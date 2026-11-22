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
 * Fourth review of #520: a hub replay (the stored snapshot the hub sends on every connect) may show data, but it never
 * clears an error and never moves lastOk; its age is its `at` on the server clock, carried to the local clock by the
 * reads' `Date` header (serverClock), so a 2-hour-old replay on a reload reads "stale 2h" at once.
 * Fifth review of #520: while a route's own first read is in flight and no Date is known, a replay on screen is
 * "checking" (no stale chip, the plan dimmed); a route whose last read failed reads on the fast cadence, and once
 * when the push turns live or a replay arrives for it (cadenceOf, dueReads, recoveryReads); a cadence change keeps
 * the phase (the next read at max(now, last send + interval)).
 */
export type PollFacts = {
  hasData: boolean;
  error: string | null;
  loading: boolean;
  /** Last good arrival (ms, the steady local clock `localNow`): a good read's settle or a live push's arrival, never a hub replay's; null before one. */
  lastOk: number | null;
  /** Last failed read (ms, `localNow`), null before one. */
  lastFail: number | null;
  /** Failed reads in a row since the last good one. */
  failures: number;
  intervalMs: number;
  /**
   * The data on screen is a hub replay's (fourth review of #520): its age is `replayAt` (its `at` on the local clock,
   * through the reads' Date: replayLocal), never its arrival; null while no read has brought a Date (unknown age:
   * stale, never live). Absent or false: the data's age is lastOk's.
   */
  replayed?: boolean;
  replayAt?: number | null;
  /**
   * The route's own first read is in flight and no Date is known yet (fifth review of #520): a replay on screen of
   * unknown age is "checking" (no stale chip, the plan dimmed, not dropped) until that read settles; stale (and the
   * plan hidden) only if it fails without a Date or brings none.
   */
  checking?: boolean;
};

/** The facts an age is read from: lastOk, or a replay's server-aged time (ageBase). */
export type AgeFacts = Pick<PollFacts, "lastOk"> & Partial<Pick<PollFacts, "replayed" | "replayAt" | "checking">>;

/**
 * The time the data on screen is as of (ms, localNow), for its age (fourth review of #520): lastOk, or for a hub
 * replay its server-aged time (the later of it and lastOk: a good read since only confirms it); null when unknown.
 */
export function ageBase(f: AgeFacts): number | null {
  if (!f.replayed) return f.lastOk;
  if (f.replayAt == null) return null;
  return f.lastOk == null ? f.replayAt : Math.max(f.lastOk, f.replayAt);
}

export type PollPhase = "loading" | "error" | "stale" | "checking" | "live" | "idle";

/**
 * A hub replay of unknown age while the route's own first read is in flight (fifth review of #520): neither stale
 * nor live yet. The connect replay often lands before the first dated read settles on a normal reload; it used to
 * flash "stale" and drop the plan.
 */
export function isChecking(f: Pick<PollFacts, "error"> & AgeFacts): boolean {
  return !!f.checking && !!f.replayed && f.error == null && ageBase(f) == null;
}

/**
 * How far ahead of `now` a last good read may sit before it is not believed (ms; re-review of #520). The pages read
 * every age on the steady clock (localNow, third review), which never moves back, so this is only a guard for a
 * caller that mixes clocks.
 */
export const CLOCK_SLACK_MS = 60_000;

/** The facts of the stale rule. */
export type StaleFacts = Pick<PollFacts, "hasData" | "error" | "lastOk" | "intervalMs"> & AgeFacts;

/**
 * Data on screen AND (the last read failed OR no good read for 2 × the interval OR the last good read is more than
 * CLOCK_SLACK_MS in the future: the clock moved back OR the data is a hub replay of unknown age, unless it is still
 * checking: isChecking). An interval of 0 never ages. The age is ageBase's: lastOk, or a replay's server-aged time.
 */
export function isStale(f: StaleFacts, now: number): boolean {
  if (!f.hasData) return false;
  if (f.error != null) return true;
  const t = ageBase(f);
  if (f.replayed && t == null) return !isChecking(f);
  if (t != null && t > now + CLOCK_SLACK_MS) return true;
  return f.intervalMs > 0 && t != null && now - t > 2 * f.intervalMs;
}

/** Which state the panel shows. An error with no data stays an error while its retry is in flight (no skeleton flash). */
export function pollPhase(f: PollFacts, now: number): PollPhase {
  if (f.hasData) return isStale(f, now) ? "stale" : isChecking(f) ? "checking" : "live";
  if (f.error != null) return "error";
  if (f.loading) return "loading";
  return "idle";
}

/** When the stale rule's clock runs out with no new read (ms), for a timer; null when it cannot. */
export function staleAt(f: Pick<PollFacts, "lastOk" | "intervalMs"> & AgeFacts): number | null {
  const t = ageBase(f);
  return f.intervalMs > 0 && t != null ? t + 2 * f.intervalMs + 1 : null;
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

/**
 * The stale tag's tooltip: the last good read, then what failed, how often and the retry cadence; for a hub replay on
 * screen, the time of its data (fourth review of #520).
 */
export function staleTitle(f: Pick<PollFacts, "error" | "lastOk" | "lastFail" | "failures" | "intervalMs"> & Partial<Pick<PollFacts, "replayed" | "replayAt">>): string {
  const lines = [`last ok ${okLine(f.lastOk)}`];
  if (f.replayed) lines.push(f.replayAt == null ? "replayed by the hub · age unknown until a read answers" : `replayed by the hub · data of ${okLine(f.replayAt)}`);
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
export function staleChanged(shown: boolean, f: StaleFacts, now: number): boolean {
  return isStale(f, now) !== shown;
}

/**
 * The steady local clock (ms, epoch-like): it follows the wall clock forward (a sleep, where the monotonic clock may
 * pause, still counts) but never backward: on a backward step (NTP, a VM resume) it advances by the monotonic clock
 * instead (third review of #520). Every local age (lastOk, lastFail, the stale tag, the plan lines) is read on it, so a
 * backward step never freezes a live tag or a stale verdict. Pure: give it the two sources to test it.
 *
 * Fifth review of #520: anchored, t = t0 + max(w − w0, m − m0, 0), so it never sums the per-call maxima of two
 * jittering clocks (that ran every age 0.1–0.3% old). A backward wall step re-anchors it at the time already
 * reached plus the monotonic time since the last call: a step back never moves it backward, and a later forward
 * step (a sleep) is counted in full.
 */
export function steadyClock(wall: () => number = () => Date.now(), mono: () => number = monotonic): () => number {
  let w0 = wall(), m0 = mono(), t0 = w0, last = t0, wPrev = w0, mPrev = m0;
  return () => {
    const w = wall(), m = mono();
    if (w < wPrev) { t0 = last + Math.max(0, m - mPrev); w0 = w; m0 = m; }
    const t = Math.max(last, t0 + Math.max(w - w0, m - m0, 0));
    last = t; wPrev = w; mPrev = Math.max(mPrev, m);
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
 * A forward jump of the clock (fourth review of #520): the steady clock (localNow, which follows a forward wall-clock
 * step and a sleep) ran ahead of the monotonic one by more than `limitMs` since the last check. A wall-clock step
 * forward (NTP) or a wake from sleep schedules no read, so the age of the data on screen jumps with it ("stale 16m",
 * dimmed plan lines) until the next scheduled read; on a jump the poll reads once at once (usePoll, useSchedule).
 * Pure: give it the two clocks to test it. Fifth review: one detector per poll for its whole life (a ref), never
 * re-created with the interval: a wake with the socket dropped changes the interval before the first tick, and a
 * new detector would take its baselines after the jump and miss it.
 */
export function clockJump(steady: () => number = localNow, mono: () => number = monotonic): (limitMs: number) => boolean {
  let s0 = steady(), m0 = mono();
  return (limitMs) => {
    const s = steady(), m = mono();
    const jumped = s - s0 - Math.max(0, m - m0) > limitMs;
    s0 = s; m0 = m;
    return jumped;
  };
}

/**
 * The resolution of the HTTP `Date` header (ms): it is whole seconds, so a read's server time is within 1 s of it
 * (fourth review of #520).
 */
export const DATE_SLACK_MS = 1_000;

/** How many reads the server-to-local offset is the minimum of (serverClock). */
export const OFFSET_SAMPLES = 6;

/** A read whose settle is more than this from its `Date` (ms) is not a clock sample (a broken proxy or clock). */
export const OFFSET_MAX_MS = 86_400_000;

/**
 * The server clock as the page sees it (fourth review of #520): each poll or retry read records its response's `Date`
 * (the server's ms, whole seconds; a failed read's 502 carries one too) and the local time it settled (localNow). Each
 * read gives (local settle) − (Date), the server-to-local offset plus the read's latency; the offset is the minimum
 * of the last OFFSET_SAMPLES (the read with the least latency). The reads are same-origin /api/* reads (Date is not a
 * CORS-safelisted header, but a same-origin response exposes every header) and no-store (a cached response carries
 * the cache's Date): api.ts getDated, usePoll.ts readDated. The hub's `at` is on the same Cloudflare clock, so a
 * replay's local time is `at + offset` (replayLocal). Null before any read brought a Date.
 *
 * The offset errs YOUNGER (fifth review of #520): the server stamps Date before the response leaves it and truncates
 * it to the second, so (local settle) − Date is the true offset plus the latency plus up to 1 s; a replay's local
 * time is that much late, and its age is underestimated by the latency plus up to 1 s (never overestimated).
 * Samples more than OFFSET_MAX_MS (a day) from the local clock are ignored.
 */
export function serverClock(samples: number = OFFSET_SAMPLES) {
  let seen: number[] = [];
  return {
    note(date: number | null, local: number): void {
      if (date == null || !Number.isFinite(date) || !Number.isFinite(local)) return;
      if (Math.abs(local - date) > OFFSET_MAX_MS) return;
      seen = [...seen.slice(1 - samples), local - date];
    },
    offset(): number | null { return seen.length ? Math.min(...seen) : null; },
  };
}

/** The page's server clock (serverClock): every dated read notes into it. */
export const pageServer = serverClock();

/** A hub time (`at`, ms) on the steady local clock, through the server-to-local offset; null when either is unknown. */
export function replayLocal(at: number | null, offset: number | null): number | null {
  return at == null || offset == null ? null : at + offset;
}

/**
 * A live push that was applied (third review of #520): when it arrived, on the local sequence (`seq`) and the steady
 * clock (`local`). A hub replay is never one (fourth review): it never moves lastOk or clears an error.
 */
export type PushMark = { seq: number; local: number };

/** The facts of a read, with the local sequence of its last failure (`failSeq`: the failed read's send). */
export type ReadFacts = Pick<PollFacts, "error" | "lastOk" | "lastFail" | "failures"> & { failSeq: number | null };

/**
 * A read that a push can also deliver (the War Room's rooms and decision, ADR-0015), with the last applied LIVE push
 * (third review of #520). The push's arrival counts toward lastOk; clearing the error needs the push to have arrived
 * after the failed read was sent, on the local sequence. A failed read sent after the push still counts. Fourth
 * review: a replay is never passed here (takePush keeps it out of `push`), so a replay never clears an error and
 * never moves lastOk, whatever its age.
 */
export function withPush<F extends ReadFacts>(f: F, p: PushMark | null): F {
  if (p == null) return f;
  const lastOk = f.lastOk == null ? p.local : Math.max(f.lastOk, p.local);
  const clears = f.error != null && (f.failSeq == null || p.seq > f.failSeq);
  return clears ? { ...f, lastOk, error: null, failures: 0 } : { ...f, lastOk };
}

/** Whether a live push beats a read: it arrived after the read was sent (the local order). */
export function pushShown(readSeq: number | null, p: PushMark | null): boolean {
  return p != null && (readSeq == null || p.seq > readSeq);
}

/** How much older (hub clock) than the newest applied push a snapshot may be and still apply (ms). */
export const PUSH_SLACK_MS = 120_000;

/**
 * The hub's own time of a pushed snapshot (ms) from its `at` (ISO): null when missing or not a date. It is the hub's
 * (Cloudflare's) clock: compared with other snapshots' `at` and with the reads' `Date` (fourth review of #520), never
 * with a browser time.
 */
export function pushTime(at: unknown): number | null {
  const t = typeof at === "string" ? Date.parse(at) : typeof at === "number" ? at : NaN;
  return Number.isFinite(t) ? t : null;
}

/** A pushed snapshot as it arrived: the hub's `at`, its local arrival, and whether it is the replay of a connect. */
export type PushArrival = PushMark & { at: number | null; replay: boolean };

/**
 * Whether a pushed snapshot applies against the other pushes (third review of #520), against `pushAt`: the hub's `at`
 * of the newest snapshot applied so far, null before one. A replay (the first snapshot of a topic on a socket, which
 * the hub sends from its store on every connect) applies only when newer than `pushAt`, and no snapshot applies when
 * more than PUSH_SLACK_MS older than it. A push without a time never applies. Against the reads: takePush.
 */
export function pushApplies(p: Pick<PushArrival, "at" | "replay">, pushAt: number | null): boolean {
  if (p.at == null) return false;
  if (pushAt == null) return true;
  if (p.replay && p.at <= pushAt) return false;
  return p.at >= pushAt - PUSH_SLACK_MS;
}

/** The read whose answer a route holds: its data, its send (local sequence) and its response's `Date` (server ms). */
export type ReadSide = { data: unknown; seq: number; date: number | null };

/** The last applied push with its data. */
export type PushSide = PushArrival & { data: unknown };

/**
 * Whether the push's data is shown rather than the read's (fourth review of #520):
 * - a live push: when it arrived after the read was sent (the f42efc2 rule, pushShown);
 * - a replay: only when its `at` is newer than the read's `Date` less DATE_SLACK_MS. A read with no Date wins (the
 *   replay cannot be shown newer). A read in flight is compared when it settles: this runs on every settle.
 * With no read, the push.
 *
 * Known limit (fifth review of #520): `Date` is stamped when the response leaves the server, not when the server
 * read its data. A read that leaves the server more than DATE_SLACK_MS after reading its data can beat a newer
 * replay of a publish the socket missed (published between that data read and the response). The window is narrow
 * (a publish within the read's own server time) and main has it too; the next live push or read corrects it.
 */
export function pushWins(read: ReadSide | null, p: PushSide | null): boolean {
  if (p == null) return false;
  if (read == null) return true;
  if (p.replay) return read.date != null && p.at != null && p.at > read.date - DATE_SLACK_MS;
  return pushShown(read.seq, p);
}

/** A route's pushes: the last applied one (`pushed`), the last applied live one (`push`), the newest hub `at`. */
export type PushSlots = { pushed: PushSide | null; push: PushMark | null; pushAt: number | null };

/**
 * A pushed snapshot arrives (fourth review of #520): the new slots, or null when it does not apply. It must apply
 * against the pushes (pushApplies, the PUSH_SLACK_MS refusals); a replay must also beat the read on screen (pushWins),
 * else it is dropped. A replay is never the live mark (`push`), so it never moves lastOk or clears an error.
 */
export function takePush(slots: PushSlots, read: ReadSide | null, data: unknown, p: PushArrival): PushSlots | null {
  if (data == null || !pushApplies(p, slots.pushAt)) return null;
  const side: PushSide = { ...p, data };
  if (p.replay && !pushWins(read, side)) return null;
  return {
    pushed: side,
    push: p.replay ? slots.push : { seq: p.seq, local: p.local },
    pushAt: slots.pushAt == null ? p.at : Math.max(slots.pushAt, p.at as number),
  };
}

/** What is on screen: the push's data when it wins (pushWins), else the read's; `push` is the push shown, if any. */
export function shownSide(read: ReadSide | null, pushed: PushSide | null): { data: unknown; seq: number | null; push: PushSide | null } {
  if (pushed != null && pushWins(read, pushed)) return { data: pushed.data, seq: pushed.seq, push: pushed };
  return read != null ? { data: read.data, seq: read.seq, push: null } : { data: null, seq: null, push: null };
}

/**
 * The facts of what is on screen (fourth review of #520): the read's facts with the last live push (withPush), and,
 * when the data shown is a replay's, its server-aged time (replayLocal: null while no Date is known, unknown age).
 * Fifth review: `firstPending` (the route's own first read is in flight) with no Date known marks it `checking`.
 */
export function shownFacts<F extends ReadFacts>(f: F, live: PushMark | null, shown: PushSide | null, offset: number | null, firstPending = false): F & Partial<Pick<PollFacts, "replayed" | "replayAt" | "checking">> {
  const g = withPush(f, live);
  if (!shown?.replay) return g;
  const replayAt = replayLocal(shown.at, offset);
  return replayAt == null && firstPending ? { ...g, replayed: true, replayAt, checking: true } : { ...g, replayed: true, replayAt };
}

/**
 * One route's reads and pushes (lib/market.tsx; re-review of #520: each route applies its own answer as it resolves,
 * so a hung sibling read never holds a good answer back). Third review: one local order. Fourth review: the read and
 * the push are kept apart and the one shown is chosen on every change (shownSide).
 * - `data`, `dataSeq`: what is on screen and its local sequence (derived: shownSide).
 * - `read`: the last good read (its data, send and `Date`); a failed read never touches it.
 * - `pushed`, `push`, `pushAt`: the pushes (takePush).
 * - `failSeq`: the send of the last failed read.
 * - `sent`, `settled`: the newest read sent and the newest settled (their sequence numbers). A read that settles after
 *   a newer one has is dropped; `sent > settled` is the route's own read in flight.
 */
export type RouteState = PushSlots & {
  data: unknown;
  dataSeq: number | null;
  read: ReadSide | null;
  lastOk: number | null;
  lastFail: number | null;
  failSeq: number | null;
  error: string | null;
  failures: number;
  sent: number;
  settled: number;
};

export const emptyRoute: RouteState = { data: null, dataSeq: null, read: null, pushed: null, push: null, pushAt: null, lastOk: null, lastFail: null, failSeq: null, error: null, failures: 0, sent: 0, settled: 0 };

const withShown = (s: RouteState): RouteState => {
  const v = shownSide(s.read, s.pushed);
  return { ...s, data: v.data, dataSeq: v.seq };
};

/** A read of the route is sent, at `seq` (nextSeq): its id. */
export function routeSent(s: RouteState, seq: number): RouteState {
  return { ...s, sent: Math.max(s.sent, seq) };
}

/**
 * What a read brought: its answer, or its error; `at` is when it settled, on the steady clock (localNow), `date` its
 * response's `Date` (server ms; null or absent when it had none).
 */
export type ReadOutcome = { ok: true; data: unknown; at: number; date?: number | null } | { ok: false; error: string; at: number; date?: number | null };

/**
 * A read of the route settled (its id: the sequence of its send). Dropped when a newer read has settled already (an
 * overtaken read never undoes a newer answer). A good answer clears the error, sets lastOk to its settle and becomes
 * the route's read; it is shown unless a live push arrived after it was sent, or a replay newer than its `Date` is
 * there (pushWins). A failed read records the failure and keeps the data as it was: it never becomes null data.
 */
export function routeSettled(s: RouteState, id: number, r: ReadOutcome): RouteState {
  if (id <= s.settled) return s;
  if (!r.ok) return { ...s, settled: id, error: r.error, lastFail: r.at, failSeq: id, failures: s.failures + 1 };
  const lastOk = s.lastOk == null ? r.at : Math.max(s.lastOk, r.at);
  return withShown({ ...s, settled: id, error: null, failures: 0, lastOk, read: { data: r.data, seq: id, date: r.date ?? null } });
}

/** A push of the route (takePush): kept and shown when it wins; else nothing changes (the same state). */
export function routePushed(s: RouteState, data: unknown, p: PushArrival): RouteState {
  const next = takePush(s, s.read, data, p);
  return next == null ? s : withShown({ ...s, ...next });
}

/** The route's own first read is in flight: sent, and none of its reads has settled (fifth review of #520). */
export const firstPending = (s: Pick<RouteState, "sent" | "settled">): boolean => s.sent > 0 && s.settled === 0;

/**
 * The route's facts as a poll shows them (shownFacts): its own reads with the last live push, and a replay on screen
 * aged through `offset` (pageServer.offset(): the server-to-local offset; null: unknown age), checking while its
 * first read is in flight (firstPending).
 */
export function routeFacts(s: RouteState, offset: number | null = null): ReadFacts & Partial<Pick<PollFacts, "replayed" | "replayAt" | "checking">> {
  return shownFacts({ error: s.error, lastOk: s.lastOk, lastFail: s.lastFail, failSeq: s.failSeq, failures: s.failures }, s.push, shownSide(s.read, s.pushed).push, offset, firstPending(s));
}

/** How long a stale decision's plan lines stay on the chart, dimmed and labelled, before they are dropped (ms). */
export const PLAN_HIDE_MS = 2 * 3_600_000;

/**
 * How the chart draws the plan of the global decision (Entry, Stop, SL+, TP and the zones; re-review of #520), from
 * that read's poll facts: at full strength while live; dimmed with " · stale 1h" on each title while stale; dropped,
 * with a small note, once the decision is older than PLAN_HIDE_MS (or of unknown age). The age is ageBase's: a hub
 * replay's is its server-aged time (fourth review), so a 2-hour-old replay is hidden at once.
 * Fifth review: while checking (isChecking) dimmed with " · checking", never dropped; a data time more than
 * CLOCK_SLACK_MS in the future (not believable, isStale) is hidden, never drawn dimmed with no age.
 */
export function planMark(f: StaleFacts, now: number): { show: boolean; dim: boolean; suffix: string; note: string | null } {
  if (!isStale(f, now)) return isChecking(f) ? { show: true, dim: true, suffix: " · checking", note: null } : { show: true, dim: false, suffix: "", note: null };
  const t = ageBase(f);
  const age = t == null ? null : now - t;
  if (age == null || age < -CLOCK_SLACK_MS || age >= PLAN_HIDE_MS) return { show: false, dim: true, suffix: "", note: `plan hidden: decision stale${age == null || age < 0 ? "" : ` ${shortAge(age)}`}` };
  return { show: true, dim: true, suffix: age < 0 ? " · stale" : ` · stale ${shortAge(age)}`, note: null };
}

/** The clock of the chart's plan mark (ms): the decision card's 1 s clock (fifth review of #520). */
export const PLAN_TICK_MS = 1_000;

/** A plan mark as one string, so the chart renders only when it changes. */
export const markKey = (m: ReturnType<typeof planMark>): string => `${m.show}|${m.dim}|${m.suffix}|${m.note ?? ""}`;

/**
 * The cadence a route reads at (fifth review of #520): `fastMs` while its last read failed (an errored route never
 * waits the 5-minute fallback of a live push: a transient 502 recovers within the fast cadence), else `intervalMs`.
 * An interval of 0 (no refresh) stays 0.
 */
export function cadenceOf(errored: boolean, intervalMs: number, fastMs: number): number {
  if (!intervalMs) return 0;
  return errored && fastMs > 0 ? Math.min(intervalMs, fastMs) : intervalMs;
}

/** A route on a schedule: its key, its last send (ms, localNow; null before one) and its cadence (ms; 0: none). */
export type Cadence = { key: string; lastSend: number | null; every: number };

/**
 * The reads due now, and how long until the next check (fifth review of #520). A route is due at
 * max(now, lastSend + every): a cadence change keeps the phase (it never restarts the interval, so a socket that
 * flaps every 1–4 minutes no longer postpones the fallback read forever, and a route that turns errored reads at
 * once if its last send is older than the fast cadence). While the tab is hidden nothing is read (the tab becoming
 * visible reads) and a due route is checked again a cadence later. `waitMs` is null with no route on a cadence.
 */
export function dueReads(routes: Cadence[], now: number, visible = true): { due: string[]; waitMs: number | null } {
  const due: string[] = [];
  let next: number | null = null;
  for (const r of routes) {
    if (!r.every) continue;
    const at = r.lastSend == null ? now : r.lastSend + r.every;
    let then = at;
    if (at <= now) {
      if (visible) due.push(r.key);
      then = now + r.every;
    }
    next = next == null ? then : Math.min(next, then);
  }
  return { due, waitMs: next == null ? null : Math.max(0, next - now) };
}

/** The push turned live (every topic delivered on the open socket) since the last render (fifth review of #520). */
export const turnedLive = (was: boolean, live: boolean): boolean => live && !was;

/**
 * The routes to read once at once (fifth review of #520): of `routes` (every route when the push turns live, the
 * routes a replay carries when one arrives), those whose last read failed and whose read is not in flight
 * (single-flight). The hub answering means the network is back, so an errored route need not wait its cadence.
 */
export function recoveryReads(routes: readonly string[], errored: (key: string) => boolean, inFlight: (key: string) => boolean): string[] {
  return routes.filter((k) => errored(k) && !inFlight(k));
}

/**
 * Whether a pushed snapshot is the replay of a connect (fifth review of #520): the hub's own flag when it sends one
 * (`replay: true` on its connect sends, `false` on a live publish), else the first snapshot of the topic on this
 * socket (the older hub's behaviour: a topic's first live publish after a connect with nothing stored is then taken
 * for a replay and cannot clear an error).
 */
export function isReplay(flag: unknown, firstOnSocket: boolean): boolean {
  return typeof flag === "boolean" ? flag : firstOnSocket;
}
