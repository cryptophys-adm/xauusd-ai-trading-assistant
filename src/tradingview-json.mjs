// TradingView alert payloads are hand-built JSON strings in Pine. A field
// written with str.tostring(x) where x is na (or ±inf) produces the bare
// tokens NaN / Infinity, which are not valid JSON (e.g. GMI's
// "shared_core_status":NaN and Prophet's "structure_state":NaN). Strict
// JSON.parse rejects the whole alert, so the webhook lane silently loses it.
//
// parseTradingViewJson parses strictly first; only on failure does it replace
// those bare tokens (outside string literals, at value positions) with null —
// Pine's na — and parse again. Nothing else is repaired.

const BARE_TOKENS = ["-Infinity", "Infinity", "-NaN", "NaN"];

export function normalizeNonFiniteTokens(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let replaced = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    const token = BARE_TOKENS.find((t) => text.startsWith(t, i));
    if (token) {
      const before = out.replace(/\s+$/, "").slice(-1);
      const after = text.slice(i + token.length).replace(/^\s+/, "")[0];
      if ((before === ":" || before === "," || before === "[") && (after === undefined || after === "," || after === "}" || after === "]")) {
        out += "null";
        i += token.length - 1;
        replaced++;
        continue;
      }
    }
    out += ch;
  }
  return { text: out, replaced };
}

/** Returns { value, normalized_tokens } or throws SyntaxError like JSON.parse. */
export function parseTradingViewJson(text) {
  try {
    return { value: JSON.parse(text), normalized_tokens: 0 };
  } catch (strictError) {
    const { text: fixed, replaced } = normalizeNonFiniteTokens(String(text));
    if (replaced === 0) throw strictError;
    return { value: JSON.parse(fixed), normalized_tokens: replaced };
  }
}
