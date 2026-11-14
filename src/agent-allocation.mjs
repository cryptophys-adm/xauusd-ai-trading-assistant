// Neuron allocation by reputation (owner 2026-11-14: "setuju poin 4", then "Setuju" to the thresholds). A room
// agent whose 30-day record in a room is measurably below the line goes to shadow in that room: it leaves the
// room's bus, quorum and discussion, and answers only on every fourth bar, in shadow (step `shadow:<agent>`,
// scored like its live calls), so its record keeps moving and its neurons drop by about three quarters. When
// that record recovers it is live again. Every move is logged (D1 agent_allocation_events), sent to the owner
// on Telegram and shown on the Nexus "Neuron allocation" page. `AGENT_ALLOCATION` "off" keeps everyone live.
//
// The rules, per room (M15, H1, H4, D1) and agent, on the directional calls of the last 30 days (the scorecards
// snapshot, src/outcome-scoring.mjs):
//   live -> shadow  when at least 60 calls are decided and fewer than 45% were right;
//   shadow -> live  when the record is back to 50% or more (the gap keeps an agent from flapping);
//   never           the moderator (it concludes the room), and never below 4 live agents with a record.

export const ALLOCATION_RULES = Object.freeze({ demote_below: 0.45, promote_at: 0.5, min_scored: 60, shadow_every: 4, min_live: 4, exempt: Object.freeze(["moderator"]) });
export const ALLOCATION_STATE_KEY = "agent-allocation:state:v1";
export const ROOM_TIMEFRAME = Object.freeze({ M15: "15", H1: "60", H4: "240", D1: "1D" });
const TIMEFRAME_ROOM = Object.freeze(Object.fromEntries(Object.entries(ROOM_TIMEFRAME).map(([r, tf]) => [tf, r])));
const BAR_MS = Object.freeze({ M15: 900_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000 });
const EVENTS_SQL = `CREATE TABLE IF NOT EXISTS agent_allocation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, room TEXT NOT NULL, agent TEXT NOT NULL,
  from_status TEXT NOT NULL, to_status TEXT NOT NULL, hit_rate REAL, scored INTEGER, reason TEXT NOT NULL)`;

export function allocationEnabled(env) {
  return String(env?.AGENT_ALLOCATION ?? "").trim().toLowerCase() !== "off";
}

/** The stored state: { rooms: { M15: { risk: { status, since, hit_rate, scored, reason } } } }. Never throws. */
export async function readAllocationState(env) {
  if (!allocationEnabled(env)) return { rooms: {} };
  try {
    const s = JSON.parse((await env?.SIGNAL_CACHE?.get?.(ALLOCATION_STATE_KEY)) || "null");
    return s && typeof s.rooms === "object" ? s : { rooms: {} };
  } catch { return { rooms: {} }; }
}

const round = (x) => Math.round(x * 1000) / 1000;

/**
 * Pure: the next state and its changes from the 30-day scorecards. `cards` are scorecards() entries; an agent's
 * record in a room is its "agent:<id>" card on that room's timeframe.
 */
export function decideAllocation({ state = { rooms: {} }, cards = [], now = Date.now(), rules = ALLOCATION_RULES } = {}) {
  const rooms = JSON.parse(JSON.stringify(state.rooms || {}));
  const changes = [];
  const records = {};
  for (const c of cards) {
    const room = TIMEFRAME_ROOM[c.timeframe];
    if (!room || !String(c.subject).startsWith("agent:")) continue;
    const agent = String(c.subject).slice(6);
    const hit = Number(c.directional?.hit) || 0, miss = Number(c.directional?.miss) || 0;
    (records[room] ||= {})[agent] = { decided: hit + miss, rate: hit + miss > 0 ? hit / (hit + miss) : null };
  }
  const at = new Date(now).toISOString();
  for (const [room, agents] of Object.entries(records)) {
    const current = rooms[room] || {};
    const statusOf = (a) => current[a]?.status ?? "live";
    // Promotions first, so a recovered agent counts as live before any demotion is weighed.
    for (const [agent, r] of Object.entries(agents)) {
      if (statusOf(agent) !== "shadow" || r.rate == null || r.decided < rules.min_scored || r.rate < rules.promote_at) continue;
      current[agent] = { status: "live", since: at, hit_rate: round(r.rate), scored: r.decided, reason: `30-day record back to ${Math.round(r.rate * 100)}% of ${r.decided} (line ${Math.round(rules.promote_at * 100)}%)` };
      changes.push({ at, room, agent, from: "shadow", to: "live", hit_rate: round(r.rate), scored: r.decided, reason: current[agent].reason });
    }
    // Demotions, weakest first, while enough agents with a record stay live.
    const candidates = Object.entries(agents)
      .filter(([agent, r]) => !rules.exempt.includes(agent) && statusOf(agent) === "live" && r.rate != null && r.decided >= rules.min_scored && r.rate < rules.demote_below)
      .sort((a, b) => a[1].rate - b[1].rate);
    for (const [agent, r] of candidates) {
      const liveWithRecord = Object.entries(agents).filter(([a, x]) => statusOf(a) === "live" && x.decided > 0).length;
      if (liveWithRecord - 1 < rules.min_live) break;
      current[agent] = { status: "shadow", since: at, hit_rate: round(r.rate), scored: r.decided, reason: `30-day record ${Math.round(r.rate * 100)}% of ${r.decided} decided calls, below ${Math.round(rules.demote_below * 100)}%` };
      changes.push({ at, room, agent, from: "live", to: "shadow", hit_rate: round(r.rate), scored: r.decided, reason: current[agent].reason });
    }
    if (Object.keys(current).length) rooms[room] = current;
  }
  return { next: { rooms, updated_at: changes.length ? at : state.updated_at ?? null }, changes };
}

/**
 * Pure: a room's roster split for one bar. `live` meets as before; `shadow` answers in shadow on this bar (every
 * `shadow_every`-th bar of the room's timeframe). An agent in shadow is never in `live`. If the split would leave
 * the room with fewer than two live agents, everyone stays live (a room must still meet).
 */
export function rosterSplit(roster, roomState, { room, barTime, rules = ALLOCATION_RULES } = {}) {
  const shadowed = new Set(Object.entries(roomState || {}).filter(([, s]) => s?.status === "shadow").map(([a]) => a));
  const live = (roster || []).filter((a) => !shadowed.has(a));
  if (live.length < 2) return { live: [...(roster || [])], shadow: [], benched: [] };
  const benched = (roster || []).filter((a) => shadowed.has(a));
  const index = Math.floor(Date.parse(barTime) / (BAR_MS[room] || BAR_MS.M15));
  const shadowNow = Number.isFinite(index) && index % rules.shadow_every === 0 ? benched : [];
  return { live, shadow: shadowNow, benched };
}

/** Hourly sweep step: applies the rules, stores the state, logs and reports each change. Never throws. */
export async function syncAgentAllocation(env, { now = Date.now(), cards, send = null } = {}) {
  if (!allocationEnabled(env)) return { status: "disabled" };
  try {
    const state = await readAllocationState(env);
    const { next, changes } = decideAllocation({ state, cards, now });
    if (!changes.length) return { status: "unchanged" };
    await env.SIGNAL_CACHE.put(ALLOCATION_STATE_KEY, JSON.stringify(next));
    try {
      await env.DB.prepare(EVENTS_SQL).run();
      for (const c of changes) {
        await env.DB.prepare("INSERT INTO agent_allocation_events (at, room, agent, from_status, to_status, hit_rate, scored, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(c.at, c.room, c.agent, c.from, c.to, c.hit_rate, c.scored, c.reason).run();
      }
    } catch (e) { console.error("agent_allocation_log_failed", String(e?.message ?? e).slice(0, 200)); }
    if (typeof send === "function") {
      const lines = changes.map((c) => `${c.to === "shadow" ? "⬇️" : "⬆️"} ${c.agent} (${c.room}) → ${c.to.toUpperCase()}: ${c.reason}`);
      try { await send(`XAUUSD SYSTEM · Neuron allocation\n${lines.join("\n")}\nAn agent in shadow leaves its room's quorum and answers every 4th bar in shadow until its record recovers.`); } catch { /* logged above */ }
    }
    return { status: "changed", changes };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The latest allocation changes, newest first (the Nexus timeline). Never throws. */
export async function readAllocationEvents(db, { limit = 50 } = {}) {
  try {
    await db.prepare(EVENTS_SQL).run();
    return ((await db.prepare("SELECT at, room, agent, from_status, to_status, hit_rate, scored, reason FROM agent_allocation_events ORDER BY id DESC LIMIT ?").bind(Math.min(200, Math.max(1, limit))).all()).results || [])
      .map((r) => ({ at: r.at, room: r.room, agent: r.agent, from: r.from_status, to: r.to_status, hit_rate: r.hit_rate, scored: r.scored, reason: r.reason }));
  } catch { return []; }
}
