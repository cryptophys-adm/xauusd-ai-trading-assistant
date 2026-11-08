// Economic calendar and the event-risk gate (backlog 11.1, owner decision 2026-11-08):
// the ForexFactory weekly JSON export, fetched by the sweep at most once an hour and cached in
// SIGNAL_CACHE. The gate: a High-impact USD event from 2 hours before to 30 minutes after it is a
// CAUTION for the strategy engine (confidence -0.1, like the other cautions) and is shown to the
// Risk Desk of the timeframe rooms. It never forces WAIT and never places anything.

export const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
export const CALENDAR_KEY = "calendar:ff:thisweek:v1";
export const CALENDAR_VERSION = "cryptophys.econ-calendar.v1";
const REFRESH_MS = 60 * 60_000;
/** Owner decision 2026-11-08: USD only, High impact, a caution from 2 hours before to 30 minutes after. */
export const EVENT_GATE = Object.freeze({ currencies: Object.freeze(["USD"]), impacts: Object.freeze(["High"]), before_ms: 2 * 3_600_000, after_ms: 30 * 60_000, effect: "caution" });

const str = (v, max = 120) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Pure: the export's rows as events with a UTC time; rows without a valid time are dropped. */
export function parseCalendar(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const t = Date.parse(r?.date);
    if (!Number.isFinite(t) || !str(r?.title)) continue;
    out.push({ title: str(r.title), currency: str(r.country, 8).toUpperCase(), time: new Date(t).toISOString(), impact: str(r.impact, 12), forecast: str(r.forecast, 24) || null, previous: str(r.previous, 24) || null });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time) || a.title.localeCompare(b.title));
}

const gated = (e, gate = EVENT_GATE) => gate.currencies.includes(e.currency) && gate.impacts.includes(e.impact);

/** Pure: the gate at `now`: events in their window (active) and the next gated events within 24 hours. */
export function eventRisk(events, now = Date.now(), gate = EVENT_GATE) {
  const list = (events || []).filter((e) => gated(e, gate));
  const active = list.filter((e) => { const t = Date.parse(e.time); return now >= t - gate.before_ms && now <= t + gate.after_ms; });
  const next = list.filter((e) => { const t = Date.parse(e.time); return t > now && t - now <= 86_400_000; }).slice(0, 5);
  return { gate: { currencies: gate.currencies, impacts: gate.impacts, before_minutes: gate.before_ms / 60_000, after_minutes: gate.after_ms / 60_000, effect: gate.effect }, active, next };
}

/** The strategy engine's caution text for the active events, or null. */
export function eventCaution(risk) {
  if (!risk?.active?.length) return null;
  const e = risk.active[0];
  const more = risk.active.length > 1 ? ` and ${risk.active.length - 1} more` : "";
  return `a high-impact ${e.currency} event (${e.title})${more} is due within ${risk.gate.before_minutes / 60} hours or has just been released`;
}

/** Sweep step: refreshes the cached calendar at most once an hour. Never throws; a failure keeps the cache. */
export async function refreshCalendar(env, { now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const kv = env?.SIGNAL_CACHE;
  if (!kv?.get || !kv?.put) return { status: "unavailable" };
  let cached = null;
  try { cached = JSON.parse((await kv.get(CALENDAR_KEY)) || "null"); } catch { cached = null; }
  if (cached && now - Date.parse(cached.fetched_at || "") < REFRESH_MS) return { status: "fresh", events: cached.events?.length ?? 0 };
  try {
    const res = await fetchImpl(CALENDAR_URL, { headers: { accept: "application/json", "user-agent": "cryptophys-nexus/1.0" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { status: "fetch_failed", http: res.status };
    const events = parseCalendar(await res.json());
    if (!events.length) return { status: "empty" };
    await kv.put(CALENDAR_KEY, JSON.stringify({ version: CALENDAR_VERSION, source: CALENDAR_URL, fetched_at: new Date(now).toISOString(), events }), { expirationTtl: 8 * 86_400 });
    return { status: "ok", events: events.length };
  } catch (error) {
    return { status: "fetch_failed", error: String(error?.name || error).slice(0, 80) };
  }
}

/** The cached calendar, or null. */
export async function cachedCalendar(env) {
  try { return JSON.parse((await env?.SIGNAL_CACHE?.get?.(CALENDAR_KEY)) || "null"); } catch { return null; }
}

/** The gated events around now (for the strategy inputs and the Risk Desk): two days back and ahead. */
export async function gatedEvents(env, { now = Date.now() } = {}) {
  const cal = await cachedCalendar(env);
  return (cal?.events || []).filter((e) => gated(e) && Math.abs(Date.parse(e.time) - now) <= 2 * 86_400_000);
}

/** GET /api/calendar: the week's events, the gate and the risk now. */
export async function readCalendar(env, { now = Date.now() } = {}) {
  const cal = await cachedCalendar(env);
  const events = cal?.events || [];
  return { version: CALENDAR_VERSION, source: "ForexFactory weekly export", fetched_at: cal?.fetched_at ?? null, events, risk: eventRisk(events, now) };
}
