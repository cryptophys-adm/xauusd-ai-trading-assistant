// Z2b inert at ship (test/zone-aim.test.mjs ZA-18): what the model and execution see, under the live wrangler.jsonc vars.
// Written against modules passed in, so the same code runs on this tree and on a git-archive of main (the pinned hashes
// were taken with it on main 6135237, before Z2b). Pure: no Worker run, no network, no D1.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
// Z1b adds ds_sources (the source labels) to the recorded key_levels; the pins hold everything else byte for byte.
// On a tree without the field (main 6135237) this is the identity.
// Stored rows hold the record as JSON text, so a string that parses as an object or array is stripped inside too.
export const withoutDsSources = (v) => JSON.parse(JSON.stringify(v, (k, x) => {
  if (k === "ds_sources") return undefined;
  if (typeof x === "string" && /^[[{]/.test(x)) { try { return JSON.stringify(withoutDsSources(JSON.parse(x))); } catch { return x; } }
  return x;
}));

/** The top-level `vars` of a wrangler.jsonc (comments and trailing commas stripped; strings kept whole). */
export function wranglerVars(url) {
  const src = readFileSync(url, "utf8");
  let out = "", inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) { out += c; if (c === "\\") { out += src[++i]; } else if (c === "\"") inStr = false; continue; }
    if (c === "\"") { inStr = true; out += c; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2) + 1; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")).vars;
}

const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const iso = "2026-11-20T13:00:00.000Z";
const row = (key, lean, action = "WAIT") => ({ key, label: key, role: key, available: true, lean, action, confidence: 0.6, summary: `${key} reads the chart.`, at: iso, stale: false });
const tf = (s) => ({ timeframes: [row("D1", 0.5 * s), row("H4", 0.45 * s), row("H1", 0.4 * s), row("M15", 0.35 * s, s > 0 ? "BUY" : "SELL"), row("NEWS", 0.2 * s), row("MACRO", 0.1 * s)] });
const answer = (stance) => ({ answer: { stance, bias: stance === "BUY" ? "BULLISH" : "BEARISH", confidence: 0.7, entry_type: "limit", target: "tp1", summary: `Decision ${stance}: the witnesses agree.`, reasons: ["The witnesses agree."], risks: [], weighed: ["D1"] } });

/**
 * The execution- and model-facing outputs per case, each hashed: the council's messages (prompt and evidence, the plans'
 * notes included), the guardrails' plans, the agents' plans, the trade, strategy_plans, the whole decision record, the EA
 * signal and managementFields, MS2's shadow rows, and the frozen capture's guardrails. `fx`: { zoneInputs, CLOSE, NOW,
 * capture } from the fixtures; `env`: the vars.
 */
export async function inertOutputs({ se, de, ea, gunzipJson }, fx, env) {
  const { zoneInputs, CLOSE, NOW } = fx;
  const key = `OANDA:XAUUSD:15:${Date.parse(CLOSE) - 15 * 60_000}`;
  const cases = [];
  for (const prophet of [false, true]) for (const s of [1, -1]) {
    const inputs = zoneInputs(undefined, { prophet });
    cases.push({ name: `${prophet ? "prophet" : "z0"}_${s > 0 ? "buy" : "sell"}`, loaded: { inputs, strategy: se.buildStrategy(inputs), global: tf(s), correlations: null, regime: "normal-trending" }, council: answer(s > 0 ? "BUY" : "SELL") });
  }
  const out = {};
  for (const c of cases) {
    const a = de.assess(c.loaded, { now: NOW, env });
    const record = de.buildDecisionRecord({ key, barClose: CLOSE, loaded: c.loaded, assessment: a, council: c.council, now: NOW, env });
    const evidence = de.councilEvidence({ barClose: CLOSE, cards: a.cards, quorum: a.quorum, guards: a.guards });
    const side = (g) => ({ plan: g.plan, plans: g.plans, checks: g.checks });
    out[c.name] = {
      messages: sha(de.councilMessages(evidence)),
      guards: sha({ long: side(a.guards.long), short: side(a.guards.short) }),
      trade: sha(record.trade), strategy_plans: sha(record.strategy_plans), record: sha(withoutDsSources(record)),
      signal: sha(ea.eaSignalFromDecision({ decision: record, now: NOW })), management: sha(ea.managementFields(record)),
      shadow: sha(de.shadowModeDecisions({ loaded: c.loaded, assessment: a, council: c.council, env, now: NOW })),
      stance: record.stance
    };
  }
  const slim = await gunzipJson(fx.capture);
  const strategy = se.buildStrategy(slim);
  const Q = { long_share: 0.8, short_share: 0.1, neutral_share: 0.1, score: 0.6, bias: "BULLISH" };
  out.capture = sha([1, -1].map((dir) => de.guardrailsFor(dir, { cards: [], quorum: Q, strategy, inputs: slim, now: slim.now, env })));
  return out;
}
