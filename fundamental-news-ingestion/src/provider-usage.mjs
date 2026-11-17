// TradingView MCP calls per caller per UTC day (owner 2026-11-11: "check dulu penyebab utama hari ini
// reach kuota limit apa ada perubahan jumlah pull ?"). On 2026-11-11 the account's provider quota ran out
// at 13:05 UTC and nothing recorded who had spent it: the pull adapter's budget counts only its own
// reservations, and calls made outside this system (other agents on the same TradingView account) are
// invisible here. This Worker is the only gateway the system uses, so it counts every provider call it
// makes, by caller, by hour, with the failures and the moment the quota ran out.
//
// One KV record per caller and day (`tv_mcp:calls:<YYYY-MM-DD>:<caller>`), so the callers, which run on
// their own schedules, rarely write the same key at once. A read-modify-write can still lose a count when
// two invocations of one caller overlap: the figures are a floor, never an overcount. No token, no URL,
// no request body is stored.

export const USAGE_KEY_PREFIX = "tv_mcp:calls:";
/**
 * One record per UTC day holding every caller's record (resource audit 2026-11-14): /health read the seven
 * caller keys of today and of yesterday on every call (14 KV reads; Nexus polls it every 30 seconds). Each
 * recordUsage also writes its caller's record into the day's summary, which /health reads instead (2 reads).
 * Two callers writing at once can drop one's update from the summary until its next record; the per-caller
 * keys stay the exact counts and the chart's reserve (readToday) still reads them.
 */
export const USAGE_DAY_PREFIX = "tv_mcp:calls-day:";
export const USAGE_CALLERS = Object.freeze(["pull_adapter", "gold_history", "calendar", "news_cron", "news_ai_worker", "news_http", "other"]);
const USAGE_TTL_SECONDS = 8 * 24 * 60 * 60;
const DAY_MS = 86_400_000;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const keyOf = (day, caller) => `${USAGE_KEY_PREFIX}${day}:${caller}`;
const callerOf = (caller) => (USAGE_CALLERS.includes(caller) ? caller : "other");

/** A tally for one invocation: the provider calls it made, the failed ones, and whether the quota ran out. */
export function usageTally(caller) {
  return { caller: callerOf(caller), calls: 0, failed: 0, quota_exceeded: false };
}

/** A fetch that counts each provider request in `tally` (a thrown or non-2xx answer counts as failed). */
export function countingFetch(tally, fetchImpl = (...args) => globalThis.fetch(...args)) {
  return async (...args) => {
    tally.calls += 1;
    try {
      const response = await fetchImpl(...args);
      if (!response?.ok) tally.failed += 1;
      return response;
    } catch (error) {
      tally.failed += 1;
      throw error;
    }
  };
}

/** Adds one invocation's tally to its caller's record of the day. Never throws. */
export async function recordUsage(env, tally, now = Date.now()) {
  const kv = env?.OAUTH_STORE;
  if (!kv || !tally || !(tally.calls > 0)) return false;
  try {
    const day = dayOf(now);
    const key = keyOf(day, callerOf(tally.caller));
    let rec = null;
    try { rec = JSON.parse((await kv.get(key)) || "null"); } catch { rec = null; }
    if (!rec || rec.date !== day) rec = { date: day, caller: callerOf(tally.caller), calls: 0, failed: 0, by_hour: Array(24).fill(0), first_call_at: null, last_call_at: null, quota_exceeded_at: null };
    const at = new Date(now).toISOString();
    const hour = new Date(now).getUTCHours();
    rec.calls += tally.calls;
    rec.failed += tally.failed;
    if (!Array.isArray(rec.by_hour) || rec.by_hour.length !== 24) rec.by_hour = Array(24).fill(0);
    rec.by_hour[hour] += tally.calls;
    rec.first_call_at = rec.first_call_at || at;
    rec.last_call_at = at;
    if (tally.quota_exceeded && !rec.quota_exceeded_at) rec.quota_exceeded_at = at;
    await kv.put(key, JSON.stringify(rec), { expirationTtl: USAGE_TTL_SECONDS });
    try {
      let summary = null;
      try { summary = JSON.parse((await kv.get(USAGE_DAY_PREFIX + day)) || "null"); } catch { summary = null; }
      if (!summary || summary.date !== day || typeof summary.callers !== "object") summary = { date: day, callers: {} };
      summary.callers[rec.caller] = rec;
      await kv.put(USAGE_DAY_PREFIX + day, JSON.stringify(summary), { expirationTtl: USAGE_TTL_SECONDS });
    } catch { /* the caller key above holds the count */ }
    return true;
  } catch {
    return false;
  }
}

/** Every caller's record of a day from its own key (exact counts; 7 KV reads). */
async function callerRecords(kv, day) {
  // In parallel (2026-11-13: twelve sequential KV reads, with the rest of /health, took a cold isolate past
  // the Drift Detector's 5-second probe at 02:00 UTC).
  return Promise.all(USAGE_CALLERS.map(async (caller) => {
    try { return JSON.parse((await kv.get(keyOf(day, caller))) || "null"); } catch { return null; }
  }));
}

/** Every caller's record of a day from the day's summary (1 KV read), or from the caller keys while there is none. */
async function summaryRecords(kv, day) {
  let summary = null;
  try { summary = JSON.parse((await kv.get(USAGE_DAY_PREFIX + day)) || "null"); } catch { summary = null; }
  if (summary?.date === day && summary.callers && typeof summary.callers === "object") return USAGE_CALLERS.map((c) => summary.callers[c] ?? null);
  return callerRecords(kv, day);
}

/** One day's calls, all callers: { date, total, failed, by_caller, by_hour, quota_exceeded_at, quota_exceeded_by }. */
async function readDay(kv, day, { summary = false } = {}) {
  const out = { date: day, total: 0, failed: 0, by_caller: {}, by_hour: Array(24).fill(0), quota_exceeded_at: null, quota_exceeded_by: null };
  const records = summary ? await summaryRecords(kv, day) : await callerRecords(kv, day);
  for (const [i, caller] of USAGE_CALLERS.entries()) {
    const rec = records[i];
    if (!rec || !(Number(rec.calls) > 0)) continue;
    out.total += Number(rec.calls) || 0;
    out.failed += Number(rec.failed) || 0;
    out.by_caller[caller] = { calls: Number(rec.calls) || 0, failed: Number(rec.failed) || 0, first_call_at: rec.first_call_at ?? null, last_call_at: rec.last_call_at ?? null, by_hour: Array.isArray(rec.by_hour) ? rec.by_hour.slice(0, 24).map((n) => Number(n) || 0) : [] };
    if (Array.isArray(rec.by_hour)) rec.by_hour.forEach((n, h) => { if (h < 24) out.by_hour[h] += Number(n) || 0; });
    if (rec.quota_exceeded_at && (!out.quota_exceeded_at || rec.quota_exceeded_at < out.quota_exceeded_at)) {
      out.quota_exceeded_at = rec.quota_exceeded_at;
      out.quota_exceeded_by = caller;
    }
  }
  return out;
}

/** Today's and yesterday's provider calls (UTC), for /health and the AI Worker's health check. Never throws. */
export async function readUsage(env, now = Date.now()) {
  const kv = env?.OAUTH_STORE;
  if (!kv) return null;
  try {
    const [today, yesterday] = await Promise.all([readDay(kv, dayOf(now), { summary: true }), readDay(kv, dayOf(now - DAY_MS), { summary: true })]);
    return { today, yesterday };
  } catch {
    return null;
  }
}

/**
 * The chart's reserve (owner 2026-11-14: "kerjakan juga", the TradingView quota). The account's provider
 * quota ran out at about 20:00 UTC on 2026-11-12 and 2026-11-13, at the 501st call of the day, and the
 * gold chart stopped for the last two hours of New York. The chart (the pull adapter) comes first: a news
 * pull is refused while today's calls, the pull's own calls and what the chart still needs before UTC
 * midnight would pass the limit. The chart's need is its median calls per completed hour today times the
 * hours left; before an hour is complete there is no estimate and news is not held back.
 * Pure: { blocked, total, limit, chart_per_hour, chart_hours_left, chart_need, wanted }.
 */
export const PROVIDER_DAILY_LIMIT = 500;
/**
 * The chart's calls an hour assumed before today has a completed hour with chart calls, on a weekday
 * (2026-11-17: ~20 an hour on 2026-11-16 and in the first hour of 11-17). Without it the reserve read
 * "no estimate" at 00:xx UTC and let news spend the day's first calls unchecked.
 */
export const CHART_PER_HOUR_FLOOR = 18;
export function chartReserve(day, { now = Date.now(), wanted = 0, limit = PROVIDER_DAILY_LIMIT, extra = 0 } = {}) {
  const d = new Date(now);
  const hour = d.getUTCHours();
  const completed = (day?.by_caller?.pull_adapter?.by_hour || []).slice(0, hour).map((n) => Number(n) || 0);
  const sorted = completed.filter((n) => n > 0).sort((a, b) => a - b);
  const weekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
  const perHour = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : (weekday ? CHART_PER_HOUR_FLOOR : 0);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const hoursLeft = Math.max(0, (midnight - now) / 3_600_000);
  const need = Math.ceil(perHour * hoursLeft);
  const total = Number(day?.total) || 0;
  const reserved = Math.max(0, Math.floor(Number(extra) || 0));
  return { blocked: total + wanted + need + reserved > limit, total, limit, chart_per_hour: perHour, chart_hours_left: Math.round(hoursLeft * 100) / 100, chart_need: need, reserved, wanted };
}

// ---------------------------------------------------------------- one budget for the account (2026-11-17)
// Owner 2026-11-17 ("setuju perbaikan alert dan kuota", relayed; task #89): the account's 500 calls a day are
// shared by the chart (the pull adapter, gold's 1H history), the economic calendar and the news pulls, and on
// 2026-11-16 the chart alone had made 443 by 23:45 UTC when the provider refused the 501st call of the day.
// Every provider call of this system passes this gateway, so it admits each job against one count (today's
// calls of every caller) before it calls:
//   - the account cap is the provider limit less ACCOUNT_SAFETY_MARGIN (calls this system cannot see, such as
//     another agent on the same TradingView account, and the counts' small floor error);
//   - the chart comes first: it is admitted while today's calls plus its own stay within the cap;
//   - the calendar next: within CALENDAR_DAILY_CAP a day and only while the chart's need to midnight still fits;
//   - news last: within NEWS_DAILY_CAP and only while the chart's need and the calendar's remaining calls fit.
// A refused chart job answers like a provider quota (until the next UTC midnight), so the pull adapter stops
// asking and the MT5 fallback takes over as it does for the provider's own refusal; news and the calendar wait.
export const ACCOUNT_SAFETY_MARGIN = 20;
export const NEWS_DAILY_CAP = 60;
export const CALENDAR_DAILY_CAP = 30;
const CLASS_OF = Object.freeze({ pull_adapter: "chart", gold_history: "chart", calendar: "calendar", news_cron: "news", news_ai_worker: "news", news_http: "news", other: "news" });
export const callerClass = (caller) => CLASS_OF[callerOf(caller)] ?? "news";
const callsOf = (day, callers) => callers.reduce((n, c) => n + (Number(day?.by_caller?.[c]?.calls) || 0), 0);

/** The caps in force: env overrides (TV_PROVIDER_DAILY_LIMIT, TV_ACCOUNT_SAFETY_MARGIN, TV_NEWS_DAILY_CAP, TV_CALENDAR_DAILY_CAP). */
export function budgetConfig(env = {}) {
  const int = (v, d, min = 0) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) && n >= min ? n : d; };
  const limit = int(env.TV_PROVIDER_DAILY_LIMIT, PROVIDER_DAILY_LIMIT, 1);
  const margin = Math.min(int(env.TV_ACCOUNT_SAFETY_MARGIN, ACCOUNT_SAFETY_MARGIN), limit - 1);
  return { limit, margin, cap: limit - margin, news_cap: int(env.TV_NEWS_DAILY_CAP, NEWS_DAILY_CAP), calendar_cap: int(env.TV_CALENDAR_DAILY_CAP, CALENDAR_DAILY_CAP) };
}

/**
 * Pure: whether a job of `wanted` provider calls from `caller` may run now, against today's calls of every
 * caller (`day`, readToday). Returns { allowed, class, reason, cap, total, wanted, retry_at, reserve }; reason
 * is null, account_cap, calendar_daily_cap, news_daily_cap or reserved_for_chart.
 */
export function admitCalls(day, { caller, wanted = 1, now = Date.now(), config = budgetConfig() } = {}) {
  const cls = callerClass(caller);
  const total = Number(day?.total) || 0;
  const w = Math.max(1, Math.floor(Number(wanted) || 1));
  const d = new Date(now);
  const retryAt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
  const out = (allowed, reason, reserve = null) => ({ allowed, class: cls, reason, cap: config.cap, total, wanted: w, retry_at: allowed ? null : retryAt, reserve });
  if (total + w > config.cap) return out(false, "account_cap");
  if (cls === "chart") return out(true, null);
  const calendarUsed = callsOf(day, ["calendar"]);
  if (cls === "calendar") {
    if (calendarUsed + w > config.calendar_cap) return out(false, "calendar_daily_cap");
    const reserve = chartReserve(day, { now, wanted: w, limit: config.cap });
    return reserve.blocked ? out(false, "reserved_for_chart", reserve) : out(true, null, reserve);
  }
  if (callsOf(day, ["news_cron", "news_ai_worker", "news_http", "other"]) + w > config.news_cap) return out(false, "news_daily_cap");
  const reserve = chartReserve(day, { now, wanted: w, limit: config.cap, extra: Math.max(0, config.calendar_cap - calendarUsed) });
  return reserve.blocked ? out(false, "reserved_for_chart", reserve) : out(true, null, reserve);
}

/**
 * Pure: the day's expected headroom under the cap for the Nexus status and the owner's report: the chart's
 * projected calls to midnight (its median hour), the calendar's remaining cap and what is left for news.
 */
export function budgetHeadroom(day, { now = Date.now(), config = budgetConfig() } = {}) {
  const total = Number(day?.total) || 0;
  const reserve = chartReserve(day, { now, limit: config.cap });
  const calendarLeft = Math.max(0, config.calendar_cap - callsOf(day, ["calendar"]));
  const newsUsed = callsOf(day, ["news_cron", "news_ai_worker", "news_http", "other"]);
  const projected = total + reserve.chart_need + calendarLeft;
  return {
    limit: config.limit, margin: config.margin, cap: config.cap, total,
    chart_today: callsOf(day, ["pull_adapter", "gold_history"]), chart_per_hour: reserve.chart_per_hour, chart_need: reserve.chart_need,
    calendar_left: calendarLeft, news_used: newsUsed, news_cap: config.news_cap,
    news_room: Math.max(0, Math.min(config.news_cap - newsUsed, config.cap - projected)),
    headroom: config.cap - projected
  };
}

/** Today's calls (UTC) for the reserve, or null. Never throws. */
export async function readToday(env, now = Date.now()) {
  const kv = env?.OAUTH_STORE;
  if (!kv) return null;
  try { return await readDay(kv, dayOf(now)); } catch { return null; }
}
