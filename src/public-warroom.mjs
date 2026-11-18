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
/** Pure: whether a text may stand in a public reading (no price, no order wording, no signal). */
export function publicPhrase(s) {
  const t = String(s ?? "");
  return Boolean(t.trim()) && !PRICE_LIKE.test(t) && !ORDER_WORDING.test(t.replace(ANALYSIS_TERMS, " ")) && !SIGNAL_WORDING.test(t);
}

/** Pure: the sentences of a text a public reading may carry (no price, no order wording, no signal). */
export function readingSentences(text, { max = 3, len = 220 } = {}) {
  const parts = (Array.isArray(text) ? text : [text]).flatMap((t) => String(t ?? "").split(/(?<=[.!?])\s+/));
  return parts.map((s) => clip(s, len)).filter(publicPhrase).slice(0, max);
}

/** Pure: a public name of a metric ("the US dollar strength"), or null. */
function metricName(m) {
  const s = clip(m, 60);
  return publicPhrase(s) ? s : null;
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
