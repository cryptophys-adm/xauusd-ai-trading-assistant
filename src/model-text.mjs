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
