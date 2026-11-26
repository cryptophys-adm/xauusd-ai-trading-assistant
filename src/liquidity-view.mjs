// GET /api/liquidity (Track B, B8): the Nexus Liquidity page's read of lens B (docs/RFC_POSITIONING_LIQUIDITY.md §4-§7,
// §15), cryptophys.liquidity-view.v1. Nexus only (behind Cloudflare Access): of the read routes it is one of the few that
// carry prices, and each price is labelled by scale: `low`/`high` and `broker` are the broker's (lens B's own M1 bars),
// `low_feed`/`high_feed` and `feed` the TradingView feed's (broker − feed_basis; null without a known basis).
//
//   reads    KV liquidity:state:v1, liquidity:baseline:<ref>, the backfill markers, lens:policy/floor, the feed series,
//            decision-engine:latest; D1 SELECTs of liquidity_readings, lens_readings, broker_bars_1m, limit_council,
//            omega_events, position_actions, omega_bridge/omega_connection/omega_settings (engine_decisions as a
//            fallback). A table that does not exist yet reads as empty ("no such table" gives []).
//   never    a write, a DDL statement, lensStatus (it creates lens_readings), an account number, login, server name,
//            account_ref, source or identity key in the answer; lens B never opens, sizes or prices an entry here.
//   card     B15: `card` and `quorum_with_liquidity` from the latest decision's decision.liquidity (lens B's council-only
//            LIQUIDITY card and the quorum it would give, informational); null when that decision has none.
//   conditions B16: lens B's liquidity conditions (liquidityConditions, the line the 15m and 1H risk desks and moderators
//            read, no sweep, no price) from the latest state at the mode's knobs, with `in_rooms` (whether the rooms read
//            them now: LENS_ROOM_LINE "conditions" and lens B on, above its floor and fresh); null without available facts.
//   B19      effects.level_moves: the hold readings (a stop moved to a lens B level: SL+ or the ladder's lock), and each
//            skip's outcome from its skip reading; level_moves is null while LENS_LEVEL_READINGS is "off".
import { LIQUIDITY_STATE_KEY, LIQUIDITY_STATE_FRESH_MS, baselineKey, backfillKey, backfillFailedKey, backfillIdentity, backfillVersionsKey, liquidityFields, liquidityLine, liquidityConditions, liquidityConditionsOn } from "./liquidity-lens.mjs";
import { lensKnobs, lensScore, readLensState } from "./lens-policy.mjs";
import { activeAccount, lensRoomLine, lensLevelReadings } from "./lens-steps.mjs";
import { feedBasis } from "./feed-basis.mjs";
import { managementFields } from "./ea-signal.mjs";
import { brokerKeyLevels, managementSpread } from "./omega-engine.mjs";
import { atr } from "./strategy-engine.mjs";
import { DECISION_LATEST_KEY } from "./decision-engine.mjs";

export const LIQUIDITY_VIEW_SCHEMA = "cryptophys.liquidity-view.v1";
/** The newest sweeps shown, and the newest rows of each effect. */
export const VIEW_SWEEPS = 50;
export const VIEW_EFFECTS = 50;
/** The readings window, and the effects' (the block and maker scores look 14 days back too). */
export const VIEW_READINGS_MS = 24 * 3_600_000;
export const VIEW_EFFECTS_MS = 14 * 86_400_000;
/** The New York hours of the week (0 = Sunday 00:00 to 167). */
export const BASELINE_HOURS = 168;
const SYMBOL = "OANDA:XAUUSD";
const M1 = 60_000, DAY_MS = 86_400_000;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (finite(v) ? Math.round(v * 100) / 100 : null);
const parse = (s, d = null) => { try { return typeof s === "string" ? JSON.parse(s) : (s ?? d); } catch { return d; } };
const noTable = (e) => /no such table/i.test(String(e?.message ?? e));
const outcomeOf = (o) => (o === "hit" || o === "miss" || o === "neutral" ? o : "pending");
const sideWord = (s) => (Number(s) > 0 ? "BUY" : Number(s) < 0 ? "SELL" : null);
const isoMs = (s) => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? t : null; };

/** A SELECT's rows; a table not created yet is none. Any other error throws (the route answers liquidity_unavailable). */
async function select(db, sql, ...params) {
  if (!db?.prepare) return [];
  try { return (await db.prepare(sql).bind(...params).all())?.results ?? []; } catch (e) { if (noTable(e)) return []; throw e; }
}
async function kvJson(kv, key) {
  try { return parse(await kv?.get?.(key), null); } catch { return null; }
}

/** Pure: lens B's facts with every key present (null where the facts do not say), so the page reads one shape. */
export function viewFacts(facts) {
  if (!facts || typeof facts !== "object") return null;
  const f = facts;
  return {
    available: f.available === true, reason: f.available === true ? null : (f.reason ?? "no_bars"),
    baseline: f.baseline ?? "insufficient", baseline_weeks: finite(f.baseline_weeks) ? f.baseline_weeks : 0, baseline_reset_at: f.baseline_reset_at ?? null,
    basis: f.basis ?? null, minute_at: f.minute_at ?? null,
    vol_pctl: finite(f.vol_pctl) ? f.vol_pctl : null, vol_pctl_15m: finite(f.vol_pctl_15m) ? f.vol_pctl_15m : null,
    vol_spike: f.vol_spike === true, thin: f.thin === true,
    spread_ratio: finite(f.spread_ratio) ? f.spread_ratio : null, spread_spike: f.spread_spike === true,
    sweep: f.sweep ? { side: f.sweep.side ?? null, age_min: finite(f.sweep.age_min) ? f.sweep.age_min : null, vol_pctl: finite(f.sweep.vol_pctl) ? f.sweep.vol_pctl : null, reclaimed: f.sweep.reclaimed === true } : null,
    pools: f.pools ? { above: f.pools.above ?? 0, below: f.pools.below ?? 0, equal_highs: f.pools.equal_highs ?? 0, equal_lows: f.pools.equal_lows ?? 0 } : null,
    hvn: f.hvn ? { inside: f.hvn.inside === true, above: f.hvn.above ?? 0, below: f.hvn.below ?? 0 } : null,
    excluded: f.excluded ?? null
  };
}

/** Pure: one hour of the week's baseline: bars, weeks, the median spread (points) and the tick-volume quantiles it gates on. */
export function baselineHour(hour, e) {
  const q = (list, i) => (Array.isArray(list) && finite(list[i]) ? list[i] : null);
  return { hour, n: finite(e?.n) ? e.n : 0, weeks: finite(e?.weeks) ? e.weeks : 0, spread_median: finite(e?.spread_median) ? e.spread_median : null, vol_p50: q(e?.q1, 50), vol_p95: q(e?.q1, 95), vol15_p20: q(e?.q15, 20), vol15_p50: q(e?.q15, 50) };
}

/** Pure: a zone on both scales: `low`/`high` broker, `*_feed` the feed's (null without a basis). */
const bothScales = (low, high, basis) => ({ low: r2(low), high: r2(high), low_feed: finite(basis) ? r2(low - basis) : null, high_feed: finite(basis) ? r2(high - basis) : null });

/**
 * Pure: lens B's levels (broker scale, liquidityFacts) on both scales, each with whether it lies in a Key Level Agent
 * zone (the strategy's candidate or qualified zones, feed scale; null without a basis or a strategy).
 */
export function viewLevels(levels, { basis = null, zones = null } = {}) {
  return (Array.isArray(levels) ? levels : []).filter((z) => finite(z?.low) && finite(z?.high) && z.low <= z.high).map((z) => {
    const s = bothScales(z.low, z.high, basis);
    const inZone = finite(basis) && Array.isArray(zones) ? zones.some((k) => s.low_feed <= k.high && s.high_feed >= k.low) : null;
    return { kind: z.kind ?? null, ...s, in_key_zone: inZone };
  });
}

/** Pure: the backfill's state from its KV records: done, backfilled (copied, rebuild pending), failed or unavailable. */
export function backfillState({ versions = null, marker = null, failed = null } = {}) {
  const none = { status: "unavailable", at_ms: null, added: null, rebuilt: null };
  if (!Array.isArray(versions) || !versions.some(finite)) return none;
  const row = (status, m) => ({ status, at_ms: isoMs(m?.at), added: finite(m?.added) ? m.added : null, rebuilt: m ? m.rebuilt === true : null });
  if (marker && marker.status !== "copying") return row(marker.rebuilt === true ? "done" : "backfilled", marker);
  if (failed) return { ...row("failed", null), at_ms: isoMs(failed.at) };
  if (marker) return row("backfilled", marker);
  return none;
}

/**
 * Pure: the page's LIQUIDITY card (B15) from a decision's decision.liquidity.card, or null. `at_ms` is when the card was
 * made (the decision's decided_at), `state_at_ms` the lens B state it read; `stale` once the card is older than lens B's
 * freshness (15 minutes). No price: a weight, a lean, the sweep's side and minutes.
 */
export function viewCard(decision, now = Date.now()) {
  const c = decision?.liquidity?.card;
  if (!c || typeof c !== "object") return null;
  const at = isoMs(decision.decided_at) ?? (finite(c.at_ms) ? c.at_ms : null);
  return {
    at_ms: at, state_at_ms: finite(c.at_ms) ? c.at_ms : null, bar_close: typeof decision.bar_close === "string" ? decision.bar_close : null,
    stale: !(finite(at) && now - at <= LIQUIDITY_STATE_FRESH_MS), counts: false,
    weight: finite(c.weight) ? c.weight : null, lens_weight: finite(c.lens_weight) ? c.lens_weight : null, lean: finite(c.lean) ? c.lean : null, side: c.side ?? null,
    sweep: c.sweep === "buy_side" || c.sweep === "sell_side" ? c.sweep : null, sweep_age_min: finite(c.sweep_age_min) ? c.sweep_age_min : null,
    lean_reason: typeof c.lean_reason === "string" ? c.lean_reason : null, agreeing: Array.isArray(c.agreeing) ? c.agreeing.filter((k) => typeof k === "string") : [],
    summary: typeof c.summary === "string" ? c.summary : null
  };
}

/** Pure: the page's quorum with liquidity (B15) from a decision's decision.liquidity, or null. Informational only. */
export function viewQuorumWithLiquidity(decision) {
  const q = decision?.liquidity?.quorum_with_liquidity;
  if (!q || typeof q !== "object") return null;
  const n = (v) => (finite(v) ? v : null), b = (v) => (typeof v === "boolean" ? v : null);
  return { score: n(q.score), bias: typeof q.bias === "string" ? q.bias : null, long_share: n(q.long_share), short_share: n(q.short_share), neutral_share: n(q.neutral_share), share_needed_above: n(q.share_needed_above), quorum_min: n(q.quorum_min), long_met: b(q.long_met), short_met: b(q.short_met), met: b(q.met) };
}

/**
 * Pure: the page's conditions (B16): liquidityConditions of the state's facts at the knobs, with the state's time,
 * whether it is stale and whether the rooms read it now (`in_rooms`, with `room_line` the switch's value); null without
 * available facts. No price.
 */
export function viewConditions(state, { knobs = null, now = Date.now(), roomLine = "conditions" } = {}) {
  const c = state?.facts ? liquidityConditions(state.facts, { knobs, stateAtMs: state.at_ms, now }) : null;
  if (!c) return null;
  const at = finite(state.at_ms) ? state.at_ms : null;
  return { at_ms: at, stale: !(finite(at) && now - at <= LIQUIDITY_STATE_FRESH_MS), in_rooms: roomLine === "conditions" && liquidityConditionsOn(state, knobs, now), room_line: roomLine, ...c };
}

/** The view (cryptophys.liquidity-view.v1). `strategy` is the shared memo (readStrategyMemo), or null. Throws on a D1 error. */
export async function readLiquidityView(env, { now = Date.now(), strategy = null } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  const state = await kvJson(kv, LIQUIDITY_STATE_KEY);
  const acct = await activeAccount(env);
  const idParts = typeof state?.identity === "string" ? state.identity.split("|") : [];
  const ref = acct?.accountRef ?? (/^acct_[0-9a-f]{16}$/.test(idParts[0] ?? "") ? idParts[0] : null);
  const source = acct?.source ?? (idParts.length >= 3 ? idParts.slice(1, -1).join("|") : null);
  const digits = acct ? acct.digits : (Number.isInteger(Number(idParts.at(-1))) ? Number(idParts.at(-1)) : null);

  // The scale: the broker minus the feed over the last two hours of closed 5m bars, as eaSignal takes it (feedBasis),
  // on lens B's own archive of the same broker bars.
  const series = async (interval) => {
    const rec = await kvJson(kv, `market-data:v2:series:${SYMBOL}|${interval}`);
    return (Array.isArray(rec?.candles) ? rec.candles : []).filter((c) => finite(c?.close) && c.close > 0 && Number.isFinite(isoMs(c.close_time)) && isoMs(c.close_time) <= now).sort((a, b) => isoMs(a.close_time) - isoMs(b.close_time));
  };
  const feed5 = (await series("5m")).slice(-24);
  let brokerBars = [];
  if (ref && source && feed5.length) {
    const since = isoMs(feed5[0].close_time) - 120_000;
    brokerBars = (await select(db, `SELECT minute_ms AS t, c FROM broker_bars_1m WHERE account_ref = ? AND source = ? AND minute_ms > ?${Number.isInteger(digits) ? " AND (digits = ? OR digits IS NULL)" : ""} ORDER BY minute_ms`, ref, source, since, ...(Number.isInteger(digits) ? [digits] : [])))
      .map((r) => ({ t: Number(r.t), c: Number(r.c) }));
  }
  const basis = feed5.length ? feedBasis(brokerBars, feed5) : null;
  const scale = { feed_basis: finite(basis) ? basis : null, feed_basis_known: finite(basis), basis_at: finite(basis) ? isoMs(feed5.at(-1).close_time) : null };
  const lastBroker = brokerBars.at(-1) ?? null;
  const price = { feed: r2(feed5.at(-1)?.close ?? (finite(strategy?.price) ? strategy.price : null)), broker: lastBroker && finite(lastBroker.c) ? r2(lastBroker.c) : null, broker_at_ms: lastBroker ? lastBroker.t + M1 : null };
  const m15 = (await series("15m")).slice(-60);
  const atrM15 = r2(atr(m15));

  // The lens's switch, weight and gates as the signal reads them (liquidityFields), and the decision Omega manages with.
  const lens = await readLensState(env, { now });
  let decision = await kvJson(kv, DECISION_LATEST_KEY);
  if (!decision?.decision_key) decision = parse((await select(db, "SELECT decision_json FROM engine_decisions ORDER BY bar_close DESC LIMIT 1"))[0]?.decision_json, null);
  const mode = typeof decision?.trading_mode === "string" ? decision.trading_mode : "intraday";
  const knobs = lensKnobs("liquidity", mode, { policy: lens.policy, floor: lens.floor, enabled: lens.switches.liquidity, baseline: state?.baseline ?? null });
  const fields = liquidityFields(state, { now, knobs });
  const facts = state ? viewFacts(state.facts ?? { available: false, reason: "no_bars" }) : null;
  const available = facts?.available === true;

  const zones = Array.isArray(strategy?.key_levels?.zones) ? strategy.key_levels.zones.filter((z) => (z?.candidate || z?.qualified) && finite(z.low) && finite(z.high) && z.low <= z.high) : null;
  const levels = available ? viewLevels(state.levels, { basis, zones }) : [];
  // The management level set Omega and the Position Manager read (B17: brokerKeyLevels' management mode over the
  // decision's key zones and lens B's levels while it is on: lens B only with a known basis, merged into a zone within
  // two spreads of the hour's median, on the account's point).
  const signal = { ...managementFields(decision ?? {}, { basis }), ...fields };
  const management = (brokerKeyLevels(signal, { spread: managementSpread(signal, { point: Number.isInteger(digits) ? Math.pow(10, -digits) : null }) }) ?? []).map((z) => ({ ...bothScales(z.low, z.high, basis), source: z.source === "liquidity" ? "liquidity" : "key_level", kind: z.kind ?? null }));

  // The baseline and the backfill (KV, the current account only).
  const stored = ref ? await kvJson(kv, baselineKey(ref)) : null;
  const versions = ref && source ? (await kvJson(kv, backfillVersionsKey(ref, source)))?.versions ?? null : null;
  const identity = Array.isArray(versions) && versions.some(finite) ? backfillIdentity(ref, source, versions.filter(finite)) : null;
  const backfill = backfillState({ versions, marker: identity ? await kvJson(kv, backfillKey(identity)) : null, failed: identity ? await kvJson(kv, backfillFailedKey(identity)) : null });
  const baseline = {
    status: stored?.baseline ?? state?.baseline ?? "unavailable", weeks: finite(stored?.baseline_weeks) ? stored.baseline_weeks : (finite(state?.baseline_weeks) ? state.baseline_weeks : 0),
    reset_at: stored?.reset_at ?? null, updated_ms: finite(stored?.updated_ms) ? stored.updated_ms : null,
    hours: Array.from({ length: BASELINE_HOURS }, (_, h) => baselineHour(h, stored?.hours?.[h]))
  };

  // The readings of the last 24 hours (one a ledger step), facts only.
  const readings = ref ? (await select(db, "SELECT at_ms, mode, baseline, facts_json FROM liquidity_readings WHERE account_ref = ? AND at_ms > ? ORDER BY at_ms", ref, now - VIEW_READINGS_MS)).map((r) => {
    const f = viewFacts(parse(r.facts_json, null) ?? { available: false });
    return { at_ms: Number(r.at_ms), mode: r.mode ?? null, baseline: r.baseline ?? null, available: f.available, reason: f.reason, vol_pctl: f.vol_pctl, vol_pctl_15m: f.vol_pctl_15m, vol_spike: f.vol_spike, thin: f.thin, spread_ratio: f.spread_ratio, spread_spike: f.spread_spike, sweep_side: f.sweep?.side ?? null, excluded: f.excluded };
  }) : [];

  // The score: the newest score_window decisive readings of every kind (lensFloorStep's own read); a sweep in it is scored.
  const scoreKnobs = lensKnobs("liquidity", "intraday", { policy: lens.policy, floor: lens.floor });
  const decisive = await select(db, "SELECT id, kind, outcome FROM lens_readings WHERE lens = 'liquidity' AND outcome IN ('hit', 'miss') ORDER BY at_ms DESC LIMIT ?", scoreKnobs.score_window);
  const counted = new Set(decisive.map((r) => r.id));
  const sc = lensScore(decisive, { window: scoreKnobs.score_window });
  const score = { hits: sc.hits, misses: sc.misses, n: sc.n, share: sc.share, score_floor: scoreKnobs.score_floor, score_window: scoreKnobs.score_window, floored: scoreKnobs.floored };
  const sweeps = available ? (await select(db, "SELECT id, at_ms, mode, side, outcome, detail_json FROM lens_readings WHERE lens = 'liquidity' AND kind = 'sweep' ORDER BY at_ms DESC LIMIT ?", VIEW_SWEEPS)).map((r) => {
    const d = parse(r.detail_json, {}) ?? {};
    return { at_ms: Number(r.at_ms), side: Number(r.side) < 0 ? "buy_side" : "sell_side", mode: r.mode ?? null, outcome: outcomeOf(r.outcome), scored: counted.has(r.id), replay: d.replay === true, vol_pctl: finite(d.vol_pctl) ? d.vol_pctl : null, atr15: finite(d.atr15) ? d.atr15 : null };
  }) : [];

  // What lens B did: the spread-spike blocks and the maker choices (scored readings), the entry council's skips on a
  // sweep against, the deferred modifications (the plan's note), the Position Manager's actions citing a sweep against.
  const since = now - VIEW_EFFECTS_MS;
  const scoredKind = async (kind) => (await select(db, "SELECT at_ms, mode, side, outcome FROM lens_readings WHERE lens = 'liquidity' AND kind = ? ORDER BY at_ms DESC LIMIT ?", kind, VIEW_EFFECTS))
    .map((r) => ({ at_ms: Number(r.at_ms), side: sideWord(r.side), mode: r.mode ?? null, outcome: outcomeOf(r.outcome) }));
  // B19: each skip's outcome from its skip reading (skip:<issued_ms>:B|S), pending until scored; null when none recorded.
  const skipOutcomes = new Map((await select(db, "SELECT id, outcome FROM lens_readings WHERE lens = 'liquidity' AND kind = 'skip' AND at_ms > ? LIMIT ?", since - DAY_MS, 4 * VIEW_EFFECTS)).map((r) => [r.id, outcomeOf(r.outcome)]));
  const skips = (await select(db, "SELECT at_ms, status, choice, rule, facts FROM limit_council WHERE kind = 'entry' AND at_ms > ? AND rule LIKE '%liquidity_sweep_against%' ORDER BY at_ms DESC LIMIT ?", since, VIEW_EFFECTS))
    .map((r) => { const f = parse(r.facts, {}) ?? {}; const side = f.side === "BUY" || f.side === "SELL" ? f.side : null; return { at_ms: Number(r.at_ms), side, mode: typeof f.mode === "string" ? f.mode : null, status: r.status ?? null, choice: r.choice ?? null, rule: r.rule ?? null, outcome: side && finite(Number(f.issued_ms)) ? skipOutcomes.get(`skip:${Number(f.issued_ms)}:${side === "BUY" ? "B" : "S"}`) ?? null : null }; });
  // B19: the stops Omega moved to a lens B level (hold readings), with their outcome; no price.
  const levelMoves = lensLevelReadings(env) === "off" ? null : (await select(db, "SELECT at_ms, mode, side, outcome, detail_json FROM lens_readings WHERE lens = 'liquidity' AND kind = 'hold' AND at_ms > ? ORDER BY at_ms DESC LIMIT ?", since, VIEW_EFFECTS))
    .map((r) => { const d = parse(r.detail_json, {}) ?? {}; return { at_ms: Number(r.at_ms), side: sideWord(r.side), mode: r.mode ?? null, action: d.what === "ladder" ? "ladder_lock" : "trail", outcome: outcomeOf(r.outcome) }; });
  const deferrals = (await select(db, "SELECT ms, detail FROM omega_events WHERE action = 'plan' AND ms > ? AND detail LIKE '%liquidity_modify_deferred%' ORDER BY ms DESC LIMIT ?", since, VIEW_EFFECTS))
    .map((r) => { const d = parse(r.detail, {}) ?? {}; const ids = String(d?.details?.liquidity_modify_deferred ?? "").split(",").filter(Boolean); return { at_ms: Number(r.ms), intents: ids.length }; });
  const pmActions = (await select(db, "SELECT at_ms, side, action, rule, status FROM position_actions WHERE at_ms > ? AND (rule LIKE '%liquidity_sweep_against%' OR why LIKE '%liquidity_sweep_against%') ORDER BY at_ms DESC LIMIT ?", since, VIEW_EFFECTS))
    .map((r) => ({ at_ms: Number(r.at_ms), side: r.side ?? null, action: r.action ?? null, rule: r.rule ?? null, status: r.status ?? null }));

  return {
    schema: LIQUIDITY_VIEW_SCHEMA,
    state: {
      at_ms: finite(state?.at_ms) ? state.at_ms : null, fresh: Boolean(state && finite(state.at_ms) && now - state.at_ms <= LIQUIDITY_STATE_FRESH_MS),
      mode: state?.mode ?? null, on: fields.liquidity_on === true, baseline: state?.baseline ?? "unavailable", backfill
    },
    scale, price, atr_m15: atrM15,
    facts, line: facts ? liquidityLine(state.facts ?? { available: false, reason: "no_bars" }) : null,
    conditions: viewConditions(state, { knobs, now, roomLine: lensRoomLine(env) }),
    levels, readings, sweeps, score,
    effects: { blocks: await scoredKind("block"), makers: await scoredKind("maker"), skips, deferrals, level_moves: levelMoves, pm_actions: pmActions },
    card: viewCard(decision, now), quorum_with_liquidity: viewQuorumWithLiquidity(decision),
    baseline, management
  };
}
