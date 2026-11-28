// Call for Councils, phase P2: live sessions (docs/RFC_CALL_FOR_COUNCILS.md §4; owner 2026-11-17, relayed: "lanjutkan
// call for councils ... adalah pendapat masing-masing agent bukan detail evidences"; confirmed in the session:
// "Setuju + topik bebas"). A session reads like a retrospective: each seat speaks its own opinion in its own voice
// (stance, 2-5 sentences, what it would try), the evidence stays behind its refs; then rebuttals by name, the
// moderator's 2-5 options (always "no_change"), and the owner's messages, each answered by the seats addressed. The
// owner opens a session on a suggested topic or on free text. The pick is made in Cerebrum (HAIC Q6): the options go to
// the platform as a council_decision.v1 report. A session never changes trading: its options are proposals.
//
// Runs as queue steps (kind "council_step", one step per message: positions, rebuttals, synthesis, answer), so a step
// may take the model's minutes. Limits (RFC §8): at most 16 model calls per session (6 positions, 4 rebuttals,
// 4 answers, 1 synthesis, 1 retry), 20 owner messages, 2 sessions open and 4 started per UTC day; CFC_MODE "on" runs
// sessions ("suggest" shows suggestions only; "off" nothing); a daily neuron cap CFC_NEURONS_PER_DAY_MAX (8,000)
// over every "cfc:*" meter. Never throws from a step; a failed step aborts the session with its reason.
import { callBusModel } from "./model-call.mjs";
import { ensureAiUsageSchema, neuronsOf } from "./ai-usage.mjs";
import { buildEvidencePack, parseTopicKey, evRef } from "./cfc-pack.mjs";
import { parseRef, refCarriesPrice } from "./owner-corrections.mjs";
import { cfcMode } from "./cfc-triggers.mjs";
import { agentRoster } from "./agent-inventory.mjs";
import { publishToPlatform } from "./platform-reports.mjs";
import { knobMenu, checkKnobValue, readKnobOverrides } from "./council-knobs.mjs";

/** States that end a session; "closed" is the owner's Close or Re-open (owner 2026-11-17). */
export const TERMINAL_STATES = Object.freeze(["aborted", "expired", "decided", "closed"]);
// C1 (orchestrator 2026-11-28, the owner's "setuju semua" on platform Issue #327): every write that moves a session's state
// carries this guard, so a step that read the session before the owner closed it cannot move it back out of a terminal
// state (cfc_mwxpyjky_splej5: closed during its synthesis, left awaiting_owner).
const NOT_TERMINAL = `state NOT IN (${TERMINAL_STATES.map((s) => `'${s}'`).join(", ")})`;
const changed = (r) => Number(r?.meta?.changes) > 0;
/** A pack older than this is stale: the page offers to re-open the topic with fresh evidence. */
export const PACK_STALE_MS = 24 * 3_600_000;
export const SESSION_LIMITS = Object.freeze({ calls: 16, positions: 6, rebuttals: 4, answers: 4, owner_messages: 20, open: 2, started_per_day: 4, neurons_per_day: 8000, pack_chars: 7000 });
export const STANCES = Object.freeze(["support", "oppose", "amend", "abstain"]);
const DAY = 86_400_000;
const parse = (s, fb = null) => { try { return s == null ? fb : JSON.parse(s); } catch { return fb; } };
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Seats per topic type (RFC §2), the first six that exist in the roster. */
export const SEATS_BY_TYPE = Object.freeze({
  strategy: ["risk", "technical", "projection", "m15", "trade_management", "interstellar_eyes"],
  engine: ["m15", "h1", "risk", "technical", "news", "projection"],
  risk: ["risk", "m15", "chronos_matrix", "technical", "trade_management", "projection"],
  news: ["news", "calendar", "dollar", "rates", "risk", "m15"],
  execution: ["trade_management", "risk", "m15", "technical"],
  data: ["technical", "risk"],
  cost: ["risk"],
  seat: ["risk", "technical", "m15"],
  knowledge: ["risk", "technical", "m15"],
  free: ["risk", "technical", "projection", "m15", "trade_management", "news"]
});

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS council_sessions (id TEXT PRIMARY KEY, topic_key TEXT NOT NULL, topic_text TEXT, type TEXT NOT NULL, question TEXT NOT NULL,
    state TEXT NOT NULL, participants TEXT NOT NULL, pack_hash TEXT, pack_json TEXT, calls INTEGER NOT NULL DEFAULT 0, options TEXT, reason TEXT,
    created_by TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS council_sessions_created ON council_sessions (created_ms)",
  `CREATE TABLE IF NOT EXISTS council_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, round TEXT NOT NULL, seat TEXT NOT NULL,
    stance TEXT, opinion TEXT NOT NULL, proposal TEXT, reply_to TEXT, refs TEXT, ms INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS council_messages_session ON council_messages (session_id, id)",
  "CREATE TABLE IF NOT EXISTS council_switch_events (id INTEGER PRIMARY KEY AUTOINCREMENT, on_value INTEGER NOT NULL, actor TEXT, ms INTEGER NOT NULL)",
  // An accepted option (owner 2026-11-17): the proposal and where it stands. Kinds: policy_parameter (shadow test, then
  // live with a rollback; phase 2), repository_task (handed to the platform for its evolution loop), no_change.
  `CREATE TABLE IF NOT EXISTS council_proposals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, option_id TEXT NOT NULL, kind TEXT NOT NULL,
    title TEXT, knob TEXT, from_value REAL, value REAL, spec TEXT, option_json TEXT NOT NULL, state TEXT NOT NULL, note TEXT,
    report_id TEXT, accepted_by TEXT, accepted_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS council_proposals_state ON council_proposals (state, updated_ms)"
];
let schemaReady = null;
export async function ensureSessionSchema(db) {
  if (schemaReady === db) return;
  for (const q of SCHEMA_SQL) await db.prepare(q).run();
  // C1's repair, idempotent: a session the owner closed (or re-opened) while a step ran was moved on to awaiting_owner
  // by that step; its reason still says so. Only that state and those reasons are touched.
  try {
    await db.prepare("UPDATE council_sessions SET state = 'closed' WHERE state = 'awaiting_owner' AND (reason LIKE 'owner_closed%' OR reason LIKE 'reopened as %')").run();
  } catch { /* the sessions stand */ }
  schemaReady = db;
}
export function resetSessionSchemaForTests() { schemaReady = null; }

/** Sessions run only with CFC_MODE "on" and the owner's switch on (the latest switch event; off by default). */
export async function sessionsEnabled(env) {
  if (cfcMode(env) !== "on") return false;
  try {
    await ensureSessionSchema(env.DB);
    const row = await env.DB.prepare("SELECT on_value FROM council_switch_events ORDER BY id DESC LIMIT 1").first();
    return Number(row?.on_value) === 1;
  } catch { return false; }
}
export async function setSessionsSwitch(env, { on, actor, now = Date.now() }) {
  await ensureSessionSchema(env.DB);
  await env.DB.prepare("INSERT INTO council_switch_events (on_value, actor, ms) VALUES (?, ?, ?)").bind(on ? 1 : 0, String(actor ?? "owner").slice(0, 200), now).run();
  return { ok: true, on: Boolean(on), mode: cfcMode(env) };
}

const roster = () => Object.fromEntries(agentRoster({}).map((a) => [a.id, { name: a.name, role: a.role }]));
/** Pure: a free-text topic's key slug. */
export function slugOf(text) {
  return clip(text, 200).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "topic";
}

/** Pure: a seat's messages for its opening or rebuttal or answer. */
/**
 * Pure: the pack as the seats read it (2026-11-17: a free pack is ~90 KB and was cut to its first 7,000 characters, so
 * every seat read the same engine section). Each top-level section gets a fair share of the budget, and a short list of
 * refs the seats may cite, taken in turn from each source, so a citation is possible at all.
 */
export function packForPrompt(pack, { chars = SESSION_LIMITS.pack_chars, cite = 30 } = {}) {
  const sections = pack?.sections && typeof pack.sections === "object" ? pack.sections : {};
  const keys = Object.keys(sections);
  const share = Math.max(300, Math.floor(chars / Math.max(1, keys.length)));
  const parts = keys.map((k) => { const t = JSON.stringify(sections[k]) ?? "null"; return `"${k}": ${t.length > share ? t.slice(0, share) + "…" : t}`; });
  const bySource = new Map();
  for (const r of Array.isArray(pack?.refs) ? pack.refs : []) {
    const src = /^ev:xauusd\/([^/]+)\//.exec(String(r))?.[1] ?? "other";
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(String(r));
  }
  const citable = [];
  for (let i = 0; citable.length < cite && [...bySource.values()].some((l) => l.length > i); i++) for (const l of bySource.values()) if (l[i] && citable.length < cite) citable.push(l[i]);
  return { text: `{${parts.join(", ")}}`, citable };
}
const refKey = (r) => String(r ?? "").trim().replace(/@[^#]*/, "");

export function seatMessages({ seat, session, pack, earlier = [], ownerText = null, round, citable = [] }) {
  const who = roster()[seat] ?? { name: seat, role: seat };
  const sys = [
    `You are ${who.name}, a member of an XAUUSD trading system's council (your role: ${who.role}).`,
    "This is a retrospective meeting. Speak in the first person, in plain words, as yourself: what YOU think about the question and why, in 2 to 5 sentences (\"I think ..., because ...\").",
    "Base it on the evidence pack only; in refs cite 1 to 3 of the citable_refs that support what you say, copied exactly (never in the opinion text). Never quote a price.",
    "Give a stance: support, oppose, amend (support with a change) or abstain; and in proposal one concrete thing you would try (or empty).",
    round === "rebuttal" ? "Answer the others by name where you disagree or agree (reply_to: their seat ids); you may change your stance." : "",
    round === "answer" ? "The owner wrote to you. Answer the owner directly, in the same plain first-person voice." : ""
  ].filter(Boolean).join(" ");
  const user = {
    question: session.question, topic: session.topic_key, owner_topic_text: session.topic_text ?? null,
    evidence_pack: String(pack ?? "").slice(0, SESSION_LIMITS.pack_chars + 2000),
    citable_refs: citable,
    others_so_far: earlier.map((m) => ({ seat: m.seat, stance: m.stance, opinion: m.opinion, proposal: m.proposal })),
    ...(ownerText ? { owner_message: ownerText } : {})
  };
  return [{ role: "system", content: sys }, { role: "user", content: JSON.stringify(user) }];
}
export const SEAT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["stance", "opinion", "proposal", "refs"],
  properties: {
    stance: { type: "string", enum: STANCES }, opinion: { type: "string", maxLength: 700 }, proposal: { type: "string", maxLength: 240 },
    refs: { type: "array", maxItems: 3, items: { type: "string", maxLength: 200 } }, reply_to: { type: "array", maxItems: 4, items: { type: "string", maxLength: 40 } }
  }
});
/** An option's kind (owner 2026-11-17): a bounded knob change, a code change for the platform's evolution loop, or none. */
export const OPTION_KINDS = Object.freeze(["policy_parameter", "repository_task", "no_change"]);
export const SYNTHESIS_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["summary", "options"],
  properties: {
    summary: { type: "string", maxLength: 800 },
    options: { type: "array", minItems: 2, maxItems: 5, items: { type: "object", additionalProperties: false, required: ["option_id", "kind", "title", "hypothesis", "change", "risk"],
      properties: {
        option_id: { type: "string", maxLength: 40 }, kind: { type: "string", enum: OPTION_KINDS }, title: { type: "string", maxLength: 120 }, hypothesis: { type: "string", maxLength: 300 },
        change: { type: "string", maxLength: 300 }, risk: { type: "string", maxLength: 200 }, dissent: { type: "string", maxLength: 200 },
        knob: { type: "string", maxLength: 60 }, value: { type: "number" }, spec: { type: "string", maxLength: 800 }
      } } }
  }
});

/** Pure: a seat's answer cleaned (refs only from the pack). */
export function cleanSeat(o, packRefs) {
  if (!o || !STANCES.includes(o.stance) || typeof o.opinion !== "string" || !o.opinion.trim()) return null;
  // A ref counts when the pack holds it, with or without its @as_of part (the seats often drop it).
  const allowed = new Map((Array.isArray(packRefs) ? packRefs : []).map((r) => [refKey(r), r]));
  const refs = [...new Set((Array.isArray(o.refs) ? o.refs : []).map((r) => allowed.get(refKey(r))).filter(Boolean))].slice(0, 3);
  return { stance: o.stance, opinion: clip(o.opinion, 700), proposal: clip(o.proposal, 240) || null, refs, reply_to: (Array.isArray(o.reply_to) ? o.reply_to : []).map((x) => clip(x, 40)).slice(0, 4) };
}
/** Pure: the options with "no_change" always among them. */
export function cleanOptions(o, live = null) {
  const opts = (Array.isArray(o?.options) ? o.options : []).filter((x) => x && x.option_id && x.title).slice(0, 5)
    .map((x, i) => {
      const base = { option_id: clip(x.option_id, 40), rank: i + 1, title: clip(x.title, 120), hypothesis: clip(x.hypothesis, 300), change: clip(x.change, 300), risk: clip(x.risk, 200), dissent: clip(x.dissent, 200) || null };
      if (base.option_id === "no_change" || x.kind === "no_change") return { ...base, kind: "no_change" };
      // A knob change only for a listed knob and a value inside its bounds; anything else is code for the platform to build.
      if (x.kind === "policy_parameter") {
        const k = checkKnobValue(x.knob, x.value, live);
        if (k.ok) return { ...base, kind: "policy_parameter", knob: k.knob.id, from: k.from, value: k.value, unit: k.knob.unit };
        return { ...base, kind: "repository_task", spec: clip(`${x.spec ?? base.change} (not a valid knob change: ${k.error})`, 800) };
      }
      return { ...base, kind: "repository_task", spec: clip(x.spec ?? base.change, 800) };
    });
  if (!opts.some((x) => x.option_id === "no_change")) opts.push({ option_id: "no_change", rank: opts.length + 1, kind: "no_change", title: "No change (the control)", hypothesis: "What runs today stays.", change: "none", risk: "none", dissent: null });
  return { summary: clip(o?.summary, 800), options: opts };
}

async function cfcNeuronsToday(db, now) {
  await ensureAiUsageSchema(db);
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = (await db.prepare("SELECT model, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c, SUM(cached_tokens) AS k FROM ai_usage_daily WHERE day = ? AND source LIKE 'cfc:%' GROUP BY model").bind(day).all()).results || [];
  let n = 0;
  for (const r of rows) n += neuronsOf(r.model, Number(r.p) || 0, Number(r.c) || 0, Number(r.k) || 0) ?? 0;
  return n;
}
const neuronCap = (env) => { const v = Number(env?.CFC_NEURONS_PER_DAY_MAX ?? SESSION_LIMITS.neurons_per_day); return Number.isFinite(v) && v >= 0 ? v : SESSION_LIMITS.neurons_per_day; };

/** Opens a session (the owner's click): a suggested topic key or free text. Returns { ok, session_id } or an error. */
export async function startSession(env, { topic_key = null, text = null, seats = null, actor = "owner", now = Date.now(), enqueue }) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "unavailable" };
  if (!(await sessionsEnabled(env))) return { ok: false, error: "council sessions are off (CFC_MODE and the switch on the Councils page)" };
  await ensureSessionSchema(db);
  const dayStart = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
  const open = await db.prepare("SELECT COUNT(*) AS n FROM council_sessions WHERE state IN ('positions', 'rebuttals', 'synthesis')").first();
  if (Number(open?.n) >= SESSION_LIMITS.open) return { ok: false, error: `at most ${SESSION_LIMITS.open} sessions open` };
  // A session that ran on an empty pack (before the fix of 2026-11-17), or that the owner closed (owner 2026-11-17:
  // "Tidak dihitung"; the daily neuron cap still bounds the cost), does not count against the day.
  const today = await db.prepare("SELECT COUNT(*) AS n FROM council_sessions WHERE created_ms >= ? AND state != 'closed' AND COALESCE(json_array_length(json_extract(pack_json, '$.refs')), 0) > 0").bind(dayStart).first();
  if (Number(today?.n) >= SESSION_LIMITS.started_per_day) return { ok: false, error: `at most ${SESSION_LIMITS.started_per_day} sessions a day` };
  const freeText = typeof text === "string" && text.trim() ? clip(text, 300) : null;
  const key = freeText ? `free:${slugOf(freeText)}` : topic_key;
  const t = parseTopicKey(key);
  if (!t.ok) return { ok: false, error: t.error };
  const pack = await buildEvidencePack(env, t.key, { now });
  if (pack?.error) return { ok: false, error: pack.error };
  // No evidence, no session (2026-11-17: a free topic ran on an empty pack and every seat abstained).
  if (!Array.isArray(pack.refs) || !pack.refs.length) return { ok: false, error: "no evidence for this topic: pick a suggested topic or name a strategy, the exits, the news or the risk in your words" };
  const names = roster();
  const chosen = (Array.isArray(seats) && seats.length ? seats : SEATS_BY_TYPE[t.type] ?? SEATS_BY_TYPE.free).filter((s) => names[s]).slice(0, SESSION_LIMITS.positions);
  if (chosen.length < 3) return { ok: false, error: "a session needs at least 3 seats" };
  const id = `cfc_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const question = freeText ?? `What should change about ${t.key}, if anything?`;
  await db.prepare("INSERT INTO council_sessions (id, topic_key, topic_text, type, question, state, participants, pack_hash, pack_json, calls, created_by, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, 'positions', ?, ?, ?, 0, ?, ?, ?)")
    .bind(id, t.key, freeText, t.type, question, JSON.stringify(chosen), pack.sha256 ?? null, JSON.stringify(pack), String(actor).slice(0, 200), now, now).run();
  await enqueue({ kind: "council_step", session_id: id, step: "positions" });
  return { ok: true, session_id: id, participants: chosen };
}

/** The owner writes to one seat or several (at most 2 answered per message, 4 per session). */
export async function ownerMessage(env, { session_id, text, to = [], actor = "owner", now = Date.now(), enqueue }) {
  const db = env.DB;
  await ensureSessionSchema(db);
  const s = await db.prepare("SELECT * FROM council_sessions WHERE id = ?").bind(session_id).first();
  if (!s) return { ok: false, error: "unknown session" };
  if (TERMINAL_STATES.includes(s.state)) return { ok: false, error: `the session is ${s.state}` };
  // A session on an empty pack cannot answer anything (2026-11-17): say so, and offer a re-open on fresh evidence.
  const packRefs = parse(s.pack_json, {})?.refs;
  if (!Array.isArray(packRefs) || !packRefs.length) return { ok: false, reopen: true, error: "this session has no evidence, so no agent can answer: re-open the topic with fresh evidence" };
  const n = await db.prepare("SELECT COUNT(*) AS n FROM council_messages WHERE session_id = ? AND round = 'owner'").bind(session_id).first();
  if (Number(n?.n) >= SESSION_LIMITS.owner_messages) return { ok: false, error: "the session's owner messages are used up" };
  const seats = parse(s.participants, []);
  const addressed = (Array.isArray(to) ? to : []).filter((x) => seats.includes(x)).slice(0, 2);
  if (!addressed.length) return { ok: false, error: "pick 1 or 2 agents to answer" };
  await db.prepare("INSERT INTO council_messages (session_id, round, seat, stance, opinion, proposal, reply_to, refs, ms) VALUES (?, 'owner', 'owner', NULL, ?, NULL, ?, NULL, ?)")
    .bind(session_id, clip(text, 1000), JSON.stringify(addressed), now).run();
  await enqueue({ kind: "council_step", session_id, step: "answer" });
  return { ok: true, answered_by: addressed, stale: now - Number(s.created_ms) > PACK_STALE_MS };
}

/** The owner's Close: the session ends (state "closed"); it frees an open slot and does not count toward the day. */
export async function closeSession(env, { session_id, actor = "owner", reason = "owner_closed", now = Date.now() }) {
  const db = env.DB;
  await ensureSessionSchema(db);
  const s = await db.prepare("SELECT id, state FROM council_sessions WHERE id = ?").bind(session_id).first();
  if (!s) return { ok: false, error: "unknown session" };
  if (TERMINAL_STATES.includes(s.state)) return { ok: false, error: `the session is already ${s.state}` };
  const r = await db.prepare(`UPDATE council_sessions SET state = 'closed', reason = ?, updated_ms = ? WHERE id = ? AND ${NOT_TERMINAL}`).bind(clip(`${reason} by ${actor}`, 200), now, session_id).run();
  if (!changed(r)) return { ok: false, error: "the session has just ended" };
  return { ok: true, session_id, state: "closed" };
}

/** The owner's Re-open: the same topic and seats on fresh evidence; the old session is closed once the new one starts. */
export async function reopenSession(env, { session_id, actor = "owner", now = Date.now(), enqueue }) {
  const db = env.DB;
  await ensureSessionSchema(db);
  const s = await db.prepare("SELECT id, topic_key, topic_text, type, state, participants FROM council_sessions WHERE id = ?").bind(session_id).first();
  if (!s) return { ok: false, error: "unknown session" };
  const free = String(s.topic_key ?? "").startsWith("free:") && s.topic_text;
  const r = await startSession(env, { topic_key: free ? null : s.topic_key, text: free ? s.topic_text : null, seats: parse(s.participants, []), actor, now, enqueue });
  if (!r?.ok) return r;
  if (!TERMINAL_STATES.includes(s.state)) await db.prepare(`UPDATE council_sessions SET state = 'closed', reason = ?, updated_ms = ? WHERE id = ? AND ${NOT_TERMINAL}`).bind(clip(`reopened as ${r.session_id} by ${actor}`, 200), now, session_id).run();
  return { ...r, reopened_from: session_id };
}

export const PROPOSAL_AGENT = "xauusd-moderator";
export const PROPOSAL_REPO = "cryptophys-adm/xauusd-ai-trading-assistant";

/** Pure: the typed_proposal.v1 report for an accepted option (docs/design/HAIC-H0-H1.md on the platform). */
export function proposalReport(p, { session, refs = [] } = {}) {
  const o = parse(p.option_json, {});
  const head = p.kind === "repository_task" ? "Council task for the evolution loop" : p.kind === "policy_parameter" ? "Council knob change (shadow test first)" : "Council decision: no change";
  return {
    kind: "xauusd_digest", severity: "info", ai_status: "model",
    subject: clip(`${head}: ${p.title ?? p.option_id}`, 200),
    body: {
      schema: "typed_proposal.v1", proposal_id: p.id, kind: p.kind, state: p.state, executor: p.kind === "repository_task" ? "cryptophys" : "xauusd",
      origin: { council: p.session_id, option_id: p.option_id, side: "nexus", repo: PROPOSAL_REPO, topic: session?.topic_key ?? null, question: session?.question ?? null },
      chosen_by: `owner:${p.accepted_by ?? "owner"}`, chosen_at: new Date(Number(p.accepted_ms)).toISOString(),
      title: o.title ?? null, hypothesis: o.hypothesis ?? null, change: o.change ?? null, risk: o.risk ?? null, dissent: o.dissent ?? null,
      ...(p.kind === "policy_parameter" ? { knob: p.knob, from: p.from_value, value: p.value } : {}),
      ...(p.kind === "repository_task" ? { spec: p.spec ?? o.change ?? null } : {}),
      evidence_refs: refs.slice(0, 12), source: "xauusd-ai-trading-assistant"
    }
  };
}

async function handOff(env, p, publish) {
  const db = env.DB;
  const session = await db.prepare("SELECT topic_key, question FROM council_sessions WHERE id = ?").bind(p.session_id).first();
  const rows = (await db.prepare("SELECT refs FROM council_messages WHERE session_id = ? AND round != 'owner'").bind(p.session_id).all()).results ?? [];
  const refs = [...new Set(rows.flatMap((r) => parse(r.refs, [])))];
  let r;
  try { r = await publish(env, PROPOSAL_AGENT, proposalReport(p, { session, refs })); } catch (e) { r = { outcome: "failed", reason: String(e?.message ?? e) }; }
  return r;
}

/**
 * The owner accepts one option of a session waiting for them. The session is decided; the proposal is stored and sent to
 * the platform (typed_proposal.v1): a repository_task is handed to the evolution loop there (Cryptophys builds it, not
 * an external party); a policy_parameter waits for its shadow test; no_change is recorded. A send that fails is retried.
 */
export async function acceptOption(env, { session_id, option_id, actor = "owner", now = Date.now(), publish = publishToPlatform }) {
  const db = env.DB;
  await ensureSessionSchema(db);
  const s = await db.prepare("SELECT id, state, options FROM council_sessions WHERE id = ?").bind(session_id).first();
  if (!s) return { ok: false, error: "unknown session" };
  if (s.state !== "awaiting_owner") return { ok: false, error: `only a session waiting for your pick can be accepted (this one is ${s.state})` };
  const opt = (parse(s.options, {})?.options ?? []).find((x) => x.option_id === option_id);
  if (!opt) return { ok: false, error: "unknown option" };
  const kind = OPTION_KINDS.includes(opt.kind) ? opt.kind : (opt.option_id === "no_change" ? "no_change" : "repository_task");
  // Re-check a knob change at acceptance: the engine may have moved since the synthesis.
  let knob = null, from = null, value = null, note = null;
  if (kind === "policy_parameter") {
    const k = checkKnobValue(opt.knob, opt.value, await readKnobOverrides(env, { now }));
    if (!k.ok) return { ok: false, error: `this knob change is no longer valid: ${k.error}` };
    knob = k.knob.id; from = k.from; value = k.value; note = "waits for its shadow test against today's setting (phase 2)";
  }
  const id = `cp_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const state = kind === "no_change" ? "closed" : kind === "policy_parameter" ? "queued_shadow" : "handoff_pending";
  const p = { id, session_id, option_id, kind, title: clip(opt.title, 120), knob, from_value: from, value, spec: kind === "repository_task" ? clip(opt.spec ?? opt.change, 800) : null,
    option_json: JSON.stringify(opt), state, note, accepted_by: clip(actor, 120), accepted_ms: now };
  // C1: the session is decided only while it still waits for the owner (a Close in between wins); then the proposal is stored.
  const decided = await db.prepare("UPDATE council_sessions SET state = 'decided', reason = ?, updated_ms = ? WHERE id = ? AND state = 'awaiting_owner'").bind(clip(`accepted ${option_id} by ${actor}`, 200), now, session_id).run();
  if (!changed(decided)) return { ok: false, error: "the session is no longer waiting for your pick" };
  await db.prepare("INSERT INTO council_proposals (id, session_id, option_id, kind, title, knob, from_value, value, spec, option_json, state, note, report_id, accepted_by, accepted_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)")
    .bind(p.id, p.session_id, p.option_id, p.kind, p.title, p.knob, p.from_value, p.value, p.spec, p.option_json, p.state, p.note, p.accepted_by, now, now).run();
  // The report carries the state the proposal has once the platform holds it (a code task: handed_off).
  const sent = await handOff(env, { ...p, state: kind === "repository_task" ? "handed_off" : state }, publish);
  const delivered = sent?.outcome === "success";
  const next = kind === "repository_task" ? (delivered ? "handed_off" : "handoff_pending") : state;
  await db.prepare("UPDATE council_proposals SET state = ?, report_id = ?, note = COALESCE(?, note), updated_ms = ? WHERE id = ?")
    .bind(next, delivered ? String(sent.report_id ?? "") || null : null, delivered ? null : clip(`platform send: ${sent?.reason ?? sent?.outcome ?? "failed"}; retried hourly`, 200), now, id).run();
  return { ok: true, proposal_id: id, kind, state: next, delivered };
}

/** Hourly: re-send repository_task proposals the platform has not received yet (a rate limit or a transport failure). */
export async function retryProposalHandoffs(env, { now = Date.now(), publish = publishToPlatform, limit = 3 } = {}) {
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  await ensureSessionSchema(db);
  const rows = (await db.prepare("SELECT * FROM council_proposals WHERE state = 'handoff_pending' ORDER BY accepted_ms LIMIT ?").bind(limit).all()).results ?? [];
  let sent = 0;
  for (const p of rows) {
    const r = await handOff(env, { ...p, state: "handed_off" }, publish);
    if (r?.outcome === "success") { sent += 1; await db.prepare("UPDATE council_proposals SET state = 'handed_off', report_id = ?, note = NULL, updated_ms = ? WHERE id = ?").bind(String(r.report_id ?? "") || null, now, p.id).run(); }
    else await db.prepare("UPDATE council_proposals SET note = ?, updated_ms = ? WHERE id = ?").bind(clip(`platform send: ${r?.reason ?? r?.outcome ?? "failed"}; retried hourly`, 200), now, p.id).run();
  }
  return { status: "ok", pending: rows.length, sent };
}

/** The accepted proposals for the page (newest first). */
export async function listProposals(env, { limit = 20 } = {}) {
  await ensureSessionSchema(env.DB);
  const rows = (await env.DB.prepare("SELECT id, session_id, option_id, kind, title, knob, from_value, value, spec, state, note, report_id, accepted_by, accepted_ms, updated_ms FROM council_proposals ORDER BY accepted_ms DESC LIMIT ?").bind(Math.min(50, Math.max(1, limit))).all()).results ?? [];
  // H3f-refs: ev_ref is the ref the owner's correction cites (POST /omega/api/correction target.ref).
  return { proposals: rows.map((r) => ({ ...r, accepted_at: new Date(Number(r.accepted_ms)).toISOString(), ev_ref: evRef("council_proposals", r.id) })) };
}

/** One step of a session (the queue consumer). */
export async function runSessionStep(env, { session_id, step }, { now = Date.now(), call = callBusModel, publish = publishToPlatform, enqueue }) {
  const db = env.DB;
  await ensureSessionSchema(db);
  const s = await db.prepare("SELECT * FROM council_sessions WHERE id = ?").bind(session_id).first();
  if (!s) return { status: "unknown" };
  // C1: a session that went terminal while this step ran (the owner's Close) stays as it is: the step stops quietly.
  const ended = { status: "ended" };
  const abort = async (reason) => {
    const r = await db.prepare(`UPDATE council_sessions SET state = 'aborted', reason = ?, updated_ms = ? WHERE id = ? AND ${NOT_TERMINAL}`).bind(clip(reason, 200), now, session_id).run();
    return changed(r) ? { status: "aborted", reason } : ended;
  };
  const keepCalls = async () => db.prepare(`UPDATE council_sessions SET calls = ? WHERE id = ? AND ${NOT_TERMINAL}`).bind(calls, session_id).run();
  if (TERMINAL_STATES.includes(s.state)) return { status: s.state };
  if (!(await sessionsEnabled(env))) return abort("council sessions were switched off");
  if ((await cfcNeuronsToday(db, now)) >= neuronCap(env)) return abort("the daily council budget is used up");
  const pack = parse(s.pack_json, {});
  const { text: packText, citable } = packForPrompt(pack);
  const packRefs = Array.isArray(pack?.refs) ? pack.refs : [];
  const seats = parse(s.participants, []);
  let calls = Number(s.calls) || 0;
  const rows = (await db.prepare("SELECT round, seat, stance, opinion, proposal, reply_to, ms FROM council_messages WHERE session_id = ? ORDER BY id").bind(session_id).all()).results ?? [];
  const spoken = rows.filter((r) => r.round !== "owner");
  const failed = {};
  const ask = async (seat, round, extra = {}) => {
    // One call stays reserved for the synthesis until it is written.
    if (calls >= SESSION_LIMITS.calls - (s.state === "awaiting_owner" ? 0 : 1)) { failed[seat] = "the session's 16 calls are used up"; return null; }
    calls += 1;
    try {
      // An answer to the owner gets a larger budget: on 2026-11-17 one was cut off at 700 tokens and lost.
      const r = await call(env, { messages: seatMessages({ seat, session: s, pack: packText, earlier: spoken, round, citable, ...extra }), schemaName: "cfc_seat", schema: SEAT_SCHEMA, maxTokens: round === "answer" ? 1400 : 700, effort: "low", deadline: Date.now() + 60_000, clock: () => Date.now(), runState: {}, role: "agent", meterSource: `cfc:${round}` });
      const m = r?.status === "answered" ? cleanSeat(r.obj, packRefs) : null;
      if (!m) failed[seat] = r?.status === "answered" ? "its reply was not a valid opinion" : "its reply was cut off or the model call failed";
      return m;
    } catch { failed[seat] = "the model call failed"; return null; }
  };
  const save = async (seat, round, m) => db.prepare("INSERT INTO council_messages (session_id, round, seat, stance, opinion, proposal, reply_to, refs, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(session_id, round, seat, m.stance, m.opinion, m.proposal, JSON.stringify(m.reply_to ?? []), JSON.stringify(m.refs ?? []), now).run();
  const advance = async (state, next) => {
    const r = await db.prepare(`UPDATE council_sessions SET state = ?, calls = ?, updated_ms = ? WHERE id = ? AND ${NOT_TERMINAL}`).bind(state, calls, now, session_id).run();
    if (!changed(r)) return false;
    if (next) await enqueue({ kind: "council_step", session_id, step: next });
    return true;
  };

  if (step === "positions") {
    const out = await Promise.all(seats.map(async (seat) => [seat, await ask(seat, "position")]));
    const ok = out.filter(([, m]) => m);
    for (const [seat, m] of ok) await save(seat, "position", m);
    if (ok.length < 3) { await keepCalls(); return abort(`only ${ok.length} seats gave a valid opinion`); }
    if (!(await advance("rebuttals", "rebuttals"))) return ended;
    return { status: "positions", spoke: ok.length };
  }
  if (step === "rebuttals") {
    const pos = spoken.filter((r) => r.round === "position");
    const count = {}; for (const p of pos) count[p.stance] = (count[p.stance] ?? 0) + 1;
    const majority = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0];
    const dissent = pos.filter((p) => p.stance !== majority).map((p) => p.seat);
    const speakers = [...new Set([...dissent, pos.find((p) => p.stance === majority)?.seat, seats.includes("risk") ? "risk" : null].filter(Boolean))].slice(0, SESSION_LIMITS.rebuttals);
    const out = await Promise.all(speakers.map(async (seat) => [seat, await ask(seat, "rebuttal")]));
    for (const [seat, m] of out) if (m) await save(seat, "rebuttal", m);
    if (!(await advance("synthesis", "synthesis"))) return ended;
    return { status: "rebuttals", spoke: out.filter(([, m]) => m).length };
  }
  if (step === "synthesis") {
    if (calls >= SESSION_LIMITS.calls) return abort("the session's calls are used up before the synthesis");
    calls += 1;
    let syn = null;
    let live = {};
    try { live = await readKnobOverrides(env, { now }); } catch { live = {}; }
    try {
      const msgs = [
        { role: "system", content: ["You are the moderator of an XAUUSD trading system's council. You never vote. Read what each member said and write a short summary of the views, then 2 to 5 ranked options the owner can pick from; one option_id must be \"no_change\" with kind no_change.",
          "Each option: a title, the hypothesis, the concrete change, its risk, who dissents, and a kind.",
          "kind policy_parameter: the change is one of the listed knobs set to a new value inside its bounds (give knob and value); it is tested in shadow against today's setting and goes live only if it proves better. Prefer this kind whenever a listed knob can express the idea.",
          "kind repository_task: the change needs new code (a new filter, rule or agent); give spec: what to build, where it applies, and how to measure that it helped. The system builds it itself.",
          "Never quote a price. The owner accepts one option; nothing changes trading until then."].join(" ") },
        { role: "user", content: JSON.stringify({ knobs: knobMenu(live), question: s.question, topic: s.topic_key, said: spoken.map((m) => ({ seat: m.seat, round: m.round, stance: m.stance, opinion: m.opinion, proposal: m.proposal })), owner: rows.filter((r) => r.round === "owner").map((r) => r.opinion) }) }
      ];
      const r = await call(env, { messages: msgs, schemaName: "cfc_synthesis", schema: SYNTHESIS_SCHEMA, maxTokens: 1500, effort: "medium", deadline: Date.now() + 90_000, clock: () => Date.now(), runState: {}, role: "moderator", meterSource: "cfc:synthesis" });
      syn = r?.status === "answered" ? cleanOptions(r.obj, live) : null;
    } catch { syn = null; }
    if (!syn) { await keepCalls(); return abort("the moderator gave no valid synthesis"); }
    const moved = await db.prepare(`UPDATE council_sessions SET state = 'awaiting_owner', options = ?, calls = ?, updated_ms = ? WHERE id = ? AND ${NOT_TERMINAL}`).bind(JSON.stringify(syn), calls, now, session_id).run();
    // C1: closed during the synthesis: no awaiting_owner, and no council_decision.v1 for a closed session.
    if (!changed(moved)) return ended;
    // The pick is made in Cerebrum (HAIC Q6): the options go to the platform's inbox. Best effort.
    try {
      await publish(env, "xauusd-moderator", { kind: "xauusd_digest", severity: "info", subject: clip(`Council: ${s.topic_text ?? s.topic_key}`, 200), ai_status: "model",
        body: { schema: "council_decision.v1", session_id, topic: s.topic_key, question: s.question, summary: syn.summary, options: syn.options, participants: seats, source: "xauusd-ai-trading-assistant" } });
    } catch { /* the session stands; the owner sees it in Nexus */ }
    return { status: "awaiting_owner", options: syn.options.length };
  }
  if (step === "answer") {
    const answered = spoken.filter((r) => r.round === "answer").length;
    const lastOwner = [...rows].reverse().find((r) => r.round === "owner");
    const to = parse(lastOwner?.reply_to, []);
    const room = Math.max(0, SESSION_LIMITS.answers - answered);
    const out = await Promise.all(to.slice(0, room).map(async (seat) => [seat, await ask(seat, "answer", { ownerText: lastOwner?.opinion })]));
    for (const [seat, m] of out) {
      if (m) await save(seat, "answer", m);
      // A seat that could not answer leaves a visible notice, never silence (2026-11-17).
      else await db.prepare("INSERT INTO council_messages (session_id, round, seat, stance, opinion, proposal, reply_to, refs, ms) VALUES (?, 'notice', ?, NULL, ?, NULL, '[]', '[]', ?)")
        .bind(session_id, seat, clip(`${roster()[seat]?.name ?? seat} could not answer: ${failed[seat] ?? "no reply"}. Nothing was stored; ask again or re-open the topic.`, 300), now).run();
    }
    if (to.length > room) await db.prepare("INSERT INTO council_messages (session_id, round, seat, stance, opinion, proposal, reply_to, refs, ms) VALUES (?, 'notice', 'system', NULL, ?, NULL, '[]', '[]', ?)")
      .bind(session_id, `The session's ${SESSION_LIMITS.answers} answers are used up; re-open the topic to ask more.`, now).run();
    await db.prepare(`UPDATE council_sessions SET calls = ?, updated_ms = ? WHERE id = ? AND ${NOT_TERMINAL}`).bind(calls, now, session_id).run();
    return { status: "answered", answers: out.filter(([, m]) => m).length };
  }
  return { status: "unknown_step" };
}

/** The sessions for the page (newest first) and one session with its messages. */
/**
 * An option's ref (H3f-refs), or null when POST /omega/api/correction would refuse it: option_id is model-written, so
 * a field the route cannot parse (a "-" or ":"), one ending in a price word (tighten_stop) or one carrying a 3+ digit
 * number gets no ref rather than one the control cannot send. The session's own ref still covers the verdict.
 */
export function optionRef(sessionId, optionId) {
  if (/\d{3,}/.test(String(optionId ?? ""))) return null;
  const ref = evRef("council_sessions", sessionId, { field: `options.${optionId}` });
  const parsed = parseRef(ref);
  return parsed && !refCarriesPrice(parsed) ? ref : null;
}

export async function listSessions(env, { limit = 20 } = {}) {
  await ensureSessionSchema(env.DB);
  const rows = (await env.DB.prepare("SELECT id, topic_key, topic_text, type, question, state, participants, calls, reason, created_ms, updated_ms, COALESCE(json_array_length(json_extract(pack_json, '$.refs')), 0) AS pack_refs FROM council_sessions ORDER BY created_ms DESC LIMIT ?").bind(Math.min(50, Math.max(1, limit))).all()).results ?? [];
  const now = Date.now();
  return { enabled: await sessionsEnabled(env), mode: cfcMode(env), limits: SESSION_LIMITS, sessions: rows.map((r) => ({ ...r, participants: parse(r.participants, []), created_at: new Date(Number(r.created_ms)).toISOString(), pack_stale: Number(r.pack_refs) === 0 || now - Number(r.created_ms) > PACK_STALE_MS, ev_ref: evRef("council_sessions", r.id) })) };
}
export async function readSession(env, id) {
  await ensureSessionSchema(env.DB);
  const s = await env.DB.prepare("SELECT id, topic_key, topic_text, type, question, state, participants, calls, options, reason, pack_hash, created_by, created_ms, updated_ms, COALESCE(json_array_length(json_extract(pack_json, '$.refs')), 0) AS pack_refs FROM council_sessions WHERE id = ?").bind(id).first();
  if (!s) return null;
  const names = roster();
  const msgs = (await env.DB.prepare("SELECT id, round, seat, stance, opinion, proposal, reply_to, refs, ms FROM council_messages WHERE session_id = ? ORDER BY id").bind(id).all()).results ?? [];
  // H3f-refs: the refs the owner's correction cites (POST /omega/api/correction target.ref), built on read.
  const options = parse(s.options, null);
  const withRefs = options && typeof options === "object" && Array.isArray(options.options)
    ? { ...options, options: options.options.map((o) => (o && typeof o === "object" ? { ...o, ev_ref: optionRef(s.id, o.option_id) } : o)) }
    : options;
  return { ...s, pack_stale: Number(s.pack_refs) === 0 || Date.now() - Number(s.created_ms) > PACK_STALE_MS, terminal: TERMINAL_STATES.includes(s.state),
    participants: parse(s.participants, []).map((x) => ({ id: x, ...(names[x] ?? { name: x, role: "" }) })), options: withRefs,
    messages: msgs.map((m) => ({ ...m, name: m.seat === "owner" ? "Owner" : names[m.seat]?.name ?? m.seat, reply_to: parse(m.reply_to, []), refs: parse(m.refs, []), at: new Date(Number(m.ms)).toISOString(), ev_ref: evRef("council_messages", m.id) })),
    ev_ref: evRef("council_sessions", s.id) };
}
