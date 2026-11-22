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
 * The API carries no generated_at, so every age is local: the time since the last good arrival (a read's answer or a
 * push's arrival) on the page's steady clock (`localNow`: the wall clock's forward steps, never its backward ones).
 * Third review of #520: reads and pushes are ordered by one local sequence (`nextSeq`), taken when a read is sent
 * and when a push arrives, never by a wall clock; the hub's `at` only recognises a replay (pushApplies).
 */
export type PollFacts = {
  hasData: boolean;
  error: string | null;
  loading: boolean;
  /** Last good arrival (ms, the steady local clock `localNow`), null before one. */
  lastOk: number | null;
  /** Last failed read (ms, `localNow`), null before one. */
  lastFail: number | null;
  /** Failed reads in a row since the last good one. */
  failures: number;
  intervalMs: number;
};

export type PollPhase = "loading" | "error" | "stale" | "live" | "idle";

/**
 * How far ahead of `now` a last good read may sit before it is not believed (ms; re-review of #520). The pages read
 * every age on the steady clock (localNow, third review), which never moves back, so this is only a guard for a
 * caller that mixes clocks.
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
 * The stale timer fired (review of #520): timers count awake time, the stale rule counts the steady clock (localNow). When the
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
 * The steady local clock (ms, epoch-like): it follows the wall clock forward (a sleep, where the monotonic clock may
 * pause, still counts) but never backward: on a backward step (NTP, a VM resume) it advances by the monotonic clock
 * instead (third review of #520). Every local age (lastOk, lastFail, the stale tag, the plan lines) is read on it, so a
 * backward step never freezes a live tag or a stale verdict. Pure: give it the two sources to test it.
 */
export function steadyClock(wall: () => number = () => Date.now(), mono: () => number = monotonic): () => number {
  let w0 = wall(), m0 = mono(), t = w0;
  return () => {
    const w = wall(), m = mono();
    const dw = w - w0, dm = Math.max(0, m - m0);
    t += dw >= 0 ? Math.max(dw, dm) : dm;
    w0 = w; m0 = m;
    return t;
  };
}

/** A monotonic clock (ms; it may pause while the machine sleeps): the steady clock's source on a backward step. */
export const monotonic = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** The page's steady clock (steadyClock): the one clock of every local time and age. */
export const localNow = steadyClock();

/**
 * A steady time as the wall clock reads it now, for display ("13:55 UTC"): the same unless the wall clock stepped
 * back since, by the size of that step.
 */
export function wallOf(t: number | null, now: number = localNow(), wall: number = Date.now()): number | null {
  return t == null ? null : t + (wall - now);
}

let seqNow = 0;
/** The page's one arrival order (third review of #520): taken when a read is sent and when a push arrives. */
export const nextSeq = (): number => ++seqNow;

/**
 * A manual retry joins a read in flight only while it is younger than this (ms): a double click shares one read, and
 * any older read in flight (the hung one that made the panel stale, or the poll's own scheduled read) is not joined.
 */
export const RETRY_JOIN_MS = 2_500;

/**
 * Whether Retry now joins the read in flight (sent at `since`, on the steady clock) rather than start another (third
 * review of #520): only while it is younger than RETRY_JOIN_MS. It used to join anything younger than the interval,
 * and the newest scheduled read always is, so a click during a hang sent nothing until the next schedule.
 */
export function joinsInFlight(since: number | null, now: number): boolean {
  if (since == null) return false;
  return now >= since && now - since < RETRY_JOIN_MS;
}

/**
 * One read at a time for a manual retry (review of #520): while a read younger than RETRY_JOIN_MS is in flight,
 * `retry` joins it instead of starting another, so a double click never starts parallel reads; an older read is not
 * joined (joinsInFlight), so a hung read never blocks the retry. `start` (the poll's own timer, a deps change)
 * always runs; the newest read is the one tracked.
 */
export function singleFlight(clock: () => number = localNow) {
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
    retry<T>(load: () => Promise<T>): Promise<T> {
      return current != null && joinsInFlight(since, clock()) ? (current as Promise<T>) : track(load());
    },
    get busy() { return current != null; },
  };
}

/**
 * A push that was applied (third review of #520): when it arrived, on the local sequence (`seq`) and the steady clock
 * (`local`). Never the hub's `at`: the hub and the browser clocks differ.
 */
export type PushMark = { seq: number; local: number };

/** The facts of a read, with the local sequence of its last failure (`failSeq`: the failed read's send). */
export type ReadFacts = Pick<PollFacts, "error" | "lastOk" | "lastFail" | "failures"> & { failSeq: number | null };

/**
 * A read that a push can also deliver (the War Room's rooms and decision, ADR-0015), with the last applied push
 * (third review of #520). The push's arrival always counts toward lastOk (it used to be dropped whenever a later read
 * failed, so a live push channel read as "stale 2h"); only clearing the error needs the push to have arrived after the
 * failed read was sent, on the local sequence. A failed read sent after the push still counts.
 */
export function withPush<F extends ReadFacts>(f: F, p: PushMark | null): F {
  if (p == null) return f;
  const lastOk = f.lastOk == null ? p.local : Math.max(f.lastOk, p.local);
  const clears = f.error != null && (f.failSeq == null || p.seq > f.failSeq);
  return clears ? { ...f, lastOk, error: null, failures: 0 } : { ...f, lastOk };
}

/** Whether the data on screen is the push's: it arrived after the read that brought the read's data was sent. */
export function pushShown(readSeq: number | null, p: PushMark | null): boolean {
  return p != null && (readSeq == null || p.seq > readSeq);
}

/** How much older (hub clock) than the newest applied push a snapshot may be and still apply (ms). */
export const PUSH_SLACK_MS = 120_000;

/**
 * The hub's own time of a pushed snapshot (ms) from its `at` (ISO): null when missing or not a date. It is the hub's
 * clock, never compared with a browser time (third review of #520: a fast or slow browser dropped fresh pushes or let
 * an old replay clear a failure); it is compared only with other snapshots' `at`.
 */
export function pushTime(at: unknown): number | null {
  const t = typeof at === "string" ? Date.parse(at) : typeof at === "number" ? at : NaN;
  return Number.isFinite(t) ? t : null;
}

/** A pushed snapshot as it arrived: the hub's `at`, its local arrival, and whether it is the replay of a connect. */
export type PushArrival = PushMark & { at: number | null; replay: boolean };

/**
 * Whether a pushed snapshot applies (third review of #520), against `pushAt`: the hub's `at` of the newest snapshot
 * applied so far, null before one (a lower bound of the server time of the data on screen: a read only replaces a
 * push when sent after it). A push always arrives after the data on screen was read, so the local order lets every
 * push in; the hub's `at` only keeps a replay out. The hub replays each topic's stored snapshot on every connect: a
 * replay (the first snapshot of a topic on a socket) applies only when newer than `pushAt`, and no snapshot applies
 * when more than PUSH_SLACK_MS older than it. With nothing known, a snapshot applies (and clears an error only when it
 * arrived after the failed read was sent: withPush). A push without a time never applies.
 */
export function pushApplies(p: Pick<PushArrival, "at" | "replay">, pushAt: number | null): boolean {
  if (p.at == null) return false;
  if (pushAt == null) return true;
  if (p.replay && p.at <= pushAt) return false;
  return p.at >= pushAt - PUSH_SLACK_MS;
}

/**
 * One route's reads and pushes (lib/market.tsx; re-review of #520: each route applies its own answer as it resolves,
 * so a hung sibling read never holds a good answer back). Third review: one local order.
 * - `data`: the last good answer (or applied push), null before one; a failed read never touches it.
 * - `dataSeq`: the local sequence of that data (the read's send, or the push's arrival).
 * - `push`: the last applied push (withPush), `pushAt` the newest applied hub `at` (pushApplies).
 * - `failSeq`: the send of the last failed read.
 * - `sent`, `settled`: the newest read sent and the newest settled (their sequence numbers). A read that settles after
 *   a newer one has is dropped; `sent > settled` is the route's own read in flight.
 */
export type RouteState = {
  data: unknown;
  dataSeq: number | null;
  lastOk: number | null;
  lastFail: number | null;
  failSeq: number | null;
  error: string | null;
  failures: number;
  push: PushMark | null;
  pushAt: number | null;
  sent: number;
  settled: number;
};

export const emptyRoute: RouteState = { data: null, dataSeq: null, lastOk: null, lastFail: null, failSeq: null, error: null, failures: 0, push: null, pushAt: null, sent: 0, settled: 0 };

/** A read of the route is sent, at `seq` (nextSeq): its id. */
export function routeSent(s: RouteState, seq: number): RouteState {
  return { ...s, sent: Math.max(s.sent, seq) };
}

/** What a read brought: its answer, or its error; `at` is when it settled, on the steady clock (localNow). */
export type ReadOutcome = { ok: true; data: unknown; at: number } | { ok: false; error: string; at: number };

/**
 * A read of the route settled (its id: the sequence of its send). Dropped when a newer read has settled already (an
 * overtaken read never undoes a newer answer). A good answer clears the error and sets lastOk to its settle; its data
 * replaces what is on screen unless a push arrived after the read was sent (pushShown). A failed read records the
 * failure and keeps the data as it was: it never becomes null data.
 */
export function routeSettled(s: RouteState, id: number, r: ReadOutcome): RouteState {
  if (id <= s.settled) return s;
  if (!r.ok) return { ...s, settled: id, error: r.error, lastFail: r.at, failSeq: id, failures: s.failures + 1 };
  const lastOk = s.lastOk == null ? r.at : Math.max(s.lastOk, r.at);
  const keep = s.push != null && s.dataSeq === s.push.seq && pushShown(id, s.push);
  return { ...s, settled: id, error: null, failures: 0, lastOk, ...(keep ? {} : { data: r.data, dataSeq: id }) };
}

/** A push of the route (pushApplies): its data shown and its arrival marked; else nothing changes. */
export function routePushed(s: RouteState, data: unknown, p: PushArrival): RouteState {
  if (data == null || !pushApplies(p, s.pushAt)) return s;
  return { ...s, data, dataSeq: p.seq, push: { seq: p.seq, local: p.local }, pushAt: s.pushAt == null ? p.at : Math.max(s.pushAt, p.at as number) };
}

/** The route's facts as a poll shows them: its own reads with the last applied push (withPush). */
export function routeFacts(s: RouteState): ReadFacts {
  return withPush({ error: s.error, lastOk: s.lastOk, lastFail: s.lastFail, failSeq: s.failSeq, failures: s.failures }, s.push);
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
