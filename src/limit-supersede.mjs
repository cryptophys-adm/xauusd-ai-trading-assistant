// SS1, a newer same-side signal supersedes a resting, unfilled Omega limit (owner decision 2026-11-23, relayed by the
// orchestrator, verbatim: "Ya, sinyal baru menggantikan (Rekomendasi)"; live on merge). The case: at 14:10:54Z the 14:00
// BUY (breakout_retest) rested a BUY_LIMIT at its zone's edge (intent open:1795442400000:B, a 30-minute life) that never
// filled; at 14:17:23Z the 14:15 BUY (zone_pullback, price inside its new zone) was skipped same_side_unprotected because
// the old resting limit counted as an unprotected position on the side; price then ran up.
//
// The rule (planIntents, entry_order "limit" or "council" only; with "market" no Omega limit rests):
//   1. A resting Omega pending limit (BUY_LIMIT or SELL_LIMIT, unfilled) on the side of the current signal whose placing
//      signal is OLDER than the current one (its place_limit intent's signal_issued_ms, else the order comment's
//      open:<issued>:<B|S>, below the signal's issued_ms) is deleted: delete_order with reason superseded_by_signal. It no
//      longer counts in any gate of the new signal (same_side_unprotected, max_positions, the platform cap, the daily
//      budget's pending risk), and the new signal goes through every normal gate in the same plan (the entry council,
//      the band, EZ1/EZ1b, zone_*, the caps).
//   2. Only unfilled pending limits: an open position (a filled limit included) keeps today's same_side_unprotected.
//      A resting limit on the other side, a limit of the same signal, and one whose placing signal is unknown are
//      unchanged (pending_order_exists, as today).
//   3. The new signal refused (council skip, out of band, expired, …): the old limit is cancelled all the same (it
//      belongs to an older decision). The plan's note superseded_by_signal says the ticket, both signals and the new
//      signal's outcome (its refusal code).
//   4. Delete first, then place: while a superseded order is still reported by the terminal (its delete not yet done,
//      or refused: it is deleted again a minute later), or a superseded_by_signal delete has no answer yet
//      (omega_intents pending or sent), no new entry is planned in that sync (note superseded_delete_waiting); the next
//      sync places it once the delete is done.
//   5. The ledgers: the limit counterfactual beside v4 (src/ledger-omega-limit.mjs) ends a resting order of an older
//      signal when the current signal is on its side (missed, gate superseded_by_signal) and places the new one on
//      planIntents' gates; v4 itself is the market replay (no resting order). The v3 Signal Ledger follows the limit
//      entry since V3L (src/ledger-v3-limit.mjs): its resting limit ends superseded_by_signal the same way, and LH1's
//      blocksNewDecision no longer holds the newer decision back under a limit entry with this switch on.
// Switch: the Omega setting `limit_supersede`, "on" (default) | "off"; "off" is today's engine byte for byte. The owner's
// switch only (Aether's policy and its rollback never write it); it is in ERA_SWITCHES. No environment variable.

export const LIMIT_SUPERSEDE_MODES = Object.freeze(["on", "off"]);
export const SUPERSEDE_REASON = "superseded_by_signal";
/** A superseded_by_signal delete is read back this long (the sync's hold on an unanswered one; INTENT_TTL_MS is 2 minutes). */
export const SUPERSEDE_READ_MS = 10 * 60_000;

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** Pure: whether a newer same-side signal supersedes a resting limit in these settings (anything but "off"). */
export function limitSupersedeOn(settings) {
  return settings?.limit_supersede !== "off";
}

/**
 * Pure: the issue time of the signal that placed a pending order: its place_limit intent's signal_issued_ms (`meta`),
 * else the order's comment (the intent id, open:<issued_ms>:<B|S>), else null (unknown: never superseded).
 */
export function orderSignalMs(order, meta = null) {
  const m = Number(meta?.signal_issued_ms);
  if (finite(m) && m > 0) return m;
  const hit = /^open:(\d+):[BS]$/.exec(String(order?.comment ?? ""));
  return hit ? Number(hit[1]) : null;
}

/**
 * Pure: the pending limits a signal supersedes: Omega's own resting orders (already filtered by the caller) on the
 * signal's side whose placing signal is older than the signal. [] without a BUY or SELL signal with an issue time.
 */
export function supersededOrders({ orders = [], pendingMeta = {}, signal = null } = {}) {
  const side = signal?.side === "BUY" || signal?.side === "SELL" ? signal.side : null;
  const issued = Number(signal?.issued_ms);
  if (!side || !finite(issued)) return [];
  const type = side === "BUY" ? "BUY_LIMIT" : "SELL_LIMIT";
  return orders.filter((o) => {
    if (o?.type !== type) return false;
    const placedBy = orderSignalMs(o, pendingMeta?.[o.ticket] ?? null);
    return finite(placedBy) && placedBy < issued;
  });
}

/**
 * Pure: the superseded_by_signal deletes the sync read back (omega_intents rows { payload, status, result }), the
 * newest per ticket, as { ticket, deleted }: true once the terminal answered it done, false when it refused or never
 * answered (failed, expired), null while it waits (pending, sent).
 */
export function supersedeDeletes(rows = []) {
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    let p = r?.payload, res = r?.result;
    try { if (typeof p === "string") p = JSON.parse(p); } catch { p = null; }
    try { if (typeof res === "string") res = JSON.parse(res); } catch { res = null; }
    const ticket = Number(p?.ticket);
    if (!finite(ticket) || p?.reason !== SUPERSEDE_REASON || out.has(ticket)) continue;
    const deleted = r.status === "done" && res?.ok === true ? true : r.status === "failed" || r.status === "expired" || r.status === "done" ? false : null;
    out.set(ticket, { ticket, deleted });
  }
  return [...out.values()];
}
