// Helpers for Workers AI text models: chat messages, request forms per model family, and the
// text of every response shape (legacy `response`, Chat Completions, Responses API). Instruct and reasoning models must be called with chat `messages`
// so their chat template is applied; raw `prompt` completion made
// glm-4.7-flash and gemma emit degenerate text ("* * * *", code fragments).

const SYSTEM_SUFFIX = "Answer in English. Follow the requested output format exactly. Never repeat characters or symbols as filler.";

/** First line is the role (system message); the remaining lines are the task (user message). */
export function chatMessages(lines) {
  const [role, ...task] = lines;
  return [
    { role: "system", content: `${role}\n${SYSTEM_SUFFIX}` },
    { role: "user", content: task.join("\n") }
  ];
}

/** Removes reasoning traces, NUL characters and runaway repetition from model text. */
export function cleanModelText(text) {
  let t = String(text ?? "").replace(/\u0000/g, "");
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const strayClose = t.lastIndexOf("</think>");
  if (strayClose >= 0) t = t.slice(strayClose + "</think>".length);
  // Degenerate loop: a short token (1-8 chars) repeated 40+ times, whitespace-separated.
  const loop = t.match(/(\S{1,8}?)(?:\s+\1){39,}/);
  if (loop && loop.index !== undefined) t = `${t.slice(0, loop.index).trimEnd()}\n[truncated: repetitive model output]`;
  return t.trim();
}

/** Returns the first parseable JSON object in model text (code fences tolerated), else null. */
export function extractJsonObject(text) {
  const c = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const tryParse = (candidate) => {
    try {
      const o = JSON.parse(candidate);
      return o && typeof o === "object" && !Array.isArray(o) ? o : null;
    } catch { return null; }
  };
  const direct = tryParse(c);
  if (direct) return direct;
  const end = c.lastIndexOf("}");
  for (let start = c.indexOf("{"); start >= 0 && start < end; start = c.indexOf("{", start + 1)) {
    const parsed = tryParse(c.slice(start, end + 1));
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Token budgets per stage. glm-4.7-flash and nemotron are reasoning models: with
 * chat messages they spend completion tokens on a hidden reasoning trace before
 * writing the answer, so small budgets end with finish_reason "length" and
 * message.content === null.
 */
export const MAX_TOKENS = Object.freeze({ analyst: 4096, counselor: 4096, reasoner: 8192 });

/**
 * Model migration (owner decision 2026-11-07): glm-5.3-flash and nemotron-3-120b-a12b stop
 * answering on 2026-11-20 (Workers AI changelog 2026-11-05: HTTP 410, error 5028). The roles move to
 *   room agents      gemma-4-26b-a4b-it, thinking off (fallback gpt-oss-20b);
 *   moderators/TLDR  gpt-oss-120b (fallback gemma-4-26b-a4b-it);
 *   news chain and the H1 Reasoner  gpt-oss-120b.
 * Each family takes its own request form; modelRequests() builds it.
 */
export const MODELS = Object.freeze({
  GEMMA_4: "@cf/google/gemma-4-26b-a4b-it",
  GPT_OSS_120B: "@cf/openai/gpt-oss-120b",
  GPT_OSS_20B: "@cf/openai/gpt-oss-20b"
});

export function modelFamily(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.includes("gpt-oss")) return "gpt-oss";
  if (m.includes("gemma-4")) return "gemma-4";
  if (m.includes("glm-5")) return "glm-5";
  if (m.includes("glm-4")) return "glm-4";
  if (m.includes("nemotron")) return "nemotron";
  return "chat";
}

const GPT_OSS_EFFORT = { low: "low", medium: "medium", high: "high", max: "high" };

/**
 * The request forms for one call, the most capable first. A form the model rejects (an input
 * validation error, see isRequestShapeError) falls back to the next one: the Workers AI binding
 * documents the plain `messages` form for every model below, but not every structured-output or
 * reasoning field for every model.
 *   gpt-oss   Chat Completions with reasoning_effort (low | medium | high) and a JSON schema, then
 *             without the schema, then the Responses form ({ input, reasoning: { effort } }).
 *   gemma-4   thinking off (chat_template_kwargs.enable_thinking false) with a JSON schema, then
 *             without it.
 *   glm-5     max_completion_tokens, reasoning_effort and a strict JSON schema (until 2026-11-20).
 *   glm-4     the plain chat form; a reasoning model without reasoning_effort, so twice the budget.
 *   nemotron  the plain chat form (until 2026-11-20).
 */
export function modelRequests(model, { messages, maxTokens, effort = "low", schemaName = null, schema = null, temperature = 0.1 }) {
  const rf = schema ? { response_format: { type: "json_schema", json_schema: { name: schemaName || "answer", strict: true, schema } } } : {};
  switch (modelFamily(model)) {
    case "gpt-oss": {
      const e = GPT_OSS_EFFORT[effort] || "low";
      const chat = { messages, max_tokens: maxTokens, temperature, reasoning_effort: e };
      return [...(schema ? [{ ...chat, ...rf }] : []), chat, { input: messages, reasoning: { effort: e } }];
    }
    case "gemma-4": {
      const chat = { messages, max_tokens: maxTokens, temperature, chat_template_kwargs: { enable_thinking: false } };
      return schema ? [{ ...chat, ...rf }, chat] : [chat];
    }
    case "glm-5": return [{ messages, max_completion_tokens: maxTokens, temperature, reasoning_effort: effort === "medium" ? "low" : effort, ...rf }];
    case "glm-4": return [{ messages, max_tokens: maxTokens * 2, temperature }];
    case "nemotron": return [{ messages, max_tokens: maxTokens, temperature }];
    default: {
      const chat = { messages, max_tokens: maxTokens, temperature };
      return schema ? [{ ...chat, ...rf }, chat] : [chat];
    }
  }
}

/** An input-validation error: the model does not take this request form (try the next one). */
export function isRequestShapeError(error) {
  if (error?.name === "TimeoutError") return false;
  return /\b(5006|5021)\b|oneOf|not met|invalid input|bad input|response_format|json[ _-]?mode|json_schema|chat_template|reasoning_effort|additional propert|unknown (field|param)|unsupported|must not have|is not allowed/i.test(String(error?.message || error || ""));
}

/**
 * Runs one model call through its request forms (modelRequests). Returns { result, variant }; a
 * form the model rejects is followed by the next, any other error is thrown at once.
 */
export async function runModel(ai, model, opts) {
  const variants = modelRequests(model, opts);
  let lastError = null;
  for (let i = 0; i < variants.length; i++) {
    try {
      return { result: await ai.run(model, variants[i]), variant: i };
    } catch (error) {
      lastError = error;
      if (i === variants.length - 1 || !isRequestShapeError(error)) throw error;
      console.warn("model_request_form_rejected", JSON.stringify({ model, variant: i, error: String(error?.message || error).slice(0, 200) }));
    }
  }
  throw lastError;
}

/** Text of a Responses API result (gpt-oss): the output_text parts of its message items. */
function responsesText(result) {
  if (!Array.isArray(result?.output)) return null;
  const parts = [];
  for (const item of result.output) {
    if (item?.type !== "message" && item?.role !== "assistant") continue;
    for (const c of Array.isArray(item.content) ? item.content : []) {
      if (typeof c === "string") parts.push(c);
      else if (typeof c?.text === "string" && c.type !== "reasoning_text") parts.push(c.text);
    }
  }
  return parts.join("");
}

/** True when a Responses API result stopped at its output token limit. */
export function responsesIncomplete(result) {
  return result?.status === "incomplete" && /max_output_tokens|length/i.test(String(result?.incomplete_details?.reason ?? "max_output_tokens"));
}

/**
 * Text of a Workers AI response (legacy `response` shape or OpenAI-style
 * chat.completion). Never returns a serialized response object: when the model
 * produced no answer text, returns a short explanatory marker instead.
 */
export function extractModelText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return String(result ?? "");
  for (const key of ["response", "output_text", "text"]) {
    if (typeof result[key] === "string") return result[key];
  }
  // JSON mode may return the parsed object itself.
  if (result.response && typeof result.response === "object" && !Array.isArray(result.response)) return JSON.stringify(result.response);
  const responses = responsesText(result);
  if (responses !== null) {
    if (responses.trim()) return responses;
    return responsesIncomplete(result) ? "[no answer: the model used its whole token budget on reasoning]" : "[no answer: the model returned no text]";
  }
  const first = Array.isArray(result.choices) ? result.choices[0] : null;
  if (first && typeof first === "object") {
    if (typeof first.text === "string") return first.text;
    const content = first.message?.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const joined = content.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")).join("");
      if (joined.trim()) return joined;
    }
    return first.finish_reason === "length"
      ? "[no answer: the model used its whole token budget on reasoning]"
      : "[no answer: the model returned no text]";
  }
  return "[no answer: unrecognised model response shape]";
}
