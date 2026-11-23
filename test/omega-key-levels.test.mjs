// Owner 2026-11-12: "apakah di omega chart bisa ditampilkan key level yang diambil dari war room ?" → "kerjakan
// sekarang, tampilan sesuai usulan". The Omega chart drew the War Room's six candidate zones nearest to price (one shared
// selection) as transparent blocks behind a toggle. OM-LEAN (owner-approved mockup 1795450033-0f25, 2026-11-23) removes
// them from Omega: its chart, now in Details, shows only Omega's own lines (inventory OM-25, OM-51; the War Room keeps the
// key levels). The shared selection stays for the War Room's Key levels panel.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { nearestCandidates } from "../workers/xauusd-nexus-dashboard/ui/src/lib/keyZones.ts";

const ui = (p) => readFileSync(new URL(`../workers/xauusd-nexus-dashboard/ui/src/${p}`, import.meta.url), "utf8");

test("K1. the six candidates nearest to price, listed highest first; nothing without a price", () => {
  const z = (low, high, role = "support") => ({ low, high, price: (low + high) / 2, role, strength: "medium" });
  const k = { price: 4100, candidates: [z(4000, 4002), z(4098, 4099), z(4101, 4103, "resistance"), z(4110, 4111, "resistance"), z(4090, 4092), z(4120, 4121, "resistance"), z(4080, 4081), z(4200, 4201, "resistance"), { low: "x", high: 1 }] };
  const out = nearestCandidates(k, 6);
  assert.equal(out.length, 6);
  assert.deepEqual(out.map((x) => x.low), [4120, 4110, 4101, 4098, 4090, 4080], "nearest six, highest first; the far and malformed zones are dropped");
  assert.deepEqual(nearestCandidates({ candidates: [z(1, 2)] }), []);
  assert.deepEqual(nearestCandidates(null), []);
});

test("K2. the War Room panel keeps the selection; the Omega page no longer reads or draws key levels (OM-LEAN)", () => {
  assert.match(ui("components/KeyLevels.tsx"), /nearestCandidates\(k, 6\)/);
  const omega = ui("pages/Omega.tsx");
  assert.doesNotMatch(omega, /\/api\/conclusion\/global|nearestCandidates|KeyZoneBands|showKeyLevels|Key Levels/, "no key-level read, block or toggle");
  assert.ok(!existsSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/lib/keyZoneBands.ts", import.meta.url)), "the bands primitive went with its only user");
});
