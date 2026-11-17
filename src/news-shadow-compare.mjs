// Measurement phase B for the news shadow (owner 2026-11-17: "setuju c, bandingkan dulu", then "A dan B", relayed).
// Once a UTC day, after New York's close, the last 24 hours of headlines are read twice by the same analyst prompt:
// TradingView's set and the free sources' set (fundamental-news-ingestion src/news-sources.mjs, phase A). Each
// reading is a small structured answer (gold and dollar bias, impact, up to three catalysts); both are kept in D1
// news_shadow_compare with whether they agree. Nothing here feeds a room, a decision or News Daily: it only measures
// whether the free sources would have led the news analyst to the same reading.
//
// Cost: two calls a day of the agent model, metered as "shadow:news_compare", so the shadow switch and its daily
// neuron breaker (src/shadow-switch.mjs) hold it like every other shadow path; it also waits while the day's shadow
// spend is past 80% of that budget. About 1,200 prompt and 600 completion tokens a call: on gpt-oss-120b about 80
// neurons, so about 160 neurons a day (below USD 0.002 at the paid rate). NEWS_SHADOW_COMPARE "off" stops it.
import { callBusModel } from "./model-call.mjs";
import { shadowAllowed, shadowSpendToday, shadowBudget, SHADOW_METER_PREFIX } from "./shadow-switch.mjs";

export const NEWS_COMPARE_METER = `${SHADOW_METER_PREFIX}news_compare`;
/** The UTC hour after which the day's comparison runs (New York has closed). */
export const NEWS_COMPARE_HOUR = 21;
const MAX_HEADLINES = 40;
const BIAS = ["BULLISH", "BEARISH", "NEUTRAL"];
const IMPACT = ["LOW", "MEDIUM", "HIGH"];
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS news_shadow_compare (
  day TEXT PRIMARY KEY, at TEXT NOT NULL, tv_n INTEGER NOT NULL, shadow_n INTEGER NOT NULL,
  tv_json TEXT, shadow_json TEXT, agree_gold INTEGER, agree_dollar INTEGER, agree_impact INTEGER, status TEXT NOT NULL)`;

export const NEWS_READING_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["gold_bias", "dollar_bias", "impact", "catalysts"],
  properties: {
    gold_bias: { type: "string", enum: BIAS },
    dollar_bias: { type: "string", enum: BIAS },
    impact: { type: "string", enum: IMPACT },
    catalysts: { type: "array", maxItems: 3, items: { type: "string", maxLength: 120 } }
  }
});

/** Pure: the analyst's messages for one set of headlines (titles and times only; never prices). */
export function readingMessages(headlines) {
  const list = headlines.slice(0, MAX_HEADLINES).map((h) => `- ${String(h.title).slice(0, 200)}${h.published_at ? ` (${String(h.published_at).slice(0, 16)}Z)` : ""}`).join("\n");
  return [
    { role: "system", content: "You are the Fundamental News Analyst for XAUUSD decision support. Read only the supplied headlines. Do not infer price action or unpublished facts. Answer with JSON: gold_bias and dollar_bias (BULLISH, BEARISH or NEUTRAL), impact on gold (LOW, MEDIUM or HIGH) and up to three key catalysts named from the headlines." },
    { role: "user", content: `HEADLINES OF THE LAST 24 HOURS:\n${list || "(none)"}` }
  ];
}

/** Pure: a model answer reduced to the schema's fields, or null when it does not fit. */
export function cleanReading(obj) {
  if (!obj || !BIAS.includes(obj.gold_bias) || !BIAS.includes(obj.dollar_bias) || !IMPACT.includes(obj.impact)) return null;
  return { gold_bias: obj.gold_bias, dollar_bias: obj.dollar_bias, impact: obj.impact, catalysts: (Array.isArray(obj.catalysts) ? obj.catalysts : []).filter((c) => typeof c === "string").slice(0, 3).map((c) => c.slice(0, 120)) };
}

/** Pure: the agreement of two readings, field by field (null when either is missing). */
export function agreement(tv, shadow) {
  if (!tv || !shadow) return { gold: null, dollar: null, impact: null };
  return { gold: tv.gold_bias === shadow.gold_bias, dollar: tv.dollar_bias === shadow.dollar_bias, impact: tv.impact === shadow.impact };
}

/**
 * The day's comparison, once, after NEWS_COMPARE_HOUR UTC. Gated by the shadow switch, its budget headroom and
 * NEWS_SHADOW_COMPARE. Never throws; returns what it did.
 */
export async function runNewsShadowCompare(env, { now = Date.now(), call = callBusModel } = {}) {
  if (String(env?.NEWS_SHADOW_COMPARE ?? "on").trim().toLowerCase() === "off") return { status: "off" };
  const db = env?.DB;
  if (!db || typeof env?.NEWS_INGESTION?.shadowItems !== "function") return { status: "unavailable" };
  if (new Date(now).getUTCHours() < NEWS_COMPARE_HOUR) return { status: "waiting" };
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    await db.prepare(SCHEMA_SQL).run();
    if (await db.prepare("SELECT day FROM news_shadow_compare WHERE day = ?").bind(day).first()) return { status: "done", day };
    if (!(await shadowAllowed(env))) return { status: "shadow_off" };
    const spend = await shadowSpendToday(db, { now });
    if (spend.neurons >= 0.8 * shadowBudget(env)) return { status: "shadow_budget_headroom", neurons: spend.neurons };
    const items = await env.NEWS_INGESTION.shadowItems({ hours: 24 });
    const tvSet = Array.isArray(items?.tv) ? items.tv : [], shadowSet = Array.isArray(items?.shadow) ? items.shadow : [];
    const read = async (set) => {
      if (!set.length) return null;
      const r = await call(env, { messages: readingMessages(set), schemaName: "news_reading", schema: NEWS_READING_SCHEMA, maxTokens: 700, effort: "low", deadline: Date.now() + 60_000, clock: () => Date.now(), runState: {}, role: "agent", meterSource: NEWS_COMPARE_METER });
      return r?.status === "answered" ? cleanReading(r.obj) : null;
    };
    const tv = await read(tvSet);
    const shadow = await read(shadowSet);
    const a = agreement(tv, shadow);
    const bit = (v) => (v == null ? null : v ? 1 : 0);
    const status = tv && shadow ? "compared" : !tvSet.length ? "no_tv_headlines" : !shadowSet.length ? "no_shadow_headlines" : "reading_failed";
    await db.prepare("INSERT OR REPLACE INTO news_shadow_compare (day, at, tv_n, shadow_n, tv_json, shadow_json, agree_gold, agree_dollar, agree_impact, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(day, new Date(now).toISOString(), tvSet.length, shadowSet.length, tv ? JSON.stringify(tv) : null, shadow ? JSON.stringify(shadow) : null, bit(a.gold), bit(a.dollar), bit(a.impact), status).run();
    return { status, day, tv_n: tvSet.length, shadow_n: shadowSet.length, agreement: a };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}

/** The last `days` comparisons and the agreement rates (GET /api/news/shadow-compare). Never throws. */
export async function readNewsShadowCompare(env, { days = 14 } = {}) {
  try {
    await env.DB.prepare(SCHEMA_SQL).run();
    const n = Math.max(1, Math.min(60, Math.floor(Number(days) || 14)));
    const rows = ((await env.DB.prepare("SELECT * FROM news_shadow_compare ORDER BY day DESC LIMIT ?").bind(n).all()).results || []).map((r) => ({
      day: r.day, at: r.at, status: r.status, tv_n: r.tv_n, shadow_n: r.shadow_n,
      tv: r.tv_json ? JSON.parse(r.tv_json) : null, shadow: r.shadow_json ? JSON.parse(r.shadow_json) : null,
      agree: { gold: r.agree_gold == null ? null : r.agree_gold === 1, dollar: r.agree_dollar == null ? null : r.agree_dollar === 1, impact: r.agree_impact == null ? null : r.agree_impact === 1 }
    }));
    const rate = (k) => { const v = rows.filter((r) => r.agree[k] != null); return v.length ? Math.round((v.filter((r) => r.agree[k]).length / v.length) * 1000) / 1000 : null; };
    return { version: "cryptophys.news-shadow-compare.v1", compared: rows.filter((r) => r.status === "compared").length, agreement_rate: { gold: rate("gold"), dollar: rate("dollar"), impact: rate("impact") }, rows };
  } catch (error) {
    return { version: "cryptophys.news-shadow-compare.v1", error: String(error?.message ?? error).slice(0, 160), rows: [] };
  }
}
