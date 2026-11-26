// ZF2 (owner 2026-11-26: "ZF2 snapshot Weekly"): the weekly HUD snapshot ("1W", hud:1W:latest), read by the zone typing
// only. It is optional: a missing weekly snapshot changes nothing anywhere; the four other charts are byte for byte as
// before; the producer (the pull adapter's HUD publisher) emits it from the bundle's W1 bars, without GMI.
import test from "node:test";
import assert from "node:assert/strict";
import { validateHudSnapshot, storeHudSnapshot, loadHudSnapshot, HUD_TIMEFRAMES, HUD_LATEST_TTL_S, latestTtlSeconds } from "../src/hud-store.mjs";
import { dsEvidence, zoneTypes, ZONE_TF_WEIGHT, ZONE_TF_NAME, dsSourceLabels } from "../src/zone-types.mjs";
import { buildKeyLevels, TF_WEIGHT } from "../src/key-level-agent.mjs";
import * as se from "../src/strategy-engine.mjs";
import { slimInputs } from "../src/strategy-inputs.mjs";
import { buildHudSnapshot, GMI_NOT_ON_WEEKLY } from "../local-engines/producer/src/hud-snapshot.mjs";
import { publishHudSnapshots } from "../market-data-ingestion/src/local-publisher.mjs";
import { zoneInputs, NOW } from "./support/zone-types-fixture.mjs";
import { weeklyBars, WEEK, WEEKLY_END } from "./support/hud-weekly-fixture.mjs";

const DAY_S = 86_400;
const kvStore = () => {
  const map = new Map(), puts = [];
  return { map, puts, async get(k) { return map.has(k) ? map.get(k) : null; }, async put(k, v, o) { map.set(k, v); puts.push([k, o?.expirationTtl ?? null]); } };
};
const base = (tf, ms, now) => ({
  schema_version: "cryptophys.hud-snapshot.v1", symbol: "OANDA:XAUUSD", timeframe: tf, candle_key: `OANDA:XAUUSD:${tf}:${ms}`,
  computed_at: new Date(now).toISOString(), huds: { prophet: { fields: { d_enc: 1 } } }
});
// A zone as the Key Level Agent emits it, and a weekly snapshot with only the boxes given.
const zone = (low, high, role = "support") => ({ low, high, price: (low + high) / 2, role, candidate: true });
const weekly = ({ prophet = [], whales = [], ob = null } = {}) => ({
  timeframe: "1W", computed_at: "2026-11-15T22:00:00Z", candle_key: "OANDA:XAUUSD:1W:1794780000000",
  huds: { ...(ob ? { order_blocks: { fields: ob } } : {}) },
  chart_plane: { version: "cryptophys.chart-plane.weekly.v1", liquidity: { whale_zones: whales }, ...(prophet.length ? { zones: { prophet } } : {}) }
});
const pz = (side, bottom, top, extra = {}) => ({ side, bottom, top, age_bars: 5, high_volume: false, touches: 0, ...extra });
const Z0_KEYS = new Set(["ds", "zone_types", "opposing_ahead", "zone_type", "zone_strength", "zone_freshness", "zone_rank", "ds_sources"]);
const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !Z0_KEYS.has(k)).map(([k, x]) => [k, strip(x)])) : v);

test("ZF2-1 the weekly timeframe: 1W after the four, an 8-day latest TTL; the four others unchanged; the typing weighs it 3 as 'weekly'", () => {
  assert.deepEqual([...HUD_TIMEFRAMES], ["60", "15", "240", "1D", "1W"]);
  assert.deepEqual(Object.fromEntries(["15", "60", "240", "1D"].map((tf) => [tf, HUD_LATEST_TTL_S[tf]])), { "15": 10800, "60": 10800, "240": 18000, "1D": 93600 });
  assert.equal(latestTtlSeconds("1W"), 8 * DAY_S);
  assert.ok(latestTtlSeconds("1W") > 7 * DAY_S, "longer than one weekly bar");
  assert.deepEqual([ZONE_TF_WEIGHT["1W"], ZONE_TF_NAME["1W"]], [3, "weekly"]);
  assert.deepEqual([ZONE_TF_WEIGHT.W, ZONE_TF_NAME.W], [3, "weekly"], "the weekly levels' own weight and word");
  assert.deepEqual(ZONE_TF_WEIGHT, TF_WEIGHT, "the Key Level Agent's weights stay equal");
});

test("ZF2-2 a weekly snapshot is accepted and stored per candle (14 days) and as hud:1W:latest (8 days); a malformed one is refused", async () => {
  const now = WEEKLY_END + 60_000;
  const snap = buildHudSnapshot({ timeframes: { W1: { candles: weeklyBars() } } }, { chart: "W1", now });
  const kv = kvStore();
  const r = await storeHudSnapshot({ SIGNAL_CACHE: kv }, snap, now);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual(r.body, { status: "accepted", candle_key: snap.candle_key, timeframe: "1W" });
  assert.deepEqual(kv.puts, [[`hud:1W:${snap.candle_key}`, 14 * DAY_S], ["hud:1W:latest", 8 * DAY_S]]);
  assert.equal((await loadHudSnapshot({ SIGNAL_CACHE: kv }, { timeframe: "1W" })).candle_key, snap.candle_key);
  // The key's timeframe must be the snapshot's; "W", "1M" and a daily key under 1W are not weekly snapshots.
  const ms = WEEKLY_END - WEEK;
  assert.deepEqual(validateHudSnapshot({ ...base("1W", ms, now), candle_key: `OANDA:XAUUSD:1D:${ms}` }, now).errors, ["candle_key_invalid"]);
  assert.deepEqual(validateHudSnapshot(base("W", ms, now), now).errors, ["unsupported_timeframe", "candle_key_invalid"]);
  assert.deepEqual(validateHudSnapshot(base("1M", ms, now), now).errors, ["unsupported_timeframe", "candle_key_invalid"]);
  assert.deepEqual(validateHudSnapshot(base("1W", ms, now), now), { valid: true, errors: [] });
});

test("ZF2-3 the four other charts store exactly as before: the same keys, TTLs and bodies", async () => {
  const now = Date.parse("2026-11-26T10:01:00Z");
  const kv = kvStore();
  const cases = [["60", "2026-11-26T09:00:00Z"], ["15", "2026-11-26T09:45:00Z"], ["240", "2026-11-26T06:00:00Z"], ["1D", "2026-11-24T22:00:00Z"]];
  for (const [tf, open] of cases) assert.equal((await storeHudSnapshot({ SIGNAL_CACHE: kv }, base(tf, Date.parse(open), now), now)).status, 202, tf);
  assert.deepEqual(kv.puts.filter(([k]) => k.endsWith(":latest")), [["hud:60:latest", 10800], ["hud:15:latest", 10800], ["hud:240:latest", 18000], ["hud:1D:latest", 93600]]);
  assert.ok(kv.puts.filter(([k]) => !k.endsWith(":latest")).every(([, t]) => t === 14 * DAY_S));
  assert.equal(JSON.parse(kv.map.get("hud:60:latest")).received_at, new Date(now).toISOString());
  assert.equal(await loadHudSnapshot({ SIGNAL_CACHE: kv }, { timeframe: "1W" }), null, "no weekly snapshot: null, never an error");
  assert.equal(await loadHudSnapshot({}, { timeframe: "1W" }), null, "no KV: null");
});

test("ZF2-4 typing: weekly boxes weigh 3x and read @weekly; no weekly snapshot (absent or null) gives the evidence as before", () => {
  const z = zone(3995, 3999);
  const snaps = { "1W": weekly({ prophet: [pz("demand", 3996, 3998)], whales: [{ role: "support", state: "active", top: 3998.5, bottom: 3995.5 }] }) };
  const ev = dsEvidence({ snapshots: snaps, atrH1: 10 });
  assert.deepEqual(ev.boxes.map((b) => [b.source, b.tf, b.side, b.weight]), [["prophet_zone", "1W", "demand", 2.1], ["whale", "1W", "demand", 2.7]]);
  const ds = zoneTypes([z], ev)[0].ds;
  assert.deepEqual([ds.type, ds.strength, ds.score, ds.sources], ["demand", "strong", 4.8, ["prophet_zone@weekly", "whale@weekly"]]);
  assert.deepEqual(dsSourceLabels(ds), ["prophet_zone@weekly", "whale@weekly"], "the recorded labels keep the weekly word");
  // A weekly best order block is prophet_best@weekly on a chart without Prophet zones.
  const best = zoneTypes([zone(4018, 4022, "resistance")], dsEvidence({ snapshots: { "1W": weekly({ ob: { bear_top: 4023, bear_bottom: 4019 } }) }, atrH1: 10 }))[0].ds;
  assert.deepEqual([best.type, best.score, best.sources], ["supply", 2.1, ["prophet_best@weekly"]]);
  // Missing: the same evidence as the four charts alone.
  const four = zoneInputs();
  const charts = { "15": four.m15Snapshot, "60": four.h1Snapshot, "240": four.h4Snapshot, "1D": four.d1Snapshot };
  const plain = dsEvidence({ snapshots: charts, bars15: four.m15Bars, atrH1: 10 });
  assert.deepEqual(dsEvidence({ snapshots: { ...charts, "1W": null }, bars15: four.m15Bars, atrH1: 10 }), plain);
  assert.deepEqual(dsEvidence({ snapshots: { ...charts, "1W": undefined }, bars15: four.m15Bars, atrH1: 10 }), plain);
  assert.ok(!plain.boxes.some((b) => b.tf === "1W"));
});

test("ZF2-5 the strategy: a weekly snapshot types the zones and changes nothing else; none (absent or null) is the strategy byte for byte", () => {
  const inputs = zoneInputs();
  const off = se.buildStrategy(inputs);
  assert.equal(JSON.stringify(se.buildStrategy({ ...inputs, w1Snapshot: null })), JSON.stringify(off), "null: byte for byte");
  assert.equal(JSON.stringify(se.buildStrategy({ ...inputs, w1Snapshot: undefined })), JSON.stringify(off), "undefined: byte for byte");
  const w = weekly({ prophet: [pz("demand", 3996, 3998), pz("supply", 4019.5, 4021.5)] });
  const on = se.buildStrategy({ ...inputs, w1Snapshot: w });
  assert.ok(on.key_levels.zones.some((z) => z.ds.sources.some((l) => l.endsWith("@weekly"))), "a zone is typed by a weekly box");
  // The overlay only: zones, members, candidates, scores, roles, labels and every price are the four charts'.
  assert.equal(JSON.stringify(strip(on)), JSON.stringify(strip(off)));
  assert.equal(on.key_levels.raw_count, off.key_levels.raw_count, "the weekly snapshot adds no raw level");
  const reading = (snapshots) => buildKeyLevels({ snapshots, bars: { M15: inputs.m15Bars, H1: inputs.h1Bars }, price: 4000, atrH1: 10 });
  const four = { "15": inputs.m15Snapshot, "60": inputs.h1Snapshot, "240": inputs.h4Snapshot, "1D": inputs.d1Snapshot };
  assert.deepEqual(strip(reading({ ...four, "1W": w }).zones), strip(reading(four).zones));
  // KM1's per-chart map does not read it.
  assert.deepEqual(se.keyLevelChartsOf({ ...inputs, w1Snapshot: w }), se.keyLevelChartsOf(inputs));
});

test("ZF2-6 the inputs: hud:1W:latest is loaded when present and only then; the capture keeps it only when present", async () => {
  const none = await se.loadStrategyInputs({ SIGNAL_CACHE: kvStore() }, { now: NOW });
  assert.equal("w1Snapshot" in none, false, "no weekly snapshot: the inputs carry no key");
  const kv = kvStore();
  const now = WEEKLY_END + 60_000;
  const snap = buildHudSnapshot({ timeframes: { W1: { candles: weeklyBars() } } }, { chart: "W1", now });
  await storeHudSnapshot({ SIGNAL_CACHE: kv }, snap, now);
  const loaded = await se.loadStrategyInputs({ SIGNAL_CACHE: kv }, { now: NOW });
  assert.equal(loaded.w1Snapshot.candle_key, snap.candle_key);
  assert.ok(dsEvidence({ snapshots: { "1W": loaded.w1Snapshot }, atrH1: 10 }).boxes.some((b) => b.tf === "1W" && b.source === "prophet_zone"));
  assert.equal("w1Snapshot" in slimInputs(zoneInputs()), false, "stored inputs are unchanged without it");
  const slim = slimInputs({ ...zoneInputs(), w1Snapshot: loaded.w1Snapshot });
  assert.equal(slim.w1Snapshot.timeframe, "1W");
  assert.deepEqual(slim.w1Snapshot.chart_plane, loaded.w1Snapshot.chart_plane, "the replay sees the weekly boxes");
});

test("ZF2-7 the producer: the HUD publisher emits W1 from the bundle's weekly bars (no GMI), once, catching up while it is the latest close", async () => {
  const sent = [];
  const kv = kvStore();
  const env = { HUD_SNAPSHOT_PUBLISH: "true", MARKET_DATA_CACHE: kv, AI_WORKER: { async submitHud(s) { sent.push(s); return { status: 202, body: { status: "accepted" } }; } } };
  const bundle = { timeframes: { W1: { candles: weeklyBars() } } };
  const r = await publishHudSnapshots(env, { now: WEEKLY_END + 65 * 60_000, bundle });
  assert.equal(r.charts.W1.status, "published", JSON.stringify(r.charts.W1));
  assert.equal(r.charts.W1.catch_up, undefined, "an hour after the close is on time");
  assert.equal(r.charts.W1.chart_plane, "cryptophys.chart-plane.weekly.v1");
  assert.deepEqual(["H1", "M15", "H4", "D1"].map((c) => r.charts[c].status), ["no_data", "no_data", "no_data", "no_data"], "the other charts as before without their bars");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].timeframe, "1W");
  assert.equal(sent[0].gmi_error, GMI_NOT_ON_WEEKLY);
  assert.deepEqual(kv.puts.find(([k]) => k === "market-data:v2:hud-published:" + sent[0].candle_key), ["market-data:v2:hud-published:" + sent[0].candle_key, 8 * DAY_S]);
  assert.equal((await publishHudSnapshots(env, { now: WEEKLY_END + 2 * 3600_000, bundle })).charts.W1.status, "already_published");
  assert.equal(sent.length, 1, "once only");
  // A bar never sent is caught up while it is the latest close (6 days), then left.
  const late = { ...env, MARKET_DATA_CACHE: kvStore() };
  const caught = await publishHudSnapshots(late, { now: WEEKLY_END + 2 * 86_400_000, bundle });
  assert.deepEqual([caught.charts.W1.status, caught.charts.W1.catch_up], ["published", true]);
  const past = await publishHudSnapshots({ ...env, MARKET_DATA_CACHE: kvStore() }, { now: WEEKLY_END + 6 * 86_400_000 + 60_000, bundle });
  assert.equal(past.charts.W1.status, "no_fresh_close");
  // Too few weekly bars: reported, never invented.
  const short = await publishHudSnapshots({ ...env, MARKET_DATA_CACHE: kvStore() }, { now: WEEKLY_END + 60_000, bundle: { timeframes: { W1: { candles: weeklyBars(120) } } } });
  assert.equal(short.charts.W1.status, "insufficient_hud_history");
  // End to end: the AI Worker's store accepts what the publisher sends.
  const ai = kvStore();
  const e2e = { ...env, MARKET_DATA_CACHE: kvStore(), AI_WORKER: { submitHud: (s) => storeHudSnapshot({ SIGNAL_CACHE: ai }, s, WEEKLY_END + 65 * 60_000) } };
  assert.equal((await publishHudSnapshots(e2e, { now: WEEKLY_END + 65 * 60_000, bundle })).charts.W1.status, "published");
  assert.ok(ai.map.has("hud:1W:latest"));
});
