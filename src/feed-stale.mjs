// Feed content staleness (orchestrator 2026-11-27, after the OmegaFeed 1.01 install: the feed terminal restarted without
// its EA, the feed bridge kept syncing, and its bars stopped at 13:07 unnoticed). A feed bridge that syncs (its row
// fresh) while its corpus source's newest bar is older than FEED_CONTENT_STALE_MS during gold's trading hours is
// "content stale": the Data feeds card says so (feedOverview), and one `feed_stale` event per episode goes to the
// Cerebrum Telegram (src/ea-heartbeat-relay.mjs; the bridge id and the bar age only, no server name, no login). A new episode starts only after a fresh bar. The MT5 fallback already
// skips a stale feed by its bar times (FEED_FRESH_MS in src/corpus-oracle.mjs); this only makes it seen. Pure; no I/O.
import { goldPausedAt } from "./market-hours.mjs";

export const FEED_CONTENT_STALE_MS = 5 * 60_000;

/**
 * Pure: whether a feed's content is stale. `syncedMs`: the bridge's last sync; `lastBarMs`: its corpus source's newest
 * bar (the bar's open time); `seenMs`: how fresh a sync must be to count (the bridge is alive).
 */
export function feedContentStale({ syncedMs, lastBarMs, now, seenMs = 120_000 }) {
  // The gold session calendar (orchestrator): the weekend and the daily break never page, nor the first minutes after
  // either (the newest bar is from before it until a new one closes).
  if (goldPausedAt(now) || goldPausedAt(now - FEED_CONTENT_STALE_MS)) return false;
  if (!(Number.isFinite(Number(syncedMs)) && now - Number(syncedMs) <= seenMs)) return false;
  const bar = Number(lastBarMs);
  // A feed that never sent a bar is not "stale" (it is new, or its corpus is refused, which feed_corpus_refused says):
  // only bars that stopped are.
  if (lastBarMs == null || !Number.isFinite(bar) || bar <= 0) return false;
  return now - bar > FEED_CONTENT_STALE_MS;
}

/**
 * Pure: whether this stale state starts a new episode: no feed_stale event yet for this bridge, or the last one is
 * older than the feed's newest bar (the feed came back in between).
 */
export function newStaleEpisode({ lastEventMs, lastBarMs }) {
  const ev = Number(lastEventMs);
  if (!Number.isFinite(ev) || ev <= 0) return true;
  return Number.isFinite(Number(lastBarMs)) && Number(lastBarMs) > ev;
}

/** Pure: the event's detail (the bridge id and the age only; no server name, no login, no account data). */
export function staleDetail({ bridgeId, lastBarMs, now }) {
  const ageMin = Number.isFinite(Number(lastBarMs)) && Number(lastBarMs) > 0 ? Math.round((now - Number(lastBarMs)) / 60_000) : null;
  return {
    bridge_id: String(bridgeId),
    last_bar_age_min: ageMin,
    message: `Feed '${String(bridgeId)}' is syncing but its bars stopped${ageMin != null ? ` ${ageMin} min ago` : ""}: the feed EA is probably not attached. Analysis uses the executor's bars meanwhile. Re-enter the feed login on Data feeds to restart it with its EA.`
  };
}
