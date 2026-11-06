import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { validateHudSnapshot, storeHudSnapshot, loadHudSnapshot, hudReadings, barsVerified, HUD_SNAPSHOT_VERSION } from "../src/hud-store.mjs";

function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { map: m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); } };
}
const now = Date.parse("2026-11-05T12:01:00Z");
const key = "OANDA:XAUUSD:60:" + Date.parse("2026-11-05T11:00:00Z");
function snapshot(extra = {}) {
  return {
    schema_version: HUD_SNAPSHOT_VERSION, symbol: "OANDA:XAUUSD", timeframe: "60", candle_key: key,
    candle_time: "2026-11-05T11:00:00.000Z", computed_at: "2026-11-05T12:00:30.000Z", not_computed: ["grid_bot_protocol"],
    huds: {
      prophet: { fields: { d_enc: 1, structure_subtype: 0, t_enc: 0, cycle_intensity: 3, kww_zscore: 1.2 }, parity: { d_enc: "prophet_r38.d_enc", structure_subtype: "prophet_r38.structure_subtype", t_enc: "prophet_r38.t_enc" } },
      decision_matrix: { fields: { verdict: 3, gate: 2, conflict: false, branch: "jma_long", is_chaos: false }, parity: { verdict: "gmi_v12_70.verdict", gate: "gmi_v12_70.gate", conflict: "gmi_v12_70.conflict" } }
    },
    ...extra
  };
}

test("validation rejects wrong schema, keys, stale or future snapshots, unknown HUDs and credentials", () => {
  assert.equal(validateHudSnapshot(snapshot(), now).valid, true);
  assert.ok(validateHudSnapshot(snapshot({ schema_version: "x" }), now).errors.includes("unsupported_schema_version"));
  assert.ok(validateHudSnapshot(snapshot({ timeframe: "5" }), now).errors.includes("unsupported_timeframe"));
  assert.ok(validateHudSnapshot(snapshot({ candle_key: "OANDA:XAUUSD:15:" + Date.parse("2026-11-05T11:00:00Z") }), now).errors.includes("candle_key_invalid"));
  assert.ok(validateHudSnapshot(snapshot({ computed_at: "2026-11-05T10:00:00Z" }), now).errors.includes("snapshot_stale"));
  assert.ok(validateHudSnapshot(snapshot({ computed_at: "2026-11-05T13:00:00Z" }), now).errors.includes("computed_at_in_future"));
  assert.ok(validateHudSnapshot(snapshot({ huds: { not_a_hud: { fields: {} } } }), now).errors.includes("huds_invalid"));
  assert.ok(validateHudSnapshot(snapshot({ secret: "x" }), now).errors.includes("credential_fields_not_permitted"));
});

test("store keeps the snapshot per candle and as latest; readings verify only fields equal to the approved record", async () => {
  const env = { SIGNAL_CACHE: kv(), WEBHOOK_BUFFER: kv() };
  const stored = await storeHudSnapshot(env, snapshot(), now);
  assert.equal(stored.status, 202);
  assert.equal((await loadHudSnapshot(env, { timeframe: "60" })).candle_key, key);
  assert.equal((await loadHudSnapshot(env, { timeframe: "60", candleKey: key })).candle_key, key);

  // No approved record yet: nothing is verified.
  let h = await hudReadings(env, await loadHudSnapshot(env, { timeframe: "60" }));
  assert.equal(h.verified_against_approved_record, false);
  assert.ok(Object.values(h.readings).every(r => r.lines.every(l => l.verified === false)));

  // Approved records: structure (d_enc 1, subtype 0) and the GMI verdict/gate match; t_enc differs.
  await env.WEBHOOK_BUFFER.put("localcalc:" + key + ":prophet", JSON.stringify({ values: { comparable: { prophet_r38: { d_enc: 1, structure_subtype: 0, t_enc: 5 } } } }));
  await env.WEBHOOK_BUFFER.put("localcalc:" + key + ":gmi", JSON.stringify({ values: { comparable: { gmi_v12_70: { verdict: 3, gate: 2, conflict: false } } } }));
  h = await hudReadings(env, await loadHudSnapshot(env, { timeframe: "60" }));
  assert.equal(h.verified_against_approved_record, true);
  const prophet = h.readings.prophet.lines;
  assert.equal(prophet[0].verified, true, "structure line verified");
  assert.equal(prophet[1].verified, false, "t_enc differs from the approved record, so it is not verified");
  assert.equal(h.readings.decision_matrix.lines[0].verified, true);
  assert.equal(h.readings.decision_matrix.lines.at(-1).verified, false, "system guard is an internal");
  assert.deepEqual(h.not_computed, ["grid_bot_protocol"]);
});

function comparisonsDb(rows) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE engine_parity_comparisons (engine TEXT, candle_key TEXT, result TEXT)");
  for (const [engine, candle, result] of rows) db.prepare("INSERT INTO engine_parity_comparisons VALUES (?, ?, ?)").run(engine, candle, result);
  const wrap = (sql, params = []) => ({ bind: (...a) => wrap(sql, a), all: async () => ({ results: db.prepare(sql).all(...params) }) });
  return { prepare: (sql) => wrap(sql) };
}

test("bars are verified only by a matching parity comparison of the same candle, and never with an input mismatch", async () => {
  assert.equal(await barsVerified({ DB: comparisonsDb([["prophet", key, "match"], ["gmi", key, "match"]]) }, key), true);
  assert.equal(await barsVerified({ DB: comparisonsDb([["prophet", key, "match"], ["gmi", key, "input_mismatch"]]) }, key), false);
  assert.equal(await barsVerified({ DB: comparisonsDb([["prophet", key, "incomplete"]]) }, key), false);
  assert.equal(await barsVerified({ DB: comparisonsDb([["prophet", "OANDA:XAUUSD:60:1", "match"]]) }, key), false, "another candle says nothing");
  assert.equal(await barsVerified({ DB: { prepare: () => { throw new Error("no such table"); } } }, key), false);
  assert.equal(await barsVerified({}, key), false);

  // Through hudReadings: the bar tier needs both the approved record and the matching comparison.
  const huds = { chronos_matrix: { fields: { session_london: true, verdict: 3 }, parity: { verdict: "gmi_v12_70.verdict" } } };
  const env = { SIGNAL_CACHE: kv(), WEBHOOK_BUFFER: kv(), DB: comparisonsDb([["gmi", key, "match"]]) };
  let h = await hudReadings(env, snapshot({ huds }));
  assert.equal(h.bars_verified, false, "no approved record: the candle is not in the trusted lane");
  await env.WEBHOOK_BUFFER.put("localcalc:" + key + ":gmi", JSON.stringify({ values: { comparable: { gmi_v12_70: { verdict: 3 } } } }));
  h = await hudReadings(env, snapshot({ huds }));
  assert.equal(h.bars_verified, true);
  assert.deepEqual(h.readings.chronos_matrix.lines.map(l => [l.verified, l.derived]), [[false, true], [true, false]]);
});

test("the Prophet reading gets the setup gate of the same snapshot (computed for the R37 Funnel)", async () => {
  const huds = { prophet: { fields: { d_enc: 0, structure_subtype: 0, t_enc: 0, cycle_intensity: -3 } }, r37_funnel: { fields: { gate_status: "SELL_WAIT_PRICE" } } };
  const h = await hudReadings({ SIGNAL_CACHE: kv(), WEBHOOK_BUFFER: kv() }, snapshot({ huds }));
  assert.ok(h.readings.prophet.lines.some(l => l.text === "Prophet's setup: a sell setup is waiting for price confirmation, and all three Prophet cycles point down."));
});

test("the Prophet reading takes the R38 signal and the R37 direction from the same snapshot, verified against the approved record", async () => {
  const huds = {
    prophet: { fields: { d_enc: 0, structure_subtype: 0, t_enc: 0, cycle_intensity: 1 }, parity: { d_enc: "prophet_r38.d_enc" } },
    r37_funnel: { fields: { buy_confirmed: true, sell_confirmed: false, buy_high_quality: false, gate_status: "BUY_CONFIRMED" }, parity: { buy_confirmed: "prophet_r38.buy_confirmed", sell_confirmed: "prophet_r38.sell_confirmed" } },
    trade_management: { fields: { prophet_dir: 1 }, parity: { prophet_dir: "gmi_v12_70.prophet_dir" } }
  };
  const env = { SIGNAL_CACHE: kv(), WEBHOOK_BUFFER: kv() };
  await env.WEBHOOK_BUFFER.put("localcalc:" + key + ":prophet", JSON.stringify({ values: { comparable: { prophet_r38: { buy_confirmed: true, sell_confirmed: false, d_enc: 0 } } } }));
  await env.WEBHOOK_BUFFER.put("localcalc:" + key + ":gmi", JSON.stringify({ values: { comparable: { gmi_v12_70: { prophet_dir: 1 } } } }));
  const lines = (await hudReadings(env, snapshot({ huds }))).readings.prophet.lines;
  assert.deepEqual(lines.slice(0, 2).map(l => [l.text, l.verified]), [
    ["Prophet's signal: a confirmed BUY on this closed candle.", true],
    ["Prophet's direction is bullish, with momentum and structure in agreement.", true]
  ]);
});

test("invalid snapshots are refused without writing", async () => {
  const env = { SIGNAL_CACHE: kv(), WEBHOOK_BUFFER: kv() };
  const r = await storeHudSnapshot(env, snapshot({ timeframe: "5" }), now);
  assert.equal(r.status, 400);
  assert.equal(env.SIGNAL_CACHE.map.size, 0);
});
