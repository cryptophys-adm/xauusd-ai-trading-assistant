// Nexus panel data states (owner-approved mockup "Nexus data states", part A, 2026-11-22): loading, empty, error, stale
// and live for every polled panel. The rules are pure (ui/src/lib/pollState.ts) and the error is a code
// (ui/src/lib/api.ts ApiError: "/api/ledger 502"); the pages print that one error line, never "Unavailable: HTTP 502".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLOCK_SLACK_MS, DATE_SLACK_MS, OFFSET_MAX_MS, OFFSET_SAMPLES, PLAN_HIDE_MS, PLAN_TICK_MS, PUSH_SLACK_MS, RETRY_JOIN_MS, STALE_TICK_MS, ageBase, cadenceOf, clockJump, dueReads, emptyRoute, firstPending, isChecking, isReplay, isStale, joinsInFlight, markKey, okLine, pageServer, planMark, pollPhase, pushApplies, pushShown, pushTime, pushWins, recoveryReads, replayLocal, retryEvery, routeFacts, routePushed, routeSent, routeSettled, serverClock, shortAge, shownFacts, shownSide, singleFlight, staleAt, staleChanged, staleTitle, staleWake, steadyClock, takePush, turnedLive, utcClock, wallOf, withPush } from "../workers/xauusd-nexus-dashboard/ui/src/lib/pollState.ts";
import { overviewBadge } from "../workers/xauusd-nexus-dashboard/ui/src/lib/healthBadge.ts";
import { ApiError, CHART_READ, errorText, get, getDated, sameOrigin } from "../workers/xauusd-nexus-dashboard/ui/src/lib/api.ts";

const src = (p) => readFileSync(new URL(`../workers/xauusd-nexus-dashboard/ui/src/${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const now = Date.parse("2026-11-22T14:02:00Z");
const base = { hasData: true, error: null, loading: false, lastOk: now - 30_000, lastFail: null, failures: 0, intervalMs: 60_000 };

test("PS1 stale = data on screen AND (the last read failed OR no good read for 2 × the interval)", () => {
  assert.equal(isStale(base, now), false, "a good read 30 s ago is live");
  assert.equal(isStale({ ...base, error: "/api/ledger 502" }, now), true, "a failed refresh after a good read");
  assert.equal(isStale({ ...base, lastOk: now - 120_000 }, now), false, "exactly 2 × the interval is not yet stale");
  assert.equal(isStale({ ...base, lastOk: now - 120_001 }, now), true, "past 2 × the interval with no good read");
  assert.equal(isStale({ ...base, hasData: false, error: "/api/ledger 502" }, now), false, "no data: an error, not stale");
  assert.equal(isStale({ ...base, intervalMs: 0, lastOk: now - 86_400_000 }, now), false, "a poll that never refreshes never ages");
  assert.equal(isStale({ ...base, intervalMs: 0, error: "/api/x 500" }, now), true, "but its failed retry is still stale");
});

test("PS2 the phase: skeleton only on the first load; an error with no data stays an error while it retries", () => {
  assert.equal(pollPhase({ ...base, hasData: false, lastOk: null, loading: true }, now), "loading");
  assert.equal(pollPhase({ ...base, hasData: false, lastOk: null, error: "/api/ledger 502" }, now), "error");
  assert.equal(pollPhase({ ...base, hasData: false, lastOk: null, error: "/api/ledger 502", loading: true }, now), "error", "Retry now never flashes the skeleton");
  assert.equal(pollPhase({ ...base, loading: true }, now), "live", "a background refresh keeps the data");
  assert.equal(pollPhase({ ...base, error: "/api/ledger 502", failures: 3 }, now), "stale");
  assert.equal(pollPhase({ ...base, hasData: false, lastOk: null }, now), "idle");
});

test("PS3 the stale timer fires just past 2 × the interval; none without a good read or an interval", () => {
  assert.equal(staleAt({ lastOk: now, intervalMs: 60_000 }), now + 120_001);
  assert.equal(staleAt({ lastOk: null, intervalMs: 60_000 }), null);
  assert.equal(staleAt({ lastOk: now, intervalMs: 0 }), null);
  assert.equal(isStale({ ...base, lastOk: now }, staleAt({ lastOk: now, intervalMs: 60_000 })), true, "the timer lands on a stale render");
});

test("PS4 ages, cadences and clocks as the tag and the error box print them", () => {
  assert.deepEqual([45_000, 7 * 60_000, 3 * 3_600_000, 50 * 3_600_000].map(shortAge), ["45s", "7m", "3h", "2d"]);
  assert.deepEqual([60_000, 120_000, 300_000, 0].map(retryEvery), ["60s", "2m", "5m", "off"]);
  assert.equal(utcClock(Date.parse("2026-11-22T13:55:07Z")), "13:55:07");
  assert.equal(utcClock(Date.parse("2026-11-22T13:55:07Z"), false), "13:55");
  assert.match(okLine(Date.parse("2026-11-22T13:55:07Z")), /^13:55:07 UTC · \d\d:\d\d:\d\d local$/);
  assert.equal(okLine(null), "—", "never read: a dash");
  const t = staleTitle({ error: "/api/ledger 502", lastOk: Date.parse("2026-11-22T13:55:07Z"), lastFail: Date.parse("2026-11-22T14:02:00Z"), failures: 3, intervalMs: 60_000 });
  assert.match(t, /^last ok 13:55:07 UTC · \d\d:\d\d:\d\d local\n\/api\/ledger 502 at 14:02:00 UTC · 3 failed · retry 60s$/);
});

test("PS5 ApiError carries the route, the status and the server's code; the message is the error line", async () => {
  const e = new ApiError("/api/ledger?days=30", 502, null);
  assert.deepEqual([e.message, e.route, e.path, e.status, e.code, e instanceof Error], ["/api/ledger 502", "/api/ledger", "/api/ledger?days=30", 502, null, true]);
  assert.equal(new ApiError("/api/calendar", 503, "not_configured").message, "/api/calendar 503 not_configured");
  assert.equal(new ApiError("/api/x", 500, "a_very_long_server_error_code_indeed").code.length, 24, "the code is cut at 24 characters");
  assert.equal(errorText(new ApiError("/api/ledger", 0)), "/api/ledger net", "offline");
  assert.equal(errorText("plain"), "plain");

  const real = globalThis.fetch;
  const reply = (status, body) => async () => new Response(body == null ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  try {
    globalThis.fetch = reply(502, null);
    await assert.rejects(get("/api/ledger?days=30"), (err) => err instanceof ApiError && err.message === "/api/ledger 502");
    globalThis.fetch = reply(503, { error: "not_configured" });
    await assert.rejects(get("/api/calendar"), { message: "/api/calendar 503 not_configured" });
    globalThis.fetch = reply(500, { status: "error" });
    await assert.rejects(get("/api/status"), { message: "/api/status 500 error" });
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(get("/api/ledger"), { message: "/api/ledger net" });
    globalThis.fetch = reply(404, { status: "not_found" });
    assert.deepEqual(await get("/api/decision/x"), { status: "not_found" }, "the not-found answer callers read stays an answer");
    globalThis.fetch = reply(200, { ledger: { items: [] } });
    assert.deepEqual(await get("/api/ledger"), { ledger: { items: [] } });
  } finally {
    globalThis.fetch = real;
  }
});

test("PS6 usePoll keeps its contract and adds lastOk, lastFail, failures and stale", () => {
  const s = src("lib/usePoll.ts");
  assert.match(s, /export function usePoll<T>\(load: \(\) => Promise<T>, intervalMs = 0, deps: unknown\[\] = \[\], errorMs = intervalMs\)/, "the interval stays apart from the deps (fifth review: and the cadence while errored)");
  assert.match(s, /if \(!hasData\.current\) setLoading\(true\);/, "the skeleton only on the first load");
  assert.match(s, /document\.visibilityState === "visible"/, "visible-only refresh");
  assert.match(s, /return \{ data, error, loading, refresh, lastOk, lastFail, failures, stale, intervalMs: every, busy, sentSeq, failSeq, nudge \};/, "fifth review: the cadence in force, and nudge");
  // Third review of #520: ages on the steady local clock (localNow), never Date.now().
  assert.match(s, /isStale\(\{ hasData: present, error, lastOk, intervalMs: every \}, localNow\(\)\)/, "one stale rule, from lib/pollState.ts");
  assert.doesNotMatch(s, /Date\.now\(\)/, "no wall-clock time in usePoll");
  assert.doesNotMatch(s, /\.generated_at\b/, "no API field: the browser clock (owner: no API change)");
});

test("PS7 the shared pieces: Panel's tag, PollBody, the error box, the empty line, the chart skeleton", () => {
  const u = src("components/ui.tsx");
  for (const name of ["export function Panel(", "export function PollBody(", "export function ErrorBox(", "export function PollError(", "export function RetryButton(", "export function Empty({ children, when }", "variant = \"rows\""]) {
    assert.ok(u.includes(name), name);
  }
  assert.match(u, /border-late-fill\/35 bg-late-fill\/10 text-late"\)\}><Dot tone="late" \/>stale \{age\}/, "stale is amber (late)");
  assert.match(u, /border-fault-fill\/35 bg-fault-fill\/10 text-fault"\)\}[^>]*><Dot tone="fault" \/>error/, "error is red (fault)");
  assert.match(u, /<Dot tone="ok" \/>\{utcClock\(ok, false\)\} UTC/, "live is cyan (ok), the time in UTC");
  assert.match(u, /const ok = wallOf\(ageBase\(poll\)\);/, "shown as the wall clock reads it now (third review: the time itself is local; fourth: a replay's server-aged time)");
  assert.match(u, /last ok \{okLine\(lastOk, false\)\}/, "the error box shows the last good read");
  assert.match(u, /"Retry now"/);
  assert.match(u, /h-11/, "44 px touch targets on a phone");
  const body = u.slice(u.indexOf("export function PollBody("));
  assert.ok(body.indexOf('phase === "error"') < body.indexOf('phase === "loading"'), "an error is shown before the skeleton");
});

test("PS8 Model checks for an error before saying \"No … yet\"", () => {
  const m = src("pages/Model.tsx");
  for (const p of ["dataset", "baseline", "gbm", "tuning"]) assert.match(m, new RegExp(`<PollBody poll=\\{${p}\\}`), p);
  assert.doesNotMatch(m, /baseline\.loading && !baseline\.data \? <Skeleton rows=\{4\} \/> : !b \?/, "the old chain read a 502 as \"not trained yet\"");
  assert.doesNotMatch(m, /gbm\.loading && !gbm\.data \? <Skeleton rows=\{4\} \/> : !g \?/);
  assert.match(m, /empty=\{!b && <Empty when=/);
});

test("PS9 market.tsx keeps the per-read catch and exposes which routes failed; the News tab shows it", () => {
  const mk = src("lib/market.tsx");
  // Re-review of #520: the per-read catch settles that path as a failure, and a failed read never becomes null data.
  assert.match(mk, /\(e\) => settle\(\{ ok: false, error: errorText\(e\), at: localNow\(\), date: \(e as ApiError\)\?\.date \?\? null \}\),/, "each read still catches its own failure (fourth review: with its Date)");
  assert.doesNotMatch(mk, /return null;\n\s+\}\);/, "the catch no longer answers null for the batch");
  const was = { ...emptyRoute, data: { engine: { stance: "SELL" } }, dataSeq: 1, lastOk: now - 59_000, sent: 1, settled: 1 };
  const failedRead = routeSettled(routeSent(was, 2), 2, { ok: false, error: "/api/conclusion/global 502", at: now });
  assert.equal(failedRead.data, was.data, "a failed read keeps the data as it was: never null");
  assert.deepEqual([failedRead.error, failedRead.lastFail, failedRead.failSeq, failedRead.failures, failedRead.lastOk], ["/api/conclusion/global 502", now, 2, 1, now - 59_000]);
  assert.equal(routeSettled({ ...emptyRoute, sent: 1 }, 1, { ok: false, error: "/api/x 502", at: now }).data, null, "with nothing on screen it stays nothing (the error box), not a null answer");
  assert.match(mk, /for \(const path of ALL_PATHS\) \{\n\s+const f = routeFacts\(route\(path\)\);\n\s+if \(f\.error\) failed\[path\] = f\.error;/, "which routes failed, from each path's own facts");
  assert.doesNotMatch(mk, /\.catch\(\(\) => null\)/, "no silent catch left");
  const tp = src("components/ThreadsPanel.tsx");
  assert.match(tp, /if \(tab === "NEWS"\) return news \? <><PollStrip poll=\{pollOf\(NEWS_PATH\)\} \/><NewsTab d=\{news\} \/><\/> : failure\(NEWS_PATH\) \?\? <p className="text-\[12px\] text-muted">No news analysis yet\.<\/p>;/);
  assert.match(tp, /failure\(threadPath\(tab\)\)/, "the room tabs too");
});

test("PS10 the listed pages print the shared error line, never the raw \"Unavailable: HTTP …\"", () => {
  const pages = ["pages/Performance.tsx", "pages/Calendar.tsx", "pages/Correlations.tsx", "pages/Alerts.tsx", "pages/Audit.tsx", "pages/Status.tsx", "pages/Scorecards.tsx", "pages/Shadow.tsx", "pages/Neurons.tsx", "pages/Strategy.tsx", "pages/Councils.tsx", "pages/Model.tsx", "components/ThreadsPanel.tsx"];
  for (const f of pages) {
    const s = src(f);
    assert.doesNotMatch(s, /Unavailable: HTTP|HTTP \$\{r\.status\}\)? *<|Failed to load: \{/, `${f}: no raw HTTP text`);
    assert.doesNotMatch(s, /unavailable:? \(?\{(error|\w+Poll\.error)\}/i, `${f}: no "… unavailable: {error}"`);
    assert.match(s, /<PollError poll=|<PollBody poll=|<ErrorBox /, `${f}: the shared error line`);
  }
  assert.doesNotMatch(src("lib/api.ts"), /`HTTP \$\{r\.status\}`/, "the API throws a code, not \"HTTP 502\"");
});

test("PS11 Performance: one poll feeds every panel, so the tag shows once, beside Refresh; the equity panel's empty line", () => {
  const p = src("pages/Performance.tsx");
  assert.equal((p.match(/^\s+poll=\{ledgerPoll\}$/gm) ?? []).length, 1, "one tag: one Panel carries the poll");
  const top = p.slice(p.indexOf('title="Performance"'), p.indexOf("{/* View Mode & Time Window Tabs */}"));
  assert.ok(top.includes("poll={ledgerPoll}") && top.includes("Refresh"), "on the top panel, with Refresh");
  assert.match(p, /<Empty when="Draws from the 2nd closed trade\. The ledger runs every 5m\.">/);
  assert.match(p, /\{days\}D · \{POLICY_SHORT\[policy\]\}/, "0 closed trades · 30D · TP1");
});

// Review of #520 (the fixes): the decision and Status keep or flag their data on a failed read; stale after a sleep or
// a clock jump; no "nothing yet" on an error; a busy-guarded Retry now.

test("PS12 the stale timer: re-armed when it fires before staleAt (the clock moved back); renders on or after it", () => {
  const at = staleAt({ lastOk: now, intervalMs: 60_000 });
  assert.deepEqual(staleWake(at, at - 3_600_000), { render: false, rearmMs: 3_600_000 }, "a backward jump of 1 h: armed again for the hour left");
  assert.deepEqual(staleWake(at, at - 1), { render: false, rearmMs: 1 });
  assert.deepEqual(staleWake(at, at), { render: true, rearmMs: null });
  assert.deepEqual(staleWake(at, at + 8 * 3_600_000), { render: true, rearmMs: null }, "after a sleep: render once");
  assert.deepEqual(staleWake(null, now), { render: false, rearmMs: null }, "no good read or no interval: nothing to do");
  const s = src("lib/usePoll.ts");
  assert.match(s, /const w = staleWake\(at, localNow\(\)\);\n\s+if \(w\.rearmMs != null\) arm\(w\.rearmMs\);\n\s+else if \(w\.render\) rerender\(\);/, "usePoll arms the timer again");
});

test("PS13 after a sleep: the tab coming back and a coarse tick re-evaluate stale, rendering only when it changes", () => {
  assert.ok(STALE_TICK_MS >= 15_000 && STALE_TICK_MS <= 30_000, "a 15–30 s tick");
  const f = { hasData: true, error: null, lastOk: now - 8 * 3_600_000, intervalMs: 60_000 };
  assert.equal(staleChanged(false, f, now), true, "8 h old data shown as live: render");
  assert.equal(staleChanged(true, f, now), false, "already stale on screen: no render");
  assert.equal(staleChanged(false, { ...f, lastOk: now - 30_000 }, now), false, "live and still live: no render");
  const s = src("lib/usePoll.ts");
  const vis = s.slice(s.indexOf("const onVisible"), s.indexOf("document.addEventListener(\"visibilitychange\""));
  assert.ok(vis.indexOf("rerender()") > -1 && vis.indexOf("rerender()") < vis.indexOf("void start()"), "on visible: the stale verdict renders before the refresh");
  assert.match(s, /if \(!every \|\| !present\) return;\n\s+const t = window\.setInterval\(\(\) => \{ if \(staleChanged\(shown\.current\.stale, shown\.current\.facts, localNow\(\)\)\) rerender\(\); \}, STALE_TICK_MS\);/, "the tick runs only while data is on screen");
});

test("PS14 Retry now is busy-guarded: a retry joins the read in flight; the poll's own reads always run", async () => {
  const f = singleFlight();
  let calls = 0, release;
  const load = () => { calls++; return new Promise((r) => { release = r; }); };
  const a = f.retry(load), b = f.retry(load);
  assert.equal(calls, 1, "two clicks, one read");
  assert.equal(a, b, "the second click joins the first");
  assert.equal(f.busy, true);
  release("x");
  assert.equal(await a, "x");
  await Promise.resolve();
  assert.equal(f.busy, false, "done: not busy");
  f.retry(load); assert.equal(calls, 2, "a click after it settled reads again");
  release("y");
  const g = singleFlight();
  let n = 0;
  const hang = () => { n++; return new Promise(() => {}); };
  g.start(hang); g.start(hang);
  assert.equal(n, 2, "the timer and a deps change always read (a hung read never blocks the next)");
  g.retry(hang);
  assert.equal(n, 2, "but Retry now joins the hung read");
  const failing = singleFlight();
  await assert.rejects(failing.retry(() => Promise.reject(new Error("/api/x 502"))));
  await Promise.resolve();
  assert.equal(failing.busy, false, "a failed read frees the guard");

  const u = src("components/ui.tsx");
  // Re-review of #520: the button is guarded by its own click only (PS23), and refresh joins only a young read.
  assert.match(u, /const click = \(\) => \{\n\s+if \(running\) return;/, "the button ignores clicks while its own click runs");
  assert.match(u, /onClick=\{click\} disabled=\{running\}/);
  assert.match(u, /<RetryButton onRetry=\{poll\.refresh\} busy=\{pollBusy\(poll\)\} compact \/>/);
  assert.match(src("lib/usePoll.ts"), /const refresh = useCallback\(\(\) => flight\.current\.retry\(read\), \[read\]\);/, "third review: the join window, not the interval");
  const mk = src("lib/market.tsx");
  assert.match(mk, /const retry = async \(\) => \{ await Promise\.all\(ALL_PATHS\.map\(refresh\)\); \};/, "the market retry joins each path's read of the last RETRY_JOIN_MS: a double click, six requests, not twelve");
  assert.match(src("components/ThreadsPanel.tsx"), /const failure = \(path: string\) => failed\[path\] \? <PollError poll=\{pollOf\(path\)\} \/> : null;/, "a tab's error box retries its own path");
});

test("PS15 a push's arrival counts toward lastOk; it clears the error only when it arrived after the failed read was sent", () => {
  // Third review of #520: ordered by the local sequence (the failed read's send, the push's arrival), never by a clock.
  const failedRead = { error: "/api/conclusion/global 502", lastOk: now - 600_000, lastFail: now - 10_000, failSeq: 10, failures: 2 };
  assert.deepEqual(withPush(failedRead, { seq: 11, local: now - 5_000 }), { error: null, lastOk: now - 5_000, lastFail: now - 10_000, failSeq: 10, failures: 0 });
  assert.deepEqual(withPush(failedRead, { seq: 9, local: now - 20_000 }), { ...failedRead, lastOk: now - 20_000 }, "a push from before the failed read: the error stays, but its arrival still counts toward lastOk");
  assert.equal(withPush(failedRead, { seq: 10, local: now }).error, failedRead.error, "never cleared by a push that did not arrive after the failed read was sent");
  assert.equal(withPush({ ...failedRead, lastOk: now - 1_000 }, { seq: 9, local: now - 20_000 }).lastOk, now - 1_000, "lastOk never goes back");
  assert.equal(withPush(failedRead, null), failedRead);
  assert.deepEqual(withPush({ ...failedRead, error: null, failures: 0, failSeq: null }, { seq: 3, local: now }), { ...failedRead, error: null, failures: 0, failSeq: null, lastOk: now });
});
test("PS16 item 1: the Decision Engine keeps its last decision on a failed read, and never says \"No decision yet.\" then", () => {
  const mk = src("lib/market.tsx");
  // Re-review: each route keeps its own last good answer (routeSettled: a failure never touches `data`, PS9).
  const ps = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/lib/pollState.ts", import.meta.url), "utf8");
  assert.match(ps, /if \(!r\.ok\) return \{ \.\.\.s, settled: id, error: r\.error, lastFail: r\.at, failSeq: id, failures: s\.failures \+ 1 \};/, "a failed read leaves the last decision in place");
  assert.doesNotMatch(mk, /setDecisionBody\(/, "the old batch replace is gone");
  assert.match(mk, /const glob = route\(GLOBAL_PATH\)\.data as any;/, "the decision is its route's data; the rooms too");
  const gd = src("components/GlobalDecision.tsx");
  assert.match(gd, /const poll = pollOf\(GLOBAL_PATH\);/);
  assert.match(gd, /poll=\{poll\} staleOpen/, "the stale tag with its detail open: the age, the last good read, the route and code, Retry now");
  const body = gd.slice(gd.indexOf("{phase === \"error\" || (none && poll.error != null)"));
  assert.ok(body.length > 0, "the error check is the first branch of the body");
  assert.ok(body.indexOf("<PollError poll={poll} />") < body.indexOf("No decision yet."), "the error box comes before \"No decision yet.\"");
  assert.equal((gd.match(/>No decision yet\.</g) ?? []).length, 1, "one place says it");
  assert.doesNotMatch(gd, /loading && !g && !e \? <Skeleton rows=\{5\} \/> : !g && !e \?/, "the old chain read a 502 as no decision");
});

test("PS17 item 2: Workers and lanes never says \"all nominal\" while /api/status failed or is stale", () => {
  const nominal = { bad: 0, warn: 0, status: "live", lane: "live" };
  assert.deepEqual(overviewBadge(nominal), { tone: "green", text: "all nominal" });
  assert.deepEqual(overviewBadge({ ...nominal, status: "error" }), { tone: "red", text: "status unknown" }, "/api/status 502, /api/local-lane ok");
  assert.deepEqual(overviewBadge({ ...nominal, status: "stale" }), { tone: "amber", text: "status stale" }, "3 × the interval of 502s with data on screen");
  assert.deepEqual(overviewBadge({ ...nominal, lane: "stale" }), { tone: "amber", text: "lane stale" });
  assert.deepEqual(overviewBadge({ ...nominal, lane: "error" }), { tone: "red", text: "lane unknown" });
  assert.deepEqual(overviewBadge({ ...nominal, status: "loading" }), { tone: "slate", text: "checking" });
  assert.deepEqual(overviewBadge({ ...nominal, bad: 2, status: "error" }), { tone: "red", text: "2 down" });
  assert.deepEqual(overviewBadge({ ...nominal, warn: 1, status: "stale" }), { tone: "amber", text: "1 need attention · stale" });
  for (const status of ["error", "stale", "loading", "idle"]) for (const lane of ["live", "error", "stale"]) {
    assert.notEqual(overviewBadge({ bad: 0, warn: 0, status, lane }).text, "all nominal", `${status}/${lane}`);
  }
  const st = src("pages/Status.tsx");
  assert.doesNotMatch(st, /"all nominal"/, "the page has no nominal text of its own");
  assert.match(st, /const badge = overviewBadge\(\{ bad, warn, status: statusPhase, lane: lanePhase \}\);/);
  assert.match(st, /\{statusPhase === "error" \? <div className="mb-2"><PollError poll=\{poll\} \/><\/div> : null\}/, "the status error box above the lane's rows, which stay");
  assert.doesNotMatch(st, /phaseOf\(poll\) === "error" && !items\.length/, "the old check hid the error when the lane answered");
  assert.match(st, /poll=\{poll\} live right=\{<Badge tone=\{badge\.tone\}>\{badge\.text\}<\/Badge>\}/, "the panel carries the status poll's tag");
  assert.match(src("components/SystemIssues.tsx"), /phase === "error" \|\| phase === "stale"/, "the War Room's issue panel says so too");
});

test("PS18 item 4: a failed read never reads as \"nothing yet\"", () => {
  const tp = src("components/ThreadsPanel.tsx");
  const m15 = tp.slice(tp.indexOf("if (tab === \"M15\") {"), tp.indexOf("if (loading) return <Skeleton rows={6} />;"));
  assert.ok(m15.indexOf("<PollError poll={roomPoll} />") > -1 && m15.indexOf("<PollError poll={roomPoll} />") < m15.indexOf("No War Room yet."), "15m: the error box before \"No War Room yet.\"");
  const ro = src("components/Roster.tsx");
  assert.match(ro, /readError \? <ErrorLine error=\{readError\} \/> : <p className="text-\[12px\] text-slate-500">No conclusion yet\.<\/p>/);
  assert.match(ro, /readError \? <ErrorLine error=\{readError\} \/> : <p className="text-\[12px\] text-slate-500">No session yet\.<\/p>/);
  const co = src("pages/Councils.tsx");
  assert.match(co, /if \(!s\) return poll\.error != null \? <PollError poll=\{poll\} \/> : <Empty>Session not found\.<\/Empty>;/);
  assert.match(co, /phase === "error" \|\| \(!d && poll\.error != null\) \? <PollError poll=\{poll\} \/> : phase === "loading" \? <Skeleton rows=\{2\} \/> : <Empty>No session yet\.<\/Empty>/);
  const sh = src("pages/Shadow.tsx");
  assert.match(sh, /const kpi = \(n: number\) => \(known \? n : "—"\);/);
  for (const k of ["totalCandidates", "promotionReadyCount", "collectingCount", "totalBarsEvaluated"]) assert.match(sh, new RegExp(`\\{kpi\\(${k}\\)\\}`), k);
  assert.match(sh, /\{!known \? "—" : promotionReadyCount \? "p < 0\.05 \+ holdout" : "None yet"\}/);
  const mo = src("pages/Model.tsx");
  assert.match(mo, /failed\.baseline \? \{ state: "—", tone: "fault", error: failed\.baseline \} : \{ state: promoted \?/, "Validate: \"—\", not \"not yet\"");
  assert.match(mo, /failed\.baseline \|\| failed\.tuning \? \{ state: "—", tone: "fault"/, "Apply: \"—\", not \"shadow only\"");
  assert.match(mo, /\(err \? `\$\{name\} error` : model\?\.model_id \? `\$\{name\} ok` : `no \$\{name\}`\)/, "Learn: \"baseline error\", never \"baseline —\" from a failed read");
  assert.doesNotMatch(mo, /"baseline —"/);
});

test("PS19 item 5: the stale/live tag on Status, Shadow, Councils, Calendar and the War Room's tabs and decision", () => {
  const st = src("pages/Status.tsx");
  for (const p of ["poll={poll} live right=", "poll={lanePoll} right=", "title=\"Parity registry\" icon={<ShieldCheck className=\"h-3.5 w-3.5 text-cyan-300\" />} poll={poll} live"]) assert.ok(st.includes(p), p);
  assert.ok(src("pages/Shadow.tsx").includes("poll={poll} live"), "Shadow");
  const co = src("pages/Councils.tsx");
  for (const p of ["poll={poll} live", "poll={sugPoll}", "poll={topic ? packPoll : undefined}", "<PollStrip poll={poll}"]) assert.ok(co.includes(p), p);
  assert.ok(src("pages/Calendar.tsx").includes("hint={hint} poll={poll} live"), "Calendar");
  const tp = src("components/ThreadsPanel.tsx");
  for (const p of ["<PollStrip poll={roomPoll} />", "<PollStrip poll={pollOf(NEWS_PATH)} />", "<PollStrip poll={pollOf(threadPath(tab))} />"]) assert.ok(tp.includes(p), p);
  assert.match(src("components/ui.tsx"), /export function PollStrip\(/);
});

// Re-review of #520: a push replay never clears a live failure; each route applies on its own; stale plan lines are
// marked; Retry now is never stuck.

test("PS20 MUST 1: the hub's replay of an old snapshot never clears a live REST failure or replaces newer data", () => {
  // The push keeps the hub's `at` and its own arrival (third review: the local sequence and the steady clock).
  const p = src("lib/push.ts");
  assert.match(p, /const arrival: PushArrival = \{ seq: nextSeq\(\), local: localNow\(\), at: pushTime\(msg\.at\), replay: isReplay\(msg\.replay, !seen\.has\(msg\.topic\)\) \};\n\s+setSnap\(\(d\) => \(\{ \.\.\.d, \[msg\.topic\]: \{ data: msg\.data, \.\.\.arrival \} \}\)\);/);
  assert.match(p, /ws\.onopen = \(\) => \{\n\s+retry = 1000;\n\s+seen = new Set\(\);/, "without the hub's flag, a replay is the first snapshot of a topic on each socket (fifth review: isReplay)");
  assert.equal(pushTime("2026-11-22T13:00:00.000Z"), Date.parse("2026-11-22T13:00:00Z"));
  assert.equal(pushTime(null), null);
  assert.equal(pushTime("not a date"), null);
  assert.equal(pushTime("2026-11-22T15:00:00Z"), Date.parse("2026-11-22T15:00:00Z"), "third review: the hub's time is never clamped to the browser's (they are different clocks)");
  const H = Date.parse("2026-11-22T13:45:00Z"); // the hub's clock
  assert.equal(PUSH_SLACK_MS, 120_000);
  assert.equal(pushApplies({ at: null, replay: false }, null), false, "a push with no time never applies");
  assert.equal(pushApplies({ at: H, replay: true }, H), false, "the replay of the snapshot already applied: kept off");
  assert.equal(pushApplies({ at: H - 1, replay: true }, H), false, "a replay older than the newest applied: kept off");
  assert.equal(pushApplies({ at: H + 1, replay: true }, H), true, "a replay of a publish missed while disconnected: may apply (then takePush checks the read)");
  assert.equal(pushApplies({ at: H - PUSH_SLACK_MS, replay: false }, H), true, "a live publish within the slack (hub clock jitter)");
  assert.equal(pushApplies({ at: H - PUSH_SLACK_MS - 1, replay: false }, H), false, "older than the data on screen by more than the slack");

  // The reproduction of c2063df, on the fourth review's clocks: the server (Cloudflare) clock T, the browser's steady
  // clock 7 minutes ahead of it (L). A good read at 13:52 answers SELL; the decision changes; /api/conclusion/global
  // 502 at 13:57 (stale 5m, "502 · 1 failed"); the socket reconnects and the hub replays its 13:45 snapshot.
  const M = 60_000, OFF = 7 * M;
  const T = (hm) => Date.parse(`2026-11-22T${hm}:00Z`), L = (hm) => T(hm) + OFF;
  const sell = { engine: { stance: "SELL" } }, old = { engine: { stance: "BUY", old: true } };
  const E = "/api/conclusion/global 502";
  let r = routeSettled(routeSent(emptyRoute, 1), 1, { ok: true, data: sell, at: L("13:52"), date: T("13:52") });
  r = routeSettled(routeSent(r, 2), 2, { ok: false, error: E, at: L("13:57"), date: T("13:57") });
  const replay = routePushed(r, old, { seq: 3, local: L("14:01"), at: T("13:45"), replay: true });
  assert.equal(replay, r, "the replay is older than the read on screen (its at against the read's Date): nothing changes");
  assert.deepEqual(routeFacts(replay, OFF), { error: E, lastOk: L("13:52"), lastFail: L("13:57"), failSeq: 2, failures: 1 });
  assert.equal(isStale({ hasData: true, ...routeFacts(replay, OFF), intervalMs: 300_000 }, L("14:02")), true, "the card stays stale");
  // A snapshot newer than the data on screen but older than the failure: shown, and still stale.
  const between = routePushed(r, old, { seq: 4, local: L("14:01"), at: T("13:54"), replay: true });
  assert.equal(between.data, old, "newer than the read on screen: shown");
  const bf = routeFacts(between, OFF);
  assert.deepEqual([bf.error, bf.lastOk, bf.lastFail, bf.failures], [E, L("13:52"), L("13:57"), 1], "but older than the failure: no cleared error, no newer lastOk");
  assert.deepEqual([bf.replayed, bf.replayAt], [true, L("13:54")], "its age is its at on the server clock, never its arrival (14:01)");
  assert.deepEqual(planMark({ hasData: true, ...bf, intervalMs: 300_000 }, L("14:02")), { show: true, dim: true, suffix: " · stale 8m", note: null });
  // Fourth review: a replay newer than the failure still never clears it (only a live push or a good read does).
  const newer = routePushed(r, old, { seq: 5, local: L("14:01"), at: T("13:59"), replay: true });
  assert.deepEqual([newer.data, routeFacts(newer, OFF).error, routeFacts(newer, OFF).lastOk], [old, E, L("13:52")]);
  // A real publish after the failure (on the local order) is a good arrival.
  const fresh = routePushed(r, old, { seq: 6, local: L("14:01"), at: T("14:01"), replay: false });
  assert.deepEqual(routeFacts(fresh, OFF), { error: null, lastOk: L("14:01"), lastFail: L("13:57"), failSeq: 2, failures: 0 });
  // Reconnect repeats: the same replay again and again never turns it live.
  let again = r;
  for (let i = 0; i < 5; i++) again = routePushed(again, old, { seq: 10 + i, local: L("14:01") + i, at: T("13:45"), replay: true });
  assert.deepEqual([again.data, routeFacts(again, OFF).error], [sell, E]);
  // A read sent before the live push on screen refreshes lastOk but never puts its older body back.
  const pushed = routePushed(routeSent(r, 21), { engine: { stance: "BUY" } }, { seq: 22, local: L("14:01"), at: T("14:01"), replay: false });
  const lateRead = routeSettled(pushed, 21, { ok: true, data: sell, at: L("14:01") + 4_000, date: T("14:01") });
  assert.deepEqual([lateRead.data.engine.stance, lateRead.lastOk, lateRead.error], ["BUY", L("14:01") + 4_000, null]);

  const mk = src("lib/market.tsx");
  assert.doesNotMatch(mk, /setPushAt\(|Date\.now\(\)/, "no push and no read stamped with the wall clock");
  assert.match(mk, /routePushed\(route\(GLOBAL_PATH\), decisionSnap\.data, decisionSnap\)/);
  assert.match(mk, /routePushed\(route\(threadPath\(c\)\), threadsSnap\.data\?\.\[c\] \?\? null, threadsSnap\)/);
  const wr = src("lib/warroom.tsx");
  assert.match(wr, /setSlots\(\(s\) => takePush\(s, readRef\.current, snap\.data, snap\) \?\? s\);/, "the War Room's 15m room too");
  assert.doesNotMatch(wr, /setPushAt\(Date\.now\(\)\)|Date\.now\(\)/);
  assert.match(src("pages/Omega.tsx"), /const pushed = push\.snap\["omega-overview"\]\?\.data;/, "Omega reads the same snapshot shape");
});
test("PS21 SHOULD 2: each route applies its own answer as it resolves; a hung sibling never holds the decision back", async () => {
  // D1's thread read hangs; /api/conclusion/global answers BUY: the decision is BUY at once, and live.
  let seq = 0;
  let d1 = routeSent(emptyRoute, ++seq);
  const first = ++seq;
  let gl = routeSettled(routeSent(emptyRoute, first), first, { ok: true, data: { engine: { stance: "SELL" } }, at: now - 399_000 });
  for (let i = 2; i <= 7; i++) {
    d1 = routeSent(d1, ++seq);
    const id = ++seq;
    gl = routeSettled(routeSent(gl, id), id, { ok: true, data: { engine: { stance: "BUY" } }, at: now - 60_000 * (8 - i) + 500 });
  }
  assert.equal(gl.data.engine.stance, "BUY", "six good answers, applied as each came");
  assert.equal(isStale({ hasData: true, ...routeFacts(gl), intervalMs: 60_000 }, now), false);
  assert.equal(d1.settled, 0, "the hung read is D1's alone");
  assert.equal(isStale({ hasData: true, ...routeFacts({ ...d1, data: {}, lastOk: now - 400_000 }), intervalMs: 60_000 }, now), true, "and D1 reads as stale");
  // An overtaken read never undoes a newer answer.
  const a = routeSent(routeSent(emptyRoute, 1), 2);
  const newer = routeSettled(a, 2, { ok: true, data: "new", at: now });
  assert.equal(routeSettled(newer, 1, { ok: true, data: "old", at: now + 1 }), newer);
  assert.equal(routeSettled(newer, 1, { ok: false, error: "/api/x 502", at: now + 1 }), newer, "nor a late failure of an older read");
  // lastOk is recorded only with that path's own answer.
  const mk = src("lib/market.tsx");
  assert.match(mk, /const settle = \(r: ReadOutcome\) => \{ routes\.current\[path\] = routeSettled\(route\(path\), id, r\); bump\(\); \};/, "each read settles its own path and renders");
  assert.doesNotMatch(mk, /Promise\.all\(\[\n?\s*\.\.\.TF_CHARTS\.map/, "no batch that waits on the slowest read");
  assert.match(mk, /useSchedule\(plan\(SLOW_PATHS\), \(due\) => \{ for \(const p of due\) void read\(p\); \}, cadenceKey\(SLOW_PATHS\), \(\) => \{ for \(const p of SLOW_PATHS\) if \(!inFlight\(p\)\) void read\(p\); \}\);/, "fifth review: each path due on its own cadence");
  assert.match(mk, /busy: s\.sent > s\.settled, refresh: \(\) => refresh\(path\)/, "busy and refresh are the path's own");
  assert.match(mk, /const id = nextSeq\(\);\n\s+routes\.current\[path\] = routeSent\(route\(path\), id\);/, "a read's id is its send on the page's one order");
  assert.match(src("lib/usePoll.ts"), /export function useSchedule\(plan: \(\) => Cadence\[\], run: \(keys: string\[\]\) => void, cadenceKey: string, onJump: \(\) => void\)/);
});
test("PS22 SHOULD 3: the chart's plan lines and zones from a stale decision are dimmed and labelled, then dropped", () => {
  const live = { hasData: true, error: null, lastOk: now - 30_000, intervalMs: 300_000 };
  assert.deepEqual(planMark(live, now), { show: true, dim: false, suffix: "", note: null });
  assert.deepEqual(planMark({ ...live, error: "/api/conclusion/global 502", lastOk: now - 3_600_000 }, now), { show: true, dim: true, suffix: " · stale 1h", note: null }, "Entry · stale 1h");
  assert.deepEqual(planMark({ ...live, lastOk: now - 11 * 60_000 }, now), { show: true, dim: true, suffix: " · stale 11m", note: null }, "no good read for 2 × the interval");
  assert.deepEqual(planMark({ ...live, error: "/api/conclusion/global 502", lastOk: now - PLAN_HIDE_MS }, now), { show: false, dim: true, suffix: "", note: "plan hidden: decision stale 2h" });
  assert.equal(planMark({ ...live, error: "x", lastOk: null }, now).show, false, "of unknown age: hidden");
  assert.equal(PLAN_HIDE_MS, 2 * 3_600_000);
  const pc = src("components/PriceChart.tsx");
  assert.match(pc, /const decisionPoll = pollOf\(GLOBAL_PATH\);/);
  assert.match(pc, /title: title \+ mark\.suffix, color: mark\.dim \? rgba\(color, STALE_LINE_ALPHA\) : color,/, "each plan line dimmed and labelled");
  assert.match(pc, /const p = showPlan && hasClearDecision && mark\.show \? strategy\?\.plan : null;/, "dropped past the threshold");
  assert.match(pc, /const candidates: any\[\] = showZones && mark\.show \?/, "the zones too");
  assert.match(pc, /\* \(mark\.dim \? 0\.5 : 1\)/);
  assert.match(pc, /\{planHidden \? <div [^>]*>\{mark\.note\}<\/div> : null\}/, "the note on the chart");
  assert.match(pc, /\}, \[strategy, showZones, showPlan, mark\.show, mark\.dim, mark\.suffix\]\);/, "redrawn when the mark changes");
});

test("PS23 SHOULD 4: Retry now is never stuck behind a hung read", async () => {
  // Third review of #520: the join window is RETRY_JOIN_MS (2–3 s), not the interval.
  assert.ok(RETRY_JOIN_MS >= 2_000 && RETRY_JOIN_MS <= 3_000, "a 2–3 s join window");
  assert.equal(joinsInFlight(null, now), false, "nothing in flight: read");
  assert.equal(joinsInFlight(now - RETRY_JOIN_MS + 1, now), true, "a read just sent: joined (a double click)");
  assert.equal(joinsInFlight(now - RETRY_JOIN_MS, now), false, "any older read: a new one");
  assert.equal(joinsInFlight(now + 5, now), false, "a time ahead of now never joins");
  let t = 0;
  const f = singleFlight(() => t);
  let n = 0;
  const hang = () => { n++; return new Promise(() => {}); };
  const first = f.retry(hang);
  assert.equal(f.retry(hang), first, "a second click within the window joins");
  assert.equal(n, 1);
  t = RETRY_JOIN_MS;
  assert.notEqual(f.retry(hang), first, "past the window the hung read is not joined");
  assert.equal(n, 2);
  const u = src("components/ui.tsx");
  const btn = u.slice(u.indexOf("export function RetryButton("), u.indexOf("/**\n * A failed read with nothing on screen"));
  assert.doesNotMatch(btn, /busy \|\| running|disabled=\{off\}|disabled=\{busy/, "a read in flight elsewhere never disables it");
  assert.match(btn, /t = window\.setTimeout\(end, RETRY_SPIN_MS\);/, "its own spin is capped");
  assert.match(u, /export const RETRY_SPIN_MS = 10_000;/);
  const mk = src("lib/market.tsx");
  assert.match(mk, /return f && joinsInFlight\(f\.since, localNow\(\)\) \? f\.p : read\(path\);/, "per path: a read just sent is joined, any older one is not");
  const api = src("lib/api.ts");
  assert.match(api, /fetch\(path, \{ headers: \{ accept: "application\/json" \}, cache \}\)/);
  assert.match(api, /return \(await fetchJson<T>\(path, cacheOf\(path, opts\)\)\)\.data;/, "no-store for the poll reads (PS29): no browser cache lock behind a hung read of the same URL");
  assert.match(api, /return fetchJson<T>\(path, "no-store"\);/, "the dated poll reads are always no-store (PS35)");
});
test("PS24 nits: a backward clock jump, Key levels' read error, System issues' lane read", () => {
  assert.equal(isStale({ ...base, lastOk: now + CLOCK_SLACK_MS }, now), false, "within the slack: live");
  assert.equal(isStale({ ...base, lastOk: now + CLOCK_SLACK_MS + 1 }, now), true, "a last good read more than 60 s in the future: the clock moved back, stale");
  assert.equal(CLOCK_SLACK_MS, 60_000);
  const kl = src("components/KeyLevels.tsx");
  assert.match(kl, /\{hasK \? <span>Zones<\/span> : readError \? <span className="[^"]*text-fault">\{readError\}<\/span> : <span>No zones<\/span>\}/, "the read error, not \"No zones\"");
  const si = src("components/SystemIssues.tsx");
  assert.match(si, /\["lane-read", "Pull adapter", lanePoll\]/, "a failed or stale /api/local-lane is listed");
  assert.match(si, /const \{ items, poll, lanePoll \} = useSystemHealth\(\);/);
});

// Third review of #520: one local monotonic order for reads and pushes; a push's arrival counts toward lastOk; Retry
// now sends a read during a hang; no-store only on the poll reads.

const MIN = 60_000;

test("PS25 (a) a push, then a failed read: the data keeps the push's age, and the plan stays shown within the threshold", () => {
  const H = Date.parse("2026-11-22T13:45:00Z");
  // The push arrives (seq 2) after a good read (seq 1); the fallback read sent after it (seq 3) answers 502 5 min later.
  let r = routeSettled(routeSent(emptyRoute, 1), 1, { ok: true, data: { engine: { stance: "SELL" } }, at: now - 20 * MIN });
  r = routePushed(r, { engine: { stance: "BUY" } }, { seq: 2, local: now - 10 * MIN, at: H, replay: false });
  r = routeSettled(routeSent(r, 3), 3, { ok: false, error: "/api/conclusion/global 502", at: now - 5 * MIN });
  const f = { hasData: true, ...routeFacts(r), intervalMs: 300_000 };
  assert.equal(r.data.engine.stance, "BUY", "the push's data stays on screen");
  assert.deepEqual([f.error, f.lastOk], ["/api/conclusion/global 502", now - 10 * MIN], "stale (the later read failed), aged from the push's arrival");
  assert.deepEqual(planMark(f, now), { show: true, dim: true, suffix: " · stale 10m", note: null }, "the plan is dimmed, never hidden");

  // The reported case: REST 502 every 5 minutes, a push every 15 minutes, for 3 hours. The card never reads older than
  // the last push and the plan is never hidden; right after each push it is live at full strength. Fourth review: the
  // first snapshot is the connect's replay, aged on the server clock (the hub's H is the browser's `now`: OFF).
  const OFF = now - H;
  let s = emptyRoute, seq = 0, maxAge = 0;
  for (let t = 0; t <= 180 * MIN; t += 30_000) {
    if (t % (15 * MIN) === 0) {
      s = routePushed(s, { engine: { stance: t % (30 * MIN) ? "BUY" : "SELL" } }, { seq: ++seq, local: now + t, at: H + t, replay: t === 0 });
      const live = { hasData: true, ...routeFacts(s, OFF), intervalMs: 300_000 };
      assert.equal(isStale(live, now + t), false, `live right after the push at ${t / MIN}m`);
      assert.equal(planMark(live, now + t).dim, false);
    }
    if (t % (5 * MIN) === 150_000) { const id = ++seq; s = routeSettled(routeSent(s, id), id, { ok: false, error: "/api/conclusion/global 502", at: now + t, date: H + t }); }
    const g = { hasData: true, ...routeFacts(s, OFF), intervalMs: 300_000 };
    maxAge = Math.max(maxAge, now + t - ageBase(g));
    assert.equal(planMark(g, now + t).show, true, `the plan stays shown at ${t / MIN}m`);
  }
  assert.ok(maxAge < 15 * MIN, `never older than the push interval (max ${maxAge / MIN}m), not "stale 2h"`);

  // On load (fourth review: the third review's claim that this replay clears the 502 is gone): the read sent at mount,
  // the hub's 1-minute-old replay, then that read answers 502 with its Date. The replay shows the data, aged 1m, and
  // the card stays in error: a replay never clears an error, whatever its age.
  let l = routeSent(emptyRoute, 1);
  l = routePushed(l, { engine: { stance: "SELL" } }, { seq: 2, local: now - 2_000, at: H - MIN, replay: true });
  assert.equal(l.data.engine.stance, "SELL", "the replay shows the data");
  // Fifth review: while the route's own first read is in flight and no Date is known, it is checking: never live,
  // no stale chip, the plan dimmed (it used to read stale on almost every normal reload).
  const lc = { hasData: true, ...routeFacts(l, null), intervalMs: 60_000 };
  assert.deepEqual([isStale(lc, now - 2_000), pollPhase({ ...lc, loading: false }, now - 2_000)], [false, "checking"], "before any Date: checking, never live");
  l = routeSettled(l, 1, { ok: false, error: "/api/conclusion/global 502", at: now, date: H });
  const lf = { hasData: true, ...routeFacts(l, OFF), intervalMs: 60_000 };
  assert.deepEqual([lf.error, lf.lastOk, lf.replayed, lf.replayAt], ["/api/conclusion/global 502", null, true, now - MIN], "still in error; no lastOk; aged 1m");
  assert.equal(pollPhase({ ...lf, loading: false }, now), "stale");
  assert.deepEqual(planMark(lf, now), { show: true, dim: true, suffix: " · stale 1m", note: null }, "the plan dimmed, aged 1m");
  // Only a live push or a good read clears it.
  const viaPush = routePushed(l, { engine: { stance: "BUY" } }, { seq: 3, local: now + 5_000, at: H + 5_000, replay: false });
  assert.deepEqual([routeFacts(viaPush, OFF).error, routeFacts(viaPush, OFF).lastOk, routeFacts(viaPush, OFF).replayed], [null, now + 5_000, undefined], "a live push: live");
  const viaRead = routeSettled(routeSent(l, 4), 4, { ok: true, data: { engine: { stance: "SELL", fresh: true } }, at: now + 6_000, date: H + 6_000 });
  assert.deepEqual([viaRead.data.engine.fresh, routeFacts(viaRead, OFF).error, routeFacts(viaRead, OFF).lastOk], [true, null, now + 6_000], "a good read: live, its data");
});

test("PS26 (b) a backward wall-clock step of 10 minutes: good reads still apply and stay live", () => {
  let wall = now, mono = 0;
  const clock = steadyClock(() => wall, () => mono);
  const tick = (ms, step = 0) => { wall += ms + step; mono += ms; return clock(); };
  assert.equal(clock(), now, "the steady clock starts on the wall clock");
  let seq = 0;
  const read = (s, data) => { const id = ++seq; return routeSettled(routeSent(s, id), id, { ok: true, data, at: clock() }); };
  let s = read(emptyRoute, { engine: { stance: "SELL" } });
  tick(30_000, -10 * MIN); // NTP or a VM resume moves the wall clock back by 10 minutes
  assert.equal(clock(), now + 30_000, "it keeps counting on the monotonic clock");
  for (let i = 0; i < 6; i++) {
    tick(60_000);
    s = read(s, { engine: { stance: "BUY" } });
    const f = { hasData: true, ...routeFacts(s), intervalMs: 60_000 };
    assert.equal(s.data.engine.stance, "BUY", `good read ${i + 1} applies`);
    assert.equal(isStale(f, clock()), false, `and is live (${i + 1})`);
    assert.deepEqual(planMark(f, clock()), { show: true, dim: false, suffix: "", note: null });
  }
  // The reads stop: the verdict still turns stale after 2 × the interval (the step froze nothing).
  tick(121_000);
  assert.equal(isStale({ hasData: true, ...routeFacts(s), intervalMs: 60_000 }, clock()), true);
  // A forward step (a sleep, where the monotonic clock may pause) counts; a slow wall follows the monotonic clock.
  const before = clock();
  wall += 8 * 3_600_000;
  assert.equal(clock(), before + 8 * 3_600_000, "after a sleep the age is the wall clock's");
  mono += 5_000; wall += 1_000;
  // Fifth review: anchored (t0 + max(w − w0, m − m0)), so after the 8 h wall step the wall leads and counts; the
  // third review's per-call maximum (before + 8 h + 5 s here) summed the two clocks' jitter.
  assert.equal(clock(), before + 8 * 3_600_000 + 1_000, "the larger elapsed time since the anchor");
  mono += 9 * 3_600_000;
  assert.equal(clock(), before + 9 * 3_600_000 + 5_000, "never slower than the monotonic clock since the anchor");
  // Shown times follow the wall clock as it reads now (wallOf); ages stay local.
  assert.equal(wallOf(now, now + 10 * MIN, now), now - 10 * MIN);
  assert.equal(wallOf(null), null);
  // The stale timer and the tag read the same clock.
  for (const f of ["lib/usePoll.ts", "lib/market.tsx", "lib/warroom.tsx", "components/ui.tsx", "components/PriceChart.tsx"]) {
    assert.doesNotMatch(src(f), /Date\.now\(\)/, `${f}: no wall-clock age`);
  }
  assert.match(src("components/PriceChart.tsx"), /intervalMs: decisionPoll\.intervalMs \};\n\s+const mark = planMark\(planFacts, localNow\(\)\);/, "the plan lines follow the local age");
  assert.match(src("components/ui.tsx"), /pollPhase\(\{[^\n]*\}, localNow\(\)\);/, "the tags too");
});

test("PS27 (c) ±5 min between the hub and the browser: fresh pushes apply at once; an old replay never clears a newer failure", () => {
  for (const skew of [5 * MIN, -5 * MIN, 30_000]) {
    const hub = (t) => t + skew; // the hub's clock against the browser's
    let seq = 0;
    let s = routeSettled(routeSent(emptyRoute, ++seq), seq, { ok: true, data: { engine: { stance: "SELL" } }, at: now });
    // A fresh publish 20 s after that fallback read: shown at once and live, whatever the skew.
    s = routePushed(s, { engine: { stance: "BUY" } }, { seq: ++seq, local: now + 20_000, at: hub(now + 20_000), replay: false });
    assert.equal(s.data.engine.stance, "BUY", `skew ${skew / 1000}s: the flip applies at once`);
    assert.equal(isStale({ hasData: true, ...routeFacts(s), intervalMs: 300_000 }, now + 21_000), false);
    // The next fallback read fails; then the socket reconnects and the hub replays the same BUY snapshot.
    const id = ++seq;
    s = routeSettled(routeSent(s, id), id, { ok: false, error: "/api/conclusion/global 502", at: now + 5 * MIN });
    const failed = s;
    s = routePushed(s, { engine: { stance: "BUY" } }, { seq: ++seq, local: now + 6 * MIN, at: hub(now + 20_000), replay: true });
    assert.equal(s, failed, `skew ${skew / 1000}s: the replay changes nothing`);
    assert.equal(routeFacts(s).error, "/api/conclusion/global 502", "the failure stands");
    // An older snapshot (replay or not) by more than the slack never applies either.
    assert.equal(routePushed(failed, { engine: { stance: "SELL" } }, { seq: ++seq, local: now + 6 * MIN, at: hub(now + 20_000 - PUSH_SLACK_MS - 1), replay: false }), failed);
    // A new publish after the failure clears it.
    s = routePushed(s, { engine: { stance: "SELL" } }, { seq: ++seq, local: now + 7 * MIN, at: hub(now + 7 * MIN), replay: false });
    assert.deepEqual([s.data.engine.stance, routeFacts(s).error, routeFacts(s).lastOk], ["SELL", null, now + 7 * MIN]);
  }
});

test("PS28 (d) Retry during a hang sends a request when the read in flight is older than the join window", () => {
  // The decision read hangs; the poll's schedule sends a read every 60 s (start: always runs), each hangs too.
  let t = 0, n = 0;
  const f = singleFlight(() => t);
  const hang = () => { n++; return new Promise(() => {}); };
  for (t = 0; t <= 120_000; t += 60_000) f.start(hang);
  assert.equal(n, 3, "three scheduled reads, all hung");
  t = 172_800; // the click measured at 172.8 s sent nothing before
  f.retry(hang);
  assert.equal(n, 4, "the click sends a request: the newest read in flight is 52.8 s old");
  // Ten clicks in 20 s (one every 2 s): one in two joins the read the previous click sent, the others send.
  n = 0;
  for (let i = 0; i < 10; i++) { t = 200_000 + i * 2_000; f.retry(hang); }
  assert.equal(n, 5, "five requests, never zero, never parallel within the window");
  assert.equal(f.busy, true);
  const mk = src("lib/market.tsx");
  assert.match(mk, /flights\.current\[path\] = \{ since: localNow\(\), p \};/, "the market's per-path flight on the same clock");
});

test("PS29 (e) OHLCV and chart reads keep the browser cache; poll and retry reads are no-store", async () => {
  const real = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (path, init) => { seen.push([path, init.cache]); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); };
    await get("/api/ohlcv?timeframe=H1&limit=400");
    await get("/api/ohlcv?timeframe=M15&limit=300", CHART_READ);
    await get("/api/hud/levels?tf=H1", CHART_READ);
    await get("/api/conclusion/global");
    await get("/api/ledger?days=30");
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(seen.map((x) => x[1]), ["default", "default", "default", "no-store", "no-store"]);
  assert.match(src("components/PriceChart.tsx"), /get<[^\n]*>\(`\/api\/ohlcv\?timeframe=\$\{tf\}&limit=400`, CHART_READ\);/, "the price chart's candles: /api/ohlcv's 30 s cache");
  assert.match(src("components/PriceChart.tsx"), /`\/api\/hud\/levels\?tf=\$\{planeTf\}`, CHART_READ\);/);
  assert.match(src("pages/Omega.tsx"), /get<\{ candles: Candle\[\] \}>\(`\/api\/ohlcv\?timeframe=\$\{tf\}&limit=300`, CHART_READ\)/, "Omega's terminal chart too");
});

test("PS30 the 15m room: a read sent before a newer push never overwrites it (the local order, not the read's end)", () => {
  assert.equal(pushShown(5, { seq: 6, local: now }), true, "the push arrived after the read was sent: the push's room");
  assert.equal(pushShown(7, { seq: 6, local: now }), false, "a read sent after the push: the read's room");
  assert.equal(pushShown(null, { seq: 6, local: now }), true, "no read's room yet: the push's");
  assert.equal(pushShown(3, null), false);
  // Fourth review: a live push still wins by the local order (pushWins), the room's read and push kept apart.
  const read = { data: "read", seq: 5, date: now };
  assert.equal(pushWins(read, { seq: 6, local: now, at: now - 3_600_000, replay: false, data: "push" }), true, "a live push arrived after the read was sent: shown, whatever its at");
  assert.equal(pushWins({ ...read, seq: 7 }, { seq: 6, local: now, at: now, replay: false, data: "push" }), false);
  const wr = src("lib/warroom.tsx");
  assert.match(wr, /const shown = shownSide\(read, slots\.pushed\);/);
  assert.match(wr, /shownFacts\(\{ error: war\.error, lastOk: war\.lastOk, lastFail: war\.lastFail, failSeq: war\.failSeq, failures: war\.failures \}, slots\.push, shown\.push, pageServer\.offset\(\), firstPending\)/);
  // Fifth review (nit 3): the market's routes age a replay through the same offset, in the stale verdict and the poll.
  const mk = src("lib/market.tsx");
  assert.match(mk, /const f = routeFacts\(route\(path\), pageServer\.offset\(\)\);\n\s+return isStale\(/, "market.tsx staleOf: routeFacts(…, pageServer.offset())");
  assert.match(mk, /const s = route\(path\);\n\s+const f = routeFacts\(s, pageServer\.offset\(\)\);/, "market.tsx pollOf: routeFacts(…, pageServer.offset())");
  const up = src("lib/usePoll.ts");
  assert.match(up, /const id = nextSeq\(\);\n\s+seq\.current = id;/, "usePoll's reads take the page's one order at their send");
  assert.match(up, /setSentSeq\(id\);/);
  assert.match(up, /setFailSeq\(id\);/);
});

// Fourth review of #520: a hub replay never clears an error or counts as fresh; replays are aged on the server clock
// through the reads' Date; a settled newer read beats a replay; a forward clock jump reads once.

const T = (hm) => Date.parse(`2026-11-22T${hm}:00Z`); // the server (Cloudflare) clock: the reads' Date and the hub's `at`
const E502 = "/api/conclusion/global 502";

/**
 * One tab of the outage: the AI Worker is down from 12:05, so the hub keeps its 12:05 decision and every read of
 * /api/conclusion/global answers 502. The tab loads at `load` (server time); its browser clock is `skew` ahead of
 * the server, each read takes `lat` ms, and the hub's replay reaches the page `replayFirst` before or after the mount
 * read settles. Returns the facts at server time `at` (a read every `every` ms).
 */
function outageTab({ load, skew = 0, lat = 300, replayFirst = true, every = 60_000, hubAt = T("12:05") }) {
  const clock = serverClock();
  const L = (t) => t + skew; // the tab's steady clock at server time t
  let s = emptyRoute, seq = 0;
  const replay = () => { s = routePushed(s, { engine: { stance: "BUY" }, setups: [{ phase: "armed" }] }, { seq: ++seq, local: L(load + 150), at: hubAt, replay: true }); };
  const failRead = (sent) => {
    const id = ++seq;
    s = routeSent(s, id);
    return () => { const date = Math.floor((sent + lat / 2) / 1000) * 1000; clock.note(date, L(sent + lat)); s = routeSettled(s, id, { ok: false, error: E502, at: L(sent + lat), date }); };
  };
  const mount = failRead(load);
  if (replayFirst) { replay(); mount(); } else { mount(); replay(); }
  return {
    at(t) {
      for (let sent = load + every; sent + lat <= t; sent += every) if (sent > (this.last ?? load)) { failRead(sent)(); this.last = sent; }
      const f = { hasData: s.data != null, ...routeFacts(s, clock.offset()), intervalMs: 300_000 };
      return { f, now: L(t), state: s, phase: pollPhase({ ...f, loading: false }, L(t)), plan: planMark(f, L(t)) };
    },
  };
}

test("PS31 (a)(b) a load during an outage with a 3-hour-old replay: error/stale and the plan hidden from the first second, never live", () => {
  // Before any read brought a Date the replay is of unknown age. Fifth review: while the route's own first read is in
  // flight it is checking (never live, no stale chip, the plan dimmed); once that read fails without a Date, stale
  // and the plan hidden.
  let s = routeSent(emptyRoute, 1);
  s = routePushed(s, { engine: { stance: "BUY" } }, { seq: 2, local: T("15:05"), at: T("12:05"), replay: true });
  const checking = { hasData: true, ...routeFacts(s, null), intervalMs: 60_000 };
  assert.deepEqual([checking.replayed, checking.replayAt, checking.checking, ageBase(checking)], [true, null, true, null]);
  assert.equal(pollPhase({ ...checking, loading: false }, T("15:05")), "checking", "never live before the read settles");
  assert.deepEqual(planMark(checking, T("15:05")), { show: true, dim: true, suffix: " · checking", note: null });
  s = routeSettled(s, 1, { ok: false, error: "/api/conclusion/global net", at: T("15:05") + 400, date: null });
  const unknown = { hasData: true, ...routeFacts(s, null), intervalMs: 60_000 };
  assert.deepEqual([unknown.replayed, unknown.replayAt, unknown.checking, ageBase(unknown)], [true, null, undefined, null]);
  assert.equal(pollPhase({ ...unknown, loading: false }, T("15:05") + 500), "stale", "the read failed without a Date: stale");
  assert.deepEqual(planMark(unknown, T("15:05") + 500), { show: false, dim: true, suffix: "", note: "plan hidden: decision stale" });
  assert.equal(staleAt(unknown), null);
  assert.match(staleTitle(unknown), /replayed by the hub · age unknown until a read answers/);

  for (const replayFirst of [true, false]) for (const skew of [0, 4 * MIN, -9 * MIN]) {
    const tab = outageTab({ load: T("15:05"), skew, replayFirst });
    for (let t = T("15:05") + 1_000; t <= T("15:35"); t += 10_000) {
      const v = tab.at(t);
      assert.equal(v.state.data.engine.stance, "BUY", "the replay's data is shown");
      assert.equal(v.f.error, E502, "the 502 is never cleared by the replay");
      assert.equal(v.f.lastOk, null, "and never becomes a last good read");
      assert.equal(v.phase, "stale", `never live (${replayFirst ? "replay first" : "read first"}, skew ${skew / MIN}m, +${(t - T("15:05")) / 1000}s)`);
      assert.equal(v.plan.show, false, "the plan hidden from the first second");
      assert.match(v.plan.note, /^plan hidden: decision stale 3h$/, "stale 3h, on the server clock");
    }
  }
  // The 15m room runs the same functions (warroom.tsx: takePush, shownSide, shownFacts).
  const clock = serverClock();
  clock.note(T("15:05"), T("15:05") + 400);
  const slots = takePush({ pushed: null, push: null, pushAt: null }, null, { room: { id: "r" } }, { seq: 2, local: T("15:05"), at: T("12:05"), replay: true });
  const shown = shownSide(null, slots.pushed);
  const wf = shownFacts({ error: "/api/war-room/latest 502", lastOk: null, lastFail: T("15:05") + 400, failSeq: 1, failures: 1 }, slots.push, shown.push, clock.offset());
  assert.deepEqual([shown.data.room.id, wf.error, wf.lastOk, slots.push], ["r", "/api/war-room/latest 502", null, null], "the room shown, in error, no lastOk, no live mark");
  assert.equal(isStale({ hasData: true, ...wf, intervalMs: 300_000 }, T("15:05") + 500), true);
  assert.equal(shortAge(T("15:05") + 500 - ageBase(wf)), "3h");
});

test("PS32 (c) a replay after a settled newer read: the read's data stays, in both arrival orders", () => {
  // Normal operation: the hub stored the 12:00 publish; the ledger moved the setup to "filled" since without
  // republishing. The reload's read (Date 12:04) answers "filled"; the replay of 12:00 says "armed".
  const published = { setups: [{ phase: "armed" }] }, current = { setups: [{ phase: "filled" }] };
  const OFF = 3 * MIN;
  const replay = (seq, at = T("12:00")) => ({ seq, local: T("12:04") + OFF + 100, at, replay: true });
  const good = (s, id, date = T("12:04")) => routeSettled(s, id, { ok: true, data: current, at: date + OFF + 300, date });
  // Replay first (the read in flight is compared when it settles), then the read.
  let a = routeSent(emptyRoute, 1);
  a = routePushed(a, published, replay(2));
  assert.equal(a.data, published, "shown while the read is in flight (of its server age)");
  a = good(a, 1);
  assert.equal(a.data, current, "replay first: the settled newer read wins");
  // The read first, then the replay.
  let b = good(routeSent(emptyRoute, 1), 1);
  const bb = routePushed(b, published, replay(2));
  assert.equal(bb, b, "read first: the replay is dropped");
  for (const s of [a, bb]) {
    const f = routeFacts(s, OFF);
    assert.deepEqual([s.data, f.error, f.lastOk, f.replayed], [current, null, T("12:04") + OFF + 300, undefined]);
    assert.equal(isStale({ hasData: true, ...f, intervalMs: 300_000 }, T("12:05") + OFF), false, "live on the read's data");
  }
  // A reconnect after a missed publish: the replay of 12:06 is newer than the read's Date: shown, in both orders.
  const missed = { setups: [{ phase: "closed" }] };
  let c = routePushed(good(routeSent(emptyRoute, 1), 1), missed, replay(2, T("12:06")));
  let d = good(routePushed(routeSent(emptyRoute, 1), missed, replay(2, T("12:06"))), 1);
  assert.deepEqual([c.data, d.data], [missed, missed]);
  assert.deepEqual([routeFacts(c, OFF).replayAt, routeFacts(d, OFF).replayAt], [T("12:06") + OFF, T("12:06") + OFF]);
  // The 1 s slack of Date's resolution: a replay published within the read's second (or the one before) wins.
  assert.equal(DATE_SLACK_MS, 1_000);
  assert.equal(pushWins({ data: 1, seq: 1, date: T("12:04") }, { ...replay(2, T("12:04") - 999), data: 2 }), true);
  assert.equal(pushWins({ data: 1, seq: 1, date: T("12:04") }, { ...replay(2, T("12:04") - 1_000), data: 2 }), false);
  // A read without a Date cannot be shown older: the replay never replaces it.
  const noDate = routeSettled(routeSent(emptyRoute, 1), 1, { ok: true, data: current, at: T("12:04"), date: null });
  assert.equal(routePushed(noDate, missed, replay(2, T("12:06"))), noDate);
  // A live push keeps the f42efc2 rule: it arrived after the read was sent, so it is shown, whatever its at.
  const live = routePushed(b, missed, { seq: 2, local: T("12:05"), at: T("12:03"), replay: false });
  assert.equal(live.data, missed);
  // The 15m room: the same rule in both orders (shownSide on every render).
  const read = { data: "read", seq: 1, date: T("12:04") };
  const early = takePush({ pushed: null, push: null, pushAt: null }, null, "replay", replay(2));
  assert.equal(shownSide(null, early.pushed).data, "replay", "before the read settles: the replay");
  assert.equal(shownSide(read, early.pushed).data, "read", "once it settles: the read");
  assert.equal(takePush({ pushed: null, push: null, pushAt: null }, read, "replay", replay(2)), null, "after it: dropped");
});

test("PS33 (b) two tabs during an outage show the same state: same inputs at different reload times, same staleness and plan", () => {
  const a = outageTab({ load: T("14:20"), skew: 2 * MIN, lat: 250 });
  const b = outageTab({ load: T("15:00"), skew: 2 * MIN, lat: 900, replayFirst: false });
  for (const t of [T("15:00") + 2_000, T("15:01"), T("15:04") + 30_000, T("15:30")]) {
    const va = a.at(t), vb = b.at(t);
    assert.deepEqual([va.phase, va.plan.show, va.plan.note], [vb.phase, vb.plan.show, vb.plan.note], `the same state at ${new Date(t).toISOString().slice(11, 19)}`);
    assert.equal(shortAge(va.now - ageBase(va.f)), shortAge(vb.now - ageBase(vb.f)), "the same age");
    assert.ok(Math.abs(ageBase(va.f) - ageBase(vb.f)) <= 1_000, "within Date's 1 s");
    assert.equal(va.phase, "stale");
  }
  // The third review's arrival ageing gave the tab loaded at 15:00 a "live" card for five minutes; the server clock does not.
  assert.notEqual(b.at(T("15:00") + 5_000).phase, "live");
});

test("PS34 nit: a forward clock jump (NTP step, wake from sleep) triggers one read; normal ticks and a backward step none", () => {
  let wall = now, mono = 0;
  const steady = steadyClock(() => wall, () => mono);
  const jumped = clockJump(steady, () => mono);
  const interval = 300_000;
  let reads = 0, busy = false;
  const tick = (ms, step = 0, sleep = false) => {
    wall += ms + step; if (!sleep) mono += ms;
    if (jumped(interval) && !busy) { reads++; busy = true; } // single-flight: none while one is in flight
  };
  for (let i = 0; i < 30; i++) tick(STALE_TICK_MS);
  assert.equal(reads, 0, "ten minutes of ticks: no read");
  tick(STALE_TICK_MS, 16 * MIN);
  assert.equal(reads, 1, "a 16-minute forward step: one read at once");
  tick(STALE_TICK_MS, 16 * MIN);
  assert.equal(reads, 1, "single-flight: none while that read is in flight");
  busy = false;
  for (let i = 0; i < 10; i++) tick(STALE_TICK_MS);
  assert.equal(reads, 1, "and none after");
  tick(STALE_TICK_MS, -30 * MIN);
  assert.equal(reads, 1, "a backward step: no read (the steady clock follows the monotonic one)");
  tick(8 * 3_600_000, 0, true);
  assert.equal(reads, 2, "a wake from an 8-hour sleep (the monotonic clock paused): one read");
  tick(STALE_TICK_MS, interval - STALE_TICK_MS);
  assert.equal(reads, 2, "a step within the interval is not a jump");
  // Fifth review (nit 3): the War Room's 10 s cadence is shorter than the 20 s tick: normal ticks must still read
  // nothing (the steady clock's progress less the monotonic one's, never the steady progress alone).
  const fast = clockJump(steady, () => mono);
  let fastReads = 0;
  for (let i = 0; i < 30; i++) { wall += STALE_TICK_MS; mono += STALE_TICK_MS; if (fast(10_000)) fastReads++; }
  assert.equal(fastReads, 0, "10 s interval, ten minutes of 20 s ticks: no read");
  wall += STALE_TICK_MS + 11_000; mono += STALE_TICK_MS;
  assert.equal(fast(10_000), true, "an 11 s forward step on it is a jump");
  const up = src("lib/usePoll.ts");
  assert.match(up, /const t = window\.setInterval\(\(\) => \{ if \(jump\.current\?\.\(every\) && !flight\.current\.busy && document\.visibilityState === "visible"\) void start\(\); \}, STALE_TICK_MS\);/, "usePoll: one read, never while one is in flight");
  assert.match(up, /if \(every\.length && jump\.current\?\.\(Math\.min\(\.\.\.every\)\) && document\.visibilityState === "visible"\) jumpRef\.current\(\);/, "useSchedule runs its onJump");
  const mk = src("lib/market.tsx");
  assert.match(mk, /const inFlight = \(p: string\) => route\(p\)\.sent > route\(p\)\.settled;/);
  assert.match(mk, /cadenceKey\(FAST_PATHS\), \(\) => \{ for \(const p of FAST_PATHS\) if \(!inFlight\(p\)\) void read\(p\); \}\);/, "market.tsx's two schedules, a path in flight skipped");
});

test("PS35 (b) the server clock: the reads' Date, same-origin and no-store only; a null Date keeps a replay non-live, live pushes still live", async () => {
  // The offset: (local settle) − Date, the minimum of the last OFFSET_SAMPLES reads (the least latency).
  const c = serverClock();
  assert.equal(c.offset(), null, "no read yet: unknown");
  c.note(null, now);
  assert.equal(c.offset(), null, "a response without Date notes nothing");
  c.note(T("14:00"), T("14:00") + 5 * MIN + 900);
  c.note(T("14:01"), T("14:01") + 5 * MIN + 200);
  c.note(T("14:02"), T("14:02") + 5 * MIN + 4_000);
  assert.equal(c.offset(), 5 * MIN + 200);
  for (let i = 0; i < OFFSET_SAMPLES; i++) c.note(T("14:10") + i * 1000, T("14:10") + i * 1000 + 5 * MIN + 600);
  assert.equal(c.offset(), 5 * MIN + 600, "only the last few reads count (a clock step ages out)");
  assert.equal(replayLocal(T("12:05"), 5 * MIN), T("12:10"));
  assert.equal(replayLocal(T("12:05"), null), null);
  assert.equal(replayLocal(null, 0), null);

  // getDated: the Date of a good and of a failed read, always no-store, same-origin only.
  const real = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (path, init) => {
      seen.push([path, init.cache]);
      const headers = { "content-type": "application/json" };
      if (!String(path).includes("nodate")) headers.date = "Sun, 22 Nov 2026 14:20:07 GMT";
      return new Response(path.includes("fail") ? "{}" : JSON.stringify({ ok: 1 }), { status: path.includes("fail") ? 502 : 200, headers });
    };
    assert.deepEqual(await getDated("/api/conclusion/global"), { data: { ok: 1 }, date: Date.parse("2026-11-22T14:20:07Z") });
    assert.deepEqual(await getDated("/api/war-room/latest?nodate=1"), { data: { ok: 1 }, date: null });
    await assert.rejects(getDated("/api/fail"), (e) => e instanceof ApiError && e.status === 502 && e.date === Date.parse("2026-11-22T14:20:07Z"), "a 502 carries its Date");
    // Fifth review (nit 4): a tab, CR or LF the URL parser drops ("/\t/evil.example/x" is "//evil.example/x" in a
    // browser), a backslash, a missing leading slash and a scheme are never same-origin.
    for (const bad of ["https://other.example/api/x", "//other.example/api/x", "api/x", "/\\other", "/\t/evil.example/x", "/\n/evil.example/x", "/\r/evil.example/x", "/\\/evil.example/x", "/api/x\u0000", "\t/api/x", " /api/x", "javascript:alert(1)"]) {
      assert.equal(sameOrigin(bad), false, JSON.stringify(bad));
      await assert.rejects(getDated(bad), { message: /cross_origin/ }, `${JSON.stringify(bad)}: never read for its Date`);
    }
    // Fifth review (nit 3): a chart read with a dated answer leaves the page's server clock as it was.
    const offset = pageServer.offset();
    assert.equal(await get("/api/ohlcv?timeframe=H1&limit=10", CHART_READ).then(() => "ok"), "ok");
    assert.equal(pageServer.offset(), offset, "a CHART_READ never notes its Date");
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(seen.map((x) => x[1]), ["no-store", "no-store", "no-store", "default"], "dated reads always no-store; no cross-origin request was sent");
  assert.deepEqual(["/api/conclusion/global", "/api/war-room/latest", "/api/threads/timeframe?chart=H1", "/api/x?q=a%09b"].map(sameOrigin), [true, true, true, true]);
  assert.equal(typeof location, "undefined", "under node the safe base resolves the paths");
  assert.match(src("lib/api.ts"), /return new URL\(path, here\)\.origin === new URL\(here\)\.origin;/);

  // Only the no-store poll and retry reads note the Date: readDated in usePoll.ts; never a chart or cached read.
  const up = src("lib/usePoll.ts");
  assert.match(up, /return getDated<T>\(path\)\.then\(\n\s+\(r\) => \{ pageServer\.note\(r\.date, localNow\(\)\); return r; \},\n\s+\(e\) => \{ if \(e instanceof ApiError\) pageServer\.note\(e\.date, localNow\(\)\); throw e; \},/);
  for (const f of ["lib/market.tsx", "lib/warroom.tsx", "components/PriceChart.tsx", "pages/Omega.tsx", "lib/api.ts", "lib/push.ts"]) {
    assert.doesNotMatch(src(f), /pageServer\.note\(/, `${f}: notes no Date of its own`);
  }
  assert.match(src("lib/market.tsx"), /const p = readDated\(path\)\.then\(/, "the decision and the rooms: dated, no-store");
  assert.match(src("lib/warroom.tsx"), /usePoll\(\(\) => readDated\(WAR_ROOM_PATH\),/, "the 15m room: dated, no-store");
  assert.match(src("lib/market.tsx"), /export const GLOBAL_PATH = "\/api\/conclusion\/global";\nexport const threadPath = \(c: TfChart\) => `\/api\/threads\/timeframe\?chart=\$\{c\}`;/, "same-origin paths");
  assert.match(src("lib/warroom.tsx"), /export const WAR_ROOM_PATH = "\/api\/war-room\/latest";/);
  assert.doesNotMatch(src("components/PriceChart.tsx"), /readDated|getDated/, "the chart's reads keep the browser cache and never age a replay");

  // With no Date at all (a proxy that strips it, every read "net"): the replay stays non-live, a live push still lives.
  let s = routeSent(emptyRoute, 1);
  s = routeSettled(s, 1, { ok: false, error: "/api/conclusion/global net", at: now - 2_000, date: null });
  s = routePushed(s, { engine: { stance: "BUY" } }, { seq: 2, local: now - 1_000, at: T("12:05"), replay: true });
  const rf = { hasData: true, ...routeFacts(s, null), intervalMs: 60_000 }; // no Date known on this page
  assert.deepEqual([rf.replayed, rf.replayAt, pollPhase({ ...rf, loading: false }, now)], [true, null, "stale"]);
  assert.equal(planMark(rf, now).show, false);
  const good = routeSettled(routeSent(s, 3), 3, { ok: true, data: { engine: { stance: "SELL" } }, at: now, date: null });
  assert.equal(good.data.engine.stance, "SELL", "a good read without Date beats the replay");
  assert.equal(routePushed(good, { engine: { stance: "BUY" } }, { seq: 4, local: now, at: T("12:06"), replay: true }), good, "and no later replay replaces it");
  const lp = routePushed(s, { engine: { stance: "SELL" } }, { seq: 5, local: now, at: T("14:00"), replay: false });
  const lf = { hasData: true, ...routeFacts(lp, null), intervalMs: 60_000 };
  assert.deepEqual([lp.data.engine.stance, lf.error, lf.lastOk, lf.replayed, pollPhase({ ...lf, loading: false }, now)], ["SELL", null, now, undefined, "live"], "a live push without any Date: live, as before");
});

// Fifth review of #520: an errored route stays on the fast cadence and reads when the push turns live; interval changes
// keep the phase; no stale flash while the first read is in flight; hardening.

/**
 * One route on a schedule, second by second, as usePoll and market.tsx's useSchedule run it (dueReads): `cadence(t)`
 * is the cadence in force at t, `answer(t)` what a read sent at t brings ("ok" or "502"; it settles at once). Returns
 * the send times and, per second, whether the route is errored.
 */
function scheduleRun({ until, cadence, answer, kicks = () => false }) {
  let lastSend = null, errored = false;
  const sends = [], erroredAt = [];
  const send = (t) => { lastSend = t; sends.push(t); errored = answer(t) !== "ok"; };
  send(0); // the mount read
  for (let t = 1_000; t <= until; t += 1_000) {
    if (kicks(t) && errored) send(t); // recoveryReads: the push turned live, or a replay arrived
    else if (dueReads([{ key: "r", lastSend, every: cadence(t, errored) }], t).due.length) send(t);
    erroredAt.push([t, errored]);
  }
  return { sends, erroredAt };
}

test("PS36 should_fix (a): an errored route stays on the fast cadence; it reads once when the push turns live or a replay arrives", () => {
  assert.equal(cadenceOf(true, 300_000, 60_000), 60_000, "a 5-minute fallback route, errored: 60 s");
  assert.equal(cadenceOf(false, 300_000, 60_000), 300_000, "good again: back to the fallback");
  assert.equal(cadenceOf(true, 10_000, 10_000), 10_000);
  assert.equal(cadenceOf(true, 0, 60_000), 0, "a poll that never refreshes stays so");
  // A transient 502 at 5:00 with the push live; the server is back at 5:10. The fallback read used to come at 10:00
  // (the card stale with the plan dimmed for about 5 minutes); now at 6:00.
  const back = 310_000;
  const run = scheduleRun({ until: 900_000, cadence: (t, e) => cadenceOf(e, 300_000, 60_000), answer: (t) => (t === 300_000 || t < back && t >= 300_000 ? "502" : "ok") });
  assert.deepEqual(run.sends.slice(0, 4), [0, 300_000, 360_000, 660_000], "fast while errored, the fallback cadence again once good");
  const recovered = run.erroredAt.find(([t, e]) => t > 300_000 && !e)[0];
  assert.ok(recovered - back <= 60_000, `recovered ${(recovered - back) / 1000}s after the server is back (within the fast cadence)`);
  // The same, with the hub's replay on a reconnect at 5:20: the errored route reads at once.
  const kicked = scheduleRun({ until: 900_000, cadence: (t, e) => cadenceOf(e, 300_000, 60_000), answer: (t) => (t >= 300_000 && t < back ? "502" : "ok"), kicks: (t) => t === 320_000 });
  assert.deepEqual(kicked.sends.slice(0, 3), [0, 300_000, 320_000], "the replay's read at 5:20");
  // An offline start: every read "net" until the Wi-Fi is back at 2:03, when the socket connects and turns live.
  const online = 123_000;
  const offline = scheduleRun({ until: 400_000, cadence: (t, e) => cadenceOf(e, t >= online ? 300_000 : 60_000, 60_000), answer: (t) => (t < online ? "net" : "ok"), kicks: (t) => t === online });
  assert.ok(offline.sends.includes(online), "a read the second the push turns live");
  assert.equal(offline.erroredAt.find(([t]) => t === online)[1], false, "live at once, not 5 minutes later");

  // Which routes read: the errored ones, never one in flight (single-flight).
  assert.deepEqual([turnedLive(false, true), turnedLive(true, true), turnedLive(true, false), turnedLive(false, false)], [true, false, false, false]);
  const err = new Set(["/api/conclusion/global", "/api/threads/timeframe?chart=D1", "/api/news/daily"]);
  const flying = new Set(["/api/threads/timeframe?chart=D1"]);
  assert.deepEqual(recoveryReads(["/api/conclusion/global", "/api/threads/timeframe?chart=D1", "/api/threads/timeframe?chart=H1", "/api/news/daily"], (p) => err.has(p), (p) => flying.has(p)), ["/api/conclusion/global", "/api/news/daily"]);

  const mk = src("lib/market.tsx");
  assert.match(mk, /const intervalOf = \(path: string\) => cadenceOf\(route\(path\)\.error != null, FAST_PATHS\.includes\(path\) \? POLL_MS : slowMs, POLL_MS\);/, "market: 60 s while errored");
  assert.match(mk, /if \(threadsSnap\.replay\) for \(const p of recoveryReads\(TF_CHARTS\.map\(threadPath\), errored, inFlight\)\) void read\(p\);/, "a rooms replay reads the errored rooms");
  assert.match(mk, /if \(decisionSnap\.replay\) for \(const p of recoveryReads\(\[GLOBAL_PATH\], errored, inFlight\)\) void read\(p\);/, "a decision replay reads an errored decision");
  assert.match(mk, /if \(turnedLive\(wasLive\.current, push\.live\)\) for \(const p of recoveryReads\(ALL_PATHS, errored, inFlight\)\) void read\(p\);\n\s+wasLive\.current = push\.live;/, "push turning live reads every errored route");
  const wr = src("lib/warroom.tsx");
  assert.match(wr, /usePoll\(\(\) => readDated\(WAR_ROOM_PATH\), push\.live \? POLL_LIVE_MS : POLL_MS, \[\], POLL_MS\);/, "the 15m room: 10 s while errored");
  assert.match(wr, /if \(snap\.replay\) recover\.current\(\);/);
  assert.match(wr, /if \(turnedLive\(wasLive\.current, push\.live\)\) recover\.current\(\);/);
  assert.match(wr, /if \(recoveryReads\(\[WAR_ROOM_PATH\], \(\) => war\.error != null, \(\) => !!war\.busy\)\.length\) war\.nudge\(\);/);
  const up = src("lib/usePoll.ts");
  assert.match(up, /const every = cadenceOf\(error != null, intervalMs, errorMs\);/);
  assert.match(up, /const nudge = useCallback\(\(\) => \{ if \(!flight\.current\.busy\) void start\(\); \}, \[start\]\);/, "nudge is single-flight");
});

test("PS37 should_fix (b): a cadence change keeps the phase (max(now, lastSend + new interval)); a socket flapping every 1–4 min still gets its fallback reads", () => {
  // The next read at max(now, lastSend + interval), whatever the interval was when the last read was sent.
  assert.deepEqual(dueReads([{ key: "a", lastSend: 0, every: 300_000 }], 50_000), { due: [], waitMs: 250_000 }, "60 s → 5 min at 0:50: the next read at 5:00, not 5:50");
  assert.deepEqual(dueReads([{ key: "a", lastSend: 0, every: 60_000 }], 100_000), { due: ["a"], waitMs: 60_000 }, "5 min → 60 s at 1:40: overdue, read now");
  assert.deepEqual(dueReads([{ key: "a", lastSend: 0, every: 60_000 }], 30_000), { due: [], waitMs: 30_000 }, "5 min → 60 s at 0:30: at 1:00, not 1:30");
  assert.deepEqual(dueReads([{ key: "a", lastSend: null, every: 60_000 }], 5), { due: ["a"], waitMs: 60_000 }, "never sent: now");
  assert.deepEqual(dueReads([{ key: "a", lastSend: 0, every: 60_000 }], 90_000, false), { due: [], waitMs: 60_000 }, "hidden: nothing read, checked a cadence later");
  assert.deepEqual(dueReads([{ key: "a", lastSend: 0, every: 0 }], 90_000), { due: [], waitMs: null }, "no cadence: no timer");
  assert.deepEqual(dueReads([{ key: "a", lastSend: 0, every: 300_000 }, { key: "b", lastSend: 20_000, every: 60_000 }, { key: "c", lastSend: 0, every: 60_000 }], 70_000), { due: ["c"], waitMs: 10_000 }, "per route: c now, b at 1:20");

  // The socket flaps: open 1–4 min (the fallback every 5 min), closed 5 s (every 60 s). The old schedule restarted
  // its interval on each change and so never fired; this one reads at least every 5 minutes.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const flips = [];
  for (let t = 0; t < 3 * 3_600_000;) { const up = 60_000 + Math.floor(rnd() * 180_000); flips.push([t, true], [t + up, false]); t += up + 5_000; }
  const liveAt = (t) => { let v = false; for (const [at, on] of flips) { if (at > t) break; v = on; } return v; };
  const cadence = (t) => (liveAt(t) ? 300_000 : 60_000);
  const now = scheduleRun({ until: 3 * 3_600_000, cadence, answer: () => "ok" }).sends;
  const gaps = now.slice(1).map((t, i) => t - now[i]);
  assert.ok(now.length > 30, `${now.length} fallback reads in 3 h`);
  assert.ok(Math.max(...gaps) <= 300_000, `the longest gap ${Math.max(...gaps) / 1000}s ≤ 5 min`);
  // The old schedule, for the record: setInterval restarted at each cadence change.
  let start = 0, every = cadence(0), old = 0;
  for (let t = 1_000; t <= 3 * 3_600_000; t += 1_000) {
    const e = cadence(t);
    if (e !== every) { every = e; start = t; } else if ((t - start) % every === 0) old++;
  }
  assert.equal(old, 0, "the restarted interval: no fallback read in 3 hours");

  const up = src("lib/usePoll.ts");
  assert.match(up, /const r = dueReads\(plan\(\), localNow\(\), document\.visibilityState === "visible"\);\n\s+if \(r\.due\.length\) void start\(\);\n\s+if \(r\.waitMs != null\) arm\(r\.waitMs\);/, "usePoll: a timeout chain on dueReads");
  assert.match(up, /lastSend\.current = localNow\(\);/, "every read is the send the phase counts from");
  assert.doesNotMatch(up.slice(up.indexOf("export function usePoll"), up.indexOf("export function useSchedule")), /setInterval\(\(\) => \{ if \(document\.visibilityState === "visible"\) void start\(\); \}, intervalMs\)/, "no interval restarted with the cadence");
  assert.match(up, /const r = dueReads\(planRef\.current\(\), localNow\(\), document\.visibilityState === "visible"\);\n\s+if \(r\.due\.length\) runRef\.current\(r\.due\);/, "useSchedule too");
  assert.match(src("lib/market.tsx"), /sentAt\.current\[path\] = localNow\(\);/, "market: each path's last send");
});

test("PS38 nit 1: a replay that lands before the first dated read settles is \"checking\": no stale chip, the plan dimmed, then live", () => {
  const OFF = 3 * MIN;
  let s = routeSent(emptyRoute, 1);
  assert.equal(firstPending(s), true);
  s = routePushed(s, { engine: { stance: "SELL" } }, { seq: 2, local: T("12:04") + OFF, at: T("12:00"), replay: true });
  const f = { hasData: true, ...routeFacts(s, null), intervalMs: 300_000 };
  assert.deepEqual([f.checking, isChecking(f), isStale(f, T("12:04") + OFF), pollPhase({ ...f, loading: false }, T("12:04") + OFF)], [true, true, false, "checking"]);
  assert.deepEqual(planMark(f, T("12:04") + OFF), { show: true, dim: true, suffix: " · checking", note: null }, "dimmed, not dropped");
  assert.equal(staleAt(f), null);
  // The read settles with its Date: the read's data, live, at full strength.
  const good = routeSettled(s, 1, { ok: true, data: { engine: { stance: "SELL", fresh: true } }, at: T("12:04") + OFF + 300, date: T("12:04") });
  const g = { hasData: true, ...routeFacts(good, OFF), intervalMs: 300_000 };
  assert.deepEqual([firstPending(good), g.checking, pollPhase({ ...g, loading: false }, T("12:05") + OFF), planMark(g, T("12:05") + OFF).dim], [false, undefined, "live", false]);
  // A read in flight with the Date already known (another route answered): aged at once, never checking.
  const known = { hasData: true, ...routeFacts(s, OFF), intervalMs: 300_000 };
  assert.deepEqual([known.checking, known.replayAt, pollPhase({ ...known, loading: false }, T("12:04") + OFF)], [undefined, T("12:00") + OFF, "live"]);
  // The outage case is unchanged: a failed read (with its Date), then a 3 h replay: stale and hidden.
  let o = routeSettled(routeSent(emptyRoute, 1), 1, { ok: false, error: E502, at: T("15:05") + OFF, date: T("15:05") });
  o = routePushed(o, { engine: { stance: "BUY" } }, { seq: 2, local: T("15:05") + OFF + 100, at: T("12:05"), replay: true });
  const of = { hasData: true, ...routeFacts(o, OFF), intervalMs: 300_000 };
  assert.deepEqual([of.checking, pollPhase({ ...of, loading: false }, T("15:06") + OFF), planMark(of, T("15:06") + OFF).note], [undefined, "stale", "plan hidden: decision stale 3h"]);
  // A later read in flight (not the first) never makes it checking.
  assert.equal(routeFacts(routeSent(o, 3), null).checking, undefined);
  // The 15m room: the same through shownFacts' firstPending.
  const slots = takePush({ pushed: null, push: null, pushAt: null }, null, { room: { id: "r" } }, { seq: 2, local: 1, at: T("12:00"), replay: true });
  assert.equal(shownFacts({ error: null, lastOk: null, lastFail: null, failSeq: null, failures: 0 }, null, slots.pushed, null, true).checking, true);
  assert.equal(shownFacts({ error: null, lastOk: null, lastFail: null, failSeq: null, failures: 0 }, null, slots.pushed, null, false).checking, undefined);
  assert.match(src("lib/warroom.tsx"), /const firstPending = war\.loading && war\.lastOk == null && war\.lastFail == null;/);
  const u = src("components/ui.tsx");
  assert.match(u, /if \(phase === "checking"\) \{\n[^\n]*\n\s+return <span [^>]*><Dot tone="plain" \/>checking<\/span>;/, "a muted \"checking\", not the amber stale chip");
  assert.match(u, /replayed: poll\.replayed, replayAt: poll\.replayAt, checking: poll\.checking \}, localNow\(\)\);/);
  assert.match(src("lib/market.tsx"), /checking: f\.checking \?\? false,/);
  assert.match(src("components/PriceChart.tsx"), /checking: decisionPoll\.checking,/);
});

test("PS39 nit 2: the hub's replay flag is used when it is a boolean; else the first message on the socket", () => {
  assert.deepEqual([isReplay(true, false), isReplay(false, true), isReplay(true, true), isReplay(false, false)], [true, false, true, false], "the hub's flag wins");
  assert.deepEqual([isReplay(undefined, true), isReplay(undefined, false), isReplay("true", false), isReplay(null, true)], [true, false, false, true], "absent (an older hub): the first message per socket");
  // With the flag, a topic's first live publish (nothing stored at connect) is a live push: it clears the error.
  let r = routeSettled(routeSent(emptyRoute, 1), 1, { ok: false, error: E502, at: now, date: now });
  r = routePushed(r, { engine: { stance: "BUY" } }, { seq: 2, local: now + 1_000, at: now + 1_000, replay: isReplay(false, true) });
  assert.deepEqual([routeFacts(r, 0).error, routeFacts(r, 0).lastOk], [null, now + 1_000]);
  const p = src("lib/push.ts");
  assert.match(p, /the hub marks its connect sends `replay: true`/, "the comment names the hub's side");
});

test("PS40 nit 5: the clock-jump detector keeps its baselines across interval changes (a wake with the socket dropped)", () => {
  let wall = now, mono = 0;
  const steady = steadyClock(() => wall, () => mono);
  const kept = clockJump(steady, () => mono);
  for (let i = 0; i < 5; i++) { wall += STALE_TICK_MS; mono += STALE_TICK_MS; kept(300_000); }
  // An 8 h sleep (the monotonic clock paused); on wake the socket drops, so the interval turns 300 s → 10 s before
  // the first 20 s tick. A detector re-created then takes its baselines after the jump and sees nothing.
  wall += 8 * 3_600_000;
  const recreated = clockJump(steady, () => mono);
  wall += STALE_TICK_MS; mono += STALE_TICK_MS;
  assert.equal(recreated(10_000), false, "re-created with the interval: the wake is missed");
  assert.equal(kept(10_000), true, "kept: the wake reads at once");
  assert.equal(kept(10_000), false, "once");
  const up = src("lib/usePoll.ts");
  assert.equal((up.match(/if \(jump\.current == null\) jump\.current = clockJump\(\);/g) ?? []).length, 2, "usePoll and useSchedule: one detector for their life (a ref)");
  assert.doesNotMatch(up, /const jumped = clockJump\(\);/, "never re-created in an effect");
  const sched = up.slice(up.indexOf("export function useSchedule"));
  assert.match(sched, /return \(\) => window\.clearInterval\(t\);\n\s+\}, \[\]\);/, "the schedule's jump tick is not re-armed with the cadence");
});

test("PS41 nit 6: the chart's plan mark runs on the card's 1 s clock and renders only when it changes", () => {
  assert.equal(PLAN_TICK_MS, 1_000);
  // After a wake with the socket open, an 8 h old plan: the mark turns at the next 1 s tick, not up to 20-30 s later.
  const f = { hasData: true, error: null, lastOk: now - 30_000, intervalMs: 300_000 };
  assert.equal(markKey(planMark(f, now)), "true|false||");
  assert.notEqual(markKey(planMark(f, now + 8 * 3_600_000)), markKey(planMark(f, now)), "the wake changes the mark: one render");
  assert.equal(markKey(planMark(f, now + 1_000)), markKey(planMark(f, now)), "an ordinary second: no render");
  const pc = src("components/PriceChart.tsx");
  assert.match(pc, /const t = window\.setInterval\(\(\) => \{ if \(markKey\(planMark\(markNow\.current\.facts, localNow\(\)\)\) !== markNow\.current\.key\) setClock\(\(n\) => n \+ 1\); \}, PLAN_TICK_MS\);/);
  assert.doesNotMatch(pc, /setClock\(\(n\) => n \+ 1\), 30_000\)/, "no 30 s tick");
  assert.match(src("components/GlobalDecision.tsx"), /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/, "the card's own 1 s clock (its countdown re-renders the tag)");
});

test("PS42 nit 7: a plan whose time is more than CLOCK_SLACK_MS ahead is hidden; serverClock ignores samples a day off", () => {
  const f = { hasData: true, error: null, lastOk: now + CLOCK_SLACK_MS + 1, intervalMs: 300_000 };
  assert.equal(isStale(f, now), true);
  assert.deepEqual(planMark(f, now), { show: false, dim: true, suffix: "", note: "plan hidden: decision stale" }, "not believable: hidden, never dimmed with no age");
  assert.deepEqual(planMark({ ...f, error: E502, lastOk: now + 5_000 }, now), { show: true, dim: true, suffix: " · stale", note: null }, "within the slack, stale: dimmed");
  assert.deepEqual(planMark({ ...f, replayed: true, replayAt: now + 2 * CLOCK_SLACK_MS, lastOk: null }, now).show, false, "a replay aged into the future too");
  assert.equal(OFFSET_MAX_MS, 86_400_000);
  const c = serverClock();
  c.note(now - OFFSET_MAX_MS - 1, now);
  c.note(now + OFFSET_MAX_MS + 1, now);
  assert.equal(c.offset(), null, "more than a day either way: no sample");
  c.note(now - OFFSET_MAX_MS, now);
  assert.equal(c.offset(), OFFSET_MAX_MS, "a day exactly still counts");
  c.note(now - 300, now);
  assert.equal(c.offset(), 300);
});

test("PS43 nit 8: an ok answer that is not JSON (a captive portal, an SPA fallback) is ApiError not_json, never a good read", async () => {
  const real = globalThis.fetch;
  const reply = (status, text, type) => async () => new Response(text, { status, headers: type ? { "content-type": type, date: "Sun, 22 Nov 2026 14:20:07 GMT" } : {} });
  try {
    globalThis.fetch = reply(200, "<!doctype html><title>Sign in</title>", "text/html; charset=utf-8");
    await assert.rejects(get("/api/conclusion/global"), (e) => e instanceof ApiError && e.message === "/api/conclusion/global 200 not_json" && e.code === "not_json");
    await assert.rejects(getDated("/api/conclusion/global"), (e) => e instanceof ApiError && e.code === "not_json" && e.date === Date.parse("2026-11-22T14:20:07Z"), "with its Date");
    globalThis.fetch = reply(200, "<html>", "application/json");
    await assert.rejects(get("/api/ledger"), { message: "/api/ledger 200 not_json" }, "a JSON type that does not parse");
    globalThis.fetch = reply(200, "{\"ok\":1}", null);
    await assert.rejects(get("/api/ledger"), { message: "/api/ledger 200 not_json" }, "no content type");
    globalThis.fetch = reply(200, "{\"ok\":1}", "application/problem+json");
    assert.deepEqual(await get("/api/ledger"), { ok: 1 }, "a +json type is JSON");
    globalThis.fetch = reply(200, "null", "application/json");
    assert.equal(await get("/api/ledger"), null, "JSON null is still an answer");
    globalThis.fetch = reply(502, "<html>Bad gateway</html>", "text/html");
    await assert.rejects(get("/api/ledger"), { message: "/api/ledger 502" }, "an HTML error page stays the status");
    globalThis.fetch = reply(404, "<html>", "text/html");
    await assert.rejects(get("/api/decision/x"), { message: "/api/decision/x 404" }, "only a JSON not_found is an answer");
  } finally {
    globalThis.fetch = real;
  }
});

test("PS44 nit 9: the steady clock is anchored (no drift from summing per-call maxima); a backward step re-anchors and never moves back", () => {
  // Two clocks that agree over time but jitter against each other on every call (a 3 ms swing each way).
  let wall = now, mono = 0;
  const clock = steadyClock(() => wall, () => mono);
  for (let i = 0; i < 1_000; i++) { if (i % 2) { wall += 1_003; mono += 997; } else { wall += 997; mono += 1_003; } clock(); }
  assert.equal(clock() - now, 1_000_000, "1000 s of both clocks: 1000 s, not 1003 s (the third review's sum ran 0.3% old)");
  // A backward wall step: re-anchored on the time reached plus the monotonic time since the last call.
  const before = clock();
  wall -= 10 * MIN; mono += 2_000;
  assert.equal(clock(), before + 2_000, "never backward; the monotonic 2 s counted");
  let last = clock();
  for (let i = 0; i < 50; i++) { wall += (i % 3) - 1; mono += 0; const t = clock(); assert.ok(t >= last, "monotone under wall jitter"); last = t; }
  // A later sleep (the monotonic clock paused) counts in full from the new anchor.
  const pre = clock();
  wall += 8 * 3_600_000;
  assert.equal(clock(), pre + 8 * 3_600_000, "the 8 h step counted in full");
});

test("PS45 nit 10 and the offset note: the known limit of (c) and the offset errs younger, in the code and the CHANGELOG", () => {
  const ps = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/lib/pollState.ts", import.meta.url), "utf8");
  assert.match(ps, /Known limit \(fifth review of #520\): `Date` is stamped when the response leaves the server/);
  assert.match(ps, /The offset errs YOUNGER/);
  assert.doesNotMatch(ps, /errs older/i);
  const log = readFileSync(new URL("../docs/CHANGELOG.md", import.meta.url), "utf8");
  const line = log.split("\n").find((l) => l.includes("**Fifth review fixes.**")) ?? "";
  assert.match(line, /more than 1 s after reading its data can beat a newer replay/);
  assert.match(line, /errs younger/);
  assert.doesNotMatch(log, /errs older/i);
});
