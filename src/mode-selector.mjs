// Account Profiles phase 4: the trading-mode selector (docs/RFC_ACCOUNT_PROFILES.md §7; owner 2026-11-18, relayed and
// confirmed in the session: "Setuju" — the council approves a switch, the owner may pin, veto or choose Auto at any
// time; platform: no ADR-0020 amendment as long as a switch touches new orders only, sizing stays SL-based within the
// profile cap, the owner's actions are the owner's only, and the kill switch and the daily loss limit keep their effect).
//
// Once a UTC day (the ledger cron), with the mode on Auto (not pinned by the owner):
//   - evidence: each mode's replayed setups (plan_setups, the control arm's R, the last 90 days) in the current 1H
//     regime, or across regimes when the regime has too few; the strategy council's walk-forward (pass / fail /
//     collecting) on them;
//   - feasibility: a mode whose median stop at the broker's minimum lot risks more than the profile's hard cap is not
//     feasible for this account;
//   - fail-safe moves, no council: the current mode is reverted to the baseline (the owner's last chosen mode) when its
//     evidence fails, or moved to the feasible mode with the smallest stop when it is no longer feasible; on a day the
//     kill switch or the daily loss limit fired, a non-baseline mode goes back to the baseline;
//   - a switch to a better mode: a mode with a walk-forward pass, feasible, its mean R at least MODE_MARGIN_R above the
//     current mode's (or the current mode not passing), the same candidate two daily runs in a row; then the mode council
//     (strategy, technical, risk, trade management) reviews it. It applies only when the risk seat and at least three of
//     four seats approve; a failure, a timeout, an invalid verdict or the cap means no switch.
// The owner's pin (POST /omega/api/trading-mode with a mode), Auto and veto (revert the last automatic switch and pin
// it) are owner only. Every change is a row in D1 omega_mode_changes, an Omega event, one Telegram line and a mode.v1
// digest item (from, to, actor, reason, evidence ref, at; no price, no lot). New orders only: an open position keeps
// its geometry; the trading mode is read by the Decision Engine at its next 15m close.
import { callBusModel } from "./model-call.mjs";
import { ensureAiUsageSchema, neuronsOf, USD_PER_1K_NEURONS } from "./ai-usage.mjs";
import { CONTROL_ARM, readPlanLearning, ensurePlanLearningSchema } from "./plan-learning.mjs";
import { modeShadowEvidence, modeProbationMode, ruleVersionOf, MODE_PROBATION_RULES } from "./mode-shadow.mjs";
import { walkForward } from "./strategy-council.mjs";
import { TRADING_MODE_KEY, TRADING_MODES_LIST, tradingMode, readLatestDecision } from "./decision-engine.mjs";
import { RANGE_GATED_AGENTS, isRanging, rangeEvidence } from "./htf-cells.mjs";
import { RANGE_BOTH_SOURCE, RANGE_BOTH_DAILY_CAP, RANGE_EPISODE_MIN_HOURS, rangeShadowMode, rangeKeyOf, rangeSetupsForEvidence, cellsOf, cellsTwice, episodeSetups, ensureRangeEpisodesSchema } from "./range-shadow.mjs";
import { PROFILES } from "./account-spec.mjs";
import { publishToPlatform, platformEnabled } from "./platform-reports.mjs";
import { HEALTH_AGENT_ID } from "./health-alerts.mjs";

export const MODE_CONTROL_KEY = "trading:mode:control:v1";
export const MODE_COUNCIL_METER = "mode_council";
export const MODE_COUNCIL_DAILY_USD = 0.25;
export const MODE_SEATS = Object.freeze(["strategy", "technical", "risk", "trade_management"]);
export const MODE_MARGIN_R = 0.1;
export const MODE_STREAK = 2;
export const MODE_REGIME_MIN = 30;
export const MODE_LEARN_DAYS = 90;
export const MODE_SCHEMA = "mode.v1";
export const MODE_RELAY_KEY = "mode:relay";
export const MODE_RELAY_MIN_GAP_MS = 30 * 60_000;
const DAY = 86_400_000;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const parse = (s) => { try { return s == null ? null : typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const LABEL = { scalp: "Scalp", intraday: "Intraday", swing: "Swing", range: "Range" };
// The mode range returns to on a breakout when nothing else is known.
export const RANGE_RETURN_DEFAULT = "intraday";
const returnOf = (c) => (TRADING_MODES_LIST.includes(c?.range_return) && c.range_return !== "range" ? c.range_return : c?.baseline && c.baseline !== "range" ? c.baseline : RANGE_RETURN_DEFAULT);

const SQL = `CREATE TABLE IF NOT EXISTS omega_mode_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, from_mode TEXT NOT NULL, to_mode TEXT NOT NULL,
  actor TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT, at_ms INTEGER NOT NULL)`;
let schemaReady = null;
export async function ensureModeSchema(db) { if (schemaReady === db) return; await db.prepare(SQL).run(); schemaReady = db; }
export function resetModeSchemaForTests() { schemaReady = null; }

/** The selector's state: { auto, pinned, baseline, last_switch, streak, last_run_day }. Default: Auto from the current mode. */
export async function readModeControl(env) {
  let c = null;
  try { c = parse(await env?.SIGNAL_CACHE?.get?.(MODE_CONTROL_KEY)); } catch { c = null; }
  const mode = await tradingMode(env);
  return { auto: c?.auto !== false, pinned: c?.pinned === true, baseline: TRADING_MODES_LIST.includes(c?.baseline) ? c.baseline : mode, last_switch: c?.last_switch ?? null, streak: c?.streak ?? null, last_run_day: c?.last_run_day ?? null, range_return: TRADING_MODES_LIST.includes(c?.range_return) ? c.range_return : null,
    // MS2: the probation, additive (only when one is stored, so the stored control stays as before without it).
    ...(c?.probation && typeof c.probation === "object" && TRADING_MODES_LIST.includes(c.probation.mode) ? { probation: c.probation } : {}), mode };
}
async function writeModeControl(env, c) {
  const { mode: _m, ...rest } = c;
  if (rest.probation == null) delete rest.probation;
  await env.SIGNAL_CACHE.put(MODE_CONTROL_KEY, JSON.stringify(rest));
}

/** Pure: each mode's evidence from resolved setups ({ mode, regime, stop, entry, r }): walk-forward, median stop. */
export function modeEvidence(setups, { regime = null, split = false } = {}) {
  const out = {};
  for (const m of TRADING_MODES_LIST) {
    const all = setups.filter((s) => s.mode === m && finite(s.r));
    const inRegime = regime ? all.filter((s) => s.regime === regime) : [];
    const use = inRegime.length >= MODE_REGIME_MIN ? inRegime : all;
    const stops = use.map((s) => Math.abs(Number(s.entry) - Number(s.stop))).filter((x) => finite(x) && x > 0).sort((a, b) => a - b);
    // MS2: the live/shadow split, when the setups carry their source (shadow evidence on).
    const sp = split ? { n_live: use.filter((s) => s.source !== "shadow").length, n_shadow: use.filter((s) => s.source === "shadow").length } : {};
    out[m] = { ...walkForward(use.map((s) => s.r)), scope: use === inRegime ? "regime" : "all", median_stop: stops.length ? stops[Math.floor(stops.length / 2)] : null, ...sp };
  }
  return out;
}

/** Pure: whether a mode is feasible for the account: its median stop at the minimum lot within the profile's cap. */
export function modeFeasible(ev, { equity, volumeMin = 0.01, contractSize = 100, capPct }) {
  if (!ev || !finite(ev.median_stop) || !finite(equity) || equity <= 0 || !finite(capPct) || capPct <= 0) return true;
  const riskPct = ((ev.median_stop * contractSize * volumeMin) / equity) * 100;
  return riskPct <= capPct;
}

/**
 * Pure: the selector's step. Returns { action: "none" | "revert" | "drop" | "propose", to, reason, evidence, streak }.
 * `forcedDay`: the kill switch or the daily loss limit fired today.
 */
export function decideMode({ mode, baseline, evidence, feasible, forcedDay = false, streak = null, regime = null, rangeReturn = RANGE_RETURN_DEFAULT }) {
  const cur = evidence[mode];
  // Range (owner 2026-11-18): only while the 1H regime ranges; a breakout leaves it at once, without the council.
  if (mode === "range" && !isRanging(regime)) return { action: "revert", to: rangeReturn, reason: "range_breakout", streak: null };
  if (forcedDay) return mode !== baseline ? { action: "revert", to: baseline === "range" && !isRanging(regime) ? rangeReturn : baseline, reason: "kill_or_daily_loss", streak: null } : { action: "none", reason: "kill_or_daily_loss", streak: null };
  if (!feasible[mode]) {
    const ok = TRADING_MODES_LIST.filter((m) => m !== mode && feasible[m]).sort((a, b) => (evidence[a]?.median_stop ?? Infinity) - (evidence[b]?.median_stop ?? Infinity));
    if (ok.length) return { action: "drop", to: ok[0], reason: "mode_not_feasible", streak: null };
  }
  if (mode !== baseline && cur?.status === "fail") return { action: "revert", to: baseline, reason: "evidence_failed", streak: null };
  const curMean = cur?.status === "pass" ? cur.mean_r : -Infinity;
  const better = TRADING_MODES_LIST.filter((m) => m !== mode && (m !== "range" || isRanging(regime)) && feasible[m] && evidence[m]?.status === "pass" && evidence[m].mean_r >= curMean + MODE_MARGIN_R)
    .sort((a, b) => evidence[b].mean_r - evidence[a].mean_r);
  if (!better.length) return { action: "none", reason: cur?.status === "pass" ? "current_mode_best" : `evidence_${cur?.status ?? "none"}`, streak: null };
  const cand = better[0];
  const passes = streak?.candidate === cand ? (Number(streak.passes) || 0) + 1 : 1;
  if (passes < MODE_STREAK) return { action: "none", reason: "candidate_holding", streak: { candidate: cand, passes } };
  return { action: "propose", to: cand, reason: "evidence", streak: { candidate: cand, passes } };
}

export const MODE_SEAT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["verdict", "reason"],
  properties: { verdict: { type: "string", enum: ["approve", "reject"] }, reason: { type: "string", maxLength: 240 } }
});
const SEAT_ROLE = {
  strategy: "the strategy seat: weigh each mode's replayed record (walk-forward, mean R, holdout) in the current regime.",
  technical: "the technical seat: weigh the current regime and volatility against the mode's timeframe and stop size.",
  risk: "the risk seat: weigh the account's capital, its profile cap and whether the new mode's stops fit it.",
  trade_management: "the trade management seat: weigh how positions would be run under the new mode (targets, the ladder, the hold time)."
};
export function modeSeatMessages(seat, pack) {
  return [
    { role: "system", content: `You sit on the mode council of an XAUUSD trading system, as ${SEAT_ROLE[seat]} The selector asks to switch the trading mode from ${LABEL[pack.from]} to ${LABEL[pack.to]} for new orders, on its measured evidence. approve = switch; reject = keep ${LABEL[pack.from]}. Prefer reject when the evidence is thin. Judge from the pack only. Answer in JSON: verdict and a one-sentence reason.` },
    { role: "user", content: JSON.stringify(pack) }
  ];
}
/** Pure: the moderator's rule: the risk seat approves and at least three of four seats approve. */
export function moderateMode(seats) {
  const approvals = MODE_SEATS.filter((s) => seats?.[s]?.verdict === "approve").length;
  const ok = seats?.risk?.verdict === "approve" && approvals >= 3;
  return { verdict: ok ? "approve" : "reject", reason: ok ? `approved by ${approvals} of 4 seats, risk included` : seats?.risk?.verdict === "approve" ? `only ${approvals} of 4 seats approve` : "the risk seat does not approve" };
}

async function spendUsd(db, now) {
  await ensureAiUsageSchema(db);
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = (await db.prepare("SELECT model, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, SUM(cached_tokens) AS k FROM ai_usage_daily WHERE day = ? AND source = ? GROUP BY model").bind(day, MODE_COUNCIL_METER).all()).results || [];
  let neurons = 0;
  for (const r of rows) neurons += neuronsOf(r.model, Number(r.p) || 0, Number(r.c) || 0, Number(r.k) || 0) ?? 0;
  return (neurons / 1000) * USD_PER_1K_NEURONS;
}

/** One mode council review. Returns { verdict: approve | reject | failed, reason, seats }. Never throws. */
export async function reviewModeSwitch(env, pack, { now = Date.now(), call = callBusModel } = {}) {
  try {
    const cap = Number(env?.MODE_COUNCIL_DAILY_USD ?? MODE_COUNCIL_DAILY_USD);
    if ((await spendUsd(env.DB, now)) >= (Number.isFinite(cap) ? cap : MODE_COUNCIL_DAILY_USD)) return { verdict: "failed", reason: "the council's daily cap is reached", seats: null };
    const ask = async (seat) => {
      try {
        const r = await call(env, { messages: modeSeatMessages(seat, pack), schemaName: "mode_council", schema: MODE_SEAT_SCHEMA, maxTokens: 240, effort: "low", deadline: Date.now() + 45_000, clock: () => Date.now(), runState: {}, role: "agent", meterSource: MODE_COUNCIL_METER });
        const o = r?.status === "answered" ? r.obj : null;
        return o && (o.verdict === "approve" || o.verdict === "reject") ? { verdict: o.verdict, reason: String(o.reason ?? "").slice(0, 240) } : null;
      } catch { return null; }
    };
    const answers = await Promise.all(MODE_SEATS.map(ask));
    const seats = Object.fromEntries(MODE_SEATS.map((s, i) => [s, answers[i]]));
    if (answers.every((a) => a == null)) return { verdict: "failed", reason: "no seat answered", seats };
    return { ...moderateMode(seats), seats };
  } catch (e) {
    return { verdict: "failed", reason: String(e?.message ?? e).slice(0, 200), seats: null };
  }
}

/** Records one change (or a refused proposal, from = to): the row, the event, the Telegram line. */
async function record(env, { from, to, actor, reason, evidence = null }, { now, log, notify }) {
  const db = env.DB;
  await ensureModeSchema(db);
  const ins = await db.prepare("INSERT INTO omega_mode_changes (from_mode, to_mode, actor, reason, evidence, at_ms) VALUES (?, ?, ?, ?, ?, ?)").bind(from, to, actor, reason, evidence ? JSON.stringify(evidence) : null, now).run();
  const id = Number(ins?.meta?.last_row_id) || null;
  try { if (log) await log(from === to ? "mode_unchanged" : "mode_changed", { from, to, actor, reason, evidence_ref: id ? `omega_mode_changes:${id}` : null }); } catch { /* audit best effort */ }
  const why = { evidence: "the selector's evidence, approved by the mode council", evidence_failed: "its evidence failed: back to the baseline", mode_not_feasible: "its stops no longer fit the account", kill_or_daily_loss: "the kill switch or the daily loss limit today", owner_pin: "the owner's pin", owner_auto: "the owner chose Auto (council)", owner_veto: "the owner's veto", council_rejected: "the mode council did not approve", probation_failed: "its probation failed: back to the baseline" }[reason] ?? reason;
  const council = evidence?.council ? `\n${MODE_SEATS.map((s) => `${s.replace("_", " ")}: ${evidence.council.seats?.[s] ? `${evidence.council.seats[s].verdict}, ${evidence.council.seats[s].reason}` : "no answer"}`).join("\n")}` : "";
  const text = from === to
    ? `XAUUSD SYSTEM · Trading mode stays ${LABEL[from]} (${why}${evidence?.proposed ? `: ${LABEL[evidence.proposed]} proposed` : ""}).${council}`
    : `XAUUSD SYSTEM · Trading mode ${LABEL[from]} → ${LABEL[to]} (${actor}, ${why}). New orders only; open positions keep theirs.${evidence?.probation?.started ? ` On probation: half the risk on new orders until it has ${MODE_PROBATION_RULES.min_live_setups} live setups and a walk-forward pass.` : ""}${council}`;
  try { if (notify) await notify(text); } catch { /* best effort */ }
  return id;
}

/**
 * The resolved setups the selector reads (the control arm's R), the last MODE_LEARN_DAYS, by opened_at and then
 * setup_key (MS1): the walk-forward's holdout is the last share of this order, so setups opened at the same time keep
 * one order on every run.
 */
async function loadSetups(db, now) {
  try {
    await ensurePlanLearningSchema(db);
    // MS2: with shadow evidence off the selector reads the live setups only, as before.
    const rows = (await db.prepare("SELECT mode, regime, agent, entry, stop, opened_at, results_json FROM plan_setups WHERE status = 'resolved' AND source = 'live' AND opened_at >= ? ORDER BY opened_at, setup_key").bind(new Date(now - MODE_LEARN_DAYS * DAY).toISOString()).all()).results ?? [];
    return rows.map((r) => ({ mode: r.mode, regime: r.regime, agent: r.agent ?? null, entry: Number(r.entry), stop: Number(r.stop), opened_ms: Date.parse(r.opened_at), r: Number(parse(r.results_json)?.[CONTROL_ARM]?.r) })).filter((s) => finite(s.r));
  } catch { return []; }
}

/**
 * Pure (MS2): live and shadow setups as one record per mode: only the setups of the rule in force (`ruleVersion`), and
 * one per mode, opening bar (decision key) and agent, the live one first on a duplicate. Order kept (opened_at, setup_key).
 */
export function unionSetups(setups, { ruleVersion }) {
  // Range shadow c2: range_both setups are range evidence only (rangeShadowEvidence), never a mode's walk-forward or the
  // probation's live count.
  const list = (setups || []).filter((s) => s.rule_version === ruleVersion && s.source !== RANGE_BOTH_SOURCE);
  const live = new Set(list.filter((s) => s.source !== "shadow").map((s) => `${s.mode}|${s.decision_key}|${s.agent}`));
  return list.filter((s) => s.source !== "shadow" || !live.has(`${s.mode}|${s.decision_key}|${s.agent}`));
}

/**
 * MS2: the resolved live and shadow setups (shadow evidence on), every field the evidence, the range cells and the
 * probation read. Not cut here: unionSetups applies the rule version.
 */
async function loadAllSetups(db, now) {
  try {
    await ensurePlanLearningSchema(db);
    const rows = (await db.prepare("SELECT setup_key, decision_key, mode, regime, agent, side, htf, entry, stop, opened_at, results_json, source, rule_version FROM plan_setups WHERE status = 'resolved' AND opened_at >= ? ORDER BY opened_at, setup_key").bind(new Date(now - MODE_LEARN_DAYS * DAY).toISOString()).all()).results ?? [];
    return rows.map((r) => ({ setup_key: r.setup_key, decision_key: r.decision_key, mode: r.mode, regime: r.regime, agent: r.agent ?? null, side: r.side, htf: r.htf ?? null, entry: Number(r.entry), stop: Number(r.stop), opened_ms: Date.parse(r.opened_at), r: Number(parse(r.results_json)?.[CONTROL_ARM]?.r), f: Number(parse(r.results_json)?.[CONTROL_ARM]?.f) === 1 ? 1 : 0, source: r.source === "shadow" || r.source === RANGE_BOTH_SOURCE ? r.source : "live", rule_version: r.rule_version ?? null })).filter((s) => finite(s.r));
  } catch { return []; }
}

const medianStopOf = (list) => { const st = list.map((s) => Math.abs(s.entry - s.stop)).filter((x) => finite(x) && x > 0).sort((a, b) => a - b); return st.length ? st[Math.floor(st.length / 2)] : null; };

/**
 * Pure (MS2, range shadow c1/c2): range's evidence from live, shadow and range_both setups: the range strategies' cells
 * (src/htf-cells.mjs cellRecords on the control arm) over their live setups in any mode, the shadow range setups and the
 * range_both setups (src/range-shadow.mjs rangeSetupsForEvidence: one per opening bar, agent and side, live before
 * shadow before range_both), of the range key in force (rangeKeyOf of `ruleVersion`); then rangeEvidence as before, with
 * the live/shadow/both split. `without_both` is the same evidence without range_both, and `cells` each cell's status
 * with and without it (the route and mode_selector_run show both).
 */
export function rangeShadowEvidence(setups, { ruleVersion }) {
  const rangeKey = rangeKeyOf(ruleVersion);
  const use = rangeSetupsForEvidence(setups, { rangeKey, withBoth: true });
  const bare = rangeSetupsForEvidence(setups, { rangeKey, withBoth: false });
  const withCells = cellsOf(use, CONTROL_ARM), bareCells = cellsOf(bare, CONTROL_ARM);
  const without = rangeEvidence(bareCells, { medianStop: medianStopOf(bare) });
  return {
    ...rangeEvidence(withCells, { medianStop: medianStopOf(use) }),
    n_live: use.filter((s) => s.source === "live").length, n_shadow: use.filter((s) => s.source === "shadow").length, n_both: use.filter((s) => s.source === RANGE_BOTH_SOURCE).length,
    without_both: { status: without.status, n: without.n, mean_r: without.mean_r, best_cell: without.best_cell ?? null },
    cells: cellsTwice({ withBoth: withCells, without: bareCells, used: use })
  };
}

/**
 * Each mode's evidence for the daily step: the setups' walk-forward per mode, range's from its passing cells. MS2 with
 * shadow evidence on: each mode's live and shadow setups of the rule in force (unionSetups), range's cells from both
 * (rangeShadowEvidence); `setups` is what it read (the probation's live count reads it too).
 */
async function selectorEvidence(env, { now, regime, withSetups = false }) {
  if (modeShadowEvidence(env) === "on") {
    const all = await loadAllSetups(env.DB, now);
    const ruleVersion = ruleVersionOf(env);
    const setups = unionSetups(all, { ruleVersion });
    const evidence = modeEvidence(setups, { regime, split: true });
    evidence.range = rangeShadowEvidence(all, { ruleVersion });
    if (withSetups) Object.defineProperty(evidence, "setups", { value: setups, enumerable: false });
    return evidence;
  }
  const setups = await loadSetups(env.DB, now);
  const evidence = modeEvidence(setups, { regime });
  // Range's evidence is its strategies' passing cells (src/htf-cells.mjs), not setups decided in range mode.
  const rangeStops = setups.filter((s) => RANGE_GATED_AGENTS.includes(s.agent)).map((s) => Math.abs(s.entry - s.stop)).filter((x) => finite(x) && x > 0).sort((a, b) => a - b);
  evidence.range = rangeEvidence((await readPlanLearning(env))?.cells ?? [], { medianStop: rangeStops.length ? rangeStops[Math.floor(rangeStops.length / 2)] : null });
  if (withSetups) Object.defineProperty(evidence, "setups", { value: setups, enumerable: false });
  return evidence;
}

/** Pure: the per-mode evidence summary of a daily outcome: n, mean R, walk-forward status and scope; no price. */
export function outcomeEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return null;
  return Object.fromEntries(TRADING_MODES_LIST.map((m) => {
    const e = evidence[m];
    return [m, e ? { n: Number.isFinite(Number(e.n)) ? Number(e.n) : null, mean_r: finite(e.mean_r) ? e.mean_r : null, status: e.status ?? null, scope: e.scope ?? null,
      // MS2: the live/shadow split, when the evidence has it (shadow evidence on).
      ...(Number.isFinite(e.n_live) ? { n_live: e.n_live, n_shadow: Number.isFinite(e.n_shadow) ? e.n_shadow : 0 } : {}),
      // Range shadow c2: range's range_both count, its status without range_both and each cell's status both ways.
      ...(m === "range" && Number.isFinite(e.n_both) ? { n_both: e.n_both, without_both: e.without_both ?? null, cells: (e.cells || []).map((c) => ({ cell: `${c.agent}|${c.side}|${c.context}`, status: c.status, setups: c.setups, status_without_both: c.without_both?.status ?? null, setups_without_both: c.without_both?.setups ?? 0 })) } : {}) } : null];
  }));
}

/**
 * Pure (MS2): a mode's own live resolved setups (`setups` as the selector read them: shadow evidence on, the rule in
 * force): { n, since_n, since_mean_r } overall and since `sinceMs`. Range: its strategies' setups decided in range mode.
 */
export function liveRecordOf(setups, mode, { sinceMs = null } = {}) {
  const all = (setups || []).filter((s) => s.mode === mode && s.source !== "shadow" && finite(s.r) && (mode !== "range" || RANGE_GATED_AGENTS.includes(s.agent)));
  const since = finite(sinceMs) ? all.filter((s) => finite(s.opened_ms) && s.opened_ms >= sinceMs) : all;
  return { n: all.length, since_n: since.length, since_mean_r: since.length ? r3(since.reduce((a, s) => a + s.r, 0) / since.length) : null };
}

/**
 * Pure (MS2): the probation's daily step. `probation`: { mode, started_ms, ... } or null. "fail" (back to the baseline,
 * reason probation_failed) when its live setups since it started reach fail_setups (15) with a mean under 0R, or its
 * walk-forward fails; "pass" (cleared, full risk) at 31 live setups and a walk-forward pass; "clear" when the mode in
 * force is not the probation's any more; else "hold".
 */
export function probationStep({ probation, mode, evidence, setups, rules = MODE_PROBATION_RULES }) {
  if (!probation) return { action: "none" };
  if (probation.mode !== mode) return { action: "clear", reason: "mode_changed" };
  const rec = liveRecordOf(setups, mode, { sinceMs: probation.started_ms });
  const wf = evidence?.[mode]?.status ?? null;
  const facts = { live_setups: rec.n, since_setups: rec.since_n, since_mean_r: rec.since_mean_r, walk_forward: wf };
  if (rec.since_n >= rules.fail_setups && finite(rec.since_mean_r) && rec.since_mean_r < 0) return { action: "fail", reason: "live_mean_below_zero", ...facts };
  if (wf === "fail") return { action: "fail", reason: "walk_forward_fail", ...facts };
  if (rec.n >= rules.min_live_setups && wf === "pass") return { action: "pass", reason: "live_setups_and_walk_forward", ...facts };
  return { action: "hold", ...facts };
}

export const MODE_RUN_EVENT = "mode_selector_run";
/**
 * MS1: every daily outcome is one event (actor agent:mode, action mode_selector_run, through `log`, which the ledger
 * cron's modeSelectorTick writes to omega_events): { day, status, reason, action, mode, to, proposed, regime, evidence }, the
 * outcomes pinned_by_server, pinned, unchanged (the step's "none" and a refused proposal), changed and failed. Best
 * effort: it never throws and never changes the outcome.
 */
async function recordOutcome(log, detail) {
  if (typeof log !== "function") return;
  try { await log("mode_selector_run", detail); } catch { /* audit best effort */ }
}

/**
 * The daily step (the ledger cron). `account`: { equity, volume_min, contract_size, cap_pct } of the connected
 * account, or null; `regime`: the latest 1H regime; `forcedDay`: the kill switch or the daily loss today.
 */
export async function runModeSelector(env, { now = Date.now(), account = null, regime = null, forcedDay = false, call = callBusModel, log = null, notify = null, force = false } = {}) {
  const db = env?.DB;
  if (!db || !env?.SIGNAL_CACHE) return { status: "unavailable" };
  const day = new Date(now).toISOString().slice(0, 10);
  let mode = null;
  try {
    await ensureModeSchema(db);
    const control = await readModeControl(env);
    mode = control.mode;
    if (!force && control.last_run_day === day) return { status: "fresh" };
    // A pinned day still records each mode's evidence; the evidence is read only, so it cannot change the outcome.
    const pinnedEvidence = async () => { try { return outcomeEvidence(await selectorEvidence(env, { now, regime })); } catch { return null; } };
    const envMode = String(env?.TRADING_MODE ?? "").trim().toLowerCase();
    if (TRADING_MODES_LIST.includes(envMode)) {
      await writeModeControl(env, { ...control, last_run_day: day });
      await recordOutcome(log, { day, status: "pinned_by_server", reason: "server_trading_mode", action: null, mode: envMode, to: null, proposed: null, regime, evidence: await pinnedEvidence() });
      return { status: "pinned_by_server" };
    }
    if (!control.auto || control.pinned) {
      await writeModeControl(env, { ...control, last_run_day: day });
      await recordOutcome(log, { day, status: "pinned", reason: control.pinned ? "owner_pin" : "auto_off", action: null, mode: control.mode, to: null, proposed: null, regime, evidence: await pinnedEvidence() });
      return { status: "pinned" };
    }
    const probationOn = modeProbationMode(env) === "on";
    const evidence = await selectorEvidence(env, { now, regime, withSetups: probationOn });
    const feasible = Object.fromEntries(TRADING_MODES_LIST.map((m) => [m, account ? modeFeasible(evidence[m], { equity: account.equity, volumeMin: account.volume_min, contractSize: account.contract_size, capPct: account.cap_pct }) : true]));
    // MS2: the probation's daily step first; a failed probation goes back to the baseline (the existing change path).
    const pstep = probationOn ? probationStep({ probation: control.probation ?? null, mode: control.mode, evidence, setups: evidence.setups }) : { action: "none" };
    const back = control.baseline === "range" && !isRanging(regime) ? returnOf(control) : control.baseline;
    const d = pstep.action === "fail" && back !== control.mode ? { action: "revert", to: back, reason: "probation_failed", streak: null }
      : decideMode({ mode: control.mode, baseline: control.baseline, evidence, feasible, forcedDay, streak: control.streak, regime, rangeReturn: returnOf(control) });
    const summary = { regime, evidence: Object.fromEntries(Object.entries(evidence).map(([m, e]) => [m, { status: e.status, n: e.n, mean_r: e.mean_r, holdout_mean_r: e.holdout_mean_r, scope: e.scope, median_stop: r3(e.median_stop), feasible: feasible[m], ...(Number.isFinite(e.n_live) ? { n_live: e.n_live, n_shadow: e.n_shadow } : {}) }])) };
    // A switch by the selector to a mode other than the baseline with fewer than 31 live setups is a probation.
    const probationFor = (to) => {
      if (!probationOn || to === control.baseline) return null;
      const rec = liveRecordOf(evidence.setups, to);
      return rec.n < MODE_PROBATION_RULES.min_live_setups ? { started: true, live_setups: rec.n, risk_scale: MODE_PROBATION_RULES.risk_scale } : null;
    };
    let applied = null, reason = d.reason, probation = control.probation ?? null, starting = null;
    if (pstep.action === "fail") summary.probation = { ...pstep, mode: control.mode };
    if (d.action === "revert" || d.action === "drop") {
      starting = d.action === "drop" ? probationFor(d.to) : null;
      await env.SIGNAL_CACHE.put(TRADING_MODE_KEY, d.to);
      const id = await record(env, { from: control.mode, to: d.to, actor: "selector", reason: d.reason, evidence: starting ? { ...summary, probation: starting } : summary }, { now, log, notify });
      applied = { from: control.mode, to: d.to, actor: "selector", reason: d.reason, at_ms: now, id };
    } else if (d.action === "propose") {
      const pack = { from: control.mode, to: d.to, ...summary, account: account ? { equity: account.equity, profile_cap_pct: account.cap_pct } : null };
      // Lens A (docs/RFC_POSITIONING_LIQUIDITY.md §3.5): crowding and divergence, a fact for the seats, never a trigger.
      try { const pos = await (await import("./lens-steps.mjs")).positioningPack(env, { now }); if (pos) pack.positioning = pos; } catch { /* without it */ }
      const review = await reviewModeSwitch(env, pack, { now, call });
      const council = { verdict: review.verdict, reason: review.reason, seats: review.seats };
      if (review.verdict === "approve") {
        starting = probationFor(d.to);
        await env.SIGNAL_CACHE.put(TRADING_MODE_KEY, d.to);
        const id = await record(env, { from: control.mode, to: d.to, actor: "council", reason: "evidence", evidence: { ...summary, council, ...(starting ? { probation: starting } : {}) } }, { now, log, notify });
        applied = { from: control.mode, to: d.to, actor: "council", reason: "evidence", at_ms: now, id };
      } else {
        reason = "council_rejected";
        await record(env, { from: control.mode, to: control.mode, actor: "council", reason: "council_rejected", evidence: { ...summary, proposed: d.to, council } }, { now, log, notify });
      }
    }
    // MS2: the probation after this run: a new one, none after any other change, cleared when it passed, else as it was.
    if (probationOn) {
      if (applied) probation = starting ? { mode: applied.to, from: applied.from, baseline: control.baseline, started_ms: now, live_setups: starting.live_setups, risk_scale: starting.risk_scale, change_id: applied.id } : null;
      else if (pstep.action === "pass" || pstep.action === "clear") probation = null;
      if (!applied && pstep.action === "pass") {
        try { if (log) await log("mode_probation_passed", { mode: control.mode, ...pstep }); } catch { /* audit best effort */ }
        try { if (notify) await notify(`XAUUSD SYSTEM · Trading mode ${LABEL[control.mode]}: probation passed (${pstep.live_setups} live setups, walk-forward pass). Full risk on new orders.`); } catch { /* best effort */ }
      }
    }
    // Entering range remembers where to return on a breakout.
    const rangeReturn = applied?.to === "range" ? (control.mode !== "range" ? control.mode : returnOf(control)) : control.range_return;
    await writeModeControl(env, { ...control, last_run_day: day, streak: applied ? null : d.streak, last_switch: applied ?? control.last_switch, range_return: rangeReturn ?? null, ...(probationOn ? { probation } : {}) });
    const status = applied ? "changed" : "unchanged";
    const probationOut = probationOn && (control.probation || probation) ? { probation: { step: pstep.action, ...(pstep.reason ? { reason: pstep.reason } : {}), ...(probation ? { mode: probation.mode, started_ms: probation.started_ms } : {}), ...(pstep.live_setups != null ? { live_setups: pstep.live_setups, since_setups: pstep.since_setups, since_mean_r: pstep.since_mean_r, walk_forward: pstep.walk_forward } : {}) } } : {};
    await recordOutcome(log, { day, status, reason, action: d.action, mode: control.mode, to: applied?.to ?? null, proposed: d.action === "propose" ? d.to : null, regime, evidence: outcomeEvidence(evidence), ...probationOut });
    return { status, decision: d, applied, evidence: summary, ...probationOut };
  } catch (e) {
    const reason = String(e?.message ?? e).slice(0, 200);
    await recordOutcome(log, { day, status: "failed", reason, action: null, mode, to: null, proposed: null, regime, evidence: null });
    return { status: "failed", reason };
  }
}

/**
 * The owner's actions (the caller has checked the owner): { mode } pins a mode (it becomes the baseline);
 * { action: "auto" } hands the mode to the selector and council; { action: "veto" } reverts the last automatic switch
 * (within 24 h) and pins it.
 */
export async function ownerModeAction(env, { mode = null, action = null, actor = "owner", now = Date.now(), log = null, notify = null } = {}) {
  await ensureModeSchema(env.DB);
  const envMode = String(env?.TRADING_MODE ?? "").trim().toLowerCase();
  if (TRADING_MODES_LIST.includes(envMode)) return { ok: false, error: "pinned_by_server", mode: envMode };
  const control = await readModeControl(env);
  if (action === "auto") {
    await writeModeControl(env, { ...control, auto: true, pinned: false, streak: null });
    await record(env, { from: control.mode, to: control.mode, actor, reason: "owner_auto" }, { now, log, notify });
    return { ok: true, mode: control.mode, auto: true, pinned: false, changed: false };
  }
  if (action === "veto") {
    const last = control.last_switch;
    if (!last || last.actor === "owner" || !(now - Number(last.at_ms) <= DAY) || last.to !== control.mode) return { ok: false, error: "no automatic switch to veto (the last 24 h)" };
    await env.SIGNAL_CACHE.put(TRADING_MODE_KEY, last.from);
    const id = await record(env, { from: control.mode, to: last.from, actor, reason: "owner_veto", evidence: { vetoed: last } }, { now, log, notify });
    await writeModeControl(env, { ...control, auto: false, pinned: true, baseline: last.from, streak: null, probation: null, last_switch: { from: control.mode, to: last.from, actor: "owner", reason: "owner_veto", at_ms: now, id } });
    return { ok: true, mode: last.from, previous: control.mode, changed: true, pinned: true };
  }
  const asked = String(mode ?? "").trim().toLowerCase();
  if (!TRADING_MODES_LIST.includes(asked)) return { ok: false, error: "mode must be scalp, intraday, swing or range, or action auto or veto" };
  const changed = asked !== control.mode;
  if (changed) await env.SIGNAL_CACHE.put(TRADING_MODE_KEY, asked);
  const id = await record(env, { from: control.mode, to: asked, actor, reason: "owner_pin" }, { now, log, notify: changed ? notify : null });
  const rangeReturn = asked === "range" ? (control.mode !== "range" ? control.mode : returnOf(control)) : control.range_return;
  // MS2: the owner's pin is the owner's choice: no probation on it.
  await writeModeControl(env, { ...control, auto: false, pinned: true, baseline: asked, streak: null, probation: null, range_return: rangeReturn ?? null, last_switch: changed ? { from: control.mode, to: asked, actor: "owner", reason: "owner_pin", at_ms: now, id } : control.last_switch });
  return { ok: true, mode: asked, previous: control.mode, changed, pinned: true };
}

/**
 * Range's breakout exit (owner 2026-11-18: "keluar otomatis saat breakout"), every 5 minutes in the ledger step: in
 * range mode with the latest decision's 1H regime no longer ranging, the mode returns to the one it came from (an
 * owner's pin of range included: the pin then holds that mode). No council: a fail-safe move, recorded and told.
 */
export async function rangeExitTick(env, { now = Date.now(), regime = undefined, log = null, notify = null } = {}) {
  if (!env?.DB || !env?.SIGNAL_CACHE) return { status: "unavailable" };
  try {
    const envMode = String(env?.TRADING_MODE ?? "").trim().toLowerCase();
    if (TRADING_MODES_LIST.includes(envMode)) return { status: "pinned_by_server" };
    const control = await readModeControl(env);
    if (control.mode !== "range") return { status: "idle" };
    if (regime === undefined) { try { regime = (await readLatestDecision(env))?.context?.regime_1h ?? null; } catch { regime = null; } }
    if (isRanging(regime)) return { status: "ranging" };
    await ensureModeSchema(env.DB);
    const to = returnOf(control);
    await env.SIGNAL_CACHE.put(TRADING_MODE_KEY, to);
    const id = await record(env, { from: "range", to, actor: "selector", reason: "range_breakout", evidence: { regime } }, { now, log, notify });
    await writeModeControl(env, { ...control, baseline: control.baseline === "range" ? to : control.baseline, streak: null, probation: null, last_switch: { from: "range", to, actor: "selector", reason: "range_breakout", at_ms: now, id } });
    return { status: "changed", to, regime };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The mode for the pages: { mode, auto, pinned, baseline, last_switch, history (last 5) }. */
export async function modeStatus(env) {
  const c = await readModeControl(env);
  let history = [];
  try {
    await ensureModeSchema(env.DB);
    history = ((await env.DB.prepare("SELECT id, from_mode, to_mode, actor, reason, at_ms FROM omega_mode_changes ORDER BY id DESC LIMIT 5").all()).results ?? [])
      .map((r) => ({ id: Number(r.id), from: r.from_mode, to: r.to_mode, actor: r.actor, reason: r.reason, at_ms: Number(r.at_ms) }));
  } catch { history = []; }
  return { mode: c.mode, auto: c.auto && !c.pinned, pinned: c.pinned, baseline: c.baseline, last_switch: c.last_switch, history,
    // MS2: the probation in force (null without one), only while MODE_PROBATION is on.
    ...(modeProbationMode(env) === "on" ? { probation: c.probation && c.probation.mode === c.mode ? c.probation : null } : {}) };
}

/**
 * MS2 (GET /api/trading-mode): each mode's evidence per 1H regime, live against shadow, as the selector reads it (the
 * resolved setups of the last 90 days, the control arm's R; shadow evidence on: the rule in force, one per bar and
 * agent), and the probation with its live record. No price, no lot.
 */
export async function modeEvidenceStatus(env, { now = Date.now() } = {}) {
  const shadowOn = modeShadowEvidence(env) === "on", probationOn = modeProbationMode(env) === "on";
  const c = await readModeControl(env);
  const setups = shadowOn ? unionSetups(await loadAllSetups(env.DB, now), { ruleVersion: ruleVersionOf(env) }) : await loadSetups(env.DB, now);
  const part = (list) => ({ n: list.length, mean_r: list.length ? r3(list.reduce((a, s) => a + s.r, 0) / list.length) : null });
  const modes = Object.fromEntries(TRADING_MODES_LIST.map((m) => {
    const mine = setups.filter((s) => s.mode === m);
    const regimes = [...new Set(mine.map((s) => s.regime ?? "unknown"))].sort();
    const split = (list) => ({ ...part(list), live: part(list.filter((s) => s.source !== "shadow")), shadow: part(list.filter((s) => s.source === "shadow")) });
    return [m, { ...split(mine), regimes: Object.fromEntries(regimes.map((g) => [g, split(mine.filter((s) => (s.regime ?? "unknown") === g))])) }];
  }));
  const p = probationOn && c.probation && c.probation.mode === c.mode ? c.probation : null;
  return {
    shadow_evidence: shadowOn ? "on" : "off", probation_mode: probationOn ? "on" : "off", rule_version: shadowOn ? ruleVersionOf(env) : null,
    learn_days: MODE_LEARN_DAYS, modes,
    probation: p ? { ...p, ...liveRecordOf(setups, p.mode, { sinceMs: p.started_ms }), rules: MODE_PROBATION_RULES } : null
  };
}

export const RANGE_SHADOW_EPISODES = 30;
/**
 * Range shadow (GET /api/range-shadow): range's evidence as the selector reads it with shadow evidence on (each cell's
 * status with and without range_both, the source counts, the fill rate), today's range_both rows against the cap, and
 * the last RANGE_SHADOW_EPISODES intraday range episodes with the range setups opened in each (open ones included), per
 * agent and side. No price, no lot. Never throws.
 */
export async function rangeShadowStatus(env, { now = Date.now() } = {}) {
  const db = env?.DB;
  const ruleVersion = ruleVersionOf(env), rangeKey = rangeKeyOf(ruleVersion);
  const head = { mode: rangeShadowMode(env), shadow_evidence: modeShadowEvidence(env), rule_version: ruleVersion, range_key: rangeKey, learn_days: MODE_LEARN_DAYS, episode_min_hours: RANGE_EPISODE_MIN_HOURS };
  if (!db) return { ...head, status: "unavailable" };
  try {
    const ev = rangeShadowEvidence(await loadAllSetups(db, now), { ruleVersion });
    const { cells, ...evidence } = ev;
    const today = new Date(now).toISOString().slice(0, 10);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM plan_setups WHERE source = ? AND opened_at >= ?").bind(RANGE_BOTH_SOURCE, `${today}T00:00:00.000Z`).first();
    await ensureRangeEpisodesSchema(db);
    const eps = ((await db.prepare("SELECT start_ms, opened_ms, end_ms, hours, status FROM range_episodes ORDER BY start_ms DESC LIMIT ?").bind(RANGE_SHADOW_EPISODES).all()).results ?? [])
      .map((e) => ({ start_ms: Number(e.start_ms), opened_ms: Number(e.opened_ms), end_ms: e.end_ms == null ? null : Number(e.end_ms), hours: Number(e.hours), status: e.status }));
    const oldest = eps.length ? Math.min(...eps.map((e) => e.start_ms)) : now;
    const rows = eps.length ? ((await db.prepare(`SELECT decision_key, mode, agent, side, htf, opened_at, results_json, source, rule_version FROM plan_setups WHERE agent IN (${RANGE_GATED_AGENTS.map(() => "?").join(", ")}) AND opened_at >= ? AND status IN ('open', 'resolved') ORDER BY opened_at, setup_key`).bind(...RANGE_GATED_AGENTS, new Date(oldest).toISOString()).all()).results ?? []) : [];
    const setups = rangeSetupsForEvidence(rows.map((r) => ({ decision_key: r.decision_key, mode: r.mode, agent: r.agent, side: r.side, htf: r.htf ?? null, opened_ms: Date.parse(r.opened_at), r: Number(parse(r.results_json)?.[CONTROL_ARM]?.r), source: r.source === "shadow" || r.source === RANGE_BOTH_SOURCE ? r.source : "live", rule_version: r.rule_version ?? null })), { rangeKey, withBoth: true });
    const at = (ms) => (finite(ms) ? new Date(ms).toISOString() : null);
    return {
      ...head, status: "ok",
      range_both: { cap_per_day: RANGE_BOTH_DAILY_CAP, today: Number(n?.n) || 0 },
      evidence, cells,
      episodes: eps.map((e) => ({ start: at(e.start_ms), opened: at(e.opened_ms), end: at(e.end_ms), hours: e.hours, status: e.status, setups: episodeSetups(e, setups, { now }) }))
    };
  } catch (e) {
    return { ...head, status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * MS2: the risk scale of Omega's new orders from the probation (src/omega-broker.mjs passes it to planIntents): 0.5 for
 * a signal decided in the probation's mode while MODE_PROBATION is on, else null (full risk). Never throws.
 */
export async function modeProbationRisk(env, signal) {
  try {
    if (modeProbationMode(env) !== "on" || !signal?.trading_mode) return null;
    const c = parse(await env?.SIGNAL_CACHE?.get?.(MODE_CONTROL_KEY));
    const p = c?.probation;
    return p && p.mode === signal.trading_mode ? { mode: p.mode, scale: finite(p.risk_scale) && p.risk_scale > 0 && p.risk_scale < 1 ? p.risk_scale : MODE_PROBATION_RULES.risk_scale } : null;
  } catch { return null; }
}

/** Pure: the mode.v1 digest for these change rows (oldest first): no price, no lot. */
export function modeReport(rows) {
  const items = rows.map((r) => ({ from: String(r.from_mode), to: String(r.to_mode), actor: String(r.actor), reason: String(r.reason), evidence_ref: `omega_mode_changes:${Number(r.id)}`, at: new Date(Number(r.at_ms)).toISOString(),
    ...(parse(r.evidence)?.council?.verdict ? { council: String(parse(r.evidence).council.verdict) } : {}) }));
  const last = items.at(-1);
  return {
    kind: "xauusd_digest", severity: "info", ai_status: "deterministic",
    subject: (items.length === 1 ? `Trading mode ${last.from} → ${last.to} (${last.actor}, ${last.reason})` : `Trading mode: ${items.length} events, now ${last.to}`).slice(0, 200),
    body: { schema: MODE_SCHEMA, items, observation: "Trading-mode changes: the selector's fail-safe moves, the council's approved switches and refusals, the owner's pins, Auto and vetoes", source: "xauusd-ai-trading-assistant" }
  };
}

/** Publishes the mode rows since the cursor as one mode.v1 report, at most one per MODE_RELAY_MIN_GAP_MS. */
export async function relayModeChanges(env, { now = Date.now(), publish = publishToPlatform } = {}) {
  if (!platformEnabled(env)) return { status: "disabled" };
  const db = env?.DB;
  if (!db || !env?.SIGNAL_CACHE) return { status: "unavailable" };
  try {
    await ensureModeSchema(db);
    const cursor = parse(await env.SIGNAL_CACHE.get(MODE_RELAY_KEY)) ?? { last_id: 0 };
    if (now - (Number(cursor.sent_ms) || 0) < MODE_RELAY_MIN_GAP_MS) return { status: "waiting" };
    const rows = (await db.prepare("SELECT * FROM omega_mode_changes WHERE id > ? ORDER BY id LIMIT 20").bind(Number(cursor.last_id) || 0).all()).results ?? [];
    if (!rows.length) return { status: "idle" };
    const r = await publish(env, HEALTH_AGENT_ID, modeReport(rows));
    if (r.outcome === "success" || !(r.outcome === "failed" || r.outcome === "disabled" || /rate/i.test(String(r.reason ?? "")))) {
      await env.SIGNAL_CACHE.put(MODE_RELAY_KEY, JSON.stringify({ last_id: Number(rows.at(-1).id), sent_ms: now }));
      return { status: r.outcome === "success" ? "sent" : "denied", count: rows.length };
    }
    await env.SIGNAL_CACHE.put(MODE_RELAY_KEY, JSON.stringify({ ...cursor, sent_ms: now }));
    return { status: "failed", retry: true };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The profile's hard cap for the feasibility check (Custom: the risk setting). */
export function capOf(profile, settings) {
  const p = PROFILES[profile];
  if (p && finite(p.hard_cap_pct)) return p.hard_cap_pct;
  return finite(Number(settings?.risk_pct)) ? Number(settings.risk_pct) : null;
}
