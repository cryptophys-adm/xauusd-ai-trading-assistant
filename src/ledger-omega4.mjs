// The Signal Ledger's Omega policy, version 4 (owner 2026-11-20: "pastikan omega performance sama dengan omega yang
// live sekarang"). v3 (src/signal-ledger.mjs simulateOmega) re-implements a few of Omega's rules on each ledger row.
// v4 replays the live engine itself: one simulated account, minute by minute on the feed's 1m bars, through the very
// functions the Omega sync and the Position Manager call:
//   signal      eaSignalFromDecision + managementFields (src/ea-signal.mjs) on the decision current then, with the 5m
//               structure (the pull adapter's structureOf) and the ladder's closed candles (lastClosedCandle) rebuilt
//               from the 1m bars, the grid's choice (applyGridChoice), range mode (applyRangeMode), the strategy arm
//               (applyArmGate);
//   plan        planIntents (src/omega-engine.mjs) at every minute that matters, with a synthetic executor that passes
//               the live gates honestly (connected, fresh, gold in USD, the account's profile and its balance, the
//               open positions with their open intent ids); its intents are applied to the simulated positions:
//               close, close_all, modify_sl, modify_tp, modify_sltp, partial_close, open. So the order of the
//               management is the live one: kill, the opposite close, the strategy exits, the Position Manager, the
//               key levels, the TP ladder and its lock, the partials, then the entry gates, the re-entry cooldown and
//               the sizing within the profile;
//   PM          positionFacts and positionAction (src/position-manager.mjs) at 3 minutes past each 5m close (the live
//               cron runs about 2.5 minutes past), with the council's recorded verdict for that position and bar where
//               the live account had one (D1 position_actions.council), else none: the mechanical fallback;
//   broker      the stop and the target at the broker, inside each minute (a gap at the open exits at the open; within
//               the minute the stop first), a SELL closing at the ask (the bid plus the fixed spread).
// It never feeds a room, a prompt or a decision, and nothing here is sent to Aether or the platform. R is the unit:
// realised P/L over the risk at the open (|entry − stop| × volume at the open); partials count their share.
// The parity check (omegaParity) compares it with Omega's real trades on the live USD account.

import { planIntents, isProtected, OMEGA_DEFAULTS, commandedStops, STOP_COMMAND_MS, REENTRY_EXIT_REASONS } from "./omega-engine.mjs";
import { eaSignalFromDecision, managementFields, applyArmGate, blackoutWindow } from "./ea-signal.mjs";
import { positionFacts, positionAction, brokerLevels } from "./position-manager.mjs";
import { lastClosedCandle } from "./omega-broker.mjs";
import { applyGridChoice, gridAdaptMode, readGridChoices } from "./grid-adapt.mjs";
import { applyRangeMode, RANGE_GATED_AGENTS } from "./htf-cells.mjs";
import { strategyArmMode, readArmState } from "./strategy-arm.mjs";
import { gatedEvents } from "./econ-calendar.mjs";
import { eaVersionGateOn } from "./account-spec.mjs";
import { toMs, decisionCloseMs, brokerDayStart, OMEGA_SIM, TRADING_MODES, ensureLedgerSchema, ledgerSeries, OMEGA4_VERSION, OMEGA4_PARITY_KEY } from "./signal-ledger.mjs";
import * as omegaEngine from "./omega-engine.mjs";
import * as positionManager from "./position-manager.mjs";
import * as positionActions from "./position-actions.mjs";
import * as eaSignalModule from "./ea-signal.mjs";
import * as omegaBroker from "./omega-broker.mjs";
import * as accountSpec from "./account-spec.mjs";
import * as goldSymbol from "./gold-symbol.mjs";
import * as gridAdapt from "./grid-adapt.mjs";
import * as htfCells from "./htf-cells.mjs";
import * as agentConfidence from "./agent-confidence.mjs";
import * as brokerTrigger from "./broker-trigger.mjs";
import * as omegaLimitKnobs from "./omega-limit-knobs.mjs";
import * as pmLoosenKnobs from "./pm-loosen-knobs.mjs";
import * as limitCouncil from "./limit-council.mjs";
import * as liquidityLens from "./liquidity-lens.mjs";

export { OMEGA4_VERSION, OMEGA4_PARITY_KEY };

/**
 * The synthetic broker: the ledger's fixed spread, gold in USD (contract 100 oz, tick 0.01 worth USD 1 a lot, so
 * USD 100 a lot per 1.00 of price), the OmegaExecutor version the live terminal runs, and the account's starting
 * balance when no live USD account is known.
 */
export const OMEGA4_SIM = Object.freeze({
  spread: OMEGA_SIM.spread, point: 0.01, tick_size: 0.01, tick_value: 1, contract_size: 100, volume_min: 0.01, volume_step: 0.01, volume_max: 100,
  executor_version: "1.20", start_balance: 1000, warmup_ms: 4 * 3600_000, pm_offset_ms: 3 * 60_000, recent_keep_ms: 2 * 86_400_000
});
export const OMEGA4_CHECKPOINT_KEY = "ledger:omega4:checkpoint:v1";
const M1 = 60_000, M5 = 5 * M1, M15 = 15 * M1;
const REENTRY_LOOKBACK_MS = 6 * 3600_000;
const MONEY_PER_PRICE_LOT = OMEGA4_SIM.tick_value / OMEGA4_SIM.tick_size;

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const iso = (ms) => new Date(ms).toISOString();
const parse = (t, fallback = null) => { if (t == null) return fallback; if (typeof t !== "string") return t; try { return JSON.parse(t); } catch { return fallback; } };

// ---------------------------------------------------------------------------
// Pure inputs rebuilt from the feed's 1m bars.

/** Pure: the feed's 1m bars as { t: open ms, o, h, l, c }, oldest first (a bar without an open opens at the close before). */
export function minuteBars(bars = []) {
  const out = [];
  for (const b of bars) {
    const t = toMs(b?.open_time);
    if (!finite(t) || toMs(b.close_time) - t !== M1 || ![b.high, b.low, b.close].every(finite)) continue;
    out.push({ t, o: finite(b.open) ? b.open : null, h: b.high, l: b.low, c: b.close });
  }
  out.sort((a, b) => a.t - b.t);
  const uniq = [];
  for (const b of out) { if (uniq.length && uniq.at(-1).t === b.t) continue; if (b.o == null) b.o = uniq.length ? uniq.at(-1).c : b.c; uniq.push(b); }
  return uniq;
}

/** Pure: bars of `tf` ms aggregated from 1m bars ({ t, close_ms, o, h, l, c, n }), oldest first. */
export function aggregate(m1, tf) {
  const out = [];
  for (const b of m1) {
    const t = Math.floor(b.t / tf) * tf;
    const last = out.at(-1);
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.n += 1; }
    else out.push({ t, close_ms: t + tf, o: b.o, h: b.h, l: b.l, c: b.c, n: 1 });
  }
  return out;
}

/**
 * Pure: the swing high and low of the last `n` bars and the ATR(14), or null: the pull adapter's structureOf
 * (market-data-ingestion/src/broker-trigger.mjs), which sends the broker's 5m structure to Omega. Kept here line for
 * line (that Worker's module pulls the 5m Prophet producer in); test/ledger-omega-v4.test.mjs proves them equal.
 */
export function structureOf(bars, n = 3) {
  if (!Array.isArray(bars) || bars.length < 15) return null;
  const last = bars.slice(-n);
  const tr = [];
  for (let i = bars.length - 14; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)));
  }
  const atr = tr.reduce((s, x) => s + x, 0) / tr.length;
  const r = (x) => Math.round(x * 1000) / 1000;
  return { swing_high: r(Math.max(...last.map((b) => b.high))), swing_low: r(Math.min(...last.map((b) => b.low))), atr: r(atr) };
}

/** Pure: the council's recorded verdict ("<momentum>, thesis <thesis>: <reason>", D1 position_actions.council), or null. */
export function parseCouncil(text) {
  const m = /^(strengthening|holding|weakening), thesis (intact|weakening|broken)(?::\s?([\s\S]*))?$/.exec(String(text ?? "").trim());
  return m ? { momentum: m[1], thesis: m[2], reason: (m[3] ?? "").slice(0, 240) } : null;
}

/**
 * Pure: a decision as the signal, the Position Manager and the gates read it, from an engine_decisions row whose
 * JSON fields were extracted by D1 (DECISION_SQL) or from the full decision_json object itself.
 */
export function decisionFromRow(r) {
  if (r?.decision_json) {
    const d = parse(r.decision_json, null);
    if (!d?.decision_key) return null;
    return withTimes(d);
  }
  if (!r?.decision_key) return null;
  return withTimes({
    decision_key: r.decision_key, stance: r.stance, decided_at: r.decided_at ?? null, bar_close: r.bar_close ?? null,
    confidence: finite(Number(r.confidence)) && r.confidence != null ? Number(r.confidence) : null,
    trade: parse(r.trade, null),
    guardrails: { long: { entry_trigger: parse(r.trig_long, null) }, short: { entry_trigger: parse(r.trig_short, null) } },
    quorum: parse(r.quorum, null), key_levels: parse(r.key_levels, []),
    agent_confidence: parse(r.conf, null), agent_confidence_prev: parse(r.conf_prev, null),
    trading_mode: typeof r.mode === "string" ? r.mode : null, strategy_execution: r.sx === 1 || r.sx === true,
    context: { regime_1h: typeof r.regime === "string" ? r.regime : null }, strategy: { atr_h1: r.atr_h1 == null ? null : Number(r.atr_h1) }
  });
}
function withTimes(d) {
  const close = decisionCloseMs(d.decision_key);
  if (!finite(close)) return null;
  const decided = toMs(d.decided_at);
  return { ...d, close_ms: close, decided_ms: finite(decided) ? Math.max(decided, close) : close };
}
/** The engine_decisions fields the replay reads (the rest of decision_json is never read by the live functions it calls). */
export const DECISION_SQL = "SELECT decision_key, stance, decided_at, bar_close, json_extract(decision_json, '$.confidence') AS confidence, json_extract(decision_json, '$.trade') AS trade, json_extract(decision_json, '$.guardrails.long.entry_trigger') AS trig_long, json_extract(decision_json, '$.guardrails.short.entry_trigger') AS trig_short, json_extract(decision_json, '$.quorum') AS quorum, json_extract(decision_json, '$.key_levels') AS key_levels, json_extract(decision_json, '$.agent_confidence') AS conf, json_extract(decision_json, '$.agent_confidence_prev') AS conf_prev, json_extract(decision_json, '$.trading_mode') AS mode, json_extract(decision_json, '$.strategy_execution') AS sx, json_extract(decision_json, '$.context.regime_1h') AS regime, json_extract(decision_json, '$.strategy.atr_h1') AS atr_h1 FROM engine_decisions WHERE bar_close >= ? ORDER BY bar_close";

/** Pure: the profile in force at a time, from the account's omega_profile_changes ({ at_ms, from_profile, to_profile }). */
export function profileTimeline(changes = [], current = null) {
  const list = (Array.isArray(changes) ? changes : []).filter((c) => finite(Number(c?.at_ms)) && typeof c.to_profile === "string").map((c) => ({ at: Number(c.at_ms), from: c.from_profile, to: c.to_profile })).sort((a, b) => a.at - b.at);
  return (ms) => {
    let p = list.length ? list[0].from ?? current : current;
    for (const c of list) { if (c.at > ms) break; p = c.to; }
    return typeof p === "string" ? p : null;
  };
}

/**
 * Pure: the live account's balance at a time, rebuilt backward from its last known balance (`last`, at `lastMs`)
 * less its deals' results closed after that time ({ closed_ms, net }). Deposits and withdrawals are not told apart.
 */
export function balanceTimeline({ last = null, lastMs = null, deals = [] } = {}) {
  if (!finite(last) || !finite(lastMs)) return null;
  const list = (Array.isArray(deals) ? deals : []).filter((d) => finite(Number(d?.closed_ms)) && finite(Number(d?.net)) && Number(d.closed_ms) <= lastMs).map((d) => ({ ms: Number(d.closed_ms), net: Number(d.net) })).sort((a, b) => a.ms - b.ms);
  const suffix = new Array(list.length + 1).fill(0);
  for (let i = list.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + list[i].net;
  return (ms) => {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].ms <= ms) lo = mid + 1; else hi = mid; }
    return r2(last - suffix[lo]);
  };
}

// ---------------------------------------------------------------------------
// The replay.

const awaitingGate = (reason) => {
  const r = String(reason ?? "");
  if (/confirmation/.test(r)) return "entry_trigger_unreconstructable";
  return r ? r.replace(/[^a-z0-9_]/gi, "_").slice(0, 40) : "no_side";
};
const BROKER_EXITS = new Set(["stop", "sl_plus", "target", "trailed_target"]);

/** At most this many replay minutes per invocation (the 5-minute cron's CPU budget); the checkpoint carries the rest. */
export const MAX_REPLAY_MINUTES = 720;

/**
 * Pure: Omega's policy replayed on the 1m bars from `from` to `to` (at most `maxSteps` minutes), one account, through
 * the live functions (see the header). Returns { records: { [decision_key]: record }, checkpoint, steps, plans,
 * pm_calls, decisions, last_ms, more }:
 *   records     every BUY/SELL decision whose entry window falls in the span: traded (open or closed, with its exit,
 *               R and size), skipped (the gate that held it) or pending (its window still runs at the end);
 *   checkpoint  the whole replay state at the next minute (open positions and their trades, the recent intent ids,
 *               the re-entry exit, the gate notes, the synthetic balance): a later run goes on from there exactly as
 *               this run would have (test V11), so a bounded run never repeats or loses a minute;
 *   more        the bound stopped the run before `to`.
 * `plan` is planIntents (a test may wrap it); `trace` collects each call's input and output.
 * `entry` is another entry policy on the same account and the same management (src/ledger-omega-limit.mjs, the limit
 * counterfactual): null is v4's own, the market entry planIntents opens. With one, planIntents' market opens are never
 * applied; the policy places, cancels and fills its own entries through the hooks below, and every fill is then
 * managed here exactly as a v4 trade. `version` labels the records and the checkpoint.
 */
export function replayOmega4({
  bars = [], decisions = [], from = null, to = Infinity, settings = OMEGA_DEFAULTS, state = null,
  profileAt = () => null, balanceAt = null, councils = {}, control = [], blackouts = [], grid = null, arms = null,
  eaGate = false, plan = planIntents, trace = null, spread = OMEGA4_SIM.spread, maxSteps = Infinity, entry = null, version = OMEGA4_VERSION
} = {}) {
  // v4 is the market replay (the taker): the live entry_order ("limit" or "council", docs/RFC_OMEGA_LIMIT_ENTRY.md stage 3)
  // never reaches it; the maker side is the limit policy's (`entry`, src/ledger-omega-limit.mjs).
  const S = { ...OMEGA_DEFAULTS, ...(settings && typeof settings === "object" ? settings : {}), enabled: true, live_armed: true, entry_order: "market" };
  const m1 = Array.isArray(bars) && bars.length && finite(bars[0]?.t) ? bars : minuteBars(bars);
  const d5 = aggregate(m1, M5), d15 = aggregate(m1, M15);
  const decs = (Array.isArray(decisions) ? decisions : []).filter((d) => d && finite(d.close_ms)).sort((a, b) => a.close_ms - b.close_ms);
  const start = finite(from) ? from : (m1.length ? m1[0].t + OMEGA4_SIM.warmup_ms : Infinity);
  const ctl = (Array.isArray(control) ? control : []).filter((c) => finite(c?.at_ms)).sort((a, b) => a.at_ms - b.at_ms);
  const spreadPts = Math.round(spread / OMEGA4_SIM.point);

  // The carried state (the checkpoint of the run before: the whole replay state at its next minute).
  const carried = state && typeof state === "object" ? state : {};
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const emitted = (Array.isArray(carried.recent) ? carried.recent : []).filter((x) => typeof x?.id === "string" && finite(x?.ms)).map((x) => ({ id: x.id, ms: x.ms, it: x.it ?? null }));
  const carriedOpens = new Set(emitted.filter((x) => x.id.startsWith("open:")).map((x) => x.id));
  let reentry = carried.reentry && finite(carried.reentry.exit_ms) ? { ...carried.reentry } : null;
  let ownBalance = finite(carried.balance) ? carried.balance : OMEGA4_SIM.start_balance;
  let ownDayMs = finite(carried.day_ms) ? carried.day_ms : null, ownDayStart = finite(carried.day_start) ? carried.day_start : ownBalance;

  const positions = Array.isArray(carried.positions) ? clone(carried.positions) : [];
  const trades = new Map((Array.isArray(carried.trades) ? clone(carried.trades) : []).map((t) => [t.key, t])); // decision key -> trade
  const notes = new Map(Array.isArray(carried.notes) ? clone(carried.notes) : []);  // decision key -> { gate, last_ms }
  const signalCache = new Map();
  let steps = 0, plans = 0, pmCalls = 0, lastMs = null, more = false;
  let i5 = -1, i15 = -1, iDec = -1, iCtl = -1, lo125 = 0;
  const firstK = m1.findIndex((b) => b.t >= start);

  const decisionAt = () => (iDec >= 0 ? decs[iDec] : null);
  const signalOf = (d, now, flags) => {
    if (!d) return null;
    const key = `${d.decision_key}|${flags.kill}|${flags.paused}|${flags.blackout}|${flags.m5key}`;
    let base = signalCache.get(key);
    if (!base) {
      const sig = { ...eaSignalFromDecision({ decision: d, kill: flags.kill, killSource: flags.kill ? "omega" : "", paused: flags.paused, blackout: flags.blackout, blackoutReason: flags.blackoutReason, now }), ...flags.m5, ...managementFields(d, { basis: 0 }), source: "decision_engine" };
      const adapted = grid ? applyGridChoice(sig, { decision: d, choices: grid }) : sig;
      let gated = applyRangeMode(adapted, { regime: d?.context?.regime_1h ?? null });
      // The range strategies' cell gate (H4/D1 trend and the cell's record at that time) is not stored: not traded here.
      if ((gated.side === "BUY" || gated.side === "SELL") && RANGE_GATED_AGENTS.includes(gated.trade_agent)) {
        gated = { ...gated, awaiting_signal_id: gated.signal_id, awaiting_side: gated.side, awaiting_reason: "cell_gate_unreconstructable", signal_id: "", side: "NONE", action: "", entry: 0, stop: 0, tp1: 0 };
      }
      base = arms ? applyArmGate(gated, arms) : gated;
      if (signalCache.size > 64) signalCache.clear();
      signalCache.set(key, base);
    }
    return { ...base, server_ms: now };
  };
  const tradeOf = (p) => trades.get(p.key);
  const priceOut = (p, bid, ask) => (p.side === "BUY" ? bid : ask);
  const rOf = (t, realized) => (t.risk0 > 0 ? r3(realized / t.risk0) : null);

  const closePos = (p, price, reason, now, volume = null) => {
    const t = tradeOf(p), dir = p.side === "BUY" ? 1 : -1;
    const vol = volume == null ? p.volume : Math.min(p.volume, volume);
    const pl = dir * (price - p.open_price) * vol;
    t.realized += pl;
    ownBalance += pl * MONEY_PER_PRICE_LOT;
    const code = reason ?? null;
    t.exits.push({ at: iso(now), code, share: r3(vol / t.volume0) });
    p.volume = r2(p.volume - vol);
    if (volume != null && p.volume >= OMEGA4_SIM.volume_min - 1e-9) { t.partials += 1; return; }
    positions.splice(positions.indexOf(p), 1);
    t.status = "closed"; t.closed_ms = now; t.exit = code; t.r = rOf(t, t.realized);
    if (REENTRY_EXIT_REASONS.includes(code)) reentry = { side: p.side, ticket: p.ticket, exit_price: price, exit_ms: now, entry_conf: finite(p.open_intent?.agent_conf) ? p.open_intent.agent_conf : null };
  };
  const brokerExit = (p, kind) => {
    if (kind === "stop") return isProtected(p) ? "sl_plus" : "stop";
    return Math.abs(Number(p.tp) - Number(p.tp0)) > OMEGA4_SIM.point / 2 ? "trailed_target" : "target";
  };
  const execPos = (p) => ({ ticket: p.ticket, side: p.side, volume: p.volume, open_price: p.open_price, sl: p.sl, tp: p.tp, source: "omega", magic: 920200, intent_id: p.intent_id, opened_ms: p.opened_ms, symbol: "XAUUSD" });
  // An open intent becomes a simulated position and its trade (v4's market fill, or another entry policy's fill).
  const openTrade = ({ key, it, now, issuedMs, mode, agent, equity, profile, noteCodes = [], extra = null }) => {
    const pos = { key, ticket: Math.floor(issuedMs / M1) * 10 + (it.side === "BUY" ? 1 : 2), side: it.side, volume: it.volume, open_price: it.entry, sl: it.sl, tp: it.tp, tp0: it.tp, intent_id: it.id, opened_ms: now, open_intent: { ...it } };
    positions.push(pos);
    if (entry) emitted.push({ id: it.id, ms: now, it });
    const stopDist = Math.abs(it.entry - it.sl);
    const riskMoney = stopDist * it.volume * MONEY_PER_PRICE_LOT;
    trades.set(key, { key, side: it.side, issued_ms: issuedMs, mode, agent, filled_ms: now, volume0: it.volume, risk0: stopDist * it.volume,
      risk_pct: equity > 0 ? r2((riskMoney / equity) * 100) : null, profile: profile ?? null, stop_source: it.stop_source ?? null, status: "open", realized: 0, exits: [], partials: 0, sl_moves: 0, tp_moves: 0, protected_ms: null,
      mfe: 0, mae: 0, pm: [], pm_council: { recorded: 0, fallback: 0 }, entry_notes: noteCodes.filter((c) => ["stop_5m", "adaptive_stop", "min_lot_within_cap", "lot_capped_5m", "lot_capped_open_risk", "lot_capped_daily_budget"].includes(c)), ...(extra ? { extra } : {}) });
    return pos;
  };

  for (let k = firstK < 0 ? m1.length : firstK; k < m1.length; k++) {
    const bar = m1[k], now = bar.t;
    if (now > to) break;
    if (steps >= maxSteps) { more = true; break; }
    steps += 1;
    lastMs = now;
    while (i5 + 1 < d5.length && d5[i5 + 1].close_ms <= now) i5 += 1;
    while (i15 + 1 < d15.length && d15[i15 + 1].close_ms <= now) i15 += 1;
    while (iDec + 1 < decs.length && decs[iDec + 1].decided_ms <= now) iDec += 1;
    while (iCtl + 1 < ctl.length && ctl[iCtl + 1].at_ms <= now) iCtl += 1;
    while (lo125 < k && m1[lo125].t < now - 125 * M1) lo125 += 1;
    // The broker day: the synthetic balance's day start (only without a live account's balance).
    const day = brokerDayStart(now);
    if (ownDayMs !== day) { ownDayMs = day; ownDayStart = ownBalance; }

    const bid0 = r2(bar.o), ask0 = r2(bar.o + spread);
    // A gap at the open: the broker's stop or target is hit at the open price.
    for (const p of positions.slice()) {
      const px = priceOut(p, bid0, ask0), dir = p.side === "BUY" ? 1 : -1;
      if (finite(p.sl) && p.sl > 0 && dir * (px - p.sl) <= 0) closePos(p, px, brokerExit(p, "stop"), now);
      else if (finite(p.tp) && p.tp > 0 && dir * (px - p.tp) >= 0) closePos(p, px, brokerExit(p, "target"), now);
    }

    const d = decisionAt();
    const mode = iCtl >= 0 ? ctl[iCtl].mode : "active";
    const blackout = blackouts.find((b) => now >= b.from_ms && now <= b.to_ms) ?? null;
    // The broker's 5m lane as Omega reads it (fresh for 6 minutes): the structure of the last closed 5m bars. The
    // Prophet confirmations on those bars are not stored, so m5_ready is false (no opposite_5m, no broker trigger).
    const last5 = i5 >= 0 ? d5[i5] : null;
    let m5 = {}, m5key = "none";
    if (last5 && now - last5.close_ms <= 6 * M1 && i5 >= 14) {
      const st = structureOf(d5.slice(i5 - 14, i5 + 1).map((b) => ({ high: b.h, low: b.l, close: b.c })));
      if (st) { m5 = { m5_source: "broker", m5_close_ms: last5.close_ms, m5_ready: false, m5_buy: false, m5_sell: false, m5_swing_high: st.swing_high, m5_swing_low: st.swing_low, m5_atr: st.atr }; m5key = String(last5.close_ms); }
    }
    const signal = signalOf(d, now, { kill: mode === "killed", paused: mode === "paused", blackout: Boolean(blackout), blackoutReason: blackout?.reason ?? null, m5, m5key });
    const entryKey = signal && (signal.side === "BUY" || signal.side === "SELL") ? signal.signal_id : signal?.awaiting_signal_id || null;
    const entryLive = signal && (signal.side === "BUY" || signal.side === "SELL") && now < signal.expires_ms && now - (finite(signal.decided_ms) ? signal.decided_ms : signal.issued_ms) <= S.max_signal_age_ms;
    // A decision held before the planner (its entry trigger, the arm, range mode, the cell gate) says why.
    if (entryKey && signal?.side === "NONE" && d && now < d.close_ms + M15 && !trades.has(entryKey)) notes.set(entryKey, { gate: awaitingGate(signal.awaiting_reason), last_ms: now });
    // Flat and no entry window open: nothing in planIntents can act (it would only open), so the minute is skipped,
    // unless another entry policy still has an order resting (its cancels and its fill are checked; nothing to plan).
    const restingOnly = !positions.length && !entryLive;
    if (restingOnly && !entry?.busy()) continue;

    // The M15 ATR(14) the terminal reports (its forming bar included), from the 1m bars.
    let atrValue = null;
    {
      const fT = Math.floor(now / M15) * M15;
      let fo = bar.o, fh = bar.o, fl = bar.o;
      for (let j = k - 1; j >= 0 && m1[j].t >= fT; j--) { fo = m1[j].o; fh = Math.max(fh, m1[j].h); fl = Math.min(fl, m1[j].l); }
      const series = [];
      for (let j = Math.max(0, i15 - 14); j <= i15; j++) series.push(d15[j]);
      series.push({ o: fo, h: fh, l: fl, c: bar.o });
      const tr = [];
      for (let j = 1; j < series.length; j++) { const b = series[j], pc = series[j - 1].c; tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc))); }
      const last14 = tr.slice(-14);
      if (last14.length === 14) atrValue = r2(last14.reduce((a, x) => a + x, 0) / 14);
    }
    const sym = { name: "XAUUSD", currency_profit: "USD", contract_size: OMEGA4_SIM.contract_size, digits: 2, point: OMEGA4_SIM.point, tick_size: OMEGA4_SIM.tick_size, tick_value: OMEGA4_SIM.tick_value,
      volume_min: OMEGA4_SIM.volume_min, volume_step: OMEGA4_SIM.volume_step, volume_max: OMEGA4_SIM.volume_max, stops_level_points: 0, bid: bid0, ask: ask0, spread_points: spreadPts,
      atr_value: atrValue, atr_points: atrValue != null ? Math.round(atrValue / OMEGA4_SIM.point) : null };
    // The synthetic executor: the account at this minute's open (its open positions as they are when it is built) and
    // the symbol it reports (an entry policy's probe may show another price; the equity is always at the real one).
    const executorFor = (symbol) => {
      const floating = positions.reduce((a, p) => a + (p.side === "BUY" ? 1 : -1) * (priceOut(p, bid0, ask0) - p.open_price) * p.volume * MONEY_PER_PRICE_LOT, 0);
      const liveBalance = typeof balanceAt === "function" ? balanceAt(now) : null;
      const balance = finite(liveBalance) ? liveBalance : r2(ownBalance);
      const dayStart = typeof balanceAt === "function" && finite(balanceAt(day)) ? balanceAt(day) : r2(ownDayStart);
      return {
        connected: true, received_ms: now, server: "ledger-replay",
        account: { trade_mode: "real", currency: "USD", balance, equity: r2(balance + floating), day_start_balance: dayStart, money: { problem: null } },
        symbol, positions: positions.map(execPos), orders: [], executor: { version: OMEGA4_SIM.executor_version, local_management: false }
      };
    };
    const executor = executorFor(sym);
    const profile = profileAt(now);
    const account = profile ? { profile, spec_status: "validated" } : null;
    // Another entry policy's resting order: its deterministic cancels at the minute's open.
    if (entry) entry.atOpen({ now, decision: d, decisions: decs, mode, blackout, executor, profile, settings: S });
    if (!restingOnly) {
      // The Position Manager, once per 5m bar (the live cron, about 2.5 minutes past the 5m close).
      const pmActions = [];
      if (positions.length && now - Math.floor(now / M5) * M5 === OMEGA4_SIM.pm_offset_ms && d) {
        const pmBar = Math.floor(now / M5);
        const prev = iDec > 0 ? decs[iDec - 1] : null;
        const decision = { ...d, quorum_prev: prev && d.close_ms - prev.close_ms === M15 ? prev.quorum ?? null : null };
        const levels = brokerLevels(signal);
        for (const p of positions) {
          const text = councils[`${p.intent_id}|${pmBar}`] ?? null;
          const council = parseCouncil(text);
          const f = positionFacts({ position: execPos(p), sym, openIntent: p.open_intent, levels, decision, ladder: S.tp_ladder === true, signal });
          const a = positionAction(f, council);
          pmCalls += 1;
          const t = tradeOf(p);
          t.pm_council[council ? "recorded" : "fallback"] += 1;
          if (["close", "sl", "tp"].includes(a.action)) {
            pmActions.push({ id: `pm:${p.ticket}:${pmBar}`, ticket: p.ticket, action: a.action, rule: a.rule, sl: a.sl ?? null, tp: a.tp ?? null, at_ms: now });
            t.pm.push({ at: iso(now), rule: a.rule, council: council ? "recorded" : "fallback" });
          }
        }
      }

      const agents = {}, positionMeta = {};
      for (const p of positions) {
        if (typeof p.open_intent?.strategy === "string" && p.open_intent.strategy) agents[p.intent_id] = p.open_intent.strategy;
        positionMeta[p.intent_id] = { mode: typeof p.open_intent?.mode === "string" ? p.open_intent.mode : null, r_dist: finite(p.open_intent?.r_dist) ? p.open_intent.r_dist : null, ...(p.open_intent?.probation === true ? { probation: true } : {}) };
      }
      const recentIntentIds = emitted.filter((x) => x.ms > now - OMEGA4_SIM.recent_keep_ms).map((x) => x.id);
      const stops = positions.length ? commandedStops(emitted.filter((x) => x.it && x.ms > now - STOP_COMMAND_MS && (x.it.kind === "modify_sl" || x.it.kind === "modify_sltp")).map((x) => ({ payload: x.it, status: "done", result: { ok: true } }))) : {};
      const recentBars = positions.length ? m1.slice(lo125, k) : null;
      // The ladder's closed candles as ladderCandles builds them (lastClosedCandle over the last 125 1m bars); {} when flat, as live.
      const candles = recentBars ? { M5: lastClosedCandle(recentBars, 5, now), M15: lastClosedCandle(recentBars, 15, now), H1: lastClosedCandle(recentBars, 60, now) } : {};
      const re = reentry && now - reentry.exit_ms <= REENTRY_LOOKBACK_MS ? reentry : null;
      const input = { signal, control: { mode, reason: "", actor: "", at: iCtl >= 0 ? iso(ctl[iCtl].at_ms) : null }, settings: S, executor, now, engineEnabled: true, recentIntentIds, agents, pmActions, account, eaGate, reentry: re, positionMeta, candles, stops };
      const out = plan(input);
      plans += 1;
      if (trace) trace.push({ now, input, output: out });

      let opened = false;
      for (const it of out.intents) {
        // Another entry policy never enters at market: its entries come only from its own fills (entry.inMinute).
        if (entry && it.kind === "open") continue;
        emitted.push({ id: it.id, ms: now, it });
        const p = it.ticket != null ? positions.find((x) => x.ticket === it.ticket) : null;
        if (it.kind === "open") {
          const key = signal.signal_id;
          if (!key || trades.has(key)) continue;
          openTrade({ key, it, now, issuedMs: signal.issued_ms, mode: it.mode ?? signal.trading_mode ?? null, agent: it.strategy ?? (signal.trade_agent || null), equity: executor.account.equity, profile, noteCodes: out.notes.map((n) => n.code) });
          opened = true;
        } else if (it.kind === "close_all") {
          for (const q of positions.slice()) closePos(q, priceOut(q, bid0, ask0), it.reason ?? "kill", now);
        } else if (!p) {
          continue;
        } else if (it.kind === "close") {
          closePos(p, priceOut(p, bid0, ask0), it.reason ?? "close", now);
        } else if (it.kind === "partial_close" && finite(it.volume) && it.volume > 0) {
          closePos(p, priceOut(p, bid0, ask0), it.reason ?? "partial", now, it.volume);
        } else if (it.kind === "modify_sl" || it.kind === "modify_tp" || it.kind === "modify_sltp") {
          const t = tradeOf(p);
          if ((it.kind === "modify_sl" || it.kind === "modify_sltp") && finite(it.sl) && it.sl > 0 && it.sl !== p.sl) { p.sl = it.sl; t.sl_moves += 1; if (t.protected_ms == null && isProtected(p)) t.protected_ms = now; }
          if ((it.kind === "modify_tp" || it.kind === "modify_sltp") && finite(it.tp) && it.tp > 0 && it.tp !== p.tp) { p.tp = it.tp; t.tp_moves += 1; }
        }
      }
      if (!entry && !opened && entryKey && entryLive && !trades.has(entryKey)) notes.set(entryKey, { gate: out.notes.at(-1)?.code ?? "no_note", last_ms: now });
      // Another entry policy places its own order on this signal (its gates are planIntents' own, see entry.afterPlan).
      if (entry) entry.afterPlan({ now, signal, decision: d, entryKey, entryLive, input, plan, executorFor, sym, bid0, ask0, spread, notes, trades, recentIntentIds: () => emitted.filter((x) => x.ms > now - OMEGA4_SIM.recent_keep_ms).map((x) => x.id) });
    }

    // Inside the minute: the broker's stop first, then the target; a SELL closes at the ask.
    for (const p of positions.slice()) {
      const t = tradeOf(p), dir = p.side === "BUY" ? 1 : -1, sd = Math.abs(p.open_intent.entry - p.open_intent.sl);
      const adverse = p.side === "BUY" ? bar.l : bar.h + spread, favorable = p.side === "BUY" ? bar.h : bar.l + spread;
      if (sd > 0) { t.mfe = Math.max(t.mfe, (dir * (favorable - p.open_price)) / sd); t.mae = Math.min(t.mae, (dir * (adverse - p.open_price)) / sd); }
      if (finite(p.sl) && p.sl > 0 && dir * (adverse - p.sl) <= 0) closePos(p, p.sl, brokerExit(p, "stop"), now + M1 - 1);
      else if (finite(p.tp) && p.tp > 0 && dir * (favorable - p.tp) >= 0) closePos(p, p.tp, brokerExit(p, "target"), now + M1 - 1);
    }
    // Another entry policy's order filled inside this minute: opened as a v4 trade, from the next minute managed as one.
    if (entry) entry.inMinute({ now, bar, spread, fill: (f) => {
      const p = openTrade({ ...f, now });
      // Inside the fill's own minute the order of the prices is unknown: the stop counts (conservative), the target waits.
      const adverse = p.side === "BUY" ? bar.l : bar.h + spread, dir = p.side === "BUY" ? 1 : -1;
      if (finite(p.sl) && p.sl > 0 && dir * (adverse - p.sl) <= 0) closePos(p, p.sl, brokerExit(p, "stop"), now + M1 - 1);
      return p;
    } });
  }

  // The records: each BUY/SELL decision whose window falls in the span.
  const records = {};
  const lastBar = lastMs != null ? m1.find((b) => b.t === lastMs) : null;
  for (const t of trades.values()) {
    const open = positions.find((p) => p.key === t.key);
    let openR = null;
    if (open && lastBar) { const px = open.side === "BUY" ? lastBar.c : lastBar.c + spread; openR = rOf(t, t.realized + (open.side === "BUY" ? 1 : -1) * (px - open.open_price) * open.volume); }
    records[t.key] = toRecord(t, { openR, version });
  }
  const stopAt = lastMs ?? start;
  for (const d of decs) {
    if (d.stance !== "BUY" && d.stance !== "SELL") continue;
    if (records[d.decision_key] || carriedOpens.has(`open:${d.close_ms}:${d.stance === "BUY" ? "B" : "S"}`)) continue;
    const windowEnd = Math.min(d.close_ms + M15, d.decided_ms + S.max_signal_age_ms);
    if (windowEnd < start || d.decided_ms > stopAt) continue;
    const n = notes.get(d.decision_key);
    const pending = stopAt < windowEnd;
    records[d.decision_key] = {
      decision_key: d.decision_key, side: d.stance, issued_ms: d.close_ms, trading_mode: TRADING_MODES.includes(d.trading_mode) ? d.trading_mode : null, agent: typeof d.trade?.agent === "string" ? d.trade.agent : null,
      omega4_status: pending ? "pending" : "skipped", omega4_gate: pending ? null : n?.gate ?? (d.trade ? "no_bars" : "no_plan"),
      omega4_filled_at: null, omega4_closed_at: null, omega4_exit: null, r_omega4: null, omega4_size: null, omega4_json: JSON.stringify({ version, gate: n?.gate ?? null })
    };
  }
  // The checkpoint: the state at the next minute. Intent ids older than 2 hours only matter for a ticket still open (its
  // partial count); the stops commanded in the last minutes keep their intent (commandedStops).
  const nextMs = lastMs != null ? lastMs + M1 : (finite(carried.at_ms) ? carried.at_ms : start);
  const open = new Set(positions.map((p) => p.ticket));
  const recent = emitted.filter((x) => x.ms > nextMs - 2 * 3600_000 || [...open].some((t) => x.id.includes(`:${t}:`)))
    .map((x) => ({ id: x.id, ms: x.ms, ...(x.it && (x.it.kind === "modify_sl" || x.it.kind === "modify_sltp") && x.ms > nextMs - STOP_COMMAND_MS - M1 ? { it: x.it } : {}) }));
  const checkpoint = {
    version, at_ms: nextMs, recent, reentry: reentry && nextMs - reentry.exit_ms <= REENTRY_LOOKBACK_MS ? reentry : null,
    balance: r2(ownBalance), day_ms: ownDayMs, day_start: r2(ownDayStart),
    positions: clone(positions), trades: clone([...trades.values()].filter((t) => t.status === "open")), notes: [...notes].filter(([, n]) => n.last_ms > nextMs - 3600_000),
    ...(entry ? { entry: entry.state() } : {})
  };
  return { records, checkpoint, steps, plans, pm_calls: pmCalls, decisions: decs.length, last_ms: lastMs, more, open_positions: positions.length };
}

function toRecord(t, { openR = null, version = OMEGA4_VERSION } = {}) {
  const json = {
    version, entry_ms: t.filled_ms, profile: t.profile, risk_pct: t.risk_pct, stop_source: t.stop_source, entry_notes: t.entry_notes,
    protected_at: t.protected_ms != null ? iso(t.protected_ms) : null, sl_moves: t.sl_moves, tp_moves: t.tp_moves, partials: t.partials,
    exits: t.exits, pm: t.pm.slice(-20), pm_council: t.pm_council, mfe_r: r3(t.mfe), mae_r: r3(t.mae), open_r: openR,
    ...(t.extra ? { entry_policy: t.extra } : {})
  };
  return {
    decision_key: t.key, side: t.side, issued_ms: t.issued_ms, trading_mode: TRADING_MODES.includes(t.mode) ? t.mode : null, agent: t.agent,
    omega4_status: t.status, omega4_gate: null, omega4_filled_at: iso(t.filled_ms), omega4_closed_at: t.status === "closed" ? iso(t.closed_ms) : null,
    omega4_exit: t.status === "closed" ? t.exit : null, r_omega4: t.status === "closed" ? t.r : null,
    // The size: the risk the lot carried at its stop as a share of the profile's target risk is in omega4_json (risk_pct);
    // the ledger counts each trade in its own R (1), the unit of the live parity.
    omega4_size: 1, omega4_json: JSON.stringify(json)
  };
}

// ---------------------------------------------------------------------------
// The engine's era: a parity window per behaviour of the code that decides Omega's trades and per set of its switches.

/**
 * The live functions and constants that decide Omega's entries and management (the ones v4 replays, and the live
 * orchestration around them: the signal's assembly, the Position Manager's run, the sync's inputs). Their source text
 * (Function.prototype.toString in node, the repository's own text) and values make ENGINE_CODE_HASH.
 */
export const ENGINE_CODE = Object.freeze({
  "omega-engine": [omegaEngine, ["planIntents", "manageIntents", "keyLevelPlan", "ladderPlan", "ladderRungs", "ladderStep", "ladderTp1Locked", "partialShare", "strategyExits", "positionManagerIntents", "reentryGate", "isProtected", "openRiskAtStops", "commandedStops", "withCommandedStop", "brokerKeyLevels", "powerBand", "floorToStep", "isRolloverQuarantine", "isOmegaOwned", "openId", "closeId", "pendingRiskAtStops", "pendingDeleteReason", "omegaPendingOrders", "pendingAsPosition", "settingsFrom", "OMEGA_DEFAULTS", "POWER_STRONG", "POWER_WEAK", "POWER_FRESH_MS", "LEAN_BAND", "DEFAULT_POSITION_AGENT", "LADDER_CONFIRM_TF", "REENTRY_EXIT_REASONS", "GOLD_PIP", "STOP_COMMAND_MS", "EXECUTOR_MAX_AGE_MS", "LIMIT_ENTRY_AVAILABLE",
    // Live limit entries (docs/RFC_OMEGA_LIMIT_ENTRY.md stage 3): the placement, the council's actions, the fill's re-check.
    "limitPlacement", "limitActionIntents", "fillGuard", "deleteOrderIntent", "pendingWithoutStop", "PROFILE_RANK", "ENTRY_ORDERS", "LIMIT_EA_MIN_VERSION", "PLATFORM_MAX_OPEN", "ENTRY_COUNCIL_WAIT_MS",
    // ADR-0020 Amendment 8 (2026-11-20): Omega's check of the council's loosening and target moves, and the loosenings sent.
    "a8Intent", "loosenRecords"]],
  "position-manager": [positionManager, ["positionFacts", "positionAction", "pmBand", "brokerLevels", "latestDecisions", "runPositionManager", "cleanCouncil", "PM_R_BAND", "THRESHOLD_PIPS", "PIP", "SHARE_DROP",
    "ruleAction", "a8Action", "loosenHold", "loosenPlan", "targetPlan", "atrExpanded", "loosenFacts", "loosenInputs", "cleanCouncilA8", "LOOSEN_REASONS", "TP_NEARER_REASONS", "TP_FURTHER_REASONS", "LOOSEN_LOOKBACK_MS", "liquidityOf", "positionCouncilMessages"]],
  "position-actions": [positionActions, ["pendingPositionActions", "ACTION_TTL_MS"]],
  "ea-signal": [eaSignalModule, ["eaSignal", "eaSignalFrom", "eaSignalFromDecision", "entryTriggerFor", "managementFields", "applyArmGate"]],
  "omega-broker": [omegaBroker, ["lastClosedCandle", "ladderCandles", "lastWeakeningExit", "positionMeta", "positionAgents", "limitInputs", "pmLoosenInputs"]],
  "omega-limit-knobs": [omegaLimitKnobs, ["limitKnobs", "LIMIT_KNOB_START", "LIMIT_KNOB_BOUNDS"]],
  "pm-loosen-knobs": [pmLoosenKnobs, ["pmLoosenKnobs", "PM_LOOSEN_KNOB_START", "PM_LOOSEN_KNOB_BOUNDS"]],
  "limit-council": [limitCouncil, ["entryFacts", "entryChoice", "pendingFacts", "pendingAction", "runLimitCouncil", "ENTRY_REASONS", "PULLBACK_MIN_R", "ENTRY_SHARE_DROP", "LIMIT_ACTION_TTL_MS"]],
  "account-spec": [accountSpec, ["effectiveLimits", "PROFILES", "versionAtLeast", "EXECUTOR_ENTRY_MIN_VERSION"]],
  "gold-symbol": [goldSymbol, ["goldSymbolCheck", "goldCheckOf", "goldPriceProblem", "GOLD_PRICE_TOLERANCE", "GOLD_CONTRACT_SIZE_MIN", "GOLD_CONTRACT_SIZE_MAX"]],
  "grid-adapt": [gridAdapt, ["applyGridChoice", "cellLevels"]],
  "htf-cells": [htfCells, ["applyRangeMode", "applyCellGate", "RANGE_GATED_AGENTS", "PROBATION"]],
  "agent-confidence": [agentConfidence, ["confidenceTrend", "flatConfidences", "parseConfidences", "CONFIDENCE_STABLE_BAND"]],
  "broker-trigger": [brokerTrigger, ["brokerTriggerFields", "readBrokerTrigger", "BROKER_TRIGGER_FRESH_MS"]],
  // The Positioning & Liquidity analyst's lens B (docs/RFC_POSITIONING_LIQUIDITY.md §4.4-§6): the signal's liquidity
  // fields and levels, the spread-spike entry gate and the modification deferral planIntents applies.
  "liquidity-lens": [liquidityLens, ["liquidityFields", "signalLiquidityLevels", "liveSpreadRatio", "liveSpreadSpike", "deferModifications", "nyHourOfWeek", "DEFERRABLE_KINDS", "LIQUIDITY_MODIFY_DEFER_MAX_MS", "LIQUIDITY_STATE_FRESH_MS", "SWEEP_WITH_MAX_AGE_MIN"]]
});

/** The text ENGINE_CODE_HASH is taken of: each name with its function's source or its value, module by module. */
export function engineCodeSource() {
  const parts = [];
  for (const [file, [mod, names]] of Object.entries(ENGINE_CODE)) {
    for (const name of names) {
      const v = mod[name];
      parts.push(`${file}.${name}=${typeof v === "function" ? v.toString() : JSON.stringify(v)}`);
    }
  }
  return parts.join("\n");
}

/** SHA-256 (hex) of a text. */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The hash of the engine's code (engineCodeSource) as it is in the repository. It is taken in node, not in the
 * Worker: the bundler strips comments and renames identifiers (`finite` becomes `finite8` when another module has
 * one), so a hash taken inside the bundle would move with unrelated code. test/ledger-omega-v4.test.mjs recomputes
 * it from the source and fails, printing the new value, until a change to any function above updates it here. It is
 * informational: the era records it, and a new code hash with the same behaviour carries the era over (nextEra).
 */
export const ENGINE_CODE_HASH = "42f5f5120c666fa556a2215c0b1dcbf70f3b3be7e45468c17c44f6559c968503";
/**
 * The engine's behaviour fingerprint: the SHA-256 of its outputs over the committed fixtures with every switch at its
 * default (OMEGA_DEFAULTS), as test/fixtures/engine-behaviour.mjs engineBehaviourSource writes them:
 *   planIntents over the market-path fixtures (test/fixtures/omega-market-path.mjs, the hand inputs and v4's replay
 *   traces and records); positionFacts, positionAction, the council's messages, schema and cleaning,
 *   positionManagerIntents and planIntents with Position Manager actions over the A8 switch-off fixtures
 *   (test/fixtures/pm-a8-off.mjs); replayOmega4's traces and records over the v4 replay fixtures
 *   (test/fixtures/omega-v4-replay.mjs); planIntents over the hand inputs with the liquidity lens on (its default) and
 *   the live spread at 3x and 1x the hour's norm (docs/RFC_POSITIONING_LIQUIDITY.md: the gate and the deferral; this
 *   group moved the hash in 2026-11-20's lens PR, a new era at its deploy). Only tests build the text, so the Worker
 *   bundle carries the value alone.
 * test/ledger-omega-v4.test.mjs V14 recomputes it and fails, printing the new value, when the behaviour changes. A new
 * value starts a new parity era at the deploy; a source change that leaves it as it is carries the era over.
 */
export const ENGINE_BEHAVIOUR_HASH = "b58968b207cfdeafa4e1ce5ad4363370c9ec1e6aa50ae2d23f3bbe3afed5c09f";
/**
 * The behaviour switches of the stored Omega settings (omega_settings id 1) whose value off their default
 * (OMEGA_DEFAULTS) changes what the live engine does: the era's switch signature (eraSwitches). A switch that turns
 * on, changes or goes back to its default starts a new era at the settings' updated_ms. Add each new one here; the
 * next one will be wait_bias_entry (docs/RFC_WAIT_BIAS_ENTRY.md).
 */
// positioning_enabled and liquidity_enabled (docs/RFC_POSITIONING_LIQUIDITY.md, owner 2026-11-20) are on by default: the
// signature compares each switch with its default (OMEGA_DEFAULTS), so at their defaults they add nothing, and the
// owner turning a lens off writes "liquidity_enabled=false" and starts a new era at that time.
export const ERA_SWITCHES = Object.freeze(["entry_order", "pm_loosen_enabled", "positioning_enabled", "liquidity_enabled"]);
/**
 * Engine code hashes from before the behaviour fingerprint whose switch-off behaviour is proven identical to the
 * first ENGINE_BEHAVIOUR_HASH: 7497aa51 (#502, limit entries stage 3; test/omega-limit-stage3.test.mjs S12 proves the
 * market path byte for byte against stage 2) and bbff5fad (ADR-0020 Amendment 8; test/position-manager-a8.test.mjs
 * A8-2 proves the Position Manager byte for byte against ad21475, whose engine code is stage 3's). A stored era of the
 * old shape ({ hash, since_ms }) with one of these is adopted with its since_ms; any other starts a new era.
 */
/**
 * The behaviour the adoptable code hashes were proven identical to: the first ENGINE_BEHAVIOUR_HASH (#504). An old-shape
 * era is adopted as this behaviour, so a later behaviour (the Positioning & Liquidity analyst's lens B, 2026-11-20)
 * starts its own era at its deploy instead of inheriting the old era's since.
 */
export const ERA_ADOPTABLE_BEHAVIOUR_HASH = "df71fd7ca2bcc577816e0c6007e92165d004634edf23350d23369a2b649cfb88";
export const ERA_ADOPTABLE_CODE_HASHES = Object.freeze([
  "7497aa5177163fa88c581f1f8f90edc5094b99aa8c66a161eb24aaa8a26a9104",
  "bbff5fadea876d05598713150251ea791989a4b8b5f65133f350873068ec9649"
]);
/** The first era: from #491 (2026-11-19 17:48 UTC), the Position Manager v4 replays (owner window from 12:00, orchestrator review of #498). */
export const ERA_SEED_MS = Date.parse("2026-11-19T17:48:00Z");
export const OMEGA4_ERA_KEY = "ledger:omega4:era:v1";
/** Parity passes or fails only on at least this many live trades opened in the current era ("insufficient" below it). */
export const PARITY_MIN_TRADES = 20;

/**
 * Pure: the switch signature of Omega's settings: each ERA_SWITCHES switch off its default, sorted, as "name" for a
 * boolean switched on and "name=value" otherwise (e.g. ["entry_order=council", "pm_loosen_enabled"]). [] at defaults.
 */
export function eraSwitches(settings = {}) {
  const s = settings && typeof settings === "object" ? settings : {};
  const out = [];
  for (const name of ERA_SWITCHES) {
    const v = s[name] === undefined ? OMEGA_DEFAULTS[name] : s[name];
    if (JSON.stringify(v) === JSON.stringify(OMEGA_DEFAULTS[name])) continue;
    out.push(v === true ? name : `${name}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return out.sort();
}

const sameList = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
/** Pure: why the switch signature moved ("switch on: entry_order=council", "switch off: pm_loosen_enabled"). */
export function switchReason(before = [], after = []) {
  const on = after.filter((x) => !before.includes(x)), off = before.filter((x) => !after.includes(x));
  return [...on.map((x) => `switch on: ${x}`), ...off.map((x) => `switch off: ${x}`)].join("; ");
}
/** The time a new era starts: `at` when it is known, not in the future and not before the era it replaces, else now. */
const eraStart = (at, sinceMs, now) => (finite(at) && at <= now && at >= sinceMs ? at : now);

/**
 * Pure: the era after this run. The era's identity is the behaviour hash and the switch signature:
 *   no stored era                   the seed (ERA_SEED_MS, reason "seed");
 *   an era of the old shape         ({ hash, since_ms }, before the behaviour hash) adopted with its since_ms when its
 *                                   code hash is in ERA_ADOPTABLE_CODE_HASHES (code_hash from its hash, the switches
 *                                   at their defaults), else treated as another behaviour; then as below;
 *   another behaviour hash          a new era from the Worker's deploy time (`deployedMs`, if not in the future and not
 *                                   before the era it replaces), else from now (reason "behaviour change");
 *   another switch signature        a new era from the settings' updated_ms (`switchesMs`, the same bounds), else from
 *                                   now (reason "switch on: …" or "switch off: …"); both at once: the later start;
 *   the same behaviour and switches with another code hash: the era carried over (same since_ms, code_hash recorded,
 *                                   the carry kept in `carried`, the last 10).
 * `switches` null (the settings could not be read) keeps the stored signature. The era replaced goes to `previous`
 * (the last 10). Returns { era, changed, events }: the log lines of what moved ("era carried (behaviour identical)").
 */
export function nextEra(stored, { behaviour = ENGINE_BEHAVIOUR_HASH, code = ENGINE_CODE_HASH, switches = null, switchesMs = null, now = Date.now(), deployedMs = null, commit = null } = {}) {
  const sw = Array.isArray(switches) ? [...switches].sort() : null;
  const oldShape = stored && typeof stored.behaviour_hash !== "string" && typeof stored.hash === "string";
  if (!stored || !finite(stored.since_ms) || (!oldShape && typeof stored.behaviour_hash !== "string")) {
    return { era: { behaviour_hash: behaviour, code_hash: code, switches: sw ?? [], since_ms: ERA_SEED_MS, commit: commit ?? null, seeded: true, reason: "seed", previous: [], carried: [] }, changed: true, events: ["era seeded"] };
  }
  const events = [];
  let cur = stored;
  if (oldShape) {
    const adopt = ERA_ADOPTABLE_CODE_HASHES.includes(stored.hash);
    cur = {
      behaviour_hash: adopt ? ERA_ADOPTABLE_BEHAVIOUR_HASH : null, code_hash: stored.hash, switches: [], since_ms: stored.since_ms, commit: stored.commit ?? null,
      seeded: stored.seeded === true, reason: stored.seeded === true ? "seed" : "code change", adopted_ms: now,
      previous: Array.isArray(stored.previous) ? stored.previous : [], carried: []
    };
    events.push(adopt ? "era adopted (behaviour identical, since kept)" : "era of unknown behaviour (not adopted)");
  }
  const swNow = sw ?? (Array.isArray(cur.switches) ? cur.switches : []);
  const behaviourMoved = cur.behaviour_hash !== behaviour, switchesMoved = !sameList(cur.switches, swNow);
  if (!behaviourMoved && !switchesMoved) {
    if (cur.code_hash === code) return { era: cur, changed: oldShape, events };
    const carried = [{ code_hash: code, from: cur.code_hash ?? null, at_ms: now, commit: commit ?? null }, ...(Array.isArray(cur.carried) ? cur.carried : [])].slice(0, 10);
    return { era: { ...cur, code_hash: code, carried }, changed: true, events: [...events, "era carried (behaviour identical)"] };
  }
  const starts = [], reasons = [];
  if (behaviourMoved) { starts.push(eraStart(deployedMs, cur.since_ms, now)); reasons.push("behaviour change"); }
  if (switchesMoved) { starts.push(eraStart(switchesMs, cur.since_ms, now)); reasons.push(switchReason(cur.switches ?? [], swNow)); }
  const since = Math.max(...starts), reason = reasons.join("; ");
  const before = { behaviour_hash: cur.behaviour_hash ?? null, code_hash: cur.code_hash ?? null, switches: cur.switches ?? [], reason: cur.reason ?? null, since_ms: cur.since_ms, until_ms: since, commit: cur.commit ?? null };
  return {
    era: { behaviour_hash: behaviour, code_hash: code, switches: swNow, since_ms: since, commit: commit ?? null, seeded: false, reason, previous: [before, ...(Array.isArray(cur.previous) ? cur.previous : [])].slice(0, 10), carried: [] },
    changed: true, events: [...events, `new era: ${reason}`]
  };
}

/** The switch signature and its time from the stored Omega settings (omega_settings id 1), or null when unreadable. */
export async function readEraSwitches(db) {
  if (!db?.prepare) return null;
  try {
    const row = await db.prepare("SELECT settings, updated_ms FROM omega_settings WHERE id = 1").first();
    const settings = row?.settings ? JSON.parse(row.settings) : {};
    const at = Number(row?.updated_ms);
    return { switches: eraSwitches({ ...OMEGA_DEFAULTS, ...settings }), updated_ms: row?.updated_ms != null && finite(at) ? at : null };
  } catch { return null; }
}

/**
 * The current era from KV (nextEra on this Worker's behaviour hash, its deploy time and the stored settings' switches
 * from env.DB), written only when it moved. Returns { era, changed, events }. Never throws.
 */
export async function eraStep(env, { now = Date.now() } = {}) {
  let stored = null;
  try { stored = JSON.parse((await env?.SIGNAL_CACHE?.get?.(OMEGA4_ERA_KEY)) || "null"); } catch { stored = null; }
  const deployed = Date.parse(String(env?.DEPLOYED_AT ?? env?.CF_VERSION_METADATA?.timestamp ?? ""));
  const commit = String(env?.DEPLOY_COMMIT ?? env?.CF_VERSION_METADATA?.tag ?? "").slice(0, 12) || null;
  const sw = await readEraSwitches(env?.DB);
  const r = nextEra(stored, { now, deployedMs: finite(deployed) ? deployed : null, commit, switches: sw?.switches ?? null, switchesMs: sw?.updated_ms ?? null });
  if (r.changed) { try { await env?.SIGNAL_CACHE?.put?.(OMEGA4_ERA_KEY, JSON.stringify(r.era)); } catch { /* next hour */ } }
  return r;
}

/** The current era (eraStep's). Never throws. */
export async function currentEra(env, { now = Date.now() } = {}) {
  return (await eraStep(env, { now })).era;
}

// ---------------------------------------------------------------------------
// The parity check against Omega's real trades on the live USD account.

/** The live account's trades are compared from here (owner 2026-11-20: the Omega that runs live now). */
export const PARITY_SINCE_MS = Date.parse("2026-11-19T12:00:00Z");
export const PARITY_PASS = Object.freeze({ same_exit_min: 0.9, mean_abs_dr_max: 0.1 });
/**
 * The live Position Manager has run the code v4 replays since #491 merged (2026-11-19 17:48 UTC; #488 at 16:33 stopped
 * the cut on a WAIT alone, #490 and #491 brought TP2 through the council and tp2_breakeven): the seed of the eras.
 */
export const PARITY_CURRENT_CODE_MS = ERA_SEED_MS;
/** Gold in USD: a tick of 0.01 is worth USD 1 a lot (contract 100 oz), so USD 100 a lot per 1.00 of price. */
export const LIVE_TICK_VALUE_PER_001 = 1;
/**
 * How a live close is read as a v4 exit code. The deal's own reason first (MT5 DEAL_REASON); a close by the EA
 * ("expert") is Omega's close intent, read by its reason. v4's trailed_target counts as target (both are the broker's
 * take-profit; v4 only says it was moved).
 */
export const LIVE_EXIT_MAP = Object.freeze({
  deal: Object.freeze({ tp: "target", sl: "stop_or_sl_plus", so: "stop_out", client: "manual", mobile: "manual", web: "manual" }),
  intent: Object.freeze({
    pm_take_profit_weakening: "pm_take_profit_weakening", pm_cut_loss: "pm_cut_loss", opposite: "opposite", mean_reversal: "mean_reversal",
    lean_flip: "lean_flip", confidence_drop: "confidence_drop", power_reversal: "power_reversal", opposite_5m: "opposite_5m", kill: "kill", manual: "manual"
  }),
  v4: Object.freeze({ trailed_target: "target" })
});
export const exitClass = (code) => (code == null ? null : LIVE_EXIT_MAP.v4[code] ?? code);

/** Pure: a live trade's exit code from its last deal ({ reason, side, entry_price, stop_loss }) and its close intent's reason. */
export function liveExitCode({ reason, side, entry_price, stop_loss } = {}, closeReason = null) {
  const r = String(reason ?? "").toLowerCase();
  if (r === "expert") return closeReason ? LIVE_EXIT_MAP.intent[closeReason] ?? String(closeReason) : "expert";
  const m = LIVE_EXIT_MAP.deal[r];
  if (m === "stop_or_sl_plus") return isProtected({ side, open_price: Number(entry_price), sl: Number(stop_loss) }) ? "sl_plus" : "stop";
  return m ?? (r || "unknown");
}

/**
 * Pure: the live trades from their deals, grouped per position (partial exits summed), with their open intent (entry,
 * sl, volume, r_dist, signal_issued_ms) and their close intent's reason. R = the P/L over the risk at the open
 * (r_dist / tick size × LIVE_TICK_VALUE_PER_001 × the open volume). A position whose exits do not yet add up to its
 * open volume is still open and left out. No ticket, price or money in the result.
 */
export function liveTradesFrom({ deals = [], opens = {}, closes = {} } = {}) {
  const by = new Map();
  for (const d of deals) {
    const t = Number(d?.position_ticket);
    if (!(t > 0)) continue;
    const g = by.get(t) ?? { ticket: t, deals: [] };
    g.deals.push(d);
    by.set(t, g);
  }
  const out = [];
  for (const g of by.values()) {
    const open = opens[g.ticket];
    if (!open || !finite(Number(open.signal_issued_ms))) continue;
    const list = g.deals.slice().sort((a, b) => Number(a.closed_ms) - Number(b.closed_ms));
    const vol = list.reduce((a, x) => a + (Number(x.volume) || 0), 0), vol0 = Number(open.volume);
    if (finite(vol0) && vol + 1e-9 < vol0) continue;
    const dist = finite(Number(open.r_dist)) && Number(open.r_dist) > 0 ? Number(open.r_dist) : Math.abs(Number(open.entry) - Number(open.sl));
    const risk = (dist / 0.01) * LIVE_TICK_VALUE_PER_001 * (finite(vol0) ? vol0 : vol);
    const profit = list.reduce((a, x) => a + (Number(x.profit) || 0), 0);
    const last = list.at(-1);
    out.push({
      signal_issued_ms: Number(open.signal_issued_ms), side: open.side ?? last.side, mode: open.mode ?? null,
      opened_ms: Number(list[0].opened_ms) || null, closed_ms: Number(last.closed_ms) || null,
      r: risk > 0 ? r3(profit / risk) : null, exit: liveExitCode(last, closes[g.ticket] ?? null), partial_exits: list.length - 1
    });
  }
  return out.sort((a, b) => a.signal_issued_ms - b.signal_issued_ms);
}

/**
 * Pure: v4 against the live trades. Each live trade is matched to its v4 decision row (decisionCloseMs(key) = the open
 * intent's signal_issued_ms, same side); a v4 trade with no live trade is counted too. Passes when the same exit holds
 * for at least PARITY_PASS.same_exit_min of the trades compared and the mean |ΔR| of the closed pairs is at most
 * PARITY_PASS.mean_abs_dr_max. `untilMs` is the end of the replay (later trades are not compared yet).
 */
export function omegaParity({ ledgerRows = [], liveTrades = [], liveOpen = [], sinceMs = PARITY_SINCE_MS, untilMs = Infinity, now = Date.now(), era = null, expected = [] } = {}) {
  // The liquidity lens's spread-spike gate (docs/RFC_POSITIONING_LIQUIDITY.md §7.2): v4 replays without the lens, so a
  // signal the gate held live is an expected difference (`expected`: "<signal issued ms>|<side>"), never a v4-only miss.
  const expectedSet = new Set(Array.isArray(expected) ? expected : []);
  const eraSince = finite(era?.since_ms) ? era.since_ms : PARITY_CURRENT_CODE_MS;
  const rowOf = new Map();
  for (const r of ledgerRows) { const c = decisionCloseMs(r?.decision_key); if (finite(c)) rowOf.set(`${c}|${r.side}`, r); }
  // Decisions live still holds open: not compared yet (neither side has a final result).
  const used = new Set((Array.isArray(liveOpen) ? liveOpen : []).map((o) => `${o.signal_issued_ms}|${o.side}`)), trades = [];
  for (const l of liveTrades) {
    if (!(l.signal_issued_ms >= sinceMs) || !(l.signal_issued_ms <= untilMs)) continue;
    const key = `${l.signal_issued_ms}|${l.side}`;
    const v = rowOf.get(key);
    const row = { issued_at: iso(l.signal_issued_ms), side: l.side, mode: l.mode ?? v?.trading_mode ?? null, live_code: (l.opened_ms ?? l.signal_issued_ms) >= eraSince ? "current" : "earlier", matched: Boolean(v), live_exit: l.exit, v4_exit: null, live_r: l.r, v4_r: null, dr: null, entry_diff_s: null, same_exit: false, cause: null };
    if (!v) { row.cause = "no v4 row for this decision (outside the replay's span)"; trades.push(row); continue; }
    used.add(key);
    row.v4_status = v.omega4_status;
    if (v.omega4_status === "skipped") row.cause = `v4 did not trade it: ${v.omega4_gate ?? "unknown gate"}`;
    else if (v.omega4_status === "pending") row.cause = "v4 still waits for its entry";
    else {
      const filled = toMs(v.omega4_filled_at);
      if (finite(filled) && finite(l.opened_ms)) row.entry_diff_s = Math.round((filled - l.opened_ms) / 1000);
      if (v.omega4_status === "open") row.cause = "v4 still holds it";
      else {
        row.v4_exit = v.omega4_exit; row.v4_r = v.r_omega4;
        row.same_exit = exitClass(v.omega4_exit) === exitClass(l.exit);
        if (finite(v.r_omega4) && finite(l.r)) row.dr = r3(v.r_omega4 - l.r);
        const why = [];
        if (!row.same_exit) why.push(`exit ${l.exit} live, ${v.omega4_exit} in v4`);
        if (row.dr != null && Math.abs(row.dr) > PARITY_PASS.mean_abs_dr_max) why.push(`R ${l.r} live, ${v.r_omega4} in v4`);
        if (row.entry_diff_s != null && Math.abs(row.entry_diff_s) > 120) why.push(`entries ${row.entry_diff_s}s apart`);
        if (why.length && row.live_code === "earlier") why.push("live ran earlier engine code (not counted)");
        row.cause = why.length ? why.join("; ") : null;
      }
    }
    trades.push(row);
  }
  for (const r of ledgerRows) {
    const c = decisionCloseMs(r?.decision_key);
    if (!finite(c) || used.has(`${c}|${r.side}`) || !(c >= sinceMs) || !(c <= untilMs)) continue;
    if (r.omega4_status !== "closed") continue;
    if (expectedSet.has(`${c}|${r.side}`)) continue;
    trades.push({ issued_at: iso(c), side: r.side, mode: r.trading_mode ?? null, live_code: c >= eraSince ? "current" : "earlier", matched: false, v4_only: true, live_exit: null, v4_exit: r.omega4_exit ?? null, live_r: null, v4_r: r.r_omega4 ?? null, dr: null, entry_diff_s: null, same_exit: false, v4_status: r.omega4_status, cause: "v4 traded it, live did not" });
  }
  trades.sort((a, b) => a.issued_at.localeCompare(b.issued_at));
  // Only the trades of the current era count; the earlier ones are shown apart.
  const current = paritySummary(trades.filter((t) => t.live_code === "current"));
  return {
    version: OMEGA4_VERSION, checked_at: iso(now), since: iso(sinceMs), until: finite(untilMs) ? iso(untilMs) : null,
    ...current, thresholds: PARITY_PASS,
    era: eraView(era, eraSince),
    earlier: paritySummary(trades.filter((t) => t.live_code === "earlier")),
    exit_map: LIVE_EXIT_MAP, tick_value: `${LIVE_TICK_VALUE_PER_001} USD per 0.01 a lot (gold in USD, contract 100 oz)`, trades
  };
}

const short = (h) => (typeof h === "string" && h ? h.slice(0, 12) : null);
/**
 * Pure: the era as the parity result shows it: since, commit, reason ("seed", "behaviour change", "switch on:
 * entry_order=council"), the behaviour and code hashes (12 characters), the switch signature, the code carries, and the
 * eras before it (the last 3). An era of the old shape ({ hash }) shows its hash as the code hash.
 */
export function eraView(era, eraSince = finite(era?.since_ms) ? era.since_ms : PARITY_CURRENT_CODE_MS) {
  const code = short(era?.code_hash ?? era?.hash);
  return {
    since: iso(eraSince), commit: era?.commit ?? null, reason: typeof era?.reason === "string" ? era.reason : era?.seeded === true ? "seed" : null,
    behaviour_hash: short(era?.behaviour_hash), code_hash: code, hash: code, switches: Array.isArray(era?.switches) ? era.switches : [], seeded: era?.seeded === true,
    adopted: finite(era?.adopted_ms), carried: Array.isArray(era?.carried) ? era.carried.slice(0, 3).map((c) => ({ at: finite(c.at_ms) ? iso(c.at_ms) : null, code_hash: short(c.code_hash), commit: c.commit ?? null })) : [],
    previous: Array.isArray(era?.previous) ? era.previous.slice(0, 3).map((p) => ({
      since: finite(p.since_ms) ? iso(p.since_ms) : null, until: finite(p.until_ms) ? iso(p.until_ms) : null, commit: p.commit ?? null, reason: p.reason ?? null,
      behaviour_hash: short(p.behaviour_hash), code_hash: short(p.code_hash ?? p.hash), hash: short(p.code_hash ?? p.hash), switches: Array.isArray(p.switches) ? p.switches : []
    })) : []
  };
}

/**
 * Pure: the status of parity rows (omegaParity): every row counts in the same-exit share, the closed pairs in |ΔR|.
 * "insufficient" below PARITY_MIN_TRADES live trades (never "pass"); else "pass" or "fail" at PARITY_PASS.
 */
export function paritySummary(trades, { minTrades = PARITY_MIN_TRADES } = {}) {
  const compared = trades.length, same = trades.filter((t) => t.same_exit).length;
  const pairs = trades.filter((t) => finite(t.dr));
  const meanAbs = pairs.length ? r3(pairs.reduce((a, t) => a + Math.abs(t.dr), 0) / pairs.length) : null;
  const share = compared ? r3(same / compared) : null;
  const liveCount = trades.filter((t) => !t.v4_only).length;
  const meets = compared > 0 && share >= PARITY_PASS.same_exit_min && meanAbs != null && meanAbs <= PARITY_PASS.mean_abs_dr_max;
  const status = liveCount < minTrades ? "insufficient" : meets ? "pass" : "fail";
  return {
    status, pass: status === "pass", min_trades: minTrades, trades_compared: compared, live_trades: liveCount, matched: trades.filter((t) => t.matched).length,
    v4_only: trades.filter((t) => t.v4_only).length, closed_pairs: pairs.length, same_exit: same, same_exit_share: share, mean_abs_dr: meanAbs
  };
}

// ---------------------------------------------------------------------------
// D1, KV and the cron.

const UPSERT_SQL = `INSERT INTO ledger_omega4 (decision_key, side, issued_ms, trading_mode, agent, omega4_status, omega4_gate, omega4_filled_at, omega4_closed_at, omega4_exit, r_omega4, omega4_size, omega4_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(decision_key) DO UPDATE SET side = excluded.side, issued_ms = excluded.issued_ms, trading_mode = excluded.trading_mode, agent = excluded.agent, omega4_status = excluded.omega4_status,
  omega4_gate = excluded.omega4_gate, omega4_filled_at = excluded.omega4_filled_at, omega4_closed_at = excluded.omega4_closed_at, omega4_exit = excluded.omega4_exit, r_omega4 = excluded.r_omega4,
  omega4_size = excluded.omega4_size, omega4_json = excluded.omega4_json, updated_at = excluded.updated_at`;
const FIELDS = ["omega4_status", "omega4_gate", "omega4_filled_at", "omega4_closed_at", "omega4_exit", "r_omega4", "omega4_size", "omega4_json"];

/** The live USD account's reference (the latest Omega deal's account, never its number), or null. */
async function liveAccountRef(db) {
  try { return (await db.prepare("SELECT account_ref FROM ea_deals WHERE source = 'omega' AND currency = 'USD' AND mode <> 'demo' AND account_ref IS NOT NULL ORDER BY closed_ms DESC LIMIT 1").first())?.account_ref ?? null; } catch { return null; }
}

/** What the replay reads beside the bars and the decisions, from D1 and KV. Never throws; each part has its fallback. */
export async function loadOmega4Context(env, { sinceMs, now = Date.now() }) {
  const db = env.DB;
  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
  const settings = await safe(async () => { const row = await db.prepare("SELECT settings FROM omega_settings WHERE id = 1").first(); return { ...OMEGA_DEFAULTS, ...(row?.settings ? JSON.parse(row.settings) : {}) }; }, { ...OMEGA_DEFAULTS });
  const ref = await liveAccountRef(db);
  const acct = ref ? await safe(() => db.prepare("SELECT profile, last_balance, last_seen_ms FROM omega_accounts WHERE account_ref = ?").bind(ref).first(), null) : null;
  const current = acct?.profile ?? (await safe(() => db.prepare("SELECT profile FROM omega_accounts ORDER BY COALESCE(last_seen_ms, created_ms) DESC LIMIT 1").first(), null))?.profile ?? null;
  const changes = ref ? await safe(async () => (await db.prepare("SELECT from_profile, to_profile, at_ms FROM omega_profile_changes WHERE account_ref = ? ORDER BY at_ms").bind(ref).all()).results ?? [], []) : [];
  const deals = ref && finite(Number(acct?.last_seen_ms)) ? await safe(async () => (await db.prepare("SELECT closed_ms, profit + COALESCE(commission, 0) + COALESCE(swap, 0) AS net FROM ea_deals WHERE account_ref = ? AND closed_ms > ?").bind(ref, sinceMs - 86_400_000).all()).results ?? [], []) : [];
  const balanceAt = acct ? balanceTimeline({ last: Number(acct.last_balance), lastMs: Number(acct.last_seen_ms), deals }) : null;
  // The council's verdicts per position and 5m bar, keyed by the position's open intent id.
  const councils = {};
  for (const r of await safe(async () => (await db.prepare("SELECT pa.bar AS bar, pa.council AS council, oi.id AS id FROM position_actions pa JOIN omega_intents oi ON oi.kind = 'open' AND json_extract(oi.result, '$.ticket') = pa.ticket WHERE pa.at_ms >= ? AND oi.created_ms >= ?").bind(sinceMs - 3600_000, sinceMs - 3 * 86_400_000).all()).results ?? [], [])) {
    if (typeof r.council === "string" && r.council) councils[`${r.id}|${r.bar}`] = r.council;
  }
  const control = (await safe(async () => (await db.prepare("SELECT at, mode FROM ea_control_events WHERE at >= ? ORDER BY id").bind(iso(sinceMs - 7 * 86_400_000)).all()).results ?? [], [])).map((c) => ({ at_ms: toMs(c.at), mode: c.mode })).filter((c) => finite(c.at_ms));
  const { beforeMs, afterMs } = blackoutWindow(env);
  const blackouts = (await safe(() => gatedEvents(env, { now }), [])).map((e) => { const t = Date.parse(e?.time ?? e?.date ?? ""); return finite(t) ? { from_ms: t - beforeMs, to_ms: t + afterMs, reason: String(e.title ?? e.event ?? "high-impact USD event").slice(0, 80) } : null; }).filter(Boolean);
  const grid = gridAdaptMode(env) === "live" ? await safe(() => readGridChoices(env), null) : null;
  const arms = strategyArmMode(env) === "live" ? await safe(() => readArmState(env), null) : null;
  return { settings, profileAt: profileTimeline(changes, current), balanceAt, councils, control, blackouts, grid, arms, eaGate: eaVersionGateOn(env), live_account: Boolean(ref), profile_source: changes.length ? "history" : current ? "current" : "none" };
}

// The feed's 1m bars kept in D1 (ledger_bars_1m), so the replay stays reproducible once the KV 1m series (about two
// days) has rolled past a checkpoint or a trade. Only closed minutes newer than the last archived one are written.
export const BAR_ARCHIVE_DAYS = 120;
const BAR_ROWS_PER_STATEMENT = 20; // 5 values a row, within D1's 100 bound parameters a statement

/** Pure: archived and live 1m bars ({ t, o, h, l, c }) as one series, oldest first, one bar a minute (the archive's first). */
export function mergeMinuteBars(archive = [], live = []) {
  const by = new Map();
  for (const b of live) if (finite(b?.t)) by.set(b.t, b);
  for (const b of archive) if (finite(b?.t)) by.set(b.t, b);
  return [...by.values()].sort((a, b) => a.t - b.t);
}

/** Appends the closed 1m bars newer than the archive's last minute (INSERT OR IGNORE, batched). Returns the rows written. */
export async function archiveMinuteBars(env, bars, { now = Date.now() } = {}) {
  const db = env?.DB;
  if (!db) return 0;
  const last = Number((await db.prepare("SELECT MAX(minute_ms) AS t FROM ledger_bars_1m").first())?.t) || 0;
  const fresh = minuteBars(bars).filter((b) => b.t > last && b.t + M1 <= now);
  if (!fresh.length) return 0;
  const statements = [];
  for (let i = 0; i < fresh.length; i += BAR_ROWS_PER_STATEMENT) {
    const part = fresh.slice(i, i + BAR_ROWS_PER_STATEMENT);
    statements.push(db.prepare(`INSERT OR IGNORE INTO ledger_bars_1m (minute_ms, o, h, l, c) VALUES ${part.map(() => "(?, ?, ?, ?, ?)").join(", ")}`).bind(...part.flatMap((b) => [b.t, b.o, b.h, b.l, b.c])));
  }
  statements.push(db.prepare("DELETE FROM ledger_bars_1m WHERE minute_ms < ?").bind(now - BAR_ARCHIVE_DAYS * 86_400_000));
  for (let i = 0; i < statements.length; i += 50) {
    const part = statements.slice(i, i + 50);
    if (typeof db.batch === "function") await db.batch(part);
    else for (const st of part) await st.run();
  }
  return fresh.length;
}

/** The archived 1m bars from `fromMs` up to (not including) `toMs`. */
export async function readArchivedBars(env, fromMs, toMs) {
  const rows = (await env.DB.prepare("SELECT minute_ms AS t, o, h, l, c FROM ledger_bars_1m WHERE minute_ms >= ? AND minute_ms < ? ORDER BY minute_ms").bind(fromMs, toMs).all()).results ?? [];
  return rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) })).filter((b) => [b.t, b.o, b.h, b.l, b.c].every(finite));
}

/**
 * The 1m bars a replay from checkpoint `cp` reads: the closed KV minutes (`live`, minuteBars) from the checkpoint less
 * the warm-up (the ATR and the 5m structure), else the last 3 days, and before the KV series the D1 archive.
 */
export async function windowBars(env, liveBars, { cp = null, now = Date.now() } = {}) {
  const live = liveBars.filter((b) => b.t + M1 <= now);
  const want = cp ? cp.at_ms - OMEGA4_SIM.warmup_ms : now - 3 * 86_400_000;
  const liveStart = live.length ? live[0].t : now;
  return liveStart > want ? mergeMinuteBars(await readArchivedBars(env, want, liveStart), live) : live.filter((b) => b.t >= want);
}

/**
 * The cron step (the ledger's 5-minute run): the bars archived, then the replay from the checkpoint (the whole replay
 * state at its next minute) for at most MAX_REPLAY_MINUTES minutes, its records into D1 (ledger_omega4, and the
 * omega4_* columns of the ledger's own rows), the next checkpoint into KV. The bars come from the KV 1m series and,
 * where it no longer reaches back, from the archive. Returns the run's work: decisions seen, minutes replayed,
 * planIntents and positionAction calls, the wall time. `shared`, when given, receives what the run loaded ({ from, m1,
 * decisions, ctx }) for the limit replay that follows it in the same step (src/ledger-omega-limit.mjs). Never throws.
 */
export async function runOmega4(env, { now = Date.now(), bars = null, maxMinutes = MAX_REPLAY_MINUTES, shared = null } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  const t0 = Date.now();
  try {
    await ensureLedgerSchema(env.DB);
    const raw = bars ?? (await ledgerSeries(env)).bars;
    const archived = await archiveMinuteBars(env, raw, { now });
    let cp = null;
    try { cp = JSON.parse((await env.SIGNAL_CACHE?.get?.(OMEGA4_CHECKPOINT_KEY)) || "null"); } catch { cp = null; }
    if (cp?.version !== OMEGA4_VERSION || !finite(cp?.at_ms)) cp = null;
    const m1 = await windowBars(env, minuteBars(raw), { cp, now });
    if (m1.length < 60) return { status: "no_bars", archived };
    const earliest = m1[0].t + OMEGA4_SIM.warmup_ms;
    // A gap only when no bar at all lies before the checkpoint (a weekend inside the warm-up is the market's, not ours).
    if (cp && m1[0].t >= cp.at_ms) {
      // Neither the KV series nor the archive reaches the checkpoint: a trade left open there is marked out at its last
      // known R (data_gap), and the replay starts again where the bars begin.
      await env.DB.prepare("UPDATE ledger_omega4 SET omega4_status = 'closed', omega4_exit = 'data_gap', r_omega4 = CAST(json_extract(omega4_json, '$.open_r') AS REAL), omega4_closed_at = ?, updated_at = ? WHERE omega4_status = 'open'").bind(iso(earliest), iso(now)).run();
      cp = null;
    }
    const from = cp ? cp.at_ms : earliest;
    const decisions = ((await env.DB.prepare(DECISION_SQL).bind(iso(from - 2 * 3600_000)).all()).results ?? []).map(decisionFromRow).filter(Boolean);
    const ctx = await loadOmega4Context(env, { sinceMs: from, now });
    if (shared && typeof shared === "object") Object.assign(shared, { from, m1, decisions, ctx });
    const run = replayOmega4({ bars: m1, decisions, from, to: now, state: cp, maxSteps: maxMinutes, ...ctx });
    const keys = Object.keys(run.records);
    let written = 0;
    const stored = new Map();
    for (let i = 0; i < keys.length; i += 50) {
      const part = keys.slice(i, i + 50);
      for (const r of (await env.DB.prepare(`SELECT * FROM ledger_omega4 WHERE decision_key IN (${part.map(() => "?").join(", ")})`).bind(...part).all()).results ?? []) stored.set(r.decision_key, r);
    }
    const writes = [];
    for (const key of keys) {
      const r = run.records[key], s = stored.get(key);
      if (s && FIELDS.every((f) => (s[f] ?? null) === (r[f] ?? null))) continue;
      writes.push(env.DB.prepare(UPSERT_SQL).bind(r.decision_key, r.side, r.issued_ms, r.trading_mode, r.agent, r.omega4_status, r.omega4_gate, r.omega4_filled_at, r.omega4_closed_at, r.omega4_exit, r.r_omega4, r.omega4_size, r.omega4_json, iso(now)));
      writes.push(env.DB.prepare("UPDATE signal_ledger SET omega4_status = ?, omega4_exit = ?, r_omega4 = ?, omega4_size = ?, omega4_filled_at = ?, omega4_closed_at = ?, omega4_json = ? WHERE id = ?")
        .bind(r.omega4_status, r.omega4_exit, r.r_omega4, r.omega4_size, r.omega4_filled_at, r.omega4_closed_at, r.omega4_json, `decision:${key}`));
      written += 1;
    }
    for (let i = 0; i < writes.length; i += 50) {
      const part = writes.slice(i, i + 50);
      if (typeof env.DB.batch === "function") await env.DB.batch(part);
      else for (const st of part) await st.run();
    }
    // The checkpoint (the state at the next minute), with the replay's reach for the parity check.
    const next = { ...run.checkpoint, last_ms: run.last_ms ?? cp?.last_ms ?? null };
    if (next.at_ms !== cp?.at_ms) await env.SIGNAL_CACHE?.put?.(OMEGA4_CHECKPOINT_KEY, JSON.stringify(next), { expirationTtl: 7 * 86_400 });
    return {
      status: "ok", from: iso(from), to: run.last_ms != null ? iso(run.last_ms) : null, more: run.more, archived,
      decisions: run.decisions, minutes: run.steps, plans: run.plans, position_actions: run.pm_calls, records: keys.length, written, open: run.open_positions, ms: Date.now() - t0
    };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200), ms: Date.now() - t0 };
  }
}

/** Omega's real trades on the live USD account since `sinceMs`, and its opens still open ({ trades, open }; no ticket, price or money leaves). */
export async function loadLiveTrades(env, { sinceMs = PARITY_SINCE_MS } = {}) {
  const db = env.DB;
  const deals = (await db.prepare("SELECT position_ticket, side, volume, entry_price, stop_loss, profit, reason, opened_ms, closed_ms FROM ea_deals WHERE source = 'omega' AND currency = 'USD' AND mode <> 'demo' AND closed_ms >= ? ORDER BY closed_ms").bind(sinceMs).all()).results ?? [];
  const tickets = [...new Set(deals.map((d) => Number(d.position_ticket)).filter((t) => t > 0))];
  const opens = {}, closes = {};
  for (let i = 0; i < tickets.length; i += 50) {
    const part = tickets.slice(i, i + 50), marks = part.map(() => "?").join(", ");
    for (const r of (await db.prepare(`SELECT payload, json_extract(result, '$.ticket') AS ticket FROM omega_intents WHERE kind = 'open' AND json_extract(result, '$.ticket') IN (${marks})`).bind(...part).all()).results ?? []) {
      const p = parse(r.payload, {});
      opens[Number(r.ticket)] = { entry: p.entry, sl: p.sl, volume: p.volume, r_dist: p.r_dist, signal_issued_ms: p.signal_issued_ms, side: p.side, mode: p.mode ?? null };
    }
    for (const r of (await db.prepare(`SELECT payload, created_ms FROM omega_intents WHERE kind IN ('close', 'close_all') AND json_extract(payload, '$.ticket') IN (${marks}) ORDER BY created_ms`).bind(...part).all()).results ?? []) {
      const p = parse(r.payload, {});
      if (Number(p.ticket) > 0) closes[Number(p.ticket)] = typeof p.reason === "string" ? p.reason : null;
    }
  }
  const trades = liveTradesFrom({ deals, opens, closes });
  // Omega's opens since then with no exit deal yet (still open on the terminal): left out of the comparison for now.
  let open = [];
  try {
    const rows = (await db.prepare("SELECT payload, json_extract(result, '$.ticket') AS ticket FROM omega_intents WHERE kind = 'open' AND status = 'done' AND created_ms >= ?").bind(sinceMs).all()).results ?? [];
    const closed = new Set(deals.map((d) => Number(d.position_ticket)));
    open = rows.filter((r) => Number(r.ticket) > 0 && !closed.has(Number(r.ticket))).map((r) => { const p = parse(r.payload, {}); return { signal_issued_ms: Number(p.signal_issued_ms), side: p.side }; }).filter((o) => finite(o.signal_issued_ms));
  } catch { open = []; }
  return { trades, open };
}

export const PARITY_EVERY_MS = 3600_000;
/** The parity check, at most once an hour from the ledger cron, kept in KV for GET /api/ledger. Never throws. */
export async function runOmegaParity(env, { now = Date.now(), force = false } = {}) {
  if (!env?.DB || !env?.SIGNAL_CACHE?.put) return { status: "unavailable" };
  try {
    const prev = JSON.parse((await env.SIGNAL_CACHE.get(OMEGA4_PARITY_KEY)) || "null");
    if (!force && prev?.checked_at && now - Date.parse(prev.checked_at) < PARITY_EVERY_MS) return { status: "fresh" };
    await ensureLedgerSchema(env.DB);
    const rows = (await env.DB.prepare("SELECT decision_key, side, trading_mode, omega4_status, omega4_gate, omega4_filled_at, omega4_closed_at, omega4_exit, r_omega4 FROM ledger_omega4 WHERE issued_ms >= ?").bind(PARITY_SINCE_MS).all()).results ?? [];
    let until = null;
    try { until = Number(JSON.parse((await env.SIGNAL_CACHE.get(OMEGA4_CHECKPOINT_KEY)) || "null")?.last_ms); } catch { until = null; }
    const live = await loadLiveTrades(env, { sinceMs: PARITY_SINCE_MS });
    // The era (its moves, "era carried (behaviour identical)" among them, go to the ledger_omega4 log line as era_events).
    const { era, events } = await eraStep(env, { now });
    let expected = [];
    try {
      expected = ((await env.DB.prepare("SELECT at_ms, side FROM lens_readings WHERE lens = 'liquidity' AND kind = 'block' AND at_ms >= ?").bind(PARITY_SINCE_MS).all()).results ?? []).map((r) => `${Number(r.at_ms)}|${Number(r.side) > 0 ? "BUY" : "SELL"}`);
    } catch { expected = []; }
    const result = omegaParity({ ledgerRows: rows, liveTrades: live.trades, liveOpen: live.open, era, untilMs: finite(until) && until > 0 ? until + M1 : now, now, expected });
    await env.SIGNAL_CACHE.put(OMEGA4_PARITY_KEY, JSON.stringify(result), { expirationTtl: 8 * 86_400 });
    return {
      status: "checked", parity: result.status, era_since: result.era.since, era_reason: result.era.reason, trades: result.trades_compared, live_trades: result.live_trades, same_exit_share: result.same_exit_share, mean_abs_dr: result.mean_abs_dr,
      ...(events.length ? { era_events: events, era_code_hash: result.era.code_hash, era_behaviour_hash: result.era.behaviour_hash } : {})
    };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The stored parity result (GET /api/ledger `parity`), or null. */
export async function readOmegaParity(env) {
  try { return JSON.parse((await env?.SIGNAL_CACHE?.get?.(OMEGA4_PARITY_KEY)) || "null"); } catch { return null; }
}
