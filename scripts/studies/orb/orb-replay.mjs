// Track A PR 7 (read-only study, the PR's replay report): the orb_breakout agent (src/strategy-agents.mjs) replayed over
// the recorded 15m Decision Engine closes, each given the 15m bars up to its close, the decision's own price, 1H ATR and
// recorded key levels (the kept set; a level ranked "candidate" is a major zone, and every level counts as one on a
// decision recorded before the zones were ranked), the live TP1 and entry-zone switches, and the high-impact USD releases of the MT5 calendar. Each plan
// becomes a setup as plan learning builds it (setupsFrom) and is scored on the control arm (setupOutcome) on the 15m
// bars, with the lapse at the session window's end. It reads JSON saved from read-only queries (D1 SELECTs, KV GET)
// under --data and imports the repository's own functions; it prints aggregates only (no row, no price).
//   node scripts/studies/orb/orb-replay.mjs --data <dir> [--repo <checkout>]
// <dir> holds raw_bars.txt ({ bars: [[open_ms, open, high, low, close, close_ms]] }, the KV 15m series) and
// raw_decisions.txt ({ rows: [[close_ms, atr_h1, price, mode, regime, [[low, high, rank]], long_agents, short_agents]],
// cal: [[time, currency, importance]] }).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const REPO = path.resolve(arg("--repo", path.join(here, "..", "..", "..")));
const DATA = path.resolve(arg("--data", path.join(here, "data")));
const { STRATEGY_AGENTS, AGENT_RULES } = await import(`${REPO}/src/strategy-agents.mjs`);
const { openingRanges } = await import(`${REPO}/src/opening-range.mjs`);
const { setupsFrom, setupOutcome, CONTROL_ARM } = await import(`${REPO}/src/plan-learning.mjs`);

const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const iso = (ms) => new Date(ms).toISOString();
const M15 = 15 * 60_000;

const bars = read("raw_bars.txt").bars.map(([o, op, h, l, c, cl]) => ({ open_time: iso(o), close_time: iso(cl ?? o + M15), open: op, high: h, low: l, close: c }))
  .sort((a, b) => Date.parse(a.open_time) - Date.parse(b.open_time));
const closeMs = bars.map((b) => Date.parse(b.close_time));
const raw = read("raw_decisions.txt");
const events = raw.cal.map(([time, currency, importance]) => ({ time, currency, impact: importance >= 3 ? "High" : "Medium" }));
const agent = STRATEGY_AGENTS.find((a) => a.id === "orb_breakout");
const lastClose = closeMs.at(-1);

const decisions = [], meta = new Map();
let ranked = 0, unranked = 0;
for (const [t, atr, price, mode, regime, zones, longAgents, shortAgents] of raw.rows) {
  if (!finite(atr) || !finite(price) || atr <= 0) continue;
  const anyRank = zones.some((z) => z[2] > 0);
  anyRank ? ranked++ : unranked++;
  const levels = zones.filter((z) => finite(z[0]) && finite(z[1])).map(([low, high, rank]) => ({ low, high, price: (low + high) / 2, major: anyRank ? rank === 2 : true, key: rank === 2, label: "zone" }));
  // The closed 15m bars up to this close (two days back is more than either window needs).
  let hi = closeMs.length; while (hi > 0 && closeMs[hi - 1] > t) hi--;
  // The live switches: TP1 at the nearest key zone, at least 1R (TP1_KEY_ZONE_MODE on) and the entry zone (ENTRY_ZONE_MODE edge).
  const ctx = { events, strategy: null, scalp: mode === "scalp", regime, basePlan: undefined, patterns: [], calibration: null, suspendedPatterns: [], keyZone: true, entryZone: true, price, atr, levels, bars: bars.slice(Math.max(0, hi - 192), hi) };
  for (const dir of [1, -1]) {
    const p = agent.plan(dir, ctx);
    if (!p) continue;
    const side = dir > 0 ? "BUY" : "SELL", key = `orb:${t}`;
    decisions.push({ key, close_ms: t, decided_at: iso(t), side, entry: p.entry, stop: p.stop, tp1: p.tp1, atr_h1: atr, mode, regime, agent: "orb_breakout", action: p.at_level ? "ENTER_MARKET" : "ENTER_LIMIT", at_level: p.at_level, pattern: p.pattern, chart: p.chart, valid_until_ms: p.valid_until_ms });
    meta.set(`${key}:${side}`, { same: (dir > 0 ? longAgents : shortAgents).length, opposite: (dir > 0 ? shortAgents : longAgents).length, rrr: p.rrr?.tp1 ?? null });
  }
}
decisions.sort((a, b) => a.close_ms - b.close_ms || (a.side < b.side ? -1 : 1));
const setups = setupsFrom(decisions).map((s) => ({ ...s, out: setupOutcome(s, bars, { now: lastClose }) }));

// The session-days the decisions covered and why a range was not traded.
const days = new Map();
for (const [t] of raw.rows) {
  let hi = closeMs.length; while (hi > 0 && closeMs[hi - 1] > t) hi--;
  for (const r of openingRanges(bars.slice(Math.max(0, hi - 192), hi), { events })) {
    if (!finite(r.open_ms)) continue;
    const k = `${r.key}:${r.open_ms}`, d = days.get(k) ?? { key: r.key, statuses: new Set(), width_atr: null };
    d.statuses.add(r.status);
    const row = raw.rows.find((x) => x[0] === t);
    if (r.status === "ok" && finite(row?.[1])) d.width_atr = r.width / row[1];
    days.set(k, d);
  }
}
const blocked = {};
for (const d of days.values()) {
  const b = (blocked[d.key] ??= { session_days: 0, ok: 0, range_event: 0, session_clock_mismatch: 0, range_incomplete_only: 0, too_narrow: 0, too_wide: 0 });
  b.session_days++;
  if (d.statuses.has("ok")) {
    b.ok++;
    if (finite(d.width_atr) && d.width_atr < AGENT_RULES.orb.min_width_atr) b.too_narrow++;
    if (finite(d.width_atr) && d.width_atr > AGENT_RULES.orb.max_width_atr) b.too_wide++;
  } else if (d.statuses.has("range_event")) b.range_event++;
  else if (d.statuses.has("session_clock_mismatch")) b.session_clock_mismatch++;
  else if (d.statuses.has("range_incomplete")) b.range_incomplete_only++;
}

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const group = (list) => {
  const res = list.filter((s) => s.out.status === "resolved" && finite(s.out.results?.[CONTROL_ARM]?.r));
  const x = res.map((s) => s.out.results[CONTROL_ARM]);
  const exits = {};
  for (const r of x) exits[r.s] = (exits[r.s] || 0) + 1;
  const filled = x.filter((r) => r.f === 1);
  const held = res.filter((s) => s.out.results[CONTROL_ARM].f === 1).map((s) => Math.round((s.out.resolved_ms - s.opened_ms) / M15));
  const m = res.map((s) => meta.get(`${s.decision_key}:${s.side}`) ?? {});
  return {
    setups: list.length, resolved: res.length, open_or_unavailable: list.length - res.length,
    fill_rate: res.length ? r3(filled.length / res.length) : null,
    mean_r: res.length ? r3(x.reduce((a, r) => a + r.r, 0) / res.length) : null,
    mean_r_filled: filled.length ? r3(filled.reduce((a, r) => a + r.r, 0) / filled.length) : null,
    exits, median_bars_held_filled: median(held),
    at_level: list.filter((s) => s.at_level).length,
    median_rrr_tp1: median(m.map((q) => q.rrr).filter(finite)),
    with_other_agent_same_side: m.filter((q) => q.same > 0).length, with_other_agent_opposite_side: m.filter((q) => q.opposite > 0).length
  };
};
const by = (f) => Object.fromEntries([...new Set(setups.map(f))].sort().map((k) => [k, group(setups.filter((s) => f(s) === k))]));

console.log(JSON.stringify({
  span: { from: iso(raw.rows[0][0]), to: iso(raw.rows.at(-1)[0]), decisions: raw.rows.length, decisions_with_ranked_levels: ranked, decisions_unranked_levels: unranked, high_usd_events: events.filter((e) => e.impact === "High").length, bars_15m: bars.length },
  plans: decisions.length,
  all: group(setups),
  by_session: by((s) => s.pattern),
  by_side: by((s) => s.side),
  by_session_side: by((s) => `${s.pattern}:${s.side}`),
  by_mode: by((s) => s.mode ?? "none"),
  // Sensitivity only (no rule reads it): the plan's first-target reward to risk.
  by_rrr_tp1: by((s) => { const q = meta.get(`${s.decision_key}:${s.side}`)?.rrr; return !finite(q) ? "unknown" : q < 1 ? "a_below_1" : q < 1.5 ? "b_1_to_1.5" : "c_1.5_plus"; }),
  session_days: blocked
}, null, 2));
