// The agent inventory and the AI logic matrix are generated from the code (owner 2026-11-15, items a/P4): this
// test keeps them equal to the room rosters and to organism.json, so a new seat or AI task cannot ship unlisted.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { agentRoster, agentInventory, aiLogic, ENGINE_LOGIC, ROOMS, INVENTORY_SCHEMA, INVENTORY_HREF, AI_LOGIC_SCHEMA, meterLabels } from "../src/agent-inventory.mjs";
import { DESK_AGENTS } from "../src/war-room.mjs";
import { TF_DESKS } from "../src/timeframe-threads.mjs";
import { MACRO_AGENTS } from "../src/macro-room.mjs";
import { hudAgentsIn } from "../src/hud-reading.mjs";
import { HUD_PLATFORM_IDS } from "../src/platform-reports.mjs";
import { organismDna } from "../src/organism.mjs";

const DNA = JSON.parse(readFileSync(new URL("../organism.json", import.meta.url), "utf8"));
const ai = DNA.organs.find((o) => o.service === "xauusd-ai-trading-assistant");

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE agent_thread_messages (id INTEGER PRIMARY KEY, thread_id TEXT, agent TEXT, ts TEXT)");
  db.exec("CREATE TABLE ai_usage_daily (day TEXT, source TEXT, model TEXT, calls INTEGER, failed INTEGER, timeouts INTEGER)");
  const wrap = (sql, params = []) => ({ bind: (...a) => wrap(sql, a), all: async () => ({ results: db.prepare(sql).all(...params) }) });
  return { prepare: (sql) => wrap(sql), raw: db };
}

test("the roster is every seat of the code's rooms, plus the moderator and the system rows", () => {
  const expected = new Set([...Object.keys(DESK_AGENTS), ...Object.keys(TF_DESKS), ...Object.keys(MACRO_AGENTS), "technical", "news",
    ...["M15", "H1", "H4", "D1"].flatMap((r) => hudAgentsIn(r)), "moderator", "system"]);
  const roster = agentRoster({});
  assert.deepEqual(new Set(roster.map((a) => a.id)), expected);
  for (const a of roster) {
    assert.ok(a.rooms.length && a.rooms.every((r) => ROOMS[r]), a.id);
    assert.equal(a.worker, "xauusd-ai-trading-assistant");
    assert.equal(a.kernel_id, HUD_PLATFORM_IDS[a.id] ?? (a.id === "moderator" ? "xauusd-moderator" : null), a.id);
  }
  assert.equal(roster.find((a) => a.id === "system").model, null, "the system rows use no model");
  assert.deepEqual(roster.find((a) => a.id === "news").rooms.sort(), ["macro", "newsdaily", "tf", "warroom"]);
});

test("the DNA links the inventory at the top level, with the roster's count, and the RPC serves it", () => {
  assert.deepEqual(DNA.agents_inventory, { href: INVENTORY_HREF, schema: INVENTORY_SCHEMA, count: agentRoster({}).length });
  assert.deepEqual(organismDna().agents_inventory, DNA.agents_inventory);
  for (const o of DNA.organs) assert.equal(o.agents_inventory, undefined, `${o.service}: never inside an organ`);
});

test("every DNA engine has its logic, and only those", () => {
  assert.deepEqual(Object.keys(ENGINE_LOGIC).sort(), ai.engines.map((e) => e.task).sort());
  for (const [task, l] of Object.entries(ENGINE_LOGIC)) {
    assert.ok(l.source && l.inputs && l.output && l.validation && l.consumers?.length, task);
    assert.ok(l.room ? ROOMS[l.room] : l.trigger, `${task}: a room or its own trigger`);
  }
  assert.deepEqual(meterLabels("metric_opening"), ["metric_opening", "shadow:metric_opening", "shadow:arena:metric_opening"]);
});

test("the inventory reads each agent's last message; the matrix sums live and shadow labels and gives a verdict", async () => {
  const db = d1();
  const now = Date.parse("2026-11-15T12:00:00Z");
  db.raw.prepare("INSERT INTO agent_thread_messages (thread_id, agent, ts) VALUES (?, ?, ?)").run("warroom:2026-11-13", "prophet", "2026-11-13T20:00:00Z");
  db.raw.prepare("INSERT INTO agent_thread_messages (thread_id, agent, ts) VALUES (?, ?, ?)").run("tf:D1", "d1", "2026-11-01T00:00:00Z");
  const env = { DB: db, WAR_ROOM_ENABLED: "true", TF_THREADS_ENABLED: "true", MACRO_ROOM_ENABLED: "true", NEWS_THREADS_ENABLED: "true", NEWS_DAILY_ENABLED: "true" };
  const inv = await agentInventory(env, { now });
  assert.equal(inv.schema, INVENTORY_SCHEMA);
  const by = Object.fromEntries(inv.agents.map((a) => [a.id, a]));
  assert.deepEqual([by.prophet.state, by.prophet.messages_7d, by.prophet.last_message_at], ["active", 1, "2026-11-13T20:00:00Z"]);
  assert.deepEqual([by.d1.state, by.d1.last_message_at], ["dormant", "2026-11-01T00:00:00Z"], "older than 7 days");
  assert.equal((await agentInventory({ DB: db }, { now })).agents.find((a) => a.id === "calendar").state, "flag_off");

  const ins = db.raw.prepare("INSERT INTO ai_usage_daily (day, source, model, calls, failed, timeouts) VALUES (?, ?, 'm', ?, 0, ?)");
  ins.run("2026-11-13", "war_room_opening", 100, 1);
  ins.run("2026-11-13", "shadow:war_room_opening", 7, 0);
  ins.run("2026-11-16", "shadow:metric_opening", 3, 0);
  const logic = await aiLogic(env, { now: Date.parse("2026-11-16T12:00:00Z") });
  assert.equal(logic.schema, AI_LOGIC_SCHEMA);
  assert.equal(logic.count, ai.engines.length);
  const e = Object.fromEntries(logic.engines.map((x) => [x.engine, x]));
  assert.deepEqual([e.war_room_opening.usage.calls, e.war_room_opening.usage.live, e.war_room_opening.usage.shadow, e.war_room_opening.usage.timeouts, e.war_room_opening.verdict], [107, 100, 7, 1, "active"]);
  assert.deepEqual([e.metric_opening.usage.shadow, e.metric_opening.verdict], [3, "active"], "metric shadow is metered under shadow:metric_opening");
  assert.equal(e.metric_rebuttal.verdict, "declared_only");
  assert.equal((await aiLogic({ DB: db }, { now })).engines.find((x) => x.engine === "macro_room_opening").verdict, "dormant_flagged");
});
