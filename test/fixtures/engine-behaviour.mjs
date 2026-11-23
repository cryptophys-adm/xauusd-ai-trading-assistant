// The engine's behaviour fingerprint (src/ledger-omega4.mjs ENGINE_BEHAVIOUR_HASH): the live engine's outputs over the
// committed fixtures with every switch at its default (OMEGA_DEFAULTS; ERA_SWITCHES all off), written one line each.
// Only tests import it, so the Worker bundle does not carry the fixtures. Three sets, reused as they are:
//   market   planIntents over the market path's hand inputs, and v4's replay traces and records over its replay
//            scenarios (test/fixtures/omega-market-path.mjs; the scenario with entry_order "limit" is left out);
//   pm       positionFacts, positionAction, the council's messages, schema and cleaning, positionManagerIntents and
//            planIntents with Position Manager actions, ADR-0020 Amendment 8 switched off (test/fixtures/pm-a8-off.mjs);
//   v4       replayOmega4's traces and records over the v4 replay fixtures (test/fixtures/omega-v4-replay.mjs).
//   liquidity planIntents over the market path's hand inputs with the liquidity lens on (its default) and the live
//            spread at 3x the hour's norm (the spread-spike gate and the modification deferral), and at 1x (no effect),
//            docs/RFC_POSITIONING_LIQUIDITY.md §5-§6.
//   gate     planIntents over the hand inputs with every position's profit-lock gate open (SLG1, the gate on), and v4's
//            replay of a peak past the gate that pulls back inside the band (the gate as the break-even's trigger).
//   change   CH1's cases (test/fixtures/change-thresholds.mjs): the Position Manager's rules over decision histories that
//            confirm or do not confirm a change, Omega's confidence exits and extend gate, a resting limit's share
//            cancel. Written with the change thresholds on only (with "off" the text is the engine's before CH1).
// Only outputs are written, never the inputs: a new switch added to OMEGA_DEFAULTS at its default leaves the text as is.
// `profitLockGate` (SLG1, 2026-11-23) sets profit_lock_gate on every input after the defaults check: "legacy" gives the
// text of the engine before the gate byte for byte (its hash is the old ENGINE_BEHAVIOUR_HASH, test V14b).
// `changeThresholds` (CH1, 2026-11-23) sets change_thresholds on every input the same way (and the Position Manager's
// facts get the tokens as the runner passes them): "" or "off" gives the text of the engine before CH1 byte for byte
// (SLG1's 94e6f50c… with the gate on; test/change-thresholds.test.mjs).
//   fast     PM-1M's cases (test/fixtures/pm-fast.mjs): the 1m layer's triggers and noise rules, Omega's check of its
//            actions, and v4's replay of a position the layer protects. Written with the layer on only.
// `pmFast` (PM-1M, 2026-11-23) sets pm_fast_1m on every input the same way: "off" gives the text of the engine before
// PM-1M byte for byte (CH1's 169243f2…; test/pm-fast.test.mjs).
//   re       RE1's cases (test/fixtures/reentry-1m.mjs): the eligibility of exits, the re-entry's check over its
//            guards, its triggers through planIntents' opening checks, and v4's replay of a break-even stop re-entered.
//            Written with the re-entry on only.
// `reentry` (RE1, 2026-11-23) sets reentry_1m on every input the same way: "off" gives the text of the engine before
// RE1 byte for byte (PM-1M's d0def5bb…; test/reentry-1m.test.mjs).
//   ss       SS1's cases (test/fixtures/limit-supersede.mjs): today's 14:00 and 14:15 BUYs through planIntents under
//            entry_order "limit" and "council" (each refusal, the open position, the other side, a refused and an
//            unanswered delete), and the limit counterfactual beside v4 over the two decisions. Written with the
//            supersede on only.
// `limitSupersede` (SS1, 2026-11-23) sets limit_supersede on every input the same way: "off" gives the text of the
// engine before SS1 byte for byte (RE1's 39c10287…; test/limit-supersede.test.mjs).
import { planIntents } from "../../src/omega-engine.mjs";
import { replayOmega4, eraSwitches } from "../../src/ledger-omega4.mjs";
import { handInputs, replayScenarios } from "./omega-market-path.mjs";
import { pmOffOutputs } from "./pm-a8-off.mjs";
import { v4ReplayScenarios, base, retraceCase } from "./omega-v4-replay.mjs";
import { changeLines } from "./change-thresholds.mjs";
import { fastLines } from "./pm-fast.mjs";
import { reentryLines } from "./reentry-1m.mjs";
import { supersedeLines } from "./limit-supersede.mjs";

const atDefaults = (name, settings) => {
  const on = eraSwitches(settings);
  if (on.length) throw new Error(`${name}: a behaviour switch is on (${on.join(", ")}); the fingerprint is taken with every switch at its default`);
};
let changeOverride = null, fastOverride = null, reOverride = null, ssOverride = null;
const withGate = (settings, gate) => {
  const s = gate ? { ...settings, profit_lock_gate: gate } : settings;
  const c = changeOverride != null ? { ...s, change_thresholds: changeOverride } : s;
  const f = fastOverride != null ? { ...c, pm_fast_1m: fastOverride } : c;
  const r = reOverride != null ? { ...f, reentry_1m: reOverride } : f;
  return ssOverride != null ? { ...r, limit_supersede: ssOverride } : r;
};
const replayLines = (group, scenarios, gate = null) => {
  const lines = [];
  for (const s of scenarios) {
    atDefaults(`${group}/${s.name}`, s.opts.settings);
    const trace = [];
    const run = replayOmega4({ ...s.opts, settings: withGate(s.opts.settings, gate), trace });
    lines.push(`${group}/${s.name}/trace=${JSON.stringify(trace.map((t) => [t.now, t.output]))}`);
    lines.push(`${group}/${s.name}/records=${JSON.stringify(run.records)}`);
    lines.push(`${group}/${s.name}/work=${JSON.stringify([run.steps, run.plans, run.pm_calls, run.open_positions])}`);
  }
  return lines;
};

/** The text ENGINE_BEHAVIOUR_HASH is taken of (sha256Hex of it). */
export function engineBehaviourSource({ profitLockGate = null, changeThresholds = null, pmFast = null, reentry = null, limitSupersede = null } = {}) {
  changeOverride = changeThresholds == null ? null : changeThresholds === "" ? "off" : changeThresholds;
  fastOverride = pmFast == null ? null : pmFast;
  reOverride = reentry == null ? null : reentry;
  ssOverride = limitSupersede == null ? null : limitSupersede;
  try { return behaviourText(profitLockGate); } finally { changeOverride = null; fastOverride = null; reOverride = null; ssOverride = null; }
}
function behaviourText(profitLockGate) {
  const lines = [];
  for (const [name, input] of handInputs()) {
    atDefaults(`market/${name}`, input.settings);
    lines.push(`market/hand/${name}=${JSON.stringify(planIntents({ ...input, settings: withGate(input.settings, profitLockGate) }))}`);
  }
  lines.push(...replayLines("market/replay", replayScenarios().filter((s) => !eraSwitches(s.opts.settings).length), profitLockGate));
  const pm = pmOffOutputs({ ...(profitLockGate ? { profitLockGate } : {}), ...(changeOverride != null ? { changeThresholds: changeOverride } : {}) });
  for (const part of ["facts", "actions", "messages", "schema", "cleaned", "intents", "plans"]) lines.push(`pm/${part}=${JSON.stringify(pm[part])}`);
  lines.push(...replayLines("v4", v4ReplayScenarios(), profitLockGate));
  for (const [ratio, tag] of [[3, "spike"], [1, "calm"]]) {
    for (const [name, inputRaw] of handInputs()) {
      const input = { ...inputRaw, settings: withGate(inputRaw.settings, profitLockGate) };
      const sp = Number(input.executor?.symbol?.spread_points);
      if (!input.signal || !(sp > 0)) continue;
      const signal = { ...input.signal, liquidity_on: true, liquidity_weight: 0.3, liquidity_spread_median: sp / ratio, liquidity_spread_widen: 2, liquidity_levels: "" };
      lines.push(`liquidity/${tag}/${name}=${JSON.stringify(planIntents({ ...input, signal, liquiditySpikeSince: input.now }))}`);
    }
  }
  // SLG1 (2026-11-23): with the profit-lock gate on (its default), the hand inputs with every position's gate open: the
  // locks made at the gate (its first lock, SL+ and the ladder past it) and the MFE they record. Not written for "legacy".
  if (profitLockGate !== "legacy") {
    for (const [name, input] of handInputs()) {
      const ps = Array.isArray(input.executor?.positions) ? input.executor.positions : [];
      if (!ps.length) continue;
      const gates = Object.fromEntries(ps.map((p) => [String(p.ticket), { open: true, mfe_r: 1.25, mfe_atr: 1.5 }]));
      lines.push(`gate/open/${name}=${JSON.stringify(planIntents({ ...input, settings: withGate(input.settings, profitLockGate), gates }))}`);
    }
    // The gate as the break-even's trigger (#535 review): a peak past the gate, back inside the band at the next run.
    lines.push(...replayLines("gate/retrace", [{ name: "retrace", opts: { ...base(), ...retraceCase() } }], profitLockGate));
  }
  // CH1 (2026-11-23): the change thresholds' own cases, only with them on (they are absent from the text before CH1).
  if (changeOverride !== "off") lines.push(...changeLines(changeOverride ?? undefined));
  // PM-1M (2026-11-23): the 1m layer's own cases, only with it on (they are absent from the text before PM-1M).
  if (fastOverride !== "off") lines.push(...fastLines());
  // RE1 (2026-11-23): the re-entry's own cases, only with it on (they are absent from the text before RE1).
  if (reOverride !== "off") lines.push(...reentryLines());
  // SS1 (2026-11-23): the supersede's own cases, only with it on (they are absent from the text before SS1).
  if (ssOverride !== "off") lines.push(...supersedeLines());
  return lines.join("\n");
}
