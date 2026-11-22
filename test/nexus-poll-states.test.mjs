// Nexus panel data states (owner-approved mockup "Nexus data states", part A, 2026-11-22): loading, empty, error, stale
// and live for every polled panel. The rules are pure (ui/src/lib/pollState.ts) and the error is a code
// (ui/src/lib/api.ts ApiError: "/api/ledger 502"); the pages print that one error line, never "Unavailable: HTTP 502".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isStale, okLine, pollPhase, retryEvery, shortAge, staleAt, staleTitle, utcClock } from "../workers/xauusd-nexus-dashboard/ui/src/lib/pollState.ts";
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
  assert.match(s, /return \{ data, error, loading, refresh, lastOk, lastFail, failures, stale, intervalMs \};/);
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
  assert.match(mk, /\(e\) => \{ failed\[path\] = errorText\(e\); return null; \}/, "each read still catches its own failure");
  assert.match(mk, /failed: \{ \.\.\.\(\(slow\.data as any\)\?\.failed \?\? \{\}\), \.\.\.\(f\?\.failed \?\? \{\}\) \}/);
  assert.doesNotMatch(mk, /\.catch\(\(\) => null\)/, "no silent catch left");
  const tp = src("components/ThreadsPanel.tsx");
  assert.match(tp, /if \(tab === "NEWS"\) return news \? <NewsTab d=\{news\} \/> : failure\(NEWS_PATH\) \?\? <p className="text-\[12px\] text-muted">No news analysis yet\.<\/p>;/);
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
