// The 5-minute position manager for the open Omega positions (owner 2026-11-17, confirmed in the session: "Ya,
// benar semua", "Setuju semua", USD 5 a day). Profit-oriented and risk-reducing only: every 5 minutes, for each
// position the system opened, the Position Council (a model call on measured inputs) judges the momentum and the
// thesis, and fixed rules turn that into at most one action:
//   profit >= +30 pips, momentum weakening        close now, without waiting for TP1
//   profit >= +30 pips, still strong               stop to break-even plus the spread
//   price >= 30 pips beyond TP1                    stop to TP1 (locks it), the position runs on to TP2; closed
//     instead when the council reads the momentum weakening
// The stop locks (break-even, TP1) go through the council; when it does not answer they apply as the mechanical
// fallback (owner 2026-11-19: "Lewat council juga", then "ya" to the fallback).
//   loss <= -30 pips, a measured reason and the    cut the loss now
//     council agrees: the decision on the other side, or the agent's measured confidence or the quorum's share
//     on the position's side dropped; and the council answered with the thesis weakening or broken
//   loss <= -30 pips, otherwise                    hold to the original stop (the broker's stop stays)
// A WAIT decision alone is never a reason to cut (owner 2026-11-19: "WAIT bisa jadi HOLD, harus divalidasi jangan
// langsung diexit"): it is said in the reason when it stands beside a measured one. Without the council's answer
// nothing is cut; the stop stays.
// TP1 is the plan's target (the open intent's tp), watched here; TP2 is the next key level beyond it, set as the
// broker's take-profit once. 1 pip = 0.10.
//
// In R since 2026-11-18 (owner, confirmed: "Per mode"; docs/RFC_ACCOUNT_PROFILES.md section 8): the +/-30 pip band
// of the profit and loss rules is the position's own stop distance at entry (the open intent's r_dist) times
// PM_R_BAND of the mode it opened in: scalp 0.3R, intraday and range 0.5R, swing 0.7R. A position whose stop distance
// is unknown keeps 30 pips. The 30 pips beyond TP1 of lock_tp1 stay in pips.
//
// Guardrails (owner): only close, or a stop moved in the position's favour (never widened), or the take-profit
// moved out to TP2; never an add, a reversal or an open. Inputs are measured: the strategy agent's confidence on the
// position's side against the bar before, the quorum's shares, the decision's stance. Never the council's own
// confidence. A missing input, a council timeout or failure, or the daily cap means no action (the broker's stop
// and target stay), except the stop locks, which apply as the fallback. POSITION_MANAGER_MODE "live" runs it, "off" stops it. Metered as "position_council" with its own
// daily cap (POSITION_COUNCIL_DAILY_USD, default 5), apart from the Decision Engine and the War Rooms.
//
// Here: the pure rules, the council's messages and schema, and the runner on the main Worker's 5-minute cron. Omega
// (src/omega-engine.mjs positionManagerIntents) turns a stored action into an intent at its next sync, checking it
// against the live price again.
import { callBusModel } from "./model-call.mjs";
import { ensureAiUsageSchema, neuronsOf, USD_PER_1K_NEURONS } from "./ai-usage.mjs";
import { confidenceTrend } from "./agent-confidence.mjs";
import { eaSignal } from "./ea-signal.mjs";
import { ensurePositionSchema, ACTION_TTL_MS } from "./position-actions.mjs";
import { readDelegations, hitlSupported } from "./omega-hitl.mjs";
export { ensurePositionSchema, pendingPositionActions, markPositionActions, ACTION_TTL_MS, actionMessage, actionIdOfIntent } from "./position-actions.mjs";

export const PIP = 0.1;
export const THRESHOLD_PIPS = 30;
/** The profit and loss band in R of the stop distance at entry, per trading mode (owner 2026-11-18: "Per mode"). */
export const PM_R_BAND = Object.freeze({ scalp: 0.3, intraday: 0.5, range: 0.5, swing: 0.7 });
const DEFAULT_MODE = "intraday";

/**
 * Pure: the band of one position, { pips, r, mode, r_dist_pips }: its mode's R band times its stop distance at entry
 * (`openIntent.r_dist`, else |entry − sl| of the intent), or THRESHOLD_PIPS with r null when that distance is unknown.
 * The mode is the intent's, else the decision's (`fallbackMode`), else intraday.
 */
export function pmBand(openIntent, fallbackMode = null) {
  const mode = [openIntent?.mode, fallbackMode].find((m) => typeof m === "string" && Object.hasOwn(PM_R_BAND, m)) ?? DEFAULT_MODE;
  const given = Number(openIntent?.r_dist);
  const dist = Number.isFinite(given) && given > 0 ? given : Math.abs(Number(openIntent?.entry) - Number(openIntent?.sl));
  if (!(Number.isFinite(dist) && dist > 0)) return { pips: THRESHOLD_PIPS, r: null, mode, r_dist_pips: null };
  return { pips: r1(PM_R_BAND[mode] * dist / PIP), r: PM_R_BAND[mode], mode, r_dist_pips: r1(dist / PIP) };
}
export const POSITION_COUNCIL_METER = "position_council";
export const POSITION_COUNCIL_DAILY_USD = 5;
/** A quorum share on the position's side that fell by more than this since the bar before is a confluence drop. */
export const SHARE_DROP = 0.05;
const DEFAULT_AGENT = "zone_pullback";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;

export function positionManagerMode(env) {
  return String(env?.POSITION_MANAGER_MODE ?? "off").trim().toLowerCase() === "live" ? "live" : "off";
}
export function dailyCapUsd(env) {
  const v = Number(env?.POSITION_COUNCIL_DAILY_USD ?? POSITION_COUNCIL_DAILY_USD);
  return Number.isFinite(v) && v >= 0 ? v : POSITION_COUNCIL_DAILY_USD;
}

/** Pure: a price distance in pips (1 pip = 0.10). */
export const pipsOf = (dist) => r1(dist / PIP);

/**
 * Pure: what the manager knows of one position. `openIntent` is its open intent's payload (entry, sl, tp = TP1,
 * strategy); `levels` the key levels on the broker's scale (low first); `decision` the latest Decision Engine record
 * (stance, quorum, agent_confidence and agent_confidence_prev). Returns null when an input the rules need is missing.
 */
export function positionFacts({ position: p, sym, openIntent, levels = [], decision }) {
  if (!p || (p.side !== "BUY" && p.side !== "SELL") || !isNum(sym?.bid) || !isNum(sym?.ask)) return null;
  const buy = p.side === "BUY", dir = buy ? 1 : -1;
  const open = Number(p.open_price ?? p.entry), sl = Number(p.sl), tp = Number(p.tp);
  const tp1 = Number(openIntent?.tp);
  if (!Number.isFinite(open) || !Number.isFinite(tp1) || tp1 <= 0 || !decision?.stance || !decision?.quorum) return null;
  const price = buy ? sym.bid : sym.ask;
  const point = isNum(sym.point) && sym.point > 0 ? sym.point : 0.01;
  const spreadPx = (isNum(sym.spread_points) ? sym.spread_points : 0) * point;
  const agent = typeof openIntent?.strategy === "string" && openIntent.strategy ? openIntent.strategy : DEFAULT_AGENT;
  const k = buy ? "long" : "short";
  const conf = decision.agent_confidence?.[agent]?.[k], prev = decision.agent_confidence_prev?.[agent]?.[k];
  const share = buy ? decision.quorum.long_share : decision.quorum.short_share;
  const prevShare = buy ? decision.quorum_prev?.long_share : decision.quorum_prev?.short_share;
  const beyond = levels.filter((z) => (buy ? z.low > tp1 + spreadPx : z.high < tp1 - spreadPx)).sort((a, b) => (buy ? a.low - b.low : b.high - a.high))[0];
  const band = pmBand(openIntent, decision.trading_mode ?? null);
  const pips = pipsOf(dir * (price - open));
  return {
    ticket: p.ticket, side: p.side, dir, open, price, sl: Number.isFinite(sl) ? sl : null, tp: Number.isFinite(tp) ? tp : null,
    tp1, tp2: beyond ? (buy ? beyond.low : beyond.high) : null, spread: spreadPx, point,
    pips, beyond_tp1_pips: pipsOf(dir * (price - tp1)),
    band_pips: band.pips, band_r: band.r, mode: band.mode, r_dist_pips: band.r_dist_pips, r: band.r_dist_pips ? Math.round((pips / band.r_dist_pips) * 100) / 100 : null,
    agent, agent_conf: isNum(conf) ? conf : null, agent_conf_prev: isNum(prev) ? prev : null, agent_trend: confidenceTrend(conf, prev),
    stance: decision.stance, with_decision: decision.stance === p.side, against_decision: decision.stance === (buy ? "SELL" : "BUY"),
    share: isNum(share) ? share : null, share_prev: isNum(prevShare) ? prevShare : null
  };
}

/**
 * Pure: the action of one position from its facts and the council's answer ({ momentum, thesis }, or null when the
 * council failed or was not asked). Returns { action: "close" | "sl" | "tp" | "hold" | "none", rule, sl?, tp?, why }.
 * "none" means no action for want of an input; "hold" is a decision to keep the position as it is.
 */
export function positionAction(f, council) {
  if (!f) return { action: "none", rule: "inputs_missing", why: "an input the rules need is missing" };
  const better = (x) => f.sl == null || (f.dir > 0 ? x > f.sl + f.point / 2 : x < f.sl - f.point / 2);
  const room = (x) => (f.dir > 0 ? x < f.price - f.spread : x > f.price + f.spread);
  // TP2 at the broker once: a take-profit still at TP1 moves out to the next key level.
  const tpAtTp1 = f.tp != null && Math.abs(f.tp - f.tp1) <= PIP / 2;
  // The stop locks go through the council too (owner 2026-11-19: "Lewat council juga"; and "ya" to the fallback): the
  // council's answer decides between locking and taking the profit now (momentum weakening). When it does not answer
  // (a failure, a timeout, the daily cap), the lock is applied as the mechanical fallback: a lock only reduces risk.
  const silent = council ? "" : " (the council did not answer: the lock applies as the fallback)";
  const reading = council ? `; the council reads ${council.momentum}, thesis ${council.thesis}` : silent;
  // Beyond TP1 by 30 pips: the stop locks TP1, or the position closes when the council reads the momentum weakening.
  if (f.beyond_tp1_pips >= THRESHOLD_PIPS && better(f.tp1) && room(f.tp1)) {
    if (council?.momentum === "weakening") return { action: "close", rule: "take_profit_weakening", why: `${f.beyond_tp1_pips} pips beyond TP1 and the momentum is weakening: closed instead of locking TP1` };
    return { action: "sl", rule: "lock_tp1", sl: f.tp1, why: `${f.beyond_tp1_pips} pips beyond TP1: stop to TP1${reading}` };
  }
  const band = isNum(f.band_pips) && f.band_pips > 0 ? f.band_pips : THRESHOLD_PIPS;
  const at = (sign) => `${sign > 0 ? "+" : ""}${f.pips} pips${f.r != null ? ` (${sign > 0 ? "+" : ""}${f.r}R, band ${f.band_r}R ${f.mode})` : ""}`;
  if (f.pips >= band) {
    if (council?.momentum === "weakening") return { action: "close", rule: "take_profit_weakening", why: `${at(1)} and the momentum is weakening: closed without waiting for TP1` };
    const be = f.open + f.dir * f.spread;
    if (better(be) && room(be)) return { action: "sl", rule: "breakeven", sl: be, why: `${at(1)}${council ? " and still strong" : ""}: stop to break-even plus the spread${reading}` };
    if (!council) return { action: "none", rule: "council_unavailable", why: "the council did not answer: the stop and target stay" };
    return tpAtTp1 && f.tp2 != null ? { action: "tp", rule: "tp2_target", tp: f.tp2, why: "target out to TP2 (the next key level)" } : { action: "hold", rule: "protected", why: `${at(1)}, the stop already protects it` };
  }
  if (f.pips <= -band) {
    if (f.agent_conf == null || f.agent_conf_prev == null || f.share == null) return { action: "none", rule: "inputs_missing", why: "the agent's confidence or the quorum is missing: the stop stays" };
    const shareDrop = f.share_prev != null && f.share_prev - f.share > SHARE_DROP;
    // Measured reasons only. A WAIT decision is not one (owner 2026-11-19): it is said beside one, never alone.
    const reasons = [
      ...(f.against_decision ? [`the decision is ${f.stance}`] : []),
      ...(f.agent_trend === "drop" ? [`the ${f.agent} confidence dropped ${f.agent_conf_prev} to ${f.agent_conf}`] : []),
      ...(shareDrop ? [`the quorum's ${f.side === "BUY" ? "bullish" : "bearish"} share fell ${Math.round(f.share_prev * 100)}% to ${Math.round(f.share * 100)}%`] : [])
    ];
    const wait = !f.with_decision && !f.against_decision ? `the decision is ${f.stance}` : null;
    if (!reasons.length) return { action: "hold", rule: "hold_to_stop", why: `${at(-1)} but no measured reason to cut${wait ? ` (${wait}, not a reason alone)` : ""}: held to the original stop` };
    // The cut goes through the council: without its answer, or with the thesis intact, the position holds.
    if (!council) return { action: "none", rule: "council_unavailable", why: `${at(-1)} and ${reasons.join("; ")}, but the council did not answer: the stop stays` };
    if (council.thesis === "intact") return { action: "hold", rule: "hold_thesis_intact", why: `${at(-1)} and ${reasons.join("; ")}, but the council calls the thesis intact: held to the original stop` };
    return { action: "close", rule: "cut_loss", why: `${at(-1)} and ${[...reasons, ...(wait ? [wait] : [])].join("; ")}; the council calls the thesis ${council.thesis}: loss cut` };
  }
  if (tpAtTp1 && f.tp2 != null && f.pips > 0) return { action: "tp", rule: "tp2_target", tp: f.tp2, why: "target out to TP2 (the next key level)" };
  return { action: "hold", rule: "inside_band", why: `${f.pips} pips: inside the ±${band} pip band${f.r != null ? ` (±${f.band_r}R ${f.mode})` : ""}` };
}

export const POSITION_COUNCIL_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["momentum", "thesis", "reason"],
  properties: {
    momentum: { type: "string", enum: ["strengthening", "holding", "weakening"] },
    thesis: { type: "string", enum: ["intact", "weakening", "broken"] },
    reason: { type: "string", maxLength: 240 }
  }
});

/** Pure: the council's messages for one position (measured inputs only; never a size, never the council's own confidence). */
export function positionCouncilMessages(f, { m5 = null, levels = [] } = {}) {
  const evidence = {
    position: { side: f.side, open: f.open, price: f.price, pips: f.pips, r: f.r ?? null, mode: f.mode ?? null, band_pips: f.band_pips ?? null, stop: f.sl, target: f.tp, tp1: f.tp1, tp2: f.tp2, beyond_tp1_pips: f.beyond_tp1_pips },
    measured: { agent: f.agent, agent_confidence_now: f.agent_conf, agent_confidence_15m_ago: f.agent_conf_prev, agent_trend: f.agent_trend, decision_stance: f.stance, quorum_share_with_position: f.share, quorum_share_15m_ago: f.share_prev },
    m5: m5 ? { atr: m5.m5_atr ?? null, swing_low: m5.m5_swing_low ?? null, swing_high: m5.m5_swing_high ?? null, confirmation_buy: m5.m5_buy === true, confirmation_sell: m5.m5_sell === true } : null,
    key_levels: levels.slice(0, 12)
  };
  return [
    { role: "system", content: "You are the Position Council of the XAUUSD system. Every 5 minutes you judge ONE open position from measured inputs only: the strategy agent's confidence on the position's side now and 15 minutes ago, the quorum's share on its side, the Decision Engine's stance, the broker's 5m structure and the key levels. Answer momentum (strengthening, holding or weakening: is price still moving the position's way with the agents and the quorum behind it?) and thesis (intact, weakening or broken: does the reason the position was opened still hold?). Fixed rules turn your answer into an action; you never choose the action, a size or a price. Return only the JSON object, with one short reason in plain words." },
    { role: "user", content: JSON.stringify(evidence) }
  ];
}

/** The council's answer reduced to the schema, or null. */
export function cleanCouncil(o) {
  if (!o || !["strengthening", "holding", "weakening"].includes(o.momentum) || !["intact", "weakening", "broken"].includes(o.thesis)) return null;
  return { momentum: o.momentum, thesis: o.thesis, reason: String(o.reason ?? "").slice(0, 240) };
}

/** Today's spend of the position council in USD (from ai_usage_daily). */
export async function positionCouncilSpendUsd(db, { now = Date.now() } = {}) {
  await ensureAiUsageSchema(db);
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = (await db.prepare("SELECT model, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, SUM(cached_tokens) AS k FROM ai_usage_daily WHERE day = ? AND source = ? GROUP BY model").bind(day, POSITION_COUNCIL_METER).all()).results || [];
  let neurons = 0;
  for (const r of rows) neurons += neuronsOf(r.model, Number(r.p) || 0, Number(r.c) || 0, Number(r.k) || 0) ?? 0;
  return Math.round((neurons / 1000) * USD_PER_1K_NEURONS * 10_000) / 10_000;
}

/**
 * The runner, on the main Worker's 5-minute cron: each open Omega position once per 5-minute bar. `deps` lets the
 * tests give the executor, the open intents, the signal, the decision, the model call and Telegram. Never throws.
 */
export async function runPositionManager(env, { now = Date.now(), call = callBusModel, send = null, executor: executorIn, openIntents: intentsIn, signal: signalIn, decision: decisionIn } = {}) {
  if (positionManagerMode(env) !== "live") return { status: "off" };
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  try {
    await ensurePositionSchema(db);
    const executor = executorIn !== undefined ? executorIn : JSON.parse((await db.prepare("SELECT state FROM omega_bridge WHERE id = 1").first())?.state || "null");
    // Omega's own positions, and the manual ones the owner delegated (owner 2026-11-19, src/omega-hitl.mjs; needs
    // OmegaExecutor 1.18): a delegated position reads its own stop and target as its plan.
    let delegatedTickets = new Set();
    if (hitlSupported(executor)) { try { delegatedTickets = new Set((await readDelegations(db)).tickets); } catch { delegatedTickets = new Set(); } }
    const delegatedOf = (p) => delegatedTickets.has(Number(p?.ticket)) && (p?.source === "manual" || p?.magic === 0);
    const positions = (Array.isArray(executor?.positions) ? executor.positions : [])
      .map((p) => (delegatedOf(p) ? { ...p, intent_id: `deleg:${p.ticket}`, delegated: true } : p))
      .filter((p) => typeof p?.intent_id === "string" && (p.intent_id.startsWith("open:") || p.delegated === true) && (p.side === "BUY" || p.side === "SELL"));
    if (!positions.length) return { status: "no_positions" };
    const sym = executor?.symbol ?? {};
    const ids = positions.filter((p) => !p.delegated).map((p) => p.intent_id);
    const stored = intentsIn ?? (ids.length ? Object.fromEntries(((await db.prepare(`SELECT id, payload FROM omega_intents WHERE kind = 'open' AND id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all()).results ?? []).map((r) => [r.id, JSON.parse(r.payload)])) : {});
    const openIntents = { ...stored };
    for (const p of positions.filter((x) => x.delegated)) {
      openIntents[p.intent_id] ??= { tp: Number(p.tp) > 0 ? p.tp : null, entry: p.open_price, sl: Number(p.sl) > 0 ? p.sl : null, strategy: null,
        ...(Number(p.sl) > 0 && Number.isFinite(Number(p.open_price)) ? { r_dist: Math.abs(Number(p.open_price) - Number(p.sl)) } : {}) };
    }
    let signal = signalIn;
    if (signal === undefined) { try { signal = await eaSignal(env, { now }); } catch { signal = null; } }
    const decision = decisionIn !== undefined ? decisionIn : await latestDecisions(db);
    const levels = brokerLevels(signal);
    const bar = Math.floor(now / 300_000);
    const capUsd = dailyCapUsd(env);
    const spent = await positionCouncilSpendUsd(db, { now });
    const out = [];
    // The daily cap reached: said once a day; the broker's stops and targets stay.
    if (spent >= capUsd && send) {
      const key = `pm:cap:${new Date(now).toISOString().slice(0, 10)}`;
      if (!(await env.SIGNAL_CACHE?.get?.(key))) {
        await env.SIGNAL_CACHE?.put?.(key, "1", { expirationTtl: 2 * 86_400 });
        try { await send(`XAUUSD POSITION MANAGER · paused for today\nThe position council reached its daily cap (USD ${capUsd}). No close until 00:00 UTC; the stop locks (break-even, TP1) still apply as the fallback, and the broker's stops and targets stay.`); } catch { /* said next time */ }
      }
    }
    for (const p of positions) {
      const id = `pm:${p.ticket}:${bar}`;
      if (await db.prepare("SELECT id FROM position_actions WHERE id = ?").bind(id).first()) continue;
      const f = positionFacts({ position: p, sym, openIntent: openIntents[p.intent_id], levels, decision });
      let council = null, councilNote = null;
      if (f && spent < capUsd) {
        try {
          const r = await call(env, { messages: positionCouncilMessages(f, { m5: signal, levels }), schemaName: "position_council", schema: POSITION_COUNCIL_SCHEMA, maxTokens: 400, effort: "low", deadline: Date.now() + 45_000, clock: () => Date.now(), runState: {}, role: "agent", meterSource: POSITION_COUNCIL_METER });
          council = r?.status === "answered" ? cleanCouncil(r.obj) : null;
          if (!council) councilNote = "council_failed";
        } catch { council = null; councilNote = "council_failed"; }
      } else if (f) councilNote = "daily_cap";
      const a = positionAction(f, council);
      const row = { id, ticket: p.ticket, bar, at_ms: now, side: p.side, pips: f?.pips ?? null, price: f?.price ?? null, action: a.action, rule: councilNote && a.action === "none" ? councilNote : a.rule,
        sl: a.sl ?? null, tp: a.tp ?? null, why: a.why, council: council ? `${council.momentum}, thesis ${council.thesis}: ${council.reason}` : null,
        orig_sl: f?.sl ?? null, orig_tp: f?.tp ?? null, basis: isNum(signal?.feed_basis) ? signal.feed_basis : null, status: ["close", "sl", "tp"].includes(a.action) ? "pending" : "noted" };
      await db.prepare("INSERT OR IGNORE INTO position_actions (id, ticket, bar, at_ms, side, pips, price, action, rule, sl, tp, why, council, orig_sl, orig_tp, basis, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(row.id, row.ticket, row.bar, row.at_ms, row.side, row.pips, row.price, row.action, row.rule, row.sl, row.tp, row.why, row.council, row.orig_sl, row.orig_tp, row.basis, row.status).run();
      // No Telegram line here: Omega says what reached the broker, or why the action was not applied (owner 2026-11-19).
      out.push({ ticket: row.ticket, action: row.action, rule: row.rule, pips: row.pips });
    }
    return { status: "ran", spent_usd: spent, cap_usd: capUsd, positions: out };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}

/** The latest decision with the quorum of the bar before (quorum_prev), or null. */
export async function latestDecisions(db) {
  try {
    const rows = (await db.prepare("SELECT decision_json FROM engine_decisions ORDER BY bar_close DESC LIMIT 2").all()).results ?? [];
    const [d, prev] = rows.map((r) => JSON.parse(r.decision_json));
    if (!d) return null;
    const fresh = prev && Date.parse(d.bar_close) - Date.parse(prev.bar_close) === 15 * 60_000;
    return { ...d, quorum_prev: fresh ? prev.quorum ?? null : null };
  } catch { return null; }
}

/** Pure: the signal's key levels on the broker's scale (as Omega reads them), [] without a known basis. */
export function brokerLevels(signal) {
  if (signal?.feed_basis_known !== true || !isNum(signal?.feed_basis) || typeof signal?.key_levels !== "string") return [];
  return signal.key_levels.split(",").map((s) => s.split(":").map(Number)).filter(([lo, hi]) => isNum(lo) && isNum(hi) && lo > 0 && lo <= hi).map(([lo, hi]) => ({ low: lo + signal.feed_basis, high: hi + signal.feed_basis })).sort((a, b) => a.low - b.low);
}

/**
 * Pure: the day's report, each action against holding to the original stop and target (owner: no shadow phase, so
 * this is how it is judged). `bars` are closed bars on the feed's scale ({ open_time, high, low, close }); a row's
 * `basis` maps them to the broker's scale. A close is worth its exit pips minus what holding would have made (the
 * first of the original stop or target touched after it; the last close when neither was). A stop or target move is
 * not scored here (its exit is a later close the broker reports).
 */
export function positionReport(rows, bars, { now = Date.now() } = {}) {
  const ms = (b) => (typeof b.open_time === "number" ? b.open_time : Date.parse(b.open_time));
  const items = [];
  let saved = 0, scored = 0;
  for (const r of rows) {
    if (r.action !== "close" || r.status !== "applied") { items.push({ ticket: r.ticket, rule: r.rule, action: r.action, status: r.status ?? null, pips: r.pips, held_pips: null, saved_pips: null }); continue; }
    const dir = r.side === "BUY" ? 1 : -1, basis = isNum(r.basis) ? r.basis : 0;
    const after = bars.filter((b) => ms(b) >= r.at_ms && ms(b) <= now);
    let heldExit = null;
    for (const b of after) {
      const hi = b.high + basis, lo = b.low + basis;
      const hitSl = isNum(r.orig_sl) && (dir > 0 ? lo <= r.orig_sl : hi >= r.orig_sl);
      const hitTp = isNum(r.orig_tp) && (dir > 0 ? hi >= r.orig_tp : lo <= r.orig_tp);
      if (hitSl) { heldExit = r.orig_sl; break; }
      if (hitTp) { heldExit = r.orig_tp; break; }
    }
    if (heldExit == null && after.length) heldExit = after.at(-1).close + basis;
    const open = isNum(r.price) && isNum(r.pips) ? r.price - dir * r.pips * PIP : null;
    const held = heldExit != null && open != null ? pipsOf(dir * (heldExit - open)) : null;
    const s = held != null && isNum(r.pips) ? r1(r.pips - held) : null;
    if (s != null) { saved += s; scored += 1; }
    items.push({ ticket: r.ticket, rule: r.rule, action: r.action, status: r.status ?? null, pips: r.pips, held_pips: held, saved_pips: s });
  }
  return { actions: rows.length, scored, saved_pips: r1(saved), items };
}

/** The UTC hour of the daily report (after New York's close). */
export const REPORT_HOUR = 21;

/** Pure: the daily report as a Telegram text. */
export function reportMessage(day, rep) {
  const lines = rep.items.filter((i) => ["close", "sl", "tp"].includes(i.action)).map((i) => `#${i.ticket} ${i.rule}${i.status && i.status !== "applied" ? ` (not applied: ${i.status})` : ""}: ${i.pips >= 0 ? "+" : ""}${i.pips} pips${i.saved_pips != null ? ` · held to the original stop/target: ${i.held_pips >= 0 ? "+" : ""}${i.held_pips} → ${i.saved_pips >= 0 ? "saved" : "lost"} ${Math.abs(i.saved_pips)} pips` : ""}`);
  return [`XAUUSD POSITION MANAGER · report ${day}`, lines.length ? `${lines.length} action${lines.length === 1 ? "" : "s"}; closes against holding: ${rep.saved_pips >= 0 ? "+" : ""}${rep.saved_pips} pips (${rep.scored} scored)` : "No action today.", ...lines.slice(0, 20)].join("\n");
}

/** The daily report, once after REPORT_HOUR UTC: today's actions against holding to the original stop and target. Never throws. */
export async function runPositionReport(env, { now = Date.now(), send = null, bars: barsIn } = {}) {
  if (positionManagerMode(env) !== "live" || !env?.DB || new Date(now).getUTCHours() < REPORT_HOUR) return { status: "waiting" };
  const day = new Date(now).toISOString().slice(0, 10), key = `pm:report:${day}`;
  try {
    if (await env.SIGNAL_CACHE?.get?.(key)) return { status: "done" };
    await ensurePositionSchema(env.DB);
    const from = Date.parse(`${day}T00:00:00Z`);
    const rows = (await env.DB.prepare("SELECT * FROM position_actions WHERE at_ms >= ? AND action IN ('close', 'sl', 'tp') ORDER BY at_ms").bind(from).all()).results ?? [];
    let bars = barsIn;
    if (bars === undefined) { try { bars = await (await import("./signal-ledger.mjs")).ledgerBars(env); } catch { bars = []; } }
    const rep = positionReport(rows, bars ?? [], { now });
    await env.SIGNAL_CACHE?.put?.(key, "1", { expirationTtl: 3 * 86_400 });
    if (send && rows.length) { try { await send(reportMessage(day, rep)); } catch { /* the report is in /api/omega/position-manager */ } }
    return { status: "reported", ...rep };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}

/** The recent actions and today's report (GET /api/omega/position-manager). Never throws. */
export async function readPositionManager(env, { now = Date.now(), limit = 50 } = {}) {
  try {
    await ensurePositionSchema(env.DB);
    const rows = (await env.DB.prepare("SELECT * FROM position_actions ORDER BY at_ms DESC LIMIT ?").bind(Math.max(1, Math.min(200, Number(limit) || 50))).all()).results ?? [];
    return { version: "cryptophys.position-manager.v1", mode: positionManagerMode(env), cap_usd: dailyCapUsd(env), spent_usd: await positionCouncilSpendUsd(env.DB, { now }), threshold_pips: THRESHOLD_PIPS, band_r: PM_R_BAND, rows };
  } catch (error) {
    return { version: "cryptophys.position-manager.v1", error: String(error?.message ?? error).slice(0, 160), rows: [] };
  }
}
