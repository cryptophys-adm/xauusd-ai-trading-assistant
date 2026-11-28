// FP1, the fresh 15m pattern exception (owner 2026-11-28 via the orchestrator, "setuju semua" on option A; the 27 Nov
// descending broadening wedge broke out at 17:00Z, pattern_lines had no plan because TP1-KZ put TP1 on a key zone
// 0.07–0.29R ahead, and no BUY followed). A pattern family's agent (src/strategy-agents.mjs, pattern_* without
// pattern_inside) whose 15m pattern broke out within the last FRESH_PATTERN.max_age_bars + 1 closed 15m bars gets a plan
// that ignores TP1-KZ: TP1 is the pattern's measured target, only when it pays at least FRESH_PATTERN.min_target_r with
// the agent's own entry and stop (no fallback to a key zone). The breaker and the held-back patterns still apply.
//
// FRESH_PATTERN_MODE (FS1, group plans): "on" (production) the plan is the agent's on that side (when it has none) or
// marks its plan for that pattern: it is offered to the council in `strategies` even alone, a trade from it carries
// fresh_pattern, and a pullback's E1 limit never applies (pattern agents are market-by-design); "record" the plans are
// only recorded (decision.fresh_plans, plan_setups source pattern_fresh); "off" (code default, so the fixtures replay as
// before) nothing. Recorded only on a side whose guardrails allow it.
//
// The automatic revert (freshPatternRevert, 5-minute ledger step): once FRESH_PATTERN_REVERT.trades fresh_pattern
// trades closed at the broker, a mean broker R below FRESH_PATTERN_REVERT.below_r sets the mode in force to "record"
// (KV FRESH_PATTERN_REVERT_KEY), with one Telegram line and one Omega event. The owner's FS1 override wins over it,
// as ROOM_BREAKOUT_WAIVE's (src/room-waive.mjs): the order owner override > automatic revert > env.
import { normBars, meanRange } from "./chart-patterns.mjs";
import { overriddenKeys } from "./feature-switches.mjs";

export const FRESH_PATTERN_SWITCH = "FRESH_PATTERN_MODE";
export const FRESH_PATTERN_MODES = Object.freeze(["on", "record", "off"]);
/** Fresh: the breakout's first close beyond the broken line is at most this many bars before the latest closed 15m bar. */
export const FRESH_PATTERN = Object.freeze({ chart: "15", max_age_bars: 1, min_target_r: 1 });
export const FRESH_PATTERN_REVERT = Object.freeze({ trades: 30, below_r: 0.1 });
export const FRESH_PATTERN_REVERT_KEY = "fresh-pattern:revert:v1";
export const FRESH_PATTERN_SOURCE = "pattern_fresh";
export const FRESH_PATTERN_PREFIX = "fresh:";

const s = (v) => String(v ?? "").trim().toLowerCase();
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const parse = (x, fallback = null) => { if (x == null) return fallback; if (typeof x !== "string") return x; try { return JSON.parse(x); } catch { return fallback; } };

/** Pure: FRESH_PATTERN_MODE as the env holds it ("off" for anything else). */
export function freshPatternModeOf(env) {
  const v = s(env?.FRESH_PATTERN_MODE);
  return FRESH_PATTERN_MODES.includes(v) ? v : "off";
}

/**
 * Pure: the mode in force. The owner's FS1 override (the resolved env says so) wins; else "record" once the automatic
 * revert has run (`revert` its KV doc) while the env says "on"; else the env value. { value, source, env_value }.
 */
export function resolveFreshPattern({ env = null, revert = null } = {}) {
  const value = freshPatternModeOf(env);
  if (overriddenKeys(env).includes(FRESH_PATTERN_SWITCH)) return { value, source: "owner", env_value: value };
  if (value === "on" && revert?.status === "reverted") return { value: "record", source: "auto_revert", env_value: value };
  return { value, source: "env", env_value: value };
}

/** The mode in force for a run (reads the revert only when it could matter). Unreadable KV: "record". Never throws. */
export async function resolveFreshPatternMode(env) {
  const value = freshPatternModeOf(env);
  if (value !== "on" || overriddenKeys(env).includes(FRESH_PATTERN_SWITCH)) return resolveFreshPattern({ env });
  try { return resolveFreshPattern({ env, revert: parse(await env?.SIGNAL_CACHE?.get?.(FRESH_PATTERN_REVERT_KEY)) }); } catch { return { value: "record", source: "unreadable", env_value: value }; }
}

/** FS1's panel (src/feature-switch-store.mjs): the automatic revert's hold ({ since, until: null } once reverted), or null. */
export async function readFreshPatternHold(kv) {
  const d = parse(await kv?.get?.(FRESH_PATTERN_REVERT_KEY), null);
  return d?.status === "reverted" ? { since: d.at ?? null, until: null } : null;
}

/**
 * Pure: how many closed bars ago a broken-out pattern's current breakout was confirmed (0: on the latest bar), from
 * the bars it was detected on (closed 15m, oldest first): the start of the run of closes beyond its broken line by the
 * detector's margin (0.1 x the mean range of the last `window` bars) that ends at the latest bar, after the pattern's
 * last turn (bars_ago from the latest bar). As src/public-patterns.mjs breakoutCloseMs, in bars. Null for a forming
 * pattern, no bars, or a latest bar that is not beyond the line.
 */
export function breakoutAgeBars(bars, p, { window = 60 } = {}) {
  const dir = Number(p?.direction);
  if (!(dir > 0 || dir < 0)) return null;
  const b = normBars(Array.isArray(bars) ? bars.slice(-window) : []), n = b.length;
  const A = meanRange(b);
  if (!n || !(A > 0)) return null;
  const line = dir > 0 ? Number(p.upper) : Number(p.lower);
  if (!Number.isFinite(line)) return null;
  const eps = 0.1 * A;
  const beyond = (x) => (dir > 0 ? x.c > line + eps : x.c < line - eps);
  if (!beyond(b[n - 1])) return null;
  const ago = Number(p.bars_ago);
  const from = Number.isInteger(ago) && ago >= 0 ? Math.max(0, n - ago) : 0;
  let k = n - 1;
  while (k - 1 >= from && beyond(b[k - 1])) k--;
  return n - 1 - k;
}

/** Pure: the record a fresh plan carries. */
export const freshPatternRecord = ({ pattern, ageBars, targetR }) => ({ pattern, chart: "15m", breakout_age_bars: ageBars, target_r: Math.round(targetR * 100) / 100 });

/**
 * Pure: the decision's fresh plans to record ({ long, short }: { agent: slim plan with fresh_pattern }), only on a side
 * whose guardrails allow it (`guards[side].allowed === true`); null when there are none.
 */
export function freshPlansRecord(fresh, guards, slim) {
  const out = {};
  for (const side of ["long", "short"]) {
    if (guards?.[side]?.allowed !== true) continue;
    const list = Object.entries(fresh?.[side] ?? {}).filter(([, a]) => a?.plan?.fresh_pattern);
    if (list.length) out[side] = Object.fromEntries(list.map(([id, a]) => [id, { ...slim(a.plan), fresh_pattern: a.plan.fresh_pattern, status: a.status }]));
  }
  return Object.keys(out).length ? out : null;
}

/** Pure: the revert's verdict on the closed fresh trades' broker R (oldest first). */
export function freshPatternVerdict(rs) {
  const list = (rs || []).filter(finite).slice(0, FRESH_PATTERN_REVERT.trades);
  const n = list.length;
  const mean = n ? list.reduce((a, x) => a + x, 0) / n : null;
  const ready = n >= FRESH_PATTERN_REVERT.trades;
  return { n, mean_r: mean == null ? null : Math.round(mean * 1000) / 1000, ready, revert: ready && mean < FRESH_PATTERN_REVERT.below_r };
}

/** Pure: the revert's Telegram line (R only). */
export function freshPatternRevertLine(v) {
  return `XAUUSD SYSTEM · Fresh 15m pattern exception (FRESH_PATTERN_MODE) set to record: its first ${v.n} trades averaged ${v.mean_r > 0 ? "+" : ""}${v.mean_r}R at the broker, below +${FRESH_PATTERN_REVERT.below_r}R. Fresh pattern plans are only recorded from now on; the owner can turn it on again in the feature switches.`;
}

/**
 * The closed fresh_pattern trades' broker R, oldest first: the decisions whose trade carries fresh_pattern, their
 * Omega entry intent (a market open or a filled limit, matched by the signal's bar), and that position's deals. A
 * trade not yet closed in full ends the list there (the window waits for it).
 */
export async function freshPatternTrades(db, { limit = FRESH_PATTERN_REVERT.trades } = {}) {
  const keys = (await db.prepare("SELECT decision_key FROM engine_decisions WHERE json_extract(decision_json, '$.trade.fresh_pattern') IS NOT NULL ORDER BY bar_close LIMIT 500").all()).results ?? [];
  const out = [];
  for (const { decision_key: key } of keys) {
    if (out.length >= limit) break;
    const ms = Number(String(key).split(":").at(-1));
    if (!finite(ms)) continue;
    const it = await db.prepare("SELECT payload, result FROM omega_intents WHERE kind IN ('open', 'place_limit') AND status = 'done' AND CAST(json_extract(payload, '$.signal_issued_ms') AS INTEGER) = ? ORDER BY created_ms LIMIT 1").bind(ms).first();
    if (!it) continue;
    const p = parse(it.payload, {}) ?? {}, res = parse(it.result, {}) ?? {};
    const ticket = Number(res.ticket);
    if (!finite(ticket)) continue;
    const deals = (await db.prepare("SELECT volume, exit_price FROM ea_deals WHERE position_ticket = ? AND exit_price > 0").bind(ticket).all()).results ?? [];
    if (!deals.length) continue;
    const vol0 = Number(p.lot ?? p.volume), rd = Number(p.r_dist) > 0 ? Number(p.r_dist) : Math.abs(Number(p.planned_entry ?? p.entry) - Number(p.sl_plan ?? p.sl));
    const fill = Number(res.fill_price) > 0 ? Number(res.fill_price) : Number(p.fill_price) > 0 ? Number(p.fill_price) : Number(p.planned_entry ?? p.entry);
    const closed = deals.reduce((a, d) => a + Number(d.volume || 0), 0);
    if (!(vol0 > 0) || !(rd > 0) || !(fill > 0) || closed < vol0 - 1e-9) break;
    const dir = p.side === "BUY" ? 1 : -1;
    out.push(deals.reduce((a, d) => a + dir * (Number(d.exit_price) - fill) * Number(d.volume || 0), 0) / (rd * vol0));
  }
  return out;
}

/**
 * The automatic revert, on every ledger step while the env says "on" and the owner has not overridden it. Returns
 * { status: inactive | owner | done | waiting | kept | reverted | unavailable | failed, ... }. Never throws.
 */
export async function freshPatternRevert(env, { now = Date.now(), send = null } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    if (freshPatternModeOf(env) !== "on") return { status: "inactive" };
    if (overriddenKeys(env).includes(FRESH_PATTERN_SWITCH)) return { status: "owner" };
    const state = parse(await kv.get(FRESH_PATTERN_REVERT_KEY), null);
    if (state?.status === "reverted" || state?.status === "kept") return { status: "done", verdict: state.status };
    const v = freshPatternVerdict(await freshPatternTrades(db));
    const summary = { n: v.n, mean_r: v.mean_r };
    if (!v.ready) return { status: "waiting", ...summary };
    const event = async (action, detail) => { try { await db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'agent:fresh-pattern', ?, ?)").bind(now, action, JSON.stringify(detail)).run(); } catch { /* audit best effort */ } };
    const status = v.revert ? "reverted" : "kept";
    await kv.put(FRESH_PATTERN_REVERT_KEY, JSON.stringify({ status, ...summary, at: new Date(now).toISOString() }));
    await event(v.revert ? "fresh_pattern_reverted" : "fresh_pattern_kept", { ...(v.revert ? { value: "record", from: "on" } : {}), ...summary });
    if (v.revert && typeof send === "function") { try { await send(freshPatternRevertLine(v)); } catch { /* best effort */ } }
    return { status, ...summary };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}
