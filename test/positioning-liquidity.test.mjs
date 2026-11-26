// The Positioning & Liquidity analyst (docs/RFC_POSITIONING_LIQUIDITY.md; owner 2026-11-20, breakglass live): lens A
// (CFTC positioning), lens B (the broker's M1 liquidity), their weights, scores, floor and switches. No live network:
// the CFTC fetch reads a fixture through an injected fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  parseCotRows, scheduledReleaseMs, COT_PUBLICATION_OUTAGES, cotAt, positioningFactsAt, positioningLean, positioningCard, positioningLine, storeCotRows, readCotRows, runCotStep,
  resetCotSchemaForTests, resetPositioningMemoForTests, usFederalHolidays, priceChangeFor, positioningReadings, COT_BACKFILL_KEY, POSITIONING_LEAN_CAP, cotUrl
} from "../src/positioning-lens.mjs";
import {
  lensKnobs, lensPolicyFromPack, floorHolds, lensFloorStep, lensReport, forbiddenReportKeys, lensFactNames, PROHIBITED_FACT, LENS_KNOBS, LENS_POLICY_KEY, LENS_FLOOR_KEY,
  resetLensStateMemoForTests, resetLensReadingsSchemaForTests, recordLensReading, lensScore, belowFloor, lensSwitchesFrom, LENS_SCORE_MIN_N
} from "../src/lens-policy.mjs";
import {
  nyHourOfWeek, buildBaseline, baselinePctl, liquidityFacts, detectSweeps, poolsOf, hvnOf, liquidityFields, signalLiquidityLevels, liveSpreadSpike, deferModifications,
  excludedWhy, scoreSweep, sweepFor, liquidityLine, archiveBrokerBars, readBrokerBars, resetLiquiditySchemaForTests, LIQUIDITY_MODIFY_DEFER_MAX_MS, BROKER_ROWS_PER_STATEMENT, eligibleMinutes,
  BROKER_BAR_COLUMNS, backfillBrokerBars, backfillIdentity, backfillKey, backfillFailedKey, backfillVersionsKey, LIQUIDITY_BACKFILL_KEY, shortHash
} from "../src/liquidity-lens.mjs";
import { withPositioning, liquidityEvidence, councilEvidence } from "../src/decision-engine.mjs";
import { planIntents, OMEGA_DEFAULTS, brokerKeyLevels, settingsFrom } from "../src/omega-engine.mjs";
import { entryFacts, entryChoice, ENTRY_REASONS, entryCouncilSchema } from "../src/limit-council.mjs";
import { liquidityOf, ruleAction, targetPlan, TP_NEARER_REASONS, positionCouncilMessages } from "../src/position-manager.mjs";
import { omegaParity, eraSwitches } from "../src/ledger-omega4.mjs";
import { replayDecision } from "../src/witness-tuning.mjs";
import { handInputs } from "./fixtures/omega-market-path.mjs";
import { nyToUtc } from "../src/positioning-lens.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
const kv = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); } }; };
const env = (over = {}) => ({ DB: d1(), SIGNAL_CACHE: kv(), ...over });
const reset = () => { resetCotSchemaForTests(); resetPositioningMemoForTests(); resetLensStateMemoForTests(); resetLensReadingsSchemaForTests(); resetLiquiditySchemaForTests(); };
const DAY = 86_400_000, M1 = 60_000, HOUR = 3_600_000;
const PRICE_KEY = /price|entry|stop|sl|tp|target|level|zone|bid|ask/i;

// ---------------------------------------------------------------- fixtures: 200 weeks of the disaggregated report

const tuesdays = (n, last = "2026-11-17") => { const out = []; for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.parse(`${last}T00:00:00Z`) - i * 7 * DAY).toISOString().slice(0, 10)); return out; };
function socrata(n = 200, { net = (i) => 100_000 + 400 * i, series = "disaggregated" } = {}) {
  const dates = tuesdays(n);
  const L = series === "legacy" ? ["noncomm_positions_long_all", "noncomm_positions_short_all", "change_in_noncomm_long_all", "change_in_noncomm_short_all"] : ["m_money_positions_long_all", "m_money_positions_short_all", "change_in_m_money_long_all", "change_in_m_money_short_all"];
  return dates.map((d, i) => {
    const nt = net(i), prev = i ? net(i - 1) : nt;
    return { report_date_as_yyyy_mm_dd: `${d}T00:00:00.000`, cftc_contract_market_code: "088691", [L[0]]: String(nt + 50_000), [L[1]]: "50000", [L[2]]: String(nt - prev), [L[3]]: "0", open_interest_all: String(500_000 + i * 100), change_in_open_interest_all: "100" };
  });
}
const rowsOf = (raw, series = "disaggregated") => parseCotRows(series, raw).map((r) => ({ ...r, released_ms: scheduledReleaseMs(r.report_date).ms, released_estimated: true }));

test("PL1. COT facts on fixtures: net, the week's change, the 156-week percentile, z, open interest, crowding, divergence, provenance", () => {
  const rows = rowsOf(socrata(200));
  const t = Date.parse("2026-11-23T12:00:00Z");
  const f = positioningFactsAt(rows, t, { knobs: { crowd_pctl: 0.9, flow_z: 1 } });
  assert.equal(f.as_of, "2026-11-17");
  assert.equal(f.series, "disaggregated");
  assert.equal(f.net, 100_000 + 400 * 199);
  assert.equal(f.net_change_1w, 400);
  assert.equal(f.net_pctl_3y, 1, "the highest net of 156 weeks");
  assert.equal(f.crowding, "crowded_long");
  assert.equal(f.weeks, 156);
  assert.deepEqual(f.oi_change_1w, { contracts: 100, pct: Math.round((100 / (500_000 + 199 * 100 - 100)) * 100 * 1000) / 1000 });
  assert.equal(f.divergence, "none");
  assert.equal(f.stale, false);
  assert.equal(positioningFactsAt(rows, t, { priceChange: -1 }).divergence, "price_down_net_up");
  // Crowding leans contrarian; a constant flow has no z (sd 0), so the lean is the crowding half, capped.
  const lean = positioningLean(f, { crowd_pctl: 0.9, flow_z: 1 });
  assert.equal(lean, -0.5);
  assert.ok(Math.abs(lean) <= POSITIONING_LEAN_CAP);
  // Stale after 14 days without a newer report: no lean, the card is stale.
  const late = positioningFactsAt(rows, Date.parse("2026-12-10T00:00:00Z"));
  assert.equal(late.stale, true);
  assert.equal(positioningLean(late), null);
  const card = positioningCard(late, { weight: 0.03 });
  assert.equal(card.stale, true);
  assert.equal(card.at, null, "no hourly decay");
  // The legacy series is never mixed into a disaggregated percentile; it stands in only when the primary is missing or older.
  const legacy = rowsOf(socrata(200, { series: "legacy", net: () => 1 }), "legacy");
  const both = positioningFactsAt([...rows, ...legacy], t);
  assert.equal(both.series, "disaggregated");
  assert.equal(both.net_pctl_3y, 1);
  const onlyLegacy = positioningFactsAt([...rows.slice(0, -3), ...legacy], t);
  assert.equal(onlyLegacy.series, "legacy");
  assert.ok(onlyLegacy.proxy);
  assert.doesNotMatch(positioningLine(f), /\d{4}\.\d/, "no price in the line");
});

test("PL2. cotAt is point in time: a Thursday reads the report of the Tuesday nine days earlier; a holiday week moves to Monday; a delayed week reads its listed day", () => {
  const rows = rowsOf(socrata(40));
  const thu = Date.parse("2026-11-19T12:00:00Z");
  assert.equal(cotAt(rows, thu).report_date, "2026-11-10", "never the report of two days earlier");
  assert.notEqual(cotAt(rows, thu).report_date, "2026-11-17");
  for (const t of [thu, Date.parse("2026-11-20T20:29:00Z")]) for (const r of rows) if (r.report_date === cotAt(rows, t).report_date) assert.ok(r.released_ms <= t);
  assert.equal(cotAt(rows, Date.parse("2026-11-20T20:31:00Z")).report_date, "2026-11-17", "Friday 15:30 New York");
  // Thanksgiving 2026 (Thursday 11-26): the report of Tuesday 11-24 is released Monday 11-30 15:30 New York.
  assert.ok(usFederalHolidays(2026).has("2026-11-26"));
  assert.equal(new Date(scheduledReleaseMs("2026-11-24").ms).toISOString(), "2026-11-30T20:30:00.000Z");
  // Summer time: 15:30 New York is 19:30 UTC.
  assert.equal(new Date(scheduledReleaseMs("2026-07-07").ms).toISOString(), "2026-07-10T19:30:00.000Z");
  const delayed = scheduledReleaseMs("2025-10-07", { delayed: { "2025-10-07": "2025-11-21" } });
  assert.equal(new Date(delayed.ms).toISOString(), "2025-11-21T20:30:00.000Z");
  assert.equal(delayed.estimated, false);
  // The 2025 shutdown (orchestrator review of #505): no report of 30 Sep to 23 Dec 2025 is read before the end of the
  // catch-up, 29 Dec 2025 15:30 New York; the report before the window and the ones after keep their usual day.
  assert.deepEqual(COT_PUBLICATION_OUTAGES.map((o) => [o.first_report, o.last_report, o.released_by]), [["2025-09-30", "2025-12-23", "2025-12-29"]]);
  const end = Date.parse("2025-12-29T20:30:00Z");
  const tuesdays = [];
  for (let t = Date.parse("2025-09-16T00:00:00Z"); t <= Date.parse("2026-01-13T00:00:00Z"); t += 7 * DAY) tuesdays.push(new Date(t).toISOString().slice(0, 10));
  const shutdownRows = tuesdays.map((d) => ({ series: "disaggregated", report_date: d, released_ms: scheduledReleaseMs(d).ms }));
  const inWindow = (d) => d >= "2025-09-30" && d <= "2025-12-23";
  for (const r of shutdownRows) {
    if (inWindow(r.report_date)) { assert.equal(r.released_ms, end, r.report_date); assert.equal(scheduledReleaseMs(r.report_date).estimated, true); }
    else assert.ok(r.released_ms < end || r.report_date > "2025-12-23", r.report_date);
  }
  assert.equal(new Date(scheduledReleaseMs("2025-09-23").ms).toISOString(), "2025-09-26T19:30:00.000Z", "the last report before the shutdown");
  assert.equal(new Date(scheduledReleaseMs("2025-12-30").ms).toISOString(), "2026-01-05T20:30:00.000Z", "after the catch-up: New Year's week, Monday");
  for (let t = Date.parse("2025-09-26T00:00:00Z"); t <= Date.parse("2026-01-10T00:00:00Z"); t += HOUR) {
    const got = cotAt(shutdownRows, t);
    if (got && inWindow(got.report_date)) assert.ok(t >= end, `${got.report_date} read at ${new Date(t).toISOString()}`);
  }
  assert.equal(cotAt(shutdownRows, end - 60_000).report_date, "2025-09-23", "a minute before the catch-up ends: the last report from before the shutdown");
  assert.equal(cotAt(shutdownRows, end).report_date, "2025-12-23");
  // A listed day (once read from CFTC's schedule) wins over the window.
  assert.equal(new Date(scheduledReleaseMs("2025-10-07", { delayed: { "2025-10-07": "2025-11-21" } }).ms).toISOString(), "2025-11-21T20:30:00.000Z");
  // The percentile at t uses only the rows released before t.
  const f = positioningFactsAt(rows, thu);
  assert.equal(f.as_of, "2026-11-10");
});

test("PL3. storage: a live row is released at max(schedule, first seen); a revision keeps released_ms; the fetch backfills once (3 + 1 years) and then waits for the next release", async () => {
  reset();
  const e = env();
  const now = Date.parse("2026-11-21T10:00:00Z");
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); const legacy = url.includes("6dca-aqww"); return { ok: true, json: async () => socrata(10, { series: legacy ? "legacy" : "disaggregated" }) }; };
  // The closed-market idle heartbeat leaves the backfill to a trading sweep: no request, nothing marked fetched.
  assert.equal((await runCotStep(e, { now, fetchImpl, allowBackfill: false })).status, "backfill_pending");
  assert.equal(calls.length, 0);
  const r1 = await runCotStep(e, { now, fetchImpl });
  assert.equal(r1.backfill, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /publicreporting\.cftc\.gov\/resource\/72hh-3qpy\.json/);
  assert.match(decodeURIComponent(calls[0]), /\$limit=260/);
  assert.ok(await e.SIGNAL_CACHE.get(COT_BACKFILL_KEY));
  assert.equal((await runCotStep(e, { now: now + 10 * M1, fetchImpl })).status, "fresh", "at most once an hour");
  assert.equal((await runCotStep(e, { now: now + 2 * 3_600_000, fetchImpl })).status, "not_due", "the next report is due on Monday (Thanksgiving week)");
  assert.equal(calls.length, 2);
  const rows = await readCotRows(e.DB);
  assert.equal(rows.filter((r) => r.series === "disaggregated").length, 10);
  assert.ok(rows.every((r) => r.released_estimated), "backfilled rows are estimated");
  // A row first seen live after its schedule: released when seen.
  const late = parseCotRows("disaggregated", socrata(1).map((x) => ({ ...x, report_date_as_yyyy_mm_dd: "2026-11-24T00:00:00.000" })));
  const seen = Date.parse("2026-12-01T09:00:00Z");
  await storeCotRows(e.DB, late, { now: seen });
  const stored = (await readCotRows(e.DB)).find((r) => r.report_date === "2026-11-24");
  assert.equal(stored.released_ms, seen);
  assert.equal(stored.released_estimated, false);
  // A revision replaces the values and keeps the release.
  const rev = await storeCotRows(e.DB, [{ ...late[0], net_long: late[0].net_long + 5, net: late[0].net + 5 }], { now: seen + DAY });
  assert.deepEqual(rev, { added: 0, revised: 1 });
  const again = (await readCotRows(e.DB)).find((r) => r.report_date === "2026-11-24");
  assert.equal(again.released_ms, seen);
  assert.equal(again.net, late[0].net + 5);
  assert.match(cotUrl("legacy", 6), /6dca-aqww/);
});

test("PL4. the POSITIONING witness: at its per-mode weight, the others scaled by 1 - w (the set still sums to 1); off or without a report it contributes nothing", () => {
  const cards = [{ key: "D1", weight: 0.6, available: true, stale: false, lean: 0.4 }, { key: "H4", weight: 0.4, available: true, stale: false, lean: -0.2 }];
  const rows = rowsOf(socrata(200));
  const facts = positioningFactsAt(rows, Date.parse("2026-11-23T00:00:00Z"));
  const knobs = lensKnobs("positioning", "swing");
  assert.equal(knobs.weight, 0.05);
  const out = withPositioning(cards, { facts, knobs });
  assert.equal(out.length, 3);
  assert.ok(Math.abs(out.reduce((s, c) => s + c.weight, 0) - 1) < 1e-9);
  assert.equal(out.find((c) => c.key === "POSITIONING").weight, 0.05);
  assert.equal(out[0].weight, 0.57);
  assert.deepEqual(withPositioning(cards, { facts, knobs: lensKnobs("positioning", "swing", { enabled: false }) }), cards, "switch off: nothing");
  assert.deepEqual(withPositioning(cards, { facts: null, knobs }), cards, "no report: nothing");
  // The witness tuner's replay keeps POSITIONING at its recorded weight in every arm.
  const d = { witnesses: [{ key: "D1", available: true, stale: false, lean: 0.5 }, { key: "POSITIONING", available: true, stale: false, lean: -0.5, weight: 0.05 }], checks: { long: [{ id: "quorum", pass: true }], short: [{ id: "quorum", pass: true }] }, mode: "intraday", decided_ms: 0 };
  // The live engine with the tuned set { D1: 1 } weighs D1 0.95 and POSITIONING 0.05; the replay does the same.
  const live = withPositioning([{ key: "D1", weight: 1, available: true, stale: false, lean: 0.5 }], { facts, knobs });
  assert.deepEqual(live.map((c) => c.weight), [0.95, 0.05]);
  const a = replayDecision(d, { D1: 1 });
  assert.equal(a.quorum.long_share, 0.95);
  assert.equal(a.quorum.short_share, 0.05);
  const { weight: _w, ...unweighted } = d.witnesses[1];
  assert.equal(replayDecision({ ...d, witnesses: [d.witnesses[0], unweighted] }, { D1: 1 }).quorum.short_share, 0, "a record without its weight: as before");
});

// ---------------------------------------------------------------- the knobs, the floor and the report

test("PL5. the knobs: anchors per mode, Aether's values clamped to the bounds, a raise above the anchor waits for a sufficient baseline", () => {
  assert.deepEqual(["scalp", "intraday", "swing", "range"].map((m) => lensKnobs("positioning", m).weight), [0.02, 0.03, 0.05, 0.03]);
  assert.deepEqual(["scalp", "intraday", "swing", "range"].map((m) => lensKnobs("liquidity", m, { baseline: "sufficient" }).weight), [0.4, 0.3, 0.2, 0.3]);
  const policy = { ...lensPolicyFromPack({ values: { "positioning.de_weight_swing": 0.5, "liquidity.council_weight_scalp": 0.7, "liquidity.spread_widen_scalp": 9, "omega.risk_pct": 1 }, doctrine_sha: "a".repeat(64) }), pulled_at: new Date(0).toISOString() };
  assert.equal(policy.values["positioning.de_weight_swing"], 0.1, "clamped to the swing bound");
  assert.equal(policy.values["liquidity.spread_widen_scalp"], 4);
  assert.equal(policy.values["omega.risk_pct"], undefined);
  const k = lensKnobs("positioning", "swing", { policy });
  assert.deepEqual([k.weight, k.weight_source], [0.1, "aether"]);
  assert.deepEqual([lensKnobs("liquidity", "scalp", { policy, baseline: "insufficient" }).weight, lensKnobs("liquidity", "scalp", { policy, baseline: "insufficient" }).weight_source], [0.4, "anchor_baseline_insufficient"]);
  assert.equal(lensKnobs("liquidity", "scalp", { policy, baseline: "sufficient" }).weight, 0.7);
  const off = lensKnobs("liquidity", "scalp", { policy, enabled: false, baseline: "sufficient" });
  assert.deepEqual([off.weight, off.active, off.weight_source], [0, false, "switch_off"]);
  assert.deepEqual(lensSwitchesFrom({ liquidity_enabled: false }), { positioning: true, liquidity: false });
});

test("PL6. the floor: a score below its floor drops the lens to the floor of its bound in every mode, with an event and one private line; only a newer doctrine value lifts it", async () => {
  reset();
  const e = env();
  const now = Date.parse("2026-11-20T12:00:00Z");
  for (let i = 0; i < 30; i++) await recordLensReading(e.DB, { id: `pos:${i}`, lens: "positioning", kind: "h4", at_ms: now - i * 4 * 3_600_000, outcome: i % 4 === 0 ? "hit" : "miss" }, { now });
  for (let i = 0; i < 30; i++) await recordLensReading(e.DB, { id: `sweep:${i}`, lens: "liquidity", kind: "sweep", at_ms: now - i * 3_600_000, outcome: "hit" }, { now });
  const lines = [], events = [];
  const r = await lensFloorStep(e, { now, notify: async (t) => lines.push(t), log: async (a, d) => events.push([a, d]) });
  assert.equal(r.status, "floored");
  assert.equal(r.lenses.positioning.dropped, true);
  assert.equal(r.lenses.liquidity.dropped, undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Positioning lens: weight to its floor in every mode\. Hit share 27% over the last 30 readings, floor 45%\. Aether can raise it again\.$/);
  assert.equal(events[0][0], "lens_weight_floor");
  assert.deepEqual(events[0][1].weights_before, { scalp: 0.02, intraday: 0.03, swing: 0.05, range: 0.03 });
  assert.equal(forbiddenReportKeys(events[0][1]).length, 0);
  const floor = JSON.parse(await e.SIGNAL_CACHE.get(LENS_FLOOR_KEY));
  assert.deepEqual(["scalp", "intraday", "swing", "range"].map((m) => lensKnobs("positioning", m, { floor }).weight), [0.02, 0.02, 0.02, 0.02]);
  assert.equal(lensKnobs("positioning", "swing", { floor }).weight_source, "floor_rollback");
  // Not again while floored.
  assert.equal((await lensFloorStep(e, { now: now + 1, notify: async (t) => lines.push(t) })).status, "ok");
  assert.equal(lines.length, 1);
  // An old value read again does not lift it; a newer doctrine value pulled after the floor does.
  const old = { values: { "positioning.de_weight_swing": 0.08 }, doctrine_sha: null, pulled_at: new Date(now + 60_000).toISOString() };
  assert.equal(floorHolds("positioning", { policy: old, floor }), true);
  const newer = { values: { "positioning.de_weight_swing": 0.08 }, doctrine_sha: "b".repeat(64), pulled_at: new Date(now + 60_000).toISOString() };
  assert.equal(floorHolds("positioning", { policy: newer, floor }), false);
  assert.equal(lensKnobs("positioning", "swing", { policy: newer, floor }).weight, 0.08);
  // Few readings never floor a lens.
  assert.equal(belowFloor(lensScore([{ outcome: "miss", kind: "h4" }]), { floor: 0.45 }), false);
  assert.ok(LENS_SCORE_MIN_N >= 20);
});

test("PL7. the lens report carries no price key at any depth, and a forbidden key is refused; every fact name passes the platform's filter", () => {
  const state = { switches: { positioning: true, liquidity: true }, policy: null, floor: {} };
  const report = lensReport({ state, scores: { positioning: { hits: 3, misses: 1, n: 4, share: 0.75 } }, positioning: { series: "disaggregated", age_days: 3, stale: false }, liquidity: { baseline: "insufficient", baseline_weeks: 1 } });
  assert.equal(report.schema, "cryptophys.lens-report.v1");
  assert.deepEqual(forbiddenReportKeys(report), []);
  const walk = (o) => (o && typeof o === "object" ? Object.entries(o).every(([k, v]) => !PRICE_KEY.test(k) && walk(v)) : true);
  assert.ok(walk(report));
  assert.deepEqual(forbiddenReportKeys({ a: [{ entry_price: 1 }] }), [".a[0].entry_price"]);
  assert.equal(lensReport({ state, scores: { positioning: { sl: 1 } } }), null, "a report with a price key is refused");
  const names = lensFactNames();
  assert.equal(names.length, Object.keys(LENS_KNOBS).length * 4 + 4);
  for (const n of names) assert.doesNotMatch(n, PROHIBITED_FACT, n);
  for (const n of ["positioning.net", "positioning.net_change_1w", "positioning.net_pctl_3y", "positioning.net_change_z", "positioning.oi_change_1w", "positioning.crowding", "positioning.divergence", "liquidity.vol_pctl", "liquidity.vol_spike", "liquidity.thin", "liquidity.spread_ratio", "liquidity.sweep", "liquidity.pools", "liquidity.hvn", "liquidity.baseline"]) assert.doesNotMatch(n, PROHIBITED_FACT);
});

// ---------------------------------------------------------------- lens B

const T0 = Date.parse("2026-11-18T14:00:00Z"); // Wednesday 09:00 New York
/** M1 bars from `from` for `n` minutes: price p(i), tick volume v(i), spread s(i). */
/** Wednesday `weeks` before T0 at `hour`:00 New York time. */
const nyWeeksAgo = (weeks, hour) => { const d = new Date(T0 - weeks * 7 * DAY); return nyToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, 0); };
const barsOf = (from, n, { p = () => 4100, v = () => 100, s = () => 20, range = 0.4 } = {}) => Array.from({ length: n }, (_, i) => { const c = p(i); return { t: from + i * M1, o: c, h: c + range / 2, l: c - range / 2, c, v: v(i), s: s(i) }; });

test("PL8. the baseline: per New York hour of the week, insufficient below four weeks with the rolling fallback, sufficient at four", () => {
  assert.equal(nyHourOfWeek(T0), 3 * 24 + 9);
  assert.equal(nyHourOfWeek(Date.parse("2026-07-15T13:00:00Z")), 3 * 24 + 9, "daylight time: the same New York hour");
  const now = T0 + 70 * M1;
  const oneWeek = barsOf(T0 - 7 * DAY, 60, { v: (i) => 50 + i });
  const b1 = buildBaseline(oneWeek, { identity: "x", now });
  assert.equal(b1.baseline, "insufficient");
  const p = baselinePctl(b1, T0 + 10 * M1, 200);
  assert.equal(p.pctl, 1);
  assert.equal(p.basis, "rolling_hour_of_day", "the same New York hour of day across the available days");
  const eligible = { [nyHourOfWeek(T0)]: 60 };
  // The same New York hour each week (US daylight time ended on 1 November: 09:00 New York moved from 13:00 to 14:00 UTC).
  const fourWeeks = [0, 1, 2, 3].flatMap((w) => barsOf(nyWeeksAgo(w + 1, 9), 60, { v: (i) => 50 + i }));
  const b4 = buildBaseline(fourWeeks, { identity: "x", now, eligible });
  assert.equal(b4.baseline, "sufficient");
  assert.equal(b4.baseline_weeks, 4);
  assert.equal(baselinePctl(b4, T0 + 10 * M1, 50).basis, "hour_of_week");
  assert.ok(baselinePctl(b4, T0 + 10 * M1, 50).pctl < 0.05);
  // Excluded minutes: the rollover quarantine, the pause and the first five minutes after a session open.
  assert.equal(excludedWhy(Date.parse("2026-11-18T21:58:00Z")), "rollover_quarantine");
  assert.equal(excludedWhy(Date.parse("2026-11-21T12:00:00Z")), "market_paused");
  assert.equal(excludedWhy(Date.parse("2026-11-18T13:02:00Z")), "session_open", "08:02 New York");
  assert.equal(excludedWhy(Date.parse("2026-11-18T13:06:00Z")), null);
  assert.ok(Object.keys(eligibleMinutes(now)).length > 100);
});

test("PL9. every lens B fact on fixtures: the spike percentile, thin, the spread ratio, a reclaimed sweep, equal-high pools and high-volume nodes; no price in the facts", () => {
  const now = T0 + 300 * M1;
  const hist = [0, 1, 2, 3].flatMap((w) => barsOf(nyWeeksAgo(w + 1, 9), 300, { v: (i) => 80 + (i % 40) }));
  const eligible = Object.fromEntries([9, 10, 11, 12, 13].map((h) => [3 * 24 + h, 60]));
  const baseline = buildBaseline(hist, { identity: "x", now, eligible });
  assert.equal(baseline.baseline, "sufficient");
  // Price oscillates with two equal highs, then one bar wicks through them on a volume spike and closes back inside.
  const p = (i) => 4100 + 2 * Math.sin(i / 6);
  const bars = barsOf(T0, 300, { p, v: (i) => (i === 298 ? 500 : 90), s: (i) => (i >= 295 ? 60 : 20) });
  const top = Math.max(...bars.slice(0, 290).map((b) => b.h));
  bars[298] = { ...bars[298], h: top + 1, c: top - 1.5, o: top - 1, l: top - 1.6 };
  const { facts, levels, sweeps } = liquidityFacts({ bars, baseline, knobs: { spike_pctl: 0.95, thin_pctl: 0.2, spread_widen: 2, sweep_lookback_min: 180, pool_tol_atr: 0.05, hvn_pctl: 0.85, profile_window_min: 240 }, now, liveSpread: 60 });
  assert.equal(facts.available, true);
  assert.equal(facts.baseline, "sufficient");
  assert.ok(facts.vol_pctl > 0.2 && facts.vol_pctl < 0.4, "the last bar's 90 ticks in an hour of 80 to 119");
  assert.equal(facts.vol_spike, false);
  assert.equal(facts.spread_ratio, 3);
  assert.equal(facts.spread_spike, true);
  assert.equal(typeof facts.thin, "boolean");
  assert.ok(sweeps.some((s) => s.side === "buy_side" && s.vol_pctl === 1), "a reclaimed buy-side sweep on the volume spike");
  assert.equal(facts.sweep.side, "buy_side");
  assert.equal(facts.sweep.reclaimed, true);
  assert.ok(facts.sweep.age_min <= 2);
  assert.ok(Number.isInteger(facts.pools.equal_highs) && Number.isInteger(facts.hvn.above));
  assert.ok(levels.length > 0 && levels.every((z) => ["sweep", "pool", "hvn"].includes(z.kind)));
  const walk = (o) => (o && typeof o === "object" ? Object.entries(o).every(([k, v]) => !PRICE_KEY.test(k) && walk(v)) : true);
  assert.ok(walk(facts), "the facts carry no price key");
  assert.doesNotMatch(liquidityLine(facts), /41\d\d\./, "the room line has no price");
  // Pools and nodes on their own.
  const pools = poolsOf(barsOf(T0, 120, { p: (i) => 4100 + 2 * Math.sin(i / 6) }), { tol: 0.2, price: 4099 });
  assert.ok(pools.some((x) => x.kind === "high" && x.swings >= 2));
  const nodes = hvnOf(barsOf(T0, 120, { p: (i) => 4100 + (i % 10) * 0.1, v: () => 50 }), { bin: 0.1, pctl: 0.85, price: 4100 });
  assert.ok(nodes.length >= 1);
  // The sweep's side per position.
  assert.equal(sweepFor(facts, "SELL"), "sweep_with");
  assert.equal(sweepFor(facts, "BUY"), "sweep_against");
  // Its score: down 0.5 ATR before beyond the extreme is a hit; beyond first a miss.
  const sw = { t: T0, side: "buy_side", extreme: 4102, close: 4100 };
  assert.equal(scoreSweep(sw, [{ t: T0 + M1, h: 4100.2, l: 4099.4 }], { atr: 1, now: T0 + DAY }), "hit");
  assert.equal(scoreSweep(sw, [{ t: T0 + M1, h: 4102.5, l: 4099.4 }], { atr: 1, now: T0 + DAY }), "miss");
  assert.equal(scoreSweep(sw, [], { atr: 1, now: T0 + 5 * M1 }), null, "pending inside its horizon");
});

test("PL10. the baseline-insufficient path: every fact says so, the weight cannot rise above its anchor, and the room line names it", () => {
  const now = T0 + 100 * M1;
  const baseline = buildBaseline(barsOf(T0 - DAY, 60), { identity: "x", now });
  const { facts } = liquidityFacts({ bars: barsOf(T0, 100), baseline, now });
  assert.equal(facts.baseline, "insufficient");
  assert.ok(facts.basis.startsWith("rolling"));
  assert.match(liquidityLine(facts), /baseline: insufficient, 0 of 4 weeks/);
  const policy = { values: { "liquidity.council_weight_scalp": 0.8 } };
  assert.equal(lensKnobs("liquidity", "scalp", { policy, baseline: facts.baseline }).weight, 0.4);
  // Without bars: unavailable, nothing uses it.
  assert.equal(liquidityFacts({ bars: [], baseline, now }).facts.available, false);
});

test("PL11. the archive is keyed by the opaque account_ref, never an account number, and batched under D1's bound-parameter limit", async () => {
  reset();
  const db = d1();
  const bars = barsOf(T0, 30);
  assert.equal(await archiveBrokerBars(db, { accountRef: "5012345", source: "mt5:x:XAUUSD", bars, now: T0 + DAY }), 0, "an account number is refused");
  assert.equal(await archiveBrokerBars(db, { accountRef: "acct_0123456789abcdef", source: "mt5macro:x:EURUSD", bars, now: T0 + DAY }), 0, "never a macro source");
  assert.equal(await archiveBrokerBars(db, { accountRef: "acct_0123456789abcdef", source: "mt5:x:XAUUSD", digits: 2, bars, now: T0 + DAY }), 30);
  assert.equal((await readBrokerBars(db, { accountRef: "acct_0123456789abcdef", source: "mt5:x:XAUUSD", fromMs: 0 })).length, 30);
  assert.equal(BROKER_BAR_COLUMNS.length, 13);
  assert.deepEqual(db.raw.prepare("PRAGMA table_info(broker_bars_1m)").all().map((c) => c.name), [...BROKER_BAR_COLUMNS], "the INSERT's columns are the table's, in order");
  assert.ok(BROKER_ROWS_PER_STATEMENT * 13 <= 100, "D1 binds at most 100 parameters a statement");
  assert.equal(BROKER_ROWS_PER_STATEMENT, 7);
  const cols = db.raw.prepare("PRAGMA table_info(broker_bars_1m)").all().map((c) => c.name);
  assert.ok(cols.includes("account_ref") && !cols.some((c) => /login|number/.test(c)));
});

// ---------------------------------------------------------------- lens B in Omega: the gate, the deferral, the levels

const hand = new Map(handInputs());
const liq = (over = {}) => ({ liquidity_on: true, liquidity_weight: 0.3, liquidity_spread_median: 10, liquidity_spread_widen: 2, liquidity_levels: "", ...over });

test("PL12. the gate liquidity_spread_spike: no new entry while the live spread is at or above spread_widen x the hour's norm; off, at the floor or calm: today's path", () => {
  const input = hand.get("open");
  assert.equal(input.executor.symbol.spread_points, 20);
  const today = planIntents(input);
  assert.ok(today.intents.some((it) => it.kind === "open"));
  const spike = planIntents({ ...input, signal: { ...input.signal, ...liq({ liquidity_spread_median: 10 }) } });
  assert.deepEqual(spike.intents, []);
  assert.ok(spike.notes.some((n) => n.code === "liquidity_spread_spike"));
  assert.deepEqual(planIntents({ ...input, signal: { ...input.signal, ...liq({ liquidity_spread_median: 15 }) } }), today, "1.33x: calm");
  assert.deepEqual(planIntents({ ...input, signal: { ...input.signal, ...liq({ liquidity_on: false }) } }), today, "at the floor the signal carries liquidity_on false");
  assert.deepEqual(planIntents({ ...input, settings: { ...input.settings, liquidity_enabled: false }, signal: { ...input.signal, ...liq() } }), today, "the owner's switch off: nothing");
  // The absolute spread gate stays first.
  const wide = hand.get("spread");
  assert.ok(planIntents({ ...wide, signal: { ...wide.signal, ...liq() } }).notes.some((n) => n.code === "spread"));
  assert.equal(liveSpreadSpike({ ...liq(), liquidity_spread_median: 0 }, { spread_points: 90 }), false, "no norm, no spike");
});

test("PL13. the modify deferral: during a spike the planner's stop and target modifications wait up to 10 minutes from its start; closes, kill and the fill guard never wait", () => {
  const its = [{ id: "ms:1:lad:1", kind: "modify_sl" }, { id: "pm:1:t:1", kind: "modify_sltp" }, { id: "x", kind: "modify_tp" }, { id: "cl:1:fg", kind: "close", reason: "fill_guard_tick_value_mismatch" }, { id: "k", kind: "close_all", reason: "kill" }, { id: "pl:1:1", kind: "partial_close" }, { id: "hard", kind: "modify_sl", hard: true }];
  const now = T0;
  const d = deferModifications(its, { spike: true, spikeSinceMs: now - 60_000, now });
  assert.deepEqual(d.deferred.map((x) => x.id), ["ms:1:lad:1", "pm:1:t:1", "x"]);
  assert.deepEqual(d.intents.map((x) => x.id), ["cl:1:fg", "k", "pl:1:1", "hard"]);
  assert.equal(deferModifications(its, { spike: true, spikeSinceMs: now - LIQUIDITY_MODIFY_DEFER_MAX_MS, now }).deferred.length, 0, "after 10 minutes it is sent");
  assert.equal(deferModifications(its, { spike: false, now }).deferred.length, 0);
  // In planIntents over every hand fixture: a spike only ever removes modifications; every close and kill stays.
  let deferredSome = 0;
  // SLG1 (2026-11-23): the profit-lock gate is on by default; open for every position here, so its locks are there to defer.
  for (const [name, raw] of handInputs()) {
    const input = { ...raw, gates: Object.fromEntries((raw.executor?.positions ?? []).map((p) => [String(p.ticket), { open: true, mfe_r: 2, mfe_atr: 2 }])) };
    const sp = Number(input.executor?.symbol?.spread_points);
    if (!input.signal || !(sp > 0)) continue;
    const calm = planIntents({ ...input, signal: { ...input.signal, ...liq({ liquidity_spread_median: sp }) } });
    const spike = planIntents({ ...input, signal: { ...input.signal, ...liq({ liquidity_spread_median: sp / 3 }) }, liquiditySpikeSince: input.now - 60_000 });
    const late = planIntents({ ...input, signal: { ...input.signal, ...liq({ liquidity_spread_median: sp / 3 }) }, liquiditySpikeSince: input.now - LIQUIDITY_MODIFY_DEFER_MAX_MS - 1 });
    const closes = (p) => p.intents.filter((it) => /close|delete/.test(it.kind)).map((it) => it.id);
    assert.deepEqual(closes(spike), closes(calm), `${name}: closes, kill and deletes are never deferred`);
    assert.ok(!spike.intents.some((it) => ["modify_sl", "modify_tp", "modify_sltp"].includes(it.kind)), `${name}: no modification during the spike`);
    assert.ok(!spike.intents.some((it) => it.kind === "open"), `${name}: no entry during the spike`);
    const mods = (p) => p.intents.filter((it) => it.kind.startsWith("modify_")).map((it) => it.id);
    if (mods(late).length) { deferredSome += 1; assert.ok(spike.notes.some((n) => n.code === "liquidity_modify_deferred")); }
  }
  assert.ok(deferredSome > 0, "some fixture had a modification to defer");
});

test("PL14. pools, sweep extremes and nodes join brokerKeyLevels with source liquidity (broker scale, no basis); never while the lens is off", () => {
  const signal = { feed_basis: 0.5, feed_basis_known: true, key_levels: "4090:4091", ...liq({ liquidity_levels: "4104.2:4104.6:pool,4111:4111:sweep,bad,4120:4119:hvn" }) };
  const levels = brokerKeyLevels(signal);
  assert.deepEqual(levels, [{ low: 4090.5, high: 4091.5 }, { low: 4104.2, high: 4104.6, source: "liquidity", kind: "pool" }, { low: 4111, high: 4111, source: "liquidity", kind: "sweep" }]);
  assert.deepEqual(brokerKeyLevels({ ...signal, liquidity_on: false }), [{ low: 4090.5, high: 4091.5 }]);
  assert.deepEqual(brokerKeyLevels({ feed_basis_known: false, ...liq({ liquidity_levels: "4104:4105:hvn" }) }), [{ low: 4104, high: 4105, source: "liquidity", kind: "hvn" }]);
  assert.deepEqual(signalLiquidityLevels({ liquidity_on: true, liquidity_levels: "" }), []);
  // The signal's fields: off (the switch, the floor or a stale state) carries nothing.
  const state = { at_ms: T0, facts: { available: true, sweep: { side: "sell_side", age_min: 3 }, thin: true }, levels: [{ low: 1, high: 2, kind: "pool" }], medians: { [nyHourOfWeek(T0)]: 12 } };
  const on = liquidityFields(state, { now: T0 + M1, knobs: lensKnobs("liquidity", "scalp", { baseline: "sufficient" }) });
  assert.deepEqual([on.liquidity_on, on.liquidity_levels, on.liquidity_spread_median, on.liquidity_spread_widen, on.liquidity_sweep, on.liquidity_thin], [true, "1:2:pool", 12, 1.8, "sell_side", true]);
  for (const knobs of [lensKnobs("liquidity", "scalp", { enabled: false }), lensKnobs("liquidity", "scalp", { floor: { liquidity: { at_ms: 1 } } })]) {
    const off = liquidityFields(state, { now: T0 + M1, knobs });
    assert.deepEqual([off.liquidity_on, off.liquidity_levels, off.liquidity_weight], [false, "", 0]);
  }
  assert.equal(liquidityFields(state, { now: T0 + 20 * M1, knobs: lensKnobs("liquidity", "scalp") }).liquidity_on, false, "a stale state");
});

// ---------------------------------------------------------------- the councils

test("PL15. the entry council's three liquidity reasons: checked against the facts, wired into the fixed list, held only while the lens is on", () => {
  assert.deepEqual([ENTRY_REASONS.liquidity_thin, ENTRY_REASONS.liquidity_sweep_with, ENTRY_REASONS.liquidity_sweep_against], ["place_limit", "enter_market", "skip"]);
  assert.ok(entryCouncilSchema("council").properties.measured.items.enum.includes("liquidity_thin"));
  const request = { side: "BUY", entry_order: "council", agent: "zone_pullback", limit: { price: 4098, away_r: 0.6 }, liquidity: { weight: 0.3, thin: true, sweep: "against" } };
  const f = entryFacts({ request, decision: null, rooms: [] });
  assert.deepEqual([f.holds.liquidity_thin, f.holds.liquidity_sweep_with, f.holds.liquidity_sweep_against], [true, false, true]);
  assert.equal(entryChoice(f, { answer: "place_limit", measured: ["liquidity_thin"], reason: "thin" }).choice, "place_limit");
  assert.equal(entryChoice(f, { answer: "skip", measured: ["liquidity_sweep_against"], reason: "against" }).choice, "skip");
  assert.equal(entryChoice(f, { answer: "enter_market", measured: ["liquidity_sweep_with"], reason: "with" }).rule, "no_measured_reason", "a reason that does not hold is the market entry");
  const offFacts = entryFacts({ request: { ...request, liquidity: undefined }, decision: null, rooms: [] });
  assert.equal(offFacts.holds.liquidity_thin, undefined);
  assert.equal(entryChoice(offFacts, { answer: "skip", measured: ["liquidity_sweep_against"], reason: "x" }).rule, "no_measured_reason");
  // planIntents files the reading only while the lens is on.
  const input = hand.get("open");
  const council = { ...input, settings: { ...input.settings, entry_order: "council" }, executor: { ...input.executor, executor: { version: "1.21" } } };
  const req = planIntents({ ...council, signal: { ...input.signal, action: "ENTER_LIMIT", ...liq({ liquidity_spread_median: 20, liquidity_thin: true, liquidity_sweep: "sell_side" }) } }).entry_request;
  assert.deepEqual(req.liquidity, { weight: 0.3, thin: true, sweep: "with" });
  assert.equal(planIntents({ ...council, signal: { ...input.signal, action: "ENTER_LIMIT" } }).entry_request.liquidity, undefined, "off: the request is today's");
});

test("PL16. the Position Manager: liquidity_sweep_against is a measured reason of the loss band's cut and of A8's target nearer, by council only; off, the facts are today's", () => {
  const signal = { liquidity_on: true, liquidity_sweep: "buy_side", liquidity_sweep_age_min: 4, liquidity_weight: 0.3 };
  assert.deepEqual(liquidityOf(signal, "BUY"), { sweep: "against", sweep_side: "buy_side", age_min: 4, weight: 0.3 });
  assert.equal(liquidityOf(signal, "SELL").sweep, "with");
  assert.equal(liquidityOf({ ...signal, liquidity_on: false }, "BUY"), null);
  assert.equal(liquidityOf({ ...signal, liquidity_sweep_age_min: 20 }, "BUY"), null);
  const f = { dir: 1, side: "BUY", open: 4100, price: 4096.9, pips: -31, band_pips: 30, r: -0.6, band_r: 0.5, mode: "intraday", sl: 4090, tp: 4110, tp1: 4110, spread: 0.2, point: 0.01, beyond_tp1_pips: -131, agent: "zone_pullback", agent_conf: 0.5, agent_conf_prev: 0.5, agent_trend: "stable", stance: "BUY", with_decision: true, against_decision: false, share: 0.6, share_prev: 0.6, tp2: null, liquidity: liquidityOf(signal, "BUY") };
  assert.equal(ruleAction(f, null).rule, "council_unavailable", "a silent council: no action");
  assert.equal(ruleAction(f, { momentum: "weakening", thesis: "intact" }).rule, "hold_thesis_intact");
  const cut = ruleAction(f, { momentum: "weakening", thesis: "weakening" });
  assert.equal(cut.rule, "cut_loss");
  assert.match(cut.why, /liquidity_sweep_against/);
  const { liquidity: _l, ...off } = f;
  assert.equal(ruleAction(off, { momentum: "weakening", thesis: "weakening" }).rule, "hold_to_stop", "without the lens: no measured reason");
  assert.ok(TP_NEARER_REASONS.includes("liquidity_sweep_against"));
  const L = { delegated: false, levels: [{ low: 4105, high: 4106 }], knobs: { atr_expand: 1.5, back_share: 0.5 } };
  const near = targetPlan({ ...f, price: 4102, pips: 20, loosen: L }, { target: "nearer", target_reason: "liquidity_sweep_against", momentum: "holding", thesis: "intact" });
  assert.equal(near.ok, true);
  assert.equal(near.action.tp, 4105);
  assert.equal(targetPlan({ ...off, price: 4102, loosen: L }, { target: "nearer", target_reason: "liquidity_sweep_against" }).ok, false);
  const msg = positionCouncilMessages(f, { levels: [] });
  assert.match(msg[0].content, /liquidity_sweep_against/);
  assert.equal(JSON.parse(msg[1].content).liquidity.sweep, "against");
  assert.doesNotMatch(positionCouncilMessages(off, { levels: [] })[0].content, /liquidity/);
});

test("PL17. liquidity never opens a position alone: without a decision's side no lens input opens, sizes or prices an entry", () => {
  const base = hand.get("no_side");
  const loud = { ...base, signal: { ...base.signal, ...liq({ liquidity_spread_median: 100, liquidity_thin: true, liquidity_sweep: "sell_side", liquidity_sweep_age_min: 1, liquidity_levels: "4099:4100:pool" }) } };
  const plan = planIntents(loud);
  assert.ok(!plan.intents.some((it) => it.kind === "open" || it.kind === "place_limit"));
  assert.deepEqual(plan, planIntents(base), "the same plan as without the lens");
  // With a side, the lens never changes the entry, the stop, the target or the lot: it can only hold it back.
  const open = hand.get("open");
  const a = planIntents(open).intents.find((it) => it.kind === "open");
  const b = planIntents({ ...open, signal: { ...open.signal, ...liq({ liquidity_spread_median: 100, liquidity_sweep: "sell_side", liquidity_sweep_age_min: 1, liquidity_thin: true }) } }).intents.find((it) => it.kind === "open");
  assert.deepEqual(b, a);
  // The Decision Engine's council sees the sweep beside the plans; it adds no plan.
  const evidence = liquidityEvidence({ state: { at_ms: T0, facts: { available: true, sweep: { side: "sell_side", age_min: 2 } } }, knobs: lensKnobs("liquidity", "scalp", { baseline: "sufficient" }) }, T0 + M1);
  assert.equal(evidence.sweepFor("BUY"), "sweep_with");
  assert.equal(liquidityEvidence({ state: { at_ms: T0, facts: { available: true } }, knobs: lensKnobs("liquidity", "scalp", { enabled: false }) }, T0), null, "the switch off: nothing for the council");
  const g = { allowed: false, checks: [], plan: null, liquidity: { sweep: "sweep_with", lens_weight: 0.4 } };
  const ev = councilEvidence({ barClose: "x", cards: [], quorum: { long_share: 0, short_share: 0, neutral_share: 1, score: 0, bias: "NEUTRAL" }, guards: { long: g, short: { ...g, liquidity: undefined } } });
  assert.deepEqual(ev.long.liquidity, { sweep: "sweep_with", lens_weight: 0.4 });
  assert.equal(ev.long.plan, null);
});

test("PL18. switch off = no contribution, and the era restarts: the switches are owner settings, on by default, off their default in the era signature", () => {
  assert.equal(OMEGA_DEFAULTS.positioning_enabled, true);
  assert.equal(OMEGA_DEFAULTS.liquidity_enabled, true);
  assert.deepEqual(eraSwitches(OMEGA_DEFAULTS), []);
  assert.deepEqual(eraSwitches({ ...OMEGA_DEFAULTS, positioning_enabled: false }), ["positioning_enabled=false"]);
  assert.equal(settingsFrom({ liquidity_enabled: false }).settings.liquidity_enabled, false);
  assert.match(settingsFrom({ liquidity_enabled: "no" }).error, /liquidity_enabled must be true or false/);
  assert.equal(settingsFrom({ risk_pct: 1 }).settings.positioning_enabled, true, "kept through any other change");
});

test("PL19. the v4 parity: a signal the spread spike held live is an expected difference, not a v4-only miss", () => {
  const issued = Date.parse("2026-11-20T11:00:00Z");
  const row = { decision_key: `OANDA:XAUUSD:15:${issued - 15 * M1}`, side: "BUY", omega4_status: "closed", omega4_exit: "tp", r_omega4: 1 };
  const plain = omegaParity({ ledgerRows: [row], sinceMs: 0, now: issued + DAY });
  assert.equal(plain.v4_only, 1);
  const exp = omegaParity({ ledgerRows: [row], sinceMs: 0, now: issued + DAY, expected: [`${issued}|BUY`] });
  assert.equal(exp.v4_only, 0);
  assert.equal(exp.trades_compared, 0);
});

test("PL20. lens A's day-one readings are point in time at each 4H close, scored on 6 bars", () => {
  const rows = rowsOf(socrata(200));
  const start = Date.parse("2026-10-01T00:00:00Z");
  const bars4h = Array.from({ length: 300 }, (_, i) => { const o = start + i * 4 * 3_600_000; const c = 4000 - i; return { open_time: new Date(o).toISOString(), close_time: new Date(o + 4 * 3_600_000).toISOString(), open: c + 1, high: c + 3, low: c - 3, close: c }; });
  const readings = positioningReadings(rows, bars4h, { knobs: { crowd_pctl: 0.9, flow_z: 1 } });
  assert.ok(readings.length > 50);
  for (const r of readings) {
    const known = cotAt(rows, r.at_ms);
    assert.ok(known.released_ms <= r.at_ms, "never a report before its release");
  }
  assert.ok(readings.some((r) => r.outcome === "hit"), "a contrarian short in a falling market");
  assert.ok(readings.slice(-3).every((r) => r.outcome === null), "the last bars are pending");
  assert.equal(priceChangeFor([{ close_time: "2026-11-10T22:00:00Z", close: 4100 }, { close_time: "2026-11-17T22:00:00Z", close: 4050 }], "2026-11-17"), -1);
});

test("PL21. the ledger step end to end on D1 and KV: the active account's archive, the baseline, the facts and their state; the page, the rooms' lines and health carry no price", async () => {
  reset();
  const { runLiquidityStep, lensStatus, roomContextLine, lensHealthIssues, positioningPack, spikeSince, resetSpikeMemoForTests } = await import("../src/lens-steps.mjs");
  const { LIQUIDITY_STATE_KEY } = await import("../src/liquidity-lens.mjs");
  const e = env({ CORPUS_ORACLE_MODE: "shadow" });
  const now = T0 + 200 * M1;
  e.DB.raw.exec("CREATE TABLE omega_bridge (id INTEGER PRIMARY KEY, state TEXT); CREATE TABLE omega_connection (id INTEGER PRIMARY KEY, version INTEGER, status TEXT, server TEXT); CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT); CREATE TABLE omega_settings (id INTEGER PRIMARY KEY, settings TEXT, version INTEGER)");
  const ref = "acct_00112233aabbccdd";
  e.DB.raw.prepare("INSERT INTO omega_bridge (id, state) VALUES (1, ?)").run(JSON.stringify({ account_ref: ref, server: "Demo-MT5", connected: true, received_ms: now - 1000, account: { login_hash: "f".repeat(64) }, symbol: { name: "XAUUSD", digits: 2, spread_points: 20 } }));
  e.DB.raw.prepare("INSERT INTO omega_connection (id, version, status, server) VALUES (1, 3, 'stored', 'Demo-MT5')").run();
  await archiveBrokerBars(e.DB, { accountRef: ref, source: "mt5:demo-mt5:XAUUSD", digits: 2, connectionVersion: 3, bars: barsOf(T0, 200, { p: (i) => 4100 + Math.sin(i / 5) }), now });
  const r = await runLiquidityStep(e, { now });
  assert.equal(r.status, "ok");
  assert.equal(r.baseline, "insufficient");
  assert.equal(r.available, true);
  const state = JSON.parse(await e.SIGNAL_CACHE.get(LIQUIDITY_STATE_KEY));
  assert.equal(state.facts.baseline, "insufficient");
  assert.ok(Array.isArray(state.levels));
  // B18: no feed series in KV here, so no basis: lens B's levels stay off the feed's scale.
  assert.deepEqual([state.feed_basis, state.feed_basis_known, state.levels_feed], [null, false, []]);
  assert.equal(e.DB.raw.prepare("SELECT COUNT(*) AS n FROM liquidity_readings").get().n, 1);
  const st = await lensStatus(e, { now });
  assert.deepEqual(st.switches, { positioning_enabled: true, liquidity_enabled: true, setting: { positioning: "positioning_enabled", liquidity: "liquidity_enabled" } });
  assert.equal(st.liquidity.baseline, "insufficient");
  assert.ok(st.liquidity.weights.scalp.weight <= 0.4);
  assert.equal(forbiddenReportKeys(st).length, 0, "the page's read carries no price key");
  const line = await roomContextLine(e, "H1", { now });
  assert.equal(line.outside_quorum, true);
  assert.match(line.line, /baseline: insufficient/);
  assert.equal(await roomContextLine(e, "H4", { now }), null, "no CFTC report stored yet");
  await storeCotRows(e.DB, parseCotRows("disaggregated", socrata(200)), { now: Date.parse("2026-11-21T00:00:00Z"), backfill: true });
  resetPositioningMemoForTests();
  const h4 = await roomContextLine(e, "H4", { now: Date.parse("2026-11-21T00:00:00Z") });
  assert.match(h4.line, /^Positioning \(CFTC as of 2026-11-17/);
  assert.equal((await positioningPack(e, { now: Date.parse("2026-11-21T00:00:00Z") })).crowding, "crowded_long");
  const issues = await lensHealthIssues(e, now);
  assert.ok(Array.isArray(issues));
  // The owner's switch off: no line, no pack fact, no facts on the page.
  e.DB.raw.prepare("INSERT INTO omega_settings (id, settings, version) VALUES (1, ?, 1)").run(JSON.stringify({ ...OMEGA_DEFAULTS, positioning_enabled: false, liquidity_enabled: false }));
  resetLensStateMemoForTests();
  assert.equal(await roomContextLine(e, "H1", { now }), null);
  assert.equal(await positioningPack(e, { now }), null);
  const off = await lensStatus(e, { now });
  assert.equal(off.liquidity.facts, null);
  assert.equal(off.positioning.weights.swing.weight, 0);
  // The whole ledger step: lens B, lens A's 4H readings (point in time, written once), the floor.
  const { runLensStep } = await import("../src/lens-steps.mjs");
  const s0 = Date.parse("2026-11-21T00:00:00Z");
  const bars4h = Array.from({ length: 200 }, (_, i) => { const o = s0 - (200 - i) * 4 * 3_600_000; const c = 4000 - i; return { open_time: new Date(o).toISOString(), close_time: new Date(o + 4 * 3_600_000).toISOString(), open: c + 1, high: c + 3, low: c - 3, close: c }; });
  await e.SIGNAL_CACHE.put("market-data:v2:series:OANDA:XAUUSD|4h", JSON.stringify({ candles: bars4h }));
  resetPositioningMemoForTests();
  const step = await runLensStep(e, { now: s0 });
  assert.equal(step.positioning.status, "ok");
  assert.ok(step.positioning.stored > 10);
  assert.equal(step.floor.status, "ok");
  await e.SIGNAL_CACHE.delete("lens:positioning:scored");
  const again = await runLensStep(e, { now: s0 + 60_000 });
  assert.equal(again.positioning.stored, 0, "written once");
  // The spike clock: it starts at the first spiking sync and holds while the spike lasts.
  resetSpikeMemoForTests();
  assert.equal(await spikeSince(e, true, { now }), now);
  assert.equal(await spikeSince(e, true, { now: now + 60_000 }), now);
  assert.equal(await spikeSince(e, false, { now: now + 120_000 }), null);
});

test("PL21b. the page's fixture (test/fixtures/nexus-intel/lens.json, Track C1) carries every key GET /api/lens returns, with its type, and no price", async () => {
  // The route's body ({ status: "ok", ...lensStatus }) with every part present: lens B's facts from the ledger step, lens A's
  // report and facts, scored readings of each kind, Aether's policy and lens A at its floor (lens B not).
  reset();
  const { runLiquidityStep, lensStatus } = await import("../src/lens-steps.mjs");
  const e = env({ CORPUS_ORACLE_MODE: "shadow" });
  const now = T0 + 200 * M1;
  e.DB.raw.exec("CREATE TABLE omega_bridge (id INTEGER PRIMARY KEY, state TEXT); CREATE TABLE omega_connection (id INTEGER PRIMARY KEY, version INTEGER, status TEXT, server TEXT); CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT); CREATE TABLE omega_settings (id INTEGER PRIMARY KEY, settings TEXT, version INTEGER)");
  const ref = "acct_00112233aabbccdd";
  e.DB.raw.prepare("INSERT INTO omega_bridge (id, state) VALUES (1, ?)").run(JSON.stringify({ account_ref: ref, server: "Demo-MT5", connected: true, received_ms: now - 1000, account: { login_hash: "f".repeat(64) }, symbol: { name: "XAUUSD", digits: 2, spread_points: 20 } }));
  e.DB.raw.prepare("INSERT INTO omega_connection (id, version, status, server) VALUES (1, 3, 'stored', 'Demo-MT5')").run();
  await archiveBrokerBars(e.DB, { accountRef: ref, source: "mt5:demo-mt5:XAUUSD", digits: 2, connectionVersion: 3, bars: barsOf(T0, 200, { p: (i) => 4100 + Math.sin(i / 5) }), now });
  assert.equal((await runLiquidityStep(e, { now })).status, "ok");
  await storeCotRows(e.DB, parseCotRows("disaggregated", socrata(200, { net: (i) => 100_000 + 400 * i + (i % 7) * 900 })), { now: now - DAY, backfill: true });
  for (let i = 0; i < 24; i++) await recordLensReading(e.DB, { id: `h4:${i}`, lens: "positioning", kind: "h4", at_ms: now - i * 4 * HOUR, outcome: i % 3 ? "miss" : "hit" }, { now });
  for (let i = 0; i < 11; i++) await recordLensReading(e.DB, { id: `liq:${i}`, lens: "liquidity", kind: i % 3 ? "sweep" : "block", at_ms: now - i * HOUR, outcome: i % 4 ? "hit" : "miss" }, { now });
  await e.SIGNAL_CACHE.put(LENS_POLICY_KEY, JSON.stringify({ values: { "liquidity.council_weight_scalp": 0.36 }, doctrine_sha: "b".repeat(64), version: 4, pulled_at: new Date(now - HOUR).toISOString() }));
  await e.SIGNAL_CACHE.put(LENS_FLOOR_KEY, JSON.stringify({ positioning: { at_ms: now - DAY, doctrine_sha: "b".repeat(64), score: 0.417, n: 24, score_floor: 0.45 } }));
  resetLensStateMemoForTests();
  const route = { status: "ok", ...(await lensStatus(e, { now })) };
  assert.ok(route.positioning.facts && route.liquidity.facts && route.positioning.floor && route.liquidity.score.kinds.sweep, "every part of the body is present");

  const fixture = JSON.parse(readFileSync(new URL("./fixtures/nexus-intel/lens.json", import.meta.url), "utf8"));
  const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const gaps = [];
  (function walk(r, f, at) {
    for (const [k, v] of Object.entries(r)) {
      const p = at ? `${at}.${k}` : k;
      if (f == null || !Object.hasOwn(f, k)) { gaps.push(`${p}: missing from lens.json`); continue; }
      // A null from the route says nothing about the type; anything else is the same type in the fixture.
      if (v !== null && kind(f[k]) !== kind(v)) { gaps.push(`${p}: ${kind(f[k])} in lens.json, ${kind(v)} from the route`); continue; }
      if (kind(v) === "object") walk(v, f[k], p);
      if (kind(v) === "array" && v.length && kind(v[0]) === "object") {
        if (!f[k].length) gaps.push(`${p}: an empty array in lens.json`); else walk(v[0], f[k][0], `${p}[0]`);
      }
    }
  })(route, fixture, "");
  assert.deepEqual(gaps, [], "lens.json follows the route (regenerate it from src/lens-steps.mjs lensStatus when the body changes)");
  assert.equal(fixture.status, "ok");
  assert.equal(forbiddenReportKeys(fixture).length, 0, "the fixture carries no price key either");
  // Values the route can return: the weight sources, the baselines, the modes and the CFTC series.
  for (const l of ["positioning", "liquidity"]) {
    assert.deepEqual(Object.keys(fixture[l].weights), ["scalp", "intraday", "swing", "range"]);
    for (const w of Object.values(fixture[l].weights)) assert.ok(["anchor", "aether", "floor_rollback", "switch_off", "anchor_baseline_insufficient"].includes(w.source), w.source);
  }
  assert.ok(["sufficient", "insufficient", "unavailable"].includes(fixture.liquidity.baseline));
  assert.ok(["scalp", "intraday", "swing", "range"].includes(fixture.mode));
  assert.ok(["disaggregated", "legacy"].includes(fixture.positioning.cot.series));
  assert.equal(fixture.liquidity.line, liquidityLine(fixture.liquidity.facts), "lens B's line is the route's own text of its facts");
});

// ---------------------------------------------------------------- B2: the backfill within D1's 100 bound parameters

/**
 * A D1 as Cloudflare runs it: a statement binding more than 100 parameters fails when it runs, and db.batch is one
 * transaction (a failing statement rolls back the whole batch, which is how every 104-parameter backfill batch was
 * lost). It records the largest statement bound and every statement run.
 */
function strictD1() {
  const raw = new DatabaseSync(":memory:"), seen = { max: 0, queries: 0, batches: 0 };
  const stmt = (sql, params = []) => ({
    sql, params,
    bind: (...a) => stmt(sql, a.map((v) => (v === undefined ? null : v))),
    check() {
      if (params.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${params.length})`);
      seen.max = Math.max(seen.max, params.length); seen.queries += 1;
    },
    async run() { this.check(); const r = raw.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    async first() { this.check(); return raw.prepare(sql).get(...params) ?? null; },
    async all() { this.check(); return { results: raw.prepare(sql).all(...params) }; }
  });
  return {
    raw, seen, prepare: (sql) => stmt(sql),
    async batch(list) {
      seen.batches += 1;
      raw.exec("BEGIN");
      try { const out = []; for (const st of list) out.push(await st.run()); raw.exec("COMMIT"); return out; } catch (e) { raw.exec("ROLLBACK"); throw e; }
    }
  };
}
const corpusSql = "CREATE TABLE corpus_bars (source TEXT NOT NULL, minute_ms INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, tick_volume INTEGER, spread_points INTEGER, connection_version INTEGER NOT NULL, received_ms INTEGER NOT NULL, PRIMARY KEY (source, minute_ms))";
function seedCorpus(db, source, version, from, n, { bars = null } = {}) {
  const ins = db.raw.prepare("INSERT INTO corpus_bars (source, minute_ms, o, h, l, c, tick_volume, spread_points, connection_version, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const b of bars ?? barsOf(from, n, { p: (i) => 4100 + Math.sin(i / 7) })) ins.run(source, b.t, b.o, b.h, b.l, b.c, b.v, b.s, version, b.t + M1);
}
const SRC = "mt5:demo-mt5:XAUUSD", REF = "acct_00112233aabbccdd";
const omegaTables = "CREATE TABLE omega_bridge (id INTEGER PRIMARY KEY, state TEXT); CREATE TABLE omega_connection (id INTEGER PRIMARY KEY, version INTEGER, status TEXT, server TEXT); CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT); CREATE TABLE omega_settings (id INTEGER PRIMARY KEY, settings TEXT, version INTEGER)";
function connected(db, now, version = 92) {
  db.raw.exec(omegaTables);
  db.raw.prepare("INSERT INTO omega_bridge (id, state) VALUES (1, ?)").run(JSON.stringify({ account_ref: REF, server: "Demo-MT5", connected: true, received_ms: now - 1000, account: { login_hash: "f".repeat(64) }, symbol: { name: "XAUUSD", digits: 2, spread_points: 20 } }));
  db.raw.prepare("INSERT INTO omega_connection (id, version, status, server) VALUES (1, ?, 'stored', 'Demo-MT5')").run(version);
}
// A seeded walk with volume spikes: the sweep detector finds sweeps in it, so a replay records and scores readings.
function walk(from, n, seed = 7) {
  let s = seed, p = 4100;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => { const o = p; p += (rnd() - 0.5) * 1.2; const spike = rnd() < 0.06; return { t: from + i * M1, o, h: Math.max(o, p) + rnd() * (spike ? 2.5 : 0.4), l: Math.min(o, p) - rnd() * (spike ? 2.5 : 0.4), c: p, v: Math.round(spike ? 900 + rnd() * 200 : 80 + rnd() * 40), s: 20 }; });
}

test("PL22. the backfill lands 1, 7, 8, 240 and 2,419 bars on a D1 that runs a batch as one transaction and refuses more than 100 bound parameters", async () => {
  for (const n of [1, 7, 8, 240, 2419]) {
    reset();
    const db = strictD1();
    db.raw.exec(corpusSql);
    seedCorpus(db, SRC, 90, T0, n);
    const e = { DB: db, SIGNAL_CACHE: kv() };
    const r = await backfillBrokerBars(e, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 90, now: T0 + 10 * DAY });
    assert.deepEqual([r.status, r.sent, r.added, r.versions], ["backfilled", n, n, [90]], `${n} bars`);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM broker_bars_1m WHERE connection_version = 90").get().n, n);
    assert.equal(db.seen.max, Math.min(n, 7) * 13, `13 x ${Math.min(n, 7)} bound (${db.seen.max})`);
    const marker = JSON.parse(await e.SIGNAL_CACHE.get(backfillKey(backfillIdentity(REF, SRC, [90]))));
    assert.deepEqual([marker.added, marker.from_ms, marker.to_ms, marker.versions], [n, T0, T0 + (n - 1) * M1, [90]]);
  }
  // The production failure: one 104-parameter statement rolls back its whole batch, the statements before it too.
  const db = strictD1();
  db.raw.exec("CREATE TABLE x (a INTEGER)");
  const ok = db.prepare("INSERT INTO x (a) VALUES (?)").bind(1);
  const big = db.prepare(`INSERT INTO x (a) VALUES ${Array(104).fill("(?)").join(", ")}`).bind(...Array(104).fill(2));
  await assert.rejects(db.batch([ok, big]), /too many SQL variables \(104\)/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM x").get().n, 0, "rolled back");
});

test("PL23. archived versions are backfilled under their own version, with the live rows' legacy flag: v90 rows keep 90 under connection 92; a rerun is a no-op; a failure logs once and retries", async () => {
  reset();
  const db = strictD1();
  db.raw.exec(corpusSql);
  // Connection 90: 300 minutes in the corpus, the last 50 archived live; connection 92 (now): 10 minutes, all archived.
  seedCorpus(db, SRC, 90, T0, 300);
  seedCorpus(db, SRC, 92, T0 + 400 * M1, 10);
  const now = T0 + 2 * DAY;
  await archiveBrokerBars(db, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 90, bars: barsOf(T0 + 250 * M1, 50, { p: (i) => 4100 + Math.sin((i + 250) / 7) }), now });
  await archiveBrokerBars(db, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 92, bars: barsOf(T0 + 400 * M1, 10, { p: (i) => 4100 + Math.sin(i / 7) }), now });
  // Another account's source and a macro source are never read.
  seedCorpus(db, "mt5:other:XAUUSD", 90, T0, 20);
  seedCorpus(db, "mt5macro:demo-mt5:XAGUSD", 90, T0, 20);
  const store = kv();
  store.m.set(LIQUIDITY_BACKFILL_KEY, JSON.stringify({ at: "2026-11-22T23:03:16.663Z", rows: 4 }));
  const e = { DB: db, SIGNAL_CACHE: store };
  // The bridge state lags (no login hash: legacy): the backfill takes the live rows' flag (0) instead.
  const r = await backfillBrokerBars(e, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 92, legacy: true, now });
  assert.deepEqual([r.status, r.versions, r.sent, r.added], ["backfilled", [90, 92], 310, 250], "the v1 marker does not stop it");
  const byVersion = Object.fromEntries(db.raw.prepare("SELECT connection_version AS v, COUNT(*) AS n FROM broker_bars_1m WHERE account_ref = ? AND source = ? GROUP BY v").all(REF, SRC).map((x) => [x.v, x.n]));
  assert.deepEqual(byVersion, { 90: 300, 92: 10 }, "v90 rows keep 90 under connection 92");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM broker_bars_1m WHERE legacy_ref <> 0").get().n, 0, "the live rows' legacy flag");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM broker_bars_1m WHERE source <> ?").get(SRC).n, 0);
  // The marker: the span the rows added cover (minutes 0-249 of connection 90).
  const marker = JSON.parse(await store.get(backfillKey(r.identity)));
  assert.deepEqual([marker.added, marker.from_ms, marker.to_ms >= T0 + 249 * M1, marker.rebuilt], [250, T0, true, false]);
  const queries = db.seen.queries;
  const again = await backfillBrokerBars(e, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 92, now: now + HOUR });
  assert.deepEqual([again.status, again.identity], ["done", backfillIdentity(REF, SRC, [90, 92])], "a rerun is a no-op");
  assert.ok(db.seen.queries - queries <= 1, `the version list comes from KV, not a scan of the archive (${db.seen.queries - queries} queries)`);
  assert.deepEqual(JSON.parse(await store.get(backfillVersionsKey(REF, SRC))).versions, [90, 92]);
  // A new connection version is a new identity: it backfills again, adding nothing already archived.
  seedCorpus(db, SRC, 93, T0 + 500 * M1, 5);
  const v93 = await backfillBrokerBars(e, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 93, now: now + 2 * HOUR });
  assert.deepEqual([v93.versions, v93.added], [[90, 92, 93], 5]);
  // The keys stay short whatever the number of versions (KV keys are at most 512 bytes).
  const many = Array.from({ length: 400 }, (_, i) => i + 1);
  assert.ok(backfillKey(backfillIdentity(REF, SRC, many)).length < 120);
  assert.equal(backfillIdentity(REF, SRC, [92, 90]), backfillIdentity(REF, SRC, [90, 92]), "sorted");
  assert.match(shortHash("90,92"), /^[0-9a-f]{8}$/);
  // A failure: no marker, one liquidity_backfill_failed per identity, retried next step.
  reset();
  const broken = strictD1();
  broken.raw.exec(corpusSql);
  seedCorpus(broken, SRC, 90, T0, 30);
  let fail = true;
  const flaky = { raw: broken.raw, batch: (l) => broken.batch(l), prepare: (sql) => { if (fail && sql.startsWith("INSERT OR IGNORE INTO broker_bars_1m")) throw new Error("D1_ERROR: overloaded"); return broken.prepare(sql); } };
  const logs = [];
  const e2 = { DB: flaky, SIGNAL_CACHE: kv() };
  const log = async (action, detail) => { logs.push([action, detail]); };
  const f1 = await backfillBrokerBars(e2, { accountRef: REF, source: SRC, connectionVersion: 90, now, log });
  const f2 = await backfillBrokerBars(e2, { accountRef: REF, source: SRC, connectionVersion: 90, now: now + 5 * M1, log });
  assert.deepEqual([f1.status, f2.status], ["failed", "failed"]);
  assert.deepEqual(logs, [["liquidity_backfill_failed", { error: "D1_ERROR: overloaded" }]], "one event per identity");
  assert.equal(JSON.parse(await e2.SIGNAL_CACHE.get(backfillKey(backfillIdentity(REF, SRC, [90])))).status, "copying", "no finished marker after a failure");
  assert.ok(await e2.SIGNAL_CACHE.get(backfillFailedKey(backfillIdentity(REF, SRC, [90]))));
  fail = false;
  const ok = await backfillBrokerBars(e2, { accountRef: REF, source: SRC, connectionVersion: 90, now: now + 10 * M1, log });
  assert.deepEqual([ok.status, ok.added, logs.length], ["backfilled", 30, 1]);
});

test("PL24. the ledger step rebuilds the baseline (no reset) and replays only the minutes the backfill added, once, in batches; a rerun changes neither", async () => {
  reset();
  const { runLiquidityStep, liquidityReplayKey, LIQUIDITY_REPLAY_KEY } = await import("../src/lens-steps.mjs");
  const { baselineKey, baselineIdentity, LIQUIDITY_STATE_KEY } = await import("../src/liquidity-lens.mjs");
  const db = strictD1();
  db.raw.exec(corpusSql);
  const now = T0 + 2600 * M1;
  connected(db, now);
  // Connection 90: 2,400 minutes of a walk with sweeps, only the last 100 archived live; connection 92: 20, archived.
  const v90 = walk(T0, 2400);
  seedCorpus(db, SRC, 90, 0, 0, { bars: v90 });
  seedCorpus(db, SRC, 92, T0 + 2450 * M1, 20);
  await archiveBrokerBars(db, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 90, bars: v90.slice(-100), now });
  await archiveBrokerBars(db, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 92, bars: barsOf(T0 + 2450 * M1, 20), now });
  const store = kv();
  // Production today: the day-one replay and the v1 backfill marker are written; the baseline and the state are
  // current for this identity (same hour), so only the backfill can force the rebuild.
  const acct = { accountRef: REF, source: SRC, digits: 2 };
  store.m.set(LIQUIDITY_REPLAY_KEY, JSON.stringify({ at: "2026-11-20T10:57:32.094Z", sweeps: 0 }));
  store.m.set(LIQUIDITY_BACKFILL_KEY, JSON.stringify({ at: "2026-11-22T23:03:16.663Z", rows: 4 }));
  store.m.set(baselineKey(REF), JSON.stringify({ identity: baselineIdentity(acct), updated_ms: now - 10 * M1, hours: {}, baseline: "insufficient", baseline_weeks: 0, reset_at: "2026-11-01T00:00:00.000Z", hour_ms: Math.floor(now / HOUR) * HOUR }));
  store.m.set(LIQUIDITY_STATE_KEY, JSON.stringify({ at_ms: now - 5 * M1, identity: baselineIdentity(acct), baseline_at: now - 10 * M1 }));
  const logs = [];
  const e = { DB: db, SIGNAL_CACHE: store };
  const first = await runLiquidityStep(e, { now, log: async (action, detail) => { logs.push(action); } });
  assert.deepEqual([first.status, first.backfill, first.backfill_added, first.rebuilt], ["ok", "backfilled", 2300, true]);
  const built = JSON.parse(await store.get(baselineKey(REF)));
  assert.equal(built.updated_ms, now, "rebuilt from the archive");
  assert.ok(Object.keys(built.hours).length > 0);
  assert.equal(built.reset_at, "2026-11-01T00:00:00.000Z", "a rebuild, not a reset");
  assert.ok(!logs.includes("liquidity_baseline_reset"));
  const identity = backfillIdentity(REF, SRC, [90, 92]);
  assert.ok(first.replay && first.replay.sweeps > 0, `the added minutes' sweeps are replayed (${first.replay?.sweeps})`);
  const replayed = JSON.parse(await store.get(liquidityReplayKey(identity)));
  // The span the backfill added: minutes 0 to 2,299, to the statement (7 rows) that held the last added minute.
  assert.deepEqual([replayed.from_ms, replayed.to_ms >= T0 + 2299 * M1 && replayed.to_ms < T0 + 2306 * M1], [T0, true], "only the span the backfill added");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM lens_readings WHERE lens = 'liquidity' AND kind = 'sweep' AND at_ms > ?").get(replayed.to_ms).n, 0, "no reading from minutes that were already archived");
  assert.equal(first.replay.added, db.raw.prepare("SELECT COUNT(*) AS n FROM lens_readings WHERE lens = 'liquidity' AND kind = 'sweep'").get().n);
  assert.ok(db.seen.batches >= 1 && db.seen.max > 80 && db.seen.max <= 91, `7-row statements ran (${db.seen.max} bound)`);
  assert.ok(JSON.parse(await store.get(backfillKey(identity))).rebuilt);
  const second = await runLiquidityStep(e, { now: now + 5 * M1 });
  assert.deepEqual([second.status, second.backfill, "backfill_added" in second, "replay" in second, "rebuilt" in second], ["ok", "done", false, false, false], "idempotent");
});

test("PL25. a step that fails after the marker still rebuilds and replays at the next step; a marker cut off before its final write is resumed", async () => {
  const { runLiquidityStep, liquidityReplayKey } = await import("../src/lens-steps.mjs");
  for (const cut of ["replay", "marker"]) {
    reset();
    const db = strictD1();
    db.raw.exec(corpusSql);
    const now = T0 + 2600 * M1;
    connected(db, now);
    const v90 = walk(T0, 2400);
    seedCorpus(db, SRC, 90, 0, 0, { bars: v90 });
    seedCorpus(db, SRC, 92, T0 + 2450 * M1, 20);
    await archiveBrokerBars(db, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 90, bars: v90.slice(-100), now });
    await archiveBrokerBars(db, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 92, bars: barsOf(T0 + 2450 * M1, 20), now });
    const inner = kv();
    inner.m.set("liquidity:replay:v1", JSON.stringify({ at: "2026-11-20T10:57:32.094Z", sweeps: 0 }));
    const identity = backfillIdentity(REF, SRC, [90, 92]);
    let failOnce = true;
    // KV refuses one write once (a 429): the replay's marker, or the backfill's final marker after its rows committed.
    const put = async (k, v, o) => {
      const finalMarker = k === backfillKey(identity) && JSON.parse(v).status === "copied";
      if (failOnce && ((cut === "replay" && k === liquidityReplayKey(identity)) || (cut === "marker" && finalMarker))) { failOnce = false; throw new Error("KV 429"); }
      return inner.put(k, v, o);
    };
    const e = { DB: db, SIGNAL_CACHE: { ...inner, get: inner.get, put } };
    const down = await runLiquidityStep(e, { now });
    // The replay's marker failing fails the step; the backfill's final marker failing fails only the backfill.
    assert.equal(cut === "replay" ? down.status : down.backfill, "failed", cut);
    const back = await runLiquidityStep(e, { now: now + 5 * M1 });
    assert.equal(back.status, "ok", cut);
    assert.ok(back.replay && back.replay.sweeps > 0, `${cut}: replayed at the next step`);
    assert.ok(await inner.get(liquidityReplayKey(identity)), cut);
    const marker = JSON.parse(await inner.get(backfillKey(identity)));
    assert.equal(marker.rebuilt, true, cut);
    if (cut === "marker") assert.deepEqual([marker.resumed, marker.added, marker.from_ms], [true, 0, T0], "resumed over the whole span copied (what it added is no longer known)");
    const third = await runLiquidityStep(e, { now: now + 10 * M1 });
    assert.equal("replay" in third, false, `${cut}: once`);
  }
});

test("PL26. runLensStep end to end over a backfill: the replayed readings reach the floor step (the backfill replay may floor lens B on day one, RFC §7.2-§7.3)", async () => {
  reset();
  const { runLensStep } = await import("../src/lens-steps.mjs");
  const { belowFloor, LENS_FLOOR_KEY: FLOOR } = await import("../src/lens-policy.mjs");
  const db = strictD1();
  db.raw.exec(corpusSql);
  const now = T0 + 2600 * M1;
  connected(db, now);
  const v90 = walk(T0, 2400, 11);
  seedCorpus(db, SRC, 90, 0, 0, { bars: v90 });
  seedCorpus(db, SRC, 92, T0 + 2450 * M1, 20);
  await archiveBrokerBars(db, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 90, bars: v90.slice(-100), now });
  await archiveBrokerBars(db, { accountRef: REF, source: SRC, digits: 2, connectionVersion: 92, bars: barsOf(T0 + 2450 * M1, 20), now });
  const store = kv();
  store.m.set("liquidity:replay:v1", JSON.stringify({ at: "2026-11-20T10:57:32.094Z", sweeps: 0 }));
  const e = { DB: db, SIGNAL_CACHE: store };
  const out = await runLensStep(e, { now });
  assert.equal(out.liquidity.status, "ok");
  assert.ok(out.liquidity.replay.sweeps > 0);
  const decisive = db.raw.prepare("SELECT outcome FROM lens_readings WHERE lens = 'liquidity' AND outcome IN ('hit', 'miss')").all();
  assert.ok(decisive.length >= 20, `enough replayed readings to be scored (${decisive.length})`);
  assert.ok(["ok", "floored"].includes(out.floor.status));
  const score = out.floor.lenses.liquidity.score;
  assert.equal(score.n, Math.min(decisive.length, score.n), "the floor step scores the replayed readings");
  assert.ok(score.n >= 20);
  // This walk's replay scores 40 hits of 93 (0.43): under the floor, so lens B drops to its floor at once, as the
  // production backfill is expected to on day one (RFC §7.2-§7.3 working as designed: the floor lowers lens B's weight).
  assert.deepEqual([score.hits, score.n, belowFloor(score, {})], [40, 93, true]);
  assert.deepEqual([out.floor.status, out.floor.lenses.liquidity.floored], ["floored", true]);
  assert.ok(JSON.parse(await store.get(FLOOR)).liquidity);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM omega_events WHERE action = 'lens_weight_floor'").get().n, 1);
});

test("PL27. B18: the ledger step writes the feed basis (feedBasis over the archive and the feed's 5m series) and lens B's levels on the feed's scale", async () => {
  reset();
  const { runLiquidityStep } = await import("../src/lens-steps.mjs");
  const { LIQUIDITY_STATE_KEY } = await import("../src/liquidity-lens.mjs");
  const e = env({ CORPUS_ORACLE_MODE: "shadow" });
  const now = T0 + 200 * M1;
  e.DB.raw.exec("CREATE TABLE omega_bridge (id INTEGER PRIMARY KEY, state TEXT); CREATE TABLE omega_connection (id INTEGER PRIMARY KEY, version INTEGER, status TEXT, server TEXT); CREATE TABLE omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT); CREATE TABLE omega_settings (id INTEGER PRIMARY KEY, settings TEXT, version INTEGER)");
  const ref = "acct_00112233aabbccdd";
  e.DB.raw.prepare("INSERT INTO omega_bridge (id, state) VALUES (1, ?)").run(JSON.stringify({ account_ref: ref, server: "Demo-MT5", connected: true, received_ms: now - 1000, account: { login_hash: "f".repeat(64) }, symbol: { name: "XAUUSD", digits: 2, spread_points: 20 } }));
  e.DB.raw.prepare("INSERT INTO omega_connection (id, version, status, server) VALUES (1, 3, 'stored', 'Demo-MT5')").run();
  const price = (i) => 4100 + Math.sin(i / 5);
  await archiveBrokerBars(e.DB, { accountRef: ref, source: "mt5:demo-mt5:XAUUSD", digits: 2, connectionVersion: 3, bars: barsOf(T0, 200, { p: price }), now });
  // The feed 0.5 below the broker at every 5m close (the broker's M1 bar closing at the same minute).
  const feed = [];
  for (let k = 1; k <= 39; k += 1) { const close = T0 + k * 5 * M1; feed.push({ open_time: new Date(close - 5 * M1).toISOString(), close_time: new Date(close).toISOString(), open: 1, high: 1, low: 1, close: Math.round((price(k * 5 - 1) - 0.5) * 100) / 100 }); }
  await e.SIGNAL_CACHE.put("market-data:v2:series:OANDA:XAUUSD|5m", JSON.stringify({ candles: feed }));
  assert.equal((await runLiquidityStep(e, { now })).status, "ok");
  const state = JSON.parse(await e.SIGNAL_CACHE.get(LIQUIDITY_STATE_KEY));
  assert.equal(state.feed_basis_known, true);
  assert.ok(Math.abs(state.feed_basis - 0.5) < 0.011, String(state.feed_basis));
  assert.equal(state.levels_feed.length, state.levels.length);
  state.levels.forEach((z, i) => { assert.ok(Math.abs(z.low - state.feed_basis - state.levels_feed[i].low) < 0.006); assert.equal(state.levels_feed[i].kind, z.kind); });
});
