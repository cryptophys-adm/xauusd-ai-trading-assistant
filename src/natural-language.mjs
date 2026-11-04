// Plain-language helpers for everything an agent shows to a trader.

const SNAKE_CASE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;
const DOTTED_PATH = /\b(?:[a-z][a-z0-9_]*[_0-9][a-z0-9_]*\.[a-z][a-z0-9_]*|[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*[_0-9][a-z0-9_]*)\b/;
const ASSIGNMENT = /\b\w+\s*=\s*\w+/;

/**
 * Errors when agent text reads like code instead of natural language: snake_case
 * field names (buy_confirmed), dotted evidence paths (h1.decision) or key=value
 * pairs. Evidence paths belong in `refs`, never in the text a trader reads.
 */
export function naturalLanguageErrors(text) {
  const s = String(text ?? "");
  const errors = [];
  if (SNAKE_CASE.test(s)) errors.push("not_natural_language:field_name");
  if (DOTTED_PATH.test(s)) errors.push("not_natural_language:evidence_path");
  if (ASSIGNMENT.test(s)) errors.push("not_natural_language:key_value");
  return errors;
}

export const NATURAL_LANGUAGE_RULE =
  "Write insight, summary and dissent in plain natural language for a trader, like a short forum post. " +
  "Never copy a key name or key path from the evidence into that text, and never write words joined by underscores or dots, or key=value pairs. " +
  "Describe evidence in words instead, for example \"the H1 decision is WAIT\", \"the 5m bias is bullish\" or \"verified by parity\". " +
  "Evidence paths go only in the refs array.";

const ENGINE_NAMES = { mizan: "MizanLib", prophet: "Prophet", gmi: "GMI" };
const WEBHOOK_NAMES = { prophet_r38: "Prophet R38", prophet_r37_ssot: "Prophet R37", gmi_v12_70: "GMI v12.70" };

function list(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items.at(-1);
}

/** Natural-language reason for a fail-closed WAIT on incomplete evidence. */
export function describeDegradedEvidence(missing = [], validationErrors = []) {
  const reasons = [];
  const engines = missing.filter(m => m.startsWith("local_calculation:")).map(m => ENGINE_NAMES[m.split(":")[1]] || m.split(":")[1]);
  if (engines.length) reasons.push(`the local ${list(engines)} calculations are not yet verified against TradingView (each needs 24 matching candles in a row)`);
  const webhooks = missing.filter(m => m.startsWith("webhook:")).map(m => WEBHOOK_NAMES[m.split(":")[1]] || m.split(":")[1]);
  if (webhooks.length) reasons.push(`the TradingView ${list(webhooks)} alert for this candle has not arrived`);
  if (missing.includes("fundamental_news_analysis")) reasons.push("there is no fresh, validated news analysis for this hour");
  const otherErrors = validationErrors.filter(e => !e.startsWith("news:"));
  if (otherErrors.length) reasons.push("part of the evidence failed its checks");
  const why = reasons.length ? reasons.join("; ") : "the evidence for this candle is incomplete";
  return `No trade for this candle. The decision is WAIT because ${why}. No entry, stop loss or take profit is issued until all evidence is complete.`;
}
