// Z6 (read-only study, the PR's v4 replay report): Omega's v4 replay (replayOmega4) over recent 15m decisions with the
// Omega setting zone_sd off and on, each decision given the supply and demand box levels rebuilt from the per-candle
// HUD snapshots (hud:<tf>:<candle_key>, KV) on the 1H, 4H, daily and weekly charts (the 15m boxes are all weak, so
// recorded only: they never reach the signal) and the decision's own recorded key levels (the kept clusters), with
// SD_LEVELS "signal". It reads the JSON saved from read-only queries (D1 SELECTs, KV GET/list) under --data and imports
// the repository's own functions; it prints aggregates only (no row, no price, no account field).
//   node scripts/studies/z6/z6-replay.mjs --data <dir> [--repo <checkout>] [--settings '{"profit_lock_gate":"legacy"}']
// --settings overrides the live Omega settings for a sensitivity run (the report's main run uses the live ones).
// <dir> holds raw_bars.txt (D1 ledger_bars_1m), raw_decisions.txt (D1 engine_decisions, DECISION_SQL's fields and the
// strategy price), raw_snapshots.txt (the HUD snapshots' box fields), raw_ctx.txt (the council verdicts per position and
// 5m bar, the control events, the CDG history, the Omega settings without updated_by, the account profile word).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const REPO = path.resolve(arg("--repo", path.join(here, "..", "..", "..")));
const DATA = path.resolve(arg("--data", path.join(here, "data")));
const { replayOmega4, decisionFromRow, OMEGA4_SIM } = await import(`${REPO}/src/ledger-omega4.mjs`);
const { planIntents, OMEGA_DEFAULTS, zoneGiveback } = await import(`${REPO}/src/omega-engine.mjs`);
const { dsEvidence, zoneTypes, sdLevels } = await import(`${REPO}/src/zone-types.mjs`);

const read = (f) => { const t = fs.readFileSync(path.join(DATA, f), "utf8"); return JSON.parse(t.slice(t.indexOf("{"))); };
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r2 = (x) => (finite(x) ? Math.round(x * 100) / 100 : null);
const TF_MS = { "60": 3600_000, "240": 4 * 3600_000, "1D": 86_400_000, "1W": 7 * 86_400_000 };

const bars = read("raw_bars.txt").bars.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const rows = read("raw_decisions.txt").rows;
const snaps = read("raw_snapshots.txt").snapshots;
const ctx = read("raw_ctx.txt");

// The snapshot each chart had at a bar close: the newest whose candle closed at or before it.
const byTf = {};
for (const [k, s] of Object.entries(snaps)) {
  const [, tf] = k.split(":"), open = Number(k.split(":").at(-1));
  if (!TF_MS[tf] || !finite(open) || !s || s.error) continue;
  (byTf[tf] ??= []).push({ close: open + TF_MS[tf], s });
}
for (const list of Object.values(byTf)) list.sort((a, b) => a.close - b.close);
const at = (tf, ms) => { let best = null; for (const x of byTf[tf] ?? []) if (x.close <= ms) best = x.s; else break; return best; };

let typedHere = 0, withSd = 0, sdSent = 0;
const plain = [], boxed = [];
for (const row of rows) {
  const d = decisionFromRow(row);
  if (!d) continue;
  plain.push(d);
  const close = Date.parse(d.bar_close), price = Number(row.price), atr = Number(row.atr_h1);
  const snapshots = Object.fromEntries(["60", "240", "1D", "1W"].map((tf) => [tf, at(tf, close)]).filter(([, s]) => s));
  const evidence = dsEvidence({ snapshots, bars15: [], atrH1: atr });
  let kept = (Array.isArray(d.key_levels) ? d.key_levels : []).map((z) => ({ ...z }));
  // A decision before Z0 has untyped key levels: typed here on the same evidence (only so the box levels can be told
  // apart in the signal; with zone_mgmt "off" Omega never reads the words).
  if (kept.length && !kept.every((z) => typeof z.zone_type === "string")) {
    typedHere += 1;
    const zs = zoneTypes(kept.map((z) => ({ low: z.low, high: z.high, role: null })), evidence);
    kept = kept.map((z, i) => ({ low: z.low, high: z.high, zone_type: zs[i].ds.type, zone_strength: zs[i].ds.strength, zone_freshness: zs[i].ds.freshness, zone_rank: "candidate" }));
  }
  const sd = finite(price) && finite(atr) ? sdLevels(evidence, kept.map((z) => ({ ...z, candidate: true })), price, atr) : [];
  if (sd.length) withSd += 1;
  sdSent += sd.filter((z) => z.zone_strength === "medium" || z.zone_strength === "strong").length;
  boxed.push({ ...d, key_levels: kept, sd_levels: sd, sd_levels_mode: "signal" });
}

const live = { ...OMEGA_DEFAULTS, ...ctx.settings, ...JSON.parse(arg("--settings", "{}")) };
const from = bars[0].t + OMEGA4_SIM.warmup_ms, to = bars.at(-1).t + 60_000;
const common = {
  bars, from, to, councils: ctx.councils ?? {}, control: ctx.control ?? [], profileAt: () => ctx.profile ?? null,
  ...(live.cd_gate === "on" && Array.isArray(ctx.cd_history) && ctx.cd_history.length ? { cdGate: { history: ctx.cd_history } } : {})
};

// The safety check beside the "on" run: at every planIntents call, the same input with zone_sd "off"; each planned stop
// with the box levels against the one without them (looser at all, looser than the giveback cap) and against the
// position's current stop.
const safety = { calls: 0, stops: 0, tighter: 0, looser: 0, looser_than_cap: 0, loosened_current: 0 };
const watched = (input) => {
  const on = planIntents(input);
  const off = planIntents({ ...input, settings: { ...input.settings, zone_sd: "off" } });
  safety.calls += 1;
  for (const p of input.executor?.positions ?? []) {
    const dir = p.side === "BUY" ? 1 : -1;
    const stop = (out) => { const its = out.intents.filter((i) => (i.kind === "modify_sl" || i.kind === "modify_sltp") && i.ticket === p.ticket && finite(i.sl)); return its.length ? its.at(-1).sl : Number(p.sl); };
    const a = stop(on), b = stop(off);
    if (!finite(a) || !finite(b)) continue;
    safety.stops += 1;
    if (dir * (a - b) > 1e-9) safety.tighter += 1;
    if (dir * (a - b) < -1e-9) safety.looser += 1;
    const cap = zoneGiveback(input.positionMeta?.[p.intent_id] ?? null);
    if (dir * (b - a) > (finite(cap) ? cap : 0) + 1e-9) safety.looser_than_cap += 1;
    if (finite(Number(p.sl)) && Number(p.sl) > 0 && dir * (a - Number(p.sl)) < -1e-9) safety.loosened_current += 1;
  }
  return on;
};

const runs = {
  plain: replayOmega4({ ...common, decisions: plain, settings: { ...live, zone_sd: "off" } }),
  off: replayOmega4({ ...common, decisions: boxed, settings: { ...live, zone_sd: "off" } }),
  on: replayOmega4({ ...common, decisions: boxed, settings: { ...live, zone_sd: "on" }, plan: watched })
};

function stats(run) {
  const recs = Object.values(run.records);
  const closed = recs.filter((r) => r.omega4_status === "closed" && finite(r.r_omega4)).sort((a, b) => Date.parse(a.omega4_closed_at) - Date.parse(b.omega4_closed_at));
  const traded = recs.filter((r) => r.omega4_status === "closed" || r.omega4_status === "open");
  let cum = 0, peak = 0, dd = 0;
  for (const r of closed) { cum += r.r_omega4; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const mods = traded.map((r) => { const j = JSON.parse(r.omega4_json); return (j.sl_moves ?? 0) + (j.tp_moves ?? 0); });
  const partials = traded.map((r) => JSON.parse(r.omega4_json).partials ?? 0);
  const exits = {};
  for (const r of closed) exits[r.omega4_exit] = (exits[r.omega4_exit] ?? 0) + 1;
  return {
    positions: traded.length, closed: closed.length, open: traded.length - closed.length,
    mean_r: closed.length ? r2(cum / closed.length) : null, total_r: r2(cum), worst_r: closed.length ? r2(Math.min(...closed.map((r) => r.r_omega4))) : null,
    best_r: closed.length ? r2(Math.max(...closed.map((r) => r.r_omega4))) : null, max_dd_r: r2(dd),
    modifies_per_position: traded.length ? r2(mods.reduce((s, x) => s + x, 0) / traded.length) : null,
    partials_per_position: traded.length ? r2(partials.reduce((s, x) => s + x, 0) / traded.length) : null, exits
  };
}
const S = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, stats(v)]));
const keys = new Set([...Object.keys(runs.off.records), ...Object.keys(runs.on.records)]);
let differ = 0, better = 0, worse = 0;
for (const k of keys) {
  const a = runs.off.records[k], b = runs.on.records[k];
  if (JSON.stringify(a) === JSON.stringify(b)) continue;
  differ += 1;
  if (finite(a?.r_omega4) && finite(b?.r_omega4)) { if (b.r_omega4 > a.r_omega4 + 1e-9) better += 1; else if (b.r_omega4 < a.r_omega4 - 1e-9) worse += 1; }
}
console.log(JSON.stringify({
  window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), decisions: plain.length, typed_here: typedHere, with_sd: withSd, sd_levels_sent: sdSent },
  live_switches: { zone_mgmt: live.zone_mgmt, profit_lock_gate: live.profit_lock_gate, tp_ladder: live.tp_ladder, pm_fast_1m: live.pm_fast_1m, cd_gate: live.cd_gate },
  off_equals_plain: JSON.stringify(runs.off.records) === JSON.stringify(runs.plain.records),
  stats: S, records_differ: differ, closed_better: better, closed_worse: worse, safety
}, null, 2));
