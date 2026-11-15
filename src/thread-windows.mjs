// Reading a room's messages by window (owner 2026-11-15, docs/RFC_ROOM_CELLS.md §6, the interim option): the
// 15m War Room keeps one thread per UTC day of its bars (`warroom:<day>`), so a window names its days and the
// (thread_id, bar_time) index is searched once per day instead of scanning every warroom row. Pure.
const DAY_MS = 86_400_000;
/** At most this many daily War Room threads are listed by name; a longer window reads the whole range. */
export const MAX_DAY_THREADS = 62;
/**
 * The 15m War Room's daily thread ids (`warroom:<UTC day of the bar close>`) from the day of `sinceIso` to the day
 * after `untilMs` (one day of slack for a clock behind the bars), oldest first; null when the window has more than
 * MAX_DAY_THREADS days or a bad time.
 */
export function warRoomThreadIds(sinceIso, untilMs = Date.now()) {
  const from = Date.parse(String(sinceIso).slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(from) || !Number.isFinite(untilMs) || untilMs < from) return null;
  const days = Math.floor((untilMs + DAY_MS - from) / DAY_MS) + 1;
  if (days > MAX_DAY_THREADS) return null;
  return Array.from({ length: days }, (_, i) => "warroom:" + new Date(from + i * DAY_MS).toISOString().slice(0, 10));
}
/**
 * The WHERE fragment and its binds for "a War Room thread from `sinceIso`" (column alias `m`, or none): the named
 * daily threads, so the (thread_id, bar_time) index is searched once per day; else the whole warroom range.
 */
export function warRoomThreadFilter(sinceIso, untilMs = Date.now(), alias = "") {
  const col = alias ? `${alias}.thread_id` : "thread_id";
  const ids = warRoomThreadIds(sinceIso, untilMs);
  if (!ids) return { sql: `${col} >= 'warroom:' AND ${col} < 'warroom;'`, binds: [] };
  return { sql: `${col} IN (${ids.map(() => "?").join(", ")})`, binds: ids };
}
/** A bar-time lower bound one day before `iso`: a message's bar never closes after the message (ts) was written. */
export const barTimeFloor = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t - DAY_MS).toISOString() : "0000"; };
