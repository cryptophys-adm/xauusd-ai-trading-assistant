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
/** A source with `backoff` that failed this many runs in a row is asked only every BACKOFF_EVERY_HOURS-th hour. */
export const BACKOFF_AFTER_FAILURES = 3;
export const BACKOFF_EVERY_HOURS = 6;
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
  // GDELT's DOC API answers slowly (production 2026-11-14: 17 of 17 runs past the 6-second limit; from outside,
  // a 429 "rate limited" after about 10 seconds). It gets its own limit and backs off when it keeps failing.
  Object.freeze({ id: "gdelt", kind: "gdelt", timeoutMs: 20_000, backoff: true, url: `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(GDELT_QUERY + " sourcelang:english")}&mode=ArtList&format=json&timespan=1h&maxrecords=75&sort=DateDesc` })
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

/** Pure: whether a backing-off source sits this run out (it failed `failures` runs in a row). */
export function inBackoff(source, failures, now = Date.now()) {
  return Boolean(source?.backoff) && failures >= BACKOFF_AFTER_FAILURES && new Date(now).getUTCHours() % BACKOFF_EVERY_HOURS !== 0;
}

async function fetchSource(source, fetcher) {
  const started = Date.now();
  try {
    const res = await fetcher(source.url, { headers: { "user-agent": "Mozilla/5.0 (compatible; cryptophys-news/1.0)", accept: "application/rss+xml, application/xml, application/json, text/xml, */*" }, signal: AbortSignal.timeout(source.timeoutMs ?? FETCH_TIMEOUT_MS) });
    if (!res.ok) return { id: source.id, ok: false, status: res.status, ...(res.status === 429 ? { error: "rate_limited" } : {}), ms: Date.now() - started, items: [] };
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
export async function runNewsShadow(env, { tvArticles = [], tvStatus = null, now = Date.now(), fetcher = (...a) => fetch(...a), sources = NEWS_SOURCES } = {}) {
  if (String(env?.NEWS_SHADOW_MODE ?? "on").trim().toLowerCase() === "off") return { status: "off" };
  const kv = env?.OAUTH_STORE;
  // Failures in a row per source, from the last run; a backing-off source that keeps failing is not asked every hour.
  let previous = {};
  try { previous = (kv ? JSON.parse((await kv.get(NEWS_SHADOW_LAST_KEY)) || "null")?.sources : null) || {}; } catch { previous = {}; }
  const failuresOf = (id) => Number(previous[id]?.consecutive_failures) || 0;
  const results = await Promise.all(sources.map((s) => inBackoff(s, failuresOf(s.id), now)
    ? Promise.resolve({ id: s.id, ok: false, status: null, skipped: "backoff", ms: 0, items: [] })
    : fetchSource(s, fetcher)));
  for (const r of results) r.consecutive_failures = r.ok ? 0 : r.skipped ? failuresOf(r.id) : failuresOf(r.id) + 1;
  const seen = new Set();
  const items = [];
  let dupes = 0;
  for (const r of results) {
    for (const i of r.items) {
      if (!i.symbols.length) continue;
      const key = fnv(i.url || i.title.toLowerCase());
      if (seen.has(key) || items.some((x) => similarity(x.title, i.title) >= 0.8)) { dupes++; continue; }
      seen.add(key);
      items.push({ id: key, ...i });
    }
  }
  items.sort((a, b) => Date.parse(b.published_at ?? 0) - Date.parse(a.published_at ?? 0));
  const tv = (Array.isArray(tvArticles) ? tvArticles : []).map((a) => ({ title: String(a?.title ?? ""), url: String(a?.url ?? ""), published_at: a?.published_at ?? a?.published ?? null }));
  const comparison = compareWithTradingView(items, tv, { now });
  const lastHour = (list) => list.filter((i) => now - Date.parse(i.published_at ?? "") <= HOUR_MS).length;
  const summary = {
    version: NEWS_SHADOW_VERSION, at: new Date(now).toISOString(),
    sources: Object.fromEntries(results.map((r) => [r.id, { ok: r.ok, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.consecutive_failures ? { consecutive_failures: r.consecutive_failures } : {}), ms: r.ms, items: r.items.length, relevant: r.items.filter((i) => i.symbols.length).length, last_hour: lastHour(r.items.filter((i) => i.symbols.length)) }])),
    ...comparison
  };
  if (kv) {
    try {
      await kv.put(NEWS_SHADOW_LAST_KEY, JSON.stringify({ ...summary, headlines: items.slice(0, MAX_KEPT).map(({ title, url, published_at, source, symbols }) => ({ title, url, published_at, source, symbols })) }), { expirationTtl: 7 * 86_400 });
      const dayKey = DAY_PREFIX + summary.at.slice(0, 10);
      const day = JSON.parse((await kv.get(dayKey)) || "null") || { date: summary.at.slice(0, 10), runs: 0, shadow_recent: 0, tv_recent: 0, overlap: 0, shadow_only: 0, tv_only: 0, sources: {} };
      day.runs += 1;
      for (const k of ["shadow_recent", "tv_recent", "overlap", "shadow_only", "tv_only"]) day[k] += summary[k];
      for (const [id, s] of Object.entries(summary.sources)) {
        const d = day.sources[id] || { ok_runs: 0, failed_runs: 0, last_hour: 0 };
        if (s.ok) d.ok_runs += 1; else if (s.skipped) d.skipped_runs = (d.skipped_runs || 0) + 1; else d.failed_runs += 1;
        d.last_hour += s.last_hour;
        // Measurement phase A (2026-11-17): what each source brought and how it failed.
        d.items = (d.items || 0) + (s.items || 0);
        d.relevant = (d.relevant || 0) + (s.relevant || 0);
        if (s.error === "rate_limited") d.rate_limited = (d.rate_limited || 0) + 1;
        else if (s.error === "timeout") d.timeouts = (d.timeouts || 0) + 1;
        if (s.ms) d.ms_total = (d.ms_total || 0) + s.ms;
        day.sources[id] = d;
      }
      day.dupes = (day.dupes || 0) + dupes;
      await kv.put(dayKey, JSON.stringify(day), { expirationTtl: 14 * 86_400 });
      await recordItems(kv, { items, tv, tvStatus, now });
    } catch { /* the shadow is diagnostics only */ }
  }
  return { status: "ok", ...summary };
}

// ---------------------------------------------------------------- measurement phase A (2026-11-17)
// Owner 2026-11-17 ("setuju c, bandingkan dulu", then "A dan B", relayed): before news may leave TradingView, the
// shadow is compared over at least 7 days. Every hour each relevant shadow headline and each TradingView headline is
// kept once per UTC day with its source, address, publication time and the time this Worker first saw it, 14 days in
// KV (news:shadow:items:<date>). Nothing reads them but GET /shadow/report: no room, decision or News Daily.
export const ITEMS_PREFIX = "news:shadow:items:";
const MAX_DAY_SHADOW = 1500, MAX_DAY_TV = 600;
const clipText = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function recordItems(kv, { items, tv, tvStatus, now }) {
  const date = new Date(now).toISOString().slice(0, 10);
  const key = ITEMS_PREFIX + date;
  const rec = JSON.parse((await kv.get(key)) || "null") || { date, shadow: {}, tv: {}, hours: {} };
  const at = new Date(now).toISOString();
  for (const i of items) {
    if (rec.shadow[i.id] || Object.keys(rec.shadow).length >= MAX_DAY_SHADOW) continue;
    rec.shadow[i.id] = { s: i.source, t: clipText(i.title, 200), u: clipText(i.url, 300), p: i.published_at ?? null, f: at };
  }
  for (const a of tv) {
    if (!a.title) continue;
    const id = fnv(a.url || a.title.toLowerCase());
    if (rec.tv[id] || Object.keys(rec.tv).length >= MAX_DAY_TV) continue;
    rec.tv[id] = { t: clipText(a.title, 200), u: clipText(a.url, 300), p: a.published_at ?? null, f: at };
  }
  const hour = at.slice(11, 13);
  rec.hours[hour] = { tv_status: typeof tvStatus === "string" ? tvStatus.slice(0, 40) : null, tv: tv.length, shadow: items.length };
  await kv.put(key, JSON.stringify(rec), { expirationTtl: 14 * 86_400 });
}

const HIGH_IMPACT = /\b(fomc|fed (rate|decision|chair)|powell|rate (cut|hike|decision)|cpi|inflation|nfp|non-?farm|payrolls?|jobless|pce|gdp|ecb|boj|tariffs?)\b/i;
const pct = (list, q) => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] * 10) / 10; };
const minutes = (a, b) => (Date.parse(a) - Date.parse(b)) / 60_000;
const script = (title) => { const letters = String(title).replace(/[^\p{L}]/gu, ""); if (!letters) return "unknown"; const latin = letters.replace(/[^\p{Script=Latin}]/gu, "").length; return latin / letters.length >= 0.7 ? "latin" : "other"; };

/**
 * Pure: the comparison report over `days` (each { date, items: news:shadow:items, totals: news:shadow:day }). A
 * shadow and a TradingView headline are the same story when their addresses match or their titles have a
 * similarity of at least 0.8, within six hours. Latency is first seen less published, per source; `lead` is
 * TradingView's first-seen less the shadow's for the same story (positive: the shadow saw it first).
 */
export function shadowReport(days, { threshold = 0.8, now = Date.now() } = {}) {
  const shadowAll = [], tvAll = [], perDay = [], sources = {};
  let dupes = 0, hoursTvPulled = 0, hoursTotal = 0;
  for (const d of days) {
    const sh = Object.values(d.items?.shadow ?? {}), tv = Object.values(d.items?.tv ?? {});
    shadowAll.push(...sh); tvAll.push(...tv);
    const hours = Object.values(d.items?.hours ?? {});
    hoursTotal += hours.length; hoursTvPulled += hours.filter((h) => h.tv_status === "ok" || h.tv > 0).length;
    dupes += Number(d.totals?.dupes) || 0;
    for (const [id, s] of Object.entries(d.totals?.sources ?? {})) {
      const a = sources[id] || { ok_runs: 0, failed_runs: 0, skipped_runs: 0, rate_limited: 0, timeouts: 0, items: 0, relevant: 0, ms_total: 0 };
      for (const k of Object.keys(a)) a[k] += Number(s[k]) || 0;
      sources[id] = a;
    }
    perDay.push({ date: d.date, shadow: sh.length, tv: tv.length, tv_hours_pulled: hours.filter((h) => h.tv_status === "ok" || h.tv > 0).length, hours: hours.length });
  }
  const pairs = [];
  const matchedTv = new Set();
  for (const s of shadowAll) {
    let best = null;
    tvAll.forEach((t, k) => {
      if (Math.abs(minutes(t.p ?? t.f, s.p ?? s.f)) > 360) return;
      const score = (s.u && t.u && s.u === t.u) ? 1 : similarity(s.t, t.t);
      if (score >= threshold && (!best || score > best.score)) best = { score, t, k };
    });
    if (best) { pairs.push({ s, t: best.t }); matchedTv.add(best.k); }
  }
  const latency = (list) => list.map((x) => minutes(x.f, x.p)).filter((m) => Number.isFinite(m) && m >= 0 && m < 48 * 60);
  const bySource = {};
  for (const s of shadowAll) (bySource[s.s] ||= []).push(s);
  const leads = pairs.map((p) => minutes(p.t.f, p.s.f)).filter(Number.isFinite);
  const impact = (list) => list.filter((x) => HIGH_IMPACT.test(x.t));
  const shadowOnlyImpact = impact(shadowAll.filter((s) => !pairs.some((p) => p.s === s)));
  const tvOnlyImpact = impact(tvAll.filter((_, k) => !matchedTv.has(k)));
  const mix = (list) => list.reduce((m, x) => { const k = script(x.t); m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    version: "cryptophys.news-shadow-report.v1", at: new Date(now).toISOString(), days: perDay,
    coverage: { shadow_items: shadowAll.length, tv_items: tvAll.length, overlap: pairs.length, shadow_only: shadowAll.length - pairs.length, tv_only: tvAll.length - matchedTv.size, tv_hours_pulled: hoursTvPulled, hours: hoursTotal },
    latency_minutes: {
      tv: { median: pct(latency(tvAll), 0.5), p90: pct(latency(tvAll), 0.9), n: latency(tvAll).length },
      shadow: Object.fromEntries(Object.entries(bySource).map(([id, list]) => [id, { median: pct(latency(list), 0.5), p90: pct(latency(list), 0.9), n: latency(list).length }])),
      lead_shadow_over_tv: { median: pct(leads, 0.5), p90: pct(leads, 0.9), n: leads.length }
    },
    quality: {
      duplicates_dropped: dupes,
      relevance_by_source: Object.fromEntries(Object.entries(sources).map(([id, a]) => [id, a.items ? Math.round((a.relevant / a.items) * 1000) / 1000 : null])),
      script_mix: { shadow: mix(shadowAll), tv: mix(tvAll) }
    },
    high_impact: { tv_only: tvOnlyImpact.slice(0, 30).map((x) => ({ title: x.t, url: x.u, published_at: x.p })), shadow_only: shadowOnlyImpact.slice(0, 30).map((x) => ({ title: x.t, url: x.u, source: x.s, published_at: x.p })) },
    reliability: Object.fromEntries(Object.entries(sources).map(([id, a]) => [id, { ok_runs: a.ok_runs, failed_runs: a.failed_runs, skipped_runs: a.skipped_runs, rate_limited: a.rate_limited, timeouts: a.timeouts, avg_ms: a.ok_runs + a.failed_runs ? Math.round(a.ms_total / (a.ok_runs + a.failed_runs)) : null, unreliable: a.failed_runs + a.skipped_runs > a.ok_runs }]))
  };
}

/** The last `n` UTC days (1 to 14) of shadow items and totals, oldest first. Never throws. */
export async function readShadowDays(env, n = 7, now = Date.now()) {
  const kv = env?.OAUTH_STORE;
  if (!kv) return [];
  const count = Math.max(1, Math.min(14, Math.floor(Number(n) || 7)));
  const dates = Array.from({ length: count }, (_, k) => new Date(now - (count - 1 - k) * 86_400_000).toISOString().slice(0, 10));
  return Promise.all(dates.map(async (date) => {
    let items = null, totals = null;
    try { items = JSON.parse((await kv.get(ITEMS_PREFIX + date)) || "null"); } catch { items = null; }
    try { totals = JSON.parse((await kv.get(DAY_PREFIX + date)) || "null"); } catch { totals = null; }
    return { date, items, totals };
  }));
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
