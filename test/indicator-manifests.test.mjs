import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { MANIFESTS, HUD_MANIFESTS, MANIFEST_FAMILIES, manifestOf } from "../src/indicator-manifests.mjs";
import { HUD_IDS, HUD_NAMES } from "../src/hud-reading.mjs";
import { AGENT_FAMILIES } from "../src/reputation.mjs";
import { TF_DESKS } from "../src/timeframe-threads.mjs";
import { DESK_AGENTS } from "../src/war-room.mjs";
import { registryEntry, lifecycleOf } from "../src/indicator-registry.mjs";
import { ENGINE_FAMILIES } from "../src/shadow-versions.mjs";

test("P2: one manifest per agent; the HUD roster and the agent families are generated from them", () => {
  const ids = MANIFESTS.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  assert.deepEqual(HUD_IDS, HUD_MANIFESTS.map((x) => x.id));
  assert.equal(HUD_IDS.length, 16, "14 HUD sections + the P6 indicator agents");
  assert.deepEqual(HUD_IDS.slice(-2), ["supertrend", "order_blocks"]);
  assert.equal(HUD_NAMES.kinetic_engine, "Kinetic Engine (TVA)");
  assert.equal(AGENT_FAMILIES, MANIFEST_FAMILIES);
  // Every room agent of the code has a manifest.
  for (const id of [...Object.keys(TF_DESKS), ...Object.keys(DESK_AGENTS), "moderator"]) assert.ok(manifestOf(id), id);
  for (const x of MANIFESTS) {
    assert.ok(["engine", "library", "hud", "indicator", "desk", "moderator"].includes(x.kind), x.id);
    assert.ok(["pine_ssot", "pine_candidate", "builtin", "none"].includes(x.reference), x.id);
    if (x.source?.pine) assert.ok(existsSync(new URL("../" + x.source.pine, import.meta.url)), x.source.pine);
    // A shadow family runs its control even when it has no candidate (prophet_r38 after the P5 review).
    if (x.shadow_family) assert.ok(x.shadow_family in ENGINE_FAMILIES, x.shadow_family);
  }
  assert.equal(manifestOf("grid_bot_protocol").computed, true, "ported 2026-11-07");
  assert.equal(manifestOf("supertrend").reference, "builtin");
});

test("the registry: lifecycle from the H1 parity identity; parity, scorecards, stuck states and shadow versions per agent", () => {
  const rows = [
    { engine: "prophet", status: "approved", consecutive_matches: 30 }, { engine: "prophet_m15", status: "approved", consecutive_matches: 40 },
    { engine: "prophet_h4", status: "candidate", consecutive_matches: 3 }, { engine: "prophet_hud", status: "candidate", consecutive_matches: 0 },
    { engine: "gmi", status: "revoked", consecutive_matches: 0 }
  ];
  const cards = [
    { subject: "indicator:prophet_r38", timeframe: "60", n: 40, directional: { hit_rate: 0.55 }, wait: { accuracy: 0.6 }, brier: 0.2 },
    { subject: "agent:fabio_amt", timeframe: "15", n: 30, directional: { hit: 12, miss: 8, neutral: 2 }, wait: { hit: 6, missed_opportunity: 2 }, brier: 0.21 }
  ];
  const stuck = [{ field: "prophet_r38.t_enc", status: "open", candles: 9, price_range: 40, atr: 10 }, { field: "gmi_v12_70.gate", status: "closed" }];
  const r38 = registryEntry(manifestOf("prophet_r38"), { registryRows: rows, cards, stuck });
  assert.equal(r38.lifecycle, "active");
  assert.deepEqual(r38.parity.map((p) => [p.engine, p.chart, p.status]), [["prophet", "H1", "approved"], ["prophet_m15", "M15", "approved"], ["prophet_h4", "H4", "candidate"]]);
  assert.deepEqual(r38.hud_parity.map((p) => p.engine), ["prophet_hud"], "prophet_hud is its own identity, not a scope of prophet");
  assert.equal(r38.scorecards.indicator[0].hit_rate, 0.55);
  assert.equal(r38.stuck_states.length, 1);
  assert.deepEqual(r38.shadow_versions, [], "prophet_r38@latch8 was stopped at the P5 review");
  assert.deepEqual(registryEntry(manifestOf("prophet_r37")).shadow_versions.map((v) => v.id), ["prophet_r37@latch8"]);
  const gmi = registryEntry(manifestOf("gmi_v12_70"), { registryRows: rows, cards, stuck });
  assert.equal(gmi.lifecycle, "candidate", "a revoked H1 identity is a candidate again");
  assert.equal(gmi.stuck_states.length, 0, "a closed stuck state is not shown");
  const fabio = registryEntry(manifestOf("fabio_amt"), { registryRows: rows, cards, stuck });
  assert.deepEqual(fabio.scorecards.agent.map((a) => [a.room, a.decisive]), [["M15", 28], ["H1", 0]]);
  assert.equal(registryEntry({ ...manifestOf("grid_bot_protocol"), computed: false }, {}).lifecycle, "not_computed");
  assert.equal(lifecycleOf(manifestOf("risk"), []), "active");
});
