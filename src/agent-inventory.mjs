// The agent inventory and the AI logic matrix (owner 2026-11-15: "setuju semuanya", items a/P4). Both are generated
// from the code, so they stay current: the room rosters (DESK_AGENTS, TF_DESKS, MACRO_AGENTS, the HUD manifests'
// rooms, the news thread's agents), the role models (roleModels), the kernel ids (HUD_PLATFORM_IDS) and the AI
// tasks of organism.json. test/agent-inventory.test.mjs keeps them equal to the rosters and to the DNA.
//   GET /api/agents/inventory  xauusd-agents-inventory.v1: every agent that speaks in a room, with its rooms,
//                              models, trigger, tables, kernel id and its last message (D1, 7 days).
//   GET /api/ai/logic          xauusd-ai-logic.v1: every AI task (engine) of the DNA, with its source, trigger, model,
//                              inputs, output, validation, consumers, meter labels and use (ai_usage_daily).
// The DNA links the inventory with one top-level field (agents_inventory), never inside an organ: the platform's
// census reads agents[] as registerable genes, and these room seats are not kernel agents.
import ORGANISM from "../organism.json" with { type: "json" };
import { DESK_AGENTS } from "./war-room.mjs";
import { TF_DESKS } from "./timeframe-threads.mjs";
import { MACRO_AGENTS } from "./macro-room.mjs";
import { BUS_AGENTS, roleModels } from "./model-call.mjs";
import { HUD_NAMES, hudAgentsIn } from "./hud-reading.mjs";
import { HUD_PLATFORM_IDS } from "./platform-reports.mjs";

export const INVENTORY_SCHEMA = "xauusd-agents-inventory.v1";
export const AI_LOGIC_SCHEMA = "xauusd-ai-logic.v1";
export const INVENTORY_HREF = "/api/agents/inventory";
const WORKER = "xauusd-ai-trading-assistant";
const DAY_MS = 86_400_000;
/** An agent with no message in this many days reads as dormant (a weekend is two days). */
export const DORMANT_AFTER_DAYS = 7;
const KERNEL_CAPABILITIES = Object.freeze(["signals.observe", "reports.publish", "memory.recall", "memory.remember"]);

/** The rooms: who sits where, what wakes the room, what it reads and writes, and its switch. */
export const ROOMS = Object.freeze({
  warroom: {
    name: "15m War Room", flag: "WAR_ROOM_ENABLED", thread: "warroom:<day>",
    trigger: "each 15m bar close (queue task live_room; the 15-minute sweep runs a missed room)",
    reads: ["KV hud:15:<candle> (HUD snapshot)", "KV context:m5:latest", "D1 ai_syntheses", "D1 agent_threads (News Daily, macro)", "D1 outcome_scores (reputation)"],
    writes: ["D1 agent_threads", "D1 agent_thread_messages", "D1 ai_usage_daily"],
    seats: () => [...Object.keys(DESK_AGENTS), ...hudAgentsIn("M15")]
  },
  tf: {
    name: "1H / 4H / D1 rooms", flag: "TF_THREADS_ENABLED", thread: "tf:H1, tf:H4, tf:D1",
    trigger: "the sweep after each 1H / 4H / D1 bar close (at most 20 min wait for the HUD snapshot)",
    reads: ["KV hud:<tf>:<candle>", "KV market-data series", "D1 agent_threads (News Daily)", "D1 economic calendar"],
    writes: ["D1 agent_threads", "D1 agent_thread_messages", "D1 ai_usage_daily"],
    seats: () => [...Object.keys(TF_DESKS), ...new Set(["H1", "H4", "D1"].flatMap((r) => hudAgentsIn(r)))]
  },
  macro: {
    name: "Macro room", flag: "MACRO_ROOM_ENABLED", thread: "macro:XAUUSD",
    trigger: "20 min after each 1H close, and after high-impact USD events",
    reads: ["KV market-data series (DXY, US10Y, silver, oil)", "D1 economic calendar", "D1 agent_threads (News Daily)"],
    writes: ["D1 agent_threads", "D1 agent_thread_messages", "D1 ai_usage_daily"],
    seats: () => Object.keys(MACRO_AGENTS)
  },
  news: {
    name: "News thread", flag: "NEWS_THREADS_ENABLED", thread: "news:<analysis>",
    trigger: "queue task news_thread after each hourly news analysis",
    reads: ["D1 news_analyses", "D1 ai_syntheses"],
    writes: ["D1 agent_threads", "D1 agent_thread_messages", "D1 ai_usage_daily"],
    seats: () => [...BUS_AGENTS]
  },
  newsdaily: {
    name: "News Daily", flag: "NEWS_DAILY_ENABLED", thread: "newsdaily:<day>",
    trigger: "after the hourly news batch (cron 6 * * * *), one digest per day",
    reads: ["D1 news_analyses"],
    writes: ["D1 agent_threads", "D1 agent_thread_messages", "D1 ai_usage_daily"],
    seats: () => ["news"]
  }
});
/** Every room's moderator concludes it; "system" writes the briefs and status rows (no model). */
const MODERATOR_ROOMS = Object.freeze(["warroom", "tf", "macro", "news", "newsdaily"]);
const SYSTEM_ROOMS = Object.freeze(["warroom", "tf", "macro", "newsdaily"]);

const nameOf = (id) => DESK_AGENTS[id]?.name ?? TF_DESKS[id]?.name ?? MACRO_AGENTS[id]?.name ?? HUD_NAMES[id]
  ?? ({ moderator: "Moderator", system: "System", news: "News Analyst", technical: "Technical Analyst" })[id] ?? id;
const roleOf = (id) => DESK_AGENTS[id]?.role ?? TF_DESKS[id]?.role ?? MACRO_AGENTS[id]?.role
  ?? (HUD_NAMES[id] ? `the ${HUD_NAMES[id]} HUD reading of the room's chart` : null)
  ?? ({ moderator: "concludes the room (stance, bias, reasons, dissent)", system: "writes the room's brief and status rows (no model)", news: "the fundamental news", technical: "price action" })[id] ?? null;

/** Pure: the roster, from the code (no D1). Each agent once, with every room it sits in. */
export function agentRoster(env = {}) {
  const byId = new Map();
  const seat = (id, room) => { const a = byId.get(id) ?? { id, rooms: [] }; if (!a.rooms.includes(room)) a.rooms.push(room); byId.set(id, a); };
  for (const [room, spec] of Object.entries(ROOMS)) for (const id of spec.seats()) seat(id, room);
  for (const room of MODERATOR_ROOMS) seat("moderator", room);
  for (const room of SYSTEM_ROOMS) seat("system", room);
  const agent = roleModels(env, "agent"), moderator = roleModels(env, "moderator");
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).map((a) => {
    const kernel = HUD_PLATFORM_IDS[a.id] ?? (a.id === "moderator" ? "xauusd-moderator" : null);
    return {
      id: a.id, name: nameOf(a.id), role: roleOf(a.id), rooms: a.rooms,
      model: a.id === "system" ? null : a.id === "moderator" ? moderator : agent,
      triggers: a.rooms.map((r) => `${ROOMS[r].name}: ${ROOMS[r].trigger}`),
      flags: [...new Set(a.rooms.map((r) => ROOMS[r].flag))],
      worker: WORKER,
      reads: [...new Set(a.rooms.flatMap((r) => ROOMS[r].reads))],
      writes: [...new Set(a.rooms.flatMap((r) => ROOMS[r].writes))],
      kernel_id: kernel, capabilities: kernel ? [...KERNEL_CAPABILITIES] : []
    };
  });
}

/** The inventory: the roster plus each agent's last message and 7-day count (one indexed read). */
export async function agentInventory(env, { now = Date.now() } = {}) {
  const roster = agentRoster(env);
  const since = new Date(now - DORMANT_AFTER_DAYS * DAY_MS).toISOString();
  let seen = new Map(), lastAny = new Map(), error = null;
  try {
    const recent = (await env.DB.prepare("SELECT agent, COUNT(*) AS n, MAX(ts) AS last FROM agent_thread_messages WHERE ts >= ? GROUP BY agent").bind(since).all()).results || [];
    seen = new Map(recent.map((r) => [r.agent, r]));
    const ids = roster.map((a) => a.id).filter((id) => !seen.has(id));
    if (ids.length) {
      const older = (await env.DB.prepare(`SELECT agent, MAX(ts) AS last FROM agent_thread_messages WHERE agent IN (${ids.map(() => "?").join(", ")}) GROUP BY agent`).bind(...ids).all()).results || [];
      lastAny = new Map(older.map((r) => [r.agent, r.last]));
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  const agents = roster.map((a) => {
    const r = seen.get(a.id);
    const enabled = a.flags.some((f) => String(env?.[f] ?? "").toLowerCase() === "true");
    const last = r?.last ?? lastAny.get(a.id) ?? null;
    return { ...a, messages_7d: Number(r?.n ?? 0), last_message_at: last, state: !enabled ? "flag_off" : r ? "active" : "dormant" };
  });
  return { schema: INVENTORY_SCHEMA, generated_at: new Date(now).toISOString(), count: agents.length, dormant_after_days: DORMANT_AFTER_DAYS, ...(error ? { error } : {}), agents };
}

// ---------------------------------------------------------------- the AI logic matrix
const ROOM_VALIDATION = "strict JSON schema; the room's validator (stance, bias, confidence, metrics grounded in the room's data, natural language, no trade levels); one correction, then the role's fallback";
/** Per AI task of the DNA: where it lives, what wakes it, what it reads and writes, how it is checked, who reads it. */
export const ENGINE_LOGIC = Object.freeze({
  war_room_opening: { source: "src/war-room.mjs runWarRoomBar", room: "warroom", role: "agent", inputs: "the seat's own evidence (HUD reading, 15m candles, 5m read, news, projection)", output: "opening {agent, stance, bias, confidence, claim, metrics}", validation: ROOM_VALIDATION, consumers: ["15m War Room conclusion", "outcome scoring (agent:<id>)", "reputation", "weighting replay", "compliance", "kernel reports"] },
  war_room_rebuttal: { source: "src/war-room.mjs runWarRoomBar", room: "warroom", role: "agent", inputs: "the openings it disputes", output: "rebuttal {rebuts, argument, stance, bias, metrics}", validation: ROOM_VALIDATION, consumers: ["15m War Room conclusion", "outcome scoring (final stance)", "weighting replay"] },
  war_room_conclusion: { source: "src/war-room.mjs runWarRoomBar", room: "warroom", role: "moderator", inputs: "the openings, the debate, the crowd line, the quorum", output: "conclusion {stance, bias, confidence, summary, reasons, dissent, metrics}", validation: ROOM_VALIDATION + "; support and confirmation rules", consumers: ["Decision Engine (M15 witness)", "strategy engine", "decision cards", "push hub", "Telegram"] },
  tf_room_opening: { source: "src/timeframe-threads.mjs runTimeframeThread", room: "tf", role: "agent", inputs: "the seat's evidence on its own chart", output: "opening", validation: ROOM_VALIDATION, consumers: ["the room's conclusion", "outcome scoring", "weighting replay"] },
  tf_room_rebuttal: { source: "src/timeframe-threads.mjs runTimeframeThread", room: "tf", role: "agent", inputs: "the openings it disputes", output: "rebuttal", validation: ROOM_VALIDATION, consumers: ["the room's conclusion", "outcome scoring"] },
  tf_room_conclusion: { source: "src/timeframe-threads.mjs runTimeframeThread", room: "tf", role: "moderator", inputs: "the openings and the debate", output: "conclusion", validation: ROOM_VALIDATION, consumers: ["Decision Engine (H1, H4, D1 witnesses)", "H1 consensus and Reasoner", "strategy engine", "decision cards"] },
  macro_room_opening: { source: "src/macro-room.mjs", room: "macro", role: "agent", inputs: "calendar, DXY, US10Y, silver, oil, News Daily", output: "opening {agent, bias, confidence, claim}", validation: "strict JSON schema; the macro room's validator", consumers: ["macro room conclusion"] },
  macro_room_rebuttal: { source: "src/macro-room.mjs", room: "macro", role: "agent", inputs: "the openings", output: "rebuttal", validation: "strict JSON schema; the macro room's validator", consumers: ["macro room conclusion"] },
  macro_room_conclusion: { source: "src/macro-room.mjs", room: "macro", role: "moderator", inputs: "the session's openings and rebuttals", output: "conclusion {bias, confidence, summary}", validation: "strict JSON schema; the macro room's validator", consumers: ["Decision Engine (MACRO witness)", "global conclusion"] },
  decision_council: { source: "src/decision-engine.mjs decideBar", trigger: "every 15m bar, after its room (and the sweep's fallback)", role: "moderator", inputs: "the witnesses, the guardrails, the strategy engine", output: "{stance, bias, confidence, summary, reasons, risks}", validation: "strict JSON schema; validateCouncil; then the deterministic guardrails (a failed council falls back to them)", consumers: ["engine decision", "signal ledger", "EA signal / Omega", "Telegram", "kernel reports"] },
  thread_agent: { source: "src/agent-threads.mjs runNewsThread", room: "news", role: "agent", inputs: "the news analysis, the H1 technical evidence", output: "{agent, round, stance, confidence, insight, refs}", validation: "strict JSON schema; validateAgentOutput (refs, natural language)", consumers: ["news thread moderator"] },
  thread_moderator: { source: "src/agent-threads.mjs runNewsThread", room: "news", role: "moderator", inputs: "the thread", output: "{stance, confidence, agreed, summary, dissent}", validation: "strict JSON schema; validateModeratorOutput", consumers: ["/api/tldr (news)", "rooms' News Analyst evidence"] },
  news_daily_tags: { source: "src/news-daily.mjs runNewsDaily", room: "newsdaily", role: "agent", inputs: "the last 24 h of headlines", output: "per-headline bias tags", validation: "strict JSON schema", consumers: ["News Daily TLDR"] },
  news_daily_tldr: { source: "src/news-daily.mjs runNewsDaily", room: "newsdaily", role: "moderator", inputs: "the tagged headlines", output: "{stance, confidence, summary}", validation: "strict JSON schema", consumers: ["every room's News Analyst", "macro room", "strategy engine", "/api/news-daily"] },
  news_analyst: { source: "src/index.ts runNewsAnalysis", trigger: "hourly news cron (6 * * * *)", model_var: "AI_MODEL_ANALYST", inputs: "the hour's fresh articles", output: "analyst text", validation: "text; the chain's next stage reads it", consumers: ["news counselor"] },
  news_counselor: { source: "src/index.ts runNewsAnalysis", trigger: "hourly news cron (6 * * * *)", model_var: "AI_MODEL_COUNSELOR", inputs: "the analyst's text", output: "counselor text", validation: "text", consumers: ["news reasoner"] },
  news_reasoner: { source: "src/index.ts runNewsAnalysis", trigger: "hourly news cron (6 * * * *)", model_var: "AI_MODEL_REASONER", inputs: "the counselor's text", output: "news recommendation (JSON)", validation: "JSON parse", consumers: ["news_analyses", "news thread", "News Daily"] },
  h1_reasoner: { source: "src/index.ts finalizeH1Decision (the H1 Reasoner)", trigger: "the H1 consensus after the 1H room", model_var: "AI_MODEL_REASONER", inputs: "the 1H room's Consensus Discussion", output: "H1 decision (JSON)", validation: "JSON parse; the H1 entry rules", consumers: ["H1 decision (ai_syntheses)", "Decision Engine (H1 context)"] },
  plain_decision: { source: "src/plain-decision.mjs", trigger: "after a decision, its plain-language rewrite", role: "agent", inputs: "the decision's reasons", output: "plain text", validation: "strict JSON schema; natural language", consumers: ["Nexus decision card", "Telegram"] },
  metric_opening: { source: "src/metric-shadow.mjs runMetricShadow", room: "warroom", role: "agent", shadow: true, flag_off: "METRIC_SHADOW=off", inputs: "the seat's data as a metric menu", output: "metric readings + stance", validation: "strict JSON schema; grounding against the menu", consumers: ["metric shadow scoring", "Nexus metric chips"] },
  metric_rebuttal: { source: "src/metric-shadow.mjs runMetricRebuttals", room: "warroom", role: "agent", shadow: true, flag_off: "METRIC_SHADOW=off", inputs: "the metric openings", output: "metric rebuttal", validation: "strict JSON schema; grounding", consumers: ["metric shadow scoring"] }
});

/** The meter labels an engine's calls land under (src/ai-usage.mjs): its name, in shadow, and in the model arena. */
export const meterLabels = (engine) => [engine, `shadow:${engine}`, `shadow:arena:${engine}`];
const DNA_ENGINES = () => (ORGANISM.organs.find((o) => o.service === WORKER)?.engines ?? []).map((e) => e.task);

/** The matrix: every DNA engine with its logic and its use in ai_usage_daily over `days` (default 14). */
export async function aiLogic(env, { now = Date.now(), days = 14 } = {}) {
  const since = new Date(now - days * DAY_MS).toISOString().slice(0, 10);
  let usage = [], error = null;
  try { usage = (await env.DB.prepare("SELECT source, SUM(calls) AS calls, SUM(timeouts) AS timeouts, SUM(failed) AS failed, MAX(day) AS last_day FROM ai_usage_daily WHERE day >= ? GROUP BY source").bind(since).all()).results || []; }
  catch (e) { error = e instanceof Error ? e.message : String(e); }
  const bySource = new Map(usage.map((u) => [u.source, u]));
  const agent = roleModels(env, "agent"), moderator = roleModels(env, "moderator");
  const engines = DNA_ENGINES().map((task) => {
    const l = ENGINE_LOGIC[task] ?? {};
    const labels = meterLabels(task);
    const split = { live: 0, shadow: 0 }, totals = { calls: 0, timeouts: 0, failed: 0 };
    let last = null;
    for (const label of labels) {
      const u = bySource.get(label);
      if (!u) continue;
      const calls = Number(u.calls) || 0;
      totals.calls += calls; totals.timeouts += Number(u.timeouts) || 0; totals.failed += Number(u.failed) || 0;
      split[label === task ? "live" : "shadow"] += calls;
      if (!last || u.last_day > last) last = u.last_day;
    }
    const room = l.room ? ROOMS[l.room] : null;
    const model = l.model_var ? { primary: env?.[l.model_var] ?? null, fallback: null } : l.role === "moderator" ? moderator : agent;
    const flagOff = room && String(env?.[room.flag] ?? "").toLowerCase() !== "true";
    const verdict = !ENGINE_LOGIC[task] ? "undocumented" : totals.calls > 0 ? "active" : flagOff ? "dormant_flagged" : "declared_only";
    return {
      engine: task, source: l.source ?? null, trigger: l.trigger ?? room?.trigger ?? null, room: l.room ?? null, flag: room?.flag ?? null,
      model, inputs: l.inputs ?? null, output: l.output ?? null, validation: l.validation ?? null, consumers: l.consumers ?? [],
      shadow: l.shadow === true, meter_labels: labels, usage: { days, ...totals, ...split, last_day: last }, verdict
    };
  });
  return { schema: AI_LOGIC_SCHEMA, generated_at: new Date(now).toISOString(), count: engines.length, usage_since: since, ...(error ? { error } : {}), engines };
}
