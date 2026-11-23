// PM-1M's fixtures (src/pm-fast.mjs): closed broker M1 bars for each trigger and each noise rule, the actions Omega
// checks, and v4 replays where the layer acts. Generated here deterministically; test/pm-fast.test.mjs asserts on them
// and test/fixtures/engine-behaviour.mjs hashes their outputs into ENGINE_BEHAVIOUR_HASH (with pm_fast_1m on only).
// Opaque tickets only; no account, no login.
import { fastProtect } from "../../src/pm-fast.mjs";
import { positionManagerIntents } from "../../src/omega-engine.mjs";
import { replayOmega4 } from "../../src/ledger-omega4.mjs";
import { base, cutLossCase, C, M1, M15, WARM, path, lerp, decision, dec, levels } from "./omega-v4-replay.mjs";

export const T0 = Date.parse("2026-11-24T09:00:00Z"); // a Tuesday morning, London open past
export const SYM = Object.freeze({ point: 0.01, digits: 2, spread_points: 20 });
const r2 = (v) => Math.round(v * 100) / 100;

/** Bars from `start`: `n` bars moving `step` a minute with wicks of `wick`, then the `tail` bodies (each a close change). */
export function bars({ start = T0, n = 40, from = 2000, step = 0.4, wick = 0.5, tail = [], spread = 20, zigzag = false } = {}) {
  const out = [];
  let px = from;
  for (let i = 0; i < n; i++) {
    const d = zigzag ? (i % 2 ? step : -step) : step;
    const o = r2(px), c = r2(px + d);
    out.push({ t: start + i * M1, o, h: r2(Math.max(o, c) + wick), l: r2(Math.min(o, c) - wick), c, s: spread });
    px = c;
  }
  for (let j = 0; j < tail.length; j++) {
    const x = tail[j];
    const { d, hi = 0.3, lo = 0.3 } = typeof x === "number" ? { d: x } : x;
    const o = r2(px), c = r2(px + d);
    out.push({ t: start + (n + j) * M1, o, h: r2(Math.max(o, c) + hi), l: r2(Math.min(o, c) - lo), c, s: spread });
    px = c;
  }
  return out;
}
export const nowAfter = (list, ms = 2000) => list.at(-1).t + M1 + ms;

// The TP anticipation of a long: 37 bars up 0.4 a minute, then down, up, down (bodies 0.9, ATR1m about 1.4), price 0.28R
// from a target at 2016 (zone 0.3R intraday).
export const tpBuyBars = () => bars({ n: 37, step: 0.4, tail: [-0.9, 0.2, -0.9] });
export const tpBuy = Object.freeze({ ticket: 101, side: "BUY", open_price: 2000, sl: 1990, tp: 2016, opened_ms: T0, volume: 0.01, intent_id: "open:1:B", magic: 920200, source: "omega" });
export const tpBuyMeta = Object.freeze({ mode: "intraday", r_dist: 10, tp1: 2016, orig_sl: 1990 });
// The same for a short (bid bars falling; the spread added back in the layer).
export const tpSellBars = () => bars({ n: 37, step: -0.4, tail: [0.9, -0.2, 0.9] });
export const tpSell = Object.freeze({ ticket: 202, side: "SELL", open_price: 2000, sl: 2010, tp: 1984.4, opened_ms: T0, volume: 0.01, intent_id: "open:2:S", magic: 920200, source: "omega" });
export const tpSellMeta = Object.freeze({ mode: "intraday", r_dist: 10, tp1: 1984.4, orig_sl: 2010 });
// The loss reduction of a long: a zigzag around 2000 (ATR1m about 1.6), an impulse down beyond the 5m swing (true range
// about 5.9) and a bar that does not reclaim it.
export const cutBuyBars = () => bars({ n: 40, step: 0.3, wick: 0.5, zigzag: true, tail: [{ d: -5.5, hi: 0.1, lo: 0.4 }, { d: -0.3, hi: 0.4, lo: 0.3 }] });
export const cutBuy = (over = {}) => ({ ticket: 303, side: "BUY", open_price: 1997, sl: 1987, tp: 2030, opened_ms: T0, volume: 0.01, intent_id: "open:3:B", magic: 920200, source: "omega", ...over });
export const cutBuyMeta = (over = {}) => ({ mode: "intraday", r_dist: 10, tp1: 2030, orig_sl: 1987, ...over });
export const GATE_OPEN = Object.freeze({ open: true, mode: "intraday", tf: "M15", mfe_px: 15, mfe_r: 1.5, mfe_atr: 2, need_px: 10, need: "1R", bars: 40, last_close_ms: null, reason: "reached" });
export const GATE_SHUT = Object.freeze({ open: false, mode: "intraday", tf: "M15", mfe_px: 8, mfe_r: 0.8, mfe_atr: 1.1, need_px: 10, need: "1R", bars: 40, last_close_ms: null, reason: "below" });

/** Every case of the pure layer, [name, input] (fastProtect's arguments). */
export function fastCases() {
  const b = tpBuyBars(), now = nowAfter(b), lastT = b.at(-1).t;
  const tp = { position: tpBuy, meta: tpBuyMeta, bars: b, now, sym: SYM };
  const s = tpSellBars();
  const cb = cutBuyBars(), cnow = nowAfter(cb);
  const cut = { position: cutBuy(), meta: cutBuyMeta(), bars: cb, now: cnow, sym: SYM };
  const at = (iso, list = tpBuyBars) => { const x = list({}); const shift = Date.parse(iso) - x.at(-1).t; return x.map((y) => ({ ...y, t: y.t + shift })); };
  const late = b.map((x, i) => (i === b.length - 4 ? { ...x, r: x.t + M1 + 150_000 } : { ...x, r: x.t + M1 + 1500 }));
  // A catch-up bar received 70 s after its close, 7 minutes ago: the 3-minute quarantine is over.
  const lateOld = b.map((x, i) => (i === b.length - 8 ? { ...x, r: x.t + M1 + 70_000 } : { ...x, r: x.t + M1 + 1500 }));
  const gap = b.filter((x, i) => i !== b.length - 12);
  return [
    ["tp/legacy_lock", tp],
    ["tp/gate_open_lock", { ...tp, gate: GATE_OPEN }],
    ["tp/gate_shut_nearer", { ...tp, gate: GATE_SHUT }],
    ["tp/sell_gate_open_lock", { position: tpSell, meta: tpSellMeta, bars: s, now: nowAfter(s), sym: SYM, gate: GATE_OPEN }],
    ["tp/sell_gate_shut_nearer", { position: tpSell, meta: tpSellMeta, bars: s, now: nowAfter(s), sym: SYM, gate: GATE_SHUT }],
    ["tp/already_locked_nearer", { ...tp, position: { ...tpBuy, sl: 2008 }, gate: GATE_OPEN }],
    ["tp/held_spike", { ...tp, gate: GATE_OPEN, spike: true }],
    ["tp/held_rate", { ...tp, gate: GATE_OPEN, history: [{ bar_ms: lastT - 2 * M1, branch: "tp" }] }],
    ["tp/rate_passed", { ...tp, gate: GATE_OPEN, history: [{ bar_ms: lastT - 3 * M1, branch: "tp" }] }],
    ["tp/held_hysteresis", { ...tp, gate: GATE_OPEN, history: [{ bar_ms: lastT - 6 * M1, branch: "cut" }] }],
    ["tp/hysteresis_passed", { ...tp, gate: GATE_OPEN, history: [{ bar_ms: lastT - 10 * M1, branch: "cut" }] }],
    ["tp/held_pm_bar", { ...tp, gate: GATE_OPEN, pmBar: true }],
    ["tp/out_of_zone", { ...tp, position: { ...tpBuy, tp: 2020 }, meta: { ...tpBuyMeta, tp1: 2020 } }],
    ["tp/in_loss", { ...tp, position: { ...tpBuy, open_price: 2014 }, meta: { ...tpBuyMeta } }],
    ["cut/tighten", cut],
    ["cut/close_below_exit_r", { ...cut, position: cutBuy({ open_price: 2000, sl: 1990 }), meta: cutBuyMeta({ orig_sl: 1990 }) }],
    ["cut/in_profit_gate_shut", { ...cut, position: cutBuy({ open_price: 1990, sl: 1980 }), meta: cutBuyMeta({ orig_sl: 1980 }), gate: GATE_SHUT }],
    ["cut/in_profit_gate_open", { ...cut, position: cutBuy({ open_price: 1990, sl: 1980 }), meta: cutBuyMeta({ orig_sl: 1980 }), gate: GATE_OPEN }],
    ["cut/already_tighter", { ...cut, position: cutBuy({ sl: 1993.9 }) }],
    ["cut/held_spike", { ...cut, spike: true }],
    ["noise/no_stream", { ...tp, bars: [] }],
    ["noise/stale", { ...tp, now: lastT + M1 + 91_000 }],
    ["noise/rollover", { ...tp, bars: at("2026-11-24T21:57:00Z"), now: Date.parse("2026-11-24T21:58:02Z") }],
    ["noise/reopen", { ...tp, bars: at("2026-11-24T23:02:00Z"), now: Date.parse("2026-11-24T23:03:02Z") }],
    ["noise/market_paused", { ...tp, bars: at("2026-11-24T22:30:00Z"), now: Date.parse("2026-11-24T22:31:02Z") }],
    ["noise/reconnect", { ...tp, bars: late }],
    ["noise/reconnect_passed", { ...tp, bars: lateOld }],
    ["noise/warmup", { ...tp, bars: gap }],
    ["noise/no_atr", { ...tp, bars: b.map((x) => ({ ...x, o: 2000, h: 2000, l: 2000, c: 2000 })) }]
  ];
}

/** Omega's check of the layer's actions (positionManagerIntents), [name, input]. */
export function fastIntentCases() {
  const sym = (bid) => ({ bid, ask: r2(bid + 0.2), point: 0.01, digits: 2, spread_points: 20, stops_level_points: 0 });
  const p = { ...tpBuy };
  const id = (m) => `pm1:${p.ticket}:${m}`;
  return [
    ["lock", { positions: [p], sym: sym(2013.2), actions: [{ id: id(29900000), ticket: p.ticket, action: "sl", rule: "pm_fast_tp", sl: 2006.6 }] }],
    ["lock_gate_shut", { positions: [p], sym: sym(2013.2), actions: [{ id: id(29900000), ticket: p.ticket, action: "sl", rule: "pm_fast_tp", sl: 2006.6 }], gates: { [p.ticket]: GATE_SHUT } }],
    ["lock_gate_open", { positions: [p], sym: sym(2013.2), actions: [{ id: id(29900000), ticket: p.ticket, action: "sl", rule: "pm_fast_tp", sl: 2006.6 }], gates: { [p.ticket]: GATE_OPEN } }],
    ["looser_stop", { positions: [{ ...p, sl: 2008 }], sym: sym(2013.2), actions: [{ id: id(29900001), ticket: p.ticket, action: "sl", rule: "pm_fast_cut", sl: 2006.6 }] }],
    ["no_room", { positions: [p], sym: sym(2006.7), actions: [{ id: id(29900002), ticket: p.ticket, action: "sl", rule: "pm_fast_cut", sl: 2006.6 }] }],
    ["nearer_tp", { positions: [p], sym: sym(2013.2), actions: [{ id: id(29900003), ticket: p.ticket, action: "tp", rule: "pm_fast_tp", tp: 2015.1 }], gates: { [p.ticket]: GATE_SHUT } }],
    ["further_tp", { positions: [p], sym: sym(2013.2), actions: [{ id: id(29900004), ticket: p.ticket, action: "tp", rule: "pm_fast_tp", tp: 2017 }] }],
    ["tp_wrong_side", { positions: [p], sym: sym(2015.0), actions: [{ id: id(29900005), ticket: p.ticket, action: "tp", rule: "pm_fast_tp", tp: 2015.1 }] }],
    ["tp_with_stop", { positions: [p], sym: sym(2013.2), actions: [{ id: id(29900006), ticket: p.ticket, action: "tp", rule: "pm_fast_tp", tp: 2015.1, sl: 2001 }] }],
    ["close", { positions: [p], sym: sym(1994), actions: [{ id: id(29900007), ticket: p.ticket, action: "close", rule: "pm_fast_cut" }] }],
    ["loosened_before", { positions: [p], sym: sym(2013.2), actions: [{ id: id(29900008), ticket: p.ticket, action: "sl", rule: "pm_fast_cut", sl: 1995 }], loosenedFrom: { [p.ticket]: 1996 } }]
  ];
}

/**
 * v4 replays where the layer acts: V5's SELL that runs 9 against (the 1m impulse tightens its stop, stopped out early),
 * and a SELL whose price turns against it near its TP (the TP anticipation locks profit; price then comes back to the lock).
 */
export function fastTpCase() {
  const d0 = decision({ close: C, trade: { side: "SELL", action: "ENTER_LIMIT", entry: 2000, stop: 2010, tp: 1985, tp1: 1985, target: "tp1", agent: "zone_pullback", rrr: 1.5 }, lv: levels([[1940, 1942]]), mode: "intraday" });
  const price = lerp([[C + 3 * M1, 2000], [C + 30 * M1, 1986]]);
  const raw = path(C - WARM, C + 31 * M1, price, 0.3);
  // Three bars after the run: up, down, up (against the short), flat, then back up through the lock.
  let px = raw.at(-1).close;
  for (const [i, d] of [[31, 0.7], [32, -0.1], [33, 0.7], [34, 0], [35, 0], [36, 0], [37, 0], [38, 0], [39, 0], ...Array.from({ length: 16 }, (_, j) => [40 + j, 0.6])]) {
    const t = C + i * M1, o = px, c = r2(px + d);
    raw.push({ open_time: new Date(t).toISOString(), close_time: new Date(t + M1).toISOString(), open: o, high: r2(Math.max(o, c) + 0.3), low: r2(Math.min(o, c) - 0.3), close: c });
    px = c;
  }
  return { bars: raw, decisions: [dec(d0), dec(decision({ close: C + M15, stance: "WAIT", decidedAfter: M1, lv: levels([[1940, 1942]]), mode: "intraday" }))], to: C + 56 * M1 };
}
export const fastReplayScenarios = () => [
  { name: "cut_loss", opts: { ...base(), ...cutLossCase() } },
  { name: "tp_anticipation", opts: { ...base(), ...fastTpCase() } }
];

/** The fingerprint's lines (test/fixtures/engine-behaviour.mjs), with the layer on (its default). */
export function fastLines() {
  const lines = [];
  lines.push(`fast/protect=${JSON.stringify(fastCases().map(([name, input]) => [name, fastProtect(input)]))}`);
  lines.push(`fast/intents=${JSON.stringify(fastIntentCases().map(([name, input]) => [name, positionManagerIntents(input)]))}`);
  for (const s of fastReplayScenarios()) {
    const trace = [];
    const run = replayOmega4({ ...s.opts, trace });
    lines.push(`fast/v4/${s.name}/trace=${JSON.stringify(trace.map((t) => [t.now, t.output]))}`);
    lines.push(`fast/v4/${s.name}/records=${JSON.stringify(run.records)}`);
  }
  return lines;
}

/**
 * The 2026-11-22 reopen, rebuilt from the measured facts (the corpus itself is not in the repository): Friday's last
 * hour with a mean 1m true range of about 2.9, the weekly close at 22:00 UTC, the Sunday reopen at 23:00 UTC whose 1m
 * ATR rises about 2.9x within ten minutes, with impulses against a long and bars turning against it, and Friday's
 * 21:59 bar arriving only at the reopen (a catch-up batch). `contiguous` moves the same bars to a Tuesday morning
 * without the weekend between them (the teeth of the test: there the layer acts).
 */
export function reopenBars({ contiguous = false } = {}) {
  const fri = contiguous ? Date.parse("2026-11-24T09:00:00Z") : Date.parse("2026-11-20T21:00:00Z"), sun = Date.parse("2026-11-22T23:00:00Z");
  const out = [];
  let px = 4050;
  for (let i = 0; i < 60; i++) {
    const d = [1.2, -1.0, 0.8, -1.1, 1.3, -0.9][i % 6];
    const o = r2(px), c = r2(px + d);
    const t = fri + i * M1;
    out.push({ t, o, h: r2(Math.max(o, c) + 0.8), l: r2(Math.min(o, c) - 0.8), c, s: 25, r: i === 59 && !contiguous ? sun + 40_000 : t + M1 + 1300 });
    px = c;
  }
  const moves = [-3, -4, 1.5, -5, -6, 2, -7, -6, 3, -8, -7, 4, -8, -6, 3, -7, -8, 2, -6, -7, 3, -8, -6, 2, -7, -6, 3, -5, -6, 2];
  const base = contiguous ? fri + 60 * M1 : sun;
  px = r2(px - 6);
  moves.forEach((d, i) => {
    const grow = Math.min(1 + 0.19 * i, 2.9);
    const o = r2(px), c = r2(px + d);
    const t = base + i * M1;
    out.push({ t, o, h: r2(Math.max(o, c) + 0.8 * grow), l: r2(Math.min(o, c) - 0.8 * grow), c, s: contiguous ? 25 : 60, r: t + M1 + 1300 });
    px = c;
  });
  return out;
}
export const reopenLong = Object.freeze({ ticket: 404, side: "BUY", open_price: 4000, sl: 3940, tp: 4100, opened_ms: Date.parse("2026-11-20T18:00:00Z"), volume: 0.01, intent_id: "open:4:B", magic: 920200, source: "omega" });
export const reopenLongMeta = Object.freeze({ mode: "intraday", r_dist: 60, tp1: 4100, orig_sl: 3940 });
