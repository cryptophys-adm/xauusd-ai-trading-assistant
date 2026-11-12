import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  publishToPlatform, publishPlatformReports, platformStatus, platformEnabled, reasonerReport, moderatorReport, hudDigestReport,
  hudChangeMatters, hudTimeframeChange, readTimeframeOpenings, HUD_PLATFORM_IDS, HUD_HEARTBEAT_MS, PLATFORM_REPORT_TIMEOUT_MS, PLATFORM_CALL_TIMEOUT_MS,
  resetPlatformSchemaCacheForTests, resetWhoamiCacheForTests, PLATFORM_HOST_WORKER
} from "../src/platform-reports.mjs";

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

/** A fake AgentRpc binding that records calls and answers like the kernel. */
function kernel(answer = () => ({ outcome: "succeeded", capability: "reports.publish", tier: 1, decision_id: "dec_1", result: { report: { report_id: "rpt_1" } } })) {
  const calls = [];
  return {
    calls,
    async whoami(agentId) { calls.push({ whoami: agentId }); return { agent_id: agentId, status: "enabled", tier_max: 1, host_worker: PLATFORM_HOST_WORKER, capabilities: [{ capability: "reports.publish", tier: 1 }, { capability: "memory.remember", tier: 1 }, { capability: "memory.recall", tier: 0 }, { capability: "signals.observe", tier: 0 }] }; },
    async syscall(agentId, capability, input) { calls.push({ agentId, capability, input }); return answer(agentId, input); }
  };
}

const KEY = "OANDA:XAUUSD:60:1793894400000"; // 2026-11-05 16:00 UTC open
function room({ bar = "2026-11-05T17:15:00.000Z", stance = "WAIT", huds = {} } = {}) {
  const openings = [
    { id: "h1", name: "H1 Desk", status: "ok", stance: "WAIT", confidence: 0.3, claim: "x" },
    ...Object.entries(huds).map(([id, s]) => ({ id, name: id, status: "ok", stance: s, confidence: 0.35, claim: "HUD reads " + s }))
  ];
  return {
    bar_time: bar, h1: { decision: "WAIT" }, confirmations: { h1_prophet_r38: { buy_confirmed: false, sell_confirmed: false } },
    roster: openings.map(o => ({ id: o.id, calibration: { verified_lines: 0, total_lines: 3 } })),
    openings, conclusion: { status: "ok", stance, confidence: 0.7, summary: "H1 decision: WAIT, and the room agrees.", reasons: ["a", "b"], dissent: [], majority: stance }
  };
}

test("disabled without the AGENTS binding (preview, tests): nothing is sent", async () => {
  assert.equal(platformEnabled({}), false);
  assert.deepEqual(await publishPlatformReports({ DB: d1() }), { status: "disabled" });
  assert.deepEqual(await publishToPlatform({}, "xauusd-moderator", {}), { outcome: "disabled" });
  assert.deepEqual(await platformStatus({}), { enabled: false });
});

test("kernel answers map to success, denied (final), rejected (final) and failed (retryable)", async () => {
  assert.deepEqual(await publishToPlatform({ AGENTS: kernel() }, "a", {}), { outcome: "success", report_id: "rpt_1" });
  assert.deepEqual(await publishToPlatform({ AGENTS: kernel(() => ({ outcome: "denied", reason: "rate_limited" })) }, "a", {}), { outcome: "denied", reason: "rate_limited" });
  assert.deepEqual(await publishToPlatform({ AGENTS: kernel(() => ({ outcome: "failed", reason: "invalid_report_body" })) }, "a", {}), { outcome: "rejected", reason: "invalid_report_body" });
  const boom = { async syscall() { throw new Error("network"); } };
  assert.deepEqual(await publishToPlatform({ AGENTS: boom }, "a", {}), { outcome: "failed", reason: "rpc_failed" });
  const hang = { syscall: () => new Promise(() => {}) };
  assert.deepEqual(await publishToPlatform({ AGENTS: hang }, "a", {}, { timeoutMs: 10 }), { outcome: "failed", reason: "timeout" });
});

test("reports are advisory observations: no size, lots, levels or order wording; within the kernel limits", () => {
  const reports = [
    reasonerReport({ candle_key: KEY, decision: "BUY", confidence: 0.62, created_at: "2026-11-05 17:02:00" }, { last_stance: "SELL" }),
    moderatorReport(room(), null),
    hudDigestReport("Prophet", "change", [{ timeframe: "15", bar_close: "2026-11-05T17:15:00.000Z", stance: "BUY", previous_stance: "WAIT", bias: "BULLISH", previous_bias: "NEUTRAL", confidence: 0.35, changed: true, change_kind: "stance", claim: "c" }], null)
  ];
  for (const r of reports) {
    assert.ok(["xauusd_digest", "hud_digest"].includes(r.kind));
    assert.ok(["info", "warning"].includes(r.severity), "critical is never used: it opens a GitHub issue");
    assert.ok(r.subject.length > 0 && r.subject.length <= 200);
    assert.ok(new TextEncoder().encode(JSON.stringify(r.body)).byteLength <= 16 * 1024);
    const text = JSON.stringify(r).toLowerCase();
    for (const banned of ["position_size", "lot", "stop_loss", "take_profit", "entry_price", "buy now", "sell now", "secret", "token"]) assert.ok(!text.includes(banned), `${banned} must not appear`);
  }
  assert.equal(reports[0].severity, "warning", "a BUY<->SELL flip is a warning");
  assert.match(reports[0].subject, /^H1 decision BUY, confidence 0\.62 \(OANDA:XAUUSD H1 candle 16:00 UTC\), flipped from SELL$/);
  assert.equal(reasonerReport({ candle_key: KEY, decision: "WAIT", confidence: 0.3 }, { last_stance: "BUY" }).severity, "info");
  assert.equal(reports[2].kind, "hud_digest");
});

test("HUD changes matter only into or out of BUY/SELL", () => {
  assert.equal(hudChangeMatters("WAIT", "BUY"), true);
  assert.equal(hudChangeMatters("SELL", "WAIT"), true);
  assert.equal(hudChangeMatters("WAIT", "HOLD"), false);
  assert.equal(hudChangeMatters("WAIT", "WAIT"), false);
  // 13 until 2026-11-11; R37 Funnel, GABFX Price Action and Playbook Execution were dismantled (platform 0047).
  assert.equal(Object.keys(HUD_PLATFORM_IDS).length, 10);
  for (const gone of ["r37_funnel", "gabfx_price_action", "playbook_execution", "grid_bot_protocol"]) assert.equal(HUD_PLATFORM_IDS[gone], undefined, gone);
  for (const id of Object.values(HUD_PLATFORM_IDS)) assert.match(id, /^hud-[a-z0-9-]+$/);
});

test("the sweep publishes each event once: new H1 decision, room conclusion (change or hourly), HUD directional changes", async () => {
  resetPlatformSchemaCacheForTests();
  const DB = d1();
  const AGENTS = kernel();
  const env = { DB, AGENTS };
  DB.raw.prepare("INSERT INTO trade_decisions (candle_key, decision, confidence) VALUES (?, 'WAIT', 0.3)").run(KEY);
  const t0 = Date.parse("2026-11-05T17:25:00Z");

  // First sweep: reasoner + moderator publish; HUD agents only record a baseline.
  let r = await publishPlatformReports(env, { now: t0, readRoom: async () => room({ huds: { prophet: "WAIT", fabio_amt: "WAIT" } }) });
  assert.deepEqual(r.published.map(p => p.agent_id).sort(), ["xauusd-moderator", "xauusd-reasoner"]);
  assert.equal(AGENTS.calls.length, 2);
  assert.ok(AGENTS.calls.every(c => c.capability === "reports.publish"));

  // Same state again: nothing.
  r = await publishPlatformReports(env, { now: t0 + 60_000, readRoom: async () => room({ huds: { prophet: "WAIT", fabio_amt: "WAIT" } }) });
  assert.deepEqual(r.published, []);

  // Next bar, same WAIT conclusion within the hour: moderator stays quiet; Prophet HUD turns BUY.
  r = await publishPlatformReports(env, { now: t0 + 15 * 60_000, readRoom: async () => room({ bar: "2026-11-05T17:30:00.000Z", huds: { prophet: "BUY", fabio_amt: "HOLD" } }) });
  assert.deepEqual(r.published.map(p => p.agent_id), ["hud-prophet"]);
  const hudCall = AGENTS.calls.at(-1);
  assert.equal(hudCall.input.kind, "hud_digest");
  assert.equal(hudCall.input.body.timeframes[0].previous_stance, "WAIT");
  assert.equal(DB.raw.prepare("SELECT last_stance FROM platform_hud_cursors WHERE agent_id = 'hud-fabio-amt-sensors' AND timeframe = '15'").get().last_stance, "HOLD", "a non-directional move updates the cursor silently");

  // The conclusion changes: the moderator publishes at once.
  r = await publishPlatformReports(env, { now: t0 + 30 * 60_000, readRoom: async () => room({ bar: "2026-11-05T17:45:00.000Z", stance: "SELL", huds: { prophet: "BUY" } }) });
  assert.deepEqual(r.published.map(p => p.agent_id), ["xauusd-moderator"]);

  // A new H1 decision: the reasoner publishes; an unchanged conclusion an hour later is the heartbeat.
  DB.raw.prepare("INSERT INTO trade_decisions (candle_key, decision, confidence) VALUES (?, 'SELL', 0.6)").run("OANDA:XAUUSD:60:1793898000000");
  r = await publishPlatformReports(env, { now: t0 + 90 * 60_000, readRoom: async () => room({ bar: "2026-11-05T18:45:00.000Z", stance: "SELL", huds: { prophet: "BUY" } }) });
  assert.deepEqual(r.published.map(p => p.agent_id).sort(), ["xauusd-moderator", "xauusd-reasoner"]);
});

test("a denial advances the cursor (no retry loop); a transport failure is retried by the next sweep", async () => {
  resetPlatformSchemaCacheForTests();
  const DB = d1();
  DB.raw.prepare("INSERT INTO trade_decisions (candle_key, decision, confidence) VALUES (?, 'WAIT', 0.3)").run(KEY);
  const noRoom = async () => null;

  const denied = kernel(() => ({ outcome: "denied", reason: "agents_disabled" }));
  let r = await publishPlatformReports({ DB, AGENTS: denied }, { readRoom: noRoom });
  assert.deepEqual(r.published, [{ agent_id: "xauusd-reasoner", outcome: "denied", reason: "agents_disabled" }]);
  r = await publishPlatformReports({ DB, AGENTS: denied }, { readRoom: noRoom });
  assert.deepEqual(r.published, [], "kill switch: not asked again for the same decision");

  resetPlatformSchemaCacheForTests();
  const DB2 = d1();
  DB2.raw.prepare("INSERT INTO trade_decisions (candle_key, decision, confidence) VALUES (?, 'WAIT', 0.3)").run(KEY);
  const down = { async syscall() { throw new Error("kernel down"); } };
  r = await publishPlatformReports({ DB: DB2, AGENTS: down }, { readRoom: noRoom });
  assert.deepEqual(r.published, [{ agent_id: "xauusd-reasoner", outcome: "failed", reason: "rpc_failed" }]);
  const ok = kernel();
  r = await publishPlatformReports({ DB: DB2, AGENTS: ok }, { readRoom: noRoom });
  assert.deepEqual(r.published, [{ agent_id: "xauusd-reasoner", outcome: "success" }]);
});

test("platformStatus reads whoami once per 5 minutes and lists the publications", async () => {
  resetPlatformSchemaCacheForTests();
  resetWhoamiCacheForTests();
  const AGENTS = kernel();
  const s = await platformStatus({ DB: d1(), AGENTS }, { now: 1 });
  assert.equal(s.enabled, true);
  assert.deepEqual(s.whoami, { agent_id: "xauusd-moderator", status: "enabled", tier_max: 1, host_worker: PLATFORM_HOST_WORKER, capabilities: ["reports.publish", "memory.remember", "memory.recall", "signals.observe"] });
  assert.deepEqual(s.publications, []);
  await platformStatus({ DB: d1(), AGENTS }, { now: 2 });
  assert.equal(AGENTS.calls.filter(c => c.whoami).length, 1);
});

// ------------------------------------------------------------------ HUD agents on every timeframe (owner 2026-11-12)

const op = (id, stance, bias, claim = `${id} reads ${stance}/${bias}`) => ({ id, name: id, status: "ok", stance, bias, confidence: 0.4, claim });
const tfRoom = (bar_key, openings) => ({ bar_key, openings });
function hudEnv() { resetPlatformSchemaCacheForTests(); const DB = d1(); const AGENTS = kernel(); return { DB, AGENTS, env: { DB, AGENTS } }; }
const hudCalls = (AGENTS) => AGENTS.calls.filter((c) => c.capability === "reports.publish" && c.agentId.startsWith("hud-"));
const T0 = Date.parse("2026-11-12T10:20:00Z");

test("T1. hudTimeframeChange: a stance into or out of BUY/SELL, or a BULLISH<->BEARISH bias flip", () => {
  const c = (last_stance, last_bias) => ({ last_stance, last_bias });
  assert.deepEqual(hudTimeframeChange(c("WAIT", "BEARISH"), op("p", "BUY", "BEARISH")), { kind: "stance" });
  assert.deepEqual(hudTimeframeChange(c("WAIT", "BEARISH"), op("p", "WAIT", "BULLISH")), { kind: "bias" });
  assert.equal(hudTimeframeChange(c("WAIT", "BEARISH"), op("p", "WAIT", "NEUTRAL")), null, "NEUTRAL is no flip");
  assert.equal(hudTimeframeChange(c("WAIT", "BULLISH"), op("p", "WAIT", "BULLISH")), null);
  assert.equal(hudTimeframeChange(c("WAIT", null), op("p", "WAIT", "BULLISH")), null, "no directional bias seen yet");
  assert.equal(hudTimeframeChange(c("WAIT", "BULLISH"), op("p", "HOLD", "BULLISH")), null, "WAIT -> HOLD is not directional");
  assert.equal(hudTimeframeChange(null, op("p", "BUY", "BULLISH")), null, "no cursor: a baseline");
  assert.equal(hudTimeframeChange(c("WAIT", "BEARISH"), { ...op("p", "BUY", "BULLISH"), status: "failed" }), null);
});

test("T2. a bias flip on the 1H room alone publishes one change report; the same state again publishes nothing", async () => {
  const { AGENTS, env } = hudEnv();
  const tfs = (bias, run) => async () => ({ "60": tfRoom(run, [op("prophet", "WAIT", bias)]), "240": null, "1D": null });
  const noRoom = async () => null;
  await publishPlatformReports(env, { now: T0, readRoom: noRoom, readTimeframes: tfs("BEARISH", "2026-11-12T09:00:00.000Z") });
  assert.equal(hudCalls(AGENTS).length, 0, "first sight is a baseline");
  await publishPlatformReports(env, { now: T0 + 3_600_000, readRoom: noRoom, readTimeframes: tfs("BULLISH", "2026-11-12T10:00:00.000Z") });
  const calls = hudCalls(AGENTS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "hud-prophet");
  assert.equal(calls[0].input.kind, "hud_digest");
  assert.equal(calls[0].input.body.event, "change");
  const h1 = calls[0].input.body.timeframes.find((t) => t.timeframe === "60");
  assert.deepEqual({ changed: h1.changed, change_kind: h1.change_kind, previous_bias: h1.previous_bias, bias: h1.bias }, { changed: true, change_kind: "bias", previous_bias: "BEARISH", bias: "BULLISH" });
  assert.match(calls[0].input.subject, /1H bias BEARISH to BULLISH/);
  await publishPlatformReports(env, { now: T0 + 3_600_000 + 15 * 60_000, readRoom: noRoom, readTimeframes: tfs("BULLISH", "2026-11-12T10:00:00.000Z") });
  assert.equal(hudCalls(AGENTS).length, 1, "nothing new");
});

test("T3. a heartbeat with the reading on every timeframe after 6 hours without a report; a fresh baseline waits", async () => {
  const { DB, AGENTS, env } = hudEnv();
  const readTimeframes = async () => ({ "60": tfRoom("2026-11-12T09:00:00.000Z", [op("prophet", "WAIT", "BULLISH"), op("tactical_muscles", "WAIT", "NEUTRAL")]), "240": tfRoom("2026-11-12T04:00:00.000Z", [op("prophet", "WAIT", "BEARISH")]), "1D": null });
  const readRoom = async () => ({ ...room({ bar: "2026-11-12T10:00:00.000Z", huds: { prophet: "WAIT", tactical_muscles: "WAIT" } }), conclusion: null });
  DB.raw.prepare("INSERT INTO platform_publications (agent_id, last_stance, published_at, outcome, attempts, updated_at) VALUES ('hud-prophet', 'WAIT', ?, 'success', 4, ?)").run(new Date(T0 - 7 * 3_600_000).toISOString(), new Date(T0 - 7 * 3_600_000).toISOString());
  await publishPlatformReports(env, { now: T0, readRoom, readTimeframes });
  assert.equal(hudCalls(AGENTS).length, 0, "the first sweep only records the cursors");
  await publishPlatformReports(env, { now: T0 + 15 * 60_000, readRoom, readTimeframes });
  let calls = hudCalls(AGENTS);
  assert.deepEqual(calls.map((c) => c.agentId), ["hud-prophet"], "Tactical Muscles has no publication 6 hours old: it waits");
  assert.equal(calls[0].input.body.event, "heartbeat");
  assert.deepEqual(calls[0].input.body.timeframes.map((t) => t.timeframe), ["15", "60", "240"]);
  assert.ok(calls[0].input.body.timeframes.every((t) => t.changed === false));
  assert.match(calls[0].input.subject, /^Prophet reading: 15m WAIT\/.*1H WAIT\/bullish, 4H WAIT\/bearish/);
  await publishPlatformReports(env, { now: T0 + 30 * 60_000, readRoom, readTimeframes });
  assert.equal(hudCalls(AGENTS).length, 1, "the heartbeat moved the reference");
  await publishPlatformReports(env, { now: T0 + 15 * 60_000 + HUD_HEARTBEAT_MS, readRoom, readTimeframes });
  calls = hudCalls(AGENTS);
  assert.deepEqual(calls.slice(1).map((c) => [c.agentId, c.input.body.event]).sort(), [["hud-prophet", "heartbeat"], ["hud-tactical-muscles", "heartbeat"]]);
});

test("T4. one report per agent per sweep, listing every timeframe that changed", async () => {
  const { AGENTS, env } = hudEnv();
  const state = (stance, bias, n) => ({
    readRoom: async () => ({ ...room({ bar: `2026-11-12T10:${n}:00.000Z` }), openings: [op("prophet", stance, bias)], conclusion: null }),
    readTimeframes: async () => ({ "60": tfRoom(`h1-${n}`, [op("prophet", "WAIT", bias)]), "240": tfRoom(`h4-${n}`, [op("prophet", "WAIT", bias)]), "1D": tfRoom("d1", [op("prophet", "WAIT", "NEUTRAL")]) })
  });
  await publishPlatformReports(env, { now: T0, ...state("WAIT", "BEARISH", "00") });
  await publishPlatformReports(env, { now: T0 + 15 * 60_000, ...state("SELL", "BULLISH", "15") });
  const calls = hudCalls(AGENTS);
  assert.equal(calls.length, 1);
  const tfs = calls[0].input.body.timeframes;
  assert.deepEqual(tfs.filter((t) => t.changed).map((t) => [t.timeframe, t.change_kind]), [["15", "stance"], ["60", "bias"], ["240", "bias"]]);
  assert.equal(tfs.find((t) => t.timeframe === "1D").changed, false);
  assert.ok(Buffer.byteLength(JSON.stringify(calls[0].input.body)) < 16 * 1024);
});

test("T5. a failed publish keeps the cursors (retried next sweep); a denial advances them", async () => {
  resetPlatformSchemaCacheForTests();
  const DB = d1();
  let answer = () => ({ outcome: "succeeded", result: { report: { report_id: "r" } } });
  const AGENTS = kernel((...a) => answer(...a));
  const env = { DB, AGENTS };
  const noRoom = async () => null;
  const tfs = (bias, run) => async () => ({ "60": tfRoom(run, [op("prophet", "WAIT", bias)]) });
  await publishPlatformReports(env, { now: T0, readRoom: noRoom, readTimeframes: tfs("BEARISH", "a") });
  answer = () => { throw new Error("kernel down"); };
  let r = await publishPlatformReports(env, { now: T0 + 15 * 60_000, readRoom: noRoom, readTimeframes: tfs("BULLISH", "b") });
  assert.deepEqual(r.published, [{ agent_id: "hud-prophet", outcome: "failed", reason: "rpc_failed" }]);
  assert.equal(DB.raw.prepare("SELECT last_bias FROM platform_hud_cursors WHERE agent_id = 'hud-prophet' AND timeframe = '60'").get().last_bias, "BEARISH");
  answer = () => ({ outcome: "denied", reason: "rate_limited" });
  r = await publishPlatformReports(env, { now: T0 + 30 * 60_000, readRoom: noRoom, readTimeframes: tfs("BULLISH", "b") });
  assert.deepEqual(r.published, [{ agent_id: "hud-prophet", outcome: "denied", reason: "rate_limited" }], "the same change is sent again");
  assert.equal(DB.raw.prepare("SELECT last_bias FROM platform_hud_cursors WHERE agent_id = 'hud-prophet' AND timeframe = '60'").get().last_bias, "BULLISH");
  r = await publishPlatformReports(env, { now: T0 + 45 * 60_000, readRoom: noRoom, readTimeframes: tfs("BULLISH", "b") });
  assert.deepEqual(r.published, [], "a denial is final");
});

test("T6. readTimeframeOpenings reads the newest 1H, 4H and 1D rooms' openings, bias from the message body", async () => {
  resetPlatformSchemaCacheForTests();
  const DB = d1();
  const ins = DB.raw.prepare("INSERT INTO agent_thread_messages (thread_id, run_id, step, agent, stance, confidence, body_json, status, ts) VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', '2026-11-12T09:11:00.000Z')");
  ins.run("tf:H1", "2026-11-12T08:00:00.000Z", "open:prophet", "prophet", "WAIT", 0.3, JSON.stringify({ bias: "BEARISH", claim: "old" }));
  ins.run("tf:H1", "2026-11-12T09:00:00.000Z", "brief", "moderator", null, null, "{}");
  ins.run("tf:H1", "2026-11-12T09:00:00.000Z", "open:prophet", "prophet", "WAIT", 0.5, JSON.stringify({ bias: "BULLISH", claim: "new" }));
  ins.run("tf:H1", "2026-11-12T09:00:00.000Z", "conclusion", "moderator", "WAIT", 0.5, "{}");
  const r = await readTimeframeOpenings(DB);
  assert.equal(r["240"], null);
  assert.equal(r["1D"], null);
  assert.equal(r["60"].bar_key, "2026-11-12T09:00:00.000Z");
  assert.deepEqual(r["60"].openings, [{ id: "prophet", status: "ok", stance: "WAIT", bias: "BULLISH", confidence: 0.5, claim: "new" }]);
  const broken = await readTimeframeOpenings({ prepare() { throw new Error("no db"); } });
  assert.deepEqual(broken, { "60": null, "240": null, "1D": null }, "never throws");
});

test("T7. a report waits 15 s for the kernel (it stores the report after ~7 s at times); whoami keeps 5 s", async () => {
  assert.equal(PLATFORM_REPORT_TIMEOUT_MS, 15_000);
  assert.equal(PLATFORM_CALL_TIMEOUT_MS, 5_000);
  const slow = { syscall: () => new Promise((resolve) => setTimeout(() => resolve({ outcome: "succeeded", result: { report: { report_id: "late" } } }), 60)) };
  assert.deepEqual(await publishToPlatform({ AGENTS: slow }, "hud-prophet", {}, { timeoutMs: 20 }), { outcome: "failed", reason: "timeout" });
  assert.deepEqual(await publishToPlatform({ AGENTS: slow }, "hud-prophet", {}), { outcome: "success", report_id: "late" });
  const src = readFileSync(new URL("../src/platform-reports.mjs", import.meta.url), "utf8");
  assert.match(src, /timeoutMs = PLATFORM_REPORT_TIMEOUT_MS/);
  assert.match(src, /env\.AGENTS\.whoami\("xauusd-moderator"\)[\s\S]{0,200}PLATFORM_CALL_TIMEOUT_MS/);
});
