// Account Profiles phase 3: the profile agent (docs/RFC_ACCOUNT_PROFILES.md §5, §6, §10; owner 2026-11-18: autonomous
// with guardrails, "as proposed"; platform ADR-0020 Amendment 3, merged 2026-11-18 03:53 UTC, main 1ade63d).
//
// The agent moves an account along one ladder, safe < conservative < aggressive < custom. Sizing happens in
// planIntents (phase 2): a lower profile only ever tightens the account's own settings.
//
// Downgrades are never blocked or delayed. They apply to new entries at once; open positions keep their size and SL.
// They run in every agent mode.
//   - Forced (severity warning): the kill switch or the daily loss limit sends the account to Safe. No autonomous
//     upgrade is allowed before the next UTC day.
//   - Agent, one step at a time, each with its own hysteresis so a trigger cannot cascade:
//       a drawdown of DRAWDOWN_STEP_PCT from the reference (the reference then resets to the equity);
//       LOSS_STREAK losing closed deals in a row since the last switch (the count restarts with the switch);
//       an extreme volatility regime, M15 ATR of EXTREME_ATR_POINTS or more (re-armed below the HIGH regime).
//
// Upgrades are one step, on passing evidence, only below the owner's ceiling, never with an open position or a
// pending order, at most one per UPGRADE_GAP_MS, and never before the block after a kill or the daily loss ends.
// The evidence is equity at or above the prior balance peak and at least UPGRADE_MIN_TRADES closed deals since the
// last switch with a positive mean net result. Missing evidence or a failing step raises nothing. In approval mode
// the agent only proposes the upgrade (pending_upgrade) and the owner accepts or declines it in Nexus.
//
// Only the owner sets the ceiling, the agent mode or a profile (OWNER_ACCESS_SUB, same origin, audited). A ceiling
// below the current profile applies at once.
//
// Each switch is recorded in three places: an Omega event (`profile_changed`), one Telegram line, and a row in D1
// omega_profile_changes that relayProfileChanges publishes as an xauusd_digest with body.schema "risk_profile.v1".
// The digest carries the opaque account reference, from, to, actor, reason, evidence ref and at; never the broker
// account number. Its severity is info, or warning for a forced downgrade, never critical.
//
// Limitation: deals in D1 ea_deals carry no account reference. The loss streak and the upgrade evidence read the
// deals closed since the switch; that is correct for one connected account, which is what Omega runs today.

import { PROFILES, ensureAccountSchema } from "./account-spec.mjs";
import { publishToPlatform, platformEnabled } from "./platform-reports.mjs";
import { HEALTH_AGENT_ID } from "./health-alerts.mjs";
import { SOFT_TRIGGERS, PENDING_DOWNGRADE_MAX_MS, VETO_HOLD_MS, vetoLapsed, trailingLosses, councilEvidence, councilLine } from "./profile-council.mjs";

export const LADDER = Object.freeze(["safe", "conservative", "aggressive", "custom"]);
export const DRAWDOWN_STEP_PCT = 20;
export const LOSS_STREAK = 4;
export const EXTREME_ATR_POINTS = 1000;   // 2x the planner's HIGH regime (500 points)
export const NORMAL_ATR_POINTS = 500;     // the HIGH regime's floor: below it the volatility trigger is armed again
export const UPGRADE_MIN_TRADES = 20;
export const UPGRADE_GAP_MS = 7 * 86_400_000;
export const RISK_PROFILE_SCHEMA = "risk_profile.v1";
export const PROFILE_RELAY_CURSOR_KEY = "risk-profile:relay";
export const PROFILE_RELAY_MIN_GAP_MS = 30 * 60_000;
export const PROFILE_RELAY_RETRY_MS = 15 * 60_000;
const FORCED = new Set(["kill_switch", "daily_loss_limit"]);

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
export const rank = (p) => LADDER.indexOf(p);
const label = (p) => PROFILES[p]?.label ?? p;
/** The next UTC midnight after `now`. */
export const nextUtcDay = (now) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

const CHANGES_SQL = `CREATE TABLE IF NOT EXISTS omega_profile_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, account_ref TEXT NOT NULL,
  from_profile TEXT NOT NULL, to_profile TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT, severity TEXT NOT NULL, at_ms INTEGER NOT NULL)`;
let schemaReady = false;
export function resetProfileAgentSchemaForTests() { schemaReady = false; }
async function ensureSchema(db) {
  if (schemaReady) return;
  await ensureAccountSchema(db);
  await db.prepare(CHANGES_SQL).run();
  schemaReady = true;
}

/**
 * Pure: the agent's step for one account. `row` is the omega_accounts row; `ctx` is { equity, balance, positions,
 * orders, atr_points, killed, daily_loss, deals (closed since the switch, oldest first, each { net }) or null when not
 * read this time, now }. Returns { change: null | { to, reason, actor, forced, evidence }, propose: null | {...},
 * state: the agent columns to write (only those that change), block_until_ms }.
 */
export function decideProfile(row, ctx) {
  const now = ctx.now;
  const profile = LADDER.includes(row?.profile) ? row.profile : "safe";
  const ceiling = LADDER.includes(row?.ceiling) ? row.ceiling : profile;
  const equity = num(ctx.equity), balance = num(ctx.balance);
  const state = {};
  const peak = num(row?.balance_peak), ddRef = num(row?.dd_ref);
  // The balance peak only rises (a deal closed above it); the drawdown reference starts there.
  if (finite(balance) && balance > 0 && (!finite(peak) || balance > peak)) state.balance_peak = balance;
  const peakNow = state.balance_peak ?? peak;
  if (!finite(ddRef) && finite(peakNow)) state.dd_ref = peakNow;
  const ref = state.dd_ref ?? ddRef;
  const down = (to, reason, evidence, { forced = false } = {}) => ({ change: { to, reason, actor: "agent", forced, evidence }, propose: null, state });
  const stepDown = rank(profile) > 0 ? LADDER[rank(profile) - 1] : null;

  // 1. Forced: the kill switch or the daily loss limit -> Safe; no autonomous upgrade before the next UTC day.
  if (ctx.killed || ctx.daily_loss) {
    const reason = ctx.killed ? "kill_switch" : "daily_loss_limit";
    const until = nextUtcDay(now);
    if (!(num(row?.upgrade_block_until_ms) >= until)) state.upgrade_block_until_ms = until;
    if (profile !== "safe") return down("safe", reason, { equity, balance }, { forced: true });
    return { change: null, propose: null, state };
  }
  // 2. Drawdown from the reference: one step, then the reference is the equity (another full step is needed).
  if (stepDown && finite(ref) && ref > 0 && finite(equity)) {
    const dd = ((ref - equity) / ref) * 100;
    if (dd >= DRAWDOWN_STEP_PCT) {
      state.dd_ref = equity;
      return down(stepDown, "drawdown", { drawdown_pct: Math.round(dd * 100) / 100, reference: ref, equity });
    }
  }
  // 3. Extreme volatility: one step, then latched until the regime is below HIGH again.
  const atr = num(ctx.atr_points);
  if (finite(atr)) {
    const latched = Number(row?.vol_latched) === 1;
    if (latched && atr < NORMAL_ATR_POINTS) state.vol_latched = 0;
    if (!latched && atr >= EXTREME_ATR_POINTS) {
      state.vol_latched = 1;
      if (stepDown) return down(stepDown, "extreme_volatility", { atr_points: atr, threshold: EXTREME_ATR_POINTS });
    }
  }
  const deals = Array.isArray(ctx.deals) ? ctx.deals : null;
  // 4. A loss streak since the last switch.
  if (stepDown && deals && deals.length >= LOSS_STREAK && deals.slice(-LOSS_STREAK).every((d) => finite(d?.net) && d.net < 0)) {
    return down(stepDown, "loss_streak", { losses: LOSS_STREAK, last_deals: deals.slice(-LOSS_STREAK).map((d) => Math.round(d.net * 100) / 100) });
  }
  // 5. An upgrade: every gate must pass, on evidence read this time; anything missing raises nothing.
  const up = rank(profile) < rank(ceiling) ? LADDER[rank(profile) + 1] : null;
  if (!up || !deals) return { change: null, propose: null, state };
  if ((Number(ctx.positions) || 0) > 0 || (Number(ctx.orders) || 0) > 0) return { change: null, propose: null, state };
  const blockUntil = state.upgrade_block_until_ms ?? num(row?.upgrade_block_until_ms);
  if (finite(blockUntil) && now < blockUntil) return { change: null, propose: null, state };
  const lastUp = num(row?.last_upgrade_ms);
  if (finite(lastUp) && now - lastUp < UPGRADE_GAP_MS) return { change: null, propose: null, state };
  if (!finite(equity) || !finite(peakNow) || equity < peakNow) return { change: null, propose: null, state };
  if (deals.length < UPGRADE_MIN_TRADES) return { change: null, propose: null, state };
  const nets = deals.map((d) => d?.net).filter(finite);
  if (nets.length < UPGRADE_MIN_TRADES) return { change: null, propose: null, state };
  const mean = nets.reduce((a, b) => a + b, 0) / nets.length;
  if (!(mean > 0)) return { change: null, propose: null, state };
  const evidence = { trades: nets.length, mean_net: Math.round(mean * 100) / 100, equity, balance_peak: peakNow };
  if (row?.agent_mode === "autonomous") return { change: { to: up, reason: "evidence", actor: "agent", forced: false, evidence }, propose: null, state };
  const pending = parse(row?.pending_upgrade);
  if (pending?.to === up) return { change: null, propose: null, state };
  return { change: null, propose: { to: up, reason: "evidence", evidence, at_ms: now }, state };
}

/** Pure: the Telegram line for a switch (the opaque reference, never the account number). */
export function profileLine(accountRef, from, to, { actor, reason, forced }) {
  const why = { kill_switch: "the kill switch", daily_loss_limit: "the daily loss limit", drawdown: `a ${DRAWDOWN_STEP_PCT}% drawdown`, loss_streak: `${LOSS_STREAK} losses in a row`,
    extreme_volatility: "extreme volatility", evidence: "evidence (equity above its peak, a positive record)", owner: "the owner", ceiling_lowered: "the owner's lower ceiling", proposal_accepted: "the owner accepting the agent's proposal" }[reason] ?? reason;
  return `XAUUSD SYSTEM · Omega account ${accountRef}: profile ${label(from)} → ${label(to)} (${actor}, ${why})${forced ? "; no autonomous upgrade before the next UTC day" : ""}. New entries only; open positions keep their size and stop.`;
}

/** Applies one switch: the row, the audit row, the Omega event, the Telegram line. Returns the change record. */
async function applySwitch(db, row, { to, reason, actor, forced = false, evidence = null }, { now, state = {}, log, notify }) {
  const from = row.profile;
  const set = { ...state, profile: to, profile_by: actor, profile_ms: now, pending_upgrade: null };
  if (rank(to) > rank(from)) set.last_upgrade_ms = now;
  const cols = Object.keys(set);
  await db.prepare(`UPDATE omega_accounts SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE account_ref = ?`).bind(...cols.map((c) => set[c]), row.account_ref).run();
  const severity = forced ? "warning" : "info";
  const ins = await db.prepare("INSERT INTO omega_profile_changes (account_ref, from_profile, to_profile, actor, reason, evidence, severity, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.account_ref, from, to, actor, reason, evidence ? JSON.stringify(evidence) : null, severity, now).run();
  const id = Number(ins?.meta?.last_row_id) || null;
  const record = { account_ref: row.account_ref, from, to, actor, reason, evidence_ref: id ? `omega_profile_changes:${id}` : null, at: new Date(now).toISOString(), severity };
  try { if (log) await log("profile_changed", { ...record, evidence }); } catch { /* the audit row stands */ }
  try { if (notify) await notify(profileLine(row.account_ref, from, to, { actor, reason, forced })); } catch { /* best effort */ }
  return record;
}

async function writeState(db, ref, state) {
  const cols = Object.keys(state);
  if (!cols.length) return;
  await db.prepare(`UPDATE omega_accounts SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE account_ref = ?`).bind(...cols.map((c) => state[c]), ref).run();
}

/**
 * The council's review of a soft downgrade: a veto keeps the profile (D1 council_veto, an audit row "council_veto" at
 * severity warning, the Telegram line); anything else applies the downgrade with the council in its evidence.
 */
async function downgradeReview(db, row, change, { state, ddReset, deals, executor, now, log, notify, review }) {
  let r = null;
  try { r = await review(row, change, { deals, executor }); } catch { r = null; }
  if (r?.verdict === "reject") {
    await writeState(db, row.account_ref, { ...state, pending_downgrade: null, council_veto: JSON.stringify({ reason: change.reason, until_ms: now + VETO_HOLD_MS, review_id: r.id ?? null, at_ms: now }) });
    const evidence = { trigger: change.reason, would_be: change.to, trigger_evidence: change.evidence ?? null, council: councilEvidence(r) };
    try {
      await db.prepare("INSERT INTO omega_profile_changes (account_ref, from_profile, to_profile, actor, reason, evidence, severity, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(row.account_ref, row.profile, row.profile, "council", "council_veto", JSON.stringify(evidence), "warning", now).run();
    } catch { /* the veto stands in the account row */ }
    try { if (log) await log("profile_downgrade_vetoed", { account_ref: row.account_ref, from: row.profile, to: change.to, ...evidence }); } catch { /* audit best effort */ }
    try { if (notify) await notify(councilLine(row.account_ref, r, { from: row.profile, to: change.to })); } catch { /* best effort */ }
    return { status: "vetoed", review: r, review_pending: false };
  }
  const council = councilEvidence(r) ?? { verdict: r?.verdict ?? "failed", reason: r?.reason ?? "the council failed" };
  const record = await applySwitch(db, row, { ...change, evidence: { ...(change.evidence ?? {}), council } }, { now, state: { ...state, ...ddReset, pending_downgrade: null, council_veto: null }, log, notify });
  return { status: "changed", change: record, review: r };
}

/** The deals closed since `sinceMs`, oldest first, as { net } (profit + commission + swap). */
async function dealsSince(db, sinceMs) {
  try {
    const rows = (await db.prepare("SELECT profit, commission, swap FROM ea_deals WHERE closed_ms >= ? ORDER BY closed_ms, id LIMIT 500").bind(Number(sinceMs) || 0).all()).results ?? [];
    return rows.map((r) => ({ net: (Number(r.profit) || 0) + (Number(r.commission) || 0) + (Number(r.swap) || 0) }));
  } catch { return null; }
}

/**
 * One agent step for the account `row` (from syncAccount) on this executor state. `withEvidence` reads the deals
 * (the loss streak and the upgrade); the bridge sync runs without it (the forced, drawdown and volatility steps cost
 * no read), the 5-minute ledger cron with it. D1 writes only on a change. Never throws; a failure raises nothing.
 * Returns { status, change?, propose? }.
 */
export async function runProfileAgent(db, row, { executor, killed = false, dailyLoss = false, withEvidence = false, now = Date.now(), log = null, notify = null, review = null, downgradeCouncil = false } = {}) {
  try {
    if (!row?.account_ref) return { status: "no_account" };
    await ensureSchema(db);
    const deals = withEvidence ? await dealsSince(db, row.profile_ms ?? row.created_ms) : null;
    const decision = decideProfile(row, {
      equity: executor?.account?.equity, balance: executor?.account?.balance,
      positions: Array.isArray(executor?.positions) ? executor.positions.length : 0,
      orders: Array.isArray(executor?.orders) ? executor.orders.length : 0,
      atr_points: executor?.symbol?.atr_points, killed, daily_loss: dailyLoss, deals, now
    });
    const change = decision.change;
    const pending = parse(row.pending_downgrade);
    const clearCouncil = { pending_downgrade: null, council_veto: null };
    // The kill switch and the daily loss limit never wait for the council.
    if (change?.forced) {
      const record = await applySwitch(db, row, change, { now, state: { ...decision.state, ...clearCouncil }, log, notify });
      return { status: "changed", change: record };
    }
    if (killed || dailyLoss) { await writeState(db, row.account_ref, { ...decision.state, ...(pending ? clearCouncil : {}) }); return { status: "unchanged" }; }
    // A soft downgrade waiting for its review (OMEGA_PROFILE_COUNCIL_DOWNGRADE "on"): reviewed here when the council can
    // run (the ledger cron), applied when the switch is off again or the review is late (PENDING_DOWNGRADE_MAX_MS).
    if (pending?.to && rank(pending.to) < rank(row.profile)) {
      const { dd_ref: _skip, ...kept } = decision.state;
      const pendingChange = { to: pending.to, reason: pending.reason, actor: "agent", forced: false, evidence: pending.evidence ?? null };
      const ddReset = pending.reason === "drawdown" && finite(num(executor?.account?.equity)) ? { dd_ref: num(executor.account.equity) } : {};
      const late = now - (Number(pending.at_ms) || 0) >= PENDING_DOWNGRADE_MAX_MS;
      if (downgradeCouncil && !late && !review) {
        await writeState(db, row.account_ref, kept);
        return { status: "review_pending", review_pending: true };
      }
      if (!downgradeCouncil || late) {
        const record = await applySwitch(db, row, { ...pendingChange, evidence: { ...(pendingChange.evidence ?? {}), council: { verdict: "not_reviewed", reason: downgradeCouncil ? "the review did not run in time" : "the downgrade review is off" } } }, { now, state: { ...kept, ...ddReset, ...clearCouncil }, log, notify });
        return { status: "changed", change: record };
      }
      return downgradeReview(db, row, pendingChange, { state: { ...kept }, ddReset, deals, executor, now, log, notify, review });
    }
    // A pending downgrade the profile already went past (the owner lowered it): nothing left to review.
    if (row.pending_downgrade != null) decision.state.pending_downgrade = null;
    if (change && rank(change.to) < rank(row.profile) && downgradeCouncil && SOFT_TRIGGERS.includes(change.reason)) {
      const { dd_ref: _skip, ...kept } = decision.state;
      const veto = parse(row.council_veto);
      if (veto && !vetoLapsed(veto, { now, reason: change.reason, drawdownPct: num(change.evidence?.drawdown_pct), losses: deals ? trailingLosses(deals) : null })) {
        await writeState(db, row.account_ref, kept);
        return { status: "vetoed", review_pending: false };
      }
      const ddReset = change.reason === "drawdown" ? { dd_ref: decision.state.dd_ref } : {};
      if (!review) {
        await writeState(db, row.account_ref, { ...kept, pending_downgrade: JSON.stringify({ to: change.to, reason: change.reason, evidence: change.evidence ?? null, at_ms: now }), council_veto: null });
        try { if (log) await log("profile_review_pending", { account_ref: row.account_ref, from: row.profile, to: change.to, reason: change.reason }); } catch { /* audit best effort */ }
        return { status: "review_pending", review_pending: true };
      }
      return downgradeReview(db, row, change, { state: kept, ddReset, deals, executor, now, log, notify, review });
    }
    // An autonomous upgrade needs the council's approval; without a council (the bridge sync) nothing is raised.
    if (change && rank(change.to) > rank(row.profile)) {
      if (!review) { await writeState(db, row.account_ref, decision.state); return { status: "unchanged" }; }
      const r = await review(row, change, { deals, executor });
      if (r?.verdict === "approve") {
        const record = await applySwitch(db, row, { ...change, evidence: { ...(change.evidence ?? {}), council: councilEvidence(r) } }, { now, state: decision.state, log, notify });
        try { if (notify) await notify(councilLine(row.account_ref, r, { from: row.profile, to: change.to })); } catch { /* best effort */ }
        return { status: "changed", change: record, review: r };
      }
      await writeState(db, row.account_ref, decision.state);
      if (r?.verdict !== "skipped") {
        try { if (log) await log("profile_upgrade_refused", { account_ref: row.account_ref, from: row.profile, to: change.to, council: councilEvidence(r) ?? { verdict: r?.verdict ?? "failed", reason: r?.reason ?? null } }); } catch { /* audit best effort */ }
        try {
          if (notify) await notify(r?.seats ? councilLine(row.account_ref, r, { from: row.profile, to: change.to }) : `XAUUSD SYSTEM · Omega account ${row.account_ref}: the profile council could not review ${label(row.profile)} → ${label(change.to)} (${r?.reason ?? "failed"}); no upgrade.`);
        } catch { /* best effort */ }
      }
      return { status: "refused", review: r };
    }
    if (change) {
      const record = await applySwitch(db, row, change, { now, state: { ...decision.state, ...(row.council_veto ? { council_veto: null } : {}) }, log, notify });
      return { status: "changed", change: record };
    }
    if (decision.propose) {
      await writeState(db, row.account_ref, { ...decision.state, pending_upgrade: JSON.stringify(decision.propose) });
      try { if (log) await log("profile_proposed", { account_ref: row.account_ref, from: row.profile, ...decision.propose }); } catch { /* audit best effort */ }
      try { if (notify) await notify(`XAUUSD SYSTEM · Omega account ${row.account_ref}: the profile agent proposes ${label(row.profile)} → ${label(decision.propose.to)} on evidence. Accept or decline on the Omega page.`); } catch { /* best effort */ }
      return { status: "proposed", propose: decision.propose };
    }
    await writeState(db, row.account_ref, decision.state);
    return { status: "unchanged" };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * The owner's controls (the caller has checked OWNER_ACCESS_SUB and same origin): `action` is ceiling | profile |
 * agent_mode | accept | decline, `value` the profile or mode. A ceiling below the profile lowers the profile at once.
 * An owner-set profile may not exceed the ceiling.
 */
export async function ownerSetProfile(db, { account_ref, action, value = null, actor = "owner", now = Date.now(), log = null, notify = null } = {}) {
  await ensureSchema(db);
  const row = await db.prepare("SELECT * FROM omega_accounts WHERE account_ref = ?").bind(String(account_ref ?? "")).first();
  if (!row) return { ok: false, error: "unknown account" };
  const audit = async (what, detail) => { try { if (log) await log(what, { account_ref: row.account_ref, actor, ...detail }); } catch { /* audit best effort */ } };
  if (action === "ceiling") {
    if (!LADDER.includes(value)) return { ok: false, error: "ceiling must be safe, conservative, aggressive or custom" };
    await db.prepare("UPDATE omega_accounts SET ceiling = ? WHERE account_ref = ?").bind(value, row.account_ref).run();
    await audit("profile_ceiling_set", { from: row.ceiling, to: value });
    try { if (notify) await notify(`XAUUSD SYSTEM · Omega account ${row.account_ref}: ceiling ${label(row.ceiling)} → ${label(value)} (owner).`); } catch { /* best effort */ }
    let change = null;
    if (rank(row.profile) > rank(value)) change = await applySwitch(db, { ...row, ceiling: value }, { to: value, reason: "ceiling_lowered", actor }, { now, log, notify });
    else if (parse(row.pending_upgrade) && rank(parse(row.pending_upgrade).to) > rank(value)) await writeState(db, row.account_ref, { pending_upgrade: null });
    return { ok: true, ceiling: value, change };
  }
  if (action === "agent_mode") {
    if (value !== "approval" && value !== "autonomous") return { ok: false, error: "agent_mode must be approval or autonomous" };
    await db.prepare("UPDATE omega_accounts SET agent_mode = ? WHERE account_ref = ?").bind(value, row.account_ref).run();
    await audit("profile_agent_mode_set", { from: row.agent_mode, to: value });
    return { ok: true, agent_mode: value };
  }
  if (action === "profile") {
    if (!LADDER.includes(value)) return { ok: false, error: "profile must be safe, conservative, aggressive or custom" };
    if (rank(value) > rank(row.ceiling)) return { ok: false, error: `above the ceiling (${label(row.ceiling)}): raise the ceiling first` };
    if (value === row.profile) return { ok: true, profile: value, change: null };
    const change = await applySwitch(db, row, { to: value, reason: "owner", actor }, { now, log, notify });
    return { ok: true, profile: value, change };
  }
  if (action === "accept" || action === "decline") {
    const pending = parse(row.pending_upgrade);
    if (!pending?.to) return { ok: false, error: "no proposal" };
    if (action === "decline") {
      await writeState(db, row.account_ref, { pending_upgrade: null });
      await audit("profile_proposal_declined", { to: pending.to });
      return { ok: true, declined: pending.to };
    }
    if (rank(pending.to) > rank(row.ceiling)) return { ok: false, error: "the proposal is above the ceiling" };
    const change = await applySwitch(db, row, { to: pending.to, reason: "proposal_accepted", actor, evidence: pending.evidence ?? null }, { now, log, notify });
    return { ok: true, profile: pending.to, change };
  }
  return { ok: false, error: "action must be ceiling, profile, agent_mode, accept or decline" };
}

/** Pure: the risk_profile.v1 digest for these change rows (oldest first). */
export function profileReport(rows) {
  const items = rows.map((r) => ({
    account_ref: String(r.account_ref), from: String(r.from_profile), to: String(r.to_profile), actor: String(r.actor), reason: String(r.reason),
    evidence_ref: `omega_profile_changes:${Number(r.id)}`, at: new Date(Number(r.at_ms)).toISOString(),
    // The profile council's session id and verdict, when it reviewed this change (src/profile-council.mjs).
    ...(parse(r.evidence)?.council?.verdict ? { council: { id: parse(r.evidence).council.id ?? null, verdict: String(parse(r.evidence).council.verdict) } } : {})
  }));
  const forced = rows.some((r) => r.severity === "warning" || FORCED.has(r.reason));
  const last = items.at(-1);
  return {
    kind: "xauusd_digest",
    severity: forced ? "warning" : "info",
    subject: (items.length === 1 ? `Omega risk profile ${label(last.from)} → ${label(last.to)} (${last.actor}, ${last.reason})` : `Omega risk profile: ${items.length} changes, now ${label(last.to)}`).slice(0, 200),
    ai_status: "deterministic",
    body: {
      schema: RISK_PROFILE_SCHEMA,
      items,
      observation: "Omega account risk profile changes: the agent's downgrades and upgrades (upgrades approved by the profile council), the council's vetoes and the owner's settings (ADR-0020 Amendment 3)",
      source: "xauusd-ai-trading-assistant"
    }
  };
}

/**
 * Publishes the profile changes since the cursor (KV risk-profile:relay) as one risk_profile.v1 report from
 * xauusd-risk-manager, at most one per PROFILE_RELAY_MIN_GAP_MS (the agent's report budget is shared). Like the
 * strategy arm relay: success advances; a rate limit or a transport failure retries; a final denial advances.
 */
export async function relayProfileChanges(env, { now = Date.now(), publish = publishToPlatform } = {}) {
  if (!platformEnabled(env)) return { status: "disabled" };
  const db = env?.DB;
  if (!db || !env?.SIGNAL_CACHE) return { status: "unavailable" };
  try {
    await ensureSchema(db);
    let cursor = null;
    try { cursor = parse(await env.SIGNAL_CACHE.get(PROFILE_RELAY_CURSOR_KEY)); } catch { cursor = null; }
    cursor = cursor ?? { last_id: 0 };
    if (now - (Number(cursor.sent_ms) || 0) < PROFILE_RELAY_MIN_GAP_MS) return { status: "waiting" };
    if (now - (Number(cursor.refused_ms) || 0) < PROFILE_RELAY_RETRY_MS) return { status: "waiting" };
    const rows = (await db.prepare("SELECT * FROM omega_profile_changes WHERE id > ? ORDER BY id LIMIT 20").bind(Number(cursor.last_id) || 0).all()).results ?? [];
    if (!rows.length) return { status: "idle" };
    const r = await publish(env, HEALTH_AGENT_ID, profileReport(rows));
    const put = async (c) => { try { await env.SIGNAL_CACHE.put(PROFILE_RELAY_CURSOR_KEY, JSON.stringify(c)); } catch { /* sent again next time */ } };
    if (r.outcome === "success") { await put({ last_id: Number(rows.at(-1).id), sent_ms: now, report_id: r.report_id ?? null }); return { status: "sent", count: rows.length }; }
    if (r.outcome === "failed" || r.outcome === "disabled" || /rate/i.test(String(r.reason ?? ""))) { await put({ ...cursor, refused_ms: now, reason: r.reason ?? null }); return { status: "failed", reason: r.reason ?? null, retry: true }; }
    console.error(JSON.stringify({ event: "risk_profile_relay_denied", outcome: r.outcome, reason: r.reason ?? null }));
    await put({ last_id: Number(rows.at(-1).id), sent_ms: now, denied: r.reason ?? r.outcome });
    return { status: "denied", reason: r.reason ?? null, retry: false };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}
