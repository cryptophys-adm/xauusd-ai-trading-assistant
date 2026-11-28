// CF2, the Call for Councils page's one adapter (the owner approved the mockup on 2026-11-28, "approved"; the API is
// CFC-A PR1, #677). Every field the page reads from the council routes is read here, and only here, so a rename in the
// API touches this file alone:
//   GET /api/council/suggestions   suggestionsOf   (status open | approved | rejected | expired, expires_at)
//   GET /api/council/sessions      sessionsOf
//   GET /api/council/session?id=   detailOf, seatsOf
//   GET /api/council/archive       archiveOf, mergeArchive, splitArchive, archivePath (cursor paging, items, vocab)
//   POST /omega/api/council        decideRequest, decideResult (action "decide", the idempotency key, 409 codes)
// Pure and null-safe: any body, null included, gives a view (empty lists, nulls), never a throw. No price and no email:
// the routes send no price, and a session's reason (the owner's Access email on a close or a re-open) is masked here.

export type Tone = "ok" | "late" | "fault" | "off" | "shadow" | "plain";

const H = 3_600_000, M = 60_000;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const ms = (iso: unknown): number | null => { const t = typeof iso === "string" ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

/** Any email in a server text, as "owner" (the archive masks the same way: src/cfc-lifecycle.mjs sessionView). */
export const maskEmail = (s: unknown): string | null => (str(s) ? String(s).replace(/\S+@\S+/g, "owner") : null);

// ------------------------------------------------------------------ status tones (the approved mockup's rule)
// ok cyan: approved, decided, live, merged, deployed. late amber: open, expiring, running, in progress, queued, proposed.
// fault red: refused, rolled back, aborted. off grey: expired, closed, rejected, handed off, none. shadow violet.
// No green: an outcome is neutral. Platform states pass through as the platform sends them (council.decisions.read).
const TONES: Record<string, Tone> = {
  approved: "ok", decided: "ok", live: "ok", merged: "ok", deployed: "ok", deployed_unmeasured: "ok",
  open: "late", awaiting_approval: "late", expiring: "late", running: "late", in_session: "late", awaiting_pick: "late", awaiting_owner: "late",
  positions: "late", rebuttals: "late", synthesis: "late", in_progress: "late", queued_external: "late", waiting_external: "late", proposed: "late",
  handoff_pending: "late", received: "late", queued: "late",
  refused: "fault", rolled_back: "fault", aborted: "fault", unfit: "fault", reverted: "fault",
  expired: "off", closed: "off", rejected: "off", handed_off: "off", none: "off", no_change: "off", superseded: "off",
  shadow: "shadow", shadow_test: "shadow", queued_shadow: "shadow"
};
export const toneOf = (status: unknown): Tone => TONES[String(status ?? "")] ?? "plain";

/** A chain or step status as its chip says it: the code, with the few the mockup words differently. */
const STATUS_TEXT: Record<string, string> = {
  awaiting_approval: "open", in_session: "running", awaiting_pick: "awaiting pick", awaiting_owner: "awaiting pick", shadow_test: "shadow",
  queued_shadow: "shadow", no_change: "no change", positions: "running", rebuttals: "running", synthesis: "running"
};
export const statusText = (status: unknown): string => STATUS_TEXT[String(status ?? "")] ?? (str(status) ?? "—");

/** A running session's step, in words. */
const STEP_TEXT: Record<string, string> = { positions: "opinions", rebuttals: "responses", synthesis: "options" };
export const stepText = (state: unknown): string | null => STEP_TEXT[String(state ?? "")] ?? null;
const RUNNING = ["positions", "rebuttals", "synthesis"];
const TERMINAL = ["aborted", "expired", "decided", "closed"];

// ------------------------------------------------------------------ times: UTC and the owner's GMT+7
const two = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const clock = (t: number) => { const d = new Date(t); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
/** "15:30 UTC · 22:30 GMT+7" on the day of `now` (UTC), else "27 Nov 06:40 UTC · 13:40 GMT+7"; "—" for no time. */
export function whenText(iso: unknown, now: number | null = null): string {
  const t = typeof iso === "number" ? iso : ms(iso);
  if (t == null) return "—";
  const d = new Date(t);
  const same = now != null && new Date(now).toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
  return `${same ? "" : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} `}${clock(t)} UTC · ${clock(t + 7 * H)} GMT+7`;
}
/** "3h 12m", "42m", "2d 4h". */
export function spanText(span: number): string {
  const m = Math.max(0, Math.floor(span / M));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${two(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
/** "23h ago", "3d ago". */
export function agoText(iso: unknown, now: number): string {
  const t = ms(iso);
  if (t == null) return "—";
  const s = Math.max(0, now - t);
  return s < H ? `${Math.floor(s / M)}m ago` : s < 48 * H ? `${Math.floor(s / H)}h ago` : `${Math.floor(s / (24 * H))}d ago`;
}

// ------------------------------------------------------------------ suggestions
export type Countdown = { left: string; soon: boolean; remaining: number; at: string; tone: Tone };
/**
 * The countdown of an open suggestion: from its created_at to its expires_at (#677: 48 h after last seen, at most 7 days
 * after made). Late amber under 1 h; `remaining` is the share of the span still left (the bar's width, 0 to 1).
 */
export function countdownOf(createdAt: unknown, expiresAt: unknown, now: number): Countdown | null {
  const start = ms(createdAt), end = ms(expiresAt);
  if (end == null) return null;
  const left = end - now;
  const span = start != null && end > start ? end - start : null;
  const remaining = span ? Math.min(1, Math.max(0, left / span)) : left > 0 ? 1 : 0;
  const soon = left < H;
  return { left: spanText(left), soon, remaining, at: whenText(end, now), tone: soon ? "late" : "plain" };
}

export type Suggestion = {
  id: number | null; topicKey: string; type: string; rule: string; status: string; tone: Tone; summary: string | null;
  createdAt: string | null; lastSeenAt: string | null; expiresAt: string | null; decidedAt: string | null; decidedBy: string | null;
  sessionId: string | null; countdown: Countdown | null; chainId: string | null;
};
export function suggestionOf(x: any, now: number): Suggestion {
  const s = obj(x);
  const id = Number.isInteger(s.id) ? (s.id as number) : null;
  const status = str(s.status) ?? "open";
  return {
    id, topicKey: str(s.topic_key) ?? "—", type: str(s.type) ?? "—", rule: str(s.rule) ?? "", status, tone: toneOf(status),
    summary: str(obj(s.signal).summary), createdAt: str(s.created_at), lastSeenAt: str(s.last_seen_at), expiresAt: str(s.expires_at),
    decidedAt: str(s.decided_at), decidedBy: str(s.decided_by), sessionId: str(s.session_id),
    countdown: status === "open" ? countdownOf(s.created_at, s.expires_at, now) : null, chainId: id != null ? `suggestion:${id}` : null
  };
}
/** When a decided or expired suggestion ended: its decided_at, else (an expiry no run has marked yet) its expires_at. */
export const endedAt = (s: Pick<Suggestion, "decidedAt" | "expiresAt" | "status">): string | null => s.decidedAt ?? (s.status === "expired" ? s.expiresAt : null);
/** Who decided, in words: owner, expired (#677 "system"), legacy (a plain label; it never appears in production). */
export const decidedByText = (by: string | null, status: string): string => (by === "system" || (!by && status === "expired") ? "expired, not decided" : by === "owner" ? `${status} by owner` : by ? `${status} · ${by}` : status);

export type Suggestions = { mode: string | null; open: Suggestion[]; recent: Suggestion[] };
/** GET /api/council/suggestions: the open ones, soonest expiry first; the rest, newest end first (the last 7 days). */
export function suggestionsOf(body: any, now: number): Suggestions {
  const d = obj(body);
  const all = arr(d.suggestions).map((x) => suggestionOf(x, now));
  const open = all.filter((s) => s.status === "open").sort((a, b) => (ms(a.expiresAt) ?? Infinity) - (ms(b.expiresAt) ?? Infinity));
  const since = now - 7 * 24 * H;
  const recent = all.filter((s) => s.status !== "open" && (ms(endedAt(s)) ?? ms(s.createdAt) ?? 0) >= since)
    .sort((a, b) => (ms(endedAt(b)) ?? 0) - (ms(endedAt(a)) ?? 0));
  return { mode: str(d.mode), open, recent };
}

// ------------------------------------------------------------------ sessions
export type SessionRow = {
  id: string; topicKey: string; topicText: string | null; question: string | null; state: string; running: boolean; terminal: boolean;
  calls: number | null; createdAt: string | null; updatedAt: string | null; reason: string | null; seats: number;
};
const msIso = (v: unknown): string | null => { const n = num(v); return n != null && n > 0 ? new Date(n).toISOString() : null; };
export function sessionRowOf(x: any): SessionRow {
  const s = obj(x);
  const state = str(s.state) ?? "—";
  return {
    id: str(s.id) ?? "—", topicKey: str(s.topic_key) ?? "—", topicText: str(s.topic_text), question: str(s.question), state,
    running: RUNNING.includes(state), terminal: s.terminal === true || TERMINAL.includes(state), calls: num(s.calls),
    createdAt: str(s.created_at) ?? msIso(s.created_ms), updatedAt: str(s.updated_at) ?? msIso(s.updated_ms), reason: maskEmail(s.reason), seats: arr(s.participants).length
  };
}
export type Sessions = { enabled: boolean | null; mode: string | null; callsMax: number; perDay: number; today: number; running: SessionRow[]; waiting: SessionRow[]; ended: SessionRow[] };
/** GET /api/council/sessions: running ones first, then those waiting for a pick, then the ended ones (newest first). */
export function sessionsOf(body: any, now: number): Sessions {
  const d = obj(body);
  const rows = arr(d.sessions).map(sessionRowOf);
  const limits = obj(d.limits);
  const day = new Date(now).toISOString().slice(0, 10);
  // As startSession counts the day (src/cfc-session.mjs): sessions made today (UTC) that the owner did not close.
  const today = rows.filter((r) => (r.createdAt ?? "").slice(0, 10) === day && r.state !== "closed").length;
  const newest = (a: SessionRow, b: SessionRow) => (ms(b.updatedAt) ?? 0) - (ms(a.updatedAt) ?? 0);
  return {
    enabled: typeof d.enabled === "boolean" ? d.enabled : null, mode: str(d.mode), callsMax: num(limits.calls) ?? 16, perDay: num(limits.started_per_day) ?? 4, today,
    running: rows.filter((r) => r.running), waiting: rows.filter((r) => !r.running && !r.terminal), ended: rows.filter((r) => r.terminal).sort(newest)
  };
}

/** An agent's answer is a vote on the topic, not a market direction: agree ok, disagree fault, amend late, abstain off. */
export const STANCE: Record<string, { text: string; tone: Tone }> = {
  support: { text: "agree", tone: "ok" }, oppose: { text: "disagree", tone: "fault" }, amend: { text: "agree, with a change", tone: "late" }, abstain: { text: "abstain", tone: "off" }
};
export const stanceOf = (s: unknown) => STANCE[String(s ?? "")] ?? { text: "not yet", tone: "plain" as Tone };

export type Tally = { support: number; oppose: number; amend: number; abstain: number; total: number };
/** progress.tally (#677): the stances of the opening positions. There is no per-option tally yet (PR2). */
export function tallyOf(t: unknown): Tally | null {
  const o = obj(t);
  const n = (k: string) => num(o[k]) ?? 0;
  const out = { support: n("support"), oppose: n("oppose"), amend: n("amend"), abstain: n("abstain"), total: 0 };
  out.total = out.support + out.oppose + out.amend + out.abstain;
  return out.total > 0 ? out : null;
}
export const tallyText = (t: Tally): string => `${t.support} agree · ${t.amend} change · ${t.oppose} disagree · ${t.abstain} abstain`;

export type Seat = { id: string; name: string; opinion: boolean; response: boolean; stance: string | null; proposal: string | null; refs: number; message: any | null };
/** Each seat of a session: whether it gave its opinion and its response, its latest stance and what it would try. */
export function seatsOf(session: any): Seat[] {
  const s = obj(session);
  const msgs = arr(s.messages).filter((m) => m && (m.round === "position" || m.round === "rebuttal"));
  return arr(s.participants).map((p) => {
    const id = typeof p === "string" ? p : str(obj(p).id) ?? "—";
    const name = typeof p === "string" ? p : str(obj(p).name) ?? id;
    const own = msgs.filter((m) => m.seat === id);
    const last = own[own.length - 1] ?? null;
    const proposal = [...own].reverse().map((m) => str(m.proposal)).find(Boolean) ?? null;
    return { id, name, opinion: own.some((m) => m.round === "position"), response: own.some((m) => m.round === "rebuttal"), stance: str(last?.stance), proposal,
      refs: own.reduce((n, m) => n + arr(m.refs).length, 0), message: last };
  });
}

export type Option = { id: string; rank: number | null; title: string; kind: string | null; hypothesis: string | null; knob: string | null; change: string | null; risk: string | null; dissent: string | null; spec: string | null; picked: boolean; raw: any };
const KIND_TEXT: Record<string, string> = { policy_parameter: "knob change · shadow test first", repository_task: "new code · built by Cryptophys", no_change: "no change" };
export const kindText = (k: unknown): string | null => KIND_TEXT[String(k ?? "")] ?? null;
const SHORT_KIND: Record<string, string> = { policy_parameter: "knob", repository_task: "new code", no_change: "no change" };
/** The option the council (or the owner) picked: "accepted <option_id> by …" in the session's reason (acceptOption). */
export const pickedOptionId = (reason: unknown): string | null => /^accepted (\S+) by /.exec(String(reason ?? ""))?.[1] ?? null;

export type Detail = {
  id: string; question: string; topicKey: string; state: string; statusText: string; tone: Tone; step: string | null; terminal: boolean;
  calls: number | null; createdAt: string | null; updatedAt: string | null; refs: number | null; packHash: string | null; stale: boolean; reason: string | null;
  summary: string | null; options: Option[]; pickedBy: string | null; seats: Seat[]; rounds: { round: string; title: string; messages: any[] }[]; participants: { id: string; name: string }[]; raw: any;
};
const ROUND_TITLE: Record<string, string> = { position: "Opening opinions", rebuttal: "Responses to each other", answer: "Answers to the owner" };
/**
 * GET /api/council/session's session, with what the archive adds (the chain: who decided, the proposal): the header, the
 * options read-only with the pick marked, each seat's vote, the rounds. `chain` may be null (not on a loaded page).
 */
export function detailOf(session: any, chain: Chain | null = null): Detail | null {
  const s = obj(session);
  if (!str(s.id)) return null;
  const state = str(s.state) ?? "—";
  const pickedId = pickedOptionId(s.reason);
  const opts = obj(s.options);
  const options = arr(opts.options).filter((o) => o && typeof o === "object").map((o) => ({
    id: str(o.option_id) ?? "—", rank: num(o.rank), title: str(o.title) ?? str(o.option_id) ?? "—", kind: str(o.kind), hypothesis: str(o.hypothesis),
    knob: o.kind === "policy_parameter" && str(o.knob) ? `${o.knob}: ${o.from ?? "—"} → ${o.value ?? "—"}${str(o.unit) ? ` ${o.unit}` : ""}` : null,
    change: str(o.change), risk: str(o.risk), dissent: str(o.dissent), spec: str(o.spec), picked: pickedId != null && o.option_id === pickedId, raw: o
  }));
  const msgs = arr(s.messages);
  const rounds = ["position", "rebuttal", "answer"].map((r) => ({ round: r, title: ROUND_TITLE[r], messages: msgs.filter((m) => m && (m.round === r || (r === "answer" && (m.round === "owner" || m.round === "notice")))) })).filter((r) => r.messages.length);
  return {
    id: s.id, question: str(s.topic_text) ?? str(s.question) ?? "—", topicKey: str(s.topic_key) ?? "—", state, statusText: RUNNING.includes(state) ? "running" : statusText(state), tone: toneOf(RUNNING.includes(state) ? "running" : state),
    step: stepText(state), terminal: s.terminal === true || TERMINAL.includes(state), calls: num(s.calls), createdAt: msIso(s.created_ms), updatedAt: msIso(s.updated_ms),
    refs: num(s.pack_refs), packHash: str(s.pack_hash), stale: s.pack_stale === true, reason: maskEmail(s.reason), summary: str(opts.summary), options,
    pickedBy: pickedId ? chain?.proposal?.decidedBy ?? null : null, seats: seatsOf(s), rounds,
    participants: arr(s.participants).map((p) => { const id = typeof p === "string" ? p : str(obj(p).id) ?? "—"; return { id, name: typeof p === "string" ? p : str(obj(p).name) ?? id }; }), raw: s
  };
}

// ------------------------------------------------------------------ the archive: chains topic -> session -> proposal
export type Step = { status: string; text: string; tone: Tone };
const step = (status: string | null): Step | null => (status ? { status, text: statusText(status), tone: toneOf(status) } : null);
export type Chain = {
  id: string; status: string; text: string; tone: Tone; source: string | null; nextActor: string; terminal: boolean; updatedAt: string | null;
  topic: { key: string; type: string | null; origin: string | null; suggestionId: number | null; rule: string | null; step: Step | null; expiresAt: string | null; decidedAt: string | null; decidedBy: string | null; endedAt: string | null };
  session: { id: string; state: string; step: Step; stepName: string | null; startedBy: string | null; reopenedAs: string | null; reason: string | null; createdAt: string | null; updatedAt: string | null; tally: Tally | null; done: number | null; expected: number | null; rebuttals: number | null; options: number | null } | null;
  proposal: { id: string; kind: string | null; kindText: string | null; title: string | null; knob: string | null; state: string; step: Step; decidedBy: string | null; decidedAt: string | null; closeCode: string | null; note: string | null } | null;
};
/** One archive item (#677 readCouncilArchive items[]). */
export function chainOf(x: any): Chain {
  const c = obj(x), t = obj(c.topic), s = c.session ? obj(c.session) : null, p = c.proposal ? obj(c.proposal) : null;
  const status = str(c.status) ?? "unknown";
  const nextActor = str(c.next_actor) ?? "none";
  // An owner's own session has no suggestion: its topic step has no status.
  const tStatus = str(t.status);
  const pf = p?.platform ? obj(p.platform) : null;
  const pState = p ? (p.state === "handed_off" && str(pf?.state) ? String(pf?.state) : str(p.state) ?? "—") : null;
  const prog = s ? obj(s.progress) : null;
  const sState = s ? str(s.state) ?? "—" : null;
  return {
    id: str(c.chain_id) ?? "—", status, text: statusText(status), tone: toneOf(status), source: str(c.status_source), nextActor, terminal: nextActor === "none", updatedAt: str(c.updated_at),
    topic: { key: str(t.key) ?? "—", type: str(t.type), origin: str(t.origin), suggestionId: Number.isInteger(t.suggestion_id) ? t.suggestion_id : null, rule: str(t.rule),
      step: step(tStatus), expiresAt: str(t.expires_at), decidedAt: str(t.decided_at), decidedBy: str(t.decided_by),
      endedAt: tStatus && tStatus !== "open" ? str(t.decided_at) ?? (tStatus === "expired" ? str(t.expires_at) : null) : null },
    session: s && sState ? {
      id: str(s.id) ?? "—", state: sState, step: step(RUNNING.includes(sState) ? "running" : sState)!, stepName: stepText(sState), startedBy: str(s.started_by), reopenedAs: str(s.reopened_as),
      reason: maskEmail(s.reason), createdAt: str(s.created_at), updatedAt: str(s.updated_at), tally: tallyOf(prog?.tally),
      done: num(obj(prog?.positions).done), expected: num(obj(prog?.positions).expected), rebuttals: num(prog?.rebuttals), options: num(prog?.synthesis)
    } : null,
    proposal: p && pState ? {
      id: str(p.id) ?? "—", kind: str(p.kind), kindText: SHORT_KIND[String(p.kind)] ?? null, title: str(p.title),
      knob: p.kind === "policy_parameter" && str(p.knob) ? `${p.knob} ${p.from ?? "—"} → ${p.value ?? "—"}` : null,
      state: pState, step: step(pState)!, decidedBy: str(p.decided_by), decidedAt: str(p.decided_at), closeCode: str(pf?.close_code), note: maskEmail(p.note)
    } : null
  };
}

export type Archive = { chains: Chain[]; nextCursor: string | null; total: number | null; windowDays: number | null; asOf: string | null; statuses: string[]; actors: string[] };
/** GET /api/council/archive (#677: items, next_cursor, total, window_days, as_of, vocab). */
export function archiveOf(body: any): Archive {
  const d = obj(body), v = obj(d.vocab);
  return {
    chains: arr(d.items ?? d.chains).map(chainOf), nextCursor: str(d.next_cursor), total: num(d.total), windowDays: num(d.window_days), asOf: str(d.as_of),
    statuses: arr(v.chain_status).filter((x) => typeof x === "string"), actors: arr(v.next_actor).filter((x) => typeof x === "string")
  };
}
/** Load more: the next page's chains after the ones on screen (a chain already listed is kept once), its cursor and total. */
export function mergeArchive(prev: Archive | null, next: Archive): Archive {
  if (!prev) return next;
  const seen = new Set(prev.chains.map((c) => c.id));
  return { ...next, chains: [...prev.chains, ...next.chains.filter((c) => !seen.has(c.id))], statuses: next.statuses.length ? next.statuses : prev.statuses };
}

/** The archive read: one page of ARCHIVE_PAGE chains (#677 allows at most 50), then the cursor. */
export const ARCHIVE_PAGE = 50;
/**
 * The archive's path. The API has no scope filter yet, so the split into active and archived chains is made here, on
 * the client (splitArchive); a later server-side `?scope=active|archive` changes this function and splitArchive only.
 */
export const archivePath = (cursor: string | null = null, limit = ARCHIVE_PAGE): string => `/api/council/archive?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

export type Split = {
  active: Chain[]; archived: Chain[]; counts: [string, number][]; loaded: number; total: number | null;
  /** The counts cover every chain of the archive's window (all pages loaded), or only the pages loaded so far. */
  exact: boolean;
};
/**
 * The owner's rule (via the Orchestrator, 2026-11-28): only the chains that need someone are listed by default (next_actor
 * not "none"); the terminal ones (next_actor "none": expired, rejected, closed, no change, aborted, deployed, ...) are
 * counted by status and listed only in the Archive view. Client-side, over the pages loaded so far: exact once every page
 * is loaded (no next cursor), else the counts are of the loaded chains only.
 */
export function splitArchive(a: Archive | null): Split {
  const chains = a?.chains ?? [];
  const active = chains.filter((c) => !c.terminal);
  const archived = chains.filter((c) => c.terminal);
  const by = new Map<string, number>();
  for (const c of archived) by.set(c.text, (by.get(c.text) ?? 0) + 1);
  const counts = [...by.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  return { active, archived, counts, loaded: chains.length, total: a?.total ?? null, exact: a != null && a.nextCursor == null };
}
/** The one line instead of the terminal chains: "Archive: 5 expired · 2 closed · 1 rejected", honest about its reach. */
export function summaryText(sp: Split, label = "Archive"): string {
  const parts = sp.counts.map(([k, n]) => `${n} ${k}`);
  const body = parts.length ? parts.join(" · ") : "nothing ended yet";
  return sp.exact || !parts.length ? `${label}: ${body}` : `${label}: ${body} in the last ${sp.loaded} loaded of ${sp.total ?? "?"}`;
}

/** The active list's quick filters: who acts next. */
export const ACTIVE_FILTERS: [string, string][] = [["all", "All"], ["owner", "Needs you"], ["moving", "In progress"]];
export const activeOf = (chains: Chain[], f: string): Chain[] => (f === "owner" ? chains.filter((c) => c.nextActor === "owner") : f === "moving" ? chains.filter((c) => c.nextActor !== "owner") : chains);
/** The Archive view's status filter: "all" and each chain status among the loaded archived chains (vocab order first). */
export function archiveStatuses(sp: Split, vocab: string[]): string[] {
  const present = [...new Set(sp.archived.map((c) => c.status))];
  const order = (s: string) => { const i = vocab.indexOf(s); return i < 0 ? vocab.length : i; };
  return ["all", ...present.sort((x, y) => order(x) - order(y) || x.localeCompare(y))];
}
export const archivedOf = (sp: Split, f: string): Chain[] => (f === "all" ? sp.archived : sp.archived.filter((c) => c.status === f));
/** An expired or rejected chain is one line in the Archive view: the topic, its chip, and when it ended. */
export const oneLine = (c: Chain): boolean => c.terminal && !c.session && (c.status === "expired" || c.status === "rejected");
export const endedText = (c: Chain, now: number | null = null): string => `${c.status === "rejected" ? "rejected" : c.status === "expired" ? "expired" : "ended"} at ${whenText(c.topic.endedAt ?? c.updatedAt, now)}`;

/** The chain of a suggestion or a session among the loaded ones. */
export const chainFor = (a: Archive | null, { suggestionId = null, sessionId = null }: { suggestionId?: number | null; sessionId?: string | null }): Chain | null =>
  (a?.chains ?? []).find((c) => (suggestionId != null && c.topic.suggestionId === suggestionId) || (sessionId != null && c.session?.id === sessionId)) ?? null;

// ------------------------------------------------------------------ the owner's decide (POST /omega/api/council)
export type Decision = "approve" | "reject";
const KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const randomPart = (): string => {
  const c = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function" ? crypto.getRandomValues(new Uint8Array(6)) : Array.from({ length: 6 }, () => Math.floor(Math.random() * 256));
  return Array.from(c, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
};
/** One idempotency key per click intent (#677 cleanKey: 1 to 64 of [A-Za-z0-9_.:-]): "decide:<id>:<decision>:<random>". */
export function decideKey(id: number, decision: Decision, random: string = randomPart()): string {
  const k = `decide:${id}:${decision}:${String(random).replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "0"}`.slice(0, 64);
  return KEY_RE.test(k) ? k : `decide:${id}:${decision}`;
}
export const isKey = (k: unknown): boolean => typeof k === "string" && KEY_RE.test(k);
/** The decide body: the same key is sent again on a retry of the same intent (#677 replays the first answer). */
export const decideRequest = (id: number, decision: Decision, key: string = decideKey(id, decision)) => ({ action: "decide" as const, suggestion_id: id, decision, idempotency_key: key });

export type DecideResult = { kind: "ok" | "already_decided" | "expired" | "session_refused" | "error"; code: string; words: string; tone: Tone; refresh: boolean; retry: boolean; sessionId: string | null; suggestion: Suggestion | null };
/**
 * The answer, in words, never a throw. 200 (a replay too) is success; 409 already_decided and expired show the card's
 * state now and refresh; 409 session_refused leaves it open with a retry; 404, 400, 403 and 5xx inline (role="alert").
 */
export function decideResult(status: number | null, body: any, decision: Decision, now: number): DecideResult {
  const b = obj(body);
  const code = str(b.code) ?? str(b.error) ?? (status ? String(status) : "network");
  const sug = b.suggestion ? suggestionOf(b.suggestion, now) : null;
  const base = { code: status ? `${status} ${code}` : "network", sessionId: str(b.session_id), suggestion: sug };
  if (status === 200 && b.ok !== false) return { ...base, kind: "ok", code: b.replay ? "200 replay" : "200", words: decision === "approve" ? "Approved. Session opened." : "Rejected. No session opens.", tone: "ok", refresh: true, retry: false };
  if (status === 409 && b.code === "already_decided") return { ...base, kind: "already_decided", words: "It was decided before yours arrived. The card shows its state now.", tone: "late", refresh: true, retry: false };
  if (status === 409 && b.code === "expired") return { ...base, kind: "expired", words: "It expired before yours arrived. The card shows its state now.", tone: "late", refresh: true, retry: false };
  if (status === 409 && b.code === "session_refused") return { ...base, kind: "session_refused", words: `The session did not start${str(b.error) ? `: ${b.error}` : ""}. The topic is open again.`, tone: "fault", refresh: true, retry: true };
  const words = status === 403 ? (b.error === "same_origin_only" ? "Refused: not sent from this page." : "Only the owner decides. Sign in with the owner's account.")
    : status === 404 ? "This topic is no longer on the server. The list refreshes."
    : status === 400 ? "Not saved: the request was refused as malformed (a Nexus bug, not yours)."
    : status == null ? "No answer from Nexus. The card is still open."
    : "Not saved. The card is still open.";
  return { ...base, kind: "error", words, tone: "fault", refresh: status === 404, retry: status == null || status >= 500 };
}

/** The decide POST (same origin, JSON), as the page's other owner writes: { status, body }, never a throw. */
export async function postCouncil(body: unknown, fetchImpl: typeof fetch = fetch): Promise<{ status: number | null; body: any }> {
  try {
    const r = await fetchImpl("/omega/api/council", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    let b: any = null;
    try { b = await r.json(); } catch { b = null; }
    return { status: r.status, body: b };
  } catch {
    return { status: null, body: null };
  }
}
