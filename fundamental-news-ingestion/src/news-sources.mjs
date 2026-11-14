// News without TradingView, in shadow (owner 2026-11-14: "cari opsi pengganti news dari provider API free
// lainnya", then the content roadmap's P0, docs/RFC_CONTENT_AGENT.md). Every hour, beside the TradingView
// news pull, the publishers' RSS feeds and GDELT are read, and what they bring is compared with TradingView's
// headlines: how many of the last hour, how many TradingView also had, which came earlier. Nothing reads the
// shadow headlines yet: the rooms, News Daily and the council still read TradingView's. No key, no quota.
// The feed addresses are measured here first (a feed that moved or blocks Workers shows as failing).

export const NEWS_SHADOW_VERSION = "cryptophys.news-shadow.v1";
export const NEWS_SHADOW_LAST_KEY = "news:shadow:last";
const DAY_PREFIX = "news:shadow:day:";
const FETCH_TIMEOUT_MS = 6000;
const HOUR_MS = 3_600_000;
const MAX_KEPT = 30;
const GDELT_QUERY = '(gold OR bullion OR XAUUSD OR "Federal Reserve" OR "Treasury yields" OR "dollar index" OR "crude oil")';

/** The sources, by id. A change is a reviewed PR. */
export const NEWS_SOURCES = Object.freeze([
  Object.freeze({ id: "fxstreet", kind: "rss", url: "https://www.fxstreet.com/rss/news" }),
  Object.freeze({ id: "investinglive", kind: "rss", url: "https://investinglive.com/feed/" }),
  Object.freeze({ id: "investing_commodities", kind: "rss", url: "https://www.investing.com/rss/news_11.rss" }),
  Object.freeze({ id: "investing_forex", kind: "rss", url: "https://www.investing.com/rss/news_1.rss" }),
  Object.freeze({ id: "fed_press", kind: "rss", url: "https://www.federalreserve.gov/feeds/press_all.xml", topic: "fed" }),
  Object.freeze({ id: "fed_speeches", kind: "rss", url: "https://www.federalreserve.gov/feeds/speeches.xml", topic: "fed" }),
  Object.freeze({ id: "gdelt", kind: "gdelt", url: `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(GDELT_QUERY + " sourcelang:english")}&mode=ArtList&format=json&timespan=1h&maxrecords=75&sort=DateDesc` })
]);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(text) {
  return String(text ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\s+/g, " ")
    .trim();
}
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};
function parseDate(text) {
  const t = String(text ?? "").trim();
  const gdelt = t.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  const ms = gdelt ? Date.UTC(+gdelt[1], +gdelt[2] - 1, +gdelt[3], +gdelt[4], +gdelt[5], +gdelt[6]) : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function fnv(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** Pure: the items of an RSS or Atom document: [{ title, url, published_at }]. */
export function parseFeed(xml) {
  const text = String(xml ?? "");
  const blocks = text.match(/<item[\s>][\s\S]*?<\/item>/gi) || text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const href = b.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    return {
      title: tag(b, "title"),
      url: decode(href ?? tag(b, "link")) || tag(b, "guid"),
      published_at: parseDate(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date"))
    };
  }).filter((i) => i.title);
}

/** Pure: GDELT's ArtList JSON as items. */
export function parseGdelt(json) {
  const list = Array.isArray(json?.articles) ? json.articles : [];
  return list.map((a) => ({ title: decode(a?.title), url: String(a?.url ?? ""), published_at: parseDate(a?.seendate) })).filter((i) => i.title);
}

const SYMBOL_WORDS = Object.freeze([
  ["OANDA:XAUUSD", /\b(gold|bullion|xau|precious metals?)\b/i],
  ["TVC:USOIL", /\b(oil|crude|wti|brent|opec)\b/i],
  ["TVC:DXY", /\b(dollar|usd|dxy|fed|fomc|federal reserve|powell|treasur(y|ies)|yields?|cpi|inflation|payrolls?|nfp|jobless|pce|gdp)\b/i]
]);
/** Pure: the system's symbols a headline is about (the Fed's own feeds are about the dollar). */
export function symbolsOf(title, topic = null) {
  const out = SYMBOL_WORDS.filter(([, re]) => re.test(title)).map(([s]) => s);
  if (topic === "fed" && !out.includes("TVC:DXY")) out.push("TVC:DXY");
  return out;
}

const words = (title) => new Set(String(title ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w.length >= 3));
/** Pure: the share of words two headlines have in common (Jaccard), 0 to 1. */
export function similarity(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

/**
 * Pure: the shadow against TradingView over the last hour. `items` are the shadow's relevant headlines,
 * `tv` TradingView's. A pair is the same story at a similarity of at least 0.5. `lead_minutes` is the median of
 * (TradingView's time - the shadow's time) over the pairs: positive means the shadow had it first.
 */
export function compareWithTradingView(items, tv, { now = Date.now(), threshold = 0.5 } = {}) {
  const recent = (list) => list.filter((i) => { const t = Date.parse(i.published_at ?? ""); return Number.isFinite(t) && now - t <= HOUR_MS && t <= now + 5 * 60_000; });
  const mine = recent(items), theirs = recent(tv);
  const leads = [];
  let overlap = 0;
  for (const i of mine) {
    const best = theirs.reduce((b, t) => { const s = similarity(i.title, t.title); return s > b.s ? { s, t } : b; }, { s: 0, t: null });
    if (best.s >= threshold) { overlap++; leads.push((Date.parse(best.t.published_at) - Date.parse(i.published_at)) / 60_000); }
  }
  const tvMatched = theirs.filter((t) => mine.some((i) => similarity(i.title, t.title) >= threshold)).length;
  leads.sort((a, b) => a - b);
  return {
    shadow_recent: mine.length, tv_recent: theirs.length, overlap, shadow_only: mine.length - overlap, tv_only: theirs.length - tvMatched,
    lead_minutes: leads.length ? Math.round(leads[Math.floor((leads.length - 1) / 2)] * 10) / 10 : null
  };
}

async function fetchSource(source, fetcher) {
  const started = Date.now();
  try {
    const res = await fetcher(source.url, { headers: { "user-agent": "Mozilla/5.0 (compatible; cryptophys-news/1.0)", accept: "application/rss+xml, application/xml, application/json, text/xml, */*" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { id: source.id, ok: false, status: res.status, ms: Date.now() - started, items: [] };
    const body = await res.text();
    let items;
    if (source.kind === "gdelt") { let json = null; try { json = JSON.parse(body); } catch { json = null; } items = parseGdelt(json); }
    else items = parseFeed(body);
    return { id: source.id, ok: true, status: res.status, ms: Date.now() - started, items: items.map((i) => ({ ...i, source: source.id, symbols: symbolsOf(i.title, source.topic ?? null) })) };
  } catch (error) {
    return { id: source.id, ok: false, status: null, error: error?.name === "TimeoutError" ? "timeout" : String(error?.message ?? error).slice(0, 80), ms: Date.now() - started, items: [] };
  }
}

/**
 * One hourly shadow run: reads every source, keeps the relevant headlines (those about gold, oil or the dollar),
 * de-duplicates them, compares the last hour with TradingView's headlines, and stores the result (KV
 * news:shadow:last and the day's totals). Never throws; never touches what the rooms read.
 */
export async function runNewsShadow(env, { tvArticles = [], now = Date.now(), fetcher = (...a) => fetch(...a), sources = NEWS_SOURCES } = {}) {
  if (String(env?.NEWS_SHADOW_MODE ?? "on").trim().toLowerCase() === "off") return { status: "off" };
  const results = await Promise.all(sources.map((s) => fetchSource(s, fetcher)));
  const seen = new Set();
  const items = [];
  for (const r of results) {
    for (const i of r.items) {
      if (!i.symbols.length) continue;
      const key = fnv(i.url || i.title.toLowerCase());
      if (seen.has(key) || items.some((x) => similarity(x.title, i.title) >= 0.8)) continue;
      seen.add(key);
      items.push({ id: key, ...i });
    }
  }
  items.sort((a, b) => Date.parse(b.published_at ?? 0) - Date.parse(a.published_at ?? 0));
  const tv = (Array.isArray(tvArticles) ? tvArticles : []).map((a) => ({ title: String(a?.title ?? ""), published_at: a?.published_at ?? a?.published ?? null }));
  const comparison = compareWithTradingView(items, tv, { now });
  const lastHour = (list) => list.filter((i) => now - Date.parse(i.published_at ?? "") <= HOUR_MS).length;
  const summary = {
    version: NEWS_SHADOW_VERSION, at: new Date(now).toISOString(),
    sources: Object.fromEntries(results.map((r) => [r.id, { ok: r.ok, status: r.status, ...(r.error ? { error: r.error } : {}), ms: r.ms, items: r.items.length, relevant: r.items.filter((i) => i.symbols.length).length, last_hour: lastHour(r.items.filter((i) => i.symbols.length)) }])),
    ...comparison
  };
  const kv = env?.OAUTH_STORE;
  if (kv) {
    try {
      await kv.put(NEWS_SHADOW_LAST_KEY, JSON.stringify({ ...summary, headlines: items.slice(0, MAX_KEPT).map(({ title, url, published_at, source, symbols }) => ({ title, url, published_at, source, symbols })) }), { expirationTtl: 7 * 86_400 });
      const dayKey = DAY_PREFIX + summary.at.slice(0, 10);
      const day = JSON.parse((await kv.get(dayKey)) || "null") || { date: summary.at.slice(0, 10), runs: 0, shadow_recent: 0, tv_recent: 0, overlap: 0, shadow_only: 0, tv_only: 0, sources: {} };
      day.runs += 1;
      for (const k of ["shadow_recent", "tv_recent", "overlap", "shadow_only", "tv_only"]) day[k] += summary[k];
      for (const [id, s] of Object.entries(summary.sources)) {
        const d = day.sources[id] || { ok_runs: 0, failed_runs: 0, last_hour: 0 };
        if (s.ok) d.ok_runs += 1; else d.failed_runs += 1;
        d.last_hour += s.last_hour;
        day.sources[id] = d;
      }
      await kv.put(dayKey, JSON.stringify(day), { expirationTtl: 14 * 86_400 });
    } catch { /* the shadow is diagnostics only */ }
  }
  return { status: "ok", ...summary };
}

/** The last shadow run (without its headlines) and today's totals, for /health. Never throws. */
export async function readNewsShadow(env, now = Date.now()) {
  const kv = env?.OAUTH_STORE;
  if (!kv) return null;
  try {
    const [last, day] = await Promise.all([kv.get(NEWS_SHADOW_LAST_KEY), kv.get(DAY_PREFIX + new Date(now).toISOString().slice(0, 10))]);
    const l = last ? JSON.parse(last) : null;
    if (l) delete l.headlines;
    return { last: l, today: day ? JSON.parse(day) : null };
  } catch {
    return null;
  }
}
