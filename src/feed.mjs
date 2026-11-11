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
