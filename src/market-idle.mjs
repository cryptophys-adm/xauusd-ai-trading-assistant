// Closed-market idle for the AI Worker's crons (2026-11-14, resource audit; owner: "lebih hemat
// read/write D1 dan KV"). From Friday 17:00 to Sunday 18:00 New York no gold bar closes, yet the parity
// sweep (every 15 minutes) still ran the war rooms and their fallback, the H1 finalize, the candle
// reconcile and backfill, outcome scoring, the hourly tuning replays (useCache false), pattern
// calibration, strategy captures and replays, compliance, Aether and platform pushes, and the ledger
// step (every 5 minutes) replayed the ledger, the plan learner, the model dataset and the baseline: all
// on inputs that cannot change until the reopen.
//
// While idle the sweep keeps only the macro rooms (a High-impact event can still be due) and, once an
// hour, a heartbeat (the economic calendar refresh and the health alerts); the ledger step does nothing.
// The first two hours after the close run in full, so the last bars' rooms, H1 decisions, scores and
// ledger events finish. The reopen needs no catch-up of its own: the first sweep after it is the first
// of its hour, so the hourly block runs there, and every step reads its own cursors.
import { goldClosedAt } from "./parity-sweep.mjs";

/** The full crons keep running this long after the Friday close. */
export const IDLE_AFTER_CLOSE_MS = 2 * 3_600_000;

/** Whether the crons stand still at `now`; `CLOSED_MARKET_IDLE` "off" never does. */
export function marketIdleAt(env, now = Date.now()) {
  if (String(env?.CLOSED_MARKET_IDLE ?? "").toLowerCase() === "off") return false;
  return goldClosedAt(now) && goldClosedAt(now - IDLE_AFTER_CLOSE_MS);
}

/** The heartbeat runs on the first sweep of each hour while idle (the sweep's own hourly rule). */
export function idleHeartbeatDue(scheduledTime) {
  return new Date(scheduledTime || Date.now()).getUTCMinutes() < 25;
}
