import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  surpriseOf, reactionOf, horizonStats, upsertReleases, refreshEconReleases, calendarIntel, releaseKey, seriesOf,
  resetEconSchemaCacheForTests, MIN_HORIZON_SAMPLES
} from "../src/econ-releases.mjs";
import { calendarOutlook, matchRelease, projectEvent } from "../src/calendar-agent.mjs";
import { calendarBiasRule, dueSessions } from "../src/macro-room.mjs";
import { calendarContextOf, contextCautions } from "../src/decision-engine.mjs";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args.map((v) => (v === undefined ? null : v))),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) })
  });
  return { prepare: (sql) => wrap(sql), raw: db };
}
const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, String(v)); } }; };
const CPI = "2026-11-10T13:30:00.000Z";

test("the surprise: actual against forecast, in the series' own spread; its effect on gold by the event's rule", () => {
  const hot = surpriseOf({ title: "CPI m/m", actual: 0.4, forecast: 0.3, previous: 0.3 });
  assert.equal(hot.surprise, 0.1);
  assert.equal(hot.gold_direction, -1, "hotter inflation weighs on gold");
  assert.equal(hot.surprise_z, 3, "a tenth of the forecast is the fallback scale (0.03), within +-3");
  assert.match(hot.basis, /fewer than 6/);
  const past = [0.1, -0.1, 0, 0.2, -0.1, 0.1, 0];
  const z = surpriseOf({ title: "CPI m/m", actual: 0.4, forecast: 0.3 }, past);
  assert.ok(z.surprise_z > 0.5 && z.surprise_z < 2, JSON.stringify(z));
  assert.match(z.basis, /7 past surprises/);
  assert.equal(surpriseOf({ title: "Unemployment Rate", actual: 4.3, forecast: 4.1 }).gold_direction, 1, "more unemployment lifts gold");
  assert.equal(surpriseOf({ title: "Fed Chair Powell Speaks", actual: null, forecast: null }), null, "a speech has no number");
  assert.equal(surpriseOf({ title: "CPI m/m", actual: 0.3, forecast: 0.3 }).gold_direction, 0, "in line: no effect");
  assert.equal(seriesOf("CPI m/m (Oct)"), seriesOf("CPI m/m (Nov)"), "the same indicator across months");
  assert.match(releaseKey({ title: "CPI m/m", time: CPI }), /^USD:2026-11-10T13:30:cpi-m-m$/);
});

/** 1H columns from `start` with closes from fn(i), each bar opening at the previous close. */
function bars(start, n, fn) {
  const t = [], o = [], h = [], l = [], c = [];
  for (let i = 0; i < n; i++) { const x = fn(i), open = i ? fn(i - 1) : x; t.push(start / 1000 + i * 3600); o.push(open); h.push(Math.max(open, x) + 1); l.push(Math.min(open, x) - 1); c.push(x); }
  return { t, o, h, l, c };
}

test("gold's reaction after a release, in ATR and signed by the rule; the learned horizon per event kind", () => {
  const start = Date.parse("2026-11-09T00:00:00Z");
  // Flat for 37 hours, then a fall of 2 per hour after the 13:30 release (13:00 bar is index 37).
  const b = bars(start, 80, (i) => (i < 37 ? 4000 : 4000 - 2 * (i - 36)));
  const rx = reactionOf({ time: CPI, gold_direction: -1 }, b);
  assert.ok(rx.atr > 0);
  assert.ok(rx.signed["1h"] > 0 && rx.signed["4h"] > rx.signed["1h"], "gold fell, the way the rule said, more over time");
  assert.equal(reactionOf({ time: "2026-12-01T00:00:00Z", gold_direction: -1 }, b), null, "outside the history");
  assert.equal(reactionOf({ time: "2026-11-09T05:00:00Z", gold_direction: -1 }, b), null, "no ATR before the first 15 hours");
  // Six inflation releases: the rule holds at 1 to 4 hours, fades by 8 and reverses by 24.
  const row = (s) => ({ kind: "inflation", gold_direction: -1, reaction_json: JSON.stringify({ signed: s }) });
  const rows = Array.from({ length: 6 }, (_, i) => row({ "1h": 0.5, "2h": 0.8, "4h": i < 5 ? 0.6 : -0.2, "8h": i < 2 ? 0.3 : -0.4, "24h": -0.5 }));
  const st = horizonStats(rows).inflation;
  assert.equal(st.samples, 6);
  assert.equal(st.horizon_hours, 4, "the longest horizon where gold still followed the rule 55% of the time");
  assert.deepEqual([st.peak.at, st.peak.mean_atr], ["2h", 0.8]);
  assert.equal(horizonStats(rows.slice(0, MIN_HORIZON_SAMPLES - 1)).inflation.horizon_hours, null, "too few releases: the fixed horizon stands");
});

test("the sweep: the released value right after the event, a history window an hour, reactions from the 1H history; never throws", async () => {
  resetEconSchemaCacheForTests();
  const now = Date.parse(CPI) + 10 * 60_000; // 13:40, the first sweep after the release (minute 40 >= 25: no back-fill)
  const calls = [];
  const env = {
    DB: fakeD1(), SIGNAL_CACHE: kv(),
    NEWS_INGESTION: {
      economicCalendar: async (req) => { calls.push(req); return { status: 200, body: { events: [{ title: "CPI m/m", time: CPI, currency: "USD", importance: 1, actual: 0.4, forecast: 0.3, previous: 0.3, unit: "%" }, { title: "Core CPI m/m", time: CPI, currency: "USD", importance: 1, actual: 0.3, forecast: 0.3, previous: 0.2 }] } }; },
      goldHistory: async () => ({ status: 200, body: { results: [{ ok: true, bars: bars(Date.parse("2026-11-09T00:00:00Z"), 80, (i) => 4000 - i) }] } })
    }
  };
  const gated = [{ title: "CPI m/m", currency: "USD", impact: "High", time: CPI }];
  const r = await refreshEconReleases(env, { now, gatedEvents: gated });
  assert.equal(r.status, "ok", JSON.stringify(r));
  assert.deepEqual(r.live, { day: "2026-11-10", events: 2 });
  assert.deepEqual(calls[0], { date_from: "2026-11-10T00:00:00Z", date_to: "2026-11-10T23:59:59Z", currencies: "USD", min_importance: 1 });
  assert.equal(r.backfill, null, "back-fill only at the first sweep of the hour");
  assert.equal((await refreshEconReleases(env, { now: now + 60_000, gatedEvents: gated })).live, null, "the actual is stored: no second pull");
  const intel = await calendarIntel(env, { now });
  const cpi = intel.releases.find((x) => x.title === "CPI m/m");
  assert.deepEqual([cpi.actual, cpi.forecast, cpi.gold_direction], [0.4, 0.3, -1]);
  // The back-fill at the next hour's first sweep: one 14-day window back.
  const hourly = await refreshEconReleases(env, { now: Date.parse("2026-11-10T14:10:00Z"), gatedEvents: [] });
  assert.match(hourly.backfill.from, /^2026-10-27/);
  // Reactions once 25 hours have passed.
  const later = await refreshEconReleases(env, { now: Date.parse("2026-11-11T15:10:00Z"), gatedEvents: [] });
  assert.ok(later.reactions >= 1, JSON.stringify(later));
  assert.ok(env.DB.raw.prepare("SELECT reaction_json FROM econ_releases WHERE title = 'CPI m/m'").get().reaction_json.includes("signed"));
  assert.equal((await refreshEconReleases({}, { now })).status, "unavailable");
  resetEconSchemaCacheForTests();
  const broken = await refreshEconReleases({ DB: fakeD1(), SIGNAL_CACHE: kv(), NEWS_INGESTION: { economicCalendar: async () => { throw new Error("down"); } } }, { now, gatedEvents: gated });
  assert.equal(broken.live.error, "down", "a gateway failure is reported, not thrown");
});

test("the Calendar Agent after the release: actual, surprise, the rule's effect and the learned horizon; the macro room and the engine follow it", () => {
  const event = { title: "CPI m/m", currency: "USD", impact: "High", time: CPI, forecast: "0.3%", previous: "0.3%" };
  const release = { title: "CPI m/m", time: CPI, kind: "inflation", actual: 0.4, forecast: 0.3, previous: 0.3, unit: "%", surprise: 0.1, surprise_z: 1.8, gold_direction: -1 };
  const stat = { samples: 12, horizon_hours: 6, horizons: { "6h": { hit_rate: 0.67 } }, peak: { at: "2h", mean_atr: 0.9, hit_rate: 0.75 } };
  assert.equal(matchRelease(event, [release]), release);
  const now = Date.parse(CPI) + 3 * 3_600_000;
  const p = projectEvent(event, now, { release, stat });
  assert.equal(p.status, "released");
  assert.equal(p.horizon.hours_after, 6, "the learned horizon replaces the fixed 4 hours");
  assert.match(p.text, /actual 0\.4% against a forecast of 0\.3% \(a surprise of \+1\.8 standard deviations\), so by rule gold down/);
  assert.match(p.text, /12 past releases of this kind gold moved the rule's way 67% of the time up to 6 hours after, most strongly after 2 hours/);
  assert.equal(projectEvent(event, Date.parse(CPI) + 5 * 3_600_000, {}).status, "past", "without a learned horizon the fixed 4 hours stand");
  const outlook = calendarOutlook([event], now, { intel: { releases: [release], stats: { inflation: stat } } });
  assert.equal(outlook.surprise_lean, -1, "a large surprise inside its horizon: gold down");
  assert.equal(calendarBiasRule(outlook), "BEARISH", "the Calendar Agent's bias follows the surprise by rule after the release");
  assert.equal(calendarBiasRule(calendarOutlook([event], now, {})), null, "without the released value the agent stays free");
  const ctx = calendarContextOf(outlook);
  assert.equal(ctx.released[0].release.surprise_z, 1.8);
  assert.match(contextCautions(1, { calendar: ctx }).join(" | "), /CPI m\/m surprised \+1\.8 standard deviations, which by its rule weighs on gold, against a long, inside its 6-hour horizon/);
  assert.deepEqual(contextCautions(-1, { calendar: ctx }), [], "with the short: no caution");
  // The macro room meets again 2 hours after the release.
  const due = dueSessions({ events: [event], now: Date.parse(CPI) + 2 * 3_600_000 + 60_000, done: new Set([`event:${CPI}`]) });
  assert.deepEqual(due.map((s) => s.kind), ["event_follow_up"]);
});

test("upserts keep the first actual and never invent one", async () => {
  resetEconSchemaCacheForTests();
  const db = fakeD1();
  await upsertReleases(db, [{ title: "NFP", time: CPI, currency: "USD", forecast: 150000 }]);
  await upsertReleases(db, [{ title: "NFP", time: CPI, currency: "USD", actual: 210000, forecast: 150000 }]);
  await upsertReleases(db, [{ title: "NFP", time: CPI, currency: "USD", forecast: 150000 }]);
  const row = db.raw.prepare("SELECT actual, gold_direction FROM econ_releases").get();
  assert.deepEqual({ ...row }, { actual: 210000, gold_direction: -1 }, "stronger hiring weighs on gold; a later answer without the actual keeps it");
  assert.equal(await upsertReleases(db, [{ title: "ECB rate", time: CPI, currency: "EUR", actual: 2 }]), 0, "USD only");
});
