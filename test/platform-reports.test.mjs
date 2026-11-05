import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  publishToPlatform, publishPlatformReports, platformStatus, platformEnabled, reasonerReport, moderatorReport, hudReport,
  hudChangeMatters, HUD_PLATFORM_IDS, resetPlatformSchemaCacheForTests, resetWhoamiCacheForTests, PLATFORM_HOST_WORKER
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
function kernel(answer = () => ({ outcome: "succeeded", result: { report_id: "rpt_1" } })) {
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
    hudReport(room({ huds: { prophet: "BUY" } }), { id: "prophet", name: "Prophet", stance: "BUY", confidence: 0.35, claim: "c" }, "WAIT", null)
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
  assert.equal(Object.keys(HUD_PLATFORM_IDS).length, 13);
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
  assert.equal(hudCall.input.body.previous_stance, "WAIT");
  assert.equal(DB.raw.prepare("SELECT last_stance FROM platform_publications WHERE agent_id = 'hud-fabio-amt-sensors'").get().last_stance, "HOLD", "a non-directional move updates the baseline silently");

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
