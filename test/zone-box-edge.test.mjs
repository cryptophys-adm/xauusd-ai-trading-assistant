// ZF1 (owner 2026-11-25: "ZF1 tepi kotak"): a box types the cluster its own edge made, although the cluster's edges are
// rounded to two decimals (the two live misses of 2026-11-25, Z6 diagnosis). A box that only touches a cluster it did not
// make still does not type it (Z0-4, Z1b-2).
import test from "node:test";
import assert from "node:assert/strict";
import { boxTypes, BOX_EDGE_TOL, zoneTypes } from "../src/zone-types.mjs";
import { clusterLevels } from "../src/key-level-agent.mjs";

const member = (price, label = "level") => ({ price, label, kind: "pivot", weight: 1 });

test("ZF1-1 the two live edge misses type their cluster: the box's own edge is one of the cluster's members", () => {
  assert.equal(BOX_EDGE_TOL, 0.001);
  // 15m whale demand 3433.454–3438.5; its bottom made the top of the cluster [3428.10, 3433.45].
  const z15 = { low: 3428.1, high: 3433.45, members: [member(3428.1), member(3433.454, "15m whale demand bottom")] };
  assert.equal(boxTypes({ bottom: 3433.454, top: 3438.5 }, z15), true);
  // 4H whale 3531.643–3540 against [3525.20, 3531.64].
  const z4h = { low: 3525.2, high: 3531.64, members: [member(3525.2), member(3531.643, "4H whale bottom")] };
  assert.equal(boxTypes({ bottom: 3531.643, top: 3540 }, z4h), true);
  // From the other side: a box whose top made the cluster's bottom.
  assert.equal(boxTypes({ bottom: 3400, top: 3420.004 }, { low: 3420, high: 3426, members: [member(3420.004), member(3426)] }), true);
  // A point at a member price.
  assert.equal(boxTypes({ point: true, bottom: 3433.454 }, z15), true);
});

test("ZF1-2 the clustering the agent runs: the box edge it rounds out of the band types it again", () => {
  const [z] = clusterLevels([member(3428.1), member(3430.2), member(3433.454)], 10);
  assert.deepEqual([z.low, z.high], [3428.1, 3433.45], "the band is rounded below the member");
  const evidence = { boxes: [{ source: "whale", tf: "15", side: "demand", weight: 0.9, bottom: 3433.454, top: 3438.5 }], bars: [], atr_h1: null };
  const [typed] = zoneTypes([{ ...z }], evidence);
  assert.deepEqual([typed.ds.type, typed.ds.sources], ["demand", ["whale@15m"]]);
});

test("ZF1-3 a box that did not make the cluster still needs a strict overlap", () => {
  const z = { low: 3428.1, high: 3433.45, members: [member(3428.1), member(3433.45)] };
  assert.equal(boxTypes({ bottom: 3433.45, top: 3438.5 }, { low: 3428.1, high: 3433.45 }), false, "touching, no members: as before");
  assert.equal(boxTypes({ bottom: 3433.47, top: 3438.5 }, z), false, "2 cents above, not a member");
  assert.equal(boxTypes({ bottom: 3433.4525, top: 3438.5 }, { ...z, members: [member(3433.454)] }), false, "just over the tolerance");
  assert.equal(boxTypes({ bottom: 3430, top: 3440 }, z), true, "a strict overlap still types");
  assert.equal(boxTypes({ point: true, bottom: 3433.5 }, z), false);
  assert.equal(boxTypes({ point: true, bottom: 3433.45 }, z), true, "a point on the edge is inside, as before");
  assert.equal(boxTypes({ at_price: true }, { ...z, role: "at price" }), true);
  assert.equal(boxTypes({ at_price: true }, { ...z, role: "support" }), false);
});

test("ZF1-4 the zone fixture: the four Z0 zones a box's own edge now types (the pins of ZA-15, ZA-18, Z1a-7, Z1b-5 move with them)", async () => {
  const se = await import("../src/strategy-engine.mjs");
  const { zoneInputs } = await import("./support/zone-types-fixture.mjs");
  const row = (s, low) => { const z = s.key_levels.zones.find((x) => x.low === low).ds; return [z.type, z.strength, z.sources]; };
  const z0 = se.buildStrategy(zoneInputs());
  // Before ZF1: supply/medium [prophet_best@4H]; none; supply/strong without whale@15m; none.
  assert.deepEqual(row(z0, 3982), ["supply", "strong", ["prophet_best@4H", "whale@1H"]]);
  assert.deepEqual(row(z0, 3992.5), ["demand", "medium", ["prophet_best@1H"]]);
  assert.deepEqual(row(z0, 4016.92), ["supply", "strong", ["prophet_best@1H", "whale@15m", "whale@1H"]]);
  assert.deepEqual(row(z0, 4023), ["supply", "medium", ["prophet_best@1H"]]);
});
