// News Daily (owner decision 2026-11-06): the News tab and every News Analyst desk read one
// rolling analysis of the last 24 hours instead of the hourly batch alone.
//
//   1. Articles: the union of every hourly news analysis of the last 24 hours (the hourly
//      pull keeps its own one-hour window; nothing extra is pulled from TradingView).
//   2. Context: how gold, the dollar index, WTI oil and the USDT dominance moved over the
//      same 24 hours, from the cached closed bars.
//   3. Each article gets a gold bias, BULLISH, BEARISH or NEUTRAL, with one plain sentence
//      why. A tagged article keeps its tag (cached), so each run tags only new articles.
//   4. The News Analyst writes the TLDR: one bias for gold over the day, a short summary and
//      one to three reasons.
// Advisory only: a bias is a fundamental reading, never an order. Runs from the hourly news
// cron behind NEWS_DAILY_ENABLED, within NEWS_DAILY_MAX_CALLS_PER_HOUR.
import { chatMessages } from "./model-text.mjs";
import { naturalLanguageErrors } from "./natural-language.mjs";
import { filterRecentUniqueArticles } from "./news-filter.mjs";
import { BUS_DEFAULT_MODEL, BUS_MAX_TOKENS } from "./multi-agent-bus.mjs";
import { ensureThreadSchema, rowToThreadMessage, threadInternals } from "./agent-threads.mjs";

const { runStep, writeMessage, upsertThread, callsInLastHour, RULES_NO_REFS, clip, inUnit, parseJson } = threadInternals;

export const NEWS_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const NEWS_BIASES = Object.freeze(["BULLISH", "BEARISH", "NEUTRAL"]);
export const NEWS_DAILY_MAX_ITEMS = 40;
export const NEWS_DAILY_BATCH = 20;
const STEP_MS = 90_000;
const WHY_MAX = 180;
const BIAS_KEY = "newsbias:v1:";
const BIAS_TTL = { expirationTtl: 60 * 60 * 24 * 3 };
const CONTEXT_SERIES = Object.freeze([
  ["gold", "OANDA:XAUUSD|1h", "gold (XAUUSD)"],
  ["dollar", "TVC:DXY|4h", "the US dollar index (DXY)"],
  ["oil", "TVC:USOIL|1h", "WTI oil (USOIL)"],
  ["usdt", "CRYPTOCAP:USDT|4h", "the USDT dominance"]
]);

export function newsDailyEnabled(env) {
  return String(env?.NEWS_DAILY_ENABLED || "").toLowerCase() === "true";
}

const TAG_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { items: { type: "array", items: { type: "object", additionalProperties: false, properties: { n: { type: "number" }, bias: { type: "string", enum: [...NEWS_BIASES] }, why: { type: "string" } }, required: ["n", "bias", "why"] } } },
  required: ["items"]
});
const TLDR_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { stance: { type: "string", enum: [...NEWS_BIASES] }, confidence: { type: "number" }, summary: { type: "string" }, reasons: { type: "array", items: { type: "string" } } },
  required: ["stance", "confidence", "summary", "reasons"]
});

const RULES = [
  "A bias is the likely effect of the news on the gold price: BULLISH (supports gold), BEARISH (weighs on gold) or NEUTRAL (no clear effect, or mixed).",
  "Judge only from the headline and what it reports; say so when a headline is only loosely related to gold. Never give entry, stop loss, take profit, position size or an order."
].join("\n");

/** Every tagged article must come back once, with a valid bias and a plain sentence. */
export function validateTags(o, numbers) {
  if (!o || typeof o !== "object" || !Array.isArray(o.items)) return { valid: false, errors: ["items_missing"] };
  const errors = [];
  const seen = new Set();
  for (const it of o.items) {
    if (!it || !numbers.includes(it.n) || seen.has(it.n)) { errors.push("item_unknown"); continue; }
    seen.add(it.n);
    if (!NEWS_BIASES.includes(it.bias)) errors.push("bias_invalid");
    if (typeof it.why !== "string" || !it.why.trim()) errors.push("why_missing");
    else errors.push(...naturalLanguageErrors(it.why));
  }
  if (seen.size !== numbers.length) errors.push("items_incomplete");
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

/** The TLDR: one bias for the day, a plain summary and one to three reasons. */
export function validateNewsTldr(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  const errors = [];
  if (!NEWS_BIASES.includes(o.stance)) errors.push("stance_invalid");
  if (!inUnit(o.confidence)) errors.push("confidence_out_of_range");
  if (typeof o.summary !== "string" || !o.summary.trim()) errors.push("summary_missing");
  else errors.push(...naturalLanguageErrors(o.summary));
  if (Array.isArray(o.reasons)) o.reasons = o.reasons.filter(r => !(typeof r === "string" && !r.trim()));
  if (!Array.isArray(o.reasons) || o.reasons.length < 1 || o.reasons.some(r => typeof r !== "string")) errors.push("reasons_invalid");
  else for (const r of o.reasons.slice(0, 3)) errors.push(...naturalLanguageErrors(r));
  return { valid: errors.length === 0, errors };
}

const publishedMs = (a) => {
  const v = a?.published_at;
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const p = Date.parse(String(v ?? ""));
  return Number.isFinite(p) ? p : null;
};
const articleId = (a) => String(a.id || a.url || a.title || "").slice(0, 300);

/** The unique articles of the last 24 hours, newest first, from the stored hourly analyses. */
export async function collectDailyArticles(db, now = Date.now()) {
  const since = new Date(now - NEWS_DAILY_WINDOW_MS - 2 * 3600_000).toISOString();
  const rows = (await db.prepare("SELECT evidence_json FROM news_analyses WHERE analyzed_at >= ? ORDER BY analyzed_at DESC LIMIT 72").bind(since).all()).results || [];
  const all = [];
  for (const row of rows) {
    const articles = parseJson(row.evidence_json, {})?.articles;
    if (Array.isArray(articles)) all.push(...articles);
  }
  return filterRecentUniqueArticles(all, now, NEWS_DAILY_WINDOW_MS)
    .map((a) => ({ id: articleId(a), title: clip(a.title, 240), url: typeof a.url === "string" ? a.url : null, published_at: new Date(publishedMs(a)).toISOString(), symbols: Array.isArray(a.symbols) ? a.symbols.slice(0, 4) : [] }))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .slice(0, NEWS_DAILY_MAX_ITEMS);
}

/** How each market moved over the last 24 hours (closed bars); null when not cached. */
export async function marketContext(env, now = Date.now()) {
  const out = {};
  for (const [id, key, label] of CONTEXT_SERIES) {
    try {
      const candles = parseJson(await env.SIGNAL_CACHE?.get?.("market-data:v2:series:" + key), {})?.candles;
      const closed = (Array.isArray(candles) ? candles : []).filter((c) => Date.parse(c.close_time) <= now);
      const last = closed.at(-1);
      const lastMs = Date.parse(last?.close_time ?? "");
      const before = [...closed].reverse().find((c) => Date.parse(c.close_time) <= lastMs - NEWS_DAILY_WINDOW_MS);
      out[id] = last && before && before.close ? { market: label, last_close: Math.round(last.close * 1000) / 1000, change_24h_percent: Math.round(((last.close - before.close) / before.close) * 10000) / 100, as_of: last.close_time } : null;
    } catch { out[id] = null; }
  }
  return out;
}

async function digestOf(items) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(items.map((i) => i.id).join("\n")));
  return Array.from(new Uint8Array(bytes)).map((v) => v.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function tagMessages(batch, context) {
  return chatMessages([
    "You are the News Analyst of the XAUUSD forum. Tag each headline below with its likely effect on the gold price.",
    RULES_NO_REFS,
    RULES,
    "The market context tells you how gold, the dollar and oil moved over the same 24 hours; use it only to judge relevance, never to invent news.",
    `Required JSON: {"items":[{"n":<number>,"bias":"BULLISH|BEARISH|NEUTRAL","why":"one plain sentence, <= ${WHY_MAX - 30} chars"}]} with every n exactly once.`,
    "MARKET CONTEXT (last 24 hours):",
    JSON.stringify(context),
    "HEADLINES:",
    JSON.stringify(batch.map((b) => ({ n: b.n, title: b.title, published_at: b.published_at, symbols: b.symbols })))
  ]);
}

function tldrMessages(items, context, counts) {
  return chatMessages([
    "You are the News Analyst of the XAUUSD forum. Write the TLDR of the last 24 hours of news for gold: one bias for the day, a short summary and one to three reasons.",
    RULES_NO_REFS,
    RULES,
    "Weigh headlines by importance and recency, not by their number: one central bank or inflation headline can outweigh many minor ones. Relate the news to how gold, the dollar and oil actually moved, and say so when they disagree. No repetition.",
    'Required JSON: {"stance":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"summary":"<= 320 chars","reasons":["<= 160 chars", "at most 3"]}',
    "MARKET CONTEXT (last 24 hours):",
    JSON.stringify(context),
    "COUNTS: " + JSON.stringify(counts),
    "TAGGED HEADLINES (newest first):",
    JSON.stringify(items.map((i) => ({ title: i.title, published_at: i.published_at, bias: i.bias, why: i.why })))
  ]);
}

const countBiases = (items) => ({
  bullish: items.filter((i) => i.bias === "BULLISH").length,
  bearish: items.filter((i) => i.bias === "BEARISH").length,
  neutral: items.filter((i) => i.bias === "NEUTRAL").length,
  untagged: items.filter((i) => !i.bias).length
});

/** One run of the daily news analysis; skipped while the 24-hour article set is unchanged. */
export async function runNewsDaily(env, { now = Date.now(), clock = () => Date.now() } = {}) {
  if (!newsDailyEnabled(env)) return { status: "disabled" };
  const db = env.DB;
  await ensureThreadSchema(db);
  const items = await collectDailyArticles(db, now);
  if (!items.length) return { status: "no_articles" };
  const digest = await digestOf(items);
  const latest = await readNewsDaily(db);
  if (latest?.digest === digest && latest.tldr?.status === "ok") return { status: "unchanged", items: items.length };

  const runId = new Date(Math.floor(now / 60_000) * 60_000).toISOString();
  const threadId = `newsdaily:${runId.slice(0, 10)}`;
  await upsertThread(db, { id: threadId, kind: "newsdaily", refKey: runId.slice(0, 10), title: `News Daily · ${runId.slice(0, 10)}`, post: null, now: clock() });
  const context = await marketContext(env, now);
  const maxPerHour = Number(env.NEWS_DAILY_MAX_CALLS_PER_HOUR ?? 6);
  let remaining = 0;
  try { remaining = (Number.isFinite(maxPerHour) ? maxPerHour : 0) - (await callsInLastHour(db, clock(), "newsdaily")); } catch { remaining = 0; }
  const dailyEnv = { ...env, MULTI_AGENT_FALLBACK_MODEL: env.MULTI_AGENT_MODEL || BUS_DEFAULT_MODEL };
  let calls = 0;
  const step = (base, opts) => {
    const deadline = clock() + STEP_MS;
    calls += 1;
    return runStep(dailyEnv, db, base, { ...opts, deadline, clock, runState: { primaryError: null }, budgetOk: async () => clock() < deadline && remaining-- > 0 });
  };
  const base = (stepName, agent) => ({ thread_id: threadId, run_id: runId, step: stepName, agent, parent_id: null, bar_time: null });

  // Tags: cached per article, so a run tags only the articles it has not seen.
  const tagged = await Promise.all(items.map(async (item) => {
    try { const cached = parseJson(await env.SIGNAL_CACHE?.get?.(BIAS_KEY + item.id), null); return cached?.bias ? { ...item, bias: cached.bias, why: cached.why } : item; }
    catch { return item; }
  }));
  const todo = tagged.filter((i) => !i.bias);
  for (let b = 0; b * NEWS_DAILY_BATCH < todo.length; b += 1) {
    const batch = todo.slice(b * NEWS_DAILY_BATCH, (b + 1) * NEWS_DAILY_BATCH).map((item, i) => ({ ...item, n: i + 1 }));
    const numbers = batch.map((x) => x.n);
    const msg = await step(base(`tag:${b + 1}`, "news"), {
      messages: tagMessages(batch, context), schemaName: "news_daily_tags", schema: TAG_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.moderator, effort: "low", validate: (o) => validateTags(o, numbers),
      toBody: (o) => ({ body: { items: o.items.map((it) => ({ n: it.n, bias: it.bias, why: clip(it.why, WHY_MAX) })) }, refs: [] })
    });
    if (msg?.status !== "ok") continue;
    for (const it of msg.items || []) {
      const item = batch.find((x) => x.n === it.n);
      if (!item) continue;
      const target = tagged.find((t) => t.id === item.id);
      target.bias = it.bias; target.why = it.why;
      try { await env.SIGNAL_CACHE?.put?.(BIAS_KEY + item.id, JSON.stringify({ bias: it.bias, why: it.why }), BIAS_TTL); } catch { /* the tag is still stored in this run */ }
    }
  }
  const counts = countBiases(tagged);
  await writeMessage(db, { ...base("brief", "system"), ts: new Date(clock()).toISOString(), status: "info", body: { digest, window_from: new Date(now - NEWS_DAILY_WINDOW_MS).toISOString(), window_to: new Date(now).toISOString(), context, counts, items: tagged } });
  const usable = tagged.filter((i) => i.bias);
  if (!usable.length) return { status: "no_tags", calls, items: tagged.length };
  await step(base("tldr", "news"), {
    messages: tldrMessages(usable, context, counts), schemaName: "news_daily_tldr", schema: TLDR_SCHEMA,
    maxTokens: BUS_MAX_TOKENS.moderator, effort: "low", validate: validateNewsTldr,
    toBody: (o) => ({ body: { summary: clip(o.summary, 400), reasons: o.reasons.slice(0, 3).map((r) => clip(r, 200)) }, refs: [] })
  });
  return { status: "complete", calls, items: tagged.length, tagged_now: todo.length };
}

/** The latest daily news analysis for the News tab: items with their bias, and the TLDR. */
export async function readNewsDaily(db) {
  await ensureThreadSchema(db);
  const row = await db.prepare("SELECT thread_id, run_id FROM agent_thread_messages WHERE thread_id LIKE 'newsdaily:%' AND step = 'brief' ORDER BY run_id DESC LIMIT 1").first();
  if (!row) return null;
  const rows = ((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? ORDER BY id").bind(row.thread_id, row.run_id).all()).results || []).map(rowToThreadMessage);
  const brief = rows.find((m) => m.step === "brief");
  const t = rows.find((m) => m.step === "tldr");
  return {
    run_at: row.run_id, digest: brief?.digest ?? null, window_from: brief?.window_from ?? null, window_to: brief?.window_to ?? null,
    context: brief?.context ?? null, counts: brief?.counts ?? null,
    items: (brief?.items || []).map((i) => ({ title: i.title, url: i.url, published_at: i.published_at, symbols: i.symbols, bias: i.bias ?? null, why: i.why ?? null })),
    tldr: t ? { status: t.status, stance: t.stance, confidence: t.confidence, summary: t.summary ?? null, reasons: t.reasons ?? [] } : null
  };
}

/** What a News Analyst desk reads: the daily TLDR and the bias counts, or null. */
export async function newsDeskEvidence(db) {
  try {
    const d = await readNewsDaily(db);
    if (!d || d.tldr?.status !== "ok") return null;
    return {
      window: "the last 24 hours", consensus: d.tldr.stance, confidence: d.tldr.confidence, summary: d.tldr.summary, reasons: d.tldr.reasons, counts: d.counts,
      headlines: d.items.filter((i) => i.bias).slice(0, 6).map((i) => ({ title: i.title, bias: i.bias }))
    };
  } catch { return null; }
}
