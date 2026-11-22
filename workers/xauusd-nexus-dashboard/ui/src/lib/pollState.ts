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
 * The API carries no generated_at, so every age is the browser clock's time since the last good read; a pushed
 * snapshot counts from its own `at` (the hub's publish time), never from when it reached the page.
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

/**
 * How far ahead of the browser clock a last good read may sit before it is not believed (ms): a clock moved back by
 * more than this left the read "in the future", and a hung read would read as live for the size of the jump
 * (re-review of #520).
 */
export const CLOCK_SLACK_MS = 60_000;

/**
 * Data on screen AND (the last read failed OR no good read for 2 × the interval OR the last good read is more than
 * CLOCK_SLACK_MS in the future: the clock moved back). An interval of 0 never ages.
 */
export function isStale(f: Pick<PollFacts, "hasData" | "error" | "lastOk" | "intervalMs">, now: number): boolean {
  if (!f.hasData) return false;
  if (f.error != null) return true;
  if (f.lastOk != null && f.lastOk > now + CLOCK_SLACK_MS) return true;
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

/** A manual retry joins a read in flight only while it is younger than this, when the poll has no interval (ms). */
export const RETRY_JOIN_MS = 30_000;

/**
 * Whether Retry now joins the read in flight (started at `since`, on a monotonic clock) rather than start another
 * (re-review of #520): only while it is younger than the poll's interval (RETRY_JOIN_MS without one). An older read
 * is the hung one that made the panel stale: a click must start a new read, never wait on it.
 */
export function joinsInFlight(since: number | null, now: number, intervalMs: number): boolean {
  if (since == null) return false;
  const limit = intervalMs > 0 ? intervalMs : RETRY_JOIN_MS;
  return now >= since && now - since < limit;
}

/** A monotonic clock (ms) for the ages of reads in flight: a wall-clock jump never makes a hung read young. */
export const monotonic = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * One read at a time for a manual retry (review of #520): while a young read is in flight, `retry` joins it instead
 * of starting another, so repeated clicks on Retry now never start parallel reads; a read older than `intervalMs`
 * (joinsInFlight) is not joined, so a hung read never blocks the retry. `start` (the poll's own timer, a deps
 * change) always runs; the newest read is the one tracked.
 */
export function singleFlight(clock: () => number = monotonic) {
  let current: Promise<unknown> | null = null;
  let since: number | null = null;
  const track = <T>(p: Promise<T>): Promise<T> => {
    current = p;
    since = clock();
    const done = () => { if (current === p) { current = null; since = null; } };
    p.then(done, done);
    return p;
  };
  return {
    start<T>(load: () => Promise<T>): Promise<T> { return track(load()); },
    retry<T>(load: () => Promise<T>, intervalMs = 0): Promise<T> {
      return current != null && joinsInFlight(since, clock(), intervalMs) ? (current as Promise<T>) : track(load());
    },
    get busy() { return current != null; },
  };
}

/**
 * A read that a push can also deliver (the War Room's rooms and decision, ADR-0015): the newest arrival wins. A push
 * after the last failed read is a good arrival, so the panel is live again; a failed read after the push still
 * counts, and a push from before it changes nothing (neither the error nor lastOk). `pushAt` is the own time (`at`, when the hub published it) of the last push that was applied
 * (pushApplies), null before one: never the time it reached the page, so a replayed old snapshot never clears a
 * failure that came after it (re-review of #520).
 */
export function withPush<F extends Pick<PollFacts, "error" | "lastOk" | "lastFail" | "failures">>(f: F, pushAt: number | null): F {
  if (pushAt == null) return f;
  // A push from before (or at) the last failed read changes nothing: no cleared error, no newer lastOk.
  if (f.lastFail != null && pushAt <= f.lastFail) return f;
  return { ...f, lastOk: f.lastOk == null ? pushAt : Math.max(f.lastOk, pushAt), error: null, failures: 0 };
}

/**
 * The own time of a pushed snapshot (ms) from its `at` (the hub's publish time, ISO): null when missing or not a
 * date; never later than the browser's `now` (a hub clock ahead of the browser must not date a snapshot in the
 * future, where it would win over every read).
 */
export function pushTime(at: unknown, now: number): number | null {
  const t = typeof at === "string" ? Date.parse(at) : typeof at === "number" ? at : NaN;
  return Number.isFinite(t) ? Math.min(t, now) : null;
}

/**
 * Whether a pushed snapshot replaces the data on screen (re-review of #520): only when its own time is newer than
 * that data's (`shownAt`: a read's start, or the push it came from). The hub replays each topic's stored snapshot on
 * every connect, so after a reload, a wake or a deploy an old snapshot arrives again: it must not replace newer data
 * or count as a good arrival. A push without a time never applies.
 */
export function pushApplies(at: number | null, shownAt: number | null): boolean {
  if (at == null) return false;
  return shownAt == null || at > shownAt;
}

/**
 * One route's reads and pushes (lib/market.tsx, re-review of #520): each route applies its own answer as it
 * resolves, so a hung sibling read never holds a good answer back.
 * - `data`: the last good answer (or applied push), null before one; a failed read never touches it.
 * - `shownAt`: how new that data is (ms): the start of the read that brought it, or the push's own `at`.
 * - `pushAt`: the own `at` of the last applied push (withPush).
 * - `sent`, `settled`: the newest read started and the newest settled (their ids). A read that settles after a newer
 *   one has is dropped; `sent > settled` is the route's own read in flight.
 */
export type RouteState = {
  data: unknown;
  shownAt: number | null;
  lastOk: number | null;
  lastFail: number | null;
  error: string | null;
  failures: number;
  pushAt: number | null;
  sent: number;
  settled: number;
};

export const emptyRoute: RouteState = { data: null, shownAt: null, lastOk: null, lastFail: null, error: null, failures: 0, pushAt: null, sent: 0, settled: 0 };

/** A read of the route starts: its id is `sent` of the result. */
export function routeSent(s: RouteState): RouteState {
  return { ...s, sent: s.sent + 1 };
}

/** What a read brought: its answer, or its error; `startedAt` and `at` are the wall-clock times it started and ended. */
export type ReadOutcome = { ok: true; data: unknown; startedAt: number; at: number } | { ok: false; error: string; at: number };

/**
 * A read of the route settled. Dropped when a newer read has settled already (an overtaken read never undoes a
 * newer answer). A good answer clears the error and refreshes lastOk; its data replaces what is on screen unless a
 * push newer than the read's start is there. A failed read records the failure and keeps the data as it was: it
 * never becomes null data.
 */
export function routeSettled(s: RouteState, id: number, r: ReadOutcome): RouteState {
  if (id <= s.settled) return s;
  if (!r.ok) return { ...s, settled: id, error: r.error, lastFail: r.at, failures: s.failures + 1 };
  const fresher = s.shownAt == null || r.startedAt >= s.shownAt;
  return {
    ...s, settled: id, error: null, failures: 0, lastOk: r.at,
    ...(fresher ? { data: r.data, shownAt: r.startedAt } : {}),
  };
}

/** A push of the route: applied only when newer than the data on screen (pushApplies); else nothing changes. */
export function routePushed(s: RouteState, data: unknown, at: number | null): RouteState {
  if (data == null || !pushApplies(at, s.shownAt)) return s;
  return { ...s, data, shownAt: at, pushAt: s.pushAt == null ? at : Math.max(s.pushAt, at as number) };
}

/** The route's facts as a poll shows them: its own reads with an applied push counted as a good arrival. */
export function routeFacts(s: RouteState): Pick<PollFacts, "error" | "lastOk" | "lastFail" | "failures"> {
  return withPush({ error: s.error, lastOk: s.lastOk, lastFail: s.lastFail, failures: s.failures }, s.pushAt);
}

/** How long a stale decision's plan lines stay on the chart, dimmed and labelled, before they are dropped (ms). */
export const PLAN_HIDE_MS = 2 * 3_600_000;

/**
 * How the chart draws the plan of the global decision (Entry, Stop, SL+, TP and the zones; re-review of #520), from
 * that read's poll facts: at full strength while live; dimmed with " · stale 1h" on each title while stale; dropped,
 * with a small note, once the decision is older than PLAN_HIDE_MS (or of unknown age).
 */
export function planMark(f: Pick<PollFacts, "hasData" | "error" | "lastOk" | "intervalMs">, now: number): { show: boolean; dim: boolean; suffix: string; note: string | null } {
  if (!isStale(f, now)) return { show: true, dim: false, suffix: "", note: null };
  const age = f.lastOk == null ? null : now - f.lastOk;
  if (age == null || age >= PLAN_HIDE_MS) return { show: false, dim: true, suffix: "", note: `plan hidden: decision stale${age == null ? "" : ` ${shortAge(age)}`}` };
  return { show: true, dim: true, suffix: age < 0 ? " · stale" : ` · stale ${shortAge(age)}`, note: null };
}
