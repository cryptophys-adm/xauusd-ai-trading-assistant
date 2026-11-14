// The content engine (owner 2026-11-14: "persiapan engine post ke Instagram/threads"): drafts from the public
// projection, the approval queue, and the Threads and Instagram publishers (dry run and a faked Meta API).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { dailyDrafts, dailyRecapText, summarizeDay, dateId, TEXT_LIMITS } from "../workers/xauusd-content/src/drafts.mjs";
import { addDrafts, listDrafts, decideDraft, recordPublish, deskCounts, getDraft, draftEvents, storeToken, storedToken } from "../workers/xauusd-content/src/desk.mjs";
import { publishThreads, publishInstagram, publishingQuota, refreshToken, THREADS_BASE, INSTAGRAM_BASE } from "../workers/xauusd-content/src/publishers.mjs";
import { PRICE_LIKE } from "../src/public-projection.mjs";

const NOW = Date.parse("2026-11-17T22:17:00Z"); // Tuesday's run: the trading day that ended 24 hours earlier
const recap = (iso, stance, bias, outcome, patterns = []) => ({ bar_close: iso, session: "london", timeframe: "15m", stance, bias, outcome, patterns });
const RECAPS = [
  recap("2026-11-16T09:00:00.000Z", "SELL", "BEARISH", "hit", [{ timeframe: "15", pattern: "wedge_falling", status: "confirmed" }]),
  recap("2026-11-16T09:15:00.000Z", "WAIT", "BEARISH", "hit"),
  recap("2026-11-16T14:30:00.000Z", "BUY", "BULLISH", "miss"),
  recap("2026-11-16T15:00:00.000Z", "WAIT", "NEUTRAL", "hit"),
  recap("2026-11-15T10:00:00.000Z", "SELL", "BEARISH", "hit"), // older than the window
  recap("2026-11-17T10:00:00.000Z", "SELL", "BEARISH", "hit") // inside the delay: never in a draft
];

test("a day's recap: counts, main bias, confirmed patterns, the scored directional reads, disclaimer and hashtags; no price", () => {
  const { summary, drafts } = dailyDrafts(RECAPS, { now: NOW });
  assert.deepEqual([summary.bars, summary.buy, summary.sell, summary.wait, summary.main_bias], [4, 1, 1, 2, "BEARISH"]);
  assert.deepEqual([summary.directional_hits, summary.directional_misses], [1, 1]);
  assert.deepEqual(drafts.map((d) => [d.channel, d.status, d.guardian.pass]), [["threads", "pending", true], ["instagram", "needs_image", true]]);
  const t = drafts[0].text;
  assert.match(t, /^Edukasi · Rekap XAUUSD Senin, 16 November 2026/);
  assert.match(t, /4 bar 15 menit: 1 kali condong beli, 1 kali condong jual, 2 kali memilih menunggu/);
  assert.match(t, /Pola yang terkonfirmasi: wedge falling\./);
  assert.match(t, /bukan ajakan jual atau beli/);
  assert.ok(t.length <= TEXT_LIMITS.threads, `${t.length} characters`);
  assert.equal(drafts[0].id, "daily:2026-11-16:threads");
  assert.ok(!PRICE_LIKE.test(t.replace(/\b(19|20)\d{2}\b/g, "")), "no price-like number besides the year");
  assert.equal(dailyRecapText(summarizeDay([], { from: "2026-11-16T00:00:00Z", to: "2026-11-17T00:00:00Z" }), { dayIso: "2026-11-17T00:00:00Z" }), null, "no decision, no draft");
  assert.equal(dateId("2026-11-20T10:00:00Z"), "Jumat, 20 November 2026");
});

function sqlite() {
  const db = new DatabaseSync(":memory:");
  return { exec(q, ...b) { const s = db.prepare(q); const isRead = /^\s*SELECT/i.test(q); const out = isRead ? s.all(...b) : (s.run(...b), []); return { toArray: () => out.map((r) => ({ ...r })) }; } };
}

test("the queue: a draft once, a person approves or rejects with a reason, the guardian runs again, every step an event", () => {
  const sql = sqlite();
  const { drafts } = dailyDrafts(RECAPS, { now: NOW });
  assert.deepEqual(addDrafts(sql, drafts, { now: NOW }), ["daily:2026-11-16:threads", "daily:2026-11-16:instagram"]);
  assert.deepEqual(addDrafts(sql, drafts, { now: NOW }), [], "the next run adds nothing twice");
  assert.deepEqual(deskCounts(sql), { needs_image: 1, pending: 1 });
  assert.equal(decideDraft(sql, { id: "daily:2026-11-16:instagram", decision: "approve", actor: "owner" }).error, "the draft is needs_image, not pending");
  assert.equal(decideDraft(sql, { id: "daily:2026-11-16:threads", decision: "reject", actor: "owner" }).error, "a reason is required to reject");
  assert.equal(decideDraft(sql, { id: "daily:2026-11-16:threads", decision: "approve", actor: "" }).error, "actor is required");
  const ok = decideDraft(sql, { id: "daily:2026-11-16:threads", decision: "approve", actor: "owner@example.com", reason: "ok" }, { now: NOW + 60_000 });
  assert.deepEqual([ok.ok, ok.status, ok.guardian.pass], [true, "approved", true]);
  assert.equal(decideDraft(sql, { id: "daily:2026-11-16:threads", decision: "reject", actor: "owner", reason: "late" }).error, "the draft is approved, not pending");
  recordPublish(sql, { id: "daily:2026-11-16:threads", remoteId: "1789" }, { now: NOW + 120_000 });
  assert.deepEqual([getDraft(sql, "daily:2026-11-16:threads").status, getDraft(sql, "daily:2026-11-16:threads").remote_id], ["published", "1789"]);
  assert.deepEqual(draftEvents(sql, "daily:2026-11-16:threads").map((e) => e.action), ["published", "approved", "drafted"]);
  // A draft whose text breaks a rule is blocked at approval, not published.
  addDrafts(sql, [{ id: "x", channel: "threads", text: "Edukasi. Bukan ajakan jual atau beli. Sell now at 3870!", status: "pending", decision_times: [] }], { now: NOW });
  const bad = decideDraft(sql, { id: "x", decision: "approve", actor: "owner" }, { now: NOW });
  assert.equal(bad.status, "blocked");
  assert.deepEqual(bad.guardian.failures.map((f) => f.check).sort(), ["instruction", "price_level"]);
  assert.deepEqual(listDrafts(sql, { status: "blocked" }).map((d) => d.id), ["x"]);
  storeToken(sql, "threads", { access_token: "t2", expires_in: 5_184_000 }, { now: NOW });
  assert.equal(storedToken(sql, "threads").access_token, "t2");
});

/** A fake Meta API: records each call (URL and body), answers containers, statuses and publishes. */
function fakeMeta({ status = "FINISHED", fail = null } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    calls.push({ method: init.method, url: String(url), body });
    const u = new URL(url);
    if (fail && u.pathname.endsWith(fail)) return new Response(JSON.stringify({ error: { message: "Application request limit reached", code: 4 } }), { status: 400 });
    if (init.method === "POST" && /\/(threads|media)$/.test(u.pathname)) return Response.json({ id: "c1" });
    if (init.method === "POST" && /_publish$/.test(u.pathname)) return Response.json({ id: "p1" });
    if (/\/c1$/.test(u.pathname)) return Response.json({ id: "c1", status, status_code: status });
    if (/publishing_limit$/.test(u.pathname)) return Response.json({ data: [{ quota_usage: 3, config: { quota_total: 250 } }] });
    if (/refresh_access_token$/.test(u.pathname)) return Response.json({ access_token: "new", expires_in: 5_184_000 });
    return new Response("{}", { status: 404 });
  };
  return { calls, fetcher };
}
const account = { user_id: "42", access_token: "SECRET-TOKEN" };
const noSleep = async () => {};

test("Threads: container, ready, publish; the token only in POST bodies; a dry run sends nothing and shows no token", async () => {
  const { calls, fetcher } = fakeMeta();
  const r = await publishThreads({ account, text: "Edukasi. Bukan ajakan jual atau beli.", fetcher, sleep: noSleep });
  assert.deepEqual(r, { remote_id: "p1", container_id: "c1" });
  assert.deepEqual(calls.map((c) => [c.method, c.url.split("?")[0]]), [["POST", `${THREADS_BASE}/42/threads`], ["GET", `${THREADS_BASE}/c1`], ["POST", `${THREADS_BASE}/42/threads_publish`]]);
  assert.deepEqual([calls[0].body.media_type, calls[2].body.creation_id], ["TEXT", "c1"]);
  assert.ok(calls.filter((c) => c.method === "POST").every((c) => !c.url.includes("SECRET") && c.body.access_token === "SECRET-TOKEN"));
  const dry = await publishThreads({ account, text: "x", dryRun: true, fetcher: () => { throw new Error("no call in a dry run"); } });
  assert.equal(dry.dry_run, true);
  assert.ok(!JSON.stringify(dry).includes("SECRET"));
  await assert.rejects(publishThreads({ account: { user_id: "42" }, text: "x", fetcher }), /not configured/);
});

test("Instagram: needs a public image; container, ready, publish; a container error or Meta error fails the call", async () => {
  const { calls, fetcher } = fakeMeta();
  await assert.rejects(publishInstagram({ account, caption: "c", imageUrl: null, fetcher, sleep: noSleep }), /public https image/);
  const r = await publishInstagram({ account, caption: "c", imageUrl: "https://img.example/card.jpg", fetcher, sleep: noSleep });
  assert.equal(r.remote_id, "p1");
  assert.deepEqual(calls.map((c) => c.url.split("?")[0]), [`${INSTAGRAM_BASE}/42/media`, `${INSTAGRAM_BASE}/c1`, `${INSTAGRAM_BASE}/42/media_publish`]);
  assert.equal(calls[1].url.includes("fields=status_code"), true);
  await assert.rejects(publishInstagram({ account, caption: "c", imageUrl: "https://img.example/a.jpg", fetcher: fakeMeta({ status: "ERROR" }).fetcher, sleep: noSleep }), /container error/);
  await assert.rejects(publishInstagram({ account, caption: "c", imageUrl: "https://img.example/a.jpg", fetcher: fakeMeta({ fail: "/media_publish" }).fetcher, sleep: noSleep }), /request limit/);
});

test("the quota is read from Meta, never assumed; a token is refreshed through its own endpoint", async () => {
  const { fetcher } = fakeMeta();
  assert.deepEqual(await publishingQuota({ channel: "threads", account, fetcher }), { used: 3, total: 250 });
  assert.equal(await publishingQuota({ channel: "threads", account: null, fetcher }), null);
  assert.deepEqual(await refreshToken({ channel: "instagram", token: "old", fetcher }), { access_token: "new", expires_in: 5_184_000 });
});
