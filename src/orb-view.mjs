// GET /api/orb (Track B, B14): the Nexus ORB page's read of the London and New York opening ranges and the
// orb_breakout agent (Track A PR 7-9), cryptophys.orb-view.v1. Nexus only (behind Cloudflare Access): one of the few
// read routes that carry prices, and every price here is the TradingView feed's (OANDA:XAUUSD closed 15m bars,
// `scale.prices` "feed"): the ranges' edges and the agent's plans. It is never part of a public route.
//
//   reads    the strategy memo (readStrategyMemo: price, atr_h1, key_levels.zones), KV the feed's 15m series,
//            decision-engine:latest (strategy_plans' orb_breakout plans, session_range, the trade), the cached economic
//            calendar, plan-learning:v1 (the agent's per-session records, the breaker); D1 SELECTs of engine_decisions
//            (the decision when KV has none) and plan_setups (the recent sessions). A table not created yet reads as empty.
//   rules    never re-implemented: openingRanges, orbMode, orbLevelsMode and rangeBreakout (src/opening-range.mjs),
//            orbWidthStatus, AGENT_RULES and suspendedPatterns (src/strategy-agents.mjs), sessionOpenMs and goldPausedAt
//            (src/market-hours.mjs), CONTROL_ARM (src/plan-learning.mjs).
//   never    a write, a DDL statement, an account, login, server or identity key.
import { openingRanges, orbMode, orbLevelsMode, rangeBreakout, OPENING_RANGE_SESSIONS, ORB_READING_BANDS } from "./opening-range.mjs";
import { AGENT_RULES, orbWidthStatus, suspendedPatterns } from "./strategy-agents.mjs";
import { sessionOpenMs, goldPausedAt, goldClosedAt } from "./market-hours.mjs";
import { CONTROL_ARM, PLAN_LEARNING_KEY } from "./plan-learning.mjs";
import { DECISION_LATEST_KEY } from "./decision-engine.mjs";
import { cachedCalendar } from "./econ-calendar.mjs";
import { atr } from "./strategy-engine.mjs";

export const ORB_VIEW_SCHEMA = "cryptophys.orb-view.v1";
/** The recent ORB sessions shown (plan_setups of orb_breakout, newest first). */
export const RECENT_SESSIONS = 10;
/** The 15m bars read: two days, more than either window needs. */
export const VIEW_BARS = 192;
const SYMBOL = "OANDA:XAUUSD";
const M15 = 15 * 60_000;
const NAME = Object.freeze({ orb_london: "london", orb_new_york: "new_york" });
const STATUS_DETAIL = Object.freeze({
  ok: "the range is formed and inside the width band",
  not_formed: "the first three 15m bars of the session are still coming",
  window_over: "the session's window is over",
  market_paused: "gold is not trading",
  range_incomplete: "a bar of the range is missing",
  range_event: "a high-impact release fell inside the range, so the session is not traded",
  session_clock_mismatch: "London is silent this week: the United States and the United Kingdom changed clocks on different dates",
  too_narrow: "the range is narrower than the width band",
  too_wide: "the range is wider than the width band"
});
const NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (finite(v) ? Math.round(v * 100) / 100 : null);
const str = (v) => (typeof v === "string" && v ? v : null);
const parse = (s, d = null) => { try { return typeof s === "string" ? JSON.parse(s) : (s ?? d); } catch { return d; } };
const noTable = (e) => /no such table/i.test(String(e?.message ?? e));
const isoMs = (s) => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? t : null; };
const dateNy = (ms) => (finite(ms) ? NY_DATE.format(new Date(ms)) : null);

/** A SELECT's rows; a table not created yet is none. Any other error throws (the route answers orb_unavailable). */
async function select(db, sql, ...params) {
  if (!db?.prepare) return [];
  try { return (await db.prepare(sql).bind(...params).all())?.results ?? []; } catch (e) { if (noTable(e)) return []; throw e; }
}
async function kvJson(kv, key) {
  try { return parse(await kv?.get?.(key), null); } catch { return null; }
}

/** Pure: the next session open after `now` on a trading day ({ session, open_ms }), or null within a week. */
export function nextRange(now) {
  let best = null;
  for (const s of OPENING_RANGE_SESSIONS) {
    for (let k = 1; k <= 8 * 24; k++) {
      const open = sessionOpenMs(s.name, now + k * 3_600_000);
      if (finite(open) && open > now && !goldClosedAt(open)) { if (!best || open < best.open_ms) best = { session: NAME[s.key], open_ms: open }; break; }
    }
  }
  return best;
}

/** Pure: a session's plan of the decision's orb_breakout on one side, in the view's shape, or null. */
function planOf(record, side, key) {
  const p = record?.strategy_plans?.[side]?.orb_breakout;
  if (!p || p.pattern !== key) return null;
  const trade = record?.trade, dir = side === "long" ? "BUY" : "SELL";
  return {
    entry: r2(p.entry), stop: r2(p.stop), tp1: r2(p.tp1), tp2: r2(p.tp2), rrr: finite(p.rrr?.tp1) ? p.rrr.tp1 : null,
    entry_type: p.at_level ? "at_level" : "limit", lapse_ms: finite(p.valid_until_ms) ? p.valid_until_ms : null,
    role: str(p.status), picked: trade?.strategy === "orb_breakout" && trade?.pattern === key && trade?.side === dir
  };
}

/** Pure: one session's card from its range (openingRanges), the bars, the ATR, the events, the zones and the decision. */
export function sessionCard(r, { bars = [], at, atrH1 = null, events = [], zones = [], record = null } = {}) {
  const width = orbWidthStatus(r, atrH1);
  const status = r.status === "ok" && width && width !== "ok" ? width : r.status;
  const phase = !finite(r.open_ms) ? null : r.status === "not_formed" ? "forming" : at >= r.end_ms ? "over" : "live";
  const built = finite(r.open_ms) ? bars.filter((b) => isoMs(b.open_time) >= r.open_ms && isoMs(b.open_time) < r.range_end_ms && isoMs(b.close_time) <= at).length : 0;
  const b = r.status === "ok" ? rangeBreakout(r, bars.filter((x) => isoMs(x.close_time) <= Math.min(at, r.end_ms)), { atr: atrH1 }) : null;
  const state = !b ? "none" : b.invalidated ? "invalidated" : b.retesting ? "retesting" : b.held ? "held" : "back_inside";
  const inRange = (events || []).filter((e) => { const t = isoMs(e?.time); return finite(t) && finite(r.open_ms) && t >= r.open_ms && t < r.range_end_ms && String(e?.impact ?? "").toLowerCase().startsWith("high") && (e?.currency == null || String(e.currency).toUpperCase() === "USD"); });
  const edge = (name, p) => (zones || []).filter((z) => finite(p) && finite(z?.low) && finite(z?.high) && p >= z.low && p <= z.high).map((z) => ({ edge: name, low: r2(z.low), high: r2(z.high), candidate: z.candidate === true }));
  return {
    variant: r.key, date_ny: dateNy(r.open_ms), open_ms: r.open_ms, range_end_ms: r.range_end_ms, end_ms: r.end_ms, phase,
    bars_built: built, bars_left: finite(r.end_ms) && phase !== "over" ? Math.max(0, Math.round((r.end_ms - at) / M15)) : 0,
    status, status_detail: STATUS_DETAIL[status] ?? null,
    high: r2(r.high), low: r2(r.low), mid: r2(r.mid), width: r2(r.width), width_atr: finite(r.width) && finite(atrH1) && atrH1 > 0 ? r2(r.width / atrH1) : null,
    breakout: { side: b ? (b.way === "up" ? "long" : "short") : null, bar_ms: b?.bar_ms ?? null, bars_since: b?.bars_since ?? null, state },
    invalidated: { long: Boolean(b && b.way === "up" && b.invalidated), short: Boolean(b && b.way === "down" && b.invalidated) },
    events_in_range: inRange.map((e) => ({ title: str(e.title) ?? str(e.event) ?? "release", time: str(e.time) })),
    edges_in_zones: r.status === "ok" ? [...edge("high", r.high), ...edge("low", r.low)] : [],
    plans: { long: planOf(record, "long", r.key), short: planOf(record, "short", r.key) }
  };
}

/** The view. `strategy` is the strategy memo (readStrategyMemo); `now` the read time. */
export async function readOrbView(env, { now = Date.now(), strategy = null } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  const series = await kvJson(kv, `market-data:v2:series:${SYMBOL}|15m`);
  const bars = (Array.isArray(series?.candles) ? series.candles : [])
    .filter((x) => finite(x?.close) && x.close > 0 && isoMs(x.close_time) !== null && isoMs(x.close_time) <= now)
    .sort((a, b) => isoMs(a.close_time) - isoMs(b.close_time)).slice(-VIEW_BARS);
  const at = bars.length ? isoMs(bars.at(-1).close_time) : now;
  const price = finite(strategy?.price) ? r2(strategy.price) : r2(bars.at(-1)?.close ?? null);
  const atrH1 = finite(strategy?.atr_h1) ? strategy.atr_h1 : null;
  const atrM15 = r2(atr(bars.slice(-15)));
  const events = (await cachedCalendar(env))?.events ?? [];
  const zones = Array.isArray(strategy?.key_levels?.zones) ? strategy.key_levels.zones : [];

  let record = await kvJson(kv, DECISION_LATEST_KEY);
  if (!record?.decision_key) record = parse((await select(db, "SELECT decision_json FROM engine_decisions ORDER BY bar_close DESC LIMIT 1"))[0]?.decision_json, null);

  // A session whose window is over is shown as it stood at its window's last bar (its range, breakout and status then).
  const ranges = openingRanges(bars, { events, now: at }).map((r) => {
    if (r.status !== "window_over" || !finite(r.end_ms)) return { r, at };
    const then = openingRanges(bars, { events, now: r.end_ms - 1 }).find((x) => x.key === r.key);
    return then && then.open_ms === r.open_ms ? { r: then, at: r.end_ms } : { r, at };
  });
  const sessions = Object.fromEntries(ranges.map(({ r, at: t }) => [NAME[r.key], sessionCard(r, { bars, at: t, atrH1, events, zones, record })]));
  const overlapOf = (side) => { const p = record?.strategy_plans?.[side]?.orb_breakout; return p && NAME[p.pattern] ? NAME[p.pattern] : null; };

  // The agent's record per session (the plan learner's, control arm) and the breaker.
  const learned = await kvJson(kv, PLAN_LEARNING_KEY);
  const agents = Array.isArray(learned?.agents) ? learned.agents : [];
  const mine = agents.find((a) => a?.agent === "orb_breakout");
  const held = suspendedPatterns(agents).filter((x) => x.agent === "orb_breakout").map((x) => x.id);
  const records = Object.fromEntries(OPENING_RANGE_SESSIONS.map((s) => {
    const q = (mine?.patterns || []).find((x) => x.pattern === s.key);
    return [NAME[s.key], { setups: q?.setups ?? 0, mean_r: q?.mean_r ?? null, fill_rate: q?.fill_rate ?? null, target_rate: q?.target_rate ?? null, held_by_breaker: held.includes(s.key) }];
  }));

  // The recent sessions' setups (newest first), each with the control arm's outcome.
  const rows = await select(db, "SELECT pattern, side, opened_at, action, at_level, status, results_json FROM plan_setups WHERE agent = ? ORDER BY opened_at DESC LIMIT ?", "orb_breakout", RECENT_SESSIONS);
  const recent = rows.map((x) => {
    const res = parse(x.results_json, null)?.[CONTROL_ARM] ?? null;
    return { date_ny: dateNy(isoMs(x.opened_at)), session: NAME[x.pattern] ?? null, side: x.side === "BUY" ? "long" : x.side === "SELL" ? "short" : null, opened_at: str(x.opened_at), entry_type: Number(x.at_level) === 1 ? "at_level" : "limit", status: str(x.status), exit: str(res?.s), r: finite(res?.r) ? res.r : null, filled: res ? res.f === 1 : null, arm: CONTROL_ARM };
  });

  return {
    schema: ORB_VIEW_SCHEMA, mode: orbMode(env), levels_mode: orbLevelsMode(env), scale: { prices: "feed", symbol: SYMBOL },
    rules: { range_bars: AGENT_RULES.orb.range_bars, min_width_atr: AGENT_RULES.orb.min_width_atr, max_width_atr: AGENT_RULES.orb.max_width_atr, beyond_atr: ORB_READING_BANDS.beyond_atr, retest_atr: ORB_READING_BANDS.retest_atr, pad_atr: AGENT_RULES.pad_atr },
    price, atr_h1: r2(atrH1), atr_m15: atrM15, bar_close: bars.length ? str(bars.at(-1).close_time) : null,
    market: { open: !goldPausedAt(now), next_range: nextRange(now) },
    decision: { decision_key: str(record?.decision_key), bar_close: str(record?.bar_close), session_range: record?.session_range ?? null },
    overlap: { long: overlapOf("long"), short: overlapOf("short") },
    sessions, records, recent
  };
}
