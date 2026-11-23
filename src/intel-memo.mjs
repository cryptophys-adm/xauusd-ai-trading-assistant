// The Nexus Intelligence views (Track B: B8 GET /api/liquidity; B9 and B14 later): their switch and the strategy memo
// they share. The memo is readStrategy (src/strategy-engine.mjs), as GET /api/strategy reads it, with its existing
// idempotent ensure*Schema calls; the views' own reads are SELECT and KV reads only. Read-only: nothing here writes.
import { readStrategy } from "./strategy-engine.mjs";

/** The strategy memo's life per isolate. */
export const STRATEGY_MEMO_MS = 60_000;

/** The views' switch: INTEL_VIEWS = "on" (default) | "off" (each view answers 404 intel_views_off). */
export function intelViewsOn(env) {
  return String(env?.INTEL_VIEWS ?? "on").trim().toLowerCase() !== "off";
}

let memo = { at: 0, db: null, kv: null, value: null };
export function resetStrategyMemoForTests() { memo = { at: 0, db: null, kv: null, value: null }; }

/**
 * readStrategy(env), kept STRATEGY_MEMO_MS per isolate and per binding pair (the strategy is computed on read, and
 * a page opens several views at once). Never throws: an unreadable strategy is null (and is not kept).
 */
export async function readStrategyMemo(env, { now = Date.now(), read = readStrategy } = {}) {
  if (memo.value && now - memo.at < STRATEGY_MEMO_MS && memo.db === env?.DB && memo.kv === env?.SIGNAL_CACHE) return memo.value;
  let value = null;
  try { value = await read(env, { now }); } catch { value = null; }
  if (value) memo = { at: now, db: env?.DB, kv: env?.SIGNAL_CACHE, value };
  return value;
}
