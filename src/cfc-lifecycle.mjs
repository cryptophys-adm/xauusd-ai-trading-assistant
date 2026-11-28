// Call for Councils, CFC-A PR1 (A1 + A4; the orchestrator's brief of 2026-11-28, answered the same day): the owner
// approves topics, a decided proposal that never starts its follow-up expires, and one archive shows each topic's
// chain (topic -> session -> proposal) with one authoritative status and who acts next.
//
// A1. The owner approves or rejects a suggested topic (D1 cfc_suggestions, src/cfc-triggers.mjs). Approval starts the
// session at once, on a fresh evidence pack (startSession, src/cfc-session.mjs); the owner's sessions switch and
// CFC_MODE ("on" or "auto") still gate it, and a refused start leaves the suggestion open. A suggestion past its
// expiry (48 h after it was last seen, never past 7 days after it was made) cannot be approved. A decision carries
// an idempotency key: the same key and decision again answer with the stored result; any other decision on a decided
// suggestion is refused with code "already_decided" or "expired" (HTTP 409 through the Omega Worker).
//
// A4. In CFC_MODE "auto" only, a decided proposal that has not started its follow-up within 7 days expires: a
// repository task never delivered to the platform (still handoff_pending). A knob change in its shadow test has
// started (queued_shadow counts as started). GET /api/council/archive reads the chains; nothing here changes trading.
import { ensureCfcSchema, effectiveStatus, suggestionExpiry, cfcAutoMode, SUGGESTION_STATUSES } from "./cfc-triggers.mjs";
import { ensureSessionSchema, startSession, TERMINAL_STATES } from "./cfc-session.mjs";
import { platformStates } from "./council-decisions.mjs";

export const DECISIONS = Object.freeze(["approve", "reject"]);
/** A decided proposal with no follow-up after this long expires (CFC_MODE "auto"). */
export const PROPOSAL_FOLLOWUP_MS = 7 * 86_400_000;
/** The archive reads this far back, at most ARCHIVE_READ rows per table, and pages ARCHIVE_PAGE chains at a time. */
export const ARCHIVE_DAYS = 90;
export const ARCHIVE_READ = 300;
export const ARCHIVE_PAGE = Object.freeze({ default: 20, max: 50 });
/** Who acts next on a chain. */
export const NEXT_ACTORS = Object.freeze(["owner", "council", "platform", "shadow", "none"]);
/** The chain statuses, in the order a chain can pass them (platform states pass through as they come). */
export const CHAIN_STATUSES = Object.freeze(["awaiting_approval", "approved", "rejected", "expired", "in_session", "awaiting_pick", "decided", "closed", "aborted",
  "no_change", "shadow_test", "live", "rolled_back", "superseded", "veto_window", "vetoed", "handoff_pending", "handed_off"]);
/** CFC-A PR2: the archive's scopes. active: a chain someone still acts on (next_actor not "none"); archive: the rest. */
export const ARCHIVE_SCOPES = Object.freeze(["active", "archive"]);
const PLATFORM_TERMINAL = Object.freeze(["rejected", "closed", "refused", "unfit", "reverted", "expired", "deployed", "deployed_unmeasured"]);
const RUNNING = Object.freeze(["positions", "rebuttals", "synthesis"]);

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const parse = (s, fb = null) => { try { return s == null ? fb : JSON.parse(s); } catch { return fb; } };
const changed = (r) => Number(r?.meta?.changes) > 0;
const toMs = (t) => (typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN);
const msIso = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? iso(Number(ms)) : null);
/** An idempotency key: printable, at most 64 characters; anything else counts as none. */
export const cleanKey = (k) => (typeof k === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(k.trim()) ? k.trim() : null);

const SUGGESTION_COLS = "id, topic_key, type, rule, status, created_at, last_seen_at, expires_at, decided_at, decided_by, session_id, decision_key";

/** Pure: the suggestion as the decide route answers it (no signal, no fingerprint). */
export function suggestionView(row, now = Date.now()) {
  if (!row) return null;
  return { id: Number(row.id), topic_key: row.topic_key, type: row.type, rule: row.rule, status: effectiveStatus(row, now),
    created_at: row.created_at, expires_at: row.expires_at ?? suggestionExpiry(row.created_at, row.last_seen_at),
    decided_at: row.decided_at ?? null, decided_by: row.decided_by ?? null, session_id: row.session_id ?? null };
}

/** The refusal for a suggestion that is no longer open. */
function refusal(row, now) {
  const st = effectiveStatus(row, now);
  const code = st === "expired" ? "expired" : "already_decided";
  return { ok: false, code, http_status: 409, error: code === "expired" ? "this suggestion has expired" : `this suggestion is already ${st}`, suggestion: suggestionView(row, now) };
}

/**
 * CFC-A1: the owner's decision on a suggested topic. `decision` approve | reject. `actor` is stored as "owner" (the
 * person's identity is checked by the Omega Worker and the RPC, and never stored here). Never throws on bad input.
 */
export async function decideSuggestion(env, { suggestion_id, decision, idempotency_key = null, now = Date.now(), enqueue, start = startSession } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, code: "unavailable", error: "unavailable" };
  const id = Number(suggestion_id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: "bad_request", http_status: 400, error: "suggestion_id must be a positive integer" };
  if (!DECISIONS.includes(decision)) return { ok: false, code: "bad_request", http_status: 400, error: "decision must be approve or reject" };
  const key = cleanKey(idempotency_key);
  await ensureCfcSchema(db);
  const read = () => db.prepare(`SELECT ${SUGGESTION_COLS} FROM cfc_suggestions WHERE id = ?`).bind(id).first();
  let row = await read();
  if (!row) return { ok: false, code: "not_found", http_status: 404, error: "unknown suggestion" };
  const target = decision === "approve" ? "approved" : "rejected";
  const replay = (r) => (key && r.decision_key === key && r.status === target ? { ok: true, replay: true, decision, suggestion_id: id, session_id: r.session_id ?? null, suggestion: suggestionView(r, now) } : null);
  if (effectiveStatus(row, now) !== "open") {
    // An open row past its expiry is marked expired now (the hourly run would do the same).
    if (row.status === "open") await db.prepare("UPDATE cfc_suggestions SET status = 'expired', decided_at = ?, decided_by = 'system' WHERE id = ? AND status = 'open'").bind(iso(now), id).run();
    row = (await read()) ?? row;
    return replay(row) ?? refusal(row, now);
  }
  const at = iso(now);
  // Claim the row first (only while it is open and unexpired), so two clicks cannot start two sessions.
  const claim = await db.prepare("UPDATE cfc_suggestions SET status = ?, decided_at = ?, decided_by = 'owner', decision_key = ? WHERE id = ? AND status = 'open' AND (expires_at IS NULL OR expires_at > ?)")
    .bind(target, at, key, id, at).run();
  if (!changed(claim)) { row = (await read()) ?? row; return replay(row) ?? refusal(row, now); }
  if (decision === "reject") return { ok: true, decision, suggestion_id: id, session_id: null, suggestion: suggestionView(await read(), now) };
  let r;
  try { r = await start(env, { topic_key: row.topic_key, actor: "owner", now, enqueue }); } catch (e) { r = { ok: false, error: String(e?.message ?? e).slice(0, 200) }; }
  if (!r?.ok) {
    // The session did not start (the switch, a limit, no evidence): the suggestion stays open for another try.
    await db.prepare("UPDATE cfc_suggestions SET status = 'open', decided_at = NULL, decided_by = NULL, decision_key = NULL WHERE id = ? AND status = 'approved' AND session_id IS NULL").bind(id).run();
    return { ok: false, code: "session_refused", http_status: 409, error: r?.error ?? "the session did not start", suggestion: suggestionView(await read(), now) };
  }
  await db.prepare("UPDATE cfc_suggestions SET session_id = ? WHERE id = ?").bind(r.session_id, id).run();
  return { ok: true, decision, suggestion_id: id, session_id: r.session_id, participants: r.participants ?? [], suggestion: suggestionView(await read(), now) };
}

/**
 * CFC-A4, hourly, CFC_MODE "auto" only: a repository task the platform never received (handoff_pending) within 7 days of
 * its decision expires and is no longer re-sent. A knob change has started its follow-up (queued_shadow or later).
 */
export async function expireStaleProposals(env, { now = Date.now() } = {}) {
  if (!cfcAutoMode(env)) return { status: "off" };
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  try {
    await ensureSessionSchema(db);
    const r = await db.prepare("UPDATE council_proposals SET state = 'expired', note = ?, updated_ms = ? WHERE state = 'handoff_pending' AND accepted_ms <= ?")
      .bind("expired: no follow-up started within 7 days of the decision", now, now - PROPOSAL_FOLLOWUP_MS).run();
    return { status: "ok", expired: Number(r?.meta?.changes) || 0 };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Pure: a chain's authoritative status, where it came from, and who acts next. */
export function chainState({ suggestion = null, session = null, proposal = null, platform = null, now = Date.now() } = {}) {
  if (proposal) {
    const st = proposal.state;
    if (st === "handed_off") {
      const ps = platform?.state ?? null;
      if (!ps) return { status: "handed_off", source: "proposal", next_actor: "platform" };
      return { status: ps, source: "platform", next_actor: PLATFORM_TERMINAL.includes(ps) ? "none" : "platform" };
    }
    if (st === "closed") return { status: "no_change", source: "proposal", next_actor: "none" };
    if (st === "queued_shadow" || st === "shadow") return { status: "shadow_test", source: "proposal", next_actor: "shadow" };
    // A live knob is still watched by its rollback check.
    if (st === "live") return { status: "live", source: "proposal", next_actor: "shadow" };
    if (st === "handoff_pending") return { status: "handoff_pending", source: "proposal", next_actor: "platform" };
    // CFC-A2: a council-picked task waits for the owner's veto (Close) before its hand-off; a vetoed one ends there.
    if (st === "veto_window") return { status: "veto_window", source: "proposal", next_actor: "owner" };
    if (st === "vetoed") return { status: "vetoed", source: "proposal", next_actor: "none" };
    return { status: st, source: "proposal", next_actor: "none" };
  }
  if (session) {
    const st = session.state;
    if (RUNNING.includes(st)) return { status: "in_session", source: "session", next_actor: "council" };
    if (st === "awaiting_owner") return { status: "awaiting_pick", source: "session", next_actor: "owner" };
    return { status: st, source: "session", next_actor: "none" };
  }
  if (suggestion) {
    const st = effectiveStatus(suggestion, now);
    if (st === "open") return { status: "awaiting_approval", source: "suggestion", next_actor: "owner" };
    if (st === "approved") return { status: "approved", source: "suggestion", next_actor: "council" };
    return { status: st, source: "suggestion", next_actor: "none" };
  }
  return { status: "unknown", source: null, next_actor: "none" };
}

/** Pure: a session's progress from its message counts ({ round, stance, n } rows; rounds position, rebuttal, answer, owner). */
export function sessionProgress(session, counts = []) {
  const seats = parse(session?.participants, []);
  const by = (round) => counts.filter((c) => c.round === round).reduce((a, c) => a + (Number(c.n) || 0), 0);
  const tally = { support: 0, oppose: 0, amend: 0, abstain: 0 };
  for (const c of counts) if (c.round === "position" && c.stance in tally) tally[c.stance] += Number(c.n) || 0;
  const options = parse(session?.options, null);
  return {
    step: session?.state ?? null,
    positions: { done: by("position"), expected: Array.isArray(seats) ? seats.length : 0 },
    rebuttals: by("rebuttal"), answers: by("answer"), owner_messages: by("owner"),
    synthesis: Array.isArray(options?.options) ? options.options.length : 0,
    // The stances the seats took in their opening positions; the per-option tally comes with the council's own pick (PR2).
    tally
  };
}

const sessionView = (s, counts) => s && ({
  id: s.id, topic_key: s.topic_key, topic_text: s.topic_text ?? null, type: s.type, state: s.state, terminal: TERMINAL_STATES.includes(s.state),
  created_at: msIso(s.created_ms), updated_at: msIso(s.updated_ms), started_by: String(s.created_by ?? "").startsWith("council") ? "council" : "owner",
  reason: s.reason ? clip(s.reason.replace(/\S+@\S+/g, "owner"), 200) : null,
  reopened_as: /^reopened as (\S+)/.exec(String(s.reason ?? ""))?.[1] ?? null,
  progress: sessionProgress(s, counts)
});
const proposalView = (p, ps) => p && ({
  id: p.id, kind: p.kind, title: p.title ?? null, state: p.state, knob: p.knob ?? null, from: p.from_value ?? null, value: p.value ?? null,
  decided_by: String(p.accepted_by ?? "").startsWith("council") ? "council" : "owner", decided_at: msIso(p.accepted_ms), updated_at: msIso(p.updated_ms), note: p.note ?? null,
  // CFC-A2: the council's own pick, its rationale and the seat tally (null for the owner's pick).
  council_decision: parse(p.decision_json, null),
  platform: ps ? { state: ps.state, at: ps.at ?? null, reason: ps.reason ?? null, close_code: ps.refs?.close_code ?? null, history: ps.history ?? [] } : null
});

/**
 * GET /api/council/archive?cursor=&limit=: every topic's chain (topic -> session -> proposal), newest change first, each
 * with one authoritative status and the next actor. Reads the last 90 days, bounded per table; pages by an offset
 * cursor. A session the owner opened on free text or a topic of their own has no suggestion: its topic is the session's.
 */
export async function readCouncilArchive(env, { cursor = null, limit = ARCHIVE_PAGE.default, scope = null, status = null, now = Date.now() } = {}) {
  const db = env.DB;
  await ensureCfcSchema(db);
  await ensureSessionSchema(db);
  const since = now - ARCHIVE_DAYS * DAY;
  const sugg = (await db.prepare(`SELECT ${SUGGESTION_COLS} FROM cfc_suggestions WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`).bind(iso(since), ARCHIVE_READ).all()).results ?? [];
  const sess = (await db.prepare("SELECT id, topic_key, topic_text, type, state, participants, options, reason, created_by, created_ms, updated_ms FROM council_sessions WHERE created_ms >= ? ORDER BY created_ms DESC LIMIT ?").bind(since, ARCHIVE_READ).all()).results ?? [];
  const props = (await db.prepare("SELECT id, session_id, kind, title, knob, from_value, value, state, note, accepted_by, accepted_ms, updated_ms, decision_json FROM council_proposals WHERE accepted_ms >= ? ORDER BY accepted_ms DESC LIMIT ?").bind(since, ARCHIVE_READ).all()).results ?? [];
  const sessById = new Map(sess.map((s) => [s.id, s]));
  const propBySession = new Map();
  for (const p of props) if (!propBySession.has(p.session_id)) propBySession.set(p.session_id, p);
  const chains = [];
  const linked = new Set();
  for (const g of sugg) {
    const s = g.session_id ? sessById.get(g.session_id) ?? null : null;
    if (s) linked.add(s.id);
    chains.push({ chain_id: `suggestion:${g.id}`, suggestion: g, session: s });
  }
  for (const s of sess) if (!linked.has(s.id)) chains.push({ chain_id: `session:${s.id}`, suggestion: null, session: s });
  for (const c of chains) {
    c.proposal = c.session ? propBySession.get(c.session.id) ?? null : null;
    const times = [toMs(c.suggestion?.decided_at), toMs(c.suggestion?.last_seen_at), toMs(c.suggestion?.created_at), Number(c.session?.updated_ms), Number(c.proposal?.updated_ms)].filter(Number.isFinite);
    c.updated_ms = times.length ? Math.max(...times) : 0;
  }
  chains.sort((a, b) => b.updated_ms - a.updated_ms || a.chain_id.localeCompare(b.chain_id));
  // CFC-A PR2: every chain's status first (the platform's latest state for each handed-off task, one bounded read), so
  // the counts cover the whole window and scope / status filter before the page is cut.
  const handed = chains.map((c) => c.proposal).filter((p) => p && p.state === "handed_off").map((p) => p.id);
  const platform = handed.length ? await platformStates(env, handed) : {};
  for (const c of chains) c.state = chainState({ suggestion: c.suggestion, session: c.session, proposal: c.proposal, platform: c.proposal ? platform[c.proposal.id] ?? null : null, now });
  const counts = { total: chains.length, active: 0, archive: 0, by_status: {}, by_next_actor: {} };
  for (const c of chains) {
    counts[c.state.next_actor === "none" ? "archive" : "active"] += 1;
    counts.by_status[c.state.status] = (counts.by_status[c.state.status] ?? 0) + 1;
    counts.by_next_actor[c.state.next_actor] = (counts.by_next_actor[c.state.next_actor] ?? 0) + 1;
  }
  const sc = ARCHIVE_SCOPES.includes(scope) ? scope : null;
  const want = typeof status === "string" && /^[a-z_]{1,40}$/.test(status) ? status : null;
  const shown = chains.filter((c) => (!sc || (sc === "active") === (c.state.next_actor !== "none")) && (!want || c.state.status === want));
  const size = Math.min(ARCHIVE_PAGE.max, Math.max(1, Number(limit) || ARCHIVE_PAGE.default));
  const offset = Math.max(0, Number.parseInt(String(cursor ?? "0"), 10) || 0);
  const page = shown.slice(offset, offset + size);
  // Only the page's sessions and proposals are read further: message counts and the platform's latest state.
  const sids = page.map((c) => c.session?.id).filter(Boolean);
  const msgCounts = new Map();
  if (sids.length) {
    const rows = (await db.prepare(`SELECT session_id, round, stance, COUNT(*) AS n FROM council_messages WHERE session_id IN (${sids.map(() => "?").join(",")}) GROUP BY session_id, round, stance`).bind(...sids).all()).results ?? [];
    for (const r of rows) (msgCounts.get(r.session_id) ?? msgCounts.set(r.session_id, []).get(r.session_id)).push(r);
  }
  const items = page.map((c) => {
    const ps = c.proposal ? platform[c.proposal.id] ?? null : null;
    const st = c.state;
    const g = c.suggestion;
    const topicKey = g?.topic_key ?? c.session?.topic_key ?? null;
    return {
      chain_id: c.chain_id, status: st.status, status_source: st.source, next_actor: st.next_actor, updated_at: msIso(c.updated_ms),
      topic: { key: topicKey, type: g?.type ?? c.session?.type ?? null, origin: g ? "suggestion" : "owner",
        ...(g ? { suggestion_id: Number(g.id), rule: g.rule, status: effectiveStatus(g, now), created_at: g.created_at, expires_at: g.expires_at ?? suggestionExpiry(g.created_at, g.last_seen_at), decided_at: g.decided_at ?? null, decided_by: g.decided_by ?? null } : {}) },
      session: sessionView(c.session, msgCounts.get(c.session?.id) ?? []),
      proposal: proposalView(c.proposal, ps)
    };
  });
  return {
    items, next_cursor: offset + size < shown.length ? String(offset + size) : null, total: shown.length, window_days: ARCHIVE_DAYS,
    scope: sc, status_filter: want, counts,
    vocab: { chain_status: CHAIN_STATUSES, platform_states: "a handed-off task shows the platform's latest state (council_proposal_updates)", next_actor: NEXT_ACTORS, suggestion_status: SUGGESTION_STATUSES,
      close_code: "the platform's short code for why a task reached a terminal state, passed through as sent", decided_by: ["owner", "council", "system", "legacy"], scope: ARCHIVE_SCOPES },
    as_of: iso(now)
  };
}
