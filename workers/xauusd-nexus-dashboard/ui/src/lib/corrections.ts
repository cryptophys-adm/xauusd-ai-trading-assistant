// H3f, the owner's correction control (owner "2. yes", 2026-11-25; the owner-approved mockup "H3f Correction control
// mockup"). Pure: the gate (viewer.can_control and the OWNER_CORRECTIONS row of the shared feature-switch read), the
// target of each host (built from the data the output already carries, never typed and never invented), the draft and
// its POST body, the reply of POST /omega/api/correction (workers/xauusd-omega/src/omega.mjs, the correction.v1 shape of
// correctionRequest; src/owner-corrections.mjs on the AI Worker), and the words of every code. No React here. The one
// write of the Nexus UI outside its settings pages is postCorrection below; everything else stays read-only.
import { switchesOf, whenText } from "./featureSwitches";

export const CORRECTION_PATH = "/omega/api/correction";
/** The FS1 row that turns the control on (the FS1 registry; default off, not in wrangler.jsonc). */
export const CORRECTIONS_KEY = "OWNER_CORRECTIONS";
/** The route's limits: text at most 500 characters (correctionRequest), the body at most 4096 characters (personJson), 10 refs. */
export const TEXT_MAX = 500;
export const BODY_MAX = 4096;
export const REFS_MAX = 10;
/** The Decision Engine's council, the decision's agent (src/decision-engine.mjs COUNCIL_AGENT). */
export const COUNCIL_AGENT = "council";

/** A council.v1 evidence ref, copied from src/cfc-pack.mjs:201 (REF_RE). The control is hidden whenever its ref fails it. */
export const REF_RE = /^ev:xauusd\/[a-z][a-z0-9_]*\/[^\s@#]+(@[^\s@#]+)?(#[A-Za-z0-9_.:|-]+)?$/;
/**
 * The ref form the AI Worker's buildCorrection parses, copied from src/owner-corrections.mjs:74 (REF, the platform's
 * council.ts §4.6): narrower after "#" than REF_RE (no ":", "|" or "-"). A ref it cannot parse answers 400 invalid_target.
 */
const CONTRACT_REF = /^ev:(platform|xauusd|aether|adr|ssot)\/(?:([a-z][a-z0-9_.-]{0,63})\/)?([^@#\s]{1,200})(?:@([^#\s]{1,40}))?(?:#([A-Za-z0-9_.]{1,80}))?$/;
/** A field that names a price (src/owner-corrections.mjs:75 PRICE_WORDS): never a price after "#". */
const PRICE_FIELD = /^(price|entry|stoploss|stop|takeprofit|sl|tp\d?|level|bid|ask|open|high|low|close|mid)$/i;
/** The subject: omega.mjs CORRECTION_SUBJECT without model: (the orchestrator's ruling: agent: or seat: only). */
export const SUBJECT_RE = /^(agent|seat):[A-Za-z0-9_.:-]{1,100}$/;

/** A ref the control may send: REF_RE, the contract's form, at most 300 characters (omega.mjs isRef), no price field. */
export function isRef(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 300 || !REF_RE.test(v)) return false;
  const m = CONTRACT_REF.exec(v);
  if (!m) return false;
  const field = m[5] ?? null;
  return field == null || !PRICE_FIELD.test(field.split(/[._]/).pop() ?? "");
}

export const SOURCES = ["nexus_card", "nexus_room", "nexus_engine", "nexus_council"] as const;
export type Source = (typeof SOURCES)[number];
/** What is rated: filled from the output's own data, never typed. */
export type Target = { source: Source; ref: string; subject: string; as_of: string | null; evidence_refs: string[] };

/** An ISO time normalised with toISOString (ends in Z); null for anything else. */
export function isoOf(v: unknown): string | null {
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** A checked target, or null (the host then shows no control). */
export function targetOf(t: { source: Source; ref: unknown; subject: unknown; as_of?: unknown; evidence_refs?: unknown[] }): Target | null {
  if (!SOURCES.includes(t.source) || !isRef(t.ref) || typeof t.subject !== "string" || !SUBJECT_RE.test(t.subject)) return null;
  const refs = [...new Set((t.evidence_refs ?? []).filter(isRef))].filter((r) => r !== t.ref).slice(0, REFS_MAX);
  return { source: t.source, ref: t.ref, subject: t.subject, as_of: isoOf(t.as_of), evidence_refs: refs };
}

/**
 * The Decision Engine card (components/GlobalDecision.tsx): the engine's own record, ev:xauusd/engine_decisions/<decision_key>
 * (the D1 table and its key, src/decision-engine.mjs), the council as its subject, its 15m close as of.
 */
export function engineTarget(e: any): Target | null {
  // The key is the ref's whole id: one with "@", "#" or a space would read as an as_of or a field, so it has no control.
  const key = typeof e?.decision_key === "string" ? e.decision_key : "";
  if (!/^[^\s@#]+$/.test(key)) return null;
  return targetOf({ source: "nexus_engine", ref: `ev:xauusd/engine_decisions/${key}`, subject: `agent:${COUNCIL_AGENT}`, as_of: e.bar_close });
}

/**
 * The rooms (components/ThreadsPanel.tsx; #588: GET /api/war-room/latest and /api/threads/timeframe carry `ev_ref`,
 * ev:xauusd/agent_thread_messages/<row id>, on each opening, rebuttal and conclusion). A conclusion card is the room's
 * moderator (seat:<TF>:moderator); an opening or a rebuttal is its agent (agent:<id>, as outcome scoring names it); as
 * of the room's bar (the 15m room's bar_time, the others' bar_close). Without an ev_ref there is no control.
 */
const roomAsOf = (room: any) => room?.bar_close ?? room?.bar_time ?? null;
export function roomConclusionTarget(room: any, tab: string): Target | null {
  const c = room?.conclusion;
  if (!c || c.status !== "ok") return null;
  return targetOf({ source: "nexus_card", ref: c.ev_ref, subject: `seat:${tab}:moderator`, as_of: roomAsOf(room) });
}
export function roomMessageTarget(m: any, room: any): Target | null {
  if (!m || m.status !== "ok" || typeof m.id !== "string") return null;
  return targetOf({ source: "nexus_room", ref: m.ev_ref, subject: `agent:${m.id}`, as_of: roomAsOf(room) });
}

/**
 * Call for Councils (pages/Councils.tsx; #588: GET /api/council/session carries `ev_ref` on the session, each message and
 * each option). A seat's opinion: its message (ev:xauusd/council_messages/<id>), the seat's agent as the subject, its time
 * as of, and the refs it cites from the evidence pack as evidence. The moderator's options: the session
 * (ev:xauusd/council_sessions/<id>), seat:cfc:moderator, each option's own ref as evidence; no time in the read, so as of
 * none. The owner's own messages and the notices have no control.
 */
export function councilOpinionTarget(m: any): Target | null {
  if (!m || m.round === "owner" || m.round === "notice" || typeof m.seat !== "string") return null;
  return targetOf({ source: "nexus_council", ref: m.ev_ref, subject: `agent:${m.seat}`, as_of: m.at, evidence_refs: Array.isArray(m.refs) ? m.refs : [] });
}
export function councilOptionsTarget(s: any): Target | null {
  const options: any[] = Array.isArray(s?.options?.options) ? s.options.options : [];
  if (!options.length) return null;
  return targetOf({ source: "nexus_council", ref: s.ev_ref, subject: "seat:cfc:moderator", as_of: null, evidence_refs: options.map((o) => o?.ev_ref) });
}

/**
 * The strategy council's verdict (pages/Strategy.tsx VerdictLine; #588: GET /api/strategy-agents agents[].verdicts.ev_ref,
 * ev:xauusd/strategy_council_runs/<day>/<strategy>#proposal): the strategy agent as the subject; the verdict carries a day,
 * no time, so as of none.
 */
export function strategyVerdictTarget(v: any, strategyId: unknown): Target | null {
  if (!v || typeof strategyId !== "string") return null;
  return targetOf({ source: "nexus_council", ref: v.ev_ref, subject: `agent:${strategyId}`, as_of: null });
}

/** The gate: the control shows only to the owner (viewer.can_control) while OWNER_CORRECTIONS is "on". */
export type Gate = { canControl: boolean; on: boolean; show: boolean };
export const HIDDEN: Gate = { canControl: false, on: false, show: false };
export function gateOf(d: any): Gate {
  const sw = switchesOf(d);
  const on = sw.rows.find((r) => r.key === CORRECTIONS_KEY)?.value === "on";
  return { canControl: sw.canControl, on, show: sw.canControl && on };
}

export type Tab = "rate" | "correct";
export type Rating = "up" | "down";
export type Draft = { tab: Tab; rating: Rating | null; category: string; text: string };
export const emptyDraft = (tab: Tab = "rate"): Draft => ({ tab, rating: null, category: "", text: "" });

/** The categories in plain words (CORRECTION_ROUTE_CATEGORIES, in the route's order). */
export const CATEGORIES: [string, string][] = [
  ["reading_wrong", "Reading wrong"], ["invalidation_too_tight", "Invalidation too tight"], ["invalidation_too_loose", "Invalidation too loose"],
  ["evidence_wrong", "Evidence wrong"], ["evidence_missing", "Evidence missing"], ["overconfident", "Overconfident"],
  ["underconfident", "Underconfident"], ["rule_broken", "Rule broken"], ["good_call", "Good call"], ["other", "Other"]
];
const CATEGORY_KEYS = CATEGORIES.map(([k]) => k);

export const over = (d: Draft): boolean => d.text.length > TEXT_MAX;
/** Rate: a rating. Correct: a category or text, and at most 500 characters. */
export function canSend(d: Draft): boolean {
  if (d.tab === "rate") return d.rating != null;
  return (d.category !== "" || d.text.trim() !== "") && !over(d);
}

/** The POST body: only the route's keys (any other key is 400 unknown_field); the text only on Correct. */
export function bodyOf(t: Target, d: Draft) {
  const category = CATEGORY_KEYS.includes(d.category) ? d.category : null;
  const text = d.tab === "correct" && d.text.trim() ? d.text : null;
  return {
    source: t.source, label: d.tab === "rate" ? "owner_rating" : "owner_correction", rating: d.rating, category, text,
    target: { ref: t.ref, subject: t.subject, as_of: t.as_of },
    ...(t.evidence_refs.length ? { evidence_refs: t.evidence_refs.slice(0, REFS_MAX) } : {})
  };
}

/** What a send came back with. */
export type Redaction = "price" | "secret";
export type Sent = { id: string | null; redactions: Redaction[]; deduplicated: boolean };
export type Reply = { kind: "sent"; sent: Sent } | { kind: "off" } | { kind: "error"; status: number | null; code: string };

/** The reply, read as the Omega page's omegaJson rule: a non-2xx answer or ok: false is a failure, its `error` the code. */
export function replyOf(httpStatus: number, data: any): Reply {
  const status = Number.isInteger(httpStatus) && httpStatus > 0 ? httpStatus : 0;
  if (status >= 200 && status < 300 && data?.ok === true) {
    const id = typeof data.correction_id === "string" && /^cor_[0-9a-f]{16}$/.test(data.correction_id) ? data.correction_id : null;
    const got: unknown[] = Array.isArray(data.redactions) ? data.redactions : [];
    // "prices masked" first, then "secret removed" (the mockup's order); "truncated" never comes (text over 500 is a 400).
    const redactions = (["price", "secret"] as const).filter((r) => got.includes(r));
    return { kind: "sent", sent: { id, redactions, deduplicated: data.deduplicated === true } };
  }
  const code = typeof data?.error === "string" && data.error ? data.error.slice(0, 80) : status ? `HTTP ${status}` : "no_answer";
  if (status === 409 || code === "disabled") return { kind: "off" };
  return { kind: "error", status: status || null, code };
}

/** The control's one write: POST /omega/api/correction, same origin, JSON. Never throws. */
export async function postCorrection(body: ReturnType<typeof bodyOf>, fetchImpl: typeof fetch = fetch): Promise<Reply> {
  let res: Response;
  try {
    res = await fetchImpl(CORRECTION_PATH, { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { kind: "error", status: null, code: "network" };
  }
  const data: any = await res.json().catch(() => ({}));
  return replyOf(res.status, data);
}

/** Which field a code marks. */
export type Field = "rating" | "category" | "text" | "both" | "target" | null;
export type ErrorText = { code: string; words: string; field: Field; tone: "fault" | "late" };
const NEXUS_BUG = "Not recorded: a Nexus bug, not yours.";
/** The 400 codes that mean Nexus sent something wrong (the route's correctionRequest and personJson, the AI Worker's buildCorrection). */
export const BUG_CODES = [
  "invalid_target", "invalid_as_of", "invalid_evidence_refs", "too_many_refs", "invalid_source", "invalid_label", "unknown_field",
  "invalid_json", "invalid_request", "invalid_side", "invalid_actor", "empty", "body must be a JSON object", "no_db"
];
/** Every code with its words (the mockup's "Words per code"), the field it marks and its tone. */
export function errorOf(status: number | null, code: string): ErrorText {
  const shown = status == null ? code : `${status} ${code}`;
  const e = (words: string, field: Field = null, tone: "fault" | "late" = "fault"): ErrorText => ({ code: shown, words, field, tone });
  switch (code) {
    case "category_or_text_required": return e("Pick a category or write what was wrong.", "both");
    case "rating_required": case "invalid_rating": return e("Pick up or down.", "rating");
    case "invalid_category": return e("Pick a category from the list.", "category");
    case "text_too_long": case "invalid_text": return e("Over 500 characters: shorten to send.", "text");
    case "invalid_subject": return e("Not recorded: this output has no valid subject. A Nexus bug, not yours.", "target");
    case "owner_only": return e("Owner only");
    case "forbidden": case "cross_origin_refused": case "same_origin_only": return e("Refused: send it from Nexus, signed in.");
    case "body_too_large": return e("Too large to send (4 KB). Shorten the text or the evidence.", "text");
    case "content_type_must_be_json": return e(NEXUS_BUG);
    case "rate_limited": return e("30 an hour reached; try later", null, "late");
    case "correction_failed": return e("Not recorded: the AI Worker did not answer. Try again.");
    case "correction_unavailable": return e("Not recorded: corrections are not deployed yet.");
    case "network": return e("No answer from Nexus. Try again.");
    default:
      if (BUG_CODES.includes(code) || code.startsWith("forbidden_key")) return e(NEXUS_BUG, "target");
      return e("Not recorded. Try again.");
  }
}

/** The footer chips after a send: the record, then one chip per redaction. */
export function sentChips(s: Sent): { text: string; tone: "ok" | "plain" }[] {
  return [
    s.deduplicated ? { text: "Already recorded", tone: "plain" as const } : { text: "Sent to the platform's teaching record", tone: "ok" as const },
    ...s.redactions.map((r) => ({ text: r === "price" ? "prices masked" : "secret removed", tone: "plain" as const }))
  ];
}

/** The target's "as of" in UTC and GMT+7, or "none". */
export const asOfText = (t: Target): string => (t.as_of ? whenText(t.as_of) : "none");
/** A target's key for the chips that stay until the page reloads. */
export const targetKey = (t: Target): string => `${t.source}|${t.ref}|${t.subject}`;

export const HINT = "Prices are masked as [level] before anything leaves Nexus. Describe the level ('the stop under the sweep low') rather than typing it.";
export const OFF_WORDS = "Owner corrections are off. Turn them on in";
