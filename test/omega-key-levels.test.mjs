// Owner 2026-11-12: "apakah di omega chart bisa ditampilkan key level yang diambil dari war room ?" → "kerjakan
// sekarang, tampilan sesuai usulan". The Omega chart draws the War Room's six candidate zones nearest to price
// (one shared selection), each as its upper and lower edge, coloured by role, shaded by strength, behind a toggle.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nearestCandidates, withAlpha } from "../workers/xauusd-nexus-dashboard/ui/src/lib/keyZones.ts";

const ui = (p) => readFileSync(new URL(`../workers/xauusd-nexus-dashboard/ui/src/${p}`, import.meta.url), "utf8");

test("K1. the six candidates nearest to price, listed highest first; nothing without a price", () => {
  const z = (low, high, role = "support") => ({ low, high, price: (low + high) / 2, role, strength: "medium" });
  const k = { price: 4100, candidates: [z(4000, 4002), z(4098, 4099), z(4101, 4103, "resistance"), z(4110, 4111, "resistance"), z(4090, 4092), z(4120, 4121, "resistance"), z(4080, 4081), z(4200, 4201, "resistance"), { low: "x", high: 1 }] };
  const out = nearestCandidates(k, 6);
  assert.equal(out.length, 6);
  assert.deepEqual(out.map((x) => x.low), [4120, 4110, 4101, 4098, 4090, 4080], "nearest six, highest first; the far and malformed zones are dropped");
  assert.deepEqual(nearestCandidates({ candidates: [z(1, 2)] }), []);
  assert.deepEqual(nearestCandidates(null), []);
  assert.equal(withAlpha("#34d399", 0.5), "rgba(52, 211, 153, 0.5)");
});

test("K2. the War Room panel and the Omega chart use the same selection", () => {
  assert.match(ui("components/KeyLevels.tsx"), /nearestCandidates\(k, 6\)/);
  const omega = ui("pages/Omega.tsx");
  assert.match(omega, /get<any>\("\/api\/conclusion\/global"\)/);
  assert.match(omega, /nearestCandidates\(r\?\.global\?\.strategy\?\.key_levels, 6\)/);
});

test("K3. the Omega chart draws each zone's edges behind a Key Levels toggle and says which prices they are on", () => {
  const omega = ui("pages/Omega.tsx");
  assert.match(omega, /const \[showKeyLevels, setShowKeyLevels\] = useState\(true\)/, "on by default");
  assert.match(omega, /Key Levels \(\{keyZones\.length\}\)/);
  assert.match(omega, /addLine\(z\.high, label, color, LineStyle\.LargeDashed, 1\)/);
  assert.match(omega, /if \(z\.low !== z\.high\) addLine\(z\.low, "", color/);
  assert.match(omega, /KEY_STRENGTH_ALPHA/);
  assert.match(omega, /on feed prices \(OANDA\); broker prices may differ/);
  assert.match(omega, /showKeyLevels, keyZones|keyZones, showKeyLevels\]\);/, "the lines redraw when the zones change");
});
