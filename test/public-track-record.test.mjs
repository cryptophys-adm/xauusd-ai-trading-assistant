// The public track record (owner 2026-11-20): R only, aggregates only, the public delay, the managed exit only on a
// passing replay check, and no forbidden key at any depth.
import test from "node:test";
import assert from "node:assert/strict";
import { publicTrackRecord, summarise, forbiddenKeys, readPublicTrackRecord, resetTrackRecordMemoForTests, publicManagedSource } from "../src/public-track-record.mjs";

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
  const t = publicTrackRecord({ ledger: LEDGER, managed: MANAGED, parity: { status: "pass" }, now: NOW, delayHours: 24, source: "v4" });
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

test("TR3 v4: the managed exit is hidden, with no number, until the replay check passes", () => {
  for (const status of ["insufficient", "fail", undefined]) {
    const m = publicTrackRecord({ ledger: LEDGER, managed: MANAGED, parity: status ? { status } : null, now: NOW, source: "v4" }).scenarios[2];
    assert.equal(m.shown, false);
    assert.equal(m.count, undefined);
    assert.equal(m.expectancy_r, undefined);
    assert.match(m.note, /replay matches the live account/);
  }
});

test("TR4 no forbidden key at any depth, no Omega and no price-like number", () => {
  const t = publicTrackRecord({ ledger: LEDGER, managed: MANAGED, parity: { status: "pass" }, now: NOW, source: "v4" });
  assert.deepEqual(forbiddenKeys(t), []);
  const text = JSON.stringify(t);
  assert.doesNotMatch(text, /omega/i);
  assert.deepEqual(forbiddenKeys({ a: [{ tp1: 1 }] }), ["tp1"]);
});

test("TR5 the reader (v4): D1 and the parity in KV, kept 1 minute", async () => {
  resetTrackRecordMemoForTests();
  let reads = 0;
  const env = {
    PUBLIC_MANAGED_SOURCE: "v4",
    DB: { prepare: (sql) => ({ all: async () => { reads += 1; return { results: /signal_ledger/.test(sql) ? LEDGER : MANAGED }; } }) },
    SIGNAL_CACHE: { get: async () => JSON.stringify({ status: "insufficient" }) }
  };
  const a = await readPublicTrackRecord(env, { now: NOW });
  assert.equal(a.scenarios[0].count, 3);
  assert.equal(a.scenarios[2].shown, false);
  await readPublicTrackRecord(env, { now: NOW + 30_000 });
  assert.equal(reads, 2, "the second call within the minute is the memo");
});

// PUB-V3 (owner 2026-11-23: "yang ditampilkan di cta public harusnya omega (v3) bukan yang live omega v4").
const V3 = [
  { opened_at: "2026-11-19 09:00:00", omega_closed_at: "2026-11-20 09:00:00", r_omega: 2, omega_size: 0.5 },
  { opened_at: "2026-11-18 09:00:00", omega_closed_at: "2026-11-19 09:00:00", r_omega: -1, omega_size: null },
  { opened_at: "2026-11-22 07:00:00", omega_closed_at: fresh, r_omega: 3, omega_size: 1 },
  { opened_at: "2026-11-19 12:00:00", omega_closed_at: old, r_omega: null, omega_size: 1 }
];

test("TR6 v3 (the default): the managed exit is the ledger's own policy, sized as the ledger sizes it, with no parity gate", () => {
  for (const parity of [null, { status: "fail" }, { status: "insufficient" }, { status: "pass" }]) {
    const t = publicTrackRecord({ ledger: LEDGER, managed: V3, parity, now: NOW });
    const m = t.scenarios[2];
    assert.equal(m.shown, true);
    assert.equal(m.count, 2, "the fresh close is inside the delay; a null R is no trade");
    assert.equal(m.net_r, 0, "2 x 0.5 + (-1 unsized)");
    assert.equal(m.won, 1);
    assert.equal(m.lost, 1);
    assert.equal(m.since, "2026-11-18");
    assert.deepEqual(t.replay_check, { status: "not_required", shown: true }, "the CTA page shows the managed column only when replay_check.shown is true");
  }
  assert.equal(publicTrackRecord({ ledger: LEDGER, managed: V3, now: NOW, source: "v3" }).scenarios[2].net_r, 0);
});

test("TR7 v3 keeps the v4 shape: the same keys at every level, the same version and labels", () => {
  const keys = (x) => (Array.isArray(x) ? x.map(keys) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, keys(x[k])])) : "value");
  const v3 = publicTrackRecord({ ledger: LEDGER, managed: V3, now: NOW });
  const v4 = publicTrackRecord({ ledger: LEDGER, managed: MANAGED, parity: { status: "pass" }, now: NOW, source: "v4" });
  assert.deepEqual(keys(v3), keys(v4));
  assert.equal(v3.version, "cryptophys.public-track-record.v1");
  assert.deepEqual(v3.scenarios.map((x) => [x.id, x.label]), v4.scenarios.map((x) => [x.id, x.label]));
  assert.deepEqual(v3.scenarios.slice(0, 2), v4.scenarios.slice(0, 2), "TP1 and TP2 do not depend on the managed source");
});

test("TR8 v3: no forbidden key, no Omega, no account and no price field, even when the rows carry them", () => {
  const rows = V3.map((x) => ({ ...x, entry_price: 4021.5, account_ref: "acct_x", omega_status: "closed", lots: 0.1 }));
  const t = publicTrackRecord({ ledger: LEDGER, managed: rows, now: NOW });
  assert.deepEqual(forbiddenKeys(t), []);
  const text = JSON.stringify(t);
  assert.doesNotMatch(text, /omega|acct_|price|lot|4021/i);
  for (const s of t.scenarios) for (const [k, v] of Object.entries(s)) if (typeof v === "number") assert.ok(Math.abs(v) < 1000, `${k} is an R aggregate, not a price`);
});

test("TR9 the switch PUBLIC_MANAGED_SOURCE: v3 by default; the reader's v3 query and no KV read; v4 as before", async () => {
  assert.equal(publicManagedSource({}), "v3");
  assert.equal(publicManagedSource({ PUBLIC_MANAGED_SOURCE: " V4 " }), "v4");
  assert.equal(publicManagedSource({ PUBLIC_MANAGED_SOURCE: "v5" }), "v3");
  resetTrackRecordMemoForTests();
  const sqls = [];
  let kv = 0;
  const env = {
    DB: { prepare: (sql) => ({ all: async () => { sqls.push(sql); return { results: /omega_status = 'closed'/.test(sql) ? V3 : LEDGER }; } }) },
    SIGNAL_CACHE: { get: async () => { kv += 1; return JSON.stringify({ status: "fail" }); } }
  };
  const a = await readPublicTrackRecord(env, { now: NOW });
  assert.equal(kv, 0, "v3 reads no parity");
  assert.equal(sqls.length, 2);
  assert.match(sqls[1], /FROM signal_ledger WHERE source = 'decision' AND omega_status = 'closed' AND r_omega IS NOT NULL/);
  assert.doesNotMatch(sqls.join(" "), /ledger_omega4/);
  assert.equal(a.scenarios[2].shown, true);
  assert.equal(a.scenarios[2].count, 2);
  resetTrackRecordMemoForTests();
  sqls.length = 0;
  const b = await readPublicTrackRecord({ ...env, PUBLIC_MANAGED_SOURCE: "v4" }, { now: NOW });
  assert.equal(kv, 1);
  assert.match(sqls[1], /FROM ledger_omega4/);
  assert.equal(b.scenarios[2].shown, false, "v4 with a failing parity stays hidden");
  resetTrackRecordMemoForTests();
});

// RT1 (owner 2026-11-25: "harus realtime", then "Semua sekarang"): the track record is realtime with Nexus under
// PUBLIC_DELAY_HOURS "0", kept 1 minute per isolate; it counts closed results only.
test("RT1 delay 0: a result closed a minute ago counts; the reader reads PUBLIC_DELAY_HOURS; 24 restores the old cutoff", async () => {
  const justNow = new Date(NOW - 60_000).toISOString();
  const ledger = [...LEDGER, { opened_at: "2026-11-22 11:00:00", r_tp1: 1, r_tp2: 1, tp1_closed_at: justNow, tp2_closed_at: justNow }];
  const managed = [...V3, { opened_at: "2026-11-22 11:00:00", omega_closed_at: justNow, r_omega: 1, omega_size: 1 }];
  const t = publicTrackRecord({ ledger, managed, now: NOW, delayHours: 0 });
  assert.equal(t.delay_hours, 0);
  assert.equal(t.scenarios[0].count, 5, "the fresh results and the one closed a minute ago");
  assert.equal(t.scenarios[2].count, 4);
  const env = (extra) => ({ ...extra, DB: { prepare: (sql) => ({ all: async () => ({ results: /omega_status = 'closed'/.test(sql) ? managed : ledger }) }) } });
  resetTrackRecordMemoForTests();
  const live = await readPublicTrackRecord(env({ PUBLIC_DELAY_HOURS: "0" }), { now: NOW });
  assert.equal(live.delay_hours, 0);
  assert.equal(live.scenarios[0].count, 5);
  resetTrackRecordMemoForTests();
  const old24 = await readPublicTrackRecord(env({ PUBLIC_DELAY_HOURS: "24" }), { now: NOW });
  assert.equal(old24.delay_hours, 24);
  assert.equal(old24.scenarios[0].count, 3, "the rollback: only results closed more than 24 hours ago");
  resetTrackRecordMemoForTests();
  for (const v of [undefined, "", "soon"]) {
    const x = await readPublicTrackRecord(env(v === undefined ? {} : { PUBLIC_DELAY_HOURS: v }), { now: NOW });
    assert.equal(x.delay_hours, 24, String(v));
    resetTrackRecordMemoForTests();
  }
});

test("RT1 delay 0: an open position or a managed row that is not closed never counts", async () => {
  const future = new Date(NOW + 3600_000).toISOString();
  const open = [
    { opened_at: "2026-11-22 11:50:00", r_tp1: null, r_tp2: null, tp1_closed_at: null, tp2_closed_at: null, closed_at: null },
    { opened_at: "2026-11-22 11:50:00", r_tp1: 1, r_tp2: 2, tp1_closed_at: null, tp2_closed_at: null, closed_at: null },
    { opened_at: "2026-11-22 11:50:00", r_tp1: 1, r_tp2: 2, tp1_closed_at: future, tp2_closed_at: future }
  ];
  const managedOpen = [
    { opened_at: "2026-11-22 11:50:00", omega_closed_at: null, r_omega: 0.5, omega_size: 1 },
    { opened_at: "2026-11-22 11:50:00", omega_closed_at: future, r_omega: 0.5, omega_size: 1 }
  ];
  const base = publicTrackRecord({ ledger: LEDGER, managed: V3, now: NOW, delayHours: 0 });
  const withOpen = publicTrackRecord({ ledger: [...LEDGER, ...open], managed: [...V3, ...managedOpen], now: NOW, delayHours: 0 });
  assert.deepEqual(withOpen, base, "open rows change nothing");
  const v4 = publicTrackRecord({ ledger: LEDGER, managed: [...MANAGED, { issued_ms: NOW - 60_000, omega4_closed_at: null, r_omega4: 2 }], parity: { status: "pass" }, now: NOW, delayHours: 0, source: "v4" });
  assert.equal(v4.scenarios[2].count, 2, "a v4 row without a close is left out");
  // The reader asks D1 for closed managed rows only: an open omega_status never reaches the sum.
  resetTrackRecordMemoForTests();
  const sqls = [];
  await readPublicTrackRecord({ PUBLIC_DELAY_HOURS: "0", DB: { prepare: (sql) => ({ all: async () => { sqls.push(sql); return { results: [] }; } }) } }, { now: NOW });
  assert.match(sqls[1], /omega_status = 'closed' AND r_omega IS NOT NULL/);
  resetTrackRecordMemoForTests();
  await readPublicTrackRecord({ PUBLIC_DELAY_HOURS: "0", PUBLIC_MANAGED_SOURCE: "v4", DB: { prepare: (sql) => ({ all: async () => { sqls.push(sql); return { results: [] }; } }) } }, { now: NOW });
  assert.match(sqls[3], /omega4_status = 'closed'/);
  resetTrackRecordMemoForTests();
});

test("RT1 the reader keeps a body for 1 minute per isolate, then reads again", async () => {
  resetTrackRecordMemoForTests();
  let reads = 0;
  const env = { PUBLIC_DELAY_HOURS: "0", DB: { prepare: () => ({ all: async () => { reads += 1; return { results: [] }; } }) } };
  await readPublicTrackRecord(env, { now: NOW });
  await readPublicTrackRecord(env, { now: NOW + 59_000 });
  assert.equal(reads, 2, "within the minute: the memo");
  await readPublicTrackRecord(env, { now: NOW + 60_000 });
  assert.equal(reads, 4, "after a minute: D1 again");
  resetTrackRecordMemoForTests();
});
