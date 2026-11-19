// The public War Room reading (owner 2026-11-18, confirmed: "Real-time analysis"; for the CTA studio's Create → War
// Room). The latest reading of one source, as analysis only:
//   - a timeframe room (15m, 1H, 4H, 1D): its bias (bullish, bearish or neutral), its reasons and the metrics it
//     weighed, in plain words, and how many analysts were heard;
//   - the news: the 24-hour digest's reading of gold and the headlines with their effect on gold.
// Never the room's decision (BUY, SELL, WAIT), its confidence, a price, a level or order wording: the content rules
// allow the system's decisions in public only as a recap after 24 hours (public-projection.mjs). Every sentence that
// names a price, uses order wording or names a side as a signal is dropped (`publicPhrase`: public-projection's price and order checks, "order flow" and "order block" being analysis, plus SIGNAL_WORDING). The
// CTA studio's guardian checks the post again. Pure, except readPublicWarRoom.
import { PRICE_LIKE, ORDER_WORDING } from "./public-projection.mjs";

export const PUBLIC_WARROOM_VERSION = "cryptophys.public-warroom.v1";
/** The sources, as the studio names them, and their room in D1 room_runs. */
export const WARROOM_SOURCES = Object.freeze({
  "15m": { room: "warroom", label: "15m" },
  "1h": { room: "tf:H1", label: "1H" },
  "4h": { room: "tf:H4", label: "4H" },
  "1d": { room: "tf:D1", label: "1D" },
  news: { room: null, label: "News" }
});
/** A side or a decision written as a signal, a confidence, an internal dashboard: never in a public reading. */
export const SIGNAL_WORDING = /\b(buy|sell|buying|selling|long|short|decision|decided|confidence|nexus|omega)\b/i;
const BIASES = Object.freeze({ BULLISH: "bullish", BEARISH: "bearish", NEUTRAL: "neutral" });
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const parse = (v, d) => { if (v && typeof v === "object") return v; try { return JSON.parse(v); } catch { return d; } };

/** Analysis terms that contain the word "order" but are no order: order flow, an order block, the order book. */
const ANALYSIS_TERMS = /\border[- ](flow|blocks?|book)s?\b/gi;
/**
 * Positional wording (2026-11-19, the holo war room's per-analyst text): a sentence that says what to do or where one
 * stands is advice, whatever its words: flat, ready to trade, waiting for an entry or a candle, the sidelines, a
 * reference to a ranked item ("#1").
 */
export const POSITION_WORDING = /\b(flat|trade[- ]?ready|ready to trade|setup is ready|in the trade|in a trade|in position|on the sidelines|sidelines|stand aside|stay(?:ing)? out|wait(?:s|ed|ing)?|hold(?:s|ing)? off|take (?:the|a) trade|no trade|position(?:s|ed|ing)?)\b|#\s?\d/i;
/** Names the public text may carry that contain a forbidden word: the Decision Matrix analyst is "Matrix" in public. */
const PUBLIC_NAMES = [[/\bdecision matrix\b/gi, "Matrix"]];
/** A ratio such as Fibonacci 0.618 is no price: decimals under 1 are left out of the price check. */
const RATIOS = /\b0?\.\d+\b/g;
/** Pure: the text with its public names (before any check). */
export const publicNames = (s) => PUBLIC_NAMES.reduce((t, [re, name]) => t.replace(re, name), String(s ?? ""));
/** Pure: whether a text may stand in a public reading (no price, no order wording, no signal, no position). */
export function publicPhrase(s) {
  const t = publicNames(s);
  return Boolean(t.trim()) && !PRICE_LIKE.test(t.replace(RATIOS, " ")) && !ORDER_WORDING.test(t.replace(ANALYSIS_TERMS, " ")) && !SIGNAL_WORDING.test(t) && !POSITION_WORDING.test(t);
}

/**
 * Pure: the sentences of a text a public reading may carry. Each whole sentence is checked first and a sentence longer
 * than `len` is dropped, never clipped: a cut could hide the word that should have refused it (2026-11-19: "...to
 * justify a high-confidence sell" passed once cut at 200 characters).
 */
export function readingSentences(text, { max = 3, len = 220 } = {}) {
  const parts = (Array.isArray(text) ? text : [text]).flatMap((t) => String(t ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/));
  return parts.map((x) => publicNames(x).trim()).filter((x) => x.length <= len && publicPhrase(x)).slice(0, max);
}

/** Pure: a public name of a metric ("the US dollar strength"), or null. */
function metricName(m) {
  const s = publicNames(String(m ?? "").replace(/\s+/g, " ").trim());
  return s.length <= 60 && publicPhrase(s) ? s : null;
}

/** Pure: the public reading of one concluded room run (D1 room_runs row), or null. */
export function publicRoomReading(row, source) {
  const meta = WARROOM_SOURCES[source];
  if (!row || !meta?.room) return null;
  const body = parse(row.body_json, {});
  const c = body?.conclusion ?? {};
  const bias = BIASES[String(row.bias ?? c.bias ?? "").toUpperCase()] ?? null;
  if (!bias) return null;
  const metrics = [...new Set((Array.isArray(c.metrics) ? c.metrics : []).map(metricName).filter(Boolean))].slice(0, 4);
  return {
    version: PUBLIC_WARROOM_VERSION, source, label: meta.label, at: row.bar_close ?? null, bias,
    reasons: readingSentences(c.reasons ?? [], { max: 3 }),
    metrics, analysts: Number.isFinite(Number(row.agents_heard)) ? Number(row.agents_heard) : null
  };
}

/** Pure: the public reading of the 24-hour news digest (readNewsDaily), or null. */
export function publicNewsReading(daily) {
  if (!daily) return null;
  const t = daily.tldr?.status === "ok" ? daily.tldr : null;
  const bias = BIASES[String(t?.stance ?? "").toUpperCase()] ?? null;
  const items = (Array.isArray(daily.items) ? daily.items : [])
    .filter((i) => BIASES[String(i?.bias ?? "").toUpperCase()] && publicPhrase(i.title))
    .slice(0, 6)
    .map((i) => ({ title: clip(i.title, 140), bias: BIASES[String(i.bias).toUpperCase()], published_at: i.published_at ?? null }));
  if (!bias && !items.length) return null;
  const counts = daily.counts && typeof daily.counts === "object"
    ? Object.fromEntries(Object.entries(BIASES).map(([k, v]) => [v, Number(daily.counts[k] ?? daily.counts[v]) || 0])) : null;
  return {
    version: PUBLIC_WARROOM_VERSION, source: "news", label: "News", at: daily.window_to ?? daily.run_at ?? null, bias,
    summary: t ? readingSentences(t.summary ?? "", { max: 2, len: 240 }) : [],
    reasons: t ? readingSentences(t.reasons ?? [], { max: 3 }) : [], counts, items
  };
}

/** The latest public reading of one source (PublicProjection.warroom). Never throws: { error } instead. */
export async function readPublicWarRoom(env, { source } = {}, { readNewsDaily = null } = {}) {
  const meta = WARROOM_SOURCES[source];
  if (!meta) return { version: PUBLIC_WARROOM_VERSION, error: `source must be one of ${Object.keys(WARROOM_SOURCES).join(", ")}` };
  try {
    if (source === "news") {
      const read = readNewsDaily ?? (await import("./news-daily.mjs")).readNewsDaily;
      return publicNewsReading(await read(env.DB)) ?? { version: PUBLIC_WARROOM_VERSION, source, error: "no news reading yet" };
    }
    const row = await env.DB.prepare("SELECT bar_close, bias, agents_heard, body_json FROM room_runs WHERE room = ? AND status = 'concluded' ORDER BY bar_close DESC LIMIT 1").bind(meta.room).first();
    return publicRoomReading(row, source) ?? { version: PUBLIC_WARROOM_VERSION, source, error: "no reading of this room yet" };
  } catch (error) {
    return { version: PUBLIC_WARROOM_VERSION, source, error: String(error?.message ?? error).slice(0, 120) };
  }
}

/** The thread each room's statements live in (D1 agent_thread_messages), by source. */
const THREAD_OF = Object.freeze({ "15m": (bar) => `warroom:${String(bar).slice(0, 10)}`, "1h": () => "tf:H1", "4h": () => "tf:H4", "1d": () => "tf:D1" });
const ID_RE = /^[a-z0-9_]{2,40}$/;

/**
 * Pure: the public scene of one concluded room run for the CTA's holo war room (owner 2026-11-19: "Sinkron dengan room
 * nyata"; "Cukup info yang perlu dan layak untuk konsumsi public"). The roster in speaking order, and per analyst its
 * metric names, at most two sentences of its opening claim and of its rebuttal, the analysts it rebutted and its bias
 * (analysis); the room's bias and the Moderator's public reasons. Never a stance, a confidence, a decision, a price,
 * order or positional wording: every sentence passes readingSentences, every metric metricName.
 */
export function publicRoomScene(row, messages = [], source) {
  const reading = publicRoomReading(row, source);
  if (!reading) return null;
  const body = parse(row.body_json, {});
  const seats = (Array.isArray(body?.agents) ? body.agents : []).filter((a) => typeof a?.agent === "string" && ID_RE.test(a.agent) && a.status !== "failed");
  const byAgent = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    const step = String(m?.step ?? ""), agent = String(m?.agent ?? "");
    if (!ID_RE.test(agent)) continue;
    const b = parse(m.body_json, {});
    const e = byAgent.get(agent) ?? {};
    if (step.startsWith("open:")) e.claim = b.claim ?? b.argument ?? null;
    else if (step.startsWith("debate:")) { e.rebuttal = b.argument ?? b.claim ?? null; e.rebuts = Array.isArray(b.rebuts) ? b.rebuts : []; }
    if (Array.isArray(b.metrics)) e.metrics = b.metrics;
    if (b.bias) e.bias = b.bias;
    byAgent.set(agent, e);
  }
  const ids = new Set(seats.map((a) => a.agent));
  const analysts = seats.map((a) => {
    const e = byAgent.get(a.agent) ?? {};
    const bias = BIASES[String(e.bias ?? a.bias ?? "").toUpperCase()] ?? null;
    return {
      id: a.agent,
      bias,
      metrics: [...new Set((e.metrics ?? a.metrics ?? []).map(metricName).filter(Boolean))].slice(0, 3),
      claim: readingSentences(e.claim ?? "", { max: 2, len: 220 }),
      rebuttal: readingSentences(e.rebuttal ?? "", { max: 2, len: 220 }),
      rebuts: (e.rebuts ?? []).filter((r) => typeof r === "string" && ids.has(r)).slice(0, 3)
    };
  });
  return { source, label: reading.label, at: reading.at, bias: reading.bias, moderator: reading.reasons, analysts };
}

/**
 * The latest public scene of every timeframe room (PublicProjection.warroomScene): one read for the holo war room,
 * which the CTA caches at the edge for about a minute. Never throws: a room that cannot be read is left out.
 */
export async function readPublicWarRoomScene(env) {
  const rooms = {};
  for (const source of ["15m", "1h", "4h", "1d"]) {
    try {
      const meta = WARROOM_SOURCES[source];
      const row = await env.DB.prepare("SELECT bar_close, bias, agents_heard, body_json FROM room_runs WHERE room = ? AND status = 'concluded' ORDER BY bar_close DESC LIMIT 1").bind(meta.room).first();
      if (!row?.bar_close) continue;
      const msgs = (await env.DB.prepare("SELECT step, agent, body_json FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? AND (step LIKE 'open:%' OR step LIKE 'debate:%') LIMIT 60").bind(THREAD_OF[source](row.bar_close), row.bar_close).all()).results ?? [];
      const scene = publicRoomScene(row, msgs, source);
      if (scene) rooms[source] = scene;
    } catch { /* that room is left out */ }
  }
  return { version: PUBLIC_WARROOM_VERSION, rooms, notice: "Analysis, not a signal." };
}
