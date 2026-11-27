// E1, limit-first (owner 2026-11-27 via the orchestrator: "harus mengikuti strateginya, jika memang strategi fallback
// harusnya tunggu di limit dan berada di zone, supply and demmand juga harus menjadi concern"). The entry follows the
// strategy's own plan: a pullback strategy (LIMIT_FIRST_AGENTS: zone_pullback, the default agent, and breakout_retest)
// always rests a limit and never becomes a market order through the at-level band or the entry council. Every other
// agent (sweep_reversal, range_fade, pattern_inside, orb_breakout, the pattern families) is unchanged.
//
// Placement (limitFirstPlacement, Omega's planner, broker scale): the plan's entry moved LIMIT_FIRST_DEPTH_ATR (0.1) of
// the 1H ATR toward the stop. When an own-type zone holds the entry (a BUY in demand, a SELL in supply, medium or
// strong; the decision's typed key levels and supply/demand boxes), the limit stays inside it (never past its far edge),
// and rests at its near edge when that edge is already at least 0.1 ATR from price. The stop, the targets, the fill
// window and zoneLimit's guards (at least ZONE_MIN_RISK_SHARE of the plan's risk, ZONE_MIN_RR to the target) as today.
//
// Recorded only (no live effect): the type of the zone at the entry (demand, supply, mixed or untyped) and
// zone_type_gate (pass when an own-type zone holds the entry, else block): what a gate "a pullback needs an own-type
// zone" would have done.
//
// Switch: the Omega setting limit_first ("on" default | "off"; FS1, an era switch). Its named auto-revert
// (limitFirstRevert, the 5-minute ledger step beside cd_gate's): after LIMIT_FIRST_REVERT.trades closed limit-first
// trades, when their mean broker R is below the e0 replay of the same setups (plan_setups by decision, side and agent),
// limit_first is set to "off" once (writeSettings, actor agent:limit-first) with one Omega event and one Telegram line.
// Pure, except limitFirstRevert.

export const LIMIT_FIRST_MODES = Object.freeze(["on", "off"]);
export const LIMIT_FIRST_AGENTS = Object.freeze(["zone_pullback", "breakout_retest"]);
export const LIMIT_FIRST_DEFAULT_AGENT = "zone_pullback";
export const LIMIT_FIRST_DEPTH_ATR = 0.1;
export const LIMIT_FIRST_REVERT = Object.freeze({ trades: 30 });
export const LIMIT_FIRST_REVERT_KEY = "limit-first:revert:v1";
export const LIMIT_FIRST_BASIS = "limit_first";
const OWN = Object.freeze({ BUY: "demand", SELL: "supply" });
const STRONG_ENOUGH = Object.freeze(["medium", "strong"]);
const EPS = 1e-9;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const isPrice = (x) => finite(x) && x > 0;
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const roundTo = (x, d) => { const f = Math.pow(10, d); return Math.round(x * f) / f; };

/** The setting: "on" unless the stored value is "off". */
export const limitFirstOn = (settings) => String(settings?.limit_first ?? "on") !== "off";

/** Whether a trade's agent is a pullback strategy (an empty agent is the default agent's plan, of before the agents). */
export const limitFirstAgent = (agent) => LIMIT_FIRST_AGENTS.includes(typeof agent === "string" && agent ? agent : LIMIT_FIRST_DEFAULT_AGENT);

/** Pure: "pass" when an own-type zone holds the entry, "block" otherwise (record only). */
export const zoneTypeGate = (ownZone) => (ownZone ? "pass" : "block");

/**
 * Pure (the EA signal, src/ea-signal.mjs): the flat limit-first fields of a pullback strategy's trade, feed scale.
 * `decision`: the engine's record (key_levels with zone words, sd_levels, strategy.atr_h1); `t` its trade; `side`.
 * { lf_atr, lf_type, lf_gate, lf_zone_low?, lf_zone_high? } or {} for any other agent or without an ATR.
 */
export function limitFirstSignalFields(decision, t, side) {
  if (!limitFirstAgent(t?.agent)) return {};
  const atr = Number(decision?.strategy?.atr_h1);
  const entry = Number(t?.entry);
  if (!(atr > 0) || !isPrice(entry) || (side !== "BUY" && side !== "SELL")) return {};
  const ok = (z) => isPrice(Number(z?.low)) && isPrice(Number(z?.high)) && Number(z.low) <= Number(z.high) && entry >= Number(z.low) && entry <= Number(z.high);
  const levels = [
    ...(Array.isArray(decision?.key_levels) ? decision.key_levels : []),
    ...(Array.isArray(decision?.sd_levels) ? decision.sd_levels : [])
  ].filter(ok);
  const typed = levels.find((z) => typeof z.zone_type === "string" && z.zone_type) ?? null;
  const own = levels.filter((z) => z.zone_type === OWN[side] && STRONG_ENOUGH.includes(z.zone_strength))
    // The tightest own zone (the one the limit sits in most precisely).
    .sort((a, b) => (Number(a.high) - Number(a.low)) - (Number(b.high) - Number(b.low)))[0] ?? null;
  const type = own ? OWN[side] : typed ? String(typed.zone_type) : "untyped";
  return {
    lf_atr: atr, lf_type: type, lf_gate: zoneTypeGate(own),
    ...(own ? { lf_zone_low: Number(own.low), lf_zone_high: Number(own.high) } : {})
  };
}

/**
 * Pure (Omega's planner): the limit-first price on the broker scale, with zoneLimit's guards. `signal` the EA signal
 * (entry, stop, tp1, feed_basis, lf_*), `sym` the terminal's symbol (bid, ask, digits, spread), `planStopDist` the plan's
 * stop distance, `minDist` the broker's stop level, `knobs` limitKnobs. Returns { ok: true, price, away, away_r, sl, tp,
 * rr, moved: true, entry_basis, zone_type, gate, from, knobs } or { ok: false, code, detail }.
 */
export function limitFirstPlacement({ signal, sym = {}, digits = 2, planStopDist, minDist = 0, knobs, minRiskShare = 0.5, minRr = 1 } = {}) {
  const buy = signal?.side === "BUY", dir = buy ? 1 : -1;
  const basis = Number(signal?.feed_basis);
  const atr = Number(signal?.lf_atr);
  const out = { knobs, zone_type: typeof signal?.lf_type === "string" ? signal.lf_type : "untyped", gate: signal?.lf_gate === "pass" ? "pass" : "block" };
  if (!finite(basis) || !(atr > 0) || !(planStopDist > 0) || !finite(sym.bid) || !finite(sym.ask)) return { ok: false, code: "limit_first_inputs", detail: "no ATR, basis or live price for the limit-first price", ...out };
  const step = Math.pow(10, -digits);
  const spreadPx = finite(sym.spread_points) && finite(sym.point) && sym.spread_points > 0 && sym.point > 0 ? sym.spread_points * sym.point : Math.max(0, sym.ask - sym.bid);
  const gap = Math.max(minDist, spreadPx, step);
  const depth = LIMIT_FIRST_DEPTH_ATR * atr;
  const from = roundTo(Number(signal.entry) + basis, digits);
  let target = from - dir * depth, basisWord = LIMIT_FIRST_BASIS;
  const rawLow = Number(signal.lf_zone_low), rawHigh = Number(signal.lf_zone_high);
  const zone = isPrice(rawLow) && isPrice(rawHigh) && rawLow <= rawHigh ? { low: roundTo(rawLow + basis, digits), high: roundTo(rawHigh + basis, digits) } : null;
  if (zone) {
    const near = buy ? zone.high : zone.low, far = buy ? zone.low : zone.high;
    const nearAway = buy ? sym.ask - near : near - sym.bid;
    // The zone's near edge, when it already stands at least the depth from price.
    if (nearAway >= depth - EPS) { target = near; basisWord = "zone_edge"; }
    // Never past the zone's far edge.
    target = buy ? Math.max(target, far) : Math.min(target, far);
  }
  // Away from price by the gap (rounded away from price), never nearer the price than the target.
  const scale = Math.pow(10, digits);
  const at = buy ? Math.min(target, Math.floor((sym.ask - gap) * scale + 1e-6) / scale) : Math.max(target, Math.ceil((sym.bid + gap) * scale - 1e-6) / scale);
  const price = roundTo(at, digits);
  const away = roundTo(buy ? sym.ask - price : price - sym.bid, digits + 2);
  const awayR = r3(away / planStopDist);
  if (zone && (buy ? price < zone.low - step / 2 : price > zone.high + step / 2)) return { ok: false, code: "zone_passed", detail: `the own ${out.zone_type} zone ${zone.low}-${zone.high} is passed`, price, away, away_r: awayR, ...out };
  if (knobs && finite(knobs.placement_band) && away > knobs.placement_band * planStopDist + EPS) return { ok: false, code: "limit_out_of_band", detail: `${awayR} x the stop from price, the band is ${knobs.placement_band}`, price, away, away_r: awayR, ...out };
  const sl = roundTo(Number(signal.stop) + basis, digits), tp = roundTo(Number(signal.tp1) + basis, digits);
  const risk = buy ? price - sl : sl - price, reward = buy ? tp - price : price - tp;
  const floor = Math.max(minDist, minRiskShare * planStopDist);
  if (!(risk >= floor - EPS)) return { ok: false, code: "zone_tight", detail: `a limit at ${price} leaves ${r3(risk)} of risk to the plan's stop, under ${r3(floor)}`, price, away, away_r: awayR, ...out };
  if (!(risk > minDist) || !(reward > minDist) || !(reward / risk >= minRr - EPS)) return { ok: false, code: "zone_rr", detail: `a limit at ${price} pays ${risk > 0 ? r3(reward / risk) : "no"} R to the target, under ${minRr}`, price, away, away_r: awayR, ...out };
  return { ok: true, moved: true, price, away, away_r: awayR, sl, tp, rr: r3(reward / risk), entry_basis: basisWord, from, ...(zone ? { own_zone: zone } : {}), ...out };
}

/** Pure: the words of the entry line ("limit (limit-first, demand zone)"; "untyped" when no zone type). */
export function limitFirstWords(p) {
  const t = typeof p?.entry_zone_type === "string" && p.entry_zone_type ? p.entry_zone_type : "untyped";
  const where = p?.entry_basis === "zone_edge" ? `${t} zone edge` : t === "untyped" ? "untyped zone" : `${t} zone`;
  return `limit (limit-first, ${where})`;
}

/**
 * Pure: the auto-revert's verdict over the closed limit-first trades (oldest first: [{ r, e0 }], r the broker R, e0 the
 * replay's control-arm R of the same setup). The first LIMIT_FIRST_REVERT.trades with both; { ready, n, mean_r,
 * mean_e0, revert }.
 */
export function limitFirstVerdict(trades = [], { n: need = LIMIT_FIRST_REVERT.trades } = {}) {
  const list = (Array.isArray(trades) ? trades : []).filter((x) => finite(Number(x?.r)) && finite(Number(x?.e0))).slice(0, need);
  const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
  const m = mean(list.map((x) => Number(x.r))), e = mean(list.map((x) => Number(x.e0)));
  const ready = list.length >= need;
  return { ready, n: list.length, mean_r: r3(m), mean_e0: r3(e), revert: ready && m < e - EPS };
}

/** The Telegram line of the revert (R only, no price, no person). */
export function limitFirstRevertLine(v) {
  const s = (x) => `${x > 0 ? "+" : ""}${x}R`;
  return `XAUUSD OMEGA · Limit-first (limit_first) off: its first ${v.n} closed trades averaged ${s(v.mean_r)}, below the ${s(v.mean_e0)} the plan replay at the plan's own entry gave on the same setups. Entries are as before; the owner may turn it on again on the switches page.`;
}

const parse = (s, fallback = null) => { if (s == null) return fallback; if (typeof s !== "string") return s; try { return JSON.parse(s); } catch { return fallback; } };

/**
 * The named auto-revert, on every ledger step until its window has a verdict. The window starts when limit_first was
 * last set (key_meta), else 0 (the default "on" from the deploy). `write(body, actor)` saves the settings. Returns
 * { status: inactive | waiting | kept | reverted | done | unavailable | failed, ... }. Never throws.
 */
export async function limitFirstRevert(env, { now = Date.now(), send = null, write = null } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    const row = await db.prepare("SELECT settings, key_meta FROM omega_settings WHERE id = 1").first();
    const settings = parse(row?.settings, {}) ?? {};
    if (!limitFirstOn(settings)) return { status: "inactive" };
    const at = Date.parse(String(parse(row?.key_meta, {})?.limit_first?.at ?? ""));
    const windowSince = finite(at) ? at : 0;
    const state = parse(await kv.get(LIMIT_FIRST_REVERT_KEY), null);
    if (state?.window_since === windowSince && (state.status === "kept" || state.status === "reverted")) return { status: "done", verdict: state.status };
    const intents = (await db.prepare("SELECT id, payload, result FROM omega_intents WHERE kind = 'place_limit' AND status = 'done' AND created_ms >= ? AND json_extract(payload, '$.limit_first') = 1 ORDER BY created_ms LIMIT 200").bind(windowSince).all()).results ?? [];
    const trades = [];
    for (const it of intents) {
      if (trades.length >= LIMIT_FIRST_REVERT.trades) break;
      const p = parse(it.payload, {}) ?? {}, res = parse(it.result, {}) ?? {};
      const ticket = Number(res.ticket);
      if (!finite(ticket)) continue;
      // A limit that never filled is no trade; a filled one still open stops the list there (the window waits for it).
      if (!finite(Number(p.filled_ms))) continue;
      const deals = (await db.prepare("SELECT volume, exit_price, closed_ms FROM ea_deals WHERE position_ticket = ? AND exit_price > 0").bind(ticket).all()).results ?? [];
      const vol0 = Number(p.lot), rd = Number(p.r_dist) > 0 ? Number(p.r_dist) : Math.abs(Number(p.planned_entry ?? p.entry) - Number(p.sl_plan ?? p.sl));
      const fill = Number(p.fill_price) > 0 ? Number(p.fill_price) : Number(p.planned_entry ?? p.entry);
      const closed = deals.reduce((a, d) => a + Number(d.volume || 0), 0);
      if (!(vol0 > 0) || !(rd > 0) || closed < vol0 - 1e-9) break;
      const dir = p.side === "BUY" ? 1 : -1;
      const r = deals.reduce((a, d) => a + dir * (Number(d.exit_price) - fill) * Number(d.volume || 0), 0) / (rd * vol0);
      const key = typeof p.decision_key === "string" ? p.decision_key : null;
      const setup = key ? await db.prepare("SELECT results_json FROM plan_setups WHERE decision_key = ? AND side = ? AND agent = ? AND source = 'live' AND status = 'resolved' LIMIT 1").bind(key, p.side, p.strategy ?? LIMIT_FIRST_DEFAULT_AGENT).first() : null;
      const e0 = Number(parse(setup?.results_json, {})?.["e0@s1"]?.r);
      trades.push({ r, e0 });
    }
    const v = limitFirstVerdict(trades);
    const summary = { n: v.n, mean_r: v.mean_r, mean_e0: v.mean_e0 };
    if (!v.ready) return { status: "waiting", ...summary };
    const event = async (action, detail) => { try { await db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, 'agent:limit-first', ?, ?)").bind(now, action, JSON.stringify(detail)).run(); } catch { /* audit best effort */ } };
    if (!v.revert) {
      await kv.put(LIMIT_FIRST_REVERT_KEY, JSON.stringify({ window_since: windowSince, status: "kept", ...summary, at: new Date(now).toISOString() }));
      await event("limit_first_kept", summary);
      return { status: "kept", ...summary };
    }
    let saved = false;
    if (typeof write === "function") { try { saved = (await write({ limit_first: "off" }, "agent:limit-first"))?.ok === true; } catch { saved = false; } }
    if (!saved) return { status: "failed", reason: "the settings could not be saved", ...summary };
    await kv.put(LIMIT_FIRST_REVERT_KEY, JSON.stringify({ window_since: windowSince, status: "reverted", ...summary, at: new Date(now).toISOString() }));
    await event("limit_first_reverted", { value: "off", from: "on", ...summary });
    if (typeof send === "function") { try { await send(limitFirstRevertLine(v)); } catch { /* best effort */ } }
    return { status: "reverted", ...summary };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}
