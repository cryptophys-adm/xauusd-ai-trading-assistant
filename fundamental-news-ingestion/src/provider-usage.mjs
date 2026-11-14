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
    return true;
  } catch {
    return false;
  }
}

/** One day's calls, all callers: { date, total, failed, by_caller, by_hour, quota_exceeded_at, quota_exceeded_by }. */
async function readDay(kv, day) {
  const out = { date: day, total: 0, failed: 0, by_caller: {}, by_hour: Array(24).fill(0), quota_exceeded_at: null, quota_exceeded_by: null };
  // Every caller's record in parallel (2026-11-13: twelve sequential KV reads, with the rest of /health,
  // took a cold isolate past the Drift Detector's 5-second probe at 02:00 UTC).
  const records = await Promise.all(USAGE_CALLERS.map(async (caller) => {
    try { return JSON.parse((await kv.get(keyOf(day, caller))) || "null"); } catch { return null; }
  }));
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
    const [today, yesterday] = await Promise.all([readDay(kv, dayOf(now)), readDay(kv, dayOf(now - DAY_MS))]);
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
export function chartReserve(day, { now = Date.now(), wanted = 0, limit = PROVIDER_DAILY_LIMIT } = {}) {
  const d = new Date(now);
  const hour = d.getUTCHours();
  const completed = (day?.by_caller?.pull_adapter?.by_hour || []).slice(0, hour).map((n) => Number(n) || 0);
  const sorted = completed.filter((n) => n > 0).sort((a, b) => a - b);
  const perHour = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const hoursLeft = Math.max(0, (midnight - now) / 3_600_000);
  const need = Math.ceil(perHour * hoursLeft);
  const total = Number(day?.total) || 0;
  return { blocked: total + wanted + need > limit, total, limit, chart_per_hour: perHour, chart_hours_left: Math.round(hoursLeft * 100) / 100, chart_need: need, wanted };
}

/** Today's calls (UTC) for the reserve, or null. Never throws. */
export async function readToday(env, now = Date.now()) {
  const kv = env?.OAUTH_STORE;
  if (!kv) return null;
  try { return await readDay(kv, dayOf(now)); } catch { return null; }
}
