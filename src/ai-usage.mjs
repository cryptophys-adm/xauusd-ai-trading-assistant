// Workers AI usage meter (owner 2026-11-11: "kurangi neuron/hari tanpa mengurangi kapabilitas agent").
//
// One row per day, source (the request's schema name or the H1 chain step) and model: calls, input and
// output tokens, failed calls, calls the caller abandoned at its timeout, and the room memo counters
// (src/room-memo.mjs). Neurons are computed at read time from the published per-model rates, so the
// Nexus panel shows where the neurons go and whether a saving is real.
//
// A call abandoned at its timeout is still billed by Workers AI when it finishes: its tokens land here
// as a late completion while the isolate lives, and `timeouts` counts the abandonment itself.

export const AI_USAGE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  timeouts INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  memo_hits INTEGER NOT NULL DEFAULT 0,
  memo_same INTEGER NOT NULL DEFAULT 0,
  reused INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, model)
)`
];

/**
 * Neurons per million tokens (Workers AI pricing page, 2026-11-11). A model missing here is shown with
 * its tokens and no neuron estimate, never with a guessed rate.
 */
export const NEURON_RATES = Object.freeze({
  "@cf/google/gemma-4-26b-a4b-it": { input: 9091, output: 27273 },
  "@cf/openai/gpt-oss-120b": { input: 31818, output: 68182 },
  "@cf/openai/gpt-oss-20b": { input: 18182, output: 27273 },
  "@cf/zai-org/glm-4.7-flash": { input: 5500, output: 36400 },
  "@cf/baai/bge-small-en-v1.5": { input: 1841, output: 0 }
});
/** Neurons included per day; above it each 1,000 neurons cost USD 0.011 (Workers Paid). */
export const FREE_NEURONS_PER_DAY = 10_000;
export const USD_PER_1K_NEURONS = 0.011;

let schemaReady = false;
export async function ensureAiUsageSchema(db) {
  if (schemaReady) return;
  for (const sql of AI_USAGE_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
export function resetAiUsageSchemaCacheForTests() { schemaReady = false; }

const int = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.round(Number(x)) : 0);

/** Input and output tokens of a model result (Chat Completions or Responses usage); zeros when absent. */
export function usageSplit(result) {
  const u = result?.usage;
  if (!u || typeof u !== "object") return { prompt: 0, completion: 0 };
  const prompt = int(u.prompt_tokens ?? u.input_tokens);
  let completion = int(u.completion_tokens ?? u.output_tokens);
  if (!completion && int(u.total_tokens) > prompt) completion = int(u.total_tokens) - prompt;
  return { prompt, completion };
}

const label = (s) => String(s || "unlabelled").replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 64);

/**
 * Adds one event to the day's row. outcome: "ok" (tokens counted), "failed", "timeout", "memo_hit"
 * (shadow: the same input was answered before), "memo_same" (and the new answer kept the same stance
 * and bias), "reused" (the stored answer was used, no model call). Never throws.
 */
export async function recordAiUsage(db, { source, model, outcome = "ok", prompt = 0, completion = 0, now = Date.now() } = {}) {
  if (!db?.prepare) return false;
  try {
    await ensureAiUsageSchema(db);
    const day = new Date(now).toISOString().slice(0, 10);
    const add = { calls: 0, failed: 0, timeouts: 0, prompt_tokens: 0, completion_tokens: 0, memo_hits: 0, memo_same: 0, reused: 0 };
    if (outcome === "ok") { add.calls = 1; add.prompt_tokens = int(prompt); add.completion_tokens = int(completion); }
    else if (outcome === "failed") add.failed = 1;
    else if (outcome === "timeout") add.timeouts = 1;
    else if (outcome === "memo_hit") add.memo_hits = 1;
    else if (outcome === "memo_same") add.memo_same = 1;
    else if (outcome === "reused") add.reused = 1;
    else return false;
    const cols = Object.keys(add);
    await db.prepare(
      `INSERT INTO ai_usage_daily (day, source, model, ${cols.join(", ")}) VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")}) ` +
      `ON CONFLICT(day, source, model) DO UPDATE SET ${cols.map((c) => `${c} = ${c} + excluded.${c}`).join(", ")}`
    ).bind(day, label(source), String(model || "none").slice(0, 80), ...cols.map((c) => add[c])).run();
    return true;
  } catch {
    return false;
  }
}

/** Estimated neurons of a row, or null when the model has no published rate here. */
export function neuronsOf(model, prompt, completion) {
  const r = NEURON_RATES[model];
  if (!r) return null;
  return Math.round((int(prompt) * r.input + int(completion) * r.output) / 1_000_000);
}

/**
 * The usage of the last `days` days (today included): one entry per day, source and model with its
 * neurons, the totals per day, and the estimated cost above the daily free neurons.
 */
export async function readAiUsage(db, { days = 2, now = Date.now() } = {}) {
  await ensureAiUsageSchema(db);
  const n = Math.min(Math.max(Math.round(Number(days) || 1), 1), 31);
  const since = new Date(now - (n - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = ((await db.prepare("SELECT * FROM ai_usage_daily WHERE day >= ? ORDER BY day DESC, source, model").bind(since).all()).results || [])
    .map((r) => ({ ...r, neurons: neuronsOf(r.model, r.prompt_tokens, r.completion_tokens) }));
  const byDay = new Map();
  for (const r of rows) {
    const d = byDay.get(r.day) || { day: r.day, calls: 0, failed: 0, timeouts: 0, prompt_tokens: 0, completion_tokens: 0, neurons: 0, unpriced_tokens: 0, memo_hits: 0, memo_same: 0, reused: 0 };
    // The evidence-key counters (A4, shadow, source "evidence_memo:<schema>") are another key's: kept on their own
    // rows, never added to the live memo's daily totals.
    const shadowKey = String(r.source).startsWith("evidence_memo:");
    for (const k of ["calls", "failed", "timeouts", "prompt_tokens", "completion_tokens", "memo_hits", "memo_same", "reused"]) if (!(shadowKey && (k === "memo_hits" || k === "memo_same"))) d[k] += Number(r[k]) || 0;
    if (r.neurons == null) d.unpriced_tokens += (Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0);
    else d.neurons += r.neurons;
    byDay.set(r.day, d);
  }
  const totals = [...byDay.values()].map((d) => ({ ...d, billable_neurons: Math.max(0, d.neurons - FREE_NEURONS_PER_DAY), est_usd: Math.round(Math.max(0, d.neurons - FREE_NEURONS_PER_DAY) / 1000 * USD_PER_1K_NEURONS * 1000) / 1000 }));
  return {
    days: n, since, free_neurons_per_day: FREE_NEURONS_PER_DAY, usd_per_1k_neurons: USD_PER_1K_NEURONS,
    note: "Estimate from the tokens Workers AI reported to this Worker and the published per-model rates; the Cloudflare bill is the authority.",
    totals, rows
  };
}
