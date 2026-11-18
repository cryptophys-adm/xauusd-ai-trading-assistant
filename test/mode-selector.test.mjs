// Phase 4: the trading-mode selector (owner 2026-11-18, confirmed: "Setuju"). Evidence gate, feasibility, fail-safe
// moves without the council, council-approved switches, the owner's pin, Auto and veto, the mode.v1 digest.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { modeEvidence, modeFeasible, decideMode, moderateMode, runModeSelector, ownerModeAction, modeStatus, modeReport, readModeControl, resetModeSchemaForTests, MODE_CONTROL_KEY } from "../src/mode-selector.mjs";
import { resetAiUsageSchemaCacheForTests } from "../src/ai-usage.mjs";
import { TRADING_MODE_KEY } from "../src/decision-engine.mjs";

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}
const kv = () => { const m = new Map(); return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const NOW = Date.parse("2026-11-18T12:00:00Z");
const DAY = 86_400_000;
// A seeded record per mode: n setups of R r (alternating a little), stop distance `stop`.
const setups = (mode, n, r, stop = 10, regime = "trend") => Array.from({ length: n }, (_, i) => ({ mode, regime, entry: 4000, stop: 4000 - stop, r: r + (i % 2 ? 0.05 : -0.05) }));

function env() {
  resetModeSchemaForTests(); resetAiUsageSchemaCacheForTests();
  const db = d1();
  db.raw.exec("CREATE TABLE plan_setups (setup_key TEXT PRIMARY KEY, mode TEXT, regime TEXT, entry REAL, stop REAL, status TEXT, opened_at TEXT, results_json TEXT)");
  return { DB: db, SIGNAL_CACHE: kv() };
}
const seed = (e, rows) => { let i = 0; for (const s of rows) e.DB.raw.prepare("INSERT INTO plan_setups VALUES (?, ?, ?, ?, ?, 'resolved', ?, ?)").run(`k${i++}`, s.mode, s.regime, s.entry, s.stop, new Date(NOW - 10 * DAY + i * 60_000).toISOString(), JSON.stringify({ "e0@s1": { r: s.r } })); };
const call = (bySeat) => async (_e, req) => {
  const seat = ["strategy", "technical", "risk", "trade_management"].find((s) => req.messages[0].content.includes(`as the ${s.replace("_", " ")} seat`));
  return bySeat[seat] ? { status: "answered", obj: { verdict: bySeat[seat], reason: `${seat} ${bySeat[seat]}` } } : { status: "failed" };
};

test("MS1 evidence per mode (regime first, else all), feasibility at the minimum lot against the profile cap", () => {
  const ev = modeEvidence([...setups("swing", 40, 0.4, 20), ...setups("intraday", 40, -0.2, 10), ...setups("scalp", 5, 1, 3)], { regime: "trend" });
  assert.deepEqual([ev.swing.status, ev.intraday.status, ev.scalp.status], ["pass", "fail", "collecting"]);
  assert.equal(ev.swing.median_stop, 20);
  // $54.50 at 0.01 lot: a 20-dollar stop risks 36.7% (over Safe's 2%); 1000 equity: 2%.
  assert.equal(modeFeasible(ev.swing, { equity: 54.5, volumeMin: 0.01, contractSize: 100, capPct: 2 }), false);
  assert.equal(modeFeasible(ev.swing, { equity: 1000, volumeMin: 0.01, contractSize: 100, capPct: 2 }), true);
});

test("MS2 the decision: fail-safe moves skip the council; a better mode needs two runs in a row and a margin", () => {
  const ev = { scalp: { status: "collecting" }, intraday: { status: "pass", mean_r: 0.15, median_stop: 10 }, swing: { status: "pass", mean_r: 0.4, median_stop: 20 } };
  const all = { scalp: true, intraday: true, swing: true };
  assert.deepEqual(decideMode({ mode: "swing", baseline: "intraday", evidence: ev, feasible: all, forcedDay: true }).action, "revert", "kill or daily loss: back to the baseline");
  assert.deepEqual(decideMode({ mode: "swing", baseline: "intraday", evidence: { ...ev, swing: { status: "fail", mean_r: -0.2 } }, feasible: all }), { action: "revert", to: "intraday", reason: "evidence_failed", streak: null });
  assert.deepEqual(decideMode({ mode: "swing", baseline: "swing", evidence: ev, feasible: { ...all, swing: false } }).to, "intraday", "infeasible: the feasible mode with the smallest stop");
  const first = decideMode({ mode: "intraday", baseline: "intraday", evidence: ev, feasible: all });
  assert.deepEqual([first.action, first.streak], ["none", { candidate: "swing", passes: 1 }]);
  assert.deepEqual(decideMode({ mode: "intraday", baseline: "intraday", evidence: ev, feasible: all, streak: first.streak }).action, "propose");
  assert.equal(decideMode({ mode: "intraday", baseline: "intraday", evidence: { ...ev, swing: { ...ev.swing, mean_r: 0.2 } }, feasible: all }).action, "none", "within the 0.1R margin: no switch");
  assert.equal(moderateMode({ risk: { verdict: "approve" }, strategy: { verdict: "approve" }, technical: { verdict: "approve" }, trade_management: { verdict: "reject" } }).verdict, "approve");
  assert.equal(moderateMode({ risk: { verdict: "reject" }, strategy: { verdict: "approve" }, technical: { verdict: "approve" }, trade_management: { verdict: "approve" } }).verdict, "reject");
});

test("MS3 the daily run: Auto by default; a council approval switches new orders, a rejection keeps the mode; once a day; a pin stops it", async () => {
  const e = env();
  await e.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  seed(e, [...setups("swing", 40, 0.4, 5), ...setups("intraday", 40, 0.05, 5)]);
  const lines = [];
  const r1 = await runModeSelector(e, { now: NOW, regime: "trend", call: call({}), notify: async (t) => lines.push(t) });
  assert.equal(r1.decision.action, "none", "first pass: the candidate holds");
  assert.equal((await runModeSelector(e, { now: NOW + 3600_000, regime: "trend", call: call({}) })).status, "fresh", "once a UTC day");
  const rej = await runModeSelector(e, { now: NOW + DAY, regime: "trend", call: call({ risk: "reject", strategy: "approve", technical: "approve", trade_management: "approve" }), notify: async (t) => lines.push(t) });
  assert.equal(rej.status, "unchanged");
  assert.equal(await e.SIGNAL_CACHE.get(TRADING_MODE_KEY), "intraday");
  assert.match(lines.at(-1), /stays Intraday \(the mode council did not approve: Swing proposed\)/);
  // Two more passes, then an approval.
  await runModeSelector(e, { now: NOW + 2 * DAY, regime: "trend", call: call({}) });
  const ok = await runModeSelector(e, { now: NOW + 3 * DAY, regime: "trend", call: call({ risk: "approve", strategy: "approve", technical: "approve", trade_management: "approve" }), notify: async (t) => lines.push(t) });
  assert.equal(ok.status, "changed");
  assert.equal(await e.SIGNAL_CACHE.get(TRADING_MODE_KEY), "swing");
  assert.match(lines.at(-1), /Trading mode Intraday → Swing \(council, the selector's evidence, approved by the mode council\)\. New orders only/);
  // The owner's veto: back to Intraday, pinned; the selector then does nothing.
  const v = await ownerModeAction(e, { action: "veto", actor: "owner@example.com", now: NOW + 3 * DAY + 60_000 });
  assert.deepEqual([v.ok, v.mode, v.pinned], [true, "intraday", true]);
  assert.equal((await runModeSelector(e, { now: NOW + 4 * DAY, regime: "trend", call: call({}) })).status, "pinned");
  // Auto again.
  await ownerModeAction(e, { action: "auto", actor: "owner@example.com", now: NOW + 4 * DAY + 1 });
  const st = await modeStatus(e);
  assert.deepEqual([st.mode, st.auto, st.pinned], ["intraday", true, false]);
  assert.ok(st.history.length >= 4);
});

test("MS4 the owner's pin is a baseline; no veto without an automatic switch; the server's TRADING_MODE wins; the digest has no price or lot", async () => {
  const e = env();
  await e.SIGNAL_CACHE.put(TRADING_MODE_KEY, "intraday");
  const p = await ownerModeAction(e, { mode: "scalp", actor: "owner@example.com", now: NOW });
  assert.deepEqual([p.ok, p.mode, p.changed, p.pinned], [true, "scalp", true, true]);
  assert.equal((await readModeControl(e)).baseline, "scalp");
  assert.match((await ownerModeAction(e, { action: "veto", actor: "o", now: NOW + 1 })).error, /no automatic switch/);
  assert.equal((await ownerModeAction({ ...e, TRADING_MODE: "swing" }, { mode: "intraday", actor: "o", now: NOW })).error, "pinned_by_server");
  const rows = e.DB.raw.prepare("SELECT * FROM omega_mode_changes").all();
  const d = modeReport(rows);
  assert.equal(d.body.schema, "mode.v1");
  assert.deepEqual(Object.keys(d.body.items[0]).sort(), ["actor", "at", "evidence_ref", "from", "reason", "to"]);
  assert.doesNotMatch(JSON.stringify(d), /lot|price|volume/);
  assert.ok(e.SIGNAL_CACHE.map.has(MODE_CONTROL_KEY));
});

test("MS5 feasibility on a small account drops the mode without the council; kill or daily loss reverts to the baseline", async () => {
  const e = env();
  await e.SIGNAL_CACHE.put(TRADING_MODE_KEY, "swing");
  await e.SIGNAL_CACHE.put(MODE_CONTROL_KEY, JSON.stringify({ auto: true, pinned: false, baseline: "intraday" }));
  seed(e, [...setups("swing", 40, 0.4, 20), ...setups("intraday", 40, 0.2, 8), ...setups("scalp", 40, 0.1, 2)]);
  let asked = 0;
  const r = await runModeSelector(e, { now: NOW, regime: "trend", account: { equity: 54.5, volume_min: 0.01, contract_size: 100, cap_pct: 10 }, call: async () => { asked += 1; return { status: "failed" }; } });
  assert.deepEqual([r.status, r.applied.to, r.applied.reason, asked], ["changed", "scalp", "mode_not_feasible", 0]);
  const e2 = env();
  await e2.SIGNAL_CACHE.put(TRADING_MODE_KEY, "swing");
  await e2.SIGNAL_CACHE.put(MODE_CONTROL_KEY, JSON.stringify({ auto: true, pinned: false, baseline: "intraday" }));
  const k = await runModeSelector(e2, { now: NOW, forcedDay: true, call: async () => { asked += 1; return { status: "failed" }; } });
  assert.deepEqual([k.applied.to, k.applied.reason, asked], ["intraday", "kill_or_daily_loss", 0]);
});
