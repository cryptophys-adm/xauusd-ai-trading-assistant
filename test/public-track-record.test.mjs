// The public track record (owner 2026-11-20): R only, aggregates only, the public delay, the managed exit only on a
// passing replay check, and no forbidden key at any depth.
import test from "node:test";
import assert from "node:assert/strict";
import { publicTrackRecord, summarise, forbiddenKeys, readPublicTrackRecord, resetTrackRecordMemoForTests } from "../src/public-track-record.mjs";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const old = "2026-11-20 10:00:00", fresh = "2026-11-22 08:00:00";
const LEDGER = [
  { opened_at: "2026-11-19 09:00:00", r_tp1: 1, r_tp2: 2, tp1_closed_at: old, tp2_closed_at: old },
  { opened_at: "2026-11-19 10:00:00", r_tp1: -1, r_tp2: -1, tp1_closed_at: old, tp2_closed_at: old },
  { opened_at: "2026-11-19 11:00:00", r_tp1: 0, r_tp2: null, tp1_closed_at: old, tp2_closed_at: null },
  { opened_at: "2026-11-22 07:00:00", r_tp1: 5, r_tp2: 5, tp1_closed_at: fresh, tp2_closed_at: fresh }
];
const MANAGED = [{ issued_ms: Date.parse("2026-11-19T12:00:00Z"), omega4_closed_at: "2026-11-20T09:00:00Z", r_omega4: 0.7 }, { issued_ms: Date.parse("2026-11-22T07:00:00Z"), omega4_closed_at: "2026-11-22T09:00:00Z", r_omega4: -1 }];

test("TR1 the four numbers per scenario, with won, lost and even", () => {
  assert.deepEqual(summarise([1, -1, 0, 2]), { count: 4, won: 2, lost: 1, even: 1, win_rate: 0.5, expectancy_r: 0.5, net_r: 2, avg_win_r: 1.5, avg_loss_r: -1, profit_factor: 3 });
  assert.equal(summarise([]).win_rate, null);
  assert.equal(summarise([1, 2]).profit_factor, null, "no loss: no profit factor");
});

test("TR2 only results closed more than the delay ago count; the base and its date", () => {
  const t = publicTrackRecord({ ledger: LEDGER, managed: MANAGED, parity: { status: "pass" }, now: NOW, delayHours: 24 });
  const [first, second, managed] = t.scenarios;
  assert.equal(first.count, 3, "the 2026-11-22 result is inside the delay");
  assert.equal(second.count, 2, "a plan without a second target is not in TP2");
  assert.equal(first.net_r, 0);
  assert.equal(second.net_r, 1);
  assert.equal(t.count, 3);
  assert.equal(t.since, "2026-11-19");
  assert.equal(managed.shown, true);
  assert.equal(managed.count, 1);
  assert.equal(t.unit, "R");
});

test("TR3 the managed exit is hidden, with no number, until the replay check passes", () => {
  for (const status of ["insufficient", "fail", undefined]) {
    const m = publicTrackRecord({ ledger: LEDGER, managed: MANAGED, parity: status ? { status } : null, now: NOW }).scenarios[2];
    assert.equal(m.shown, false);
    assert.equal(m.count, undefined);
    assert.equal(m.expectancy_r, undefined);
    assert.match(m.note, /replay matches the live account/);
  }
});

test("TR4 no forbidden key at any depth, no Omega and no price-like number", () => {
  const t = publicTrackRecord({ ledger: LEDGER, managed: MANAGED, parity: { status: "pass" }, now: NOW });
  assert.deepEqual(forbiddenKeys(t), []);
  const text = JSON.stringify(t);
  assert.doesNotMatch(text, /omega/i);
  assert.deepEqual(forbiddenKeys({ a: [{ tp1: 1 }] }), ["tp1"]);
});

test("TR5 the reader: D1 and the parity in KV, kept 10 minutes", async () => {
  resetTrackRecordMemoForTests();
  let reads = 0;
  const env = {
    DB: { prepare: (sql) => ({ all: async () => { reads += 1; return { results: /signal_ledger/.test(sql) ? LEDGER : MANAGED }; } }) },
    SIGNAL_CACHE: { get: async () => JSON.stringify({ status: "insufficient" }) }
  };
  const a = await readPublicTrackRecord(env, { now: NOW });
  assert.equal(a.scenarios[0].count, 3);
  assert.equal(a.scenarios[2].shown, false);
  await readPublicTrackRecord(env, { now: NOW + 60_000 });
  assert.equal(reads, 2, "the second call within 10 minutes is the memo");
});
