// The profile council (owner 2026-11-18, relayed: "libatkan council untuk naik profil"; confirmed in the session:
// upgrades need the council's approval; "Council boleh menolak" for downgrades from the soft triggers).
//
// Three seats review one profile change: risk, strategy and trade management. Each seat answers approve or reject
// with one reason, from an evidence pack of measured facts only (never a price): equity and its drawdown, the live
// record since the last switch and per profile, the volatility regime, the recent position-management actions and the
// strategy council's verdicts. The moderator is a fixed rule, not a model:
//   - an upgrade applies only when the risk seat approves and at least two of three seats approve. A seat that fails
//     counts as reject. A council that cannot run (no pack, the daily cap, a second review the same UTC day) means no
//     upgrade;
//   - a downgrade from a soft trigger (drawdown, loss streak, extreme volatility) is vetoed only when all three seats
//     answered, the risk seat rejects and at least two reject. Anything else, a failure included, applies it.
// The kill switch and the daily loss limit never reach the council.
//
// The downgrade review runs with OMEGA_PROFILE_COUNCIL_DOWNGRADE "on" (platform ADR-0020 Amendment 5, merged 2026-11-18,
// allows the veto within these rules); anything else keeps every downgrade immediate. Never vetoable: the kill switch,
// the daily loss limit, a disarm, and the owner lowering the ceiling (those never reach the council). An invalid
// verdict, a failure or a timeout applies the downgrade.
//
// Each review is one row in D1 omega_profile_councils (its id is the council session id), metered as
// "profile_council" with its own daily cap (PROFILE_COUNCIL_DAILY_USD).
import { callBusModel } from "./model-call.mjs";
import { ensureAiUsageSchema, neuronsOf, USD_PER_1K_NEURONS } from "./ai-usage.mjs";
import { PROFILES } from "./account-spec.mjs";
import { DEAL_MONEY_COLUMNS_SQL } from "./gold-symbol.mjs";

export const PROFILE_COUNCIL_METER = "profile_council";
export const PROFILE_COUNCIL_DAILY_USD = 0.25;
export const SEATS = Object.freeze(["risk", "strategy", "trade_management"]);
export const SOFT_TRIGGERS = Object.freeze(["drawdown", "loss_streak", "extreme_volatility"]);
export const DOWNGRADE_REVIEWS_PER_DAY = 3;
export const VETO_HOLD_MS = 24 * 3_600_000;
export const VETO_WORSE_DRAWDOWN_PCT = 25;
export const VETO_WORSE_LOSSES = 6;
// ADR-0020 Amendment 5 (platform, merged 2026-11-18 08:38 UTC): a review takes about 2 minutes at most.
export const PENDING_DOWNGRADE_MAX_MS = 2 * 60_000;
export const SEAT_DEADLINE_MS = 25_000;
const LADDER = ["safe", "conservative", "aggressive", "custom"];
const rank = (p) => LADDER.indexOf(p);
const label = (p) => PROFILES[p]?.label ?? p;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (x) => (finite(x) ? Math.round(x * 100) / 100 : null);
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };

export function downgradeCouncilOn(env) {
  return String(env?.OMEGA_PROFILE_COUNCIL_DOWNGRADE ?? "off").trim().toLowerCase() === "on";
}
export function profileCouncilCapUsd(env) {
  const v = Number(env?.PROFILE_COUNCIL_DAILY_USD ?? PROFILE_COUNCIL_DAILY_USD);
  return Number.isFinite(v) && v >= 0 ? v : PROFILE_COUNCIL_DAILY_USD;
}

const SQL = `CREATE TABLE IF NOT EXISTS omega_profile_councils (id TEXT PRIMARY KEY, account_ref TEXT NOT NULL, kind TEXT NOT NULL,
  from_profile TEXT NOT NULL, to_profile TEXT NOT NULL, trigger TEXT NOT NULL, seats TEXT, verdict TEXT NOT NULL, reason TEXT,
  pack TEXT, day TEXT NOT NULL, at_ms INTEGER NOT NULL)`;
let schemaReady = null;
export async function ensureProfileCouncilSchema(db) {
  if (schemaReady === db) return;
  await db.prepare(SQL).run();
  schemaReady = db;
}
export function resetProfileCouncilSchemaForTests() { schemaReady = null; }

export const SEAT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["verdict", "reason"],
  properties: { verdict: { type: "string", enum: ["approve", "reject"] }, reason: { type: "string", maxLength: 240 } }
});

const SEAT_ROLE = {
  risk: "the risk seat: you guard the account's capital. Weigh the drawdown, the equity against its peak, the loss streak and the volatility regime.",
  strategy: "the strategy seat: you judge whether the strategies have a measured edge now. Weigh the strategy council's walk-forward verdicts and the live record per profile.",
  trade_management: "the trade management seat: you judge how positions are being run. Weigh the recent position-management actions (cut losses, stops moved, closes) and the record since the last switch."
};

/** The seat's messages: facts only, no price. */
export function seatMessages(seat, kind, pack) {
  const ask = kind === "upgrade"
    ? `The profile agent asks to raise the account's risk profile from ${label(pack.from)} to ${label(pack.to)} on its measured evidence. approve = apply the upgrade; reject = keep ${label(pack.from)}. Prefer reject when the evidence is thin.`
    : `A measured trigger (${pack.trigger}) asks to lower the account's risk profile from ${label(pack.from)} to ${label(pack.to)}. approve = apply the downgrade; reject = veto it and keep ${label(pack.from)}. The downgrade protects the account: prefer approve unless the evidence clearly shows the trigger is noise.`;
  return [
    { role: "system", content: `You sit on the profile council of an XAUUSD trading system, as ${SEAT_ROLE[seat]} ${ask} Judge from the evidence pack only. Answer in JSON: verdict and a one-sentence reason.` },
    { role: "user", content: JSON.stringify(pack) }
  ];
}

/** Pure: the moderator's rule over the seats' answers ({ seat: { verdict, reason } | null }). */
export function moderate(kind, seats) {
  const answers = SEATS.map((s) => seats?.[s]?.verdict ?? null);
  const approvals = answers.filter((v) => v === "approve").length;
  const rejects = answers.filter((v) => v === "reject").length;
  if (kind === "upgrade") {
    const ok = seats?.risk?.verdict === "approve" && approvals >= 2;
    return { verdict: ok ? "approve" : "reject", reason: ok ? `approved by ${approvals} of 3 seats, risk included` : seats?.risk?.verdict === "approve" ? `only ${approvals} of 3 seats approve` : "the risk seat does not approve" };
  }
  const veto = answers.every((v) => v != null) && seats?.risk?.verdict === "reject" && rejects >= 2;
  return { verdict: veto ? "reject" : "approve", reason: veto ? `vetoed by ${rejects} of 3 seats, risk included` : answers.some((v) => v == null) ? "a seat did not answer: the downgrade applies" : "the downgrade applies" };
}

/** Pure: the trailing run of losing deals (each { net }). */
export function trailingLosses(deals) {
  let n = 0;
  for (let i = (deals?.length ?? 0) - 1; i >= 0; i -= 1) { if (finite(deals[i]?.net) && deals[i].net < 0) n += 1; else break; }
  return n;
}

/** Pure: whether a veto on `reason` no longer holds (expired, or the trigger got worse). */
export function vetoLapsed(veto, { now, reason, drawdownPct = null, losses = null }) {
  if (!veto || veto.reason !== reason) return true;
  if (!(Number(veto.until_ms) > now)) return true;
  if (reason === "drawdown" && finite(drawdownPct) && drawdownPct >= VETO_WORSE_DRAWDOWN_PCT) return true;
  if (reason === "loss_streak" && finite(losses) && losses >= VETO_WORSE_LOSSES) return true;
  return false;
}

async function spendUsd(db, now) {
  await ensureAiUsageSchema(db);
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = (await db.prepare("SELECT model, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, SUM(cached_tokens) AS k FROM ai_usage_daily WHERE day = ? AND source = ? GROUP BY model").bind(day, PROFILE_COUNCIL_METER).all()).results || [];
  let neurons = 0;
  for (const r of rows) neurons += neuronsOf(r.model, Number(r.p) || 0, Number(r.c) || 0, Number(r.k) || 0) ?? 0;
  return (neurons / 1000) * USD_PER_1K_NEURONS;
}

/** The live record per profile over the last 90 days: deals matched to the profile in force when they closed. */
async function perProfile(db, row, now) {
  const since = now - 90 * 86_400_000;
  const changes = (await db.prepare("SELECT to_profile, at_ms FROM omega_profile_changes WHERE account_ref = ? ORDER BY at_ms, id").bind(row.account_ref).all()).results ?? [];
  const deals = (await db.prepare(`SELECT ${DEAL_MONEY_COLUMNS_SQL}, closed_ms FROM ea_deals WHERE closed_ms >= ? AND COALESCE(source, '') = 'omega' ORDER BY closed_ms LIMIT 1000`).bind(since).all()).results ?? [];
  const out = {};
  for (const d of deals) {
    let p = null;
    for (const c of changes) { if (Number(c.at_ms) <= Number(d.closed_ms)) p = c.to_profile; else break; }
    p = p ?? "custom";
    const net = (Number(d.profit) || 0) + (Number(d.commission) || 0) + (Number(d.swap) || 0);
    const o = (out[p] ??= { profile: p, trades: 0, net_sum: 0, wins: 0 });
    o.trades += 1; o.net_sum += net; if (net > 0) o.wins += 1;
  }
  return Object.values(out).map((o) => ({ ...o, net_sum: r2(o.net_sum), mean_net: r2(o.net_sum / o.trades), win_rate: r2(o.wins / o.trades) }));
}

/** The evidence pack for one review; null when its record cannot be read. */
export async function buildPack(env, row, { change, executor, deals, now }) {
  const db = env.DB;
  const equity = Number(executor?.account?.equity), balance = Number(executor?.account?.balance);
  const peak = Number(row?.balance_peak);
  const atr = Number(executor?.symbol?.atr_points);
  if (!finite(equity) || !finite(balance)) return null;
  const nets = Array.isArray(deals) ? deals.map((d) => d?.net).filter(finite) : null;
  let profiles = [], pm = [], verdicts = null;
  try { profiles = await perProfile(db, row, now); } catch { profiles = []; }
  try {
    pm = ((await db.prepare("SELECT kind, json_extract(payload, '$.reason') AS reason, status, created_ms FROM omega_intents WHERE kind IN ('close', 'partial_close', 'modify_sl', 'modify_tp') ORDER BY created_ms DESC LIMIT 20").all()).results ?? [])
      .map((r) => ({ kind: r.kind, reason: r.reason ?? null, status: r.status, at: new Date(Number(r.created_ms)).toISOString() }));
  } catch { pm = []; }
  try {
    const doc = parse(await env?.SIGNAL_CACHE?.get?.("strategy-council:v1"));
    verdicts = doc?.verdicts ? Object.fromEntries(Object.entries(doc.verdicts).map(([k, v]) => [k, { walk_forward: v?.walk_forward?.status ?? null, mean_r: v?.walk_forward?.mean_r ?? null, live_mean_r: v?.live_mean_r ?? null, proposal: v?.proposal ?? null }])) : null;
  } catch { verdicts = null; }
  return {
    account_ref: row.account_ref, kind: rank(change.to) > rank(row.profile) ? "upgrade" : "downgrade",
    from: row.profile, to: change.to, ceiling: row.ceiling, trigger: change.reason, trigger_evidence: change.evidence ?? null,
    equity: r2(equity), balance: r2(balance), balance_peak: finite(peak) ? r2(peak) : null,
    drawdown_from_peak_pct: finite(peak) && peak > 0 ? r2(((peak - equity) / peak) * 100) : null,
    atr_points: finite(atr) ? atr : null, vol_regime: !finite(atr) ? null : atr >= 1000 ? "extreme" : atr >= 500 ? "high" : "normal",
    record_since_switch: nets ? { trades: nets.length, mean_net: nets.length ? r2(nets.reduce((a, b) => a + b, 0) / nets.length) : null, losses_in_a_row: trailingLosses(deals), last_10: nets.slice(-10).map(r2) } : null,
    per_profile: profiles, position_management: pm, strategy_verdicts: verdicts,
    profile_limits: { from: PROFILES[row.profile] ?? null, to: PROFILES[change.to] ?? null }
  };
}

/**
 * One council review of `change` ({ to, reason, evidence }) for the account `row`. Returns { id, kind, verdict:
 * "approve" | "reject" | "failed" | "skipped", reason, seats }. "failed" and "skipped" mean the council did not decide:
 * the caller applies no upgrade and does apply the downgrade. Never throws.
 */
export async function reviewProfileChange(env, row, change, { executor, deals = null, now = Date.now(), call = callBusModel } = {}) {
  const db = env?.DB;
  const kind = rank(change?.to) > rank(row?.profile) ? "upgrade" : "downgrade";
  const day = new Date(now).toISOString().slice(0, 10);
  const id = `pc_${now}_${String(row?.account_ref ?? "").slice(5, 13)}`;
  const record = async (verdict, reason, seats = null, pack = null) => {
    try {
      await db.prepare("INSERT OR REPLACE INTO omega_profile_councils (id, account_ref, kind, from_profile, to_profile, trigger, seats, verdict, reason, pack, day, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, row.account_ref, kind, row.profile, change.to, String(change.reason ?? ""), seats ? JSON.stringify(seats) : null, verdict, reason, pack ? JSON.stringify(pack) : null, day, now).run();
    } catch { /* the caller's audit stands */ }
    return { id, kind, verdict, reason, seats };
  };
  try {
    if (!db || !row?.account_ref) return { id: null, kind, verdict: "failed", reason: "no database", seats: null };
    await ensureProfileCouncilSchema(db);
    const today = (await db.prepare("SELECT COUNT(*) AS n FROM omega_profile_councils WHERE account_ref = ? AND kind = ? AND day = ? AND verdict != 'skipped'").bind(row.account_ref, kind, day).first())?.n ?? 0;
    if (kind === "upgrade" && Number(today) >= 1) return { id: null, kind, verdict: "skipped", reason: "one upgrade review a UTC day", seats: null };
    if (kind === "downgrade" && Number(today) >= DOWNGRADE_REVIEWS_PER_DAY) return record("failed", "the day's downgrade reviews are used: the downgrade applies");
    if ((await spendUsd(db, now)) >= profileCouncilCapUsd(env)) return record("failed", "the council's daily cap is reached");
    const pack = await buildPack(env, row, { change, executor, deals, now });
    if (!pack) return record("failed", "no evidence pack");
    const ask = async (seat) => {
      try {
        const r = await call(env, { messages: seatMessages(seat, kind, pack), schemaName: "profile_council", schema: SEAT_SCHEMA, maxTokens: 240, effort: "low", deadline: Date.now() + SEAT_DEADLINE_MS, clock: () => Date.now(), runState: {}, role: "agent", meterSource: PROFILE_COUNCIL_METER });
        const o = r?.status === "answered" ? r.obj : null;
        return o && (o.verdict === "approve" || o.verdict === "reject") ? { verdict: o.verdict, reason: String(o.reason ?? "").slice(0, 240) } : null;
      } catch { return null; }
    };
    const answers = await Promise.all(SEATS.map(ask));
    const seats = Object.fromEntries(SEATS.map((s, i) => [s, answers[i]]));
    if (answers.every((a) => a == null)) return record("failed", "no seat answered", seats, pack);
    const m = moderate(kind, seats);
    return record(m.verdict, m.reason, seats, pack);
  } catch (e) {
    return { id: null, kind, verdict: "failed", reason: String(e?.message ?? e).slice(0, 200), seats: null };
  }
}

/** Pure: the council's part of a change's evidence and of its Telegram line. */
export function councilEvidence(review) {
  if (!review?.id) return null;
  return { id: review.id, verdict: review.verdict, reason: review.reason, seats: Object.fromEntries(SEATS.map((s) => [s, review.seats?.[s] ? `${review.seats[s].verdict}: ${review.seats[s].reason}` : "no answer"])) };
}
export function councilLine(accountRef, review, { from, to }) {
  const what = review.kind === "upgrade"
    ? (review.verdict === "approve" ? `approves ${label(from)} → ${label(to)}` : `rejects ${label(from)} → ${label(to)}; the profile stays ${label(from)}`)
    : (review.verdict === "reject" ? `vetoes the downgrade ${label(from)} → ${label(to)}; the profile stays ${label(from)} for up to 24 h` : `lets the downgrade ${label(from)} → ${label(to)} apply`);
  const seats = SEATS.map((s) => `${s.replace("_", " ")}: ${review.seats?.[s] ? `${review.seats[s].verdict}, ${review.seats[s].reason}` : "no answer"}`).join("\n");
  return `XAUUSD SYSTEM · Omega account ${accountRef}: the profile council ${what} (${review.reason}).\n${seats}`;
}

/** The account's last reviews, newest first, for the Omega page. */
export async function lastCouncilReviews(db, accountRef, { limit = 3 } = {}) {
  try {
    await ensureProfileCouncilSchema(db);
    const rows = (await db.prepare("SELECT id, kind, from_profile, to_profile, trigger, seats, verdict, reason, at_ms FROM omega_profile_councils WHERE account_ref = ? ORDER BY at_ms DESC LIMIT ?").bind(accountRef, limit).all()).results ?? [];
    return rows.map((r) => ({ id: r.id, kind: r.kind, from: r.from_profile, to: r.to_profile, trigger: r.trigger, verdict: r.verdict, reason: r.reason, seats: parse(r.seats), at_ms: Number(r.at_ms) }));
  } catch { return []; }
}
