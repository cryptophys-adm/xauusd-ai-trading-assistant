// B19 (Track B PR 19, owner 2026-11-22: "tidak perlu shadow, langsung integrasikan ... position dan lainnya"): lens B's
// effects recorded and scored. The ladder's lock carries level_source "liquidity" only when a lens B rung set its price;
// the limit council's skips on liquidity_sweep_against become skip readings (scored as blocks); the stops Omega moved to
// a lens B level become hold readings (eight 15m bars: a close more than 0.1 x ATR15 beyond is a miss). Both are reported
// only, never in the automatic floor (FLOOR_KINDS). LENS_LEVEL_READINGS "off" stops both. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as oe from "../src/omega-engine.mjs";
import * as pm from "../src/position-manager.mjs";
import { scoreLevelHold, LEVEL_HOLD_ATR, LEVEL_HOLD_BARS_15M, archiveBrokerBars, resetLiquiditySchemaForTests } from "../src/liquidity-lens.mjs";
import { lensLevelReadings, holdReadingId, recordSkipReadings, lensHoldStep, scoreLedgerReadings, runLensStep } from "../src/lens-steps.mjs";
import { FLOOR_KINDS, lensFloorStep, ensureLensReadingsSchema, resetLensStateMemoForTests, LENS_FLOOR_KEY } from "../src/lens-policy.mjs";
import { ensureLimitCouncilSchema, resetLimitCouncilSchemaForTests } from "../src/limit-council.mjs";
import { ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH, engineCodeSource, sha256Hex } from "../src/ledger-omega4.mjs";
import { engineBehaviourSource } from "./fixtures/engine-behaviour.mjs";
import { managementScenario, SIGNAL_PLAIN, SYM, LONG, META, NOW } from "./support/zone-sd-fixture.mjs";
import { d1, kv } from "./support/liquidity-view-seed.mjs";

const M1 = 60_000, M15 = 15 * M1, HOUR = 3_600_000, DAY = 86_400_000;
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const LENS = Object.freeze({ liquidity_on: true, liquidity_weight: 0.3, liquidity_spread_median: 20, liquidity_spread_widen: 2 });
const ladder = (signal, bid, over = {}) => oe.manageIntents({ positions: [{ ...LONG, sl: 3890, ...over }], sym: { ...SYM, bid, ask: bid + 0.2 }, settings: { ...oe.OMEGA_DEFAULTS, tp_ladder: true }, signal: { ...signal, power: 0.3 }, now: NOW, positionMeta: META }).filter((i) => i.kind === "modify_sl");

test("LR-1 the ladder's lock carries level_source \"liquidity\" only on a lens B rung; a key-level, tied or break-even rung and the lens off add no key", () => {
  // A long from 3900: lens B's node 3909-3909.5 sits between L1 (3905) and L2 (3913). At 3914 the lock steps to it.
  const lens = { ...SIGNAL_PLAIN, ...LENS, liquidity_levels: "3909:3909.5:hvn" };
  assert.deepEqual(ladder(lens, 3914), [{ id: "ms:7:lad:390900", kind: "modify_sl", ticket: 7, sl: 3909, tp: 3945, reason: "ladder_lock_tp2", level_source: "liquidity" }]);
  // A key-level rung (3915, L3) with lens B in the set: no key.
  assert.deepEqual(ladder(lens, 3920), [{ id: "ms:7:lad:391500", kind: "modify_sl", ticket: 7, sl: 3915, tp: 3945, reason: "ladder_lock_tp4" }]);
  // The same lock without lens B (a key rung 3905): today's payload.
  assert.deepEqual(ladder(SIGNAL_PLAIN, 3914), [{ id: "ms:7:lad:390500", kind: "modify_sl", ticket: 7, sl: 3905, tp: 3945, reason: "ladder_lock_tp1" }]);
  // A tie (a lens B level sharing L1's edge, kept unmerged with the spread unknown): no key.
  const tie = { ...SIGNAL_PLAIN, ...LENS, liquidity_spread_median: 0, liquidity_levels: "3905:3905.3:pool" };
  for (const bid of [3908, 3910, 3912]) assert.ok(ladder(tie, bid).every((i) => !("level_source" in i) || i.reason.startsWith("sl_key_level")), `${bid}`);
  // The break-even rung (TP0): never tagged.
  for (const bid of [3902, 3903, 3904]) assert.ok(ladder(lens, bid).filter((i) => i.reason === "ladder_lock_tp0").every((i) => !("level_source" in i)), `${bid}`);
  // The lens off: byte for byte the plain signal's.
  for (const bid of [3911, 3914, 3920, 3930]) assert.deepEqual(ladder({ ...lens, liquidity_on: false }, bid), ladder(SIGNAL_PLAIN, bid));
  // Without lens B the whole management scenario is today's.
  assert.equal(sha(managementScenario({ oe, pm }, { signal: { ...SIGNAL_PLAIN, liquidity_on: false, liquidity_levels: "" } })), sha(managementScenario({ oe, pm }, { signal: SIGNAL_PLAIN })));
});

/** M1 bars at a flat price with a given 15m range (ATR15 = range), from `from` for `n` minutes. */
const flat = (from, n, { c = 3920, range = 2, at = {} } = {}) => Array.from({ length: n }, (_, i) => { const t = from + i * M1; const close = at[t] ?? c; return { t, o: close, h: close + range / 2, l: close - range / 2, c: close, v: 100 }; });

test("LR-2 scoreLevelHold: eight closed 15m bars; a close more than 0.1 x ATR15 beyond the level is a miss, exactly 0.1 holds; pending while open; neutral without ATR or bars", () => {
  const created = NOW - 4 * HOUR + 7 * M1, start = Math.ceil(created / M15) * M15, end = start + LEVEL_HOLD_BARS_15M * M15;
  const before = flat(start - 20 * M15, 20 * 15, { c: 3920 });
  const atr = 2; // each 15m bar's range is 2 (flat closes)
  const window = (close) => flat(start, LEVEL_HOLD_BARS_15M * 15, { c: 3920, at: { [start + 3 * M15 + 14 * M1]: close } });
  const level = 3915, long = (bars, now = end + M1) => scoreLevelHold({ level, side: 1, created_ms: created, bars, now });
  assert.equal(long([...before, ...window(3920)]), "hit");
  assert.equal(long([...before, ...window(level - LEVEL_HOLD_ATR * atr)]), "hit", "exactly 0.1 ATR beyond holds");
  assert.equal(long([...before, ...window(level - LEVEL_HOLD_ATR * atr - 0.01)]), "miss");
  assert.equal(long([...before, ...window(3920)], end - M1), null, "the window is still open");
  assert.equal(long([...before, ...window(level - 1)], start + 4 * M15), "miss", "a miss inside the window is final");
  assert.equal(long([...before, ...window(level - 1)], start + 3 * M15 + 14 * M1), null, "a 15m bar still forming is not read");
  assert.equal(long(window(3920)), "neutral", "no ATR before the window");
  assert.equal(long([...before, ...window(3920).slice(0, 60)]), "neutral", "bars missing once the window is over");
  // A short: the stop above; a close beyond it upward is the miss.
  assert.equal(scoreLevelHold({ level: 3925, side: -1, created_ms: created, bars: [...before, ...window(3925 + 0.5)], now: end + M1 }), "miss");
  assert.equal(scoreLevelHold({ level: 3925, side: -1, created_ms: created, bars: [...before, ...window(3920)], now: end + M1 }), "hit");
  assert.equal(scoreLevelHold({ level: 3925, side: 0, created_ms: created, bars: before }), "neutral");
});

/** An environment with the active account, its M1 archive, omega_intents, limit_council, ledger_omega4 and lens_readings. */
async function world({ intents = [], skips = [], ledger = [], bars = [], extra = {} } = {}) {
  resetLiquiditySchemaForTests(); resetLensStateMemoForTests(); resetLimitCouncilSchemaForTests();
  const env = { DB: d1(), SIGNAL_CACHE: kv(), TRADING_MODE: "intraday", ...extra };
  const raw = env.DB.raw;
  raw.exec("CREATE TABLE IF NOT EXISTS omega_bridge (id INTEGER PRIMARY KEY, state TEXT); CREATE TABLE IF NOT EXISTS omega_connection (id INTEGER PRIMARY KEY, version INTEGER, status TEXT, server TEXT); CREATE TABLE IF NOT EXISTS omega_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER, actor TEXT, action TEXT, detail TEXT); CREATE TABLE IF NOT EXISTS omega_settings (id INTEGER PRIMARY KEY, settings TEXT, version INTEGER)");
  raw.exec("CREATE TABLE IF NOT EXISTS omega_intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER)");
  raw.exec("CREATE TABLE IF NOT EXISTS ledger_omega4 (decision_key TEXT, side TEXT, omega4_status TEXT, r_omega4 REAL, limit_status TEXT, r_limit REAL)");
  const ref = "acct_00112233aabbccdd";
  raw.prepare("INSERT OR REPLACE INTO omega_bridge (id, state) VALUES (1, ?)").run(JSON.stringify({ account_ref: ref, server: "Demo-MT5", connected: true, received_ms: NOW - 1000, account: { login_hash: "f".repeat(64) }, symbol: { name: "XAUUSD", digits: 2, spread_points: 20 } }));
  raw.prepare("INSERT OR REPLACE INTO omega_connection (id, version, status, server) VALUES (1, 3, 'stored', 'Demo-MT5')").run();
  if (bars.length) await archiveBrokerBars(env.DB, { accountRef: ref, source: "mt5:demo-mt5:XAUUSD", digits: 2, connectionVersion: 3, bars, now: NOW });
  const ins = raw.prepare("INSERT INTO omega_intents (id, kind, payload, status, result, created_ms) VALUES (?, ?, ?, ?, ?, ?)");
  for (const i of intents) ins.run(i.id, i.kind ?? "modify_sl", JSON.stringify(i.payload), i.status ?? "done", JSON.stringify(i.result ?? { ok: true }), i.created_ms);
  await ensureLimitCouncilSchema(env.DB);
  const lc = raw.prepare("INSERT INTO limit_council (id, kind, open_id, at_ms, status, choice, rule, facts, updated_ms) VALUES (?, 'entry', ?, ?, 'decided', ?, ?, ?, ?)");
  for (const s of skips) lc.run(s.id, s.id, s.at_ms, s.choice ?? "skip", s.rule, JSON.stringify({ side: s.side, mode: "intraday", issued_ms: s.issued_ms }), s.at_ms);
  const lg = raw.prepare("INSERT INTO ledger_omega4 (decision_key, side, omega4_status, r_omega4, limit_status, r_limit) VALUES (?, ?, ?, ?, ?, ?)");
  for (const l of ledger) lg.run(l.key, l.side, l.status, l.r, null, null);
  await ensureLensReadingsSchema(env.DB);
  return env;
}
const readings = (env, kind) => env.DB.raw.prepare("SELECT id, kind, at_ms, mode, side, outcome, detail_json FROM lens_readings WHERE kind = ? ORDER BY at_ms").all(kind).map((r) => ({ ...r }));

test("LR-3 hold readings: one per ticket and stop price (retries and a key-level and ladder lock at one price are one); the id and the detail carry no price; a rerun adds nothing", async () => {
  const t = NOW - 5 * HOUR + 3 * M1, start = Math.ceil(t / M15) * M15;
  const bars = [...flat(start - 20 * M15, 20 * 15, { c: 3920 }), ...flat(start, 9 * 15, { c: 3920 })];
  const payload = (reason) => ({ ticket: 7, sl: 3915, tp: 3945, reason, level_source: "liquidity" });
  const intents = [
    { id: "ms:7:lad:391500", payload: payload("ladder_lock_tp2"), created_ms: t },
    { id: "ms:7:lad:391500:2", payload: payload("ladder_lock_tp2"), created_ms: t + M1 },
    { id: "ms:7:k:391500", payload: payload("sl_key_level_normal"), created_ms: t + 2 * M1 },
    { id: "ms:8:k:392500", payload: { ticket: 8, sl: 3925, tp: 3900, reason: "sl_key_level_normal", level_source: "liquidity" }, created_ms: t },
    { id: "ms:9:k:391000", payload: { ticket: 9, sl: 3910, reason: "sl_key_level_normal" }, created_ms: t },
    { id: "ms:10:k:391100", payload: { ticket: 10, sl: 3911, reason: "sl_key_level_normal", level_source: "liquidity" }, status: "failed", created_ms: t }
  ];
  const env = await world({ intents, bars });
  const r = await lensHoldStep(env, { now: NOW, mode: "intraday" });
  assert.deepEqual([r.status, r.seen, r.added], ["ok", 4, 2]);
  const rows = readings(env, "hold");
  assert.deepEqual(rows.map((x) => [x.side, x.outcome, JSON.parse(x.detail_json).what]), [[1, "hit", "ladder"], [-1, "hit", "trail"]]);
  assert.deepEqual(rows.map((x) => x.id).sort(), [holdReadingId(7, 3915), holdReadingId(8, 3925)].sort());
  for (const x of rows) { assert.doesNotMatch(x.id, /39\d\d/); assert.doesNotMatch(x.detail_json, /\d{3,5}/, "no price in the detail"); }
  assert.notEqual(holdReadingId(7, 3915), holdReadingId(7, 3915.01));
  const again = await lensHoldStep(env, { now: NOW + HOUR, mode: "intraday" });
  assert.deepEqual([again.added, again.scored], [0, 0]);
  assert.equal(readings(env, "hold").length, 2);
  // A pending reading (window open) is scored on a later run.
  const t2 = NOW - 30 * M1;
  const env2 = await world({ intents: [{ id: "ms:7:k:391500", payload: payload("sl_key_level_normal"), created_ms: t2 }], bars: [...flat(Math.ceil(t2 / M15) * M15 - 20 * M15, 20 * 15 + 30, { c: 3920 })] });
  await lensHoldStep(env2, { now: NOW, mode: "intraday" });
  assert.equal(readings(env2, "hold")[0].outcome, null);
});

test("LR-4 skip readings: a rule naming liquidity_sweep_against (either shape) records one per signal and side; a bare council_skip does not; scored as blocks", async () => {
  const issued = NOW - 3 * HOUR;
  const skips = [
    { id: "ec:a", at_ms: issued + 5000, issued_ms: issued, side: "BUY", rule: "council_skip:liquidity_sweep_against" },
    { id: "ec:b", at_ms: issued + 6000, issued_ms: issued + M15, side: "SELL", rule: "liquidity_sweep_against+liquidity_thin" },
    { id: "ec:c", at_ms: issued + 7000, issued_ms: issued + 2 * M15, side: "BUY", rule: "council_skip" },
    { id: "ec:d", at_ms: issued + 8000, issued_ms: issued + 3 * M15, side: "BUY", rule: "liquidity_thin", choice: "place_limit" }
  ];
  const ledger = [{ key: `OANDA:XAUUSD:15:${issued - M15}`, side: "BUY", status: "closed", r: -1 }, { key: `OANDA:XAUUSD:15:${issued}`, side: "SELL", status: "closed", r: 1.5 }];
  const env = await world({ skips, ledger });
  assert.deepEqual(await recordSkipReadings(env, { now: NOW, mode: "intraday" }), { added: 2, rows: 3 });
  assert.deepEqual((await recordSkipReadings(env, { now: NOW, mode: "intraday" })).added, 0, "one per signal and side");
  assert.deepEqual(readings(env, "skip").map((r) => r.id), [`skip:${issued}:B`, `skip:${issued + M15}:S`]);
  assert.equal(await scoreLedgerReadings(env, { now: NOW }), 0, "skips are scored only with LENS_LEVEL_READINGS on");
  assert.equal(await scoreLedgerReadings(env, { now: NOW, skip: true }), 2);
  assert.deepEqual(readings(env, "skip").map((r) => r.outcome), ["hit", "miss"], "a v4 loss avoided is a hit; a v4 win skipped a miss");
});

test("LR-5 the floor reads FLOOR_KINDS only: any number of hold and skip misses never floor lens B; the same misses as sweeps do", async () => {
  assert.deepEqual([...FLOOR_KINDS.liquidity], ["sweep", "block", "maker"]);
  const env = await world();
  const ins = env.DB.raw.prepare("INSERT INTO lens_readings (id, lens, kind, at_ms, mode, side, outcome, detail_json, scored_ms) VALUES (?, 'liquidity', ?, ?, 'intraday', 1, ?, NULL, ?)");
  for (let i = 0; i < 100; i += 1) { ins.run(`hold:${i}`, "hold", NOW - i * M1, "miss", NOW); ins.run(`skip:${i}:B`, "skip", NOW - i * M1, "miss", NOW); }
  for (let i = 0; i < 20; i += 1) ins.run(`sweep:${i}`, "sweep", NOW - 2 * DAY - i * M1, i < 12 ? "hit" : "miss", NOW);
  const r = await lensFloorStep(env, { now: NOW });
  assert.equal(r.status, "ok");
  assert.equal(r.lenses.liquidity.floored, false);
  assert.equal(r.lenses.liquidity.score.n, 20, "the 200 hold and skip readings are not in the floor's window");
  assert.equal(await env.SIGNAL_CACHE.get(LENS_FLOOR_KEY), null);
  // The same misses as sweeps floor it.
  const env2 = await world();
  const ins2 = env2.DB.raw.prepare("INSERT INTO lens_readings (id, lens, kind, at_ms, mode, side, outcome, detail_json, scored_ms) VALUES (?, 'liquidity', 'sweep', ?, 'intraday', 1, ?, NULL, ?)");
  for (let i = 0; i < 100; i += 1) ins2.run(`sweep:${i}`, NOW - i * M1, "miss", NOW);
  assert.equal((await lensFloorStep(env2, { now: NOW })).lenses.liquidity.floored, true);
});

test("LR-6 LENS_LEVEL_READINGS: \"off\" records and scores neither; on (default) the hourly lens step does both", async () => {
  assert.deepEqual([lensLevelReadings({}), lensLevelReadings({ LENS_LEVEL_READINGS: " OFF " }), lensLevelReadings({ LENS_LEVEL_READINGS: "on" }), lensLevelReadings({ LENS_LEVEL_READINGS: "x" })], ["on", "off", "on", "on"]);
  const t = NOW - 5 * HOUR + 3 * M1, start = Math.ceil(t / M15) * M15;
  const setup = { intents: [{ id: "ms:7:lad:391500", payload: { ticket: 7, sl: 3915, tp: 3945, reason: "ladder_lock_tp2", level_source: "liquidity" }, created_ms: t }], skips: [{ id: "ec:a", at_ms: t, issued_ms: t, side: "BUY", rule: "council_skip:liquidity_sweep_against" }], bars: [...flat(start - 20 * M15, 20 * 15, { c: 3920 }), ...flat(start, 9 * 15, { c: 3920 })] };
  const hourly = Date.UTC(2026, 10, 26, 10, 2);
  const off = await world({ ...setup, extra: { LENS_LEVEL_READINGS: "off" } });
  const r0 = await runLensStep(off, { now: hourly });
  assert.equal("hold_readings" in r0 || "skip_readings" in r0, false);
  assert.deepEqual([readings(off, "hold").length, readings(off, "skip").length], [0, 0]);
  const on = await world(setup);
  const r1 = await runLensStep(on, { now: hourly });
  assert.equal(r1.hold_readings.status, "ok");
  assert.equal(r1.skip_readings.added, 1);
});

test("LR-7 the hashes: V14 unchanged; ENGINE_CODE_HASH moves with manageIntents (the ladder tag) only", async () => {
  assert.equal(createHash("sha256").update(engineBehaviourSource()).digest("hex"), ENGINE_BEHAVIOUR_HASH);
  assert.equal(ENGINE_BEHAVIOUR_HASH, "ecfe3f90dbca623504efcbe7f70b778a4b6134a941a27b282c034f6c402baa69");
  assert.equal(await sha256Hex(engineCodeSource()), ENGINE_CODE_HASH);
  assert.notEqual(ENGINE_CODE_HASH, "b4077f53eef256e3966ae214c126624fb1e8edc39456c739fdb99012ec3d306a", "B19 moved it (manageIntents' ladder tag)");
});

/** A seeded M1 random walk (mulberry32), so the dry run below is the same on every run. */
function walk(from, n, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = []; let c = 3900;
  for (let i = 0; i < n; i += 1) { const o = c; c = Math.round((c + (rnd() - 0.5) * 0.9) * 100) / 100; out.push({ t: from + i * M1, o, h: Math.max(o, c) + 0.15, l: Math.min(o, c) - 0.15, c, v: 100 }); }
  return { bars: out, rnd };
}

test("LR-8 dry run over a seeded 3-day fixture (the Cloudflare gate refused the read-only query): hold and skip readings recorded and scored by the live code, n = hit + miss + neutral + pending per kind", async () => {
  const from = NOW - 3 * DAY - 6 * HOUR;
  const { bars, rnd } = walk(from, (NOW - from) / M1, 19);
  const closeAt = (t) => bars[Math.floor((t - from) / M1)].c;
  // A stop move every ~2.5 h: half the ladder's lock, half SL+; the stop 0.3 to 3.0 below (long) or above (short) price.
  const intents = [];
  for (let t = NOW - 3 * DAY + 20 * M1, k = 0; t < NOW - 10 * M1; t += 150 * M1, k += 1) {
    const side = k % 3 === 2 ? -1 : 1, gap = 0.3 + rnd() * 2.7, sl = Math.round((closeAt(t) - side * gap) * 100) / 100;
    intents.push({ id: `ms:${100 + k}:${k % 2 ? "k" : "lad"}:${Math.round(sl * 100)}`, payload: { ticket: 100 + k, sl, reason: k % 2 ? "sl_key_level_normal" : "ladder_lock_tp2", level_source: "liquidity" }, created_ms: t });
  }
  // One move 20 minutes ago, its stop well away: still inside its window (pending).
  { const t = NOW - 20 * M1, sl = Math.round((closeAt(t) - 6) * 100) / 100; intents.push({ id: `ms:199:k:${Math.round(sl * 100)}`, payload: { ticket: 199, sl, reason: "sl_key_level_normal", level_source: "liquidity" }, created_ms: t }); }
  // Skips with lens B's reason: every 6 h, both rule shapes, v4 results lost / won / flat / skipped / missing in turn.
  const skips = [], ledger = [], results = [-1, 1.2, 0, "skipped", null];
  for (let t = Math.ceil((NOW - 3 * DAY) / M15) * M15, k = 0; t < NOW - HOUR; t += 6 * HOUR, k += 1) {
    const side = k % 2 ? "SELL" : "BUY";
    skips.push({ id: `ec:${k}`, at_ms: t + 4000, issued_ms: t, side, rule: k % 2 ? "liquidity_sweep_against+liquidity_thin" : "council_skip:liquidity_sweep_against" });
    const r = results[k % results.length];
    if (r !== null) ledger.push({ key: `OANDA:XAUUSD:15:${t - M15}`, side, status: r === "skipped" ? "skipped" : "closed", r: r === "skipped" ? null : r });
  }
  const env = await world({ intents, skips, ledger, bars });
  const hold = await lensHoldStep(env, { now: NOW, mode: "intraday" });
  const skip = await recordSkipReadings(env, { now: NOW, mode: "intraday" });
  await scoreLedgerReadings(env, { now: NOW, skip: true });
  const tally = (kind) => { const t = { n: 0, hit: 0, miss: 0, neutral: 0, pending: 0 }; for (const r of readings(env, kind)) { t.n += 1; t[r.outcome ?? "pending"] += 1; } return t; };
  const byWhat = (what) => { const t = { n: 0, hit: 0, miss: 0, neutral: 0, pending: 0 }; for (const r of readings(env, "hold")) if (JSON.parse(r.detail_json).what === what) { t.n += 1; t[r.outcome ?? "pending"] += 1; } return t; };
  const report = { hold: tally("hold"), ladder: byWhat("ladder"), trail: byWhat("trail"), skip: tally("skip"), backfill: { hold: hold.added, skip: skip.added } };
  for (const k of ["hold", "ladder", "trail", "skip"]) assert.equal(report[k].n, report[k].hit + report[k].miss + report[k].neutral + report[k].pending, k);
  assert.equal(report.ladder.n + report.trail.n, report.hold.n);
  assert.equal(report.hold.n, intents.length, "one reading per stop move");
  assert.equal(report.skip.n, skips.length);
  assert.deepEqual(report, LR8);
});
/** LR-8's pinned result (the seeded fixture is fixed, so a change here is a change in the recording or the scoring). */
const LR8 = { hold: { n: 30, hit: 16, miss: 13, neutral: 0, pending: 1 }, ladder: { n: 15, hit: 9, miss: 6, neutral: 0, pending: 0 }, trail: { n: 15, hit: 7, miss: 7, neutral: 0, pending: 1 }, skip: { n: 12, hit: 3, miss: 3, neutral: 4, pending: 2 }, backfill: { hold: 30, skip: 12 } };
