// Executor silence (ES1, orchestrator 2026-11-27 after FS3; "with a live account, a silent VPS stop is the bigger risk").
// FS3 (src/feed-stale.mjs) keeps a market-wide stop quiet: the feed and the executor's bars stopping together is the
// market stopping. A whole-VPS stop looks the same on the bars, so this watches the executor bridge's sync liveness
// instead (D1 omega_bridge.synced_ms, else the state's received_ms): the bridge keeps syncing every few seconds while
// the market is closed or thin (calm mode syncs every 5 s), so an early close never fires this, and a VPS, terminal or
// bridge service that stops does. Inside gold's trading hours (goldPausedAt, also 5 minutes after a pause), the engine
// on, a bridge that once synced and went quiet for more than EXECUTOR_SILENT_MS: one Telegram line on the Omega path per
// episode, `critical` when the last state shows a position or a pending order (they are not managed while it is quiet),
// else `warning`; one line when it syncs again. One omega_events row each (agent:cerebrum; minutes and counts only, no
// server, login or account figure). Read-only towards trading: nothing here changes a setting, an intent or a position.
import { goldPausedAt } from "./market-hours.mjs";

export const EXECUTOR_SILENT_MS = 5 * 60_000;
export const EXECUTOR_SILENT_KEY = "executor-silent:v1";

const num = (v) => (v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
const parse = (s, fallback = null) => { if (s == null) return fallback; if (typeof s !== "string") return s; try { return JSON.parse(s); } catch { return fallback; } };
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

/** Pure: the bridge's last sync (synced_ms, else the state's received_ms), or null when it never synced. */
export function lastSyncMs(row) {
  return num(row?.synced_ms) ?? num(parse(row?.state, null)?.received_ms);
}

/** Pure: whether the executor is silent now: in trading hours, synced once, quiet for more than `silentMs`. */
export function executorSilent({ syncedMs, now, silentMs = EXECUTOR_SILENT_MS }) {
  if (goldPausedAt(now) || goldPausedAt(now - silentMs)) return false;
  const s = num(syncedMs);
  return s != null && now - s > silentMs;
}

/** Pure: the open exposure in the last state: positions and pending orders (counts only). */
export function exposureOf(state) {
  const st = parse(state, null) ?? {};
  const positions = Array.isArray(st.positions) ? st.positions.length : 0;
  const orders = Array.isArray(st.orders) ? st.orders.length : 0;
  return { positions, orders, severity: positions + orders > 0 ? "critical" : "warning" };
}

/** Pure: the Telegram line for an episode that opens. */
export function silentLine({ syncedMs, now, positions, orders, severity }) {
  const mins = Math.max(1, Math.round((now - syncedMs) / 60_000));
  const head = `XAUUSD SYSTEM · ${severity === "critical" ? "CRITICAL · " : ""}Omega executor silent for ${mins} min (last sync ${hhmm(syncedMs)} UTC)`;
  const what = severity === "critical"
    ? `${positions} open position${positions === 1 ? "" : "s"} and ${orders} pending order${orders === 1 ? "" : "s"} are not managed until the bridge syncs again (the broker still holds their stop and target).`
    : "no position or pending order is open; no new entry can reach the broker until it syncs again.";
  return `${head}: ${what} Check the VPS, the MT5 terminal and the bridge service.`;
}

/** Pure: the Telegram line when it syncs again. */
export function backLine({ sinceMs, now }) {
  return `XAUUSD SYSTEM · Omega executor syncing again after ${Math.max(1, Math.round((now - sinceMs) / 60_000))} min of silence.`;
}

async function event(db, now, action, detail) {
  try { await db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(now, "agent:cerebrum", action, JSON.stringify(detail)).run(); } catch { /* best effort */ }
}

/**
 * On every ledger step: open an episode when the executor goes silent in trading hours (once per silence), close it on
 * the next sync. `send(text)` is the Omega Telegram. Returns { status: off | unavailable | never_synced | ok | silent |
 * opened | back | failed }. Never throws.
 */
export async function runExecutorSilentCheck(env, { now = Date.now(), send = null } = {}) {
  if (env?.OMEGA_ENGINE_ENABLED !== "true") return { status: "off" };
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    let row = null;
    try { row = await db.prepare("SELECT state, synced_ms FROM omega_bridge WHERE id = 1").first(); } catch { row = null; }
    const syncedMs = lastSyncMs(row);
    if (syncedMs == null) return { status: "never_synced" };
    const open = parse(await kv.get(EXECUTOR_SILENT_KEY), null);
    if (open && syncedMs > Number(open.synced_ms)) {
      // It synced again: close the episode.
      await kv.delete?.(EXECUTOR_SILENT_KEY);
      const minutes = Math.round((syncedMs - Number(open.synced_ms)) / 60_000);
      await event(db, now, "executor_back", { silent_min: minutes, severity: open.severity });
      if (typeof send === "function") { try { await send(backLine({ sinceMs: Number(open.synced_ms), now: syncedMs })); } catch { /* best effort */ } }
      return { status: "back", silent_min: minutes };
    }
    if (!executorSilent({ syncedMs, now })) return { status: open ? "silent" : "ok" };
    if (open) return { status: "silent" };
    const x = exposureOf(row?.state);
    await kv.put(EXECUTOR_SILENT_KEY, JSON.stringify({ synced_ms: syncedMs, opened_ms: now, severity: x.severity }), { expirationTtl: 14 * 86400 });
    const minutes = Math.round((now - syncedMs) / 60_000);
    await event(db, now, "executor_silent", { silent_min: minutes, severity: x.severity, positions: x.positions, orders: x.orders });
    if (typeof send === "function") { try { await send(silentLine({ syncedMs, now, ...x })); } catch { /* best effort */ } }
    return { status: "opened", severity: x.severity, silent_min: minutes };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}
