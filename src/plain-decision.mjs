// Plain-language text for the H1 decision (owner rule: every agent output a trader
// reads is natural language). The decision, its direction, prices and conditions are
// never changed here: only the reasoning, confirmation and invalidation sentences.
import { chatMessages } from "./model-text.mjs";
import { callBusModel } from "./multi-agent-bus.mjs";
import { naturalLanguageErrors } from "./natural-language.mjs";

export const DECISION_TEXT_FIELDS = Object.freeze(["reasoning", "confirmation", "invalidation"]);

export const DECISION_TEXT_RULE =
  "Write reasoning, confirmation and invalidation as plain sentences a trader reads. " +
  "Name each indicator (Prophet, GMI v12.70, MizanLib) and say in words what it shows; Prophet is one indicator, its signal and trade management (R38) and its direction and confirmation candle (R37) read together, " +
  "for example \"GMI v12.70 reports a conflict, so its confluence gate blocks the setup\". " +
  "Never write field names, words joined by underscores, key paths with dots, comparisons such as == or !=, or key = value pairs.";

const COMPARISON = /[=!<>]=|&&|\|\|/;
const REWRITE_TIMEOUT_MS = 60_000;

function textErrors(text) {
  const s = String(text ?? "");
  const errors = naturalLanguageErrors(s);
  if (COMPARISON.test(s)) errors.push("not_natural_language:comparison");
  return errors;
}

/** Fields of a decision whose text reads like code, with their errors. */
export function decisionTextErrors(decision) {
  const out = {};
  for (const field of DECISION_TEXT_FIELDS) {
    const value = decision?.[field];
    if (typeof value !== "string" || !value.trim()) continue;
    const errors = textErrors(value);
    if (errors.length) out[field] = errors;
  }
  return out;
}

/** Standalone numbers only: indicator names and timeframes (R38, v12.70, 15m, H1) are not numbers. */
function numbersIn(text) {
  const matches = String(text ?? "").match(/(?<![A-Za-z\d.])-?\d+(?:\.\d+)?(?![A-Za-z\d])/g) || [];
  // Signs are compared loosely ("-1" may be written as "minus 1"); new magnitudes are what matter.
  return new Set(matches.map(n => String(Math.abs(Number(n)))));
}

/**
 * Returns { decision, status, rewritten }. When a text field reads like code, one call to the
 * bus model rewrites only those fields. A rewrite is kept only when it reads as natural language
 * and introduces no number that the original text did not contain; otherwise the original stays.
 */
export async function plainDecisionText(env, decision, { clock = () => Date.now() } = {}) {
  const bad = decisionTextErrors(decision);
  const fields = Object.keys(bad);
  if (!fields.length) return { decision, status: "plain", rewritten: [] };

  const original = Object.fromEntries(fields.map(f => [f, decision[f]]));
  const schema = {
    type: "object",
    properties: Object.fromEntries(fields.map(f => [f, { type: "string" }])),
    required: fields,
    additionalProperties: false
  };
  const messages = chatMessages([
    "You rewrite the text of an XAUUSD advisory decision into plain language for a trader. You never change the decision, its direction, its numbers, its conditions or its meaning.",
    DECISION_TEXT_RULE,
    `The decision is ${String(decision.decision || "WAIT")} and it stays exactly that.`,
    "Rewrite only the fields below. Keep every condition and every fact; only change how it is written. Do not add any number that is not already in the text.",
    `Required JSON: {${fields.map(f => `"${f}":"..."`).join(",")}}`,
    "TEXT:",
    JSON.stringify(original)
  ]);
  let call;
  try {
    call = await callBusModel(env, {
      messages, schemaName: "plain_decision", schema, maxTokens: 2048, effort: "low",
      deadline: clock() + REWRITE_TIMEOUT_MS, clock, runState: {}
    });
  } catch (error) {
    console.warn("plain_decision_failed", error instanceof Error ? error.message : String(error));
    return { decision, status: "rewrite_failed", rewritten: [] };
  }
  if (call?.status !== "answered" || call.truncated || !call.obj || typeof call.obj !== "object") {
    return { decision, status: "rewrite_failed", rewritten: [] };
  }
  const next = { ...decision };
  const rewritten = [];
  for (const field of fields) {
    const candidate = call.obj[field];
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    if (textErrors(candidate).length) continue;
    const allowed = numbersIn(original[field]);
    if ([...numbersIn(candidate)].some(n => !allowed.has(n))) continue;
    next[field] = candidate.trim();
    rewritten.push(field);
  }
  if (rewritten.length) next.text_rewritten = rewritten;
  return { decision: next, status: rewritten.length === fields.length ? "rewritten" : "partially_rewritten", rewritten };
}
