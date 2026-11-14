// What a GMI parity mismatch was computed on (owner 2026-11-14: "kerjakan 1 dan 2", item 1).
//
// On 2026-11-13 18:45 UTC the 15m GMI identity was revoked by one mismatch in 301 comparisons since its
// approval: TradingView's verdict was a sell where the local engine's was none, on a bar whose OHLCV
// matched. GMI's footprint reads the bar's intrabars (1m below 4H, 5m on 4H, 15m on daily), and the
// TradingView alert carries only the final fields (pinescript/ssot is never edited), so the one open
// question was whether the intrabars the local engine read were the ones TradingView finalised.
//
// So a GMI mismatch keeps a fingerprint of the intrabars as cached at the comparison, and a later sweep
// reads them again (INTRABAR_RECHECK_AFTER_MS after) and records whether any minute changed. No price is
// kept: per intrabar its offset in minutes, its volume and its direction (close against open), and one
// hash over the full bars. The local engines are not touched (their implementation hash is their
// parity identity).

const SYMBOL = "OANDA:XAUUSD";
const MINUTE_MS = 60_000;
const TF_MS = Object.freeze({ "5": 5 * MINUTE_MS, "15": 15 * MINUTE_MS, "60": 60 * MINUTE_MS, "240": 240 * MINUTE_MS, "1D": 1440 * MINUTE_MS });
/** The intrabar series GMI reads per chart (gmi-core.mjs intrabarTimeframe: 1m below 4H, 5m on 4H, 15m on daily). */
const INTRABAR_SERIES = Object.freeze({ "5": "1m", "15": "1m", "60": "1m", "240": "5m", "1D": "15m" });
const INTRABAR_SECONDS = Object.freeze({ "1m": 60, "5m": 300, "15m": 900 });
/** A mismatch is read again this long after the comparison, once. */
export const INTRABAR_RECHECK_AFTER_MS = 30 * MINUTE_MS;
/** Mismatches older than this are not read again (the 1m series keeps about 50 hours). */
export const INTRABAR_RECHECK_WITHIN_MS = 6 * 60 * MINUTE_MS;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Pure: the chart timeframe and bar window of a candle key ("OANDA:XAUUSD:15:<open ms>"), or null. */
export function candleWindow(candleKey) {
  const parts = String(candleKey ?? "").split(":");
  const openMs = Number(parts.at(-1)), tf = parts.at(-2);
  if (!Number.isFinite(openMs) || !TF_MS[tf]) return null;
  return { tf, openMs, closeMs: openMs + TF_MS[tf], series: INTRABAR_SERIES[tf] };
}

function fnv1a(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/**
 * Pure: the fingerprint of the intrabars of a window: { series, count, hash, bars: [{ at, v, d }] } with
 * `at` the minutes after the bar's open, `v` the volume, `d` +1, -1 or 0 (close against open). No price.
 */
export function intrabarFingerprint(candles, { series, openMs, closeMs }) {
  const stepMs = (INTRABAR_SECONDS[series] ?? 60) * 1000;
  const inside = (Array.isArray(candles) ? candles : [])
    .filter((c) => isNum(c?.time) && c.time * 1000 >= openMs && c.time * 1000 + stepMs <= closeMs)
    .sort((a, b) => a.time - b.time);
  const hash = fnv1a(inside.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume ?? ""].join(",")).join(";"));
  return {
    series, count: inside.length, hash,
    bars: inside.map((c) => ({ at: Math.round((c.time * 1000 - openMs) / MINUTE_MS), v: isNum(c.volume) ? c.volume : null, d: c.close > c.open ? 1 : c.close < c.open ? -1 : 0 }))
  };
}

/** Pure: what changed between two fingerprints: { same, changed: [minutes], added: [minutes], removed: [minutes] }. */
export function compareFingerprints(before, after) {
  if (!before || !after) return null;
  const key = (b) => `${b.v}|${b.d}`;
  const a = new Map((before.bars || []).map((b) => [b.at, key(b)]));
  const z = new Map((after.bars || []).map((b) => [b.at, key(b)]));
  const changed = [...a.keys()].filter((m) => z.has(m) && z.get(m) !== a.get(m));
  const added = [...z.keys()].filter((m) => !a.has(m));
  const removed = [...a.keys()].filter((m) => !z.has(m));
  return { same: before.hash === after.hash, changed, added, removed };
}

/** The fingerprint of a candle's intrabars as cached now (SIGNAL_CACHE, the pull adapter's series), or null. Never throws. */
export async function readIntrabars(env, candleKey) {
  const w = candleWindow(candleKey);
  if (!w) return null;
  try {
    const record = JSON.parse((await env?.SIGNAL_CACHE?.get?.(`market-data:v2:series:${SYMBOL}|${w.series}`)) || "null");
    return { ...intrabarFingerprint(record?.candles, w), read_at: new Date().toISOString(), ...(record?.fallback ? { fallback: true } : {}) };
  } catch {
    return null;
  }
}

/**
 * Sweep step: reads the intrabars of each recent GMI mismatch again, once, and records in its detail
 * whether they changed since the comparison (`intrabars_later`). Diagnostics only: the result, the
 * counts and the identity's status are not touched. Never throws.
 */
export async function recheckMismatchIntrabars(env, { now = Date.now(), limit = 10 } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  try {
    const rows = (await env.DB.prepare(
      `SELECT engine, source_hash, implementation_hash, candle_key, detail FROM engine_parity_comparisons
       WHERE result = 'mismatch' AND compared_at >= ? AND compared_at <= ? AND detail LIKE '%"intrabars":%' AND detail NOT LIKE '%"intrabars_later":%'
       ORDER BY compared_at LIMIT ?`
    ).bind(new Date(now - INTRABAR_RECHECK_WITHIN_MS).toISOString(), new Date(now - INTRABAR_RECHECK_AFTER_MS).toISOString(), limit).all())?.results || [];
    let updated = 0;
    for (const row of rows) {
      let detail;
      try { detail = JSON.parse(row.detail); } catch { continue; }
      const later = await readIntrabars(env, row.candle_key);
      if (!later) continue;
      detail.intrabars_later = { ...later, ...compareFingerprints(detail.intrabars, later) };
      await env.DB.prepare("UPDATE engine_parity_comparisons SET detail = ? WHERE engine = ? AND source_hash = ? AND implementation_hash = ? AND candle_key = ?")
        .bind(JSON.stringify(detail), row.engine, row.source_hash, row.implementation_hash, row.candle_key).run();
      updated += 1;
    }
    return { status: "ok", checked: rows.length, updated };
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
}
