// Which price feed a candle was built on (the MT5 fallback, docs/RFC_MT5_FALLBACK.md). The pull adapter
// marks the OANDA:XAUUSD 1m series with `fallback.since_sec` while it holds the broker's bars (its KV
// namespace is this Worker's SIGNAL_CACHE); a candle that closes after that time was built on them.
const M1_KEY = "market-data:v2:series:OANDA:XAUUSD|1m";
const TF_MS = Object.freeze({ "5": 300_000, "15": 900_000, "60": 3_600_000, "240": 14_400_000, "1D": 86_400_000 });

/** Pure: the close (ms) of a candle key "OANDA:XAUUSD:<tf>:<open ms>", or null. */
export function keyCloseOf(candleKey) {
  const parts = String(candleKey ?? "").split(":");
  const open = Number(parts.at(-1)), tf = TF_MS[parts.at(-2)];
  return Number.isFinite(open) && tf ? open + tf : null;
}

/** The fallback's start (ms) while the 1m series holds broker bars, else null. Never throws. */
export async function fallbackSinceMs(env) {
  try {
    const r = JSON.parse((await env?.SIGNAL_CACHE?.get?.(M1_KEY)) || "null");
    const since = Number(r?.fallback?.since_sec);
    return Number.isFinite(since) ? since * 1000 : null;
  } catch { return null; }
}

/** "mt5_fallback" when a candle closing at `closeMs` was built on the broker's bars, else "tradingview". */
export async function feedAt(env, closeMs) {
  const since = await fallbackSinceMs(env);
  return since !== null && Number.isFinite(closeMs) && closeMs > since ? "mt5_fallback" : "tradingview";
}

// ---------------------------------------------------------------- the owner's switch (2026-11-11)
// Owner 2026-11-11: a switch for the MT5 fallback in the War Room ("owner akan mengaktifkan untuk
// fallback"). Stored in the KV namespace this Worker shares with the pull adapter (SIGNAL_CACHE = its
// MARKET_DATA_CACHE), read by the pull adapter before each fallback step. Unset means the pull adapter's
// own FEED_FALLBACK_MODE ("auto" in production). Changed only by a person through Omega (Access, a
// reason), audited in D1 feed_fallback_events and reported to Telegram.
export const FEED_FALLBACK_KEY = "market-data:v2:feed-fallback-mode";
export const FEED_FALLBACK_MODES = Object.freeze(["auto", "off"]);
const FEED_EVENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS feed_fallback_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, mode TEXT NOT NULL, previous_mode TEXT, reason TEXT NOT NULL, actor TEXT NOT NULL)`;
const clip = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");

async function readSwitch(env) {
  try {
    const r = JSON.parse((await env?.SIGNAL_CACHE?.get?.(FEED_FALLBACK_KEY)) || "null");
    return r && FEED_FALLBACK_MODES.includes(r.mode) ? r : null;
  } catch { return null; }
}

/** The switch, whether a fallback runs now, the broker corpus' freshness and the last changes. Never throws. */
export async function readFeedFallback(env, { now = Date.now() } = {}) {
  const sw = await readSwitch(env);
  const since = await fallbackSinceMs(env);
  let corpus = null, events = [];
  try {
    const src = await env?.DB?.prepare?.("SELECT source, last_minute_ms FROM corpus_sources WHERE last_minute_ms IS NOT NULL ORDER BY updated_ms DESC LIMIT 1").first();
    if (src) corpus = { source: src.source, last_bar_close: new Date(Number(src.last_minute_ms) + 60_000).toISOString(), age_s: Math.max(0, Math.round((now - Number(src.last_minute_ms) - 60_000) / 1000)) };
  } catch { corpus = null; }
  try {
    await env.DB.prepare(FEED_EVENTS_SCHEMA).run();
    events = (await env.DB.prepare("SELECT at, mode, previous_mode, reason, actor FROM feed_fallback_events ORDER BY id DESC LIMIT 10").all())?.results || [];
  } catch { events = []; }
  return {
    mode: sw?.mode ?? "auto", mode_source: sw ? "owner" : "default",
    set_at: sw?.at ?? null, set_by: sw?.actor ?? null, reason: sw?.reason ?? null,
    active: since !== null, active_since: since !== null ? new Date(since).toISOString() : null,
    corpus, events
  };
}

/** The owner's change of the switch: a mode, a reason, a person. Audited; returns the new state. */
export async function setFeedFallback(env, { mode, reason = "", actor = "" } = {}, { now = Date.now() } = {}) {
  if (!FEED_FALLBACK_MODES.includes(mode)) return { ok: false, error: `mode must be one of ${FEED_FALLBACK_MODES.join(", ")}` };
  const who = clip(actor, 200), why = clip(reason, 200);
  if (!who) return { ok: false, error: "actor is required" };
  if (!why) return { ok: false, error: "a reason is required" };
  if (!env?.SIGNAL_CACHE?.put) return { ok: false, error: "kv_unavailable" };
  const previous = (await readSwitch(env))?.mode ?? "auto";
  const record = { mode, reason: why, actor: who, at: new Date(now).toISOString() };
  await env.SIGNAL_CACHE.put(FEED_FALLBACK_KEY, JSON.stringify(record));
  try {
    await env.DB.prepare(FEED_EVENTS_SCHEMA).run();
    await env.DB.prepare("INSERT INTO feed_fallback_events (at, mode, previous_mode, reason, actor) VALUES (?, ?, ?, ?, ?)").bind(record.at, mode, previous, why, who).run();
  } catch (error) {
    console.error("feed_fallback_audit_failed", error instanceof Error ? error.message : String(error));
  }
  return { ok: true, mode, previous_mode: previous, changed: previous !== mode, at: record.at };
}
