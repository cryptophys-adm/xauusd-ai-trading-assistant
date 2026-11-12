// 5m execution for Omega (docs/RFC_OMEGA_5M_EXECUTION.md; owner 2026-11-11 "ya rancang A+C, timing dari
// broker langsung", 2026-11-12: a 3-bar window, a lot cap of 1.5x, everything on). The pull adapter runs
// the 5m Prophet producer on the broker's M5 bars (aggregated from the Corpus Oracle's M1) at each broker
// 5m close and sends here what the entry's timing and the position's management need: the bar's
// confirmations, the swing high and low of the last 3 bars and the 5m ATR, on the broker's own scale.
// Kept in KV with the last bars, so a confirmation inside the 3-bar window still counts. Read by the
// signal (src/ea-signal.mjs) for Omega and the EA. Switch: OMEGA_EXEC_5M = "on" (default) | "off".
export const BROKER_TRIGGER_KEY = "trigger:broker:m5:latest";
export const BROKER_TRIGGER_FRESH_MS = 6 * 60_000;
export const BROKER_TRIGGER_WINDOW_BARS = 3;
const M5_MS = 5 * 60_000;
const KEEP = 6;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const pos = (v) => isNum(v) && v > 0;

export function exec5mMode(env) {
  return String(env?.OMEGA_EXEC_5M ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

/** Pure: one broker 5m bar's trigger checked, or null. */
export function triggerFrom(p, now = Date.now()) {
  if (!p || typeof p !== "object") return null;
  const close = Number(p.close_ms);
  if (!isNum(close) || close % M5_MS !== 0 || close > now + 60_000) return null;
  if (!pos(p.swing_high) || !pos(p.swing_low) || p.swing_low > p.swing_high || !pos(p.atr)) return null;
  return {
    close_ms: close,
    ready: p.ready === true,
    buy_confirmed: p.ready === true && p.buy_confirmed === true,
    sell_confirmed: p.ready === true && p.sell_confirmed === true,
    swing_high: p.swing_high, swing_low: p.swing_low, atr: p.atr,
    bars: isNum(p.bars) ? Math.round(p.bars) : null,
    source: typeof p.source === "string" ? p.source.slice(0, 80) : null
  };
}

/** RPC from the pull adapter: stores the broker 5m bar's trigger with the last bars. Never throws. */
export async function storeBrokerTrigger(env, payload, { now = Date.now() } = {}) {
  const t = triggerFrom(payload, now);
  if (!t) return { ok: false, error: "invalid_trigger" };
  const kv = env?.SIGNAL_CACHE;
  if (!kv?.put) return { ok: false, error: "kv_unavailable" };
  let rec = null;
  try { rec = JSON.parse((await kv.get(BROKER_TRIGGER_KEY)) || "null"); } catch { rec = null; }
  const recent = [t, ...(Array.isArray(rec?.recent) ? rec.recent : []).filter((r) => r?.close_ms !== t.close_ms)].sort((a, b) => b.close_ms - a.close_ms).slice(0, KEEP);
  await kv.put(BROKER_TRIGGER_KEY, JSON.stringify({ latest: recent[0], recent, stored_at: new Date(now).toISOString() }), { expirationTtl: 1800 });
  return { ok: true, close_ms: t.close_ms, ready: t.ready };
}

/** The fresh broker trigger (its latest bar closed at most 6 minutes ago), or null. Never throws. */
export async function readBrokerTrigger(env, { now = Date.now() } = {}) {
  if (exec5mMode(env) === "off") return null;
  try {
    const rec = JSON.parse((await env?.SIGNAL_CACHE?.get?.(BROKER_TRIGGER_KEY)) || "null");
    const latest = rec?.latest;
    if (!latest || !isNum(latest.close_ms) || now - latest.close_ms > BROKER_TRIGGER_FRESH_MS) return null;
    return { latest, recent: Array.isArray(rec.recent) ? rec.recent : [latest] };
  } catch { return null; }
}

/** Pure: the flat signal fields Omega reads for the 5m stop and management (the EA ignores them). */
export function brokerTriggerFields(broker) {
  const t = broker?.latest;
  if (!t) return {};
  return { m5_source: "broker", m5_close_ms: t.close_ms, m5_ready: t.ready === true, m5_buy: t.buy_confirmed === true, m5_sell: t.sell_confirmed === true, m5_swing_high: t.swing_high, m5_swing_low: t.swing_low, m5_atr: t.atr };
}
