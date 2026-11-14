import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { readShadowVersions, holmAdjust, holmMonth, HOLDOUT_BARS, SHADOW_MIN_SAMPLE, resetShadowSchemaCacheForTests, resetShadowReadCacheForTests } from "../src/shadow-versions.mjs";
import { resetOutcomeSchemaCacheForTests, SCORING_VERSION } from "../src/outcome-scoring.mjs";
import { tuningView, ACTIVE_VALUES } from "../src/tuning.mjs";
import { TUNING_GRID } from "../src/aether-pack.mjs";

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
const reset = () => { resetShadowSchemaCacheForTests(); resetOutcomeSchemaCacheForTests(); resetShadowReadCacheForTests(); };
const START = Date.parse("2026-09-01T00:00:00Z");
const cand = (id) => ({ id, family: "prophet_r37", role: "candidate", timeframe: "60", params: { stateMaxAge: 8 }, reference: "none", change: "test" });

/** Seeds scored bars for the control and the candidates: plan(i) -> { control, [id]: { stance, result } }. */
async function seeded(n, ids, plan, now) {
  reset();
  const env = { DB: d1(), SIGNAL_CACHE: { async get() { return null; } }, WEBHOOK_BUFFER: { async get() { return null; } } };
  await readShadowVersions(env, { now, days: 90, candidates: [], cache: false }); // ensures the schemas
  const ins = env.DB.raw.prepare("INSERT INTO outcome_scores (subject, source, timeframe, candle_key, statement_close, stance, result, scoring_version, scored_at) VALUES (?, 'shadow', '60', ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < n; i++) {
    const open = START + i * 3_600_000, key = "OANDA:XAUUSD:60:" + open, close = new Date(open + 3_600_000).toISOString();
    const p = plan(i);
    ins.run("shadow:prophet_r37@active", key, close, p.control.stance, p.control.result, SCORING_VERSION, close);
    for (const id of ids) ins.run("shadow:" + id, key, close, p[id].stance, p[id].result, SCORING_VERSION, close);
  }
  return env;
}
const NOW = START + 400 * 3_600_000;
const same = { stance: "BUY", result: "hit" };
const win = { cand: { stance: "SELL", result: "hit" }, control: { stance: "BUY", result: "miss" } };
const lose = { cand: { stance: "SELL", result: "miss" }, control: { stance: "BUY", result: "hit" } };

test("Holm–Bonferroni adjusts step-down, keeps the input order and skips untested candidates", () => {
  assert.deepEqual(holmAdjust([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]);
  assert.deepEqual(holmAdjust([null, 0.02]), [null, 0.02]);
  assert.deepEqual(holmAdjust([0.6, 0.5]), [1, 1]);
  assert.deepEqual(holmAdjust([]), []);
  assert.equal(holmMonth(Date.parse("2026-11-08T02:00:00Z")), "2026-11");
});

test("the newest 100 shared bars are the holdout; a candidate better in discovery and no worse there is ready", async () => {
  const id = "prophet_r37@latch8";
  const env = await seeded(320, [id], (i) => (i < 220 && i % 4 === 0 ? { control: win.control, [id]: win.cand } : { control: same, [id]: same }), NOW);
  const view = await readShadowVersions(env, { now: NOW, days: 90, candidates: [cand(id)], cache: false });
  const fam = view.families.find(f => f.family === "prophet_r37");
  const k = fam.candidates[0];
  assert.equal(view.holdout_bars, HOLDOUT_BARS);
  assert.equal(k.discovery.bars, 220);
  assert.equal(k.holdout.bars, 100);
  assert.equal(k.holdout.complete, true);
  assert.equal(k.discovery.candidate_better, 55);
  assert.equal(k.holdout.candidate_better + k.holdout.control_better, 0, "no holdout bar was used by the discovery test");
  assert.equal(k.discovery.p_holm, k.discovery.p_value, "one test this month: Holm changes nothing");
  assert.deepEqual(fam.holm, { month: "2026-09", alpha: 0.05, tests: 1, live: [id], stopped_this_month: [] });
  assert.equal(k.criteria.higher_outcome_score, true);
  assert.equal(k.criteria.holdout_no_worse, true);
  assert.equal(k.verdict, "better_than_active: ready for owner review");
});

test("a candidate that is worse on the holdout is not ready, however good its discovery test", async () => {
  const id = "prophet_r37@latch8";
  const env = await seeded(320, [id], (i) => {
    if (i < 220 && i % 4 === 0) return { control: win.control, [id]: win.cand };
    if (i >= 220 && i % 5 === 0) return { control: lose.control, [id]: lose.cand };
    return { control: same, [id]: same };
  }, NOW);
  const k = (await readShadowVersions(env, { now: NOW, days: 90, candidates: [cand(id)], cache: false })).families.find(f => f.family === "prophet_r37").candidates[0];
  assert.equal(k.criteria.higher_outcome_score, true);
  assert.equal(k.holdout.control_better, 20);
  assert.equal(k.criteria.holdout_no_worse, false);
  assert.equal(k.verdict, "holdout_failed");
});

test("Holm across the family: two borderline candidates are each significant alone, neither together", async () => {
  const a = "prophet_r37@latch8", b = "prophet_r37@latch16";
  // 5 wins and no loss each: p = 0.5^5 = 0.031 alone; Holm with two tests: 0.0624.
  const plan = (i) => (i < 220 && i % 40 === 0 && i < 200 ? { control: win.control, [a]: win.cand, [b]: win.cand } : { control: same, [a]: same, [b]: same });
  const alone = await seeded(320, [a], plan, NOW);
  const k1 = (await readShadowVersions(alone, { now: NOW, days: 90, candidates: [cand(a)], cache: false })).families.find(f => f.family === "prophet_r37").candidates[0];
  assert.equal(k1.discovery.p_value, 0.0312);
  assert.equal(k1.criteria.higher_outcome_score, true);
  const both = await seeded(320, [a, b], plan, NOW);
  const fam = (await readShadowVersions(both, { now: NOW, days: 90, candidates: [cand(a), cand(b)], cache: false })).families.find(f => f.family === "prophet_r37");
  for (const k of fam.candidates) {
    assert.equal(k.discovery.p_value, 0.0312);
    assert.equal(k.discovery.p_holm, 0.0624);
    assert.equal(k.criteria.higher_outcome_score, false);
    assert.equal(k.verdict, "not_better");
  }
  assert.equal(fam.holm.tests, 2);
});

test("candidates stopped in the same calendar month join the family's Holm set", async () => {
  const id = "prophet_r37@latch8";
  const nov = Date.parse("2026-11-20T00:00:00Z");
  const start = nov - 330 * 3_600_000;
  reset();
  const env = { DB: d1(), SIGNAL_CACHE: { async get() { return null; } }, WEBHOOK_BUFFER: { async get() { return null; } } };
  await readShadowVersions(env, { now: nov, days: 30, candidates: [], cache: false });
  const ins = env.DB.raw.prepare("INSERT INTO outcome_scores (subject, source, timeframe, candle_key, statement_close, stance, result, scoring_version, scored_at) VALUES (?, 'shadow', '60', ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < 320; i++) {
    const open = start + i * 3_600_000, key = "OANDA:XAUUSD:60:" + open, close = new Date(open + 3_600_000).toISOString();
    const w = i < 200 && i % 40 === 0;
    ins.run("shadow:prophet_r37@active", key, close, w ? "BUY" : "BUY", w ? "miss" : "hit", SCORING_VERSION, close);
    ins.run("shadow:" + id, key, close, w ? "SELL" : "BUY", "hit", SCORING_VERSION, close);
  }
  const fam = (await readShadowVersions(env, { now: nov, days: 30, candidates: [cand(id)], cache: false })).families.find(f => f.family === "prophet_r37");
  assert.deepEqual(fam.holm.stopped_this_month, ["prophet_r37@latch12"], "stopped 2026-11-07 with p 0.5");
  assert.equal(fam.holm.tests, 2);
  assert.equal(fam.candidates[0].discovery.p_holm, 0.0624);
});

test("below the discovery minimum the candidate is still collecting", async () => {
  const id = "prophet_r37@latch8";
  const env = await seeded(SHADOW_MIN_SAMPLE + HOLDOUT_BARS - 1, [id], () => ({ control: same, [id]: same }), NOW);
  const k = (await readShadowVersions(env, { now: NOW, days: 90, candidates: [cand(id)], cache: false })).families.find(f => f.family === "prophet_r37").candidates[0];
  assert.equal(k.criteria.minimum_sample, false);
  assert.equal(k.discovery.p_holm, null);
  assert.equal(k.verdict, "collecting");
});

test("the tuning view lists every grid point as running, stopped or untested, with the statistics used", async () => {
  const id = "prophet_r37@latch8";
  const env = await seeded(320, [id], (i) => (i < 220 && i % 4 === 0 ? { control: win.control, [id]: win.cand } : { control: same, [id]: same }), NOW);
  const t = tuningView(await readShadowVersions(env, { now: NOW, days: 90, candidates: [cand(id)], cache: false }));
  assert.deepEqual(t.families.map(f => `${f.family}.${f.param}`), Object.entries(TUNING_GRID).flatMap(([f, ps]) => Object.keys(ps).map(p => `${f}.${p}`)));
  const r37 = t.families.find(f => f.family === "prophet_r37");
  assert.equal(r37.active_value, ACTIVE_VALUES.stateMaxAge);
  assert.deepEqual(r37.points.map(p => [p.value, p.status]), [[8, "running"], [12, "stopped"], [16, "untested"], [24, "untested"]]);
  assert.equal(r37.points[0].verdict, "better_than_active: ready for owner review");
  assert.equal(r37.points[0].source, "repository");
  assert.equal(r37.points[1].p_value, 0.5);
  assert.equal(r37.next_untested, 16);
  assert.equal(t.statistics.holdout_bars, 100);
  assert.match(t.statistics.multiple_testing, /Holm/);
  assert.match(t.use, /never a live prompt/);
  const gmi = t.families.find(f => f.family === "gmi_v12_70");
  // GMI's latch8 and latch12 stopped at their review (owner 2026-11-14): the next point is 16.
  assert.deepEqual(gmi.points.map(p => [p.value, p.status]), [[8, "stopped"], [12, "stopped"], [16, "untested"], [24, "untested"]]);
  assert.equal(gmi.next_untested, 16);
});
