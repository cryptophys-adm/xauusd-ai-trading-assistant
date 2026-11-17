// Call for Councils, phase P1 (owner 2026-11-16: "tahap P1 mulai"; docs/RFC_CALL_FOR_COUNCILS.md §1.0, §3, §12):
// the evidence pack of a council topic. Evidence only: no model call, no session, no write to any trading or
// decision table. A pack is built per topic TYPE from the tables that exist today:
//
//   strategy   strategy:<agent>[:<pattern> | :exits][@<mode>|<regime>]   any agent of STRATEGY_AGENTS, any pattern it trades
//   seat       seat:<id>[@<chart>]                                       any room or desk seat of the roster
//   engine     engine:15 | engine:model                                  the Decision Engine, the self-trained baseline's gate
//   risk       risk:<session | mode | regime>                            the Signal Ledger grouped by session, trading mode or 1H regime
//   news       news:release_horizon | news:drift | news:calendar
//   execution  execution:recoveries | rejected_intents | fills | sl_plus
//   data       data:parity | market_feed | tv_budget | <engine of a stuck state>
//   cost       cost:<meter source> | cost:shadow
//   knowledge  knowledge:<learned item id>
//   free       free:<slug>                                               the owner picks the sections in a later phase
//
// Rules (RFC §3): every price field is dropped (entry, stop, targets, levels, prices, ATR in price units); claims
// speak in R, shares, counts, ATR multiples and times. Each section is bounded (at most a few hundred rows read,
// each read by an index or by its newest rows). A section whose source does not exist says so
// ({ unavailable: "<reason>" }) instead of inventing a value. Refs follow council.v1:
// ev:xauusd/<source>/<id>[@<as_of>][#<field>]. The pack's sha256 is the hash of its canonical JSON (keys sorted)
// without the sha256 field itself, so the same evidence at the same as_of always hashes the same.
//
// The pack holds no price, but it stays behind Cloudflare Access like the rest of /api (RFC §3 "Leakage"): it never
// goes to the kernel, to Aether or to PublicProjection.

import { AGENT_IDS, DEFAULT_AGENT, STRATEGY_AGENTS, agentCatalog, agentStatuses, suspendedAgents, suspendedPatterns } from "./strategy-agents.mjs";
import { TRADING_MODES, sessionAt, decisionCloseMs, toMs, ensureLedgerSchema } from "./signal-ledger.mjs";
import { REGIMES } from "./market-regime.mjs";
import { PLAN_ARMS, CONTROL_ARM, contextOf, readPlanLearning, ensurePlanLearningSchema } from "./plan-learning.mjs";
import { ensureDecisionSchema } from "./decision-engine.mjs";
import { agentRoster } from "./agent-inventory.mjs";
import { EVENT_GATE } from "./econ-calendar.mjs";
import { SCORING_VERSION, ENGINE_SUBJECT } from "./outcome-scoring.mjs";
import { reputationOf } from "./reputation.mjs";
import { neuronsOf } from "./ai-usage.mjs";
import { readBaseline } from "./model-baseline.mjs";

export const CFC_PACK_SCHEMA = "council_pack.v1";
export const TOPIC_TYPES = Object.freeze(["strategy", "seat", "engine", "risk", "news", "execution", "data", "cost", "knowledge", "free"]);
export const CHARTS = Object.freeze(["15", "60", "240", "1D"]);
export const SESSIONS = Object.freeze(["asia", "london", "new_york", "late"]);
export const ENGINE_TOPICS = Object.freeze(["15", "model"]);
export const NEWS_KINDS = Object.freeze(["release_horizon", "drift", "calendar"]);
export const EXECUTION_KINDS = Object.freeze(["recoveries", "rejected_intents", "fills", "sl_plus"]);
/** The engines whose fields outcome scoring watches for stuck states (src/outcome-scoring.mjs STUCK_FIELDS). */
export const STUCK_FEEDS = Object.freeze(["prophet_r37", "prophet_r38", "gmi_v12_70"]);
export const DATA_FEEDS = Object.freeze(["parity", "market_feed", "tv_budget", ...STUCK_FEEDS]);
export const CONTEXT_MODES = Object.freeze([...TRADING_MODES, "none"]);
export const CONTEXT_REGIMES = Object.freeze([...REGIMES, "unknown"]);
export const RISK_VALUES = Object.freeze([...SESSIONS, ...TRADING_MODES, ...REGIMES]);
export const TOPIC_KEY_MAX = 120;

/** Bounds of every read (RFC §8: no unbounded scan). */
export const PACK_LIMITS = Object.freeze({ window_days: 60, trades: 200, trades_read: 400, trades_shown: 50, setups: 200, held: 200, deals: 500, releases: 300, short_days: 7, statements: 200, compliance: 500, decisions: 200, events: 500, intents: 500, usage_days: 14, refs: 300 });

/** Every key that names a price, a price distance or money; never kept in a pack, never a ref's field. */
export const PRICE_FIELDS = Object.freeze([
  "entry", "stop", "tp", "tp1", "tp2", "exit_price", "entry_price", "stop_loss", "take_profit", "progressive_stop", "price", "prices",
  "level", "levels", "key_levels", "zones", "upper", "lower", "fill_price", "open", "high", "low", "close", "sl", "atr", "atr_h1",
  "price_range", "threshold", "max_up", "max_down", "band", "volume", "profit", "commission", "swap", "balance", "equity", "actual", "forecast", "previous"
]);
const PRICE_SET = new Set(PRICE_FIELDS);

const DAY = 86_400_000, M15 = 15 * 60_000;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const num = (x) => (x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : null);
const iso = (ms) => new Date(ms).toISOString();
const clip = (s, n) => (s == null ? null : String(s).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n));
const parse = (t, fb = null) => { try { return t == null ? fb : typeof t === "string" ? JSON.parse(t) : t; } catch { return fb; } };
const unavailable = (reason) => ({ unavailable: String(reason) });
const failed = (what, e) => unavailable(`${what} could not be read (${clip(e?.message ?? e, 120)})`);

// ---------------------------------------------------------------------------------------------- topic keys

/** The patterns an agent trades (its family, or the forming patterns it swings in), from the registry. */
const PATTERNS_OF = Object.freeze(Object.fromEntries(agentCatalog(null).map((a) => [a.id, Object.freeze((a.patterns || []).map((p) => p.id))])));
export const patternsOf = (agent) => PATTERNS_OF[agent] ?? [];
/** The seats a seat topic may name: the generated roster (src/agent-inventory.mjs) without the system writer. */
export const SEAT_IDS = Object.freeze(agentRoster({}).map((a) => a.id).filter((id) => id !== "system"));
const SOURCE_RE = /^[a-z][a-z0-9_:.-]{0,63}$/;
const ITEM_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * Pure: the strict check of a topic key (RFC §1.0). { ok: true, key, type, ... } or { ok: false, error }.
 * Every value is checked against the registry or a fixed set, so a key never reaches a reader unchecked.
 */
export function parseTopicKey(raw) {
  const bad = (error) => ({ ok: false, error });
  if (typeof raw !== "string") return bad("the topic is missing");
  const key = raw;
  if (key.length < 3 || key.length > TOPIC_KEY_MAX) return bad(`the topic must be 3 to ${TOPIC_KEY_MAX} characters`);
  if (!/^[\x21-\x7e]+$/.test(key)) return bad("the topic has a space or a character outside ASCII");
  const at = key.indexOf(":");
  if (at < 1) return bad("the topic must start with its type and a colon");
  const type = key.slice(0, at), rest = key.slice(at + 1);
  if (!TOPIC_TYPES.includes(type)) return bad(`unknown topic type "${type}"`);
  if (!rest) return bad("the topic names nothing after its type");
  switch (type) {
    case "strategy": {
      const [head, context, ...more] = rest.split("@");
      if (more.length) return bad("a strategy topic has at most one @context");
      const [agent, second, ...extra] = head.split(":");
      if (extra.length) return bad("a strategy topic is strategy:<agent>[:<pattern>|:exits][@<context>]");
      if (!AGENT_IDS.includes(agent)) return bad(`unknown strategy agent "${agent}"`);
      let pattern = null, focus = null;
      if (second !== undefined) {
        if (second === "exits") focus = "exits";
        else if (patternsOf(agent).includes(second)) pattern = second;
        else return bad(`"${second}" is neither "exits" nor a pattern ${agent} trades`);
      }
      let ctx = null;
      if (context !== undefined) {
        const [mode, regime, ...tail] = context.split("|");
        if (tail.length || !CONTEXT_MODES.includes(mode) || !CONTEXT_REGIMES.includes(regime)) return bad("a context is <mode>|<regime>, as the plan learner names it");
        ctx = `${mode}|${regime}`;
      }
      return { ok: true, key, type, agent, pattern, focus, context: ctx };
    }
    case "seat": {
      const [id, chart, ...more] = rest.split("@");
      if (more.length || !SEAT_IDS.includes(id)) return bad(`unknown seat "${id}"`);
      if (chart !== undefined && !CHARTS.includes(chart)) return bad(`a seat's chart is one of ${CHARTS.join(", ")}`);
      return { ok: true, key, type, seat: id, chart: chart ?? null };
    }
    case "engine":
      return ENGINE_TOPICS.includes(rest) ? { ok: true, key, type, engine: rest } : bad(`an engine topic is one of ${ENGINE_TOPICS.map((x) => "engine:" + x).join(", ")}`);
    case "risk": {
      if (!RISK_VALUES.includes(rest)) return bad("a risk topic names a session, a trading mode or a 1H regime");
      const dimension = SESSIONS.includes(rest) ? "session" : TRADING_MODES.includes(rest) ? "mode" : "regime";
      return { ok: true, key, type, dimension, value: rest };
    }
    case "news":
      return NEWS_KINDS.includes(rest) ? { ok: true, key, type, kind: rest } : bad(`a news topic is one of ${NEWS_KINDS.join(", ")}`);
    case "execution":
      return EXECUTION_KINDS.includes(rest) ? { ok: true, key, type, kind: rest } : bad(`an execution topic is one of ${EXECUTION_KINDS.join(", ")}`);
    case "data":
      return DATA_FEEDS.includes(rest) ? { ok: true, key, type, feed: rest } : bad(`a data topic is one of ${DATA_FEEDS.join(", ")}`);
    case "cost":
      return SOURCE_RE.test(rest) ? { ok: true, key, type, source: rest } : bad("a cost topic names a meter source (lower case, digits, _ : . -)");
    case "knowledge":
      return ITEM_RE.test(rest) ? { ok: true, key, type, item: rest } : bad("a knowledge topic names a learned item id");
    case "free":
      return SLUG_RE.test(rest) ? { ok: true, key, type, slug: rest } : bad("a free topic is a slug: lower case, digits and dashes");
    default:
      return bad("unknown topic type");
  }
}

/** Pure: every topic key the page's picker can offer, from the code (no D1). */
export function topicCatalog() {
  const strategy = STRATEGY_AGENTS.flatMap((a) => [`strategy:${a.id}`, `strategy:${a.id}:exits`, ...patternsOf(a.id).map((p) => `strategy:${a.id}:${p}`)]);
  return {
    strategy: { keys: strategy, contexts: CONTEXT_MODES.flatMap((m) => CONTEXT_REGIMES.map((r) => `${m}|${r}`)), agents: agentCatalog(null).map((a) => ({ id: a.id, label: a.label, patterns: (a.patterns || []).map((p) => ({ id: p.id, name: p.name })) })) },
    seat: { keys: SEAT_IDS.flatMap((id) => [`seat:${id}`, ...CHARTS.map((c) => `seat:${id}@${c}`)]), seats: SEAT_IDS, charts: CHARTS },
    engine: { keys: ENGINE_TOPICS.map((x) => `engine:${x}`) },
    risk: { keys: RISK_VALUES.map((x) => `risk:${x}`) },
    news: { keys: NEWS_KINDS.map((x) => `news:${x}`) },
    execution: { keys: EXECUTION_KINDS.map((x) => `execution:${x}`) },
    data: { keys: DATA_FEEDS.map((x) => `data:${x}`) },
    cost: { keys: ["cost:shadow"], free_form: "cost:<meter source>, e.g. a source of GET /api/ai-usage" },
    knowledge: { keys: [], free_form: "knowledge:<learned item id>" },
    free: { keys: [], free_form: "free:<slug>" }
  };
}

// ---------------------------------------------------------------------------------------------- hashing, refs, prices

/** Pure: JSON with every object's keys sorted, undefined dropped (the pack's canonical form). */
export function canonicalJson(v) {
  if (v === undefined || v === null || typeof v === "function") return "null";
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== "function").sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pure: a copy with every price key removed, at any depth. */
export function stripPrices(v) {
  if (Array.isArray(v)) return v.map(stripPrices);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!PRICE_SET.has(k)) out[k] = stripPrices(x);
  return out;
}

/** Pure: the price keys found anywhere in `v` (the tests' check; [] for a clean pack). */
export function priceKeysIn(v, path = "") {
  if (Array.isArray(v)) return v.flatMap((x, i) => priceKeysIn(x, `${path}[${i}]`));
  if (!v || typeof v !== "object") return [];
  return Object.entries(v).flatMap(([k, x]) => [...(PRICE_SET.has(k) ? [`${path}.${k}`] : []), ...priceKeysIn(x, `${path}.${k}`)]);
}

export const REF_RE = /^ev:xauusd\/[a-z][a-z0-9_]*\/[^\s@#]+(@[^\s@#]+)?(#[A-Za-z0-9_.:|-]+)?$/;
const refId = (id) => String(id ?? "").replace(/[\s@#]/g, "_");
/** Pure: a council.v1 evidence ref; null for a price field (a price is never a ref). */
export function evRef(source, id, { asOf = null, field = null } = {}) {
  if (field != null && PRICE_SET.has(String(field).split(".").at(-1))) return null;
  return `ev:xauusd/${source}/${refId(id)}${asOf ? "@" + refId(asOf) : ""}${field != null ? "#" + String(field).replace(/[^A-Za-z0-9_.:|-]/g, "_") : ""}`;
}

/**
 * The pack: { schema, topic, type, as_of, sections, refs, sha256 }. Sections lose every price key; refs are
 * unique, sorted, valid and capped; sha256 is the hash of the canonical JSON of everything else.
 */
export async function finalizePack({ topic, type, as_of, sections, refs }) {
  const clean = stripPrices(sections);
  const list = [...new Set((refs || []).filter((r) => typeof r === "string" && REF_RE.test(r)))].sort().slice(0, PACK_LIMITS.refs);
  const body = { schema: CFC_PACK_SCHEMA, topic, type, as_of, sections: clean, refs: list };
  return { ...body, sha256: await sha256Hex(canonicalJson(body)) };
}

// ---------------------------------------------------------------------------------------------- statistics

/** Pure: nearest-rank quantiles of finite numbers, or null without any. */
export function quantiles(values) {
  const xs = (values || []).filter(finite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const q = (p) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1))];
  return { n: xs.length, p10: r3(q(0.1)), p25: r3(q(0.25)), p50: r3(q(0.5)), p75: r3(q(0.75)), p90: r3(q(0.9)), mean: r3(xs.reduce((a, b) => a + b, 0) / xs.length) };
}

/** The exits that end at the stop: the plain stop and the protected stop (SL+), per either definition. */
export const STOP_EXITS = Object.freeze(["stop", "sl_plus"]);

/** Pure: the exits of `items` ({ exit, r }), as counts and shares, the stop share (stop + SL+) and the mean R. */
export function tally(items) {
  const xs = (items || []).filter((x) => x && typeof x.exit === "string");
  const counts = new Map();
  for (const x of xs) counts.set(x.exit, (counts.get(x.exit) || 0) + 1);
  const rs = xs.map((x) => x.r).filter(finite);
  const total = rs.reduce((a, b) => a + b, 0);
  return {
    n: xs.length,
    stop_share: xs.length ? r3(xs.filter((x) => STOP_EXITS.includes(x.exit)).length / xs.length) : null,
    mean_r: rs.length ? r3(total / rs.length) : null, total_r: rs.length ? r3(total) : null,
    exits: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([exit, n]) => ({ exit, n, share: r3(n / xs.length) }))
  };
}

/** Omega's exit of a trade (src/signal-ledger.mjs simulateOmega; "sl_plus" is its stop locked behind passed key levels). */
export const omegaExit = (t) => (t.omega ? { exit: t.omega.exit, r: t.omega.r } : null);
/** The ledger's exit of a trade (simulateSignal; "sl_plus" is its breakeven stop after halfway to TP1). */
export const ledgerExit = (t) => (t.plan ? { exit: t.plan.exit, r: t.plan.r } : null);

/** Pure: both definitions side by side (RFC decision 2): Omega's locked stop is the headline, the ledger's breakeven beside it. */
export function exitsOf(trades) {
  return { omega: tally(trades.map(omegaExit)), ledger: tally(trades.map(ledgerExit)) };
}

/** Pure: exitsOf per value of `keyOf` (null values grouped as "unknown"), the largest groups first. */
export function exitsBy(trades, keyOf) {
  const groups = new Map();
  for (const t of trades) { const k = keyOf(t) ?? "unknown"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  return [...groups].sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0]))).map(([value, list]) => ({ value: String(value), trades: list.length, ...exitsOf(list) }));
}

/** Pure: the losing runs of a definition in time order: the longest run of losses and the deepest drawdown in R. */
export function lossRuns(trades, pick) {
  const xs = trades.map((t) => ({ at: t.opened_at, x: pick(t) })).filter((y) => y.x && finite(y.x.r)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  let run = 0, longest = 0, cum = 0, peak = 0, dd = 0;
  for (const { x } of xs) {
    run = x.r < 0 ? run + 1 : 0; longest = Math.max(longest, run);
    cum += x.r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
  }
  return { n: xs.length, longest_losing_run: longest, max_drawdown_r: r3(dd), current_losing_run: run };
}

// ---------------------------------------------------------------------------------------------- the trades

/** The Decision Engine's resolved trades of the window, newest first, with what their decision says (no price). */
export const TRADES_SQL = `SELECT l.id, l.candle_key, l.opened_at, l.side, l.status, l.exit_reason, l.sl_plus_triggered, l.r_tp1, l.r_tp2,
    l.mfe_r, l.mae_r, l.bars_held, l.ambiguous, l.closed_at, l.trading_mode, l.entry_action, l.omega_status, l.omega_exit, l.r_omega, l.omega_closed_at,
    json_extract(l.omega_json, '$.protected_at') AS omega_protected_at, json_extract(l.omega_json, '$.sl_moves') AS omega_sl_moves,
    json_extract(l.omega_json, '$.tp_moves') AS omega_tp_moves, json_extract(l.omega_json, '$.mfe_r') AS omega_mfe_r, json_extract(l.omega_json, '$.mae_r') AS omega_mae_r,
    json_extract(e.decision_json, '$.trade.agent') AS agent, json_extract(e.decision_json, '$.trade.strategy') AS strategy,
    json_extract(e.decision_json, '$.trade.pattern') AS pattern, json_extract(e.decision_json, '$.context.regime_1h') AS regime
  FROM signal_ledger l LEFT JOIN engine_decisions e ON e.decision_key = l.candle_key
  WHERE l.source = 'decision' AND l.opened_at >= ? AND (l.status = 'closed' OR l.omega_status = 'closed')
  ORDER BY l.opened_at DESC LIMIT ?`;

/** Pure: one ledger row as a pack trade: its agent, context and both exits, in R; no price. */
export function tradeOf(r) {
  const closeMs = decisionCloseMs(r.candle_key), openMs = closeMs - M15;
  const agent = AGENT_IDS.includes(str(r.agent)) ? str(r.agent) : AGENT_IDS.includes(str(r.strategy)) ? str(r.strategy) : DEFAULT_AGENT;
  const mode = TRADING_MODES.includes(r.trading_mode) ? r.trading_mode : null;
  const regime = str(r.regime);
  const ledgerExitOf = r.exit_reason === "stop" ? (Number(r.sl_plus_triggered) === 1 ? "sl_plus" : "stop") : str(r.exit_reason) ?? "unknown";
  return {
    id: String(r.id), key: String(r.candle_key ?? ""), opened_at: String(r.opened_at), side: r.side === "SELL" ? "SELL" : "BUY",
    bar_open: finite(openMs) ? iso(openMs) : null, session: finite(openMs) ? sessionAt(openMs) : null,
    mode, regime, context: contextOf({ mode, regime }), agent, pattern: str(r.pattern),
    entry_action: r.entry_action === "ENTER_LIMIT" || r.entry_action === "ENTER_MARKET" ? r.entry_action : null,
    plan: r.status === "closed" ? { exit: ledgerExitOf, r: num(r.r_tp1), r_tp2: num(r.r_tp2), mfe_r: num(r.mfe_r), mae_r: num(r.mae_r), bars: num(r.bars_held), ambiguous: Number(r.ambiguous) === 1, closed_at: r.closed_at ?? null } : null,
    omega: r.omega_status === "closed" ? { exit: str(r.omega_exit) ?? "unknown", r: num(r.r_omega), protected: r.omega_protected_at != null, sl_moves: num(r.omega_sl_moves), tp_moves: num(r.omega_tp_moves), mfe_r: num(r.omega_mfe_r), mae_r: num(r.omega_mae_r), closed_at: r.omega_closed_at ?? null } : null
  };
}

/**
 * The resolved Decision Engine trades of the last `days` (at most `limit`, newest first). `ensure` runs the ledger's
 * and the engine's run-time schemas first, as their own read routes do; the hourly flags pass false and read what
 * the ledger step (every 5 minutes) has made.
 */
export async function readDecisionTrades(db, { now = Date.now(), days = PACK_LIMITS.window_days, limit = PACK_LIMITS.trades_read, ensure = true } = {}) {
  if (ensure) { await ensureLedgerSchema(db); await ensureDecisionSchema(db); }
  const rows = (await db.prepare(TRADES_SQL).bind(iso(now - days * DAY), limit).all()).results || [];
  return rows.map(tradeOf);
}

/** Pure: the trades of a strategy topic (agent, then pattern and context), newest first, at most PACK_LIMITS.trades. */
export function tradesOfTopic(trades, t) {
  return trades.filter((x) => x.agent === t.agent && (!t.pattern || x.pattern === t.pattern) && (!t.context || x.context === t.context)).slice(0, PACK_LIMITS.trades);
}

/** Pure: a trade as a row of the pack's table (no price). */
const tradeRow = (t) => ({
  ref: `signal_ledger/${t.id}`, opened_at: t.opened_at, side: t.side, agent: t.agent, pattern: t.pattern, mode: t.mode, regime: t.regime, session: t.session, entry_action: t.entry_action,
  omega_exit: t.omega?.exit ?? null, omega_r: t.omega?.r ?? null, omega_protected: t.omega ? t.omega.protected : null,
  ledger_exit: t.plan?.exit ?? null, ledger_r: t.plan?.r ?? null, mfe_r: t.plan?.mfe_r ?? null, mae_r: t.plan?.mae_r ?? null, bars_held: t.plan?.bars ?? null, ambiguous: t.plan ? t.plan.ambiguous : null
});

const tradeRefs = (trades, asOf) => trades.slice(0, PACK_LIMITS.trades_shown).flatMap((t) => [t.omega ? evRef("signal_ledger", t.id, { asOf, field: "r_omega" }) : null, t.plan ? evRef("signal_ledger", t.id, { asOf, field: "r_tp1" }) : null]).filter(Boolean);

/** Pure: the trades section: how many, the window, and the newest rows. */
export function tradesSection(trades, { days = PACK_LIMITS.window_days } = {}) {
  return { n: trades.length, window_days: days, cap: PACK_LIMITS.trades, shown: Math.min(trades.length, PACK_LIMITS.trades_shown), rows: trades.slice(0, PACK_LIMITS.trades_shown).map(tradeRow) };
}

/** Pure: the exits section of a set of trades, split by side, mode, 1H regime, session and entry type. */
export function exitsSection(trades, { byAgent = false, byPattern = false } = {}) {
  return {
    headline: "omega", definitions: EXIT_DEFINITIONS, ...exitsOf(trades),
    by_side: exitsBy(trades, (t) => t.side), by_mode: exitsBy(trades, (t) => t.mode), by_regime: exitsBy(trades, (t) => t.regime),
    by_session: exitsBy(trades, (t) => t.session), by_entry_action: exitsBy(trades, (t) => t.entry_action),
    ...(byAgent ? { by_agent: exitsBy(trades, (t) => t.agent) } : {}), ...(byPattern ? { by_pattern: exitsBy(trades, (t) => t.pattern) } : {})
  };
}

export const EXIT_DEFINITIONS = Object.freeze({
  omega: "the headline: Omega's policy replayed on each signal (src/signal-ledger.mjs simulateOmega); sl_plus is the stop locked behind passed key levels (src/omega-engine.mjs)",
  ledger: "beside it: the plan held to its first target (simulateSignal); sl_plus is the breakeven stop set once price reached halfway to TP1",
  stop_share: "the share of the trades ending at the stop or at SL+",
  same_bar: "a bar that touches both the stop and the target counts as the stop; 1m bars where the 1m series reaches, else 15m"
});

/** Pure: the excursions in R per exit, under each definition. */
export function excursionsSection(trades) {
  const by = (pick, mfe, mae) => {
    const groups = new Map();
    for (const t of trades) { const x = pick(t); if (!x) continue; if (!groups.has(x.exit)) groups.set(x.exit, []); groups.get(x.exit).push(t); }
    return [...groups].sort((a, b) => b[1].length - a[1].length).map(([exit, list]) => ({ exit, n: list.length, mfe_r: quantiles(list.map(mfe)), mae_r: quantiles(list.map(mae)) }));
  };
  return {
    omega: by(omegaExit, (t) => t.omega?.mfe_r, (t) => t.omega?.mae_r),
    ledger: by(ledgerExit, (t) => t.plan?.mfe_r, (t) => t.plan?.mae_r),
    note: "maximum favourable (mfe_r) and adverse (mae_r) excursion in R of the trade's own risk"
  };
}

/** Pure: the limit entry at the key level apart from the market entry (RFC decision 1), for the topic's trades and for every agent. */
export function entryActionsSection(topicTrades, allTrades) {
  const split = (list) => Object.fromEntries(["ENTER_LIMIT", "ENTER_MARKET"].map((a) => [a, exitsOf(list.filter((t) => t.entry_action === a))]));
  return { this_topic: split(topicTrades), all_agents: split(allTrades), note: "ENTER_LIMIT is the limit entry at the key level; ENTER_MARKET enters at price when the plan is at its level" };
}

// ---------------------------------------------------------------------------------------------- strategy readers

const SETUPS_SQL = "SELECT setup_key, agent, pattern, opened_at, side, entry, stop, atr_h1, mode, regime, context, at_level, results_json FROM plan_setups WHERE status = 'resolved' AND opened_at >= ? AND agent = ? ORDER BY opened_at DESC LIMIT ?";

/** Pure: the plan learner's setups of an agent: the contexts, every grid arm against the plan, and the stop distance in ATR per exit. */
export function setupSections(rows, t) {
  const setups = rows.map((r) => ({ ...r, results: parse(r.results_json, {}) || {} }))
    .filter((s) => (!t.pattern || s.pattern === t.pattern) && (!t.context || s.context === t.context));
  if (!setups.length) return { setups: { n: 0, note: "no resolved setup of this agent in the window" }, invalidation: unavailable("no resolved setup of this agent in the window") };
  const contexts = new Map();
  for (const s of setups) { const c = contexts.get(s.context) ?? { context: s.context, n: 0, r: 0, rn: 0 }; c.n += 1; const x = s.results?.[CONTROL_ARM]; if (finite(x?.r)) { c.r += x.r; c.rn += 1; } contexts.set(s.context, c); }
  const arms = PLAN_ARMS.map((arm) => {
    const rs = [], diffs = [];
    for (const s of setups) {
      const a = s.results?.[arm.id], c = s.results?.[CONTROL_ARM];
      if (finite(a?.r)) rs.push(a.r);
      if (finite(a?.r) && finite(c?.r)) diffs.push(a.r - c.r);
    }
    return { arm: arm.id, entry_shift_atr: arm.entry_shift, stop_scale: arm.stop_scale, n: rs.length, mean_r: rs.length ? r3(rs.reduce((x, y) => x + y, 0) / rs.length) : null, mean_diff_r: diffs.length ? r3(diffs.reduce((x, y) => x + y, 0) / diffs.length) : null };
  });
  const stopAtr = (s) => { const e = Number(s.entry), st = Number(s.stop), a = Number(s.atr_h1); return finite(e) && finite(st) && finite(a) && a > 0 ? Math.abs(e - st) / a : null; };
  const byExit = (pred) => quantiles(setups.filter((s) => pred(s.results?.[CONTROL_ARM]?.s)).map(stopAtr));
  return {
    setups: {
      n: setups.length, control: CONTROL_ARM, at_level: setups.filter((s) => Number(s.at_level) === 1).length,
      contexts: [...contexts.values()].sort((a, b) => b.n - a.n).map((c) => ({ context: c.context, setups: c.n, mean_r: c.rn ? r3(c.r / c.rn) : null })),
      arms, note: "the plan learner's 20 arms (entry shift in 1H ATR, stop scale) replayed on this agent's own setups; mean_diff_r against the plan as it is"
    },
    invalidation: { unit: "stop distance in 1H ATR", stopped: byExit((s) => s === "stop"), target: byExit((s) => s === "target"), time: byExit((s) => s === "time"), unfilled: byExit((s) => s && !["stop", "target", "time"].includes(s)) }
  };
}

/** Pure: the agent's record from the plan learner's state, and its breaker state. */
export function recordSection(state, t, statuses) {
  if (!state) return unavailable("the plan learner has no state yet (KV plan-learning:state:v1)");
  const records = Array.isArray(state.agents) ? state.agents : [];
  const rec = records.find((r) => r.agent === t.agent) ?? null;
  const record = rec ? { ...rec, ...(t.pattern ? { patterns: (rec.patterns || []).filter((p) => p.pattern === t.pattern) } : {}), ...(t.context ? { contexts: (rec.contexts || []).filter((c) => c.context === t.context) } : {}) } : null;
  const wf = state.walk_forward;
  return {
    generated_at: state.generated_at ?? null, status: statuses?.[t.agent] ?? null, record,
    suspended: suspendedAgents(records).some((x) => x.id === t.agent),
    suspended_patterns: suspendedPatterns(records).filter((x) => x.agent === t.agent).map((x) => ({ pattern: x.id, setups: x.setups, mean_r: x.mean_r })),
    walk_forward: t.agent === DEFAULT_AGENT && wf ? { verdict: wf.verdict ?? null, independent: wf.independent ?? null, discovery: wf.discovery ?? null, holdout: wf.holdout ?? null } : unavailable("the plan learner's referee is learned on zone_pullback's setups only")
  };
}

const HELD_SQL = "SELECT h.decision_key, h.held_at, h.reason, json_extract(e.decision_json, '$.trade.agent') AS agent, json_extract(e.decision_json, '$.trade.strategy') AS strategy FROM signal_ledger_held h LEFT JOIN engine_decisions e ON e.decision_key = h.decision_key WHERE h.held_at >= ? ORDER BY h.held_at DESC LIMIT ?";
const SCORES_SQL = (n) => `SELECT candle_key, stance, result, session, brier FROM outcome_scores WHERE subject = ? AND timeframe = '15' AND candle_key IN (${Array(n).fill("?").join(", ")})`;
const DEALS_SQL = "SELECT signal_id, reason, source, side, mode, opened_ms, closed_ms FROM ea_deals WHERE closed_ms >= ? ORDER BY closed_ms DESC LIMIT ?";
const RELEASES_SQL = "SELECT release_key, title, kind, time, surprise_z, gold_direction FROM econ_releases WHERE time >= ? AND time <= ? ORDER BY time LIMIT ?";

/** The 4-bar outcome of the Decision Engine's own stance on the trades' bars (outcome_scores, engine:15). */
async function scoresOf(db, trades) {
  const keys = [...new Set(trades.map((t) => t.key).filter(Boolean))];
  const rows = [];
  for (let i = 0; i < keys.length; i += 50) {
    const part = keys.slice(i, i + 50);
    rows.push(...(((await db.prepare(SCORES_SQL(part.length)).bind(ENGINE_SUBJECT, ...part).all()).results) || []));
  }
  const byKey = new Map(rows.map((r) => [r.candle_key, r]));
  const sum = (list) => {
    const xs = list.map((t) => byKey.get(t.key)).filter(Boolean);
    const hit = xs.filter((x) => x.result === "hit").length, miss = xs.filter((x) => x.result === "miss").length;
    return { scored: xs.length, hit, miss, neutral: xs.length - hit - miss, hit_rate: hit + miss ? r3(hit / (hit + miss)) : null };
  };
  const stopped = (t) => t.omega && STOP_EXITS.includes(t.omega.exit);
  return { subject: ENGINE_SUBJECT, horizon: "4 bars of 15m", all: sum(trades), omega_stopped: sum(trades.filter(stopped)), omega_not_stopped: sum(trades.filter((t) => t.omega && !stopped(t))) };
}

/** The real fills of the trades' signals (ea_deals.signal_id is the decision key); never money, volume or a price. */
async function executionsOf(db, trades, { now }) {
  const rows = ((await db.prepare(DEALS_SQL).bind(now - PACK_LIMITS.window_days * DAY, PACK_LIMITS.deals).all()).results) || [];
  const keys = new Set(trades.map((t) => t.key));
  const mine = rows.filter((r) => keys.has(r.signal_id));
  const count = (list, k) => Object.entries(list.reduce((a, r) => { const v = String(r[k] ?? "unknown"); a[v] = (a[v] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
  return {
    trades: trades.length, signals_with_a_fill: new Set(mine.map((r) => r.signal_id)).size, deals: mine.length,
    by_reason: count(mine, "reason"), by_source: count(mine, "source"),
    hold_minutes: quantiles(mine.map((r) => (finite(Number(r.opened_ms)) && finite(Number(r.closed_ms)) ? (Number(r.closed_ms) - Number(r.opened_ms)) / 60_000 : null)))
  };
}

/** Pure: the releases inside each losing trade's life, widened by the event gate (2 hours before, 30 minutes after a release). */
export function releasesNear(trades, releases) {
  const losing = trades.filter((t) => (t.omega && finite(t.omega.r) && t.omega.r < 0) || (t.plan && finite(t.plan.r) && t.plan.r < 0));
  const rows = [];
  for (const t of losing) {
    const o = toMs(t.opened_at), c = toMs(t.omega?.closed_at ?? t.plan?.closed_at ?? t.opened_at);
    for (const e of releases) {
      const at = toMs(e.time);
      if (!finite(at) || !finite(o)) continue;
      if (at - EVENT_GATE.before_ms <= (finite(c) ? c : o) && at + EVENT_GATE.after_ms >= o) rows.push({ trade: `signal_ledger/${t.id}`, release: e.release_key, title: clip(e.title, 80), kind: e.kind, minutes_from_open: Math.round((at - o) / 60_000), surprise_z: num(e.surprise_z), gold_direction: num(e.gold_direction) });
    }
  }
  return { losing_trades: losing.length, inside_a_release_window: new Set(rows.map((r) => r.trade)).size, window: { before_minutes: EVENT_GATE.before_ms / 60_000, after_minutes: EVENT_GATE.after_ms / 60_000 }, rows: rows.slice(0, 100) };
}

async function releasesFor(db, trades) {
  const times = trades.flatMap((t) => [toMs(t.opened_at), toMs(t.omega?.closed_at ?? t.plan?.closed_at ?? t.opened_at)]).filter(finite);
  if (!times.length) return [];
  return ((await db.prepare(RELEASES_SQL).bind(iso(Math.min(...times) - EVENT_GATE.after_ms), iso(Math.max(...times) + EVENT_GATE.before_ms), PACK_LIMITS.releases).all()).results) || [];
}

const PRIOR = unavailable("no earlier council decision on this topic is stored");

async function safe(what, fn) { try { return await fn(); } catch (e) { return failed(what, e); } }

async function strategyPack(env, t, { now, asOf, refs }) {
  const db = env.DB;
  const state = await readPlanLearning(env);
  const records = Array.isArray(state?.agents) ? state.agents : [];
  const statuses = agentStatuses(env, { records });
  const agent = agentCatalog(statuses).find((a) => a.id === t.agent);
  const all = await readDecisionTrades(db, { now });
  const trades = tradesOfTopic(all, t);
  refs.push(...tradeRefs(trades, asOf));
  // The learner's state is cited only when it is stored: a ref to nothing is not evidence.
  if (state && records.some((r) => r?.agent === t.agent || r?.id === t.agent)) refs.push(evRef("plan_learning", "state", { asOf: state.generated_at ?? null, field: `agents.${t.agent}` }));
  const setupRows = await safe("plan_setups", async () => { await ensurePlanLearningSchema(db); return ((await db.prepare(SETUPS_SQL).bind(iso(now - PACK_LIMITS.window_days * DAY), t.agent, PACK_LIMITS.setups).all()).results) || []; });
  const learned = Array.isArray(setupRows) ? setupSections(setupRows, t) : { setups: setupRows, invalidation: setupRows };
  if (Array.isArray(setupRows)) refs.push(...setupRows.slice(0, 20).map((r) => evRef("plan_setups", r.setup_key, { field: "results_json" })));
  const held = await safe("signal_ledger_held", async () => {
    const rows = ((await db.prepare(HELD_SQL).bind(iso(now - PACK_LIMITS.window_days * DAY), PACK_LIMITS.held).all()).results) || [];
    const mine = rows.filter((r) => (AGENT_IDS.includes(r.agent) ? r.agent : AGENT_IDS.includes(r.strategy) ? r.strategy : DEFAULT_AGENT) === t.agent);
    const reasons = Object.entries(mine.reduce((a, r) => { a[r.reason ?? "unknown"] = (a[r.reason ?? "unknown"] || 0) + 1; return a; }, {})).map(([reason, n]) => ({ reason, n }));
    return { held: mine.length, read: rows.length, reasons, note: "decisions the no-stacking rule held back; the agent is the decision's trade agent (zone_pullback before the agents)" };
  });
  return {
    scope: { agent: t.agent, label: agent?.label ?? t.agent, status: statuses[t.agent] ?? null, family: agent?.family ?? null, pattern: t.pattern, focus: t.focus, context: t.context, patterns_traded: patternsOf(t.agent).length },
    trades: tradesSection(trades),
    exits: exitsSection(trades, { byPattern: patternsOf(t.agent).length > 0 }),
    entry_actions: entryActionsSection(trades, all),
    excursions: excursionsSection(trades),
    invalidation: learned.invalidation,
    setups: learned.setups,
    record: recordSection(state, t, statuses),
    held,
    scores: trades.length ? await safe("outcome_scores", () => scoresOf(db, trades)) : unavailable("no resolved trade of this topic in the window"),
    executions: await safe("ea_deals", () => executionsOf(db, trades, { now })),
    calendar: await safe("econ_releases", async () => releasesNear(trades, await releasesFor(db, trades))),
    prior: PRIOR
  };
}

// ---------------------------------------------------------------------------------------------- other types

async function snapshotCards(db, days) {
  const row = await db.prepare("SELECT computed_at, body FROM scorecard_snapshots WHERE days = ? AND scoring_version = ?").bind(days, SCORING_VERSION).first();
  return row ? { computed_at: row.computed_at, cards: parse(row.body, []) || [] } : null;
}
const cardView = (c) => (c ? { n: c.n, directional: c.directional, wait: c.wait, brier: c.brier ?? null, by_session: c.by_session ?? {} } : null);

async function seatPack(env, t, { now, asOf, refs }) {
  const db = env.DB;
  const roster = agentRoster({}).find((a) => a.id === t.seat);
  const charts = t.chart ? [t.chart] : CHARTS;
  const reputation = await safe("scorecard_snapshots", async () => {
    const out = {};
    for (const days of [7, 30]) {
      const snap = await snapshotCards(db, days);
      if (!snap) { out[`${days}d`] = unavailable(`no stored ${days}-day scorecard (scorecard_snapshots)`); continue; }
      out[`${days}d`] = { computed_at: snap.computed_at, charts: charts.map((chart) => { const c = snap.cards.find((x) => x.subject === `agent:${t.seat}` && String(x.timeframe) === chart); return { chart, reputation: c ? reputationOf(c) : null, scorecard: cardView(c) }; }) };
      refs.push(evRef("scorecard_snapshots", `${days}d`, { asOf: snap.computed_at, field: `agent:${t.seat}` }));
    }
    return out;
  });
  const statements = await safe("outcome_scores", async () => {
    const rows = ((await db.prepare("SELECT timeframe, candle_key, stance, result, session, brier, statement_close FROM outcome_scores WHERE subject = ? AND statement_close >= ? ORDER BY statement_close DESC LIMIT ?").bind(`agent:${t.seat}`, iso(now - 30 * DAY), PACK_LIMITS.statements).all()).results) || [];
    const mine = rows.filter((r) => charts.includes(String(r.timeframe)));
    refs.push(...mine.slice(0, 20).map((r) => evRef("outcome_scores", `agent:${t.seat}/${r.timeframe}/${r.candle_key}`, { field: "result" })));
    const by = (k) => Object.entries(mine.reduce((a, r) => { const v = String(r[k] ?? "unknown"); a[v] = (a[v] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
    return { read: rows.length, n: mine.length, by_stance: by("stance"), by_result: by("result"), by_session: by("session"), note: "the seat's scored statements of the last 30 days (newest 200)" };
  });
  const compliance = await safe("compliance_checks", async () => {
    const rows = ((await db.prepare("SELECT check_id, chart, step, bar_time FROM compliance_checks WHERE bar_time >= ? AND agent = ? ORDER BY bar_time DESC LIMIT ?").bind(iso(now - 30 * DAY), t.seat, PACK_LIMITS.compliance).all()).results) || [];
    const by = Object.entries(rows.reduce((a, r) => { a[r.check_id] = (a[r.check_id] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).map(([check, n]) => ({ check, n }));
    return { findings: rows.length, by_check: by, note: "deterministic rule findings on the seat's room messages (src/compliance.mjs), last 30 days" };
  });
  return {
    scope: { seat: t.seat, name: roster?.name ?? t.seat, rooms: roster?.rooms ?? [], chart: t.chart },
    reputation, statements, compliance,
    room_runs: unavailable("a seat's own text sits inside whole run documents (room_runs); reading one seat would read every document, so this pack cites its scored statements instead"),
    owner_corrections: unavailable("owner corrections are kept in the council sessions and are not read into a seat pack yet"),
    prior: PRIOR
  };
}

async function enginePack(env, t, { now, asOf, refs }) {
  const db = env.DB;
  if (t.engine === "model") {
    const baseline = await readBaseline(env);
    if (!baseline) return { baseline: unavailable("no self-trained baseline is stored (or MODEL_BASELINE_MODE is off)"), prior: PRIOR };
    refs.push(evRef("model_baseline", "state", { asOf: baseline.trained_at ?? null, field: "promotion.status" }));
    return {
      baseline: { trained_at: baseline.trained_at ?? null, rows: baseline.rows ?? null, status: baseline.status ?? null, checks: baseline.checks ?? null, prospective: baseline.prospective ?? {}, promotion: baseline.promotion ?? null },
      note: "the self-trained baseline's gate (src/model-baseline.mjs promotionGate); its advice reaches the council only while promoted",
      prior: PRIOR
    };
  }
  const decisions = await safe("engine_decisions", async () => {
    await ensureDecisionSchema(db);
    const rows = ((await db.prepare("SELECT decision_key, bar_close, stance, source, json_extract(decision_json, '$.overruled') AS overruled, json_extract(decision_json, '$.quorum.score') AS score, json_extract(decision_json, '$.trading_mode') AS mode, json_extract(decision_json, '$.trade.agent') AS agent, json_extract(decision_json, '$.trade.strategy') AS strategy FROM engine_decisions ORDER BY bar_close DESC LIMIT ?").bind(PACK_LIMITS.decisions).all()).results) || [];
    const count = (vals) => Object.entries(vals.reduce((a, v) => { const k = String(v ?? "none"); a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
    const over = rows.map((r) => parse(r.overruled, null)).filter(Boolean);
    refs.push(...rows.slice(0, 10).map((r) => evRef("engine_decisions", r.decision_key, { field: "stance" })));
    return {
      n: rows.length, since: rows.at(-1)?.bar_close ?? null, by_stance: count(rows.map((r) => r.stance)), by_source: count(rows.map((r) => r.source)), by_mode: count(rows.map((r) => r.mode)),
      overruled: { n: over.length, by: count(over.map((o) => o.by)), failed_checks: count(over.flatMap((o) => (Array.isArray(o.failed) ? o.failed.map((f) => f.check) : []))) },
      quorum_score: quantiles(rows.map((r) => num(r.score))),
      trade_agents: count(rows.filter((r) => r.stance !== "WAIT").map((r) => (AGENT_IDS.includes(r.agent) ? r.agent : AGENT_IDS.includes(r.strategy) ? r.strategy : DEFAULT_AGENT))),
      note: "the newest 200 15m decisions; overruled is a guardrail or the strategy agents holding a BUY or SELL at WAIT"
    };
  });
  const scores = await safe("scorecard_snapshots", async () => {
    const out = {};
    for (const days of [7, 30]) {
      const snap = await snapshotCards(db, days);
      const c = snap?.cards.find((x) => x.subject === ENGINE_SUBJECT && String(x.timeframe) === "15");
      out[`${days}d`] = snap ? { computed_at: snap.computed_at, ...(cardView(c) ?? { n: 0 }) } : unavailable(`no stored ${days}-day scorecard`);
      if (snap) refs.push(evRef("outcome_summary", `${ENGINE_SUBJECT}/${days}d`, { asOf: snap.computed_at, field: "hit_rate" }));
    }
    return out;
  });
  const witness = await safe("auto_tune_runs", async () => {
    const rows = ((await db.prepare("SELECT ran_at, status, apply_status, push_status FROM auto_tune_runs WHERE step = 'witness' AND ran_at >= ? ORDER BY ran_at DESC LIMIT 60").bind(iso(now - 30 * DAY)).all()).results) || [];
    const applied = rows.filter((r) => r.apply_status && !["unchanged", "disabled"].includes(r.apply_status));
    return { runs: rows.length, changes: applied.map((r) => ({ ran_at: r.ran_at, apply_status: r.apply_status })), failed: rows.filter((r) => r.status === "failed").length, note: "the witness weights' auto-tuning steps of the last 30 days (src/witness-tuning.mjs)" };
  });
  return { decisions, scores, witness_tuning: witness, prior: PRIOR };
}

async function riskPack(env, t, { now, asOf, refs }) {
  const all = await readDecisionTrades(env.DB, { now });
  const trades = all.filter((x) => x[t.dimension] === t.value).slice(0, PACK_LIMITS.trades);
  refs.push(...tradeRefs(trades, asOf));
  return {
    scope: { dimension: t.dimension, value: t.value },
    trades: tradesSection(trades),
    exits: exitsSection(trades, { byAgent: true }),
    excursions: excursionsSection(trades),
    loss_runs: { omega: lossRuns(trades, omegaExit), ledger: lossRuns(trades, ledgerExit), note: "in time order: the longest run of losing trades, the current one, and the deepest drawdown in R" },
    compared_with_all: { all_trades: all.length, ...exitsOf(all.slice(0, PACK_LIMITS.trades)) },
    prior: PRIOR
  };
}

async function newsPack(env, t, { now, asOf, refs }) {
  const db = env.DB;
  const releases = await safe("econ_releases", async () => ((await db.prepare(RELEASES_SQL).bind(iso(now - 30 * DAY), iso(now), PACK_LIMITS.releases).all()).results) || []);
  const trades = await readDecisionTrades(db, { now });
  const inside = Array.isArray(releases) ? releasesNear(trades, releases) : releases;
  if (Array.isArray(releases)) refs.push(...releases.slice(-20).map((r) => evRef("econ_releases", r.release_key, { field: "surprise_z" })));
  const insideKeys = new Set((inside.rows || []).map((r) => r.trade.replace("signal_ledger/", "")));
  return {
    releases: Array.isArray(releases) ? { n: releases.length, window_days: 30, rows: releases.slice(-100).map((r) => ({ ref: `econ_releases/${r.release_key}`, title: clip(r.title, 80), kind: r.kind, time: r.time, surprise_z: num(r.surprise_z), gold_direction: num(r.gold_direction) })) } : releases,
    losing_trades_near_releases: inside,
    exits_inside_vs_outside: { inside: exitsOf(trades.filter((x) => insideKeys.has(x.id))), outside: exitsOf(trades.filter((x) => !insideKeys.has(x.id))), note: "inside: losing trades whose life overlapped a release's gate window" },
    drift_alerts: unavailable("no news drift health alert exists (src/health-alerts.mjs has no such kind)"),
    calendar_witness: unavailable("the CALENDAR witness has no scored record of its own (outcome scoring scores the rooms, the seats and the engine)"),
    scope: { kind: t.kind },
    prior: PRIOR
  };
}

const digitsOut = (s) => clip(String(s ?? "").replace(/\d+(\.\d+)?/g, "#"), 120);

async function executionPack(env, t, { now, asOf, refs }) {
  const db = env.DB;
  const since = now - PACK_LIMITS.short_days * DAY;
  const events = await safe("omega_events", async () => {
    const rows = (((await db.prepare("SELECT id, ms, actor, action FROM omega_events ORDER BY id DESC LIMIT ?").bind(PACK_LIMITS.events).all()).results) || []).filter((r) => Number(r.ms) >= since);
    const by = Object.entries(rows.reduce((a, r) => { const k = `${r.action}|${r.actor}`; a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ action: k.split("|")[0], actor: k.split("|")[1], n }));
    refs.push(...rows.filter((r) => r.action === "autonomous_recovery").slice(0, 10).map((r) => evRef("omega_events", r.id, { field: "action" })));
    return { n: rows.length, window_days: PACK_LIMITS.short_days, by_action: by, recoveries: rows.filter((r) => r.action === "autonomous_recovery").map((r) => ({ at: iso(Number(r.ms)), actor: r.actor })).slice(0, 50) };
  });
  const intents = await safe("omega_intents", async () => {
    const rows = ((await db.prepare("SELECT id, kind, status, result, created_ms FROM omega_intents WHERE created_ms >= ? ORDER BY created_ms DESC LIMIT ?").bind(since, PACK_LIMITS.intents).all()).results) || [];
    const by = Object.entries(rows.reduce((a, r) => { const k = `${r.kind}|${r.status}`; a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ kind: k.split("|")[0], status: k.split("|")[1], n }));
    const errors = Object.entries(rows.filter((r) => r.status === "failed").reduce((a, r) => { const e = digitsOut(parse(r.result, {})?.error ?? "no error text"); a[e] = (a[e] || 0) + 1; return a; }, {})).map(([error, n]) => ({ error, n }));
    refs.push(...rows.filter((r) => r.status === "failed").slice(0, 10).map((r) => evRef("omega_intents", r.id, { field: "status" })));
    return { n: rows.length, by_kind_status: by, failed_errors: errors, note: "the terminal's error text with every number replaced by #" };
  });
  const trades = await readDecisionTrades(db, { now });
  const fills = await safe("ea_deals", async () => {
    const rows = ((await db.prepare(DEALS_SQL).bind(since, PACK_LIMITS.deals).all()).results) || [];
    const keys = new Set(trades.map((x) => x.key));
    const count = (k) => Object.entries(rows.reduce((a, r) => { const v = String(r[k] ?? "unknown"); a[v] = (a[v] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
    return { deals: rows.length, with_a_signal: rows.filter((r) => r.signal_id).length, matching_a_ledger_trade: rows.filter((r) => keys.has(r.signal_id)).length, by_reason: count("reason"), by_source: count("source"), by_mode: count("mode"), note: "real fills, last 7 days; never money, volume or a price" };
  });
  const omegaTrades = trades.filter((x) => x.omega).slice(0, PACK_LIMITS.trades);
  refs.push(...tradeRefs(omegaTrades, asOf));
  return {
    scope: { kind: t.kind },
    omega_events: events, intents, fills,
    sl_plus_in_practice: {
      omega: { trades: omegaTrades.length, protected: omegaTrades.filter((x) => x.omega.protected).length, sl_moves: quantiles(omegaTrades.map((x) => x.omega.sl_moves)), tp_moves: quantiles(omegaTrades.map((x) => x.omega.tp_moves)), ...tally(omegaTrades.map(omegaExit)) },
      ledger: { trades: trades.filter((x) => x.plan).length, ...tally(trades.filter((x) => x.plan).slice(0, PACK_LIMITS.trades).map(ledgerExit)) },
      note: "Omega's stop moves behind passed key levels (protected = SL+ reached) beside the ledger's breakeven SL+"
    },
    prior: PRIOR
  };
}

const DATA_ALERT_KINDS = Object.freeze(["parity_revoked", "input_mismatch", "market_data_stale", "market_data_fallback", "webhook_rejected", "webhook_silent"]);

async function dataPack(env, t, { now, refs }) {
  const db = env.DB;
  const stuck = await safe("stuck_states", async () => {
    const rows = ((await db.prepare("SELECT field, value, first_candle_key, last_candle_key, candles, price_range, atr, status, detected_at, updated_at FROM stuck_states WHERE status = 'open' ORDER BY updated_at DESC LIMIT 50").all()).results) || [];
    const mine = STUCK_FEEDS.includes(t.feed) ? rows.filter((r) => String(r.field).startsWith(t.feed + ".")) : rows;
    refs.push(...mine.slice(0, 10).map((r) => evRef("stuck_states", `${r.field}/${r.first_candle_key}`, { field: "candles" })));
    return { open: mine.length, rows: mine.map((r) => ({ field: r.field, value: r.value, candles: num(r.candles), range_atr: finite(num(r.price_range)) && num(r.atr) > 0 ? r3(num(r.price_range) / num(r.atr)) : null, first_candle_key: r.first_candle_key, last_candle_key: r.last_candle_key, detected_at: r.detected_at })), note: "range_atr: the price range of the stuck run in 1H ATR" };
  });
  const alerts = await safe("health_alerts", async () => {
    const rows = (((await db.prepare("SELECT alert_key, kind, status, subject, opened_at, resolved_at FROM health_alerts ORDER BY rowid DESC LIMIT 300").all()).results) || []).filter((r) => DATA_ALERT_KINDS.includes(r.kind) && (r.status === "open" || toMs(r.opened_at) >= now - 30 * DAY));
    refs.push(...rows.slice(0, 10).map((r) => evRef("health_alerts", r.alert_key, { field: "status" })));
    return { n: rows.length, open: rows.filter((r) => r.status === "open").length, rows: rows.slice(0, 50).map((r) => ({ kind: r.kind, status: r.status, subject: digitsOut(r.subject), opened_at: r.opened_at, resolved_at: r.resolved_at })), note: "the data health alerts open now or opened in the last 30 days; numbers in the subject replaced by #" };
  });
  const parity = await safe("engine_parity_registry", async () => {
    const rows = ((await db.prepare("SELECT engine, status, consecutive_matches, updated_at FROM engine_parity_registry ORDER BY updated_at DESC LIMIT 50").all()).results) || [];
    return { engines: rows.map((r) => ({ engine: r.engine, status: r.status, consecutive_matches: num(r.consecutive_matches), updated_at: r.updated_at })) };
  });
  const tv = await safe("tv_call_budget", async () => {
    const rows = ((await db.prepare("SELECT day, used, daily, updated_at FROM tv_call_budget WHERE day >= ? ORDER BY day DESC LIMIT 14").bind(iso(now - PACK_LIMITS.short_days * DAY).slice(0, 10)).all()).results) || [];
    return { days: rows.map((r) => ({ day: r.day, used: num(r.used), daily: num(r.daily) })) };
  });
  return { scope: { feed: t.feed }, stuck_states: stuck, alerts, parity, tv_budget: tv, prior: PRIOR };
}

/** Pure: neurons per day and source (the model is used for the rate only and never kept). */
export function usageBySource(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const k = `${r.day}|${r.source}`;
    const a = out.get(k) ?? { day: r.day, source: r.source, calls: 0, failed: 0, timeouts: 0, prompt_tokens: 0, completion_tokens: 0, neurons: 0, unpriced_calls: 0 };
    a.calls += Number(r.calls) || 0; a.failed += Number(r.failed) || 0; a.timeouts += Number(r.timeouts) || 0;
    a.prompt_tokens += Number(r.prompt_tokens) || 0; a.completion_tokens += Number(r.completion_tokens) || 0;
    const n = neuronsOf(r.model, Number(r.prompt_tokens) || 0, Number(r.completion_tokens) || 0);
    if (n == null) a.unpriced_calls += Number(r.calls) || 0; else a.neurons += n;
    out.set(k, a);
  }
  return [...out.values()].sort((a, b) => b.day.localeCompare(a.day) || a.source.localeCompare(b.source));
}

/** Pure: per source, the neurons of the last 7 days against the 7 before. */
export function weekOverWeek(perDay, now) {
  const cut = iso(now - 7 * DAY).slice(0, 10), floor = iso(now - 14 * DAY).slice(0, 10);
  const by = new Map();
  for (const r of perDay) {
    if (r.day <= floor) continue;
    const a = by.get(r.source) ?? { source: r.source, last_7d: 0, prior_7d: 0 };
    if (r.day > cut) a.last_7d += r.neurons; else a.prior_7d += r.neurons;
    by.set(r.source, a);
  }
  return [...by.values()].map((a) => ({ ...a, growth: a.prior_7d > 0 ? r3(a.last_7d / a.prior_7d - 1) : null })).sort((a, b) => b.last_7d - a.last_7d);
}

export const USAGE_SQL = "SELECT day, source, model, calls, failed, timeouts, prompt_tokens, completion_tokens FROM ai_usage_daily WHERE day >= ? ORDER BY day DESC LIMIT 2000";

async function costPack(env, t, { now, refs }) {
  const db = env.DB;
  const matches = (s) => (t.source === "shadow" ? String(s).startsWith("shadow:") : s === t.source);
  const usage = await safe("ai_usage_daily", async () => {
    const rows = ((await db.prepare(USAGE_SQL).bind(iso(now - PACK_LIMITS.usage_days * DAY).slice(0, 10)).all()).results) || [];
    const perDay = usageBySource(rows);
    const mine = perDay.filter((r) => matches(r.source));
    refs.push(...mine.slice(0, 14).map((r) => evRef("ai_usage_daily", `${r.day}/${r.source}`, { field: "neurons" })));
    const totals = new Map();
    for (const r of perDay) totals.set(r.day, (totals.get(r.day) || 0) + r.neurons);
    return { window_days: PACK_LIMITS.usage_days, this_source: mine, week_over_week: weekOverWeek(perDay, now).filter((r) => matches(r.source)), all_sources_per_day: [...totals].map(([day, neurons]) => ({ day, neurons })), note: "estimated neurons (src/ai-usage.mjs NEURON_RATES); calls of a model without a published rate are counted apart" };
  });
  const switches = await safe("shadow_switch_events", async () => {
    const rows = ((await db.prepare("SELECT id, at, mode, previous_mode, reason, actor FROM shadow_switch_events ORDER BY id DESC LIMIT 50").all()).results) || [];
    return { n: rows.length, breaker_trips: rows.filter((r) => r.actor === "cost-breaker").length, rows: rows.slice(0, 20).map((r) => ({ at: r.at, mode: r.mode, previous_mode: r.previous_mode, actor: r.actor, reason: clip(r.reason, 160) })) };
  });
  return { scope: { source: t.source }, usage, shadow_switch: switches, prior: PRIOR };
}

async function knowledgePack(env, t, { now, refs }) {
  const db = env.DB;
  const item = await safe("learned_live", async () => {
    const rows = ((await db.prepare("SELECT item_id, version, status, item_json, verdict_json, promoted_at, retired_at, reason FROM learned_live WHERE item_id = ? ORDER BY version DESC LIMIT 10").bind(t.item).all()).results) || [];
    refs.push(...rows.map((r) => evRef("learned_live", `${r.item_id}/v${r.version}`, { field: "status" })));
    if (!rows.length) return unavailable("this item was never live (learned_live)");
    return { versions: rows.map((r) => { const it = parse(r.item_json, {}) || {}; return { version: r.version, status: r.status, promoted_at: r.promoted_at, retired_at: r.retired_at, reason: clip(r.reason, 300), text: clip(it.text, 600), audience: it.audience ?? null, verdict: stripPrices(parse(r.verdict_json, null)) }; }) };
  });
  const shadow = await safe("shadow_agent_outputs", async () => {
    const rows = ((await db.prepare("SELECT subject, agent, arm, stance, control_stance, result, control_result, statement_close FROM shadow_agent_outputs WHERE created_at >= ? AND item_id = ? ORDER BY created_at DESC LIMIT 500").bind(iso(now - PACK_LIMITS.window_days * DAY), t.item).all()).results) || [];
    const scored = rows.filter((r) => r.result && r.control_result);
    const right = (x) => x === "hit";
    return { outputs: rows.length, scored: scored.length, note_right: scored.filter((r) => right(r.result)).length, control_right: scored.filter((r) => right(r.control_result)).length, agents: [...new Set(rows.map((r) => r.agent))].sort(), note: "the shadow knowledge arm's answers with the note against the same agent's live answer (src/shadow-knowledge.mjs)" };
  });
  return { scope: { item: t.item }, item, shadow, owner_corrections: unavailable("owner corrections are kept in the council sessions and are not read into this pack yet"), prior: PRIOR };
}

/**
 * The topic keys a free topic reads (owner 2026-11-17: a free topic must never run on an empty pack): always the
 * Decision Engine, the default strategy's exits and Omega's fills; then by the words of its slug, the strategies, the
 * SL+ in practice, the releases, the trading mode's risk and the rejected intents.
 */
export function freeTopicKeys(slug) {
  const w = String(slug ?? "");
  const keys = ["engine:15", "strategy:zone_pullback:exits", "execution:fills"];
  if (/strateg|arm|agent|setup|entry|grid/.test(w)) keys.push(...AGENT_IDS.filter((a) => a !== "zone_pullback").slice(0, 3).map((a) => `strategy:${a}`));
  if (/sl|stop|exit|tp|trail|lock|key-?level/.test(w)) keys.push("execution:sl_plus");
  if (/news|berita|calendar|kalender|release|rilis/.test(w)) keys.push("news:release_horizon");
  if (/risk|risiko|loss|rugi|drawdown|session|sesi/.test(w)) keys.push("risk:scalp");
  if (/reject|tolak|intent|order|eksekusi|execution/.test(w)) keys.push("execution:rejected_intents");
  return [...new Set(keys)].slice(0, 8);
}

async function freePack(env, t, ctx) {
  const out = { scope: { slug: t.slug, reads: freeTopicKeys(t.slug) } };
  for (const key of out.scope.reads) {
    const sub = parseTopicKey(key);
    if (!sub.ok) continue;
    let sections;
    try {
      sections = sub.type === "strategy" ? await strategyPack(env, sub, ctx) : sub.type === "engine" ? await enginePack(env, sub, ctx) : sub.type === "execution" ? await executionPack(env, sub, ctx) : sub.type === "news" ? await newsPack(env, sub, ctx) : sub.type === "risk" ? await riskPack(env, sub, ctx) : null;
    } catch (e) { sections = { error: failed(key, e) }; }
    for (const [name, sec] of Object.entries(sections ?? {})) if (name !== "prior") out[`${key}.${name}`] = sec;
  }
  // The strategy council's latest verdicts (walk-forward and proposal per strategy) and the arm state.
  out.strategy_council = await safe("strategy council", async () => {
    const rows = (await env.DB.prepare("SELECT day, strategy_id, proposal, reason, walk_forward FROM strategy_council_runs WHERE day = (SELECT MAX(day) FROM strategy_council_runs) ORDER BY strategy_id").all()).results ?? [];
    if (!rows.length) return unavailable("no strategy council verdict yet");
    return { rows: rows.map((r) => { const wf = (() => { try { return JSON.parse(r.walk_forward); } catch { return {}; } })(); return { strategy: r.strategy_id, walk_forward: wf.status ?? null, setups: wf.n ?? null, mean_r: wf.mean_r ?? null, proposal: r.proposal, reason: clip(r.reason, 160), ref: `strategy_council/${r.day}:${r.strategy_id}` }; }) };
  });
  out.strategy_arm = await safe("strategy arm", async () => {
    const rows = (await env.DB.prepare("SELECT strategy_id FROM strategy_arms WHERE armed = 1 ORDER BY strategy_id").all()).results ?? [];
    return { mode: rows.length ? "armed" : "auto", armed: rows.map((r) => r.strategy_id) };
  });
  return { ...out, prior: PRIOR };
}

/**
 * The evidence pack of a topic key, or { error } for a key the grammar refuses. Read-only: it reads D1 and KV and
 * writes nothing but the runtime schemas the readers of those tables already ensure.
 */
export async function buildEvidencePack(env, topicKey, { now = Date.now() } = {}) {
  const t = parseTopicKey(topicKey);
  if (!t.ok) return { error: t.error };
  if (!env?.DB) return { error: "no database binding" };
  const asOf = iso(now), refs = [];
  const ctx = { now, asOf, refs };
  let sections;
  switch (t.type) {
    case "strategy": sections = await strategyPack(env, t, ctx); break;
    case "seat": sections = await seatPack(env, t, ctx); break;
    case "engine": sections = await enginePack(env, t, ctx); break;
    case "risk": sections = await riskPack(env, t, ctx); break;
    case "news": sections = await newsPack(env, t, ctx); break;
    case "execution": sections = await executionPack(env, t, ctx); break;
    case "data": sections = await dataPack(env, t, ctx); break;
    case "cost": sections = await costPack(env, t, ctx); break;
    case "knowledge": sections = await knowledgePack(env, t, ctx); break;
    default: sections = await freePack(env, t, ctx);
  }
  // Every row ref of the sections' tables is a ref of the pack too.
  for (const s of Object.values(sections)) for (const row of s?.rows ?? []) if (typeof row?.ref === "string") { const [source, ...id] = row.ref.split("/"); refs.push(evRef(source, id.join("/"), { asOf })); }
  return finalizePack({ topic: t.key, type: t.type, as_of: asOf, sections, refs });
}
