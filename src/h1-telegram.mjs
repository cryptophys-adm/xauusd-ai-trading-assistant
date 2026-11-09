// The H1 decision's Telegram message (owner decision 2026-11-08): sent only for a BUY or SELL, or
// when the decision changes from the previous bar's (for example BUY -> WAIT). A WAIT that follows
// a WAIT is not sent. H1_TELEGRAM_MODE = "all" restores one message per bar. The previous decision
// is kept in SIGNAL_CACHE; the same bar processed twice with the same decision is never sent twice.
// Since 2026-11-09 the Decision Engine (src/decision-engine.mjs) is the single decision and sends its
// own message: while it is on (DECISION_ENGINE not "off") no H1 decision message is sent.

export const H1_TELEGRAM_KEY = "telegram:h1:last-decision:v1";
const TTL_S = 14 * 86_400;
const norm = (d) => String(d || "WAIT").trim().toUpperCase();

/** Pure: whether the H1 decision `action` is sent, given the previous bar's decision (or null). */
export function shouldNotifyH1(action, previous, mode = "changes") {
  const a = norm(action);
  if (String(mode).trim().toLowerCase() === "all") return true;
  if (a === "BUY" || a === "SELL") return true;
  return previous != null && norm(previous) !== a;
}

/**
 * Sends the H1 decision message through `send(text)` when the rule allows it, and records the
 * decision as the previous one. A failed send throws (the caller logs it) and leaves the record, so
 * the next bar still compares with the last decision that was recorded.
 */
export async function notifyH1Decision(env, { candleKey, action, text, send }) {
  if (String(env?.DECISION_ENGINE ?? "on").trim().toLowerCase() !== "off") return { sent: false, reason: "decision_engine" };
  const kv = env?.SIGNAL_CACHE;
  let prev = null;
  try { prev = JSON.parse((await kv?.get?.(H1_TELEGRAM_KEY)) || "null"); } catch { prev = null; }
  const a = norm(action);
  if (prev && prev.candle_key === candleKey && norm(prev.decision) === a) return { sent: false, reason: "already_handled" };
  const notify = shouldNotifyH1(a, prev?.decision ?? null, env?.H1_TELEGRAM_MODE ?? "changes");
  if (notify) await send(text);
  try { await kv?.put?.(H1_TELEGRAM_KEY, JSON.stringify({ decision: a, candle_key: candleKey, at: new Date().toISOString() }), { expirationTtl: TTL_S }); } catch { /* best effort */ }
  return { sent: notify, reason: notify ? (a === "BUY" || a === "SELL" ? "directional" : "changed") : "unchanged_wait" };
}
