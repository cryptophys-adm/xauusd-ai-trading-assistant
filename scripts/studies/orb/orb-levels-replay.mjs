// Track A PR 8 (read-only study, the PR's report): the opening-range edges as key levels, on and off, over the stored
// strategy captures (D1 strategy_inputs: the slim inputs buildStrategy reads, gzip). Each capture is built twice, with
// the edges on (today's default) and with modes.orbLevels "off", and every strategy agent's plan on both sides is
// computed from each (agentContext with the live TP1 key-zone and entry-zone switches, every agent live). It reads JSON
// saved from read-only queries under --data (raw_inputs_*.txt: { rows: [[candle_key, inputs_gz]] }) and imports the
// repository's own functions; it prints aggregates only (no row, no price).
//   node scripts/studies/orb/orb-levels-replay.mjs --data <dir> [--repo <checkout>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const REPO = path.resolve(arg("--repo", path.join(here, "..", "..", "..")));
const DATA = path.resolve(arg("--data", path.join(here, "data")));
const se = await import(`${REPO}/src/strategy-engine.mjs`);
const { gunzipJson } = await import(`${REPO}/src/strategy-inputs.mjs`);
const { agentContext, agentPlans, AGENT_IDS } = await import(`${REPO}/src/strategy-agents.mjs`);
const { openingRanges } = await import(`${REPO}/src/opening-range.mjs`);

const rows = fs.readdirSync(DATA).filter((f) => /^raw_inputs_\d+\.txt$/.test(f)).sort()
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")).rows);
const live = Object.fromEntries(AGENT_IDS.map((id) => [id, "live"]));
const edgesOf = (s) => s.key_levels.zones.flatMap((z) => (z.members ?? []).filter((m) => /opening range/.test(m.label)));
const candKey = (s) => JSON.stringify(s.key_levels.zones.filter((z) => z.candidate).map((z) => [z.low, z.high, z.role]));
const plansOf = (slim, strategy) => {
  const out = {};
  for (const [side, dir] of [["long", 1], ["short", -1]]) {
    const ctx = agentContext({ strategy, bars: slim.m15Bars ?? [], regime: null, scalp: false, keyZone: true, entryZone: true });
    out[side] = agentPlans(dir, ctx, live);
  }
  return out;
};

const t = { captures: 0, errors: 0, live_window: 0, with_edges: 0, edge_levels: 0, zones_touched: 0, zone_count_changed: 0, candidates_changed: 0, candidate_joined_by_edge: 0, candidate_count_up: 0, candidate_count_down: 0, candidates_moved_same_count: 0, candidate_only_with_edge: 0, direction_changed: 0, decision_changed: 0 };
const plan = { compared: 0, appeared: 0, vanished: 0, tp1_moved: 0, stop_moved: 0, entry_moved: 0, unchanged: 0 };
const byAgent = {};
const sessions = { orb_london: 0, orb_new_york: 0 };
for (const [, gz] of rows) {
  let slim;
  try { slim = await gunzipJson(gz); } catch { t.errors++; continue; }
  t.captures++;
  try {
    const ranges = openingRanges(slim.m15Bars ?? []).filter((r) => r.status === "ok");
    if (ranges.length) t.live_window++;
    for (const r of ranges) sessions[r.key]++;
    const on = se.buildStrategy(slim);
    const off = se.buildStrategy({ ...slim, modes: { ...(slim.modes ?? {}), orbLevels: "off" } });
    const e = edgesOf(on);
    if (e.length) t.with_edges++;
    t.edge_levels += e.length;
    t.zones_touched += on.key_levels.zones.filter((z) => (z.members ?? []).some((m) => /opening range/.test(m.label))).length;
    if (on.key_levels.zones.length !== off.key_levels.zones.length) t.zone_count_changed++;
    if (candKey(on) !== candKey(off)) t.candidates_changed++;
    const nOn = on.key_levels.zones.filter((z) => z.candidate).length, nOff = off.key_levels.zones.filter((z) => z.candidate).length;
    if (nOn > nOff) t.candidate_count_up++; else if (nOn < nOff) t.candidate_count_down++; else if (candKey(on) !== candKey(off)) t.candidates_moved_same_count++;
    // A candidate zone whose families without the edges' session family would be fewer than three (the edge made the third).
    t.candidate_only_with_edge += on.key_levels.zones.filter((z) => z.candidate && (z.members ?? []).some((m) => /opening range/.test(m.label)) && !(z.members ?? []).some((m) => !/opening range/.test(m.label) && m.kind && ["open", "session profile"].includes(m.kind)) && (z.families ?? []).length - 1 < 3).length;
    t.candidate_joined_by_edge += on.key_levels.zones.filter((z) => z.candidate && (z.members ?? []).some((m) => /opening range/.test(m.label))).length;
    if (on.direction !== off.direction) t.direction_changed++;
    if (on.decision !== off.decision) t.decision_changed++;
    const pOn = plansOf(slim, on), pOff = plansOf(slim, off);
    for (const side of ["long", "short"]) for (const id of AGENT_IDS) {
      const a = pOn[side][id]?.plan ?? null, b = pOff[side][id]?.plan ?? null;
      if (!a && !b) continue;
      plan.compared++;
      const g = (byAgent[id] ??= { changed: 0, compared: 0 });
      g.compared++;
      if (a && !b) { plan.appeared++; g.changed++; continue; }
      if (!a && b) { plan.vanished++; g.changed++; continue; }
      const moved = (k) => a[k] !== b[k];
      if (moved("tp1")) plan.tp1_moved++;
      if (moved("stop")) plan.stop_moved++;
      if (moved("entry")) plan.entry_moved++;
      if (moved("tp1") || moved("stop") || moved("entry")) g.changed++; else plan.unchanged++;
    }
  } catch (err) { t.errors++; }
}
console.log(JSON.stringify({ span: { captures: rows.length, first: rows[0]?.[0]?.split(":").slice(0, 3).join(":") }, ranges_live: sessions, totals: t, plans: plan, by_agent: Object.fromEntries(Object.entries(byAgent).filter(([, g]) => g.changed)) }, null, 2));
