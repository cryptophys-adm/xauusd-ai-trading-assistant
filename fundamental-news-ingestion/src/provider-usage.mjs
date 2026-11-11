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
  for (const caller of USAGE_CALLERS) {
    let rec = null;
    try { rec = JSON.parse((await kv.get(keyOf(day, caller))) || "null"); } catch { rec = null; }
    if (!rec || !(Number(rec.calls) > 0)) continue;
    out.total += Number(rec.calls) || 0;
    out.failed += Number(rec.failed) || 0;
    out.by_caller[caller] = { calls: Number(rec.calls) || 0, failed: Number(rec.failed) || 0, first_call_at: rec.first_call_at ?? null, last_call_at: rec.last_call_at ?? null };
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
    return { today: await readDay(kv, dayOf(now)), yesterday: await readDay(kv, dayOf(now - DAY_MS)) };
  } catch {
    return null;
  }
}
