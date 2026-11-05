import test from "node:test";
import assert from "node:assert/strict";
import { validateHudSnapshot, storeHudSnapshot, loadHudSnapshot, hudReadings, HUD_SNAPSHOT_VERSION } from "../src/hud-store.mjs";

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

test("invalid snapshots are refused without writing", async () => {
  const env = { SIGNAL_CACHE: kv(), WEBHOOK_BUFFER: kv() };
  const r = await storeHudSnapshot(env, snapshot({ timeframe: "5" }), now);
  assert.equal(r.status, 400);
  assert.equal(env.SIGNAL_CACHE.map.size, 0);
});
