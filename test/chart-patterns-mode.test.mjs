// Track A PR 1: CHART_PATTERNS_MODE = "off" switches the Projection Agent's chart patterns off everywhere they
// are read. Before this, buildStrategy read the switch from `env`, which the decision engine, the Global
// Conclusion and the capture never passed, so "off" changed nothing. The switch now travels in the inputs
// (loadStrategyInputs → modes.chartPatterns), and the four rooms pass it to projectionReading.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { path } from "./support/pattern-fixtures.mjs";
import { buildStrategy, loadStrategyInputs, chartPatternsMode, ownTimeframePlan, loadOwnTimeframePlanInputs } from "../src/strategy-engine.mjs";
import { buildKeyLevels } from "../src/key-level-agent.mjs";
import { projectionReading, chartPatternsMode as projectionMode } from "../src/projection-agent.mjs";
import { slimInputs } from "../src/strategy-inputs.mjs";
import { agentContext, agentPlans, agentStatuses, priceActionReading, AGENT_IDS } from "../src/strategy-agents.mjs";

const NOW = Date.parse("2026-11-04T13:10:00Z");
const op = (id, bias) => ({ id, status: "ok", stance: "WAIT", bias, confidence: 0.6 });
const room = (biases, bar_close, extra = {}) => ({ bar_close, openings: biases.map((b, i) => op("a" + i, b)), conclusion: { status: "ok", stance: "WAIT", bias: null, confidence: 0.6 }, ...extra });
const bull = ["BULLISH", "BULLISH", "BULLISH", "NEUTRAL"];
// An ascending triangle on the 1H and the 15m charts (test/chart-patterns.test.mjs C6 finds it on the 1H).
const POINTS = [[0, 70], [10, 100], [14, 84], [18, 100], [22, 89], [26, 100], [30, 94], [34, 100], [36, 97]];
const h1Bars = path(POINTS, { start: NOW - 37 * 3_600_000, barMs: 3_600_000 });
const m15Bars = path(POINTS, { start: NOW - 37 * 900_000, barMs: 900_000 });
const input = (over = {}) => ({
  rooms: {
    D1: room(bull, "2026-11-03T22:00:00.000Z"), H4: room(bull, "2026-11-04T12:00:00.000Z"),
    H1: room(bull, "2026-11-04T13:00:00.000Z"), M15: { ...room(bull, null), bar_time: "2026-11-04T13:00:00.000Z" }
  },
  news: null, confirmations: { m5_prophet_r38: { buy_confirmed: true, sell_confirmed: false, verified: true } },
  h1Bars, m15Bars, h1Chain: { decision: "WAIT", confidence: 0 }, now: NOW, ...over
});
const ALL_LIVE = agentStatuses({ STRATEGY_AGENTS_LIVE: AGENT_IDS.join(",") });
const patternPlans = (strategy, dir) => Object.keys(agentPlans(dir, agentContext({ strategy, bars: m15Bars }), ALL_LIVE)).filter((id) => id.startsWith("pattern_"));

test("PM1 the switch: one reader, in the Projection Agent; the strategy engine re-exports it", () => {
  assert.equal(chartPatternsMode, projectionMode);
  assert.deepEqual([chartPatternsMode({}), chartPatternsMode(null), chartPatternsMode({ CHART_PATTERNS_MODE: " OFF " }), chartPatternsMode({ CHART_PATTERNS_MODE: "x" })], ["on", "on", "off", "on"]);
});

test("PM2 buildStrategy: modes.chartPatterns \"off\" leaves no pattern, no pattern member, no pattern plan and no price action", () => {
  const on = buildStrategy(input());
  assert.ok(on.key_levels.patterns.length > 0, "the fixture has patterns while on");
  assert.ok(on.key_levels.zones.some((z) => z.members.some((m) => m.kind === "pattern")), "and pattern members in a zone");
  assert.ok(patternPlans(on, -1).length > 0, "and a pattern agent's plan");
  const off = buildStrategy(input({ modes: { chartPatterns: "off" } }));
  assert.deepEqual(off.key_levels.patterns, []);
  assert.deepEqual(off.key_levels.zones.flatMap((z) => z.members).filter((m) => m.kind === "pattern"), []);
  assert.deepEqual(priceActionReading(off.key_levels.patterns), [], "the council's price action is empty");
  for (const dir of [1, -1]) assert.deepEqual(patternPlans(off, dir), [], `no pattern_* or pattern_inside plan (${dir})`);
  // "on" or unset is today's strategy, byte for byte.
  assert.deepEqual(buildStrategy(input({ modes: { chartPatterns: "on" } })), on);
  assert.deepEqual(buildStrategy(input({ modes: null })), on);
  assert.deepEqual(JSON.stringify(buildStrategy(input())), JSON.stringify(on));
});

test("PM3 the inputs carry the switch: loadStrategyInputs, the capture's slim inputs, and the replay builds what was live", async () => {
  // TP1-KZ (2026-11-23) travels in the same modes.
  assert.deepEqual((await loadStrategyInputs({ CHART_PATTERNS_MODE: "off" }, { now: NOW })).modes, { chartPatterns: "off", tp1KeyZone: "on", entryZone: "edge" });
  assert.deepEqual((await loadStrategyInputs({}, { now: NOW })).modes, { chartPatterns: "on", tp1KeyZone: "on", entryZone: "edge" });
  // The capture keeps "off" (so its replay builds what the live strategy built) and adds nothing when on.
  assert.deepEqual(slimInputs({ ...input(), modes: { chartPatterns: "off" } }).modes, { chartPatterns: "off" });
  assert.equal("modes" in slimInputs({ ...input(), modes: { chartPatterns: "on" } }), false, "stored inputs are unchanged while on");
  const replayed = buildStrategy(slimInputs({ ...input(), modes: { chartPatterns: "off" } }));
  assert.deepEqual(replayed.key_levels.patterns, []);
});

test("PM4 the four rooms: projectionReading \"off\" drops the patterns and keeps the projection levels", () => {
  const on = projectionReading({ bars: m15Bars, timeframe: "15 minutes" });
  assert.ok(on.patterns.length > 0);
  const off = projectionReading({ bars: m15Bars, timeframe: "15 minutes", patterns: "off" });
  assert.deepEqual(off.patterns, []);
  assert.deepEqual(off.levels, on.levels);
  assert.deepEqual(projectionReading({ bars: m15Bars, timeframe: "15 minutes", patterns: "on" }), on, "\"on\" is today's reading");
  // The 15m War Room and the 1H/4H/D1 rooms pass the switch from env.
  for (const file of ["../src/war-room.mjs", "../src/timeframe-threads.mjs"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const calls = src.split("\n").filter((l) => l.includes("projectionReading({"));
    assert.ok(calls.length >= 1 && calls.every((l) => l.includes("patterns: chartPatternsMode(env) })")), `${file}: ${calls}`);
  }
});

test("PM5 every reader of the strategy builds from loadStrategyInputs, so each honours the switch", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  // loadDecisionInputs, readGlobalConclusion and readStrategy build from loadStrategyInputs' output; the capture
  // builds from its slim copy. None passes env into buildStrategy (riskChecks would fall back to env.TRADING_MODE).
  assert.match(read("../src/decision-engine.mjs"), /const inputs = await loadStrategyInputs\(env, \{ now \}\);\s*const strategy = await safe\(async \(\) => buildStrategy\(inputs\)\);/);
  assert.match(read("../src/global-conclusion.mjs"), /const inputs = await loadStrategyInputs\(env, \{ now \}\);[\s\S]{0,200}buildStrategy\(inputs\)/);
  assert.match(read("../src/strategy-engine.mjs"), /return buildStrategy\(await loadStrategyInputs\(env, \{ now, m5Context \}\), \{ mode \}\);/);
  assert.match(read("../src/strategy-inputs.mjs"), /const slim = slimInputs\(\{ \.\.\.inputs, now \}\);[\s\S]{0,120}build\(slim\)/);
  for (const f of ["../src/decision-engine.mjs", "../src/global-conclusion.mjs", "../src/strategy-inputs.mjs"]) assert.doesNotMatch(read(f), /buildStrategy\([^)]*env/, f);
});

test("PM6 the H1 chain's own-timeframe plan honours the switch: no projection-reader zone member while off", async () => {
  assert.deepEqual((await loadOwnTimeframePlanInputs({ CHART_PATTERNS_MODE: "off" })).modes, { chartPatterns: "off" });
  assert.deepEqual((await loadOwnTimeframePlanInputs({})).modes, { chartPatterns: "on" });
  // The zones ownTimeframePlan builds from (the 1H snapshot and bars only), with and without the switch.
  const zonesOf = (patterns) => buildKeyLevels({ snapshots: { "60": null }, bars: { H1: h1Bars }, price: h1Bars.at(-1).close, atrH1: 2.46, patterns }).zones;
  const projection = (zones) => zones.flatMap((z) => z.members).filter((m) => m.reader === "projection");
  assert.ok(projection(zonesOf("on")).length > 0, "the 1H triangle gives projection members while on");
  assert.deepEqual(projection(zonesOf("off")), []);
  // The plan itself: "on" and unset are today's plan; "off" builds from zones without pattern levels.
  for (const dir of [1, -1]) {
    const today = ownTimeframePlan({ snapshot: null, bars: h1Bars }, dir);
    assert.deepEqual(ownTimeframePlan({ snapshot: null, bars: h1Bars, modes: { chartPatterns: "on" } }, dir), today);
    assert.deepEqual(ownTimeframePlan({ snapshot: null, bars: h1Bars, modes: null }, dir), today);
    const off = ownTimeframePlan({ snapshot: null, bars: h1Bars, modes: { chartPatterns: "off" } }, dir);
    assert.doesNotMatch(JSON.stringify(off ?? {}), /breakout line|broken (?:upper|lower) line|triangle|flag|double top|triple top|pattern/i, `no pattern level in the plan (${dir})`);
    assert.match(JSON.stringify(today ?? {}), /breakout line|broken (?:upper|lower) line/, `the fixture has pattern levels in today's plan (${dir})`);
  }
  assert.notDeepEqual(ownTimeframePlan({ snapshot: null, bars: h1Bars, modes: { chartPatterns: "off" } }, -1), ownTimeframePlan({ snapshot: null, bars: h1Bars }, -1), "the switch changes this plan on the fixture");
  // The one live caller (src/index.ts) builds from loadOwnTimeframePlanInputs, so it carries the switch.
  assert.match(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), /ownTimeframePlan\(await loadOwnTimeframePlanInputs\(env\),/);
});
