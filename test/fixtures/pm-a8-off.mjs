// ADR-0020 Amendment 8 switched off (docs/RFC_PM_A8.md): the Position Manager and Omega's handling of its actions must
// give exactly what they gave before the amendment. Generated here deterministically:
//   facts     positionFacts over BUY and SELL positions, prices across the bands, with and without the TP ladder;
//   actions   positionAction of each with every council answer and a silent council;
//   messages  the council's messages and schema for a few of them;
//   intents   positionManagerIntents over closes, locks, TP2 and TP2 with break-even, on OmegaExecutor 1.17 and 1.18;
//   plans     planIntents with Position Manager actions, the settings with the switch absent or false.
// test/position-manager-a8.test.mjs hashes the outputs and compares them with the hashes taken before the amendment.
// `profitLockGate` (SLG1, 2026-11-23): "on" (the default) gives positionFacts a gate with no measurement (closed: the
// fixtures carry no bars) and positionManagerIntents no gate facts; "legacy" is the code before the gate byte for byte.
import { positionFacts as positionFactsOf, positionAction, positionCouncilMessages, cleanCouncil, POSITION_COUNCIL_SCHEMA } from "../../src/position-manager.mjs";
import { positionManagerIntents, planIntents, OMEGA_DEFAULTS } from "../../src/omega-engine.mjs";

const sym = (bid, extra = {}) => ({ bid, ask: Math.round((bid + 0.2) * 100) / 100, point: 0.01, digits: 2, spread_points: 20, stops_level_points: 0, ...extra });
const decision = (over = {}) => ({ stance: "SELL", quorum: { long_share: 0.05, short_share: 0.9 }, quorum_prev: { long_share: 0.05, short_share: 0.9 },
  agent_confidence: { zone_pullback: { long: 0.3, short: 0.8 } }, agent_confidence_prev: { zone_pullback: { long: 0.3, short: 0.8 } }, trading_mode: "intraday", ...over });
const SELL = { ticket: 101, side: "SELL", open_price: 3880, sl: 3890, tp: 3870, volume: 0.01, intent_id: "open:1:S", magic: 920200, source: "omega" };
const BUY = { ticket: 202, side: "BUY", open_price: 3880, sl: 3870, tp: 3890, volume: 0.02, intent_id: "open:2:B", magic: 920200, source: "omega" };
const intentOf = (p, over = {}) => ({ tp: p.tp, sl: p.sl, entry: p.open_price, strategy: "zone_pullback", mode: "intraday", r_dist: 10, ...over });
const levels = [{ low: 3850, high: 3852 }, { low: 3860, high: 3862 }, { low: 3895, high: 3897 }, { low: 3905, high: 3907 }];
const COUNCILS = [null,
  { momentum: "strengthening", thesis: "intact", reason: "r" }, { momentum: "holding", thesis: "intact", reason: "r" },
  { momentum: "holding", thesis: "weakening", reason: "r" }, { momentum: "weakening", thesis: "weakening", reason: "r" },
  { momentum: "weakening", thesis: "broken", reason: "r" }];
const DECISIONS = [decision(), decision({ stance: "BUY" }), decision({ stance: "WAIT" }),
  decision({ agent_confidence: { zone_pullback: { long: 0.6, short: 0.6 } } }), decision({ quorum: { long_share: 0.3, short_share: 0.6 } })];

/** The facts of every case: [name, facts]. */
export function factCases({ profitLockGate = OMEGA_DEFAULTS.profit_lock_gate } = {}) {
  const positionFacts = (input) => positionFactsOf({ ...input, ...(profitLockGate === "legacy" ? {} : { gate: null }) });
  const out = [];
  const sellBids = [3890.5, 3883, 3882.8, 3879.5, 3878.8, 3876.3, 3874, 3870.5, 3866.8, 3860];
  const buyBids = [3869.5, 3877, 3875, 3880.5, 3881.4, 3883.8, 3886, 3889.5, 3893.4, 3900];
  for (const [p, bids] of [[SELL, sellBids], [BUY, buyBids]]) {
    for (const bid of bids) {
      for (const ladder of [false, true]) {
        for (const [di, dec] of DECISIONS.entries()) {
          for (const over of [{}, { sl: p.side === "SELL" ? 3879.5 : 3880.5 }, { sl: p.side === "SELL" ? 3876.5 : 3883.5 }, { tp: p.side === "SELL" ? 3862 : 3895 }]) {
            const position = { ...p, ...over };
            const f = positionFacts({ position, sym: sym(bid), openIntent: intentOf(p), levels, decision: dec, ladder, signal: null });
            out.push([`${p.side}:${bid}:${ladder}:${di}:${JSON.stringify(over)}`, f]);
          }
        }
      }
    }
  }
  // Inputs missing, a delegated position's intent without a stop distance, other modes.
  out.push(["no_decision", positionFacts({ position: SELL, sym: sym(3876), openIntent: intentOf(SELL), levels, decision: null })]);
  out.push(["no_tp1", positionFacts({ position: SELL, sym: sym(3876), openIntent: { strategy: null }, levels, decision: decision() })]);
  out.push(["no_r", positionFacts({ position: SELL, sym: sym(3876), openIntent: { tp: 3870, entry: 3880, sl: null, strategy: null }, levels, decision: decision() })]);
  for (const mode of ["scalp", "swing", "range", "nonsense"]) out.push([`mode_${mode}`, positionFacts({ position: SELL, sym: sym(3876.3), openIntent: intentOf(SELL, { mode }), levels, decision: decision() })]);
  return out;
}

/** Everything the amendment must leave as it was with its switch off. */
export function pmOffOutputs({ profitLockGate = OMEGA_DEFAULTS.profit_lock_gate } = {}) {
  const facts = factCases({ profitLockGate });
  const legacy = profitLockGate === "legacy";
  const actions = [];
  for (const [name, f] of facts) for (const [ci, c] of COUNCILS.entries()) actions.push([`${name}|${ci}`, positionAction(f, c)]);
  const messages = facts.filter((_, i) => i % 37 === 0).map(([name, f]) => [name, f ? positionCouncilMessages(f, { m5: { m5_atr: 2, m5_swing_low: 3870, m5_swing_high: 3890, m5_buy: false, m5_sell: true }, levels }) : null]);
  const cleaned = [{ momentum: "holding", thesis: "intact", reason: "x".repeat(300) }, { momentum: "up", thesis: "intact" }, { momentum: "weakening", thesis: "broken", reason: null, stop: "loosen" }, null].map(cleanCouncil);
  const intents = [];
  const positions = [SELL, BUY, { ...SELL, ticket: 303, sl: 3879.5 }, { ...BUY, ticket: 404, magic: 0, source: "manual", intent_id: null }, { ...BUY, ticket: 505, delegated: true, intent_id: "deleg:505" }];
  const acts = [
    { id: "pm:101:7000", ticket: 101, action: "sl", rule: "breakeven", sl: 3879.8 },
    { id: "pm:101:7001", ticket: 101, action: "sl", rule: "lock_tp1", sl: 3895 },
    { id: "pm:202:7000", ticket: 202, action: "tp", rule: "tp2_target", tp: 3895 },
    { id: "pm:202:7001", ticket: 202, action: "tp", rule: "tp2_target", tp: 3885 },
    { id: "pm:202:7002", ticket: 202, action: "tp", rule: "tp2_breakeven", tp: 3895, sl: 3880.2 },
    { id: "pm:202:7003", ticket: 202, action: "tp", rule: "tp2_breakeven", tp: 3895, sl: 3869 },
    { id: "pm:303:7000", ticket: 303, action: "tp", rule: "tp2_breakeven", tp: 3862, sl: 3879.8 },
    { id: "pm:303:7001", ticket: 303, action: "sl", rule: "breakeven", sl: 3881 },
    { id: "pm:404:7000", ticket: 404, action: "close", rule: "cut_loss" },
    { id: "pm:505:7000", ticket: 505, action: "sl", rule: "breakeven", sl: 3880.2 },
    { id: "pm:606:7000", ticket: 606, action: "close", rule: "cut_loss" },
    { id: "pm:101:7002", ticket: 101, action: "close", rule: "take_profit_weakening" },
    { id: "pm:202:7004", ticket: 202, action: "hold", rule: "x" }
  ];
  for (const bid of [3876.1, 3883.8, 3882, 3895]) {
    for (const sltp of [false, true]) {
      for (const skip of [[], [101]]) intents.push(positionManagerIntents({ positions, sym: sym(bid), actions: acts, skipTickets: skip, sltp, ...(legacy ? {} : { gates: {} }) }));
    }
  }
  intents.push(positionManagerIntents({ positions, sym: {}, actions: acts, ...(legacy ? {} : { gates: {} }) }));
  const plans = [];
  const executor = (bid, version = "1.21") => ({ connected: true, received_ms: 1_000, positions, executor: { version }, account: { trade_mode: "demo", equity: 10_000, day_start_balance: 10_000 }, symbol: { ...sym(bid), atr_value: 4, tick_size: 0.01, tick_value: 1 } });
  const KL = { feed_basis: 0, feed_basis_known: true, key_levels: levels.map((z) => `${z.low}:${z.high}`).join(","), power: 0.6, power_ms: 1_000, m5_atr: 2, side: "NONE" };
  for (const settings0 of [{ ...OMEGA_DEFAULTS, enabled: true }, { ...OMEGA_DEFAULTS, enabled: true, tp_ladder: false }, { enabled: true, pm_loosen_enabled: false }, { enabled: true, tp_ladder: false, pm_loosen_enabled: false }]) {
    const settings = legacy ? { ...settings0, profit_lock_gate: "legacy" } : settings0;
    for (const bid of [3876.1, 3883.8]) {
      for (const version of ["1.17", "1.21"]) {
        // OMEGA_DEFAULTS carries the switch (false) since the amendment; the other two pass it explicitly.
        plans.push(planIntents({ executor: executor(bid, version), now: 1_000, engineEnabled: true, settings, signal: KL, pmActions: acts, positionMeta: { "open:1:S": { mode: "intraday", r_dist: 10 }, "open:2:B": { mode: "scalp", r_dist: 10 } } }));
      }
    }
  }
  return { facts, actions, messages, schema: POSITION_COUNCIL_SCHEMA, cleaned, intents, plans };
}
