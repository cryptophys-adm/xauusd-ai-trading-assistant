// Omega health (owner 2026-11-12, "Omega dan EA di AI Mesh"): the liveness of the execution host, for the
// platform's AI Mesh page. Read-only and measured only:
//   ea      the EA's liveness: the fresher of the legacy EA's heartbeat (KV `ea:heartbeat:last`,
//           fresh within 15 minutes) and OmegaExecutor's state relayed by the bridge (D1 `omega_bridge.state.received_ms`,
//           fresh within 2 minutes; `source` says which), because OmegaExecutor sends no HTTP heartbeat
//   control the Omega control mode (active / paused / killed) and when it was set
//   bridge  the VPS bridge's last sync (D1 omega_bridge): its age, version, and the terminal state it sent
// A value nobody measured is null. No account figures (balance, equity, server), no controls: the RPC entrypoint
// OmegaHealth exposes health() and nothing else.
import { EA_HEARTBEAT_KEY, readControl } from "./ea-signal.mjs";

export const OMEGA_HEALTH_SCHEMA = "omega-health.v1";
/** Same thresholds as Omega's own page (ea-execution.mjs, omega-broker.mjs). */
export const EA_STALE_AFTER_MS = 15 * 60_000;
export const BRIDGE_STALE_AFTER_MS = 2 * 60_000;
export const EXECUTOR_STALE_AFTER_MS = 2 * 60_000;
export const TERMINAL_STATE_FRESH_MS = 60_000;

const str = (v, n = 40) => (typeof v === "string" && v ? v.slice(0, n) : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const parse = (text) => { try { return text == null ? null : JSON.parse(text); } catch { return null; } };

function eaBlock(heartbeat, now) {
  const receivedMs = heartbeat?.received_at ? Date.parse(heartbeat.received_at) : NaN;
  const age = Number.isFinite(receivedMs) ? Math.max(0, now - receivedMs) : null;
  const seen = age != null;
  return {
    seen,
    heartbeat_age_ms: age,
    stale_after_ms: EA_STALE_AFTER_MS,
    connected: seen && age <= EA_STALE_AFTER_MS,
    version: str(heartbeat?.version),
    mode: str(heartbeat?.mode),
    trading_allowed: bool(heartbeat?.trading_allowed),
    open_positions: num(heartbeat?.positions),
    reported_control: str(heartbeat?.control),
    source: seen ? "heartbeat" : null
  };
}

/** OmegaExecutor sends no HTTP heartbeat: its liveness is the state it wrote, relayed by the bridge. */
function executorEaBlock(row, now) {
  const st = parse(row?.state);
  if (!st || typeof st !== "object" || Array.isArray(st)) return null;
  const receivedMs = st.received_ms;
  if (typeof receivedMs !== "number" || !Number.isFinite(receivedMs)) return null;
  const age = Math.max(0, now - receivedMs);
  return {
    seen: true,
    heartbeat_age_ms: age,
    stale_after_ms: EXECUTOR_STALE_AFTER_MS,
    connected: age <= EXECUTOR_STALE_AFTER_MS,
    // OmegaExecutor 1.12+ reports itself; null for an older build.
    version: str(st.executor?.version, 16),
    mode: typeof st.executor?.auto_break_even === "boolean" && typeof st.executor?.trailing_stop === "boolean"
      ? (st.executor.auto_break_even || st.executor.trailing_stop ? "local_stops" : "omega_only") : null,
    trading_allowed: bool(st.trade_allowed),
    open_positions: Array.isArray(st.positions) ? st.positions.length : null,
    reported_control: null,
    source: "omega_executor"
  };
}

/** `row` is the omega_bridge row omegaHealth read (null when missing or unreadable). */
async function bridgeBlock(env, now, row) {
  let conn = null;
  try { conn = await env.DB.prepare("SELECT status FROM omega_connection WHERE id = 1").first(); } catch { conn = null; }
  const syncedRaw = Number(row?.synced_ms);
  const synced = Number.isFinite(syncedRaw) && syncedRaw > 0 ? syncedRaw : null;
  const age = synced != null ? Math.max(0, now - synced) : null;
  const st = parse(row?.state);
  const stateAge = num(st?.received_ms) != null ? Math.max(0, now - st.received_ms) : null;
  const fresh = stateAge != null && stateAge < TERMINAL_STATE_FRESH_MS;
  const stored = conn?.status === "stored";
  return {
    seen: age != null,
    synced_age_ms: age,
    stale_after_ms: BRIDGE_STALE_AFTER_MS,
    connected: age != null && age < BRIDGE_STALE_AFTER_MS,
    bridge_version: str(row?.bridge_version),
    credentials_stored: conn ? stored : null,
    // The terminal state counts only while it is fresh and the owner's credentials are stored (as Omega shows it).
    terminal_connected: st && fresh && stored ? st.connected === true : null,
    trade_allowed: st && fresh && stored ? bool(st.trade_allowed) : null,
    terminal_state_age_ms: stateAge
  };
}

/** Pure of side effects: reads KV and D1, writes nothing. Never throws. */
export async function omegaHealth(env, { now = Date.now() } = {}) {
  let heartbeat = null;
  try { heartbeat = parse(await env.SIGNAL_CACHE?.get?.(EA_HEARTBEAT_KEY)); } catch { heartbeat = null; }
  let bridgeRow = null;
  try { bridgeRow = await env.DB.prepare("SELECT bridge_version, state, synced_ms FROM omega_bridge WHERE id = 1").first(); } catch { bridgeRow = null; }
  let control = null;
  try {
    const c = await readControl(env);
    const at = c?.at ? Date.parse(c.at) : NaN;
    control = { mode: str(c?.mode, 16), set_ms: Number.isFinite(at) ? at : null };
  } catch { control = null; }
  const hbBlock = eaBlock(heartbeat, now);
  const execBlock = executorEaBlock(bridgeRow, now);
  // The two EAs are never attached together: when both were seen, the fresher one is the one that runs.
  const ea = execBlock && (!hbBlock.seen || execBlock.heartbeat_age_ms < hbBlock.heartbeat_age_ms) ? execBlock : hbBlock;
  return {
    schema: OMEGA_HEALTH_SCHEMA,
    server_ms: now,
    engine_enabled: env?.OMEGA_ENGINE_ENABLED === "true",
    ea,
    control,
    bridge: await bridgeBlock(env, now, bridgeRow)
  };
}
