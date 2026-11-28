// B14 (Track B): GET /api/orb, the Nexus ORB view (src/orb-view.mjs, cryptophys.orb-view.v1).
// test/fixtures/nexus-intel/orb.json is the Nexus ORB page's (C4) contract: the view's answer on the seeded environment
// (test/support/orb-view-seed.mjs). Read-only: SELECTs and KV reads only, no DDL; no account, login, server or identity;
// every price the feed's; never a public route. The rules are the agent's own (openingRanges, orbWidthStatus,
// rangeBreakout). No network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readOrbView, sessionCard, nextRange, ORB_VIEW_SCHEMA, RECENT_SESSIONS } from "../src/orb-view.mjs";
import { openingRanges } from "../src/opening-range.mjs";
import { STRATEGY_AGENTS, AGENT_RULES, agentContext, orbWidthStatus } from "../src/strategy-agents.mjs";
import { publicAnalysis } from "../src/public-analysis.mjs";
import { seedOrbEnv, orbBars, STRATEGY, PLAN, NOW, LDN, d1 } from "./support/orb-view-seed.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = () => JSON.parse(readFileSync(join(root, "test/fixtures/nexus-intel/orb.json"), "utf8"));
const view = async (seed = {}, opts = {}) => { const env = await seedOrbEnv(seed); return { env, v: { status: "ok", ...(await readOrbView(env, { now: NOW, strategy: STRATEGY, ...opts })) } }; };
const keysIn = (o, out = []) => { if (Array.isArray(o)) o.forEach((x) => keysIn(x, out)); else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { out.push(k); keysIn(v, out); } return out; };
const M15 = 15 * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const series = (from, to, at = {}) => { const out = []; for (let t = from; t < to; t += M15) { const [high, low, close] = at[t] ?? [2602, 2598, 2600]; out.push({ open_time: iso(t), close_time: iso(t + M15), open: close, high, low, close }); } return out; };

test("ORV1. the fixture is the view's answer, key for key: the C4 tree", async () => {
  const { v } = await view();
  assert.deepEqual(v, fixture());
  assert.equal(v.schema, ORB_VIEW_SCHEMA);
  assert.deepEqual(Object.keys(v), ["status", "schema", "mode", "levels_mode", "scale", "rules", "price", "atr_h1", "atr_m15", "bar_close", "market", "decision", "overlap", "sessions", "records", "recent"]);
  assert.deepEqual(v.scale, { prices: "feed", symbol: "OANDA:XAUUSD" });
  assert.deepEqual(Object.keys(v.sessions), ["london", "new_york"]);
  for (const s of Object.values(v.sessions)) assert.deepEqual(Object.keys(s), ["variant", "date_ny", "open_ms", "range_end_ms", "end_ms", "phase", "bars_built", "bars_left", "status", "status_detail", "high", "low", "mid", "width", "width_atr", "breakout", "invalidated", "events_in_range", "edges_in_zones", "plans"]);
  // London: formed, broke up, retesting the high, its long plan picked by the decision; the high sits in a key zone.
  const l = v.sessions.london;
  assert.deepEqual([l.phase, l.status, l.high, l.low, l.width_atr, l.breakout.side, l.breakout.state, l.plans.long.picked, l.plans.long.entry_type, l.plans.short], ["live", "ok", 2605, 2595, 1.25, "long", "retesting", true, "at_level", null]);
  assert.deepEqual(l.edges_in_zones, [{ edge: "high", low: 2604.5, high: 2606, candidate: true }]);
  assert.equal(l.plans.long.lapse_ms, PLAN.valid_until_ms);
  // New York (yesterday's, over): a release inside its range; only the USD high-impact release counts.
  assert.deepEqual([v.sessions.new_york.phase, v.sessions.new_york.status, v.sessions.new_york.events_in_range.map((e) => e.title)], ["over", "range_event", ["Retail sales"]]);
  assert.deepEqual(v.overlap, { long: "london", short: null });
  assert.deepEqual(v.records.london.held_by_breaker, true, "16 setups below 0R: the breaker holds London");
  assert.deepEqual(v.recent.map((x) => [x.session, x.side, x.exit, x.r]), [["london", "long", null, null], ["london", "long", "stop", -1], ["new_york", "short", "target_before_entry", 0]]);
  assert.equal(RECENT_SESSIONS, 10);
  assert.deepEqual(v.rules, { range_bars: 3, min_width_atr: AGENT_RULES.orb.min_width_atr, max_width_atr: AGENT_RULES.orb.max_width_atr, beyond_atr: AGENT_RULES.breakout.beyond_atr, retest_atr: AGENT_RULES.breakout.retest_atr, pad_atr: AGENT_RULES.pad_atr });
  assert.equal(v.market.next_range.session, "new_york");
});

test("ORV2. the rules are the agent's: the sessions equal openingRanges on the same bars; the 2026-03-16 London clock mismatch", async () => {
  const bars = orbBars();
  const ranges = openingRanges(bars, { now: Date.parse(bars.at(-1).close_time) });
  const { v } = await view();
  const london = ranges.find((r) => r.key === "orb_london");
  assert.deepEqual([v.sessions.london.open_ms, v.sessions.london.range_end_ms, v.sessions.london.end_ms, v.sessions.london.high, v.sessions.london.low], [london.open_ms, london.range_end_ms, london.end_ms, london.high, london.low]);
  const open = Date.UTC(2026, 2, 16, 7, 0);
  const mm = series(open - 4 * M15, open + 8 * M15);
  const r = openingRanges(mm)[0];
  const card = sessionCard(r, { bars: mm, at: Date.parse(mm.at(-1).close_time), atrH1: 8 });
  assert.deepEqual([card.status, card.status_detail.includes("changed clocks")], ["session_clock_mismatch", true]);
  // Width: the view and the agent read one helper.
  const wide = { ...london, width: 10 };
  assert.deepEqual([orbWidthStatus(wide, 8), orbWidthStatus(wide, 50), orbWidthStatus(wide, 2), orbWidthStatus({}, 8)], ["ok", "too_narrow", "too_wide", null]);
  assert.equal(sessionCard(london, { bars, at: Date.parse(bars.at(-1).close_time), atrH1: 2 }).status, "too_wide");
  assert.equal(nextRange(NOW).session, "new_york");
});

test("ORV3. orbWidthStatus refactor: the agent's plans are byte-identical to the inline rule it replaced", () => {
  const orb = STRATEGY_AGENTS.find((a) => a.id === "orb_breakout");
  const O = AGENT_RULES.orb;
  // The rule before the refactor, inline: skip a range under min or over max width.
  const before = (r, atr) => !(r.width < O.min_width_atr * atr || r.width > O.max_width_atr * atr);
  for (const atr of [1, 2, 2.857, 2.86, 3, 8, 10, 39.9, 40, 40.1, 60]) {
    assert.equal(orbWidthStatus({ width: 10 }, atr) === "ok", before({ width: 10 }, atr), `atr ${atr}`);
    const ctx = { ...agentContext({ bars: orbBars() }), price: 2605.5, atr, levels: [{ low: 2629, high: 2631, price: 2630, major: true }, { low: 2569, high: 2571, price: 2570, major: true }] };
    const p = orb.plan(1, ctx);
    if (!before({ width: 10 }, atr)) assert.equal(p, null, `atr ${atr}: out of the band, no plan`);
  }
  // The pinned plan at the seed's ATR (taken before the refactor, the same bars and levels).
  assert.deepEqual([PLAN.agent, PLAN.pattern, PLAN.entry, PLAN.stop, PLAN.at_level], ["orb_breakout", "orb_london", 2605.5, 2599.2, true]);
});

test("ORV4. read-only: SELECTs and KV reads only; no account, login, server or identity key; the feed's prices", async () => {
  const env = await seedOrbEnv();
  const prepare = env.DB.prepare;
  const seen = [];
  env.DB.prepare = (sql) => { seen.push(sql); if (/^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|REPLACE)\b/i.test(sql)) throw new Error(`refused: ${sql.slice(0, 40)}`); return prepare(sql); };
  const puts = env.SIGNAL_CACHE.puts.length;
  const v = await readOrbView(env, { now: NOW, strategy: STRATEGY });
  assert.ok(seen.length >= 1 && seen.every((s) => /^\s*SELECT\b/i.test(s)), seen.join(" | "));
  assert.equal(env.SIGNAL_CACHE.puts.length, puts, "no KV write");
  const keys = keysIn(v);
  for (const bad of ["account", "account_ref", "login", "server", "broker", "identity", "balance", "equity", "lots", "volume"]) assert.ok(!keys.includes(bad), bad);
  // A cold D1: no table yet reads as empty.
  const cold = await seedOrbEnv();
  cold.DB = d1();
  const c = await readOrbView(cold, { now: NOW, strategy: STRATEGY });
  assert.deepEqual(c.recent, []);
  // The decision from D1 when KV has none.
  const { v: fromDb } = await view({ decisionInKv: false });
  assert.equal(fromDb.sessions.london.plans.long.picked, true);
});

test("ORV5. the switches: orb_breakout off reads mode off (the sessions still read); ORB_LEVELS off; INTEL_VIEWS off answers 404", async () => {
  const { v } = await view({ env: { STRATEGY_AGENTS_OFF: "orb_breakout" } });
  assert.deepEqual([v.mode, v.levels_mode, v.sessions.london.status], ["off", "off", "ok"]);
  const { v: lv } = await view({ env: { ORB_LEVELS: "off" } });
  assert.deepEqual([lv.mode, lv.levels_mode], ["on", "off"]);
});

async function bundle(entry) {
  const out = await build({ entryPoints: [join(root, entry)], bundle: true, format: "esm", platform: "browser", conditions: ["workerd", "worker", "browser"], write: false, logLevel: "silent", alias: { "cloudflare:workers": join(root, "test/support/cloudflare-workers-stub.mjs") } });
  const dir = await mkdtemp(join(tmpdir(), "orb-"));
  const file = join(dir, "worker.mjs");
  await writeFile(file, out.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  await rm(dir, { recursive: true, force: true });
  return mod.default;
}

test("ORV6. the route: 200 no-store, INTEL_VIEWS off 404, a D1 failure 500 orb_unavailable; never on a public route", async () => {
  const worker = await bundle("src/index.ts");
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const env = await seedOrbEnv();
  const r = await worker.fetch(new Request("https://worker.test/api/orb"), env, ctx);
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual([body.status, body.schema], ["ok", "cryptophys.orb-view.v1"]);
  const off = await worker.fetch(new Request("https://worker.test/api/orb"), { ...env, INTEL_VIEWS: "off" }, ctx);
  assert.equal(off.status, 404);
  const broken = await seedOrbEnv();
  const prepare = broken.DB.prepare;
  broken.DB.prepare = (sql) => { if (/FROM plan_setups/.test(sql)) throw new Error("D1_ERROR: boom"); return prepare(sql); };
  const e = await worker.fetch(new Request("https://worker.test/api/orb"), broken, ctx);
  assert.equal(e.status, 500);
  assert.deepEqual(await e.json(), { status: "error", error: "orb_unavailable" });
  // Never public: no /api/public* path answers the view, and the public analysis carries none of it.
  for (const path of ["/api/public/orb", "/api/public-orb", "/api/public-projection/orb"]) {
    const p = await worker.fetch(new Request(`https://worker.test${path}`), env, ctx);
    const text = await p.text();
    assert.ok(!text.includes("cryptophys.orb-view.v1") && !text.includes("opening range"), `${path}: ${p.status}`);
  }
  const pub = JSON.stringify(await worker.fetch(new Request("https://worker.test/api/public-projection"), env, ctx).then((x) => x.text()));
  assert.ok(!pub.includes("orb-view") && !pub.includes("orb_london"));
  const analysis = JSON.stringify(publicAnalysis(STRATEGY.key_levels, { now: NOW }));
  assert.ok(!analysis.includes("orb") && !analysis.includes("opening range"));
});

test("ORV7. /api/strategy-agents: orb_breakout's variants in the catalogue, its per-session records under record.patterns, the held session", async () => {
  const { agentCatalog, suspendedPatterns } = await import("../src/strategy-agents.mjs");
  const orb = agentCatalog(null).find((a) => a.id === "orb_breakout");
  assert.deepEqual(orb.variants, [{ id: "orb_london", name: "London opening range" }, { id: "orb_new_york", name: "New York opening range" }]);
  assert.equal(agentCatalog(null).filter((a) => a.variants).length, 1, "only orb_breakout");
  const records = [{ agent: "orb_breakout", patterns: [{ pattern: "orb_london", setups: 16, mean_r: -0.2 }, { pattern: "orb_new_york", setups: 4, mean_r: 0.3 }] }];
  assert.deepEqual(suspendedPatterns(records), [{ id: "orb_london", agent: "orb_breakout", setups: 16, mean_r: -0.2 }]);
});
