// C5: the Position Manager lines on the Omega page (Setup › Engine, the Broker engine panel, under Reversal probation;
// the owner-approved mockup "Nexus C5 Position Manager lines mockup", "setuju mockup C5"). The pure model of the panel:
// its one read, the lines of B5's GET /api/omega/position-manager (src/pm-line-breaker.mjs pmLinesView: { id, version,
// enabled, off_since, closes, mean_r_last15, r_vs_hold }, 17 lines in registry order), their formats (R neutral, times
// UTC · GMT+7) and its one write, POST /omega/api/pm-lines { line, enabled: true } (the Omega Worker's route,
// workers/xauusd-omega/src/omega.mjs, then setPmLine) with every code it answers. No React here.
import { intelGet } from "./intel";

/**
 * The panel's one read (GET only, lib/intel.ts intelGet's allow-list): the Position Manager route every 60 s. limit=1:
 * the panel shows the lines, not the route's recent actions.
 */
export const PM_LINES_READS = {
  lines: { path: "/api/omega/position-manager?limit=1", everyMs: 60_000, chart: false }
} as const;
/** The route as an error line names it (lib/api.ts ApiError: no query string). */
export const PM_ROUTE = "/api/omega/position-manager";
/** The panel's one write. */
export const PM_POST_PATH = "/omega/api/pm-lines";

/**
 * The read: the route's body, or a thrown error when the AI Worker's own read failed (a 200 with `error` and no lines),
 * so the panel shows it as a failed read with Retry now.
 */
export async function readPmLines(): Promise<unknown> {
  const body = await intelGet(PM_LINES_READS, "lines");
  const e = readErrorOf(body);
  if (e) throw new Error(readErrorText(e));
  return body;
}
/** A failed read inside the AI Worker as the error line shows it. */
export const readErrorText = (code: string): string => `${PM_ROUTE} read failed: ${code}`;

export type PmLine = {
  id: string;
  version: number;
  enabled: boolean;
  /** When the breaker turned it off (ms), null while on or when only PM_LINES_OFF holds it off. */
  off_since: number | null;
  closes: number;
  mean_r_last15: number | null;
  r_vs_hold: number | null;
};
/** Why a line is off: its breaker (it has an off_since; the owner's button may turn it back on), or PM_LINES_OFF only. */
export type OffBy = "breaker" | "hand" | null;

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const ID_RE = /^[a-z0-9_]{1,64}$/;

/** One line of the route, or null when it is not one (an unknown shape is left out, never shown half). */
export function lineOf(x: any): PmLine | null {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !ID_RE.test(x.id)) return null;
  if (!Number.isInteger(x.version) || x.version < 1 || typeof x.enabled !== "boolean") return null;
  return {
    id: x.id,
    version: x.version,
    enabled: x.enabled,
    off_since: isNum(x.off_since) && x.off_since > 0 ? x.off_since : null,
    closes: Number.isInteger(x.closes) && x.closes >= 0 ? x.closes : 0,
    mean_r_last15: isNum(x.mean_r_last15) ? x.mean_r_last15 : null,
    r_vs_hold: isNum(x.r_vs_hold) ? x.r_vs_hold : null
  };
}

/** The route's lines, or null when the body carries none (B5 not deployed, a failed read, not_found). */
export function linesOf(body: any): PmLine[] | null {
  if (!body || typeof body !== "object" || !Array.isArray(body.lines)) return null;
  return body.lines.map(lineOf).filter((l: PmLine | null): l is PmLine => l != null);
}

/** The route's own read error ({ error, rows: [] } with no lines: readPositionManager failed), else null. */
export function readErrorOf(body: any): string | null {
  return body && typeof body === "object" && !Array.isArray(body.lines) && typeof body.error === "string" && body.error ? body.error.slice(0, 64) : null;
}

/** "cut_loss@1". */
export const tagOf = (l: Pick<PmLine, "id" | "version">): string => `${l.id}@${l.version}`;

/**
 * Why an off line is off. The route gives enabled false for a line the breaker holds off (off_since set) and for one
 * PM_LINES_OFF names; only the breaker sets off_since. A line held off by both has an off_since: the button shows, and
 * setPmLine answers off_by_PM_LINES_OFF.
 */
export function offBy(l: PmLine): OffBy {
  if (l.enabled) return null;
  return l.off_since != null ? "breaker" : "hand";
}
/** The owner's Turn back on: only on a line the breaker holds off. */
export const canTurnOn = (l: PmLine): boolean => offBy(l) === "breaker";

/** A mean R, signed with two decimals and a true minus ("+0.31R", "−0.38R", "0.00R"), "—" when there is none. */
export function rText(v: number | null): string {
  if (!isNum(v)) return "—";
  const x = Math.round(v * 100) / 100;
  if (x === 0) return "0.00R";
  return `${x > 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}R`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GMT7_MS = 7 * 3_600_000;
const two = (n: number) => String(n).padStart(2, "0");
/**
 * "Mon 23 Nov 16:35 UTC · 23:35 GMT+7"; the GMT+7 side names its own day when it is another one ("Mon 23 Nov 20:35 UTC ·
 * Tue 03:35 GMT+7"). "—" without a time.
 */
export function whenText(ms: number | null): string {
  if (!isNum(ms) || ms <= 0) return "—";
  const u = new Date(ms), g = new Date(ms + GMT7_MS);
  const sameDay = u.getUTCDate() === g.getUTCDate();
  return `${DAYS[u.getUTCDay()]} ${u.getUTCDate()} ${MONTHS[u.getUTCMonth()]} ${two(u.getUTCHours())}:${two(u.getUTCMinutes())} UTC · ${sameDay ? "" : `${DAYS[g.getUTCDay()]} `}${two(g.getUTCHours())}:${two(g.getUTCMinutes())} GMT+7`;
}

// ---------------------------------------------------------------- the write

/** The route's and setPmLine's refusal of any body but enabled: true (the button never sends one). */
const ENABLED_ONLY = "enabled must be true (turning a line on is the only action)";

/** Every error code the POST answers: the Omega Worker's route (Access, personJson, the owner, the body, the binding) and setPmLine. */
export const POST_ERRORS = [
  "off_by_PM_LINES_OFF", "unknown_line", "unavailable", "owner_only", "forbidden", "access_denied", "cross_origin_refused", "same_origin_only",
  "content_type_must_be_json", "body_too_large", "invalid_json", "body must be a JSON object", "pm_lines_unavailable", "pm_lines_failed",
  "omega_binding_missing", "method_not_allowed", "network", ENABLED_ONLY
] as const;

/** setPmLine's answer for a line the switch PM_LINES_OFF also names (the panel shows "also off by the switch"). */
export const ALSO_OFF = "off_by_PM_LINES_OFF";

/** The words after a refused POST's code: what happened and what to do. */
export function errorWords(code: string): string {
  switch (code) {
    case "off_by_PM_LINES_OFF": return "also off by the switch (PM_LINES_OFF): it stays off until the switch no longer names it.";
    case "unknown_line": return "the server has no such line. Reload the page.";
    case "unavailable": return "the AI Worker could not read its line state. Nothing changed.";
    case "owner_only": return "only the owner turns a line back on. Nothing changed.";
    case "forbidden": return "a person makes this change, never a service token.";
    case "access_denied": return "Cloudflare Access refused the request. Sign in again.";
    case "cross_origin_refused":
    case "same_origin_only": return "the request did not come from this page. Nothing changed.";
    case "content_type_must_be_json":
    case "body_too_large":
    case "invalid_json":
    case "body must be a JSON object": return "the request was malformed. Nothing changed.";
    case "pm_lines_unavailable": return "the AI Worker has no Position Manager lines to change. Nothing changed.";
    case "pm_lines_failed":
    case "omega_binding_missing": return "Omega could not reach the AI Worker. Nothing changed.";
    case "network": return "no answer from Omega. Nothing changed.";
    case "method_not_allowed": return "Omega takes this change as a POST only. Nothing changed.";
    case ENABLED_ONLY: return "turning a line on is the only action. Nothing changed.";
    default: return "nothing changed.";
  }
}

export type PostResult = { ok: true } | { ok: false; error: string };

/** The body of the one write: turning a line on is the only action. */
export const postBody = (line: string) => ({ line, enabled: true as const });

/**
 * The panel's one write: POST /omega/api/pm-lines, same origin, JSON, with the Omega page's omegaJson rule (a non-2xx
 * answer or `ok: false` is a failure, its `error` the code, else "HTTP <status>"; no answer is "network"). Never throws.
 */
export async function postPmLine(line: string, fetchImpl: typeof fetch = fetch): Promise<PostResult> {
  let res: Response;
  try {
    res = await fetchImpl(PM_POST_PATH, { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(postBody(line)) });
  } catch {
    return { ok: false, error: "network" };
  }
  const data: any = await res.json().catch(() => ({}));
  return replyResult(res.status, data);
}

/**
 * Pure: an answer as the panel reads it (omegaJson's rule): a 2xx without `ok: false` is done; else the failure's code,
 * its `error` (at most 64 characters) or "HTTP <status>".
 */
export function replyResult(status: number, data: any): PostResult {
  const ok = status >= 200 && status < 300;
  if (!ok || data?.ok === false) return { ok: false, error: typeof data?.error === "string" && data.error ? data.error.slice(0, 64) : `HTTP ${status}` };
  return { ok: true };
}
