// Nexus panel data states (owner-approved mockup "Nexus data states", part A, 2026-11-22): loading, empty, error, stale
// and live for every polled panel. The rules are pure (ui/src/lib/pollState.ts) and the error is a code
// (ui/src/lib/api.ts ApiError: "/api/ledger 502"); the pages print that one error line, never "Unavailable: HTTP 502".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLOCK_SLACK_MS, PLAN_HIDE_MS, RETRY_JOIN_MS, STALE_TICK_MS, emptyRoute, isStale, joinsInFlight, okLine, planMark, pollPhase, pushApplies, pushTime, retryEvery, routeFacts, routePushed, routeSent, routeSettled, shortAge, singleFlight, staleAt, staleChanged, staleTitle, staleWake, utcClock, withPush } from "../workers/xauusd-nexus-dashboard/ui/src/lib/pollState.ts";
import { overviewBadge } from "../workers/xauusd-nexus-dashboard/ui/src/lib/healthBadge.ts";
import { ApiError, errorText, get } from "../workers/xauusd-nexus-dashboard/ui/src/lib/api.ts";

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
  assert.match(s, /export function usePoll<T>\(load: \(\) => Promise<T>, intervalMs = 0, deps: unknown\[\] = \[\]\)/, "the interval stays apart from the deps");
  assert.match(s, /if \(!hasData\.current\) setLoading\(true\);/, "the skeleton only on the first load");
  assert.match(s, /document\.visibilityState === "visible"/, "visible-only refresh");
  assert.match(s, /return \{ data, error, loading, refresh, lastOk, lastFail, failures, stale, intervalMs, busy \};/);
  assert.match(s, /isStale\(\{ hasData: present, error, lastOk, intervalMs \}, Date\.now\(\)\)/, "one stale rule, from lib/pollState.ts");
  assert.doesNotMatch(s, /\.generated_at\b/, "no API field: the browser clock (owner: no API change)");
});

test("PS7 the shared pieces: Panel's tag, PollBody, the error box, the empty line, the chart skeleton", () => {
  const u = src("components/ui.tsx");
  for (const name of ["export function Panel(", "export function PollBody(", "export function ErrorBox(", "export function PollError(", "export function RetryButton(", "export function Empty({ children, when }", "variant = \"rows\""]) {
    assert.ok(u.includes(name), name);
  }
  assert.match(u, /border-late-fill\/35 bg-late-fill\/10 text-late"\)\}><Dot tone="late" \/>stale \{age\}/, "stale is amber (late)");
  assert.match(u, /border-fault-fill\/35 bg-fault-fill\/10 text-fault"\)\}[^>]*><Dot tone="fault" \/>error/, "error is red (fault)");
  assert.match(u, /<Dot tone="ok" \/>\{utcClock\(poll\.lastOk, false\)\} UTC/, "live is cyan (ok), the time in UTC");
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
  assert.match(mk, /\(e\) => settle\(\{ ok: false, error: errorText\(e\), at: Date\.now\(\) \}\),/, "each read still catches its own failure");
  assert.doesNotMatch(mk, /return null;\n\s+\}\);/, "the catch no longer answers null for the batch");
  const was = { ...emptyRoute, data: { engine: { stance: "SELL" } }, shownAt: now - 60_000, lastOk: now - 59_000, sent: 1, settled: 1 };
  const failedRead = routeSettled(routeSent(was), 2, { ok: false, error: "/api/conclusion/global 502", at: now });
  assert.equal(failedRead.data, was.data, "a failed read keeps the data as it was: never null");
  assert.deepEqual([failedRead.error, failedRead.lastFail, failedRead.failures, failedRead.lastOk], ["/api/conclusion/global 502", now, 1, now - 59_000]);
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
  assert.match(s, /const w = staleWake\(at, Date\.now\(\)\);\n\s+if \(w\.rearmMs != null\) arm\(w\.rearmMs\);\n\s+else if \(w\.render\) rerender\(\);/, "usePoll arms the timer again");
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
  assert.match(s, /if \(!intervalMs \|\| !present\) return;\n\s+const t = window\.setInterval\(\(\) => \{ if \(staleChanged\(shown\.current\.stale, shown\.current\.facts, Date\.now\(\)\)\) rerender\(\); \}, STALE_TICK_MS\);/, "the tick runs only while data is on screen");
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
  assert.match(src("lib/usePoll.ts"), /const refresh = useCallback\(\(\) => flight\.current\.retry\(read, intervalRef\.current\), \[read\]\);/);
  const mk = src("lib/market.tsx");
  assert.match(mk, /const retry = async \(\) => \{ await Promise\.all\(ALL_PATHS\.map\(refresh\)\); \};/, "the market retry joins each path's young read: two clicks, six requests, not twelve");
  assert.match(src("components/ThreadsPanel.tsx"), /const failure = \(path: string\) => failed\[path\] \? <PollError poll=\{pollOf\(path\)\} \/> : null;/, "a tab's error box retries its own path");
});

test("PS15 a push after the last failed read is a good arrival; a failed read after the push still counts", () => {
  const failedRead = { error: "/api/conclusion/global 502", lastOk: now - 600_000, lastFail: now - 10_000, failures: 2 };
  assert.deepEqual(withPush(failedRead, now - 5_000), { error: null, lastOk: now - 5_000, lastFail: now - 10_000, failures: 0 });
  assert.equal(withPush(failedRead, now - 20_000), failedRead, "a push from before the failure changes nothing: no cleared error, no newer lastOk (re-review)");
  assert.equal(withPush(failedRead, now - 10_000), failedRead, "nor one from the same instant");
  assert.equal(withPush(failedRead, null), failedRead);
});

test("PS16 item 1: the Decision Engine keeps its last decision on a failed read, and never says \"No decision yet.\" then", () => {
  const mk = src("lib/market.tsx");
  // Re-review: each route keeps its own last good answer (routeSettled: a failure never touches `data`, PS9).
  const ps = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/lib/pollState.ts", import.meta.url), "utf8");
  assert.match(ps, /if \(!r\.ok\) return \{ \.\.\.s, settled: id, error: r\.error, lastFail: r\.at, failures: s\.failures \+ 1 \};/, "a failed read leaves the last decision in place");
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
  // The push keeps its own time (the hub's `at`), never the time it reached the page.
  const p = src("lib/push.ts");
  assert.match(p, /const at = pushTime\(msg\.at, Date\.now\(\)\);\n\s+setSnap\(\(d\) => \(\{ \.\.\.d, \[msg\.topic\]: \{ data: msg\.data, at \} \}\)\);/);
  assert.equal(pushTime("2026-11-22T13:00:00.000Z", now), Date.parse("2026-11-22T13:00:00Z"));
  assert.equal(pushTime(null, now), null);
  assert.equal(pushTime("not a date", now), null);
  assert.equal(pushTime("2026-11-22T15:00:00Z", now), now, "a hub clock ahead never dates a snapshot in the future");
  assert.equal(pushApplies(null, null), false, "a push with no time never applies");
  assert.equal(pushApplies(now - 1, now), false, "older than the data on screen: kept off");
  assert.equal(pushApplies(now, now), false, "the same snapshot again: kept off");
  assert.equal(pushApplies(now + 1, now), true);
  assert.equal(pushApplies(now - 86_400_000, null), true, "nothing on screen: shown (its own age marks it stale)");

  // The reproduction: a good read at 13:52, the decision changes, /api/conclusion/global 502 at 13:57 (stale 5m,
  // "502 · 1 failed"); the socket reconnects and the hub replays the 13:45 snapshot.
  const sell = { engine: { stance: "SELL" } }, old = { engine: { stance: "BUY", old: true } };
  let r = routeSettled(routeSent(emptyRoute), 1, { ok: true, data: sell, startedAt: now - 600_000, at: now - 599_000 });
  r = routeSettled(routeSent(r), 2, { ok: false, error: "/api/conclusion/global 502", at: now - 300_000 });
  const replay = routePushed(r, old, now - 1_020_000);
  assert.equal(replay, r, "the replay is older than the data on screen: nothing changes");
  assert.deepEqual(routeFacts(replay), { error: "/api/conclusion/global 502", lastOk: now - 599_000, lastFail: now - 300_000, failures: 1 });
  assert.equal(isStale({ hasData: true, ...routeFacts(replay), intervalMs: 300_000 }, now), true, "the card stays stale");
  // A snapshot newer than the data on screen but older than the failure: shown, and still stale.
  const between = routePushed(r, old, now - 400_000);
  assert.equal(between.data, old, "newer than the data on screen: shown");
  assert.deepEqual(routeFacts(between), { error: "/api/conclusion/global 502", lastOk: now - 599_000, lastFail: now - 300_000, failures: 1 }, "but older than the failure: no cleared error, no newer lastOk");
  // A real publish after the failure is a good arrival.
  const fresh = routePushed(r, old, now - 5_000);
  assert.deepEqual(routeFacts(fresh), { error: null, lastOk: now - 5_000, lastFail: now - 300_000, failures: 0 });
  // Reconnect repeats: the same replay again and again never turns it live.
  let again = r;
  for (let i = 0; i < 5; i++) again = routePushed(again, old, now - 1_020_000);
  assert.equal(routeFacts(again).error, "/api/conclusion/global 502");
  // A read whose start is older than the push on screen refreshes lastOk but never puts its older body back.
  const pushed = routePushed(routeSent(r), { engine: { stance: "BUY" } }, now - 5_000);
  const lateRead = routeSettled(pushed, 3, { ok: true, data: sell, startedAt: now - 10_000, at: now - 1_000 });
  assert.deepEqual([lateRead.data.engine.stance, lateRead.lastOk, lateRead.error], ["BUY", now - 1_000, null]);

  const mk = src("lib/market.tsx");
  assert.doesNotMatch(mk, /setPushAt\(|Date\.now\(\) \}\)\); \} \}, \[push\.data/, "no push stamped with the page's clock");
  assert.match(mk, /routePushed\(route\(GLOBAL_PATH\), decisionSnap\.data, decisionSnap\.at\)/);
  assert.match(mk, /routePushed\(route\(threadPath\(c\)\), threadsSnap\.data\?\.\[c\] \?\? null, threadsSnap\.at\)/);
  const wr = src("lib/warroom.tsx");
  assert.match(wr, /pushApplies\(snap\.at, s\.at\) \? \{ data: snap\.data, at: snap\.at, pushAt:/, "the War Room's 15m room too");
  assert.doesNotMatch(wr, /setPushAt\(Date\.now\(\)\)/);
  assert.match(src("pages/Omega.tsx"), /const pushed = push\.snap\["omega-overview"\]\?\.data;/, "Omega reads the same snapshot shape");
});

test("PS21 SHOULD 2: each route applies its own answer as it resolves; a hung sibling never holds the decision back", async () => {
  // D1's thread read hangs; /api/conclusion/global answers BUY: the decision is BUY at once, and live.
  let d1 = routeSent(emptyRoute);
  let gl = routeSettled(routeSent(emptyRoute), 1, { ok: true, data: { engine: { stance: "SELL" } }, startedAt: now - 400_000, at: now - 399_000 });
  for (let i = 2; i <= 7; i++) {
    d1 = routeSent(d1);
    gl = routeSettled(routeSent(gl), i, { ok: true, data: { engine: { stance: "BUY" } }, startedAt: now - 60_000 * (8 - i), at: now - 60_000 * (8 - i) + 500 });
  }
  assert.equal(gl.data.engine.stance, "BUY", "six good answers, applied as each came");
  assert.equal(isStale({ hasData: true, ...routeFacts(gl), intervalMs: 60_000 }, now), false);
  assert.equal(d1.settled, 0, "the hung read is D1's alone");
  assert.equal(isStale({ hasData: true, ...routeFacts({ ...d1, data: {}, lastOk: now - 400_000 }), intervalMs: 60_000 }, now), true, "and D1 reads as stale");
  // An overtaken read never undoes a newer answer.
  const a = routeSent(routeSent(emptyRoute));
  const newer = routeSettled(a, 2, { ok: true, data: "new", startedAt: now - 1_000, at: now });
  assert.equal(routeSettled(newer, 1, { ok: true, data: "old", startedAt: now - 9_000, at: now + 1 }), newer);
  assert.equal(routeSettled(newer, 1, { ok: false, error: "/api/x 502", at: now + 1 }), newer, "nor a late failure of an older read");
  // lastOk is recorded only with that path's own answer.
  const mk = src("lib/market.tsx");
  assert.match(mk, /const settle = \(r: ReadOutcome\) => \{ routes\.current\[path\] = routeSettled\(route\(path\), id, r\); bump\(\); \};/, "each read settles its own path and renders");
  assert.doesNotMatch(mk, /Promise\.all\(\[\n?\s*\.\.\.TF_CHARTS\.map/, "no batch that waits on the slowest read");
  assert.match(mk, /useSchedule\(\(\) => \{ for \(const p of SLOW_PATHS\) void read\(p\); \}, slowMs\);/);
  assert.match(mk, /busy: s\.sent > s\.settled, refresh: \(\) => refresh\(path\)/, "busy and refresh are the path's own");
  assert.match(src("lib/usePoll.ts"), /export function useSchedule\(run: \(\) => void, intervalMs: number\)/);
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
  assert.equal(joinsInFlight(null, now, 60_000), false, "nothing in flight: read");
  assert.equal(joinsInFlight(now - 59_999, now, 60_000), true, "a young read: joined");
  assert.equal(joinsInFlight(now - 60_000, now, 60_000), false, "older than the interval: a new read");
  assert.equal(joinsInFlight(now - RETRY_JOIN_MS + 1, now, 0), true, "a poll with no interval joins for RETRY_JOIN_MS");
  assert.equal(joinsInFlight(now - RETRY_JOIN_MS, now, 0), false);
  assert.equal(joinsInFlight(now + 5, now, 60_000), false, "a clock that moved back never joins");
  let t = 0;
  const f = singleFlight(() => t);
  let n = 0;
  const hang = () => { n++; return new Promise(() => {}); };
  const first = f.retry(hang, 60_000);
  assert.equal(f.retry(hang, 60_000), first, "a second click within the interval joins");
  assert.equal(n, 1);
  t = 60_000;
  assert.notEqual(f.retry(hang, 60_000), first, "past the interval the hung read is not joined");
  assert.equal(n, 2);
  const u = src("components/ui.tsx");
  const btn = u.slice(u.indexOf("export function RetryButton("), u.indexOf("/**\n * A failed read with nothing on screen"));
  assert.doesNotMatch(btn, /busy \|\| running|disabled=\{off\}|disabled=\{busy/, "a read in flight elsewhere never disables it");
  assert.match(btn, /t = window\.setTimeout\(end, RETRY_SPIN_MS\);/, "its own spin is capped");
  assert.match(u, /export const RETRY_SPIN_MS = 10_000;/);
  const mk = src("lib/market.tsx");
  assert.match(mk, /return f && joinsInFlight\(f\.since, monotonic\(\), intervalOf\(path\)\) \? f\.p : read\(path\);/, "per path: a young read is joined, an old one is not");
  assert.match(src("lib/api.ts"), /fetch\(path, \{ headers: \{ accept: "application\/json" \}, cache: "no-store" \}\)/, "no browser cache lock behind a hung read of the same URL");
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
