// Call for Councils, phase P1 (owner 2026-11-16: "tahap P1 mulai"; docs/RFC_CALL_FOR_COUNCILS.md §1.2, §8, §12):
// the deterministic suggestion flags. Agents and outcome scoring may only SUGGEST a council (owner decision Q9):
// a suggestion is a card on the Call for Councils page; it costs no model call, starts nothing and changes no
// decision, room, witness, plan or Omega setting. Checked once an hour in the parity sweep (skipped while the
// market is closed, like the other hourly jobs).
//
// The flags, for every type (RFC §1.2; the non-strategy thresholds are the RFC's proposals, re-checked with the
// strategy trigger after the first five sessions, decision 5):
//   strategy  a live agent suspended by its breaker; a pattern held back for an agent; an agent's or a pattern's
//             last 20 resolved trades ending at the stop or SL+ 65 % of the time or more (Omega's policy, the
//             ledger's plan, or the plan learner's replay of the agent's own plan, so shadow agents count too);
//             an agent's mean R per setup below 0 in one context over 20 setups. Every agent of
//             STRATEGY_AGENTS that is not off, and every pattern it trades: a new agent is covered by its entry.
//   risk      a session, trading mode or 1H regime whose last 20 resolved trades end at the stop or SL+ 65 % of
//             the time or more (the same rule)
//   engine    the Decision Engine's 7-day directional hit rate 10 points or more below its 30-day rate (30
//             decisive calls in 7 days at least); the self-trained baseline disconnected from the council
//   seat      a room seat's crowd weight at the floor (0.25) on a chart
//   knowledge a live learned note retired as worse than its control in the last 7 days
//   news      three or more losing trades within a release's gate window in 7 days
//   execution three or more self-healing recoveries, or three or more failed Omega intents, in 24 hours
//   data      a stuck state open over 24 candles; a market-data-stale alert open
//   cost      a meter source's neurons up 50 % week on week (at least 1,000 a week); a shadow breaker trip in 7 days
//
// Rate limits (RFC §1.2): one open suggestion per topic key; a fingerprint (topic key and rule) is not suggested
// again within 7 days; at most 3 new suggestions per UTC day. While its flag still fires, a suggestion's signal and
// last_seen_at are refreshed.
//
// Lifecycle (CFC-A1, orchestrator brief 2026-11-28, src/cfc-lifecycle.mjs): open -> approved | rejected | expired.
// A suggestion expires 48 hours after it was last seen (SUGGESTION_TTL_MS); a re-seen trigger extends it, never past
// 7 days after it was created (SUGGESTION_MAX_MS). Only the owner approves or rejects (POST /omega/api/council
// action "decide"); approval starts the session at once. The legacy "dismissed" (never written) reads as "rejected".
//
// CFC_MODE (Worker variable): "off" runs nothing; "suggest" (the default) runs the hourly flags; "on" also lets the
// owner open sessions (with the switch on the Councils page); "auto" is "on" plus the council-led steps of CFC-A
// (PR1: the decided proposals' 7-day follow-up expiry; the council's own pick arrives in PR2). Any other value counts
// as "off". The evidence route stays readable in every mode.

import { AGENT_IDS, DEFAULT_AGENT, agentStatuses, suspendedAgents, suspendedPatterns, AGENT_BREAKER, PATTERN_BREAKER } from "./strategy-agents.mjs";
import { TRADING_MODES } from "./signal-ledger.mjs";
import { REGIMES } from "./market-regime.mjs";
import { readPlanLearning } from "./plan-learning.mjs";
import { SCORING_VERSION, ENGINE_SUBJECT } from "./outcome-scoring.mjs";
import { reputationOf, WEIGHT_RANGE } from "./reputation.mjs";
import { readBaseline } from "./model-baseline.mjs";
import {
  CHARTS, SESSIONS, STUCK_FEEDS, STOP_EXITS, TOPIC_TYPES, parseTopicKey, readDecisionTrades, releasesNear, usageBySource, weekOverWeek, sha256Hex, USAGE_SQL, PACK_LIMITS
} from "./cfc-pack.mjs";

export const CFC_MODES = Object.freeze(["off", "suggest", "on", "auto"]);
export const CFC_DEFAULT_MODE = "suggest";
/** The Worker variable: unset is the default ("suggest"); an unknown value fails closed ("off"). */
export function cfcMode(env) {
  const raw = env?.CFC_MODE;
  if (raw == null || String(raw).trim() === "") return CFC_DEFAULT_MODE;
  const v = String(raw).trim().toLowerCase();
  return CFC_MODES.includes(v) ? v : "off";
}
export const cfcSuggestionsEnabled = (env) => cfcMode(env) !== "off";
/** Sessions may run ("on" or "auto"; the owner's switch on the Councils page is checked as well). */
export const cfcSessionsMode = (env) => ["on", "auto"].includes(cfcMode(env));
/** The council-led steps of CFC-A run only in "auto". */
export const cfcAutoMode = (env) => cfcMode(env) === "auto";

/** CFC-A1: a suggestion lives 48 hours after it was last seen, and never past 7 days after it was made. */
export const SUGGESTION_TTL_MS = 48 * 3_600_000;
export const SUGGESTION_MAX_MS = 7 * 86_400_000;
export const SUGGESTION_STATUSES = Object.freeze(["open", "approved", "rejected", "expired"]);
/** Pure: when a suggestion made at `createdAt` and last seen at `lastSeenAt` expires (ISO). */
export function suggestionExpiry(createdAt, lastSeenAt) {
  const c = toMs(createdAt), l = toMs(lastSeenAt);
  if (!Number.isFinite(c) || !Number.isFinite(l)) return null;
  return new Date(Math.min(l + SUGGESTION_TTL_MS, c + SUGGESTION_MAX_MS)).toISOString();
}
/** Pure: the status a stored row stands at now (an open row past its expiry reads expired; legacy dismissed reads rejected). */
export function effectiveStatus(row, now = Date.now()) {
  const st = row?.status === "dismissed" ? "rejected" : row?.status;
  if (st !== "open") return SUGGESTION_STATUSES.includes(st) ? st : "rejected";
  const exp = toMs(row.expires_at ?? suggestionExpiry(row.created_at, row.last_seen_at));
  return Number.isFinite(exp) && exp <= now ? "expired" : "open";
}

export const CFC_RULES = Object.freeze({
  strategy: Object.freeze({ last_n: 20, stop_share: 0.65, context_min_setups: 20, agent_breaker_setups: AGENT_BREAKER.min_setups, pattern_breaker_setups: PATTERN_BREAKER.min_setups }),
  risk: Object.freeze({ last_n: 20, stop_share: 0.65 }),
  engine: Object.freeze({ margin: 0.1, min_decisive_7d: 30 }),
  seat: Object.freeze({ weight_floor: WEIGHT_RANGE[0] }),
  knowledge: Object.freeze({ days: 7 }),
  news: Object.freeze({ losing_trades: 3, days: 7 }),
  execution: Object.freeze({ recoveries_per_day: 3, failed_intents_per_day: 3 }),
  data: Object.freeze({ stuck_candles: 24 }),
  cost: Object.freeze({ growth: 0.5, min_neurons_week: 1000, breaker_days: 7 }),
  cooldown_days: 7, daily_cap: 3, trades_read: 400, setups_read: 1500
});
export const MODEL_GATE_KEY = "cfc:model-gate:v1";

const DAY = 86_400_000;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const iso = (ms) => new Date(ms).toISOString();
const pc = (x) => `${Math.round(x * 100)}%`;
const toMs = (t) => (typeof t === "string" ? Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z") : NaN);
const parse = (t, fb = null) => { try { return t == null ? fb : JSON.parse(t); } catch { return fb; } };

// ---------------------------------------------------------------------------------------------- the flags (pure)

/** Pure: the stop share (stop + SL+) of the newest `n` items ({ exit } newest first), or null below n. */
export function stopShare(items, n) {
  const last = (items || []).filter((x) => x && typeof x.exit === "string").slice(0, n);
  if (last.length < n) return { n: last.length, stop_share: null };
  return { n: last.length, stop_share: r3(last.filter((x) => STOP_EXITS.includes(x.exit)).length / last.length) };
}

/** Pure: the three stop-share definitions of a set of trades (newest first) and replayed setups (newest first). */
export function stopShares(trades, setups, n) {
  return {
    omega: stopShare(trades.filter((t) => t.omega).map((t) => ({ exit: t.omega.exit })), n),
    ledger: stopShare(trades.filter((t) => t.plan).map((t) => ({ exit: t.plan.exit })), n),
    replay: stopShare((setups || []).filter((s) => Number(s.f) === 1).map((s) => ({ exit: s.s })), n)
  };
}
const firedBy = (shares, threshold) => Object.entries(shares).filter(([, v]) => finite(v.stop_share) && v.stop_share >= threshold).map(([k]) => k);
const DEF_LABEL = { omega: "Omega's policy", ledger: "the ledger's plan", replay: "the plan learner's replay" };
const shareText = (shares, fired, n) => fired.map((k) => `${pc(shares[k].stop_share)} of the last ${n} (${DEF_LABEL[k]})`).join("; ");

const candidate = (topic_key, rule, signal) => ({ topic_key, type: topic_key.slice(0, topic_key.indexOf(":")), rule, signal: { rule, ...signal } });

/** Pure: the strategy flags of every agent that is not off and every pattern it trades. */
export function strategyFlags({ records = [], trades = [], setups = [], statuses = {}, wanted = {} } = {}, rules = CFC_RULES.strategy) {
  const out = [];
  const on = AGENT_IDS.filter((id) => statuses[id] !== "off");
  for (const x of suspendedAgents(records)) {
    if (on.includes(x.id) && wanted[x.id] === "live") out.push(candidate(`strategy:${x.id}`, "agent_suspended", { setups: x.setups, mean_r: x.mean_r, min_setups: rules.agent_breaker_setups, summary: `The breaker suspended this live agent: ${x.mean_r}R per setup over ${x.setups} setups.` }));
  }
  for (const x of suspendedPatterns(records)) {
    if (on.includes(x.agent)) out.push(candidate(`strategy:${x.agent}:${x.id}`, "pattern_suspended", { setups: x.setups, mean_r: x.mean_r, min_setups: rules.pattern_breaker_setups, summary: `The pattern is held back for this agent: ${x.mean_r}R per setup over ${x.setups} setups of its own.` }));
  }
  for (const rec of records) {
    if (!on.includes(rec?.agent)) continue;
    for (const c of rec.contexts || []) {
      if (!(finite(c.setups) && c.setups >= rules.context_min_setups && finite(c.mean_r) && c.mean_r < 0)) continue;
      out.push(candidate(`strategy:${rec.agent}@${c.context}`, "context_negative", { context: c.context, setups: c.setups, mean_r: c.mean_r, min_setups: rules.context_min_setups, summary: `${c.mean_r}R per setup over ${c.setups} setups in ${c.context.replace("|", " · ")}.` }));
    }
  }
  const agentOf = (s) => (AGENT_IDS.includes(s.agent) ? s.agent : DEFAULT_AGENT);
  for (const id of on) {
    const mine = trades.filter((t) => t.agent === id), mySetups = setups.filter((s) => agentOf(s) === id);
    const shares = stopShares(mine, mySetups, rules.last_n), fired = firedBy(shares, rules.stop_share);
    if (fired.length) out.push(candidate(`strategy:${id}:exits`, "stop_share", { last_n: rules.last_n, at_least: rules.stop_share, shares, fired_by: fired, summary: `Ended at the stop or SL+: ${shareText(shares, fired, rules.last_n)}.` }));
    const patterns = [...new Set([...mine.map((t) => t.pattern), ...mySetups.map((s) => s.pattern)].filter(Boolean))].sort();
    for (const p of patterns) {
      const ps = stopShares(mine.filter((t) => t.pattern === p), mySetups.filter((s) => s.pattern === p), rules.last_n), pf = firedBy(ps, rules.stop_share);
      if (pf.length) out.push(candidate(`strategy:${id}:${p}`, "pattern_stop_share", { pattern: p, last_n: rules.last_n, at_least: rules.stop_share, shares: ps, fired_by: pf, summary: `This pattern ended at the stop or SL+: ${shareText(ps, pf, rules.last_n)}.` }));
    }
  }
  return out;
}

/** Pure: the risk flags, per session, trading mode and 1H regime (the strategy rule on the ledger's trades). */
export function riskFlags(trades, rules = CFC_RULES.risk) {
  const out = [];
  const dims = [["session", SESSIONS], ["mode", TRADING_MODES], ["regime", REGIMES]];
  for (const [dim, values] of dims) {
    for (const v of values) {
      const shares = stopShares(trades.filter((t) => t[dim] === v), [], rules.last_n);
      delete shares.replay;
      const fired = firedBy(shares, rules.stop_share);
      if (fired.length) out.push(candidate(`risk:${v}`, "stop_share", { dimension: dim, last_n: rules.last_n, at_least: rules.stop_share, shares, fired_by: fired, summary: `Trades in ${v.replace("_", " ")} ended at the stop or SL+: ${shareText(shares, fired, rules.last_n)}.` }));
    }
  }
  return out;
}

const cardOf = (cards, subject, tf) => (cards || []).find((c) => c.subject === subject && String(c.timeframe) === tf) ?? null;

/** Pure: the Decision Engine's 7-day hit rate against its 30-day rate (the stored scorecards). */
export function engineFlags({ cards7 = null, cards30 = null } = {}, rules = CFC_RULES.engine) {
  const a = cardOf(cards7, ENGINE_SUBJECT, "15")?.directional, b = cardOf(cards30, ENGINE_SUBJECT, "15")?.directional;
  if (!a || !b || !finite(a.hit_rate) || !finite(b.hit_rate)) return [];
  const decisive = (a.hit || 0) + (a.miss || 0);
  if (decisive < rules.min_decisive_7d || r3(b.hit_rate - a.hit_rate) < rules.margin) return [];
  return [candidate("engine:15", "hit_rate_drop", { hit_rate_7d: a.hit_rate, hit_rate_30d: b.hit_rate, decisive_7d: decisive, margin: rules.margin, summary: `The 7-day directional hit rate (${pc(a.hit_rate)} of ${decisive} decisive calls) is ${Math.round((b.hit_rate - a.hit_rate) * 100)} points below the 30-day rate (${pc(b.hit_rate)}).` })];
}

/** Pure: the baseline's gate went from promoted to not promoted since the last run. */
export function modelFlags({ previous = null, current = null } = {}) {
  if (previous !== "promoted" || !current || current === "promoted") return [];
  return [candidate("engine:model", "model_disconnected", { previous, current, summary: "The self-trained baseline was disconnected from the council's advice." })];
}

/** Pure: the seats whose crowd weight sits at the floor on a chart (the 30-day scorecards). */
export function seatFlags(cards30, rules = CFC_RULES.seat) {
  const out = [];
  for (const c of cards30 || []) {
    if (!String(c.subject).startsWith("agent:") || !CHARTS.includes(String(c.timeframe))) continue;
    const rep = reputationOf(c);
    if (finite(rep.weight) && rep.weight <= rules.weight_floor) out.push(candidate(`seat:${c.subject.slice(6)}@${c.timeframe}`, "weight_floor", { chart: String(c.timeframe), weight: rep.weight, accuracy: rep.accuracy, decisive: rep.decisive, summary: `Crowd weight at the floor (${rep.weight}) on this chart: ${rep.accuracy == null ? "no" : pc(rep.accuracy)} accuracy over ${rep.decisive} decisive calls.` }));
  }
  return out;
}

/** Pure: the live notes retired as worse than their control in the last days. */
export function knowledgeFlags(rows, { now = Date.now() } = {}, rules = CFC_RULES.knowledge) {
  return (rows || []).filter((r) => r.status === "retired" && /^worse live/.test(String(r.reason ?? "")) && toMs(r.retired_at) >= now - rules.days * DAY)
    .map((r) => candidate(`knowledge:${r.item_id}`, "retired_worse", { version: r.version, retired_at: r.retired_at, summary: `Retired as worse than its control: ${String(r.reason).slice(0, 200)}` }));
}

/** Pure: losing trades within a release's gate window in the last days. */
export function newsFlags(trades, releases, { now = Date.now() } = {}, rules = CFC_RULES.news) {
  const recent = trades.filter((t) => toMs(t.opened_at) >= now - rules.days * DAY);
  const near = releasesNear(recent, releases || []);
  if (near.inside_a_release_window < rules.losing_trades) return [];
  return [candidate("news:release_horizon", "losses_near_releases", { losing_trades: near.inside_a_release_window, days: rules.days, at_least: rules.losing_trades, summary: `${near.inside_a_release_window} losing trades in ${rules.days} days lived through a high-impact USD release's window.` })];
}

/** Pure: self-healing recoveries and failed Omega intents in the last 24 hours. */
export function executionFlags({ recoveries = 0, failedIntents = 0 } = {}, rules = CFC_RULES.execution) {
  const out = [];
  if (recoveries >= rules.recoveries_per_day) out.push(candidate("execution:recoveries", "recoveries_per_day", { recoveries, at_least: rules.recoveries_per_day, summary: `${recoveries} self-healing recoveries of the terminal in 24 hours.` }));
  if (failedIntents >= rules.failed_intents_per_day) out.push(candidate("execution:rejected_intents", "failed_intents_per_day", { failed: failedIntents, at_least: rules.failed_intents_per_day, summary: `${failedIntents} Omega intents failed on the terminal in 24 hours.` }));
  return out;
}

/** Pure: stuck states open over 24 candles, stale market data (S5: the revoked-parity trigger is retired). */
export function dataFlags({ stuck = [], alerts = [] } = {}, rules = CFC_RULES.data) {
  const out = [];
  const feeds = new Map();
  for (const s of stuck || []) {
    const feed = String(s.field ?? "").split(".")[0];
    if (!STUCK_FEEDS.includes(feed) || s.status !== "open" || !(Number(s.candles) >= rules.stuck_candles)) continue;
    feeds.set(feed, Math.max(feeds.get(feed) ?? 0, Number(s.candles)));
  }
  for (const [feed, candles] of [...feeds].sort()) out.push(candidate(`data:${feed}`, "stuck_state", { candles, at_least: rules.stuck_candles, summary: `A field of ${feed} has not changed for ${candles} closed 1H candles.` }));
  const open = (kind) => (alerts || []).some((a) => a.kind === kind && a.status === "open");
  if (open("market_data_stale")) out.push(candidate("data:market_feed", "market_data_stale", { summary: "Market data stopped while the market trades." }));
  return out;
}

/** Pure: a meter source's neurons up week on week, and a shadow breaker trip. */
export function costFlags({ usage = [], switches = [], now = Date.now() } = {}, rules = CFC_RULES.cost) {
  const out = [];
  for (const w of weekOverWeek(usageBySource(usage), now)) {
    if (finite(w.growth) && w.growth >= rules.growth && w.last_7d >= rules.min_neurons_week) out.push(candidate(`cost:${w.source}`, "neurons_growth", { last_7d: w.last_7d, prior_7d: w.prior_7d, growth: w.growth, at_least: rules.growth, summary: `Neurons up ${pc(w.growth)} week on week (${w.last_7d} against ${w.prior_7d}).` }));
  }
  const trips = (switches || []).filter((e) => e.actor === "cost-breaker" && e.mode === "off" && toMs(e.at) >= now - rules.breaker_days * DAY);
  if (trips.length) out.push(candidate("cost:shadow", "shadow_breaker_trip", { trips: trips.length, last: trips[0].at, summary: `The shadow cost breaker turned shadow off ${trips.length} time(s) in ${rules.breaker_days} days.` }));
  return out;
}

const RULE_ORDER = ["agent_suspended", "pattern_suspended", "stop_share", "pattern_stop_share", "context_negative"];
/** Pure: every flag, valid by the topic grammar, in priority order (type, then rule, then key). */
export function computeFlags(inputs = {}, { now = Date.now() } = {}) {
  const all = [
    ...strategyFlags(inputs.strategy ?? {}), ...riskFlags(inputs.trades ?? []), ...engineFlags(inputs.engine ?? {}), ...modelFlags(inputs.model ?? {}),
    ...seatFlags(inputs.cards30 ?? []), ...knowledgeFlags(inputs.learned ?? [], { now }), ...newsFlags(inputs.trades ?? [], inputs.releases ?? [], { now }),
    ...executionFlags(inputs.execution ?? {}), ...dataFlags(inputs.data ?? {}), ...costFlags({ ...(inputs.cost ?? {}), now })
  ];
  const typeRank = ["strategy", "risk", "engine", "execution", "news", "data", "cost", "seat", "knowledge"];
  const rank = (c) => [typeRank.indexOf(c.type), RULE_ORDER.includes(c.rule) ? RULE_ORDER.indexOf(c.rule) : RULE_ORDER.length];
  return all.filter((c) => parseTopicKey(c.topic_key).ok && TOPIC_TYPES.includes(c.type))
    .sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || a.topic_key.localeCompare(b.topic_key); });
}

/** The dedup fingerprint: the topic key and the rule that fired (the contract's 7-day cooldown keys on it). */
export const fingerprintOf = (c) => sha256Hex(`${c.topic_key}|${c.rule}`);

/**
 * Pure: which candidates become new suggestions. A topic key already open is refreshed, not added again; a
 * fingerprint seen within the cooldown is skipped; at most `cap` new ones a UTC day. Candidates keep their order.
 */
export function selectNew(candidates, { open = new Set(), recent = new Set(), createdToday = 0, cap = CFC_RULES.daily_cap } = {}) {
  const insert = [], touch = [], skipped = [], keys = new Set();
  let left = Math.max(0, cap - createdToday);
  for (const c of candidates) {
    if (keys.has(c.topic_key)) { skipped.push({ topic_key: c.topic_key, rule: c.rule, why: "same_topic_this_run" }); continue; }
    keys.add(c.topic_key);
    if (open.has(c.topic_key)) { touch.push(c); continue; }
    if (recent.has(c.fingerprint)) { skipped.push({ topic_key: c.topic_key, rule: c.rule, why: "cooldown" }); continue; }
    if (left <= 0) { skipped.push({ topic_key: c.topic_key, rule: c.rule, why: "daily_cap" }); continue; }
    insert.push(c); left -= 1;
  }
  return { insert, touch, skipped };
}

// ---------------------------------------------------------------------------------------------- storage

/** The v2 table (CFC-A1): the lifecycle statuses, the expiry and who decided, when, with which session and request key. */
const tableSql = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_key TEXT NOT NULL,
    type TEXT NOT NULL,
    rule TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    signal_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT,
    decided_at TEXT,
    decided_by TEXT,
    session_id TEXT,
    decision_key TEXT
  )`;
const INDEX_SQL = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_cfc_suggestions_open ON cfc_suggestions(topic_key) WHERE status = 'open'",
  "CREATE INDEX IF NOT EXISTS idx_cfc_suggestions_created ON cfc_suggestions(created_at)",
  "CREATE INDEX IF NOT EXISTS idx_cfc_suggestions_fingerprint ON cfc_suggestions(fingerprint, created_at)"
];
/** D1 cfc_suggestions (migrations 0024 and 0028; also made at run time, since production applies no migration). */
export const CFC_SCHEMA_SQL = [tableSql("cfc_suggestions"), ...INDEX_SQL];
// SQLite cannot change a CHECK in place, so the v1 table (status open | dismissed) is rebuilt once, in one batch (atomic on
// D1): the v2 table, the rows copied (dismissed as rejected, each open row's expiry from its own times), the swap, the
// indexes. Idempotent: a v2 table is left as it is.
const ISO = (expr) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${expr})`;
export const CFC_MIGRATE_V2_SQL = [
  "DROP TABLE IF EXISTS cfc_suggestions_v2",
  tableSql("cfc_suggestions_v2"),
  `INSERT INTO cfc_suggestions_v2 (id, topic_key, type, rule, fingerprint, signal_json, status, created_at, last_seen_at, expires_at, decided_at, decided_by)
   SELECT id, topic_key, type, rule, fingerprint, signal_json, CASE WHEN status = 'dismissed' THEN 'rejected' ELSE 'open' END, created_at, last_seen_at,
     MIN(${ISO("last_seen_at, '+48 hours'")}, ${ISO("created_at, '+7 days'")}),
     CASE WHEN status = 'dismissed' THEN last_seen_at END, CASE WHEN status = 'dismissed' THEN 'legacy' END
   FROM cfc_suggestions`,
  "DROP TABLE cfc_suggestions",
  "ALTER TABLE cfc_suggestions_v2 RENAME TO cfc_suggestions",
  ...INDEX_SQL
];
let schemaReady = false;
export function resetCfcSchemaCacheForTests() { schemaReady = false; }
export async function ensureCfcSchema(db) {
  if (schemaReady) return;
  await db.prepare(CFC_SCHEMA_SQL[0]).run();
  const row = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cfc_suggestions'").first();
  if (row?.sql && !String(row.sql).includes("'approved'")) {
    const list = CFC_MIGRATE_V2_SQL.map((q) => db.prepare(q));
    if (typeof db.batch === "function") await db.batch(list); else for (const q of list) await q.run();
  }
  for (const sql of INDEX_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

export const OPEN_KEYS_SQL = "SELECT topic_key FROM cfc_suggestions WHERE status = 'open' LIMIT 500";
export const RECENT_FINGERPRINTS_SQL = "SELECT fingerprint FROM cfc_suggestions WHERE created_at >= ? LIMIT 2000";
export const CREATED_SINCE_SQL = "SELECT COUNT(*) AS n FROM cfc_suggestions WHERE created_at >= ?";
export const SUGGESTIONS_SQL = "SELECT id, topic_key, type, rule, fingerprint, signal_json, status, created_at, last_seen_at, expires_at, decided_at, decided_by, session_id FROM cfc_suggestions ORDER BY created_at DESC LIMIT ?";
/** CFC-A1: open suggestions past their expiry become expired (the hourly run; a read shows the same through effectiveStatus). */
export const EXPIRE_SQL = "UPDATE cfc_suggestions SET status = 'expired', decided_at = ?, decided_by = 'system' WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?";
const SETUP_ARMS_SQL = `SELECT agent, pattern, opened_at, json_extract(results_json, '$."e0@s1".s') AS s, json_extract(results_json, '$."e0@s1".f') AS f
  FROM plan_setups WHERE status = 'resolved' AND source = 'live' AND opened_at >= ? ORDER BY opened_at DESC LIMIT ?`;

const tryRead = async (unavailable, what, fn, fb) => { try { return await fn(); } catch (e) { unavailable.push(`${what}: ${String(e?.message ?? e).slice(0, 100)}`); return fb; } };

/**
 * Every source the flags read, each bounded; a source that fails (a table or column not made yet) is named in
 * `unavailable` and adds no flag. No other module's schema is touched here: the flags only read.
 */
export async function readTriggerInputs(env, { now = Date.now() } = {}) {
  const db = env.DB, unavailable = [];
  const state = await readPlanLearning(env);
  const records = Array.isArray(state?.agents) ? state.agents : [];
  if (!state) unavailable.push("plan learner state: none yet");
  const trades = await tryRead(unavailable, "signal_ledger", () => readDecisionTrades(db, { now, limit: CFC_RULES.trades_read, ensure: false }), []);
  const setups = await tryRead(unavailable, "plan_setups", async () => ((await db.prepare(SETUP_ARMS_SQL).bind(iso(now - PACK_LIMITS.window_days * DAY), CFC_RULES.setups_read).all()).results) || [], []);
  const snap = async (days) => { const row = await db.prepare("SELECT body FROM scorecard_snapshots WHERE days = ? AND scoring_version = ?").bind(days, SCORING_VERSION).first(); return row ? parse(row.body, []) : null; };
  const cards7 = await tryRead(unavailable, "scorecard_snapshots 7d", () => snap(7), null);
  const cards30 = await tryRead(unavailable, "scorecard_snapshots 30d", () => snap(30), null);
  const learned = await tryRead(unavailable, "learned_live", async () => ((await db.prepare("SELECT item_id, version, status, retired_at, reason FROM learned_live WHERE status = 'retired' ORDER BY promoted_at DESC LIMIT 30").all()).results) || [], []);
  const releases = await tryRead(unavailable, "econ_releases", async () => ((await db.prepare("SELECT release_key, title, kind, time, surprise_z, gold_direction FROM econ_releases WHERE time >= ? AND time <= ? ORDER BY time LIMIT 300").bind(iso(now - (CFC_RULES.news.days + 4) * DAY), iso(now)).all()).results) || [], []);
  const recoveries = await tryRead(unavailable, "omega_events", async () => (((await db.prepare("SELECT ms FROM omega_events WHERE action = 'autonomous_recovery' ORDER BY id DESC LIMIT 50").all()).results) || []).filter((r) => Number(r.ms) >= now - DAY).length, 0);
  const failedIntents = await tryRead(unavailable, "omega_intents", async () => Number((await db.prepare("SELECT COUNT(*) AS n FROM omega_intents WHERE status = 'failed' AND created_ms >= ?").bind(now - DAY).first())?.n) || 0, 0);
  const stuck = await tryRead(unavailable, "stuck_states", async () => ((await db.prepare("SELECT field, status, candles FROM stuck_states WHERE status = 'open' ORDER BY updated_at DESC LIMIT 50").all()).results) || [], []);
  const alerts = await tryRead(unavailable, "health_alerts", async () => ((await db.prepare("SELECT kind, status FROM health_alerts ORDER BY rowid DESC LIMIT 300").all()).results) || [], []);
  const usage = await tryRead(unavailable, "ai_usage_daily", async () => ((await db.prepare(USAGE_SQL).bind(iso(now - 15 * DAY).slice(0, 10)).all()).results) || [], []);
  const switches = await tryRead(unavailable, "shadow_switch_events", async () => ((await db.prepare("SELECT at, mode, actor FROM shadow_switch_events ORDER BY id DESC LIMIT 50").all()).results) || [], []);
  const baseline = await tryRead(unavailable, "model baseline", () => readBaseline(env), null);
  const previousGate = await tryRead(unavailable, "model gate state", async () => parse(await env.SIGNAL_CACHE?.get?.(MODEL_GATE_KEY), null)?.status ?? null, null);
  return {
    unavailable,
    strategy: { records, trades, setups, statuses: agentStatuses(env, { records }), wanted: agentStatuses(env, { records: [] }) },
    trades, engine: { cards7, cards30 }, cards30: cards30 ?? [], learned, releases,
    model: { previous: previousGate, current: baseline?.promotion?.status ?? null },
    execution: { recoveries, failedIntents }, data: { stuck, alerts }, cost: { usage, switches }
  };
}

/**
 * The hourly step: compute the flags and store the new suggestions (D1 cfc_suggestions). Writes only that table
 * and one KV key (the baseline gate last seen). Never throws.
 */
export async function runCfcTriggers(env, { now = Date.now() } = {}) {
  if (!cfcSuggestionsEnabled(env)) return { status: "off" };
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  try {
    await ensureCfcSchema(db);
    const at0 = iso(now);
    const expired = Number((await db.prepare(EXPIRE_SQL).bind(at0, at0).run())?.meta?.changes) || 0;
    const inputs = await readTriggerInputs(env, { now });
    const flags = computeFlags(inputs, { now });
    for (const c of flags) c.fingerprint = await fingerprintOf(c);
    const open = new Set((((await db.prepare(OPEN_KEYS_SQL).all()).results) || []).map((r) => r.topic_key));
    const recent = new Set((((await db.prepare(RECENT_FINGERPRINTS_SQL).bind(iso(now - CFC_RULES.cooldown_days * DAY)).all()).results) || []).map((r) => r.fingerprint));
    const dayStart = iso(Math.floor(now / DAY) * DAY);
    const createdToday = Number((await db.prepare(CREATED_SINCE_SQL).bind(dayStart).first())?.n) || 0;
    const sel = selectNew(flags, { open, recent, createdToday });
    const at = iso(now);
    const writes = [
      ...sel.insert.map((c) => db.prepare("INSERT OR IGNORE INTO cfc_suggestions (topic_key, type, rule, fingerprint, signal_json, status, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)").bind(c.topic_key, c.type, c.rule, c.fingerprint, JSON.stringify(c.signal), at, at, suggestionExpiry(at, at))),
      // A re-seen trigger extends the expiry to 48 hours from now, capped at 7 days after the suggestion was made.
      ...sel.touch.map((c) => db.prepare(`UPDATE cfc_suggestions SET last_seen_at = ?, signal_json = ?, expires_at = MIN(?, ${ISO("created_at, '+7 days'")}) WHERE topic_key = ? AND status = 'open'`).bind(at, JSON.stringify(c.signal), new Date(now + SUGGESTION_TTL_MS).toISOString(), c.topic_key))
    ];
    if (writes.length) { if (typeof db.batch === "function") await db.batch(writes); else for (const w of writes) await w.run(); }
    const gate = inputs.model.current;
    if (gate && gate !== inputs.model.previous) await env.SIGNAL_CACHE?.put?.(MODEL_GATE_KEY, JSON.stringify({ status: gate, at }));
    return { status: "ok", flags: flags.length, created: sel.insert.map((c) => c.topic_key), refreshed: sel.touch.length, expired, skipped: sel.skipped.length, unavailable: inputs.unavailable };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** GET /api/council/suggestions: the newest suggestions (open first), with the mode and the rules. */
export async function readSuggestions(env, { now = Date.now(), limit = 50 } = {}) {
  await ensureCfcSchema(env.DB);
  const rows = ((await env.DB.prepare(SUGGESTIONS_SQL).bind(Math.min(200, Math.max(1, limit))).all()).results) || [];
  const items = rows.map((r) => ({
    id: r.id, topic_key: r.topic_key, type: r.type, rule: r.rule, status: effectiveStatus(r, now), created_at: r.created_at, last_seen_at: r.last_seen_at,
    expires_at: r.expires_at ?? suggestionExpiry(r.created_at, r.last_seen_at), decided_at: r.decided_at ?? null, decided_by: r.decided_by ?? null, session_id: r.session_id ?? null,
    // Still firing: seen by one of the last two hourly runs.
    active: toMs(r.last_seen_at) >= now - 2 * 3_600_000, fingerprint: r.fingerprint, signal: parse(r.signal_json, null)
  })).sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1));
  return { mode: cfcMode(env), rules: CFC_RULES, lifecycle: { statuses: SUGGESTION_STATUSES, ttl_hours: SUGGESTION_TTL_MS / 3_600_000, max_days: SUGGESTION_MAX_MS / 86_400_000, decide: "POST /omega/api/council { action: \"decide\", suggestion_id, decision: approve | reject, idempotency_key } (owner only)" },
    sessions: "the owner opens a session on the Councils page (GET /api/council/sessions), or approves a suggestion", suggestions: items };
}
