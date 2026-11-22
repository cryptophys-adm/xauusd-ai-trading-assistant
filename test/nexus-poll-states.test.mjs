// Nexus panel data states (owner-approved mockup "Nexus data states", part A, 2026-11-22): loading, empty, error, stale
// and live for every polled panel. The rules are pure (ui/src/lib/pollState.ts) and the error is a code
// (ui/src/lib/api.ts ApiError: "/api/ledger 502"); the pages print that one error line, never "Unavailable: HTTP 502".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STALE_TICK_MS, isStale, okLine, pollPhase, retryEvery, shortAge, singleFlight, staleAt, staleChanged, staleTitle, staleWake, utcClock, withPush } from "../workers/xauusd-nexus-dashboard/ui/src/lib/pollState.ts";
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
  assert.match(mk, /\(e\) => \{\n\s+const was = facts\.current\[path\] \?\? noFacts;\n\s+failed\[path\] = errorText\(e\);/, "each read still catches its own failure");
  assert.match(mk, /for \(const \[path, f\] of Object\.entries\(facts\.current\)\) \{\n\s+if \(f\.error\) failed\[path\] = f\.error;/, "which routes failed, from each path's own facts");
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
  assert.match(u, /const off = busy \|\| running;\n\s+const click = \(\) => \{\n\s+if \(off\) return;/, "the button ignores clicks while busy");
  assert.match(u, /onClick=\{click\} disabled=\{off\}/);
  assert.match(u, /<RetryButton onRetry=\{poll\.refresh\} busy=\{pollBusy\(poll\)\} compact \/>/, "the stale tag's Retry is busy while a read is in flight");
  assert.match(src("lib/usePoll.ts"), /const refresh = useCallback\(\(\) => flight\.current\.retry\(read\), \[read\]\);/);
  const mk = src("lib/market.tsx");
  assert.match(mk, /const retry = async \(\) => \{ await Promise\.all\(\[slow\.refresh\(\), fast\.refresh\(\)\]\); \};/, "the War Room retry joins both polls' reads: two clicks, six requests, not twelve");
  assert.match(src("components/ThreadsPanel.tsx"), /retrying=\{busy\} onRetry=\{retry\}/);
});

test("PS15 a push after the last failed read is a good arrival; a failed read after the push still counts", () => {
  const failedRead = { error: "/api/conclusion/global 502", lastOk: now - 600_000, lastFail: now - 10_000, failures: 2 };
  assert.deepEqual(withPush(failedRead, now - 5_000), { error: null, lastOk: now - 5_000, lastFail: now - 10_000, failures: 0 });
  assert.deepEqual(withPush(failedRead, now - 20_000), { ...failedRead, lastOk: now - 20_000 });
  assert.equal(withPush(failedRead, null), failedRead);
});

test("PS16 item 1: the Decision Engine keeps its last decision on a failed read, and never says \"No decision yet.\" then", () => {
  const mk = src("lib/market.tsx");
  assert.match(mk, /if \(!d\.failed\[GLOBAL_PATH\]\) setDecisionBody\(d\.decision\);/, "a failed read leaves the last decision in place");
  assert.doesNotMatch(mk, /setDecisionBody\(d\.decision\); \}/, "the old unconditional replace blanked the card");
  assert.match(mk, /for \(const c of TF_CHARTS\) if \(!d\.failed\[threadPath\(c\)\]\) got\[c\] = d\.threads\[c\];/, "the rooms too");
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
