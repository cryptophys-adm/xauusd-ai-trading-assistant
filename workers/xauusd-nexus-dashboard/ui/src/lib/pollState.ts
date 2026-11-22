/**
 * The data states of a polled panel (mockup "Nexus data states", part A, owner-approved 2026-11-22): pure functions,
 * no React and no imports, so test/nexus-poll-states.test.mjs runs them in Node.
 *
 * - loading: no data yet and the first read is in flight (the skeleton; a background refresh never shows it);
 * - error: the read failed and there is no data on screen;
 * - stale: data on screen and the last read failed, or no good read for 2 × the interval;
 * - live: the last read was good.
 * An empty answer is the page's own call (`empty` on PollBody): a good read with nothing to draw.
 *
 * The API carries no generated_at, so every age is the browser clock's time since the last good read.
 */
export type PollFacts = {
  hasData: boolean;
  error: string | null;
  loading: boolean;
  /** Last good read (ms since epoch), null before one. */
  lastOk: number | null;
  /** Last failed read (ms), null before one. */
  lastFail: number | null;
  /** Failed reads in a row since the last good one. */
  failures: number;
  intervalMs: number;
};

export type PollPhase = "loading" | "error" | "stale" | "live" | "idle";

/** Data on screen AND (the last read failed OR no good read for 2 × the interval). An interval of 0 never ages. */
export function isStale(f: Pick<PollFacts, "hasData" | "error" | "lastOk" | "intervalMs">, now: number): boolean {
  if (!f.hasData) return false;
  if (f.error != null) return true;
  return f.intervalMs > 0 && f.lastOk != null && now - f.lastOk > 2 * f.intervalMs;
}

/** Which state the panel shows. An error with no data stays an error while its retry is in flight (no skeleton flash). */
export function pollPhase(f: PollFacts, now: number): PollPhase {
  if (f.hasData) return isStale(f, now) ? "stale" : "live";
  if (f.error != null) return "error";
  if (f.loading) return "loading";
  return "idle";
}

/** When the stale rule's clock runs out with no new read (ms), for a timer; null when it cannot. */
export function staleAt(f: Pick<PollFacts, "lastOk" | "intervalMs">): number | null {
  return f.intervalMs > 0 && f.lastOk != null ? f.lastOk + 2 * f.intervalMs + 1 : null;
}

/** A short age: 45s, 7m, 3h, 2d. */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The retry cadence: 60s, 2m, 5m; "off" when the poll does not refresh. */
export function retryEvery(intervalMs: number): string {
  if (!intervalMs) return "off";
  const s = Math.round(intervalMs / 1000);
  return s < 120 ? `${s}s` : shortAge(intervalMs);
}

const two = (n: number) => String(n).padStart(2, "0");

/** HH:MM:SS (or HH:MM) in UTC. */
export function utcClock(ms: number, seconds = true): string {
  const d = new Date(ms);
  const hm = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  return seconds ? `${hm}:${two(d.getUTCSeconds())}` : hm;
}

/** HH:MM:SS (or HH:MM) in the browser's zone. */
export function localClock(ms: number, seconds = true): string {
  const d = new Date(ms);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return seconds ? `${hm}:${two(d.getSeconds())}` : hm;
}

/** "13:55:12 UTC · 20:55:12 local", or "—" before a good read. */
export function okLine(lastOk: number | null, seconds = true): string {
  return lastOk == null ? "—" : `${utcClock(lastOk, seconds)} UTC · ${localClock(lastOk, seconds)} local`;
}

/** The stale tag's tooltip: the last good read, then what failed, how often and the retry cadence. */
export function staleTitle(f: Pick<PollFacts, "error" | "lastOk" | "lastFail" | "failures" | "intervalMs">): string {
  const lines = [`last ok ${okLine(f.lastOk)}`];
  if (f.error != null) {
    const at = f.lastFail != null ? ` at ${utcClock(f.lastFail)} UTC` : "";
    lines.push(`${f.error}${at} · ${f.failures} failed · retry ${retryEvery(f.intervalMs)}`);
  } else {
    lines.push(`no good read for ${shortAge(2 * f.intervalMs)} or more · retry ${retryEvery(f.intervalMs)}`);
  }
  return lines.join("\n");
}

/**
 * The stale timer fired (review of #520): timers count awake time, the stale rule counts the wall clock. When the
 * timer lands before `staleAt` (the clock moved back, or the timer ran early) it is armed again for what is left;
 * on or after it, the panel renders once (and turns stale). With no `staleAt` there is nothing to do.
 */
export function staleWake(at: number | null, now: number): { render: boolean; rearmMs: number | null } {
  if (at == null) return { render: false, rearmMs: null };
  return now < at ? { render: false, rearmMs: at - now } : { render: true, rearmMs: null };
}

/** The coarse clock of a poll with data on screen (ms): after a sleep or a forward jump the tag turns within it. */
export const STALE_TICK_MS = 20_000;

/**
 * Whether the coarse tick (or the tab becoming visible) must render: only when the stale verdict now differs from
 * the one on screen, so a tick never re-renders a page for nothing.
 */
export function staleChanged(shown: boolean, f: Pick<PollFacts, "hasData" | "error" | "lastOk" | "intervalMs">, now: number): boolean {
  return isStale(f, now) !== shown;
}

/**
 * One read at a time for a manual retry (review of #520): while a read is in flight, `retry` joins it instead of
 * starting another, so repeated clicks on Retry now never start parallel reads. `start` (the poll's own timer, a
 * deps change) always runs; the newest read is the one tracked.
 */
export function singleFlight() {
  let current: Promise<unknown> | null = null;
  const track = <T>(p: Promise<T>): Promise<T> => {
    current = p;
    const done = () => { if (current === p) current = null; };
    p.then(done, done);
    return p;
  };
  return {
    start<T>(load: () => Promise<T>): Promise<T> { return track(load()); },
    retry<T>(load: () => Promise<T>): Promise<T> { return current != null ? (current as Promise<T>) : track(load()); },
    get busy() { return current != null; },
  };
}

/**
 * A read that a push can also deliver (the War Room's rooms and decision, ADR-0015): the newest arrival wins. A push
 * after the last failed read is a good arrival, so the panel is live again; a failed read after the push still
 * counts. `pushAt` is when the push last delivered (ms), null before one.
 */
export function withPush<F extends Pick<PollFacts, "error" | "lastOk" | "lastFail" | "failures">>(f: F, pushAt: number | null): F {
  if (pushAt == null) return f;
  const lastOk = f.lastOk == null ? pushAt : Math.max(f.lastOk, pushAt);
  const failedSince = f.error != null && f.lastFail != null && f.lastFail > pushAt;
  return { ...f, lastOk, error: failedSince ? f.error : null, failures: failedSince ? f.failures : 0 };
}
