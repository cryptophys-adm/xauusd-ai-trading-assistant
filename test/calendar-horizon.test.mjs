// The economic calendar's horizons (owner 2026-11-12: "ada tendensi market bergerak sesuai proyeksi horizon
// menjelang release economic calendar"; "ya kerjakan 1-3 dan 4a"; "sekaligus horizon news release
// mempengaruhi bobot", CALENDAR 0.08): the pre-release drift measured per event kind, the consensus lean's
// strength and the imminent window from it, and the CALENDAR witness that counts only inside a horizon.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { consensusOf, preDriftOf, preDriftStats, refreshEconReleases, calendarIntel, resetEconSchemaCacheForTests, MIN_HORIZON_SAMPLES } from "../src/econ-releases.mjs";
import { projectEvent, calendarOutlook, consensusStrength } from "../src/calendar-agent.mjs";
import { calendarWitness, witnessCards, quorumOf, calendarContextOf, EXTENDED_WITNESS_WEIGHTS } from "../src/decision-engine.mjs";
import { withCalendarWeight, witnessWeightsProblems, WITNESS_KEYS } from "../src/witness-tuning.mjs";

const H = 3_600_000;
const CPI = "2026-11-10T13:30:00.000Z";
function bars(start, n, fn) {
  const t = [], o = [], h = [], l = [], c = [];
  for (let i = 0; i < n; i++) { const x = fn(i), open = i ? fn(i - 1) : x; t.push(start / 1000 + i * 3600); o.push(open); h.push(Math.max(open, x) + 1); l.push(Math.min(open, x) - 1); c.push(x); }
  return { t, o, h, l, c };
}
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

test("the consensus and the drift before a release: gold's move into the release hour, in ATR, signed by the consensus", () => {
  assert.equal(consensusOf({ title: "CPI m/m", forecast: 0.4, previous: 0.3 }), -1, "a hotter forecast: the consensus leans gold down");
  assert.equal(consensusOf({ title: "Unemployment Rate", forecast: 4.3, previous: 4.1 }), 1);
  assert.equal(consensusOf({ title: "CPI m/m", forecast: 0.3, previous: 0.3 }), 0, "no change: no consensus");
  assert.equal(consensusOf({ title: "Fed Chair Powell Speaks" }), 0);
  // Flat until 05:00 on the 10th (index 29), then 2 lower an hour into the 13:00 bar (index 37) that holds the release.
  const b = bars(Date.parse("2026-11-09T00:00:00Z"), 60, (i) => (i < 29 ? 4000 : 4000 - 2 * (i - 28)));
  const pre = preDriftOf({ title: "CPI m/m", time: CPI, forecast: 0.4, previous: 0.3 }, b);
  assert.equal(pre.consensus, -1);
  assert.ok(pre.signed["1h"] > 0 && pre.signed["8h"] > pre.signed["4h"] && pre.signed["4h"] > pre.signed["1h"], JSON.stringify(pre));
  assert.ok(pre.moves["4h"] < 0, "gold fell into the release");
  const none = preDriftOf({ title: "CPI m/m", time: CPI, forecast: 0.3, previous: 0.3 }, b);
  assert.equal(none.signed["4h"], null, "no consensus: the move is kept, unsigned");
  assert.equal(preDriftOf({ title: "CPI m/m", time: "2026-12-01T13:30:00Z" }, b), null, "outside the history");
});

test("the pre-release statistics per kind: the hit rate at each hour and the learned pre-release horizon", () => {
  const row = (s, consensus = -1) => ({ kind: "inflation", pre_json: JSON.stringify({ consensus, signed: s }) });
  // Gold drifts the consensus way over 1 to 4 hours in 5 of 6 releases; over 8 hours only in 2.
  const rows = Array.from({ length: 6 }, (_, i) => row({ "1h": 0.2, "2h": 0.3, "4h": i < 5 ? 0.4 : -0.3, "8h": i < 2 ? 0.2 : -0.5 }));
  const st = preDriftStats([...rows, row({ "4h": -9 }, 0)]).inflation;
  assert.deepEqual([st.samples, st.horizon_hours, st.hit_rate], [6, 4, 0.833], "a release without a consensus does not count");
  assert.equal(preDriftStats(rows.slice(0, MIN_HORIZON_SAMPLES - 1)).inflation.horizon_hours, null, "too few: unmeasured");
  const against = preDriftStats(Array.from({ length: 6 }, () => row({ "1h": -0.2, "2h": -0.2, "4h": -0.3, "8h": -0.1 }))).inflation;
  assert.deepEqual([against.horizon_hours, against.hit_rate], [0, null]);
  // The consensus lean's strength from it.
  assert.equal(consensusStrength(null), 1, "unmeasured: the rule stands whole");
  assert.equal(consensusStrength({ horizon_hours: null, samples: 3 }), 1);
  assert.equal(consensusStrength(st), 1, "83 %: whole");
  assert.equal(consensusStrength({ horizon_hours: 2, hit_rate: 0.6 }), 0.4);
  assert.equal(consensusStrength({ horizon_hours: 1, hit_rate: 0.55 }), 0.2);
  assert.equal(consensusStrength(against), 0, "measured, not drifting: the consensus is not held");
});

test("the Calendar Agent before a release: the window and the strength follow the measured drift; the evidence is in its text", () => {
  const e = { title: "CPI m/m", currency: "USD", impact: "High", time: CPI, forecast: "0.4%", previous: "0.3%" };
  const at = (h) => Date.parse(CPI) - h * H;
  const drift = { samples: 12, horizon_hours: 4, hit_rate: 0.7, mean_atr: 0.31 };
  const p = projectEvent(e, at(3), { pre: drift });
  assert.deepEqual([p.status, p.consensus_lean, p.horizon.hours_before, p.horizon.learned_before], ["imminent", -0.8, 4, true], "3 hours before is inside the learned 4");
  assert.match(p.text, /in 12 past releases of this kind gold drifted the consensus way 70% of the time over the 4 hours before it \(mean \+0\.31 ATR\)/);
  assert.deepEqual(p.pre_release, { samples: 12, horizon_hours: 4, hit_rate: 0.7, mean_atr: 0.31, strength: 0.8 });
  assert.equal(projectEvent(e, at(3)).status, "upcoming", "unmeasured: the fixed 2 hours");
  assert.equal(projectEvent(e, at(3)).consensus_lean, -1);
  const flat = projectEvent(e, at(1), { pre: { samples: 9, horizon_hours: 0, hit_rate: null } });
  assert.equal(flat.consensus_lean, 0);
  assert.match(flat.text, /did not drift the consensus way reliably, so the consensus lean is not held/);
  const o = calendarOutlook([e], at(3), { intel: { releases: [], stats: {}, pre_stats: { inflation: drift } } });
  assert.equal(o.consensus_lean, -0.8);
  const ctx = calendarContextOf(o);
  assert.deepEqual([ctx.next[0].horizon_hours_before, ctx.next[0].pre_release.strength], [4, 0.8], "the council reads it");
});

test("the CALENDAR witness: the consensus inside the pre-release horizon, the surprise inside the post-release one, nothing outside", () => {
  const e = { title: "CPI m/m", currency: "USD", impact: "High", time: CPI, forecast: "0.4%", previous: "0.3%" };
  const drift = { samples: 12, horizon_hours: 4, hit_rate: 0.7, mean_atr: 0.31 };
  const outlook = (now, intel = {}) => calendarOutlook([e], now, { intel: { releases: [], stats: {}, pre_stats: { inflation: drift }, ...intel } });
  const before = calendarWitness(outlook(Date.parse(CPI) - 3 * H));
  assert.deepEqual([before.phase, before.lean], ["before", -0.8]);
  assert.match(before.summary, /CPI m\/m at 13:30 UTC: consensus -0\.8 \(drift 70% over 4h\)/);
  const far = calendarWitness(outlook(Date.parse(CPI) - 10 * H));
  assert.deepEqual([far.phase, far.lean], [null, null], "outside every horizon: no lean");
  // After: a hot print (+2 SD) inside the learned 4-hour reaction horizon, measured at 65 %.
  const release = { title: "CPI m/m", kind: "inflation", time: CPI, actual: 0.6, forecast: 0.4, previous: 0.3, surprise: 0.2, surprise_z: 2, gold_direction: -1 };
  const after = calendarWitness(outlook(Date.parse(CPI) + H, { releases: [release], stats: { inflation: { samples: 20, horizon_hours: 4, hit_rate: 0.65, peak: null } } }));
  assert.deepEqual([after.phase, after.lean], ["after", -0.6], "-1 x min(1, 2/1.5) x strength 0.6");
  const gone = calendarWitness(outlook(Date.parse(CPI) + 5 * H, { releases: [release], stats: { inflation: { samples: 20, horizon_hours: 4, hit_rate: 0.65 } } }));
  assert.equal(gone.lean, null, "past its horizon");
  // On the card and in the quorum: 0.08 of the weight inside a horizon, out of it otherwise.
  const ON = { GLOBAL_DECISION_WEIGHTED: "true" };
  const global = { timeframes: [{ key: "D1", available: true, lean: 0.5 }, { key: "H1", available: true, lean: 0.5 }] };
  const inside = witnessCards({ global, context: { calendar: outlook(Date.parse(CPI) - 3 * H), independent: {} }, env: ON });
  const card = inside.find((c) => c.key === "CALENDAR");
  assert.deepEqual([card.available, card.lean, card.weight, card.phase], [true, -0.8, 0.08, "before"]);
  const outside = witnessCards({ global, context: { calendar: outlook(Date.parse(CPI) - 10 * H), independent: {} }, env: ON });
  assert.equal(outside.find((c) => c.key === "CALENDAR").available, false);
  assert.ok(quorumOf(inside).score < quorumOf(outside).score, "a bearish consensus inside its horizon pulls the quorum");
  assert.equal(witnessCards({ global, context: { calendar: null }, env: {} }).some((c) => c.key === "CALENDAR"), false, "only with the extended witnesses");
});

test("the weights: CALENDAR 0.08, the others' B-11 shares kept outside a horizon; a stored set without it is migrated", () => {
  const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum(EXTENDED_WITNESS_WEIGHTS) - 1) < 1e-9);
  assert.equal(EXTENDED_WITNESS_WEIGHTS.CALENDAR, 0.08);
  assert.deepEqual(witnessWeightsProblems(EXTENDED_WITNESS_WEIGHTS), []);
  // Without CALENDAR the shares are the B-11 ones (D1 0.16 of the rest, to rounding).
  const rest = sum(EXTENDED_WITNESS_WEIGHTS) - EXTENDED_WITNESS_WEIGHTS.CALENDAR - EXTENDED_WITNESS_WEIGHTS.SESSION;
  assert.ok(Math.abs(EXTENDED_WITNESS_WEIGHTS.D1 / rest - 0.16 / 0.98) < 0.001);
  const old = { D1: 0.2, H4: 0.16, H1: 0.12, M15: 0.12, NEWS: 0.08, MACRO: 0.04, STRATEGY: 0.08, KEY_LEVELS: 0.05, REGIME: 0.05, TREND_TF: 0.05, MACRO_DRIVERS: 0.03, SESSION: 0.02 };
  const migrated = withCalendarWeight(old);
  assert.deepEqual(witnessWeightsProblems(migrated), [], JSON.stringify(migrated));
  assert.deepEqual([migrated.CALENDAR, migrated.SESSION, WITNESS_KEYS.length], [0.08, 0.02, 13]);
  assert.ok(migrated.D1 > migrated.H4, "the tuned order is kept");
  assert.equal(withCalendarWeight(EXTENDED_WITNESS_WEIGHTS), EXTENDED_WITNESS_WEIGHTS, "a set with it is left alone");
});

test("the sweep measures the drift before every release whose hour has begun, history included, once", async () => {
  resetEconSchemaCacheForTests();
  const DB = fakeD1();
  // A table from before the column (production): the schema adds pre_json.
  DB.raw.exec("CREATE TABLE econ_releases (release_key TEXT PRIMARY KEY, series TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, currency TEXT NOT NULL, time TEXT NOT NULL, importance INTEGER, actual REAL, forecast REAL, previous REAL, unit TEXT, surprise REAL, surprise_z REAL, gold_direction INTEGER, reaction_json TEXT, fetched_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  DB.raw.prepare("INSERT INTO econ_releases (release_key, series, kind, title, currency, time, forecast, previous, fetched_at, updated_at) VALUES ('k1', 'cpi', 'inflation', 'CPI m/m', 'USD', ?, 0.4, 0.3, 'x', 'x')").run(CPI);
  DB.raw.prepare("INSERT INTO econ_releases (release_key, series, kind, title, currency, time, forecast, previous, fetched_at, updated_at) VALUES ('k2', 'cpi', 'inflation', 'CPI m/m', 'USD', '2026-11-11T13:30:00.000Z', 0.4, 0.3, 'x', 'x')").run();
  const env = { DB, SIGNAL_CACHE: kv(), NEWS_INGESTION: { goldHistory: async () => ({ status: 200, body: { results: [{ ok: true, bars: bars(Date.parse("2026-11-09T00:00:00Z"), 60, (i) => 4000 - i) }] } }) } };
  const r = await refreshEconReleases(env, { now: Date.parse(CPI) + 10 * 60_000, gatedEvents: [] });
  assert.equal(r.pre, 1, JSON.stringify(r));
  assert.match(DB.raw.prepare("SELECT pre_json FROM econ_releases WHERE release_key = 'k1'").get().pre_json, /"consensus":-1/);
  assert.equal(DB.raw.prepare("SELECT pre_json FROM econ_releases WHERE release_key = 'k2'").get().pre_json, null, "not yet released");
  assert.equal((await refreshEconReleases(env, { now: Date.parse(CPI) + 20 * 60_000, gatedEvents: [] })).pre, undefined, "measured once");
  const intel = await calendarIntel(env, { now: Date.parse(CPI) });
  assert.equal(intel.pre_stats.inflation.samples, 1);
});
