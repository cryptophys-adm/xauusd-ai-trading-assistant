// B16 (Track B): the 15m and 1H risk desks and moderators read lens B's liquidity conditions (src/liquidity-lens.mjs
// liquidityConditions; src/lens-steps.mjs roomContextLine, roomConditionsLine; src/war-room.mjs and
// src/timeframe-threads.mjs agentData "risk", conclusionMessages and the stored brief). Plain words, no sweep clause and
// no price-shaped number; no extra model call; LENS_ROOM_LINE "brief" gives today's prompts byte for byte; only while lens
// B is on, above its floor and fresh. No network: an in-memory D1 and KV and a stubbed model.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resetThreadSchemaCacheForTests, buildLiveRoomTask } from "../src/agent-threads.mjs";
import { runWarRoomBar, readWarRoom, LIQUIDITY_CONDITIONS_LABEL } from "../src/war-room.mjs";
import { runTimeframeThread, readTimeframeThread } from "../src/timeframe-threads.mjs";
import { roomContextLine, roomConditionsLine, lensRoomLine, LENS_ROOM_LINES, LIQUIDITY_ROOM_CHARTS } from "../src/lens-steps.mjs";
import { liquidityConditions, liquidityConditionsOn, sessionLiquidity, PRICE_SHAPED, LIQUIDITY_STATE_KEY, LIQUIDITY_STATE_FRESH_MS } from "../src/liquidity-lens.mjs";
import { lensKnobs, resetLensStateMemoForTests, LENS_FLOOR_KEY } from "../src/lens-policy.mjs";
import { liquidityEvidence } from "../src/decision-engine.mjs";
import { OMEGA_DEFAULTS } from "../src/omega-engine.mjs";
import { ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";

const PRICE = /\b\d{3,5}(\.\d+)?\b/;
const M1 = 60_000, H1 = 3_600_000;
const BAR = "2026-11-05T14:45:00.000Z"; // Thursday 09:45 New York: London and New York
const K15 = "OANDA:XAUUSD:15:" + (Date.parse(BAR) - 900_000);
const ROOM_NOW = Date.parse(BAR) + 2 * M1;

const FACTS = Object.freeze({
  available: true, baseline: "insufficient", baseline_weeks: 2, baseline_reset_at: null, basis: "rolling_hour_of_day", minute_at: new Date(ROOM_NOW - 3 * M1).toISOString(),
  vol_pctl: 0.62, vol_pctl_15m: 0.12, vol_spike: false, thin: true, spread_ratio: 2.347, spread_spike: true,
  sweep: { side: "sell_side", age_min: 4, vol_pctl: 0.97, reclaimed: true },
  pools: { above: 1, below: 2, equal_highs: 2, equal_lows: 2 }, hvn: { inside: true, above: 1, below: 0 }
});
const stateAt = (at, facts = FACTS) => JSON.stringify({ at_ms: at, identity: "x", mode: "intraday", facts, levels: [{ low: 4101.25, high: 4101.75, kind: "pool" }, { low: 4096.5, high: 4096.5, kind: "sweep" }], medians: {}, median_any: 20, baseline: facts.baseline, baseline_weeks: 2 });

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ai_syntheses (id INTEGER PRIMARY KEY AUTOINCREMENT, candle_key TEXT NOT NULL, ticker TEXT, timeframe TEXT, timestamp TEXT, prophet_metrics TEXT, gmi_metrics TEXT, ai_analysis TEXT, ai_model TEXT)");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); } }; };

/** Every agent answers from its Required JSON line; the moderator waits. Counts the calls. */
function fakeAI() {
  const calls = [];
  return {
    calls,
    run: async (model, request) => {
      calls.push({ model, request });
      const sys = request.messages[0].content, user = request.messages[1].content;
      const agent = (user.match(/Required JSON: \{"agent":"(\w+)"/) || [])[1];
      let content;
      if (/moderator of the XAUUSD/.test(sys)) content = { stance: "WAIT", confidence: 0.55, summary: "Stay flat: the room has no confirmation and the higher volatility argues for patience.", reasons: ["No signal confirmed on the closed candles.", "Volatility is elevated."], dissent: [], metrics: ["the closed candles of this chart"] };
      else if (/Consensus Discussion/.test(sys)) content = { agent, stance: "WAIT", confidence: 0.5, rebuts: [agent === "technical" ? "risk" : "technical"], argument: "The last candles closed near their middle, which argues against chasing either side now.", metrics: ["the closes of the last candles"] };
      else content = { agent, stance: "WAIT", confidence: 0.5, claim: "My own data supports waiting for the next candle.", metrics: ["my own readings of this chart"] };
      return { choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { total_tokens: 40 } };
    }
  };
}
function hud(candleKey, timeframe) {
  return JSON.stringify({
    schema_version: "cryptophys.hud-snapshot.v1", symbol: "OANDA:XAUUSD", timeframe, candle_key: candleKey, computed_at: BAR, not_computed: ["grid_bot_protocol"],
    huds: { kinetic_engine: { fields: { theta: 43, omega: -0.4, alpha: -0.1, entropy: 0.86, is_chaos: true }, parity: {} }, fabio_amt: { fields: { vah: 4071, val: 3894, poc: 3948 }, parity: {} } }
  });
}
function series(lastOpen, stepMs, count = 60) {
  const candles = Array.from({ length: count }, (_, i) => {
    const open = lastOpen - (count - 1 - i) * stepMs;
    const base = 4000 + Math.sin(i / 3) * 20 + i;
    return { open_time: new Date(open).toISOString(), close_time: new Date(open + stepMs).toISOString(), open: base, high: base + 12, low: base - 9, close: base + 3, volume: 1000 + i };
  });
  return JSON.stringify({ candles });
}
/** lens B's situation: "on", "off" (the owner's switch), "floored", "stale", "none" (no state). */
function lensSetup(e, how, now) {
  if (how !== "none") e.SIGNAL_CACHE.m.set(LIQUIDITY_STATE_KEY, stateAt(how === "stale" ? now - LIQUIDITY_STATE_FRESH_MS - M1 : now - 2 * M1));
  if (how === "floored") e.SIGNAL_CACHE.m.set(LENS_FLOOR_KEY, JSON.stringify({ liquidity: { at_ms: now - H1, doctrine_sha: null, score: 0.3, n: 40 } }));
  if (how === "off") {
    e.DB.raw.exec("CREATE TABLE omega_settings (id INTEGER PRIMARY KEY, settings TEXT, version INTEGER)");
    e.DB.raw.prepare("INSERT INTO omega_settings (id, settings, version) VALUES (1, ?, 1)").run(JSON.stringify({ ...OMEGA_DEFAULTS, liquidity_enabled: false }));
  }
}
const prompts = (ai) => ai.calls.map((c) => c.request.messages.map((m) => m.content).join("\n"));
/** The prompts as a set (the openings run in parallel, so their order may differ between two runs). */
const promptSet = (ai) => prompts(ai).sort();
const dataOf = (p) => JSON.parse(p.split("YOUR DATA:\n")[1].split("\n")[0]);

async function warRoom({ how = "on", line = undefined } = {}) {
  resetThreadSchemaCacheForTests();
  resetLensStateMemoForTests();
  const ai = fakeAI();
  const e = { DB: fakeD1(), AI: ai, SIGNAL_CACHE: kv({ ["hud:15:" + K15]: hud(K15, "15") }), WEBHOOK_BUFFER: kv(), WAR_ROOM_ENABLED: "true", WAR_ROOM_MAX_CALLS_PER_HOUR: "112", TRADING_MODE: "intraday", ...(line ? { LENS_ROOM_LINE: line } : {}) };
  lensSetup(e, how, ROOM_NOW);
  const bars = Array.from({ length: 12 }, (_, i) => ({ t: new Date(Date.parse(BAR) - (11 - i) * 300_000).toISOString(), o: 4100 + i, h: 4103 + i, l: 4098 + i, c: 4101 + i, v: 10 }));
  const ctx = { schema_version: "cryptophys.local-context.v1", trust_status: "informational_unverified", symbol: "OANDA:XAUUSD", timeframe: "5", candle_time: BAR, bias: "BEARISH", buy_confirmed: false, sell_confirmed: false, d_enc: -1, recent_bars: bars };
  const result = await runWarRoomBar(e, buildLiveRoomTask({ barTime: BAR, context: ctx }), { clock: () => ROOM_NOW });
  return { ai, e, result, room: await readWarRoom(e.DB) };
}

const H1_OPEN = Date.parse("2026-11-05T13:00:00.000Z"); // closes 14:00Z, Thursday 09:00 New York
const H1_KEY = "OANDA:XAUUSD:60:" + H1_OPEN;
const H1_NOW = H1_OPEN + H1 + 10 * M1;
const H4_OPEN = Date.parse("2026-11-05T10:00:00.000Z");
const H4_KEY = "OANDA:XAUUSD:240:" + H4_OPEN;
const H4_NOW = H4_OPEN + 4 * H1 + 5 * M1;
async function tfRoom(chart, { how = "on", line = undefined } = {}) {
  resetThreadSchemaCacheForTests();
  resetLensStateMemoForTests();
  const ai = fakeAI();
  const [open, step, key, now, iv, tf] = chart === "H1" ? [H1_OPEN, H1, H1_KEY, H1_NOW, "1h", "60"] : [H4_OPEN, 4 * H1, H4_KEY, H4_NOW, "4h", "240"];
  const e = { DB: fakeD1(), AI: ai, WEBHOOK_BUFFER: kv(), SIGNAL_CACHE: kv({ [`market-data:v2:series:OANDA:XAUUSD|${iv}`]: series(open, step), [`hud:${tf}:${key}`]: hud(key, tf) }), TF_THREADS_ENABLED: "true", TF_THREADS_MAX_CALLS_PER_HOUR: "120", MODEL_RATE_LIMIT_RETRY_MS: "0", TRADING_MODE: "intraday", ...(line ? { LENS_ROOM_LINE: line } : {}) };
  lensSetup(e, how, now);
  const result = await runTimeframeThread(e, { chart, candleKey: key }, { clock: () => now });
  return { ai, e, result, room: await readTimeframeThread(e.DB, chart, { candleKey: key }) };
}

test.beforeEach(() => { resetThreadSchemaCacheForTests(); resetLensStateMemoForTests(); });

test("RC1. liquidityConditions: plain words from lens B's facts and the mode's knobs; no sweep clause, no price-shaped number; null without facts", () => {
  const knobs = lensKnobs("liquidity", "intraday", { baseline: "insufficient" });
  const c = liquidityConditions(FACTS, { knobs, now: ROOM_NOW });
  assert.equal(c.line, "Liquidity conditions (broker M1, intraday mode, baseline: insufficient, 2 of 4 weeks): spread 2.3 times its norm for this hour of the week, widened (widened at 2 times or more); depth thin: the last 15 minutes' tick volume at the 12th percentile of its hour (thin at or below the 20th); the minute's tick volume at the 62nd percentile, no spike; session: London and New York overlap, high liquidity; levels: price inside a high-volume node (1 above, 0 below); untaken equal highs/lows 1 above, 2 below, 1 at price.");
  assert.deepEqual(c.spread, { ratio: 2.35, widen: 2, state: "widened" });
  assert.deepEqual(c.depth, { vol_pctl_15m: 0.12, thin_pctl: 0.2, state: "thin" });
  assert.deepEqual(c.activity, { vol_pctl: 0.62, spike_pctl: 0.95, state: "normal" });
  assert.deepEqual(c.session, { names: ["London", "New York"], overlap: true, liquidity: "high", excluded: null });
  assert.deepEqual(c.levels, { inside_node: true, nodes_above: 1, nodes_below: 0, pools_above: 1, pools_below: 2, pools_at: 1 });
  assert.doesNotMatch(c.line, /sweep/i, "the sweep is the LIQUIDITY card's (B15)");
  assert.doesNotMatch(c.line, PRICE);
  assert.doesNotMatch(JSON.stringify(c), /sweep/i);
  // Every shape of the facts the ledger step writes: no price-shaped number, no sweep, ever.
  const variants = [
    {}, { spread_ratio: 1.234 }, { spread_ratio: 0.987 }, { spread_ratio: 152.5, spread_spike: true }, { spread_ratio: null }, { vol_pctl: 1, vol_pctl_15m: 0, vol_spike: true }, { vol_pctl: null, vol_pctl_15m: null },
    { pools: { above: 120, below: 999, equal_highs: 1500, equal_lows: 0 }, hvn: { inside: false, above: 250, below: 4100 } }, { excluded: "rollover_quarantine" }, { baseline: "sufficient", baseline_weeks: 8 },
    { minute_at: "2026-11-07T15:00:00.000Z" }, { minute_at: "2026-11-05T22:30:00.000Z" }, { minute_at: "2026-11-05T23:30:00.000Z" }, { minute_at: "2026-11-05T21:30:00.000Z" }, { sweep: null }, { sweep: { side: "buy_side", age_min: 1234, vol_pctl: 0.99, reclaimed: true } }
  ];
  for (const v of variants) {
    for (const k of [knobs, lensKnobs("liquidity", "swing", { policy: { values: { "liquidity.spread_widen_swing": 3.75, "liquidity.thin_pctl_swing": 0.05 } } }), null]) {
      const x = liquidityConditions({ ...FACTS, ...v }, { knobs: k, now: ROOM_NOW });
      assert.ok(x && typeof x.line === "string", JSON.stringify(v));
      assert.doesNotMatch(x.line, PRICE, x.line);
      assert.doesNotMatch(x.line, /sweep/i, x.line);
    }
  }
  assert.match(liquidityConditions({ ...FACTS, spread_ratio: 152.5 }, { knobs }).line, /spread more than 10 times its norm/);
  assert.match(liquidityConditions({ ...FACTS, excluded: "rollover_quarantine" }, { knobs }).line, /The minute is excluded from the baseline \(rollover quarantine\)\.$/);
  assert.match(liquidityConditions({ ...FACTS, minute_at: "2026-11-07T15:00:00.000Z" }, { knobs }).line, /session: market closed/, "Saturday");
  assert.match(liquidityConditions({ ...FACTS, minute_at: "2026-11-05T21:30:00.000Z" }, { knobs }).line, /session: New York, normal liquidity/, "Thursday 16:30 New York");
  assert.match(liquidityConditions({ ...FACTS, minute_at: "2026-11-05T22:30:00.000Z" }, { knobs }).line, /session: the daily trading pause/, "17:30 New York");
  assert.match(liquidityConditions({ ...FACTS, minute_at: "2026-11-05T23:30:00.000Z" }, { knobs }).line, /session: between sessions, thin liquidity/, "18:30 New York, before Tokyo");
  for (const f of [null, undefined, {}, { available: false, reason: "archive_stale" }]) assert.equal(liquidityConditions(f, { knobs }), null);
  assert.ok(PRICE_SHAPED.test("at 4101.25") && PRICE_SHAPED.test("at 152.5") && !PRICE_SHAPED.test("the 100th percentile, 2.35 times"));
  assert.deepEqual(sessionLiquidity(Date.parse("2026-11-05T01:00:00Z")), { names: ["Tokyo"], overlap: false, liquidity: "normal" });
});

test("RC2. the gates are the LIQUIDITY card's: on, above the floor, available and fresh (liquidityEvidence)", () => {
  const on = lensKnobs("liquidity", "intraday", { baseline: "insufficient" });
  const st = { at_ms: ROOM_NOW - 2 * M1, facts: FACTS };
  const cases = [
    [st, on, ROOM_NOW],
    [st, lensKnobs("liquidity", "intraday", { enabled: false }), ROOM_NOW],
    [st, lensKnobs("liquidity", "intraday", { floor: { liquidity: { at_ms: 1, doctrine_sha: null } } }), ROOM_NOW],
    [st, on, st.at_ms + LIQUIDITY_STATE_FRESH_MS],
    [st, on, st.at_ms + LIQUIDITY_STATE_FRESH_MS + 1],
    [{ ...st, facts: { available: false } }, on, ROOM_NOW],
    [{ facts: FACTS }, on, ROOM_NOW],
    [null, on, ROOM_NOW]
  ];
  assert.deepEqual(cases.map(([s, k, n]) => liquidityConditionsOn(s, k, n)), [true, false, false, true, false, false, false, false]);
  for (const [s, k, n] of cases) assert.equal(liquidityConditionsOn(s, k, n), liquidityEvidence({ state: s, knobs: k }, n) !== null, "the same gates as the council's evidence");
});

test("RC3. roomContextLine: the conditions in the 15m and 1H lines only while lens B reads; off, floored, stale or \"brief\": today's line", async () => {
  const at = async (how, chart = "H1", line = undefined) => {
    resetLensStateMemoForTests();
    const e = { DB: fakeD1(), SIGNAL_CACHE: kv(), TRADING_MODE: "intraday", ...(line ? { LENS_ROOM_LINE: line } : {}) };
    lensSetup(e, how, ROOM_NOW);
    return roomContextLine(e, chart, { now: ROOM_NOW });
  };
  const on = await at("on");
  const today = await at("on", "H1", "brief");
  assert.deepEqual(Object.keys(today), ["analyst", "lens", "line", "bias", "baseline", "outside_quorum"], "brief: today's keys");
  assert.deepEqual(on, { ...today, conditions: on.conditions }, "on: today's line plus the conditions");
  assert.match(on.conditions, /^Liquidity conditions \(broker M1, intraday mode/);
  assert.deepEqual(await at("on", "M15"), on, "the 15m room reads the same");
  for (const how of ["floored", "stale"]) assert.deepEqual(await at(how), today, `${how}: today's line, no conditions`);
  assert.equal(await at("off"), null, "the owner's switch off: no line at all, as today");
  assert.equal(await at("none"), null);
  assert.equal(await at("on", "H4"), null, "4H: lens A only (no CFTC report here)");
  assert.deepEqual([lensRoomLine({}), lensRoomLine({ LENS_ROOM_LINE: " Brief " }), lensRoomLine({ LENS_ROOM_LINE: "conditions" }), lensRoomLine({ LENS_ROOM_LINE: "x" })], ["conditions", "brief", "conditions", "conditions"]);
  assert.deepEqual([...LENS_ROOM_LINES], ["conditions", "brief"]);
  assert.deepEqual([...LIQUIDITY_ROOM_CHARTS], ["M15", "H1"]);
  assert.equal(roomConditionsLine({}, "H4", on), null, "gated by chart");
  assert.equal(roomConditionsLine({ LENS_ROOM_LINE: "brief" }, "H1", on), null);
  assert.equal(roomConditionsLine({}, "H1", on), on.conditions);
  assert.equal(roomConditionsLine({}, "H1", { lens: "positioning", conditions: "x" }), null);
  assert.match(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /"LENS_ROOM_LINE": "conditions"/);
});

test("RC4. the 15m War Room: the risk desk's data, the moderator's prompt and the stored brief carry the line; no other prompt; no extra call", async () => {
  const on = await warRoom();
  assert.equal(on.result.status, "complete");
  const line = on.room.context.conditions;
  assert.equal(typeof line, "string");
  assert.match(line, /^Liquidity conditions \(broker M1, intraday mode, baseline: insufficient, 2 of 4 weeks\): spread 2\.3 times its norm/);
  assert.doesNotMatch(line, PRICE);
  assert.doesNotMatch(line, /sweep/i);
  const p = prompts(on.ai);
  const risk = p.find((x) => /"agent":"risk"/.test(x) && !/Consensus Discussion/.test(x));
  assert.equal(dataOf(risk).liquidity_conditions, line, "the risk desk's data");
  const moderator = p.find((x) => /moderator of the XAUUSD Live War Room/.test(x));
  assert.ok(moderator.includes(`${LIQUIDITY_CONDITIONS_LABEL} ${line}\nCOMMUNICATION BUS:`), "the moderator's prompt");
  assert.deepEqual(p.filter((x) => x.includes(line)).sort(), [risk, moderator].sort(), "no other agent reads it");
  assert.doesNotMatch(LIQUIDITY_CONDITIONS_LABEL, PRICE);
  // No extra model call: the same calls as the room with the line off.
  const off = await warRoom({ line: "brief" });
  assert.equal(on.ai.calls.length, off.ai.calls.length);
  assert.equal(on.ai.calls.length, 5 + 1 + 1, "five openings, the Risk Manager's rebuttal, the conclusion");
  // A retried bar reads the line as the brief stored it, whatever lens B's state says now.
  on.e.SIGNAL_CACHE.m.delete(LIQUIDITY_STATE_KEY);
  on.e.DB.raw.prepare("DELETE FROM agent_thread_messages WHERE step = 'conclusion'").run();
  const before = on.ai.calls.length;
  resetLensStateMemoForTests();
  assert.equal((await runWarRoomBar(on.e, buildLiveRoomTask({ barTime: BAR, context: { candle_time: BAR, recent_bars: [] } }), { clock: () => ROOM_NOW })).status, "complete");
  const again = prompts(on.ai).slice(before);
  assert.deepEqual(again.length, 1, "only the conclusion again");
  assert.ok(again[0].includes(`${LIQUIDITY_CONDITIONS_LABEL} ${line}`));
});

test("RC5. the 1H room: the risk desk, the moderator and the stored brief; the 4H room unchanged", async () => {
  const on = await tfRoom("H1");
  assert.equal(on.result.status, "complete");
  const line = on.room.context.conditions;
  assert.match(line, /^Liquidity conditions \(broker M1, intraday mode/);
  assert.doesNotMatch(line, PRICE);
  assert.doesNotMatch(line, /sweep/i);
  const p = prompts(on.ai);
  const risk = p.find((x) => /"agent":"risk"/.test(x) && !/Consensus Discussion/.test(x));
  assert.equal(dataOf(risk).liquidity_conditions, line);
  const moderator = p.find((x) => /moderator of the XAUUSD 1-hour War Room/.test(x));
  assert.ok(moderator.includes(`${LIQUIDITY_CONDITIONS_LABEL} ${line}\nCOMMUNICATION BUS:`));
  assert.deepEqual(p.filter((x) => x.includes(line)).sort(), [risk, moderator].sort());
  const off = await tfRoom("H1", { line: "brief" });
  assert.equal(on.ai.calls.length, off.ai.calls.length, "no extra model call");
  // 4H: the same prompts and brief with the line on or off, and no conditions anywhere (lens B is not in the 4H room).
  const h4on = await tfRoom("H4"), h4off = await tfRoom("H4", { line: "brief" });
  assert.equal(h4on.result.status, "complete");
  assert.deepEqual(promptSet(h4on.ai), promptSet(h4off.ai));
  assert.doesNotMatch(prompts(h4on.ai).join("\n"), /liquidity_conditions|LIQUIDITY CONDITIONS/);
  assert.equal(h4on.room.context, null);
});

test("RC6. off is byte for byte: LENS_ROOM_LINE \"brief\", and lens B off, floored or stale, give the prompts of a room without the conditions", async () => {
  // Today's prompts: the room with no lens B state at all reaches none of B16's code (no line, no conditions).
  const today15 = promptSet((await warRoom({ how: "none" })).ai);
  const today1h = promptSet((await tfRoom("H1", { how: "none" })).ai);
  for (const [how, line] of [["on", "brief"], ["off", undefined], ["floored", undefined], ["stale", undefined]]) {
    const w = await warRoom({ how, line });
    assert.deepEqual(promptSet(w.ai), today15, `15m ${how}${line ? " " + line : ""}`);
    assert.equal(w.room.context?.conditions, undefined, `15m ${how}: no conditions in the brief`);
    const h = await tfRoom("H1", { how, line });
    assert.deepEqual(promptSet(h.ai), today1h, `1H ${how}${line ? " " + line : ""}`);
    assert.equal(h.room.context?.conditions, undefined);
  }
  // "brief" stores today's brief line (no conditions key) while lens B is on.
  const brief = await warRoom({ line: "brief" });
  assert.deepEqual(Object.keys(brief.room.context), ["analyst", "lens", "line", "bias", "baseline", "outside_quorum"]);
});

test("RC7. Omega's hashes hold (V13/V14): lens B's room conditions are outside ENGINE_CODE", async () => {
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.equal(typeof ENGINE_BEHAVIOUR_HASH, "string");
  assert.doesNotMatch(engineCodeSource(), /liquidityConditions|roomConditionsLine/);
});
