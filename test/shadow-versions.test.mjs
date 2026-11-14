import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  CONTROLS, CANDIDATES, RETIRED_CANDIDATES, ENGINE_FAMILIES, SHADOW_WARMUP_BARS, GMI_LOOKBACK_BARS, computeVersion, runShadowVersions, readShadowVersions, stuckEpisodes, signTestP,
  resetShadowSchemaCacheForTests, resetShadowReadCacheForTests
, latchCandidate } from "../src/shadow-versions.mjs";
import { resetOutcomeSchemaCacheForTests, SCORING_VERSION } from "../src/outcome-scoring.mjs";
import { replayProphetR37ClosedBars } from "../src/prophet-r37-oscillator.mjs";
import { regateGmi } from "../src/gmi-regate.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  const stmt = (sql, params = []) => ({
    bind: (...a) => stmt(sql, a.map(v => (v === undefined ? null : v))),
    async run() { db.prepare(sql).run(...params); return { success: true }; },
    async first() { return db.prepare(sql).get(...params) ?? null; },
    async all() { return { results: db.prepare(sql).all(...params) }; }
  });
  return { raw: db, prepare: (sql) => stmt(sql) };
}

/** Deterministic H1 bars: a noisy oscillation (seeded), so structure states occur. */
function syntheticBars(n, start = Date.parse("2026-09-01T00:00:00Z")) {
  let seed = 7, p = 4000;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => {
    const o = p; p += Math.sin(i / 9) * 6 + (rnd() - 0.5) * 14;
    const h = Math.max(o, p) + rnd() * 6, l = Math.min(o, p) - rnd() * 6;
    return { open_time: new Date(start + i * 3_600_000).toISOString(), close_time: new Date(start + (i + 1) * 3_600_000).toISOString(), open: o, high: h, low: l, close: p, volume: 1000 + Math.round(rnd() * 800) };
  });
}
const BARS = syntheticBars(420);
const NOW = Date.parse(BARS.at(-1).close_time) + 60_000;
const series = (bars) => ({ async get(k) { return k === "market-data:v2:series:OANDA:XAUUSD|1h" ? JSON.stringify({ candles: bars }) : null; } });
const LATCH = { id: "prophet_r37@latch-test", family: "prophet_r37", role: "candidate", timeframe: "60", params: { stateMaxAge: 8 }, reference: "none", change: "test latch" };
function reset() { resetShadowSchemaCacheForTests(); resetOutcomeSchemaCacheForTests(); resetShadowReadCacheForTests(); }

test("controls are the active engines with their default parameters; P5 candidates expire the latch sooner", () => {
  assert.deepEqual(CONTROLS.map(c => c.id), ["prophet_r37@active", "prophet_r38@active", "gmi_v12_70@active"]);
  assert.ok(CONTROLS.every(c => c.params === null && c.role === "control"));
  // P5 review (owner decision 2026-11-07): prophet_r37@latch12 and prophet_r38@latch8 are stopped;
  // the GMI candidates at their review (owner 2026-11-14).
  assert.deepEqual(CANDIDATES.map(c => [c.id, c.params]), [["prophet_r37@latch8", { stateMaxAge: 8 }]]);
  assert.ok(CANDIDATES.every(c => /^\d{4}-\d{2}-\d{2}$/.test(c.review.by) && c.review.rule), "every running candidate has a review date and rule");
  assert.deepEqual(RETIRED_CANDIDATES.map(r => [r.id, r.retired_on]), [["prophet_r37@latch12", "2026-11-07"], ["prophet_r38@latch8", "2026-11-07"], ["gmi_v12_70@latch8", "2026-11-14"], ["gmi_v12_70@latch12", "2026-11-14"]]);
  assert.ok(RETIRED_CANDIDATES.every(r => !CANDIDATES.some(c => c.id === r.id) && r.reason && r.result && r.family === r.id.split("@")[0]));
  assert.ok(RETIRED_CANDIDATES.filter(r => r.family === "gmi_v12_70").every(r => r.result.differing_stances === 0 && r.result.p_value === null), "the GMI latch never changed a stance");
  assert.ok(CANDIDATES.every(c => c.role === "candidate" && c.reference === "none" && c.timeframe === "60"));
  assert.deepEqual(Object.keys(ENGINE_FAMILIES), ["prophet_r37", "prophet_r38", "gmi_v12_70"]);
});

test("the R37 control reproduces the active replay exactly", () => {
  const out = computeVersion(CONTROLS[0], BARS);
  const ref = replayProphetR37ClosedBars(BARS.map((b, i) => ({ bar_index: i, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })), { mintick: 0.001 });
  assert.equal(out.length, BARS.length);
  out.forEach((o, i) => assert.deepEqual(o.fields, { d_enc: ref.structure[i].d_enc, b_enc: ref.structure[i].b_enc, subtype: ref.structure[i].subtype }));
  assert.ok(out.some(o => Math.abs(o.fields.d_enc) === 3), "the fixture must contain latched structure states");
});

test("every latch-expiry candidate holds a ±3 structure state at most its maximum age (R37 and R38)", () => {
  for (const c of [LATCH, ...CANDIDATES.filter(c => !ENGINE_FAMILIES[c.family].needs_local_records)]) {
    const max = c.params.stateMaxAge ?? c.params.state_max_age;
    let run = 0, longest = 0;
    for (const o of computeVersion(c, BARS)) { run = Math.abs(o.fields.d_enc) === 3 ? run + 1 : 0; longest = Math.max(longest, run); }
    assert.ok(longest <= max + 1, `${c.id} held ${longest} bars`);
  }
});

test("runShadowVersions stores outputs after the warm-up only, once, and scores closed horizons as source shadow", async () => {
  reset();
  const env = { DB: d1(), SIGNAL_CACHE: series(BARS) };
  const r = await runShadowVersions(env, { now: NOW, candidates: [LATCH] });
  assert.equal(r.status, "ok");
  const stored = BARS.length - SHADOW_WARMUP_BARS;
  for (const id of ["prophet_r37@active", "prophet_r38@active", LATCH.id]) {
    assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM shadow_outputs WHERE version_id = ?").get(id).n, stored);
    const scored = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM outcome_scores WHERE subject = ? AND source = 'shadow' AND scoring_version = ?").get("shadow:" + id, SCORING_VERSION).n;
    assert.equal(scored, stored - 4, "the last 4 outputs wait for their horizon");
  }
  // First computation wins: a later run on changed bars keeps the stored outputs.
  const before = env.DB.raw.prepare("SELECT stance, fields_json FROM shadow_outputs WHERE version_id = 'prophet_r37@active' ORDER BY close_time").all();
  const shifted = BARS.slice(5).concat(syntheticBars(5, Date.parse(BARS.at(-1).close_time)).map(b => ({ ...b, open: b.open + 50, high: b.high + 50, low: b.low + 50, close: b.close + 50 })));
  await runShadowVersions({ DB: env.DB, SIGNAL_CACHE: series(shifted) }, { now: Date.parse(shifted.at(-1).close_time) + 60_000, candidates: [LATCH] });
  const after = env.DB.raw.prepare("SELECT stance, fields_json FROM shadow_outputs WHERE version_id = 'prophet_r37@active' ORDER BY close_time").all();
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.length, before.length + 5);
});

test("too little history: nothing is stored", async () => {
  reset();
  const env = { DB: d1(), SIGNAL_CACHE: series(BARS.slice(0, SHADOW_WARMUP_BARS)) };
  assert.equal((await runShadowVersions(env, { now: NOW })).status, "insufficient_history");
});

test("the shadow view compares each candidate with the control on the same bars, with the RFC criteria", async () => {
  reset();
  const lastKey = "OANDA:XAUUSD:60:" + Date.parse(BARS.at(-1).open_time);
  const ctrl = computeVersion(CONTROLS[0], BARS).at(-1);
  const local = { values: { comparable: { prophet_r37_ssot: { direction: ctrl.stance === "BUY" ? 1 : ctrl.stance === "SELL" ? -1 : 0, d_enc: ctrl.fields.d_enc, structure_subtype: ctrl.fields.subtype } } } };
  const env = { DB: d1(), SIGNAL_CACHE: series(BARS), WEBHOOK_BUFFER: { async get(k) { return k === "localcalc:" + lastKey + ":prophet" ? JSON.stringify(local) : null; } } };
  await runShadowVersions(env, { now: NOW, candidates: [LATCH] });
  const view = await readShadowVersions(env, { now: NOW, days: 90, candidates: [LATCH], cache: false });
  const r37 = view.families.find(f => f.family === "prophet_r37");
  assert.deepEqual(r37.control.matches_approved_local_records, { compared: 1, agree: 1 });
  const c = r37.candidates[0];
  assert.equal(c.id, LATCH.id);
  assert.equal(c.same_bars, BARS.length - SHADOW_WARMUP_BARS - 4);
  assert.equal(c.control_on_same_bars.n, c.scored.n);
  assert.equal(c.criteria.higher_outcome_score, null, "no discovery test before its minimum sample (RFC §9.3)");
  assert.equal(c.criteria.holdout_no_worse, null);
  assert.equal(c.discovery.bars + c.holdout.bars, c.same_bars);
  assert.equal(typeof c.criteria.no_new_stuck_states, "boolean");
  assert.match(c.criteria.reference_parity, /local-only/);
  assert.equal(c.criteria.minimum_sample, false, "116 bars is below the 200-statement minimum");
  assert.equal(c.verdict, "collecting");
  assert.ok(c.differing_stances >= 0 && c.differing_stances <= c.same_bars);
  assert.equal(view.families.find(f => f.family === "prophet_r38").candidates.length, 0, "only the candidates passed in are compared");
  assert.equal(c.review, null, "a candidate without a review date has none");
  assert.deepEqual(view.families.find(f => f.family === "prophet_r38").retired.map(r => r.id), ["prophet_r38@latch8"], "stopped candidates are listed with their family");
});

test("a candidate's review is due on its date, or earlier once it has 30 decisive pairs", async () => {
  reset();
  const env = { DB: d1(), SIGNAL_CACHE: series(BARS), WEBHOOK_BUFFER: { async get() { return null; } } };
  const early = { ...LATCH, review: { by: "2099-01-01", rule: "test" } };
  const late = { ...LATCH, id: "prophet_r37@latch-late", review: { by: "2000-01-01", rule: "test" } };
  await runShadowVersions(env, { now: NOW, candidates: [early, late] });
  const view = await readShadowVersions(env, { now: NOW, days: 90, candidates: [early, late], cache: false });
  const [a, b] = view.families.find(f => f.family === "prophet_r37").candidates;
  assert.equal(a.review.decisive_pairs, a.paired.candidate_better + a.paired.control_better);
  assert.equal(a.review.min_decisive_pairs, 30);
  assert.equal(a.review.due, a.review.decisive_pairs >= 30);
  assert.equal(b.review.due, true, "past its date");
});

test("stuckEpisodes counts one episode per qualifying run", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ candle_key: "k" + i, fields: { d_enc: i < 10 ? 3 : 0, b_enc: 1, subtype: 1 } }));
  const barsByKey = new Map(rows.map((r, i) => [r.candle_key, { high: 100 + i * 5, low: 95 + i * 5 }]));
  const atrByKey = new Map(rows.map(r => [r.candle_key, 5]));
  const s = stuckEpisodes(rows, barsByKey, atrByKey);
  assert.equal(s.d_enc.episodes, 1);
  assert.equal(s.d_enc.stuck_candles, 3, "candles 8, 9 and 10 of the run qualify (range > 15 from the 4th candle, run ≥ 8 from the 8th)");
  assert.equal(s.b_enc.episodes, 1);
});

test("a higher accuracy counts only when the paired sign test says it is not chance", () => {
  assert.equal(signTestP(0, 0), null);
  assert.equal(signTestP(5, 5), 0.623);
  assert.equal(signTestP(10, 0), 0.001);
  assert.ok(signTestP(15, 5) < 0.05);
  assert.ok(signTestP(4, 2) > 0.05, "4 against 2 is chance");
});

test("GMI versions are re-gated from the approved local GMI records; bars without one have no output", async () => {
  reset();
  const ref = replayProphetR37ClosedBars(BARS.map((b, i) => ({ bar_index: i, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })), { mintick: 0.001 });
  const kvMap = new Map();
  const withRecord = BARS.slice(-10);
  withRecord.forEach((bar) => {
    const i = BARS.indexOf(bar);
    const diagnostics = { branch: "initial", htf_state: 1, ltf_state: 0, ext_state: 0, vah: bar.close + 5, val: bar.close - 5, poc: bar.close };
    const st = ref.structure[i];
    const comparable = regateGmi({ diagnostics, close: bar.close, proFast: ref.pro_fast[i], subtype: st.subtype, dEnc: st.d_enc });
    kvMap.set("localcalc:OANDA:XAUUSD:60:" + Date.parse(bar.open_time) + ":gmi", JSON.stringify({ values: { candle: { c: bar.close }, diagnostics, comparable: { gmi_v12_70: comparable } } }));
  });
  const env = { DB: d1(), SIGNAL_CACHE: series(BARS), WEBHOOK_BUFFER: { async get(k) { return kvMap.get(k) ?? null; } } };
  // The GMI candidates are stopped (2026-11-14); the re-gate is still how any GMI candidate runs.
  const gmiLatch = latchCandidate("gmi_v12_70", 8, "stateMaxAge", { by: "2026-11-14", rule: "test" });
  const r = await runShadowVersions(env, { now: NOW, candidates: [gmiLatch] });
  assert.equal(r.versions["gmi_v12_70@active"].stored, 10, "only the bars with a local GMI record");
  assert.equal(r.versions[gmiLatch.id].stored, 10);
  assert.ok(GMI_LOOKBACK_BARS >= 24);
  const row = env.DB.raw.prepare("SELECT fields_json FROM shadow_outputs WHERE version_id = 'gmi_v12_70@active' ORDER BY close_time DESC LIMIT 1").get();
  assert.deepEqual(Object.keys(JSON.parse(row.fields_json)), ["d_enc", "b_enc", "subtype", "verdict", "gate"]);
  // A second run reads no record again for bars every GMI version already has.
  let reads = 0;
  env.WEBHOOK_BUFFER = { async get(k) { reads += 1; return kvMap.get(k) ?? null; } };
  await runShadowVersions(env, { now: NOW, candidates: [gmiLatch] });
  assert.equal(reads, Math.min(GMI_LOOKBACK_BARS, BARS.length - SHADOW_WARMUP_BARS) - 10, "only the bars still missing an output are read");
  const view = await readShadowVersions(env, { now: NOW, days: 90, candidates: [gmiLatch], cache: false });
  const gmi = view.families.find(f => f.family === "gmi_v12_70");
  assert.deepEqual(gmi.control.matches_approved_local_records, { compared: 10, agree: 10 }, "the control reproduces the approved GMI records");
});
