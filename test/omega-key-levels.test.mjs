// Owner 2026-11-12: "apakah di omega chart bisa ditampilkan key level yang diambil dari war room ?" → "kerjakan
// sekarang, tampilan sesuai usulan". The Omega chart draws the War Room's six candidate zones nearest to price
// (one shared selection), coloured by role, shaded by strength, behind a toggle; since 2026-11-12 as transparent
// blocks, not lines ("jangan berupa garis supaya tidak ambigu dengan garis posisi").
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

test("K3. the Omega chart draws each zone as a transparent block, never a line, behind a Key Levels toggle, and says which prices they are on", () => {
  // Owner 2026-11-12: "ubah key level di chart omega menjadi block zone transparans, jangan berupa garis supaya tidak
  // ambigu dengan garis posisi".
  const omega = ui("pages/Omega.tsx");
  assert.match(omega, /const \[showKeyLevels, setShowKeyLevels\] = useState\(true\)/, "on by default");
  assert.match(omega, /Key Levels \(\{keyZones\.length\}\)/);
  assert.match(omega, /series\.attachPrimitive\(bands\)/);
  assert.match(omega, /bandsRef\.current\?\.setZones\(showKeyLevels \? keyZones\.map/);
  assert.match(omega, /KEY_STRENGTH_FILL/);
  assert.doesNotMatch(omega, /addLine\(z\.(high|low)/, "no zone is a price line");
  assert.doesNotMatch(omega, /LargeDashed/);
  assert.match(omega, /on feed prices \(OANDA\); broker prices may differ/);
  assert.match(omega, /showKeyLevels, keyZones|keyZones, showKeyLevels\]\);/, "the blocks redraw when the zones change");
});

test("K4. the blocks: a translucent band from low to high behind the candles, a thin zone still visible, its label inside or above", async () => {
  const { KeyZoneBands } = await import("../workers/xauusd-nexus-dashboard/ui/src/lib/keyZoneBands.ts");
  const bands = new KeyZoneBands();
  let updates = 0;
  // 1 price unit = 10 px, price 4000 at y 200; pixel ratio 2.
  bands.attached({ series: { priceToCoordinate: (p) => 200 - (p - 4000) * 10 }, requestUpdate: () => { updates += 1; } });
  bands.setZones([
    { low: 4010, high: 4012, fill: "rgba(248, 81, 73, 0.2)", text: "rgba(248, 81, 73, 0.85)", label: "KL R · strong" },
    { low: 3999.9, high: 4000, fill: "rgba(34, 211, 238, 0.13)", text: "rgba(34, 211, 238, 0.85)", label: "KL at price · medium" }
  ]);
  assert.equal(updates, 1, "a new set redraws the chart");
  const [view] = bands.paneViews();
  assert.equal(view.zOrder(), "bottom", "behind the candles");
  const ops = [];
  const ctx = { set fillStyle(v) { ops.push(["style", v]); }, set font(v) {}, set textBaseline(v) { ops.push(["baseline", v]); }, fillRect: (...a) => ops.push(["rect", ...a]), fillText: (t, x, y) => ops.push(["text", t, x, y]) };
  const target = { useBitmapCoordinateSpace: (f) => f({ context: ctx, bitmapSize: { width: 1000, height: 800 }, verticalPixelRatio: 2, horizontalPixelRatio: 2 }) };
  const r = view.renderer();
  r.draw(target);
  assert.equal(ops.length, 0, "nothing in the foreground");
  r.drawBackground(target);
  const rects = ops.filter((o) => o[0] === "rect");
  assert.deepEqual(rects[0], ["rect", 0, 160, 1000, 40], "4012-4010: y 80-100 css, 160-200 bitmap, the pane's whole width");
  assert.deepEqual(rects[1], ["rect", 0, 398, 1000, 6], "a 1-px zone (y 200-201) is drawn 3 px tall around it (199-202)");
  assert.deepEqual(ops.filter((o) => o[0] === "baseline").map((o) => o[1]), ["top", "bottom"], "the label inside a tall band, above a thin one");
  assert.ok(ops.some((o) => o[0] === "style" && o[1] === "rgba(248, 81, 73, 0.2)"), "translucent fill");
  bands.detached();
  ops.length = 0;
  r.drawBackground(target);
  assert.equal(ops.length, 0, "detached: nothing drawn");
});
