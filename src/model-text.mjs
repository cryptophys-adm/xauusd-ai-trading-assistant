// Helpers for Workers AI text models used by the analyst/counselor/reasoner
// stages. Instruct and reasoning models must be called with chat `messages`
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
export const MAX_TOKENS = Object.freeze({ analyst: 4096, counselor: 4096, reasoner: 6144, bus_agent: 1536, bus_moderator: 2048 });

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
