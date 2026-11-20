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
// Only outputs are written, never the inputs: a new switch added to OMEGA_DEFAULTS at its default leaves the text as is.
import { planIntents } from "../../src/omega-engine.mjs";
import { replayOmega4, eraSwitches } from "../../src/ledger-omega4.mjs";
import { handInputs, replayScenarios } from "./omega-market-path.mjs";
import { pmOffOutputs } from "./pm-a8-off.mjs";
import { v4ReplayScenarios } from "./omega-v4-replay.mjs";

const atDefaults = (name, settings) => {
  const on = eraSwitches(settings);
  if (on.length) throw new Error(`${name}: a behaviour switch is on (${on.join(", ")}); the fingerprint is taken with every switch at its default`);
};
const replayLines = (group, scenarios) => {
  const lines = [];
  for (const s of scenarios) {
    atDefaults(`${group}/${s.name}`, s.opts.settings);
    const trace = [];
    const run = replayOmega4({ ...s.opts, trace });
    lines.push(`${group}/${s.name}/trace=${JSON.stringify(trace.map((t) => [t.now, t.output]))}`);
    lines.push(`${group}/${s.name}/records=${JSON.stringify(run.records)}`);
    lines.push(`${group}/${s.name}/work=${JSON.stringify([run.steps, run.plans, run.pm_calls, run.open_positions])}`);
  }
  return lines;
};

/** The text ENGINE_BEHAVIOUR_HASH is taken of (sha256Hex of it). */
export function engineBehaviourSource() {
  const lines = [];
  for (const [name, input] of handInputs()) {
    atDefaults(`market/${name}`, input.settings);
    lines.push(`market/hand/${name}=${JSON.stringify(planIntents(input))}`);
  }
  lines.push(...replayLines("market/replay", replayScenarios().filter((s) => !eraSwitches(s.opts.settings).length)));
  const pm = pmOffOutputs();
  for (const part of ["facts", "actions", "messages", "schema", "cleaned", "intents", "plans"]) lines.push(`pm/${part}=${JSON.stringify(pm[part])}`);
  lines.push(...replayLines("v4", v4ReplayScenarios()));
  for (const [ratio, tag] of [[3, "spike"], [1, "calm"]]) {
    for (const [name, input] of handInputs()) {
      const sp = Number(input.executor?.symbol?.spread_points);
      if (!input.signal || !(sp > 0)) continue;
      const signal = { ...input.signal, liquidity_on: true, liquidity_weight: 0.3, liquidity_spread_median: sp / ratio, liquidity_spread_widen: 2, liquidity_levels: "" };
      lines.push(`liquidity/${tag}/${name}=${JSON.stringify(planIntents({ ...input, signal, liquiditySpikeSince: input.now }))}`);
    }
  }
  return lines.join("\n");
}
