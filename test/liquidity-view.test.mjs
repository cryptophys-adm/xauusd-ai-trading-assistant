// B8 (Track B): GET /api/liquidity, the Nexus liquidity view (src/liquidity-view.mjs, cryptophys.liquidity-view.v1).
// test/fixtures/nexus-intel/liquidity.json is the Nexus Liquidity page's contract: the view's answer on the seeded
// environment (test/support/liquidity-view-seed.mjs) has its keys and types. Read-only: SELECTs and KV reads only, no
// account, login, server or identity anywhere; prices only with their scale. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readLiquidityView, backfillState, viewLevels, viewFacts, LIQUIDITY_VIEW_SCHEMA, BASELINE_HOURS } from "../src/liquidity-view.mjs";
import { readStrategyMemo, resetStrategyMemoForTests, intelViewsOn, STRATEGY_MEMO_MS } from "../src/intel-memo.mjs";
import { feedBasis as movedFeedBasis } from "../src/feed-basis.mjs";
import { feedBasis as signalFeedBasis } from "../src/ea-signal.mjs";
import { resetLensStateMemoForTests } from "../src/lens-policy.mjs";
import { seedLiquidityEnv, NOW, STRATEGY, REF, SERVER, SOURCE, LOGIN_HASH, BASIS, d1, kv } from "./support/liquidity-view-seed.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(root, "test/fixtures/nexus-intel", name), "utf8"));
const view = async (opts = {}, { strategy = STRATEGY } = {}) => { resetLensStateMemoForTests(); const env = await seedLiquidityEnv(opts); return { env, v: { status: "ok", ...(await readLiquidityView(env, { now: NOW, strategy })) } }; };

/** Asserts `got` has the keys and types of `want` at every depth: null on either side is a nullable value. */
function sameShape(got, want, path = "$") {
  if (got === null || want === null) return;
  if (Array.isArray(want)) {
    assert.ok(Array.isArray(got), `${path}: an array`);
    if (want.length) for (const [i, x] of got.entries()) sameShape(x, want[Math.min(i, want.length - 1)], `${path}[${i}]`);
    return;
  }
  if (typeof want === "object") {
    assert.equal(typeof got, "object", `${path}: an object`);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${path}: its keys`);
    for (const k of Object.keys(want)) sameShape(got[k], want[k], `${path}.${k}`);
    return;
  }
  assert.equal(typeof got, typeof want, `${path}: ${typeof want}`);
}
/** Every key at any depth. */
const keysIn = (o, out = []) => { if (Array.isArray(o)) o.forEach((x) => keysIn(x, out)); else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { out.push(k); keysIn(v, out); } return out; };

test("LV1. the fixture is the view's answer: keys and types, the outcomes and statuses the page reads, and the fields that wait for B15-B19", async () => {
  const main = fixture("liquidity.json"), down = fixture("liquidity-unavailable.json");
  const { v } = await view();
  sameShape(v, main);
  sameShape((await view({ available: false })).v, down);
  // Both fixtures are one contract: the same keys at every depth.
  sameShape(down, main);
  assert.equal(main.schema, LIQUIDITY_VIEW_SCHEMA);
  assert.equal(main.schema, "cryptophys.liquidity-view.v1");
  for (const k of ["state", "scale", "price", "atr_m15", "facts", "line", "conditions", "levels", "readings", "sweeps", "score", "effects", "card", "quorum_with_liquidity", "baseline", "management"]) assert.ok(k in main, k);
  assert.deepEqual(Object.keys(main.state).sort(), ["at_ms", "backfill", "baseline", "fresh", "mode", "on"]);
  assert.deepEqual(Object.keys(main.scale).sort(), ["basis_at", "feed_basis", "feed_basis_known"]);
  assert.deepEqual(Object.keys(main.effects).sort(), ["blocks", "deferrals", "level_moves", "makers", "pm_actions", "skips"]);
  assert.equal(typeof main.atr_m15, "number");
  // Levels: both scales and the Key Level Agent zone check.
  for (const l of main.levels) assert.deepEqual(Object.keys(l).sort(), ["high", "high_feed", "in_key_zone", "kind", "low", "low_feed"]);
  assert.ok(main.levels.some((l) => l.in_key_zone === true) && main.levels.some((l) => l.in_key_zone === false));
  for (const l of main.levels) assert.equal(Math.round((l.low - l.low_feed) * 100) / 100, BASIS, "feed = broker - feed_basis");
  // Sweeps: hit, miss, neutral and pending, whether each counts in the score, and the replayed ones.
  assert.deepEqual([...new Set(main.sweeps.map((s) => s.outcome))].sort(), ["hit", "miss", "neutral", "pending"]);
  for (const s of main.sweeps) { assert.equal(typeof s.scored, "boolean"); assert.equal(typeof s.replay, "boolean"); assert.equal(s.scored, s.outcome === "hit" || s.outcome === "miss"); }
  assert.ok(main.sweeps.some((s) => s.replay === true));
  // Effects: maker outcomes are scores (never filled/unfilled); deferrals carry no outcome.
  assert.deepEqual([...new Set(main.effects.makers.map((m) => m.outcome))].sort(), ["hit", "miss", "neutral"]);
  assert.ok(!JSON.stringify(main.effects.makers).match(/filled/));
  for (const d of main.effects.deferrals) assert.ok(!("outcome" in d));
  assert.ok(main.effects.blocks.length && main.effects.skips.length && main.effects.pm_actions.length && main.effects.deferrals.length);
  // Management: zones on both scales.
  assert.ok(main.management.length);
  for (const z of main.management) for (const k of ["low", "high", "low_feed", "high_feed"]) assert.ok(k in z, k);
  assert.ok(main.management.some((z) => z.source === "key_level") && main.management.some((z) => z.source === "liquidity"));
  // The backfill's status and the baseline's 168 hours.
  assert.ok(["done", "backfilled", "failed", "unavailable"].includes(main.state.backfill.status));
  assert.equal(main.baseline.hours.length, BASELINE_HOURS);
  assert.deepEqual(main.baseline.hours.map((h) => h.hour), Array.from({ length: 168 }, (_, h) => h));
  // No facts (no recent broker bar): a reason, no levels and no sweeps.
  assert.equal(down.facts.available, false);
  assert.ok(["archive_stale", "no_bars"].includes(down.facts.reason));
  assert.deepEqual([down.levels, down.sweeps], [[], []]);
  assert.equal(down.state.on, false, "no facts, so lens B is off for the signal");
  assert.ok(down.management.every((z) => z.source === "key_level"));
  // B19: level_moves are the hold readings (no price: side, mode, action, outcome); each skip carries its outcome.
  for (const f of [main, down, v]) {
    assert.ok(Array.isArray(f.effects.level_moves));
    for (const m of f.effects.level_moves) assert.deepEqual(Object.keys(m).sort(), ["action", "at_ms", "mode", "outcome", "side"]);
  }
  assert.deepEqual(main.effects.level_moves.map((m) => [m.action, m.outcome]), [["key_level_lock", "pending"], ["ladder_lock", "hit"]]);
  assert.deepEqual(main.effects.skips.map((x) => x.outcome), ["hit"]);
  assert.equal((await view({ env: { LENS_LEVEL_READINGS: "off" } })).v.effects.level_moves, null, "off: no level moves");
  // liquidity-level-readings-off.json is the seed's answer with the switch off, byte for byte: no skip or hold reading
  // recorded, so level_moves is null and the entry council's skip carries no outcome; pm_actions stays an array.
  const off = fixture("liquidity-level-readings-off.json");
  assert.deepEqual((await view({ env: { LENS_LEVEL_READINGS: "off" } })).v, off);
  sameShape(off, main);
  assert.equal(off.effects.level_moves, null);
  assert.ok(off.effects.skips.length && off.effects.skips.every((x) => x.outcome === null));
  assert.ok(Array.isArray(off.effects.pm_actions) && off.effects.pm_actions.length);
  // B16: the conditions the 15m and 1H rooms read (liquidityConditions), filled from the latest state; none without
  // available facts.
  assert.deepEqual(v.conditions, main.conditions);
  assert.deepEqual(Object.keys(main.conditions).sort(), ["activity", "at_ms", "baseline", "baseline_weeks", "depth", "in_rooms", "levels", "line", "mode", "room_line", "session", "spread", "stale"]);
  assert.deepEqual([main.conditions.in_rooms, main.conditions.room_line, main.conditions.stale, main.conditions.at_ms], [true, "conditions", false, main.state.at_ms]);
  for (const f of [down, (await view({ available: false })).v]) assert.equal(f.conditions, null);
  // B15: the card and the quorum with liquidity come from the latest decision's decision.liquidity; with no recent broker
  // bar the seeded decision had none, so both are null there.
  assert.deepEqual(Object.keys(main.card).sort(), ["agreeing", "at_ms", "bar_close", "counts", "lean", "lean_reason", "lens_weight", "side", "stale", "state_at_ms", "summary", "sweep", "sweep_age_min", "weight"]);
  assert.deepEqual(Object.keys(main.quorum_with_liquidity).sort(), ["bias", "long_met", "long_share", "met", "neutral_share", "quorum_min", "score", "share_needed_above", "short_met", "short_share"]);
  assert.deepEqual([main.card.counts, main.card.weight, main.card.lean, main.card.sweep, main.card.lean_reason], [false, 0.03, 0.6, "sell_side", "sweep_with_agreeing_witness"]);
  assert.deepEqual(v.card, main.card);
  assert.deepEqual(v.quorum_with_liquidity, main.quorum_with_liquidity);
  for (const f of [down, (await view({ available: false })).v]) assert.deepEqual([f.card, f.quorum_with_liquidity], [null, null]);
});

test("LV1b. B15: the card and the quorum with liquidity from the latest decision; no price-like number; stale after 15 minutes; none without decision.liquidity", async () => {
  const { viewCard, viewQuorumWithLiquidity } = await import("../src/liquidity-view.mjs");
  const main = fixture("liquidity.json");
  const { PRICE_LIKE } = await import("../src/public-projection.mjs");
  assert.doesNotMatch(main.card.summary, PRICE_LIKE);
  for (const k of keysIn({ card: main.card, q: main.quorum_with_liquidity })) assert.doesNotMatch(k, /price|entry|stop|target|level|zone|^tp|^sl$/i, k);
  const decided = Date.parse("2026-11-23T14:47:00Z");
  const d = { decided_at: new Date(decided).toISOString(), bar_close: "2026-11-23T14:45:00.000Z", liquidity: { card: { weight: 0.03, lean: -0.6, side: "BEARISH", sweep: "buy_side", sweep_age_min: 4, at_ms: decided - 60_000, lean_reason: "sweep_with_agreeing_witness", agreeing: ["H4"], summary: "x", lens_weight: 0.3 }, quorum_with_liquidity: { score: -0.2, bias: "BEARISH", long_share: 0.1, short_share: 0.7, neutral_share: 0.2, share_needed_above: 0.5, quorum_min: 0.5, long_met: false, short_met: true, met: true, witnesses: 9, weight: 1 } } };
  assert.deepEqual([viewCard(d, decided + 15 * 60_000).stale, viewCard(d, decided + 15 * 60_000 + 1).stale], [false, true]);
  assert.deepEqual([viewCard(d, decided).at_ms, viewCard(d, decided).state_at_ms, viewCard(d, decided).counts], [decided, decided - 60_000, false]);
  assert.equal(viewCard({ ...d, liquidity: { ...d.liquidity, card: { ...d.liquidity.card, sweep: "sweep_with" } } }, decided).sweep, null, "only a side names the sweep");
  assert.deepEqual(viewQuorumWithLiquidity(d), { score: -0.2, bias: "BEARISH", long_share: 0.1, short_share: 0.7, neutral_share: 0.2, share_needed_above: 0.5, quorum_min: 0.5, long_met: false, short_met: true, met: true });
  for (const x of [null, {}, { liquidity: null }, { liquidity: {} }]) assert.deepEqual([viewCard(x), viewQuorumWithLiquidity(x)], [null, null]);
});

test("LV2. without a known basis the feed's scale is null: low_feed, high_feed, in_key_zone; nothing manages (B17: lens B joins the management set only with a known basis)", async () => {
  const { v } = await view({ feed: false });
  assert.deepEqual(v.scale, { feed_basis: null, feed_basis_known: false, basis_at: null });
  assert.ok(v.levels.length);
  for (const l of v.levels) assert.deepEqual([l.low_feed, l.high_feed, l.in_key_zone], [null, null, null]);
  assert.deepEqual(v.management, [], "no Key Level zone without a basis, and lens B waits for one (B17)");
  assert.equal(v.atr_m15, null);
  assert.equal(v.price.feed, STRATEGY.price, "the strategy's price without the feed's 5m series");
  // Without the strategy memo, no zone check either (the levels stay).
  const bare = (await view({}, { strategy: null })).v;
  assert.ok(bare.levels.every((l) => l.in_key_zone === null && Number.isFinite(l.low_feed)));
  // Pure parts.
  assert.deepEqual(viewLevels([{ low: 4100, high: 4101, kind: "pool" }]), [{ kind: "pool", low: 4100, high: 4101, low_feed: null, high_feed: null, in_key_zone: null }]);
  assert.deepEqual(viewLevels([{ low: 4100, high: 4101, kind: "pool" }], { basis: 0.5, zones: [{ low: 4100.4, high: 4100.6 }] })[0], { kind: "pool", low: 4100, high: 4101, low_feed: 4099.5, high_feed: 4100.5, in_key_zone: true });
  assert.equal(viewFacts(null), null);
});

test("LV3. no account, login, server, source or identity in the answer or the fixtures (key or value)", async () => {
  const { v } = await view();
  for (const body of [v, fixture("liquidity.json"), fixture("liquidity-unavailable.json"), fixture("liquidity-level-readings-off.json")]) {
    for (const k of keysIn(body)) assert.doesNotMatch(k, /account|login|server|identity|ticket/i, k);
    const text = JSON.stringify(body);
    for (const secret of [REF, SERVER, SERVER.toLowerCase(), SOURCE, LOGIN_HASH, "acct_", "9001", "9002"]) assert.ok(!text.includes(secret), secret);
  }
});

test("LV4. the view reads only: SELECT statements, no KV write, no DDL; a table not created yet is empty; another D1 error fails", async () => {
  const { env, v } = await view();
  assert.ok(env.DB.seen.length > 5);
  for (const sql of env.DB.seen) assert.match(sql, /^\s*SELECT\b/i, sql);
  assert.deepEqual(env.SIGNAL_CACHE.puts, []);
  // A cold environment: no table and no KV record at all.
  resetLensStateMemoForTests();
  const cold = { DB: d1(), SIGNAL_CACHE: kv() };
  const c = await readLiquidityView(cold, { now: NOW, strategy: null });
  for (const sql of cold.DB.seen) assert.match(sql, /^\s*SELECT\b/i, sql);
  assert.deepEqual(cold.SIGNAL_CACHE.puts, []);
  assert.equal(cold.DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n, 0, "no table created");
  assert.deepEqual([c.facts, c.line, c.levels, c.readings, c.sweeps, c.management, c.effects.blocks, c.effects.skips, c.effects.deferrals, c.effects.pm_actions], [null, null, [], [], [], [], [], [], [], []]);
  assert.deepEqual([c.state.baseline, c.state.backfill.status, c.state.on, c.baseline.status, c.baseline.hours.length], ["unavailable", "unavailable", false, "unavailable", 168]);
  assert.equal(c.conditions, null, "B16: no state, no conditions");
  // A D1 failure that is not a missing table reaches the route (500 liquidity_unavailable).
  const broken = await seedLiquidityEnv();
  const prepare = broken.DB.prepare;
  broken.DB.prepare = (sql) => { if (/FROM lens_readings/.test(sql)) throw new Error("D1_ERROR: network connection lost"); return prepare(sql); };
  await assert.rejects(readLiquidityView(broken, { now: NOW, strategy: STRATEGY }), /network connection lost/);
});

test("LV5. the backfill's status: done, backfilled (copied, the rebuild pending), failed, unavailable", () => {
  assert.equal(backfillState().status, "unavailable");
  assert.equal(backfillState({ versions: [] }).status, "unavailable");
  assert.equal(backfillState({ versions: [92] }).status, "unavailable");
  assert.deepEqual(backfillState({ versions: [90, 92], marker: { status: "copied", at: "2026-11-22T19:00:00.000Z", added: 2419, rebuilt: true } }), { status: "done", at_ms: Date.parse("2026-11-22T19:00:00.000Z"), added: 2419, rebuilt: true });
  assert.equal(backfillState({ versions: [90, 92], marker: { status: "copied", added: 10, rebuilt: false } }).status, "backfilled");
  assert.equal(backfillState({ versions: [90, 92], marker: { status: "copying" } }).status, "backfilled");
  assert.deepEqual(backfillState({ versions: [90, 92], failed: { at: "2026-11-22T19:00:00.000Z" } }), { status: "failed", at_ms: Date.parse("2026-11-22T19:00:00.000Z"), added: null, rebuilt: null });
  assert.equal(backfillState({ versions: [90, 92], marker: { status: "copying" }, failed: { at: "x" } }).status, "failed");
  assert.equal(backfillState({ versions: [90, 92], marker: { status: "copied", rebuilt: true }, failed: { at: "x" } }).status, "done", "a later copy clears an earlier failure");
});

test("LV6. the strategy memo: read once per 60 s per isolate and binding pair, an unreadable strategy not kept; INTEL_VIEWS", async () => {
  resetStrategyMemoForTests();
  let calls = 0;
  const read = async () => { calls += 1; return { price: calls }; };
  const env = { DB: {}, SIGNAL_CACHE: {} };
  assert.deepEqual(await readStrategyMemo(env, { now: 0 + 1, read }), { price: 1 });
  assert.deepEqual(await readStrategyMemo(env, { now: STRATEGY_MEMO_MS, read }), { price: 1 });
  assert.deepEqual(await readStrategyMemo(env, { now: STRATEGY_MEMO_MS + 2, read }), { price: 2 });
  assert.deepEqual(await readStrategyMemo({ DB: {}, SIGNAL_CACHE: {} }, { now: STRATEGY_MEMO_MS + 3, read }), { price: 3 }, "another binding pair reads again");
  resetStrategyMemoForTests();
  const failing = async () => { calls += 1; throw new Error("boom"); };
  assert.equal(await readStrategyMemo(env, { now: 10, read: failing }), null);
  assert.equal(await readStrategyMemo(env, { now: 11, read: async () => null }), null);
  assert.deepEqual(await readStrategyMemo(env, { now: 12, read }), { price: calls }, "null is never kept");
  assert.deepEqual([intelViewsOn({}), intelViewsOn(null), intelViewsOn({ INTEL_VIEWS: "on" }), intelViewsOn({ INTEL_VIEWS: " OFF " }), intelViewsOn({ INTEL_VIEWS: "x" })], [true, true, true, false, true]);
  assert.match(readFileSync(join(root, "wrangler.jsonc"), "utf8"), /"INTEL_VIEWS": "on"/);
});

test("LV7. feedBasis moved to src/feed-basis.mjs; src/ea-signal.mjs re-exports the same function", () => {
  assert.equal(signalFeedBasis, movedFeedBasis);
  const broker = [0, 1, 2, 3].map((i) => ({ t: Date.parse("2026-11-23T10:04:00Z") + i * 300_000, c: 4100 + i + 0.5 }));
  const feed = [0, 1, 2, 3].map((i) => ({ close_time: new Date(Date.parse("2026-11-23T10:05:00Z") + i * 300_000).toISOString(), close: 4100 + i }));
  assert.equal(movedFeedBasis(broker, feed), 0.5);
});

async function bundle(entry) {
  const out = await build({ entryPoints: [join(root, entry)], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent", alias: { "cloudflare:workers": join(root, "test/support/cloudflare-workers-stub.mjs") } });
  const dir = await mkdtemp(join(tmpdir(), "lv-"));
  const file = join(dir, "worker.mjs");
  await writeFile(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  await rm(dir, { recursive: true, force: true });
  return mod.default;
}

test("LV8. the route: 200 no-store through the AI Worker and Nexus's proxy (GET only, POST 405); INTEL_VIEWS off 404; a D1 failure 500 liquidity_unavailable", async () => {
  const worker = await bundle("src/index.ts");
  const nexus = await bundle("workers/xauusd-nexus-dashboard/src/index.ts");
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const env = await seedLiquidityEnv();
  const r = await worker.fetch(new Request("https://worker.test/api/liquidity"), env, ctx);
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(body.status, "ok");
  assert.equal(body.schema, "cryptophys.liquidity-view.v1");
  assert.equal(body.state.backfill.status, "done");
  // Nexus forwards the GET over its AI_WORKER binding and the AI Worker's no-store stands; a POST never leaves Nexus.
  const seen = [];
  const AI_WORKER = { async fetch(req) { seen.push([req.method, new URL(req.url).pathname]); return worker.fetch(req, env, ctx); } };
  const p = await nexus.fetch(new Request("https://nexus.test/api/liquidity"), { AI_WORKER });
  assert.equal(p.status, 200);
  assert.equal(p.headers.get("cache-control"), "no-store");
  assert.equal((await p.json()).schema, "cryptophys.liquidity-view.v1");
  assert.equal((await nexus.fetch(new Request("https://nexus.test/api/liquidity", { method: "POST", body: "{}" }), { AI_WORKER })).status, 405);
  assert.deepEqual(seen, [["GET", "/api/liquidity"]]);
  // The off switch.
  const off = await worker.fetch(new Request("https://worker.test/api/liquidity"), { ...env, INTEL_VIEWS: "off" }, ctx);
  assert.equal(off.status, 404);
  assert.deepEqual(await off.json(), { status: "not_found", reason: "intel_views_off" });
  // A failing D1 read.
  const broken = await seedLiquidityEnv();
  const prepare = broken.DB.prepare;
  broken.DB.prepare = (sql) => { if (/FROM liquidity_readings/.test(sql)) throw new Error("D1_ERROR: boom"); return prepare(sql); };
  const e = await worker.fetch(new Request("https://worker.test/api/liquidity"), broken, ctx);
  assert.equal(e.status, 500);
  assert.deepEqual(await e.json(), { status: "error", error: "liquidity_unavailable" });
});
