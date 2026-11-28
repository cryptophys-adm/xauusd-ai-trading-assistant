// CR1, the decision council's missing-confidence WAIT (owner 2026-11-28 via the orchestrator, "setuju semua", PR B).
// 133 of 565 council decisions over the 14 days before 27 Nov answered confidence 0, 58 of them citing a missing
// confidence. The cause: the doctrine rule engine_thresholds (Canon, src/doctrine-consumer.mjs; the council reads it as
// "Operational Mandates") lists "a confidence of at least 0.4" among the thresholds a BUY or SELL needs, beside the
// guardrail checks, and fail_closed_wait says missing evidence means WAIT; the model takes the confidence for an input
// it was not given, answers WAIT with confidence 0, and says so ("no confidence value is supplied, so the engine cannot
// meet the minimum 0.4"), while the side's guardrails all pass. The canon text is the Knowledge Council's; this Worker
// only says, once, how to read it.
//
// COUNCIL_CONF_RETRY (FS1, group agents; wrangler "on", code default "off" so the fixtures replay as before):
//   1. the council's doctrine block carries one line after engine_thresholds (CONF_DOCTRINE_NOTE): the confidence there
//      is the one the council returns, never an input;
//   2. a valid answer that is WAIT with confidence 0, or that cites a missing confidence or the 0.4 minimum
//      (confRetryNeeded), on a decision where a side's guardrails all pass, is asked once more with one correction line
//      (CONF_RETRY_NOTE), at most CONF_RETRY_DAILY_CAP times a UTC day (KV counter). The second valid answer is the
//      answer; an invalid one leaves the first. Recorded as decision.conf_retry { first, second } (stance, confidence).
// "off": neither.

export const CONF_RETRY_SWITCH = "COUNCIL_CONF_RETRY";
export const CONF_RETRY_DAILY_CAP = 20;
export const CONF_RETRY_KEY_PREFIX = "council-conf-retry:";

/** The line after engine_thresholds in the council's doctrine block. */
export const CONF_DOCTRINE_NOTE = "  How to read engine_thresholds' confidence: it is the confidence you return in your answer, your own judgement of your stance. It is never an input, never missing, and no check reads it before you answer.";

/** The one correction the council gets when it answered WAIT for a missing confidence. */
export const CONF_RETRY_NOTE = "Correction: no confidence value is given to you and none is missing; no guardrail checks a confidence before your answer. The 0.4 minimum applies to the confidence you return. Answer again from the same evidence with your own confidence for the stance you choose, and do not cite a missing confidence.";

const s = (v) => String(v ?? "").trim().toLowerCase();

/** Pure: COUNCIL_CONF_RETRY as the env holds it ("off" for anything else). */
export function councilConfRetryMode(env) {
  return s(env?.COUNCIL_CONF_RETRY) === "on" ? "on" : "off";
}

/** Pure: the answer's text cites a missing confidence or the confidence minimum as its reason. */
export function citesMissingConfidence(answer) {
  const text = [answer?.summary, ...(Array.isArray(answer?.reasons) ? answer.reasons : []), ...(Array.isArray(answer?.risks) ? answer.risks : [])].filter((x) => typeof x === "string").join(" \n ");
  if (!text) return false;
  const patterns = [
    /(no|without|lacks?|lacking|missing|absent)\s+(an?\s+|any\s+)?(explicit\s+|required\s+|overall\s+)?confidence/i,
    /confidence[^.\n]{0,80}\b(missing|not\s+(provided|supplied|given|available|present)|absent|unavailable|lacking|is\s+required|required\s+by)/i,
    /confidence[^.\n]{0,40}(≥|>=|at\s+least|minimum|threshold)\s*(of\s+)?0?\.4/i,
    /(minimum|required)\s+(0?\.4\s+)?confidence/i
  ];
  return patterns.some((re) => re.test(text));
}

/**
 * Pure: whether a valid council answer is re-asked: a WAIT with confidence 0 or one citing a missing confidence, on a
 * decision where a side's guardrails all pass (`evidence.long.allowed` / `evidence.short.allowed`).
 */
export function confRetryNeeded(answer, evidence) {
  if (!answer || answer.stance !== "WAIT") return false;
  if (!(evidence?.long?.allowed === true || evidence?.short?.allowed === true)) return false;
  return answer.confidence === 0 || citesMissingConfidence(answer);
}

/** Pure: the day's KV counter key (UTC). */
export const confRetryKey = (ms) => `${CONF_RETRY_KEY_PREFIX}${new Date(ms).toISOString().slice(0, 10)}`;

/** Takes one of the day's retries (KV counter, 2 days' TTL): true while under the cap; false at the cap or when unreadable. */
export async function takeConfRetry(env, { now = Date.now(), cap = CONF_RETRY_DAILY_CAP } = {}) {
  const kv = env?.SIGNAL_CACHE;
  if (!kv?.get || !kv?.put) return false;
  try {
    const key = confRetryKey(now);
    const n = Number(await kv.get(key)) || 0;
    if (n >= cap) return false;
    await kv.put(key, String(n + 1), { expirationTtl: 2 * 86_400 });
    return true;
  } catch { return false; }
}

/** The day's retry count (0 when unreadable). */
export async function confRetryCount(env, { now = Date.now() } = {}) {
  try { return Number(await env?.SIGNAL_CACHE?.get?.(confRetryKey(now))) || 0; } catch { return 0; }
}

/** Pure: the record of a retry. */
export const confRetryRecord = (first, second) => ({
  first: { stance: first?.stance ?? null, confidence: typeof first?.confidence === "number" ? first.confidence : null },
  second: second ? { stance: second.stance ?? null, confidence: typeof second.confidence === "number" ? second.confidence : null } : null
});
