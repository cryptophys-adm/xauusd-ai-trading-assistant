// RM1a: the report's tables from ../out/rows.json (rm1a-replay.mjs). R and ATR(1H) multiples, counts and shares only.
//   RM1A_DATA=<data dir> node scripts/studies/rm1a/rm1a-tables.mjs   (writes <data dir>/../out/tables.md)
import fs from "node:fs";
import path from "node:path";
import { DATA, finite } from "./common.mjs";
const { meta, rows } = JSON.parse(fs.readFileSync(path.join(DATA, "..", "out", "rows.json"), "utf8"));
const r2 = (x) => (finite(x) ? Math.round(x * 100) / 100 : null);
const mean = (xs) => (xs.length ? r2(xs.reduce((a, x) => a + x, 0) / xs.length) : null);
const traded = (s) => s && (s.status === "closed" || s.status === "open") && finite(s.r);
const T = [];
const fmt = (v) => (v == null ? "–" : v);

// ---------------------------------------------------------------- 1. first pass (move after the close, ATR(1H))
function moveLine(label, xs) {
  const m1 = xs.map((x) => x.move_1h).filter(finite), m4 = xs.map((x) => x.move_4h).filter(finite);
  return `| ${label} | ${xs.length} | ${fmt(mean(m1))} | ${m4.length} | ${fmt(mean(m4))} | ${m4.filter((v) => v >= 1).length} | ${m4.filter((v) => v <= -1).length} |`;
}
const MOVE_HEAD = "| class (WAIT, quorum's side) | n | mean 1h move ATR | n with 4h | mean 4h move ATR | 4h ≥ +1 ATR | 4h ≤ −1 ATR |\n|---|---|---|---|---|---|---|";
const CLASSES = [["room_only", "room the only failing check"], ["room_plus", "room plus another check"], ["other_guard", "another check, room passing"], ["council_wait_all_pass", "council WAIT, all checks pass"], ["overruled_strategy_agents", "overruled: strategy_agents"], ["overruled_strategy_arm", "overruled: strategy_arm"], ["no_quorum_side", "no quorum side"]];
for (const [since, title] of [["2026-11-23", "First pass reproduced (since 2026-11-23)"], ["2026-11-17", "Extended window (since 2026-11-17)"]]) {
  const xs = rows.filter((r) => r.bar_close >= since);
  const st = {}; for (const r of xs) st[r.stance] = (st[r.stance] || 0) + 1;
  T.push(`\n### ${title}\n\ndecisions ${xs.length}: ${Object.entries(st).map(([k, v]) => `${k} ${v}`).join(", ")}\n\n${MOVE_HEAD}`);
  for (const [k, label] of CLASSES) { const g = xs.filter((r) => r.cls === k); if (g.length) T.push(moveLine(label, g)); }
  T.push(moveLine("traded (BUY/SELL), own side", xs.filter((r) => r.cls === "traded")));
}

// ---------------------------------------------------------------- 2. replay
function stats(list, simOf = (x) => x.sim) {
  const t = list.filter((x) => traded(simOf(x))), R = t.map((x) => simOf(x).r);
  return { n: list.length, traded: t.length, total_r: r2(R.reduce((a, x) => a + x, 0)) ?? 0, mean_r: mean(R), win: t.length ? Math.round((R.filter((x) => x > 0).length / t.length) * 100) : null,
    tp: t.filter((x) => simOf(x).exit === "target").length, sl: t.filter((x) => simOf(x).exit === "stop").length, open: t.filter((x) => simOf(x).status === "open").length,
    tp_r: mean(t.map((x) => simOf(x).tp_r).filter(finite)), stop_atr: mean(t.map((x) => simOf(x).stop_atr).filter(finite)), ct: list.filter((x) => x.counter_trend).length,
    m4: mean(list.map((x) => x.move_4h).filter(finite)) };
}
const HEAD = "| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |\n|---|---|---|---|---|---|---|---|---|---|---|";
const line = (label, s) => `| ${label} | ${s.n} | ${s.traded} | ${s.total_r} | ${fmt(s.mean_r)} | ${s.win == null ? "–" : `${s.win}%`} | ${s.tp} / ${s.sl} / ${s.open} | ${fmt(s.tp_r)} | ${fmt(s.stop_atr)} | ${s.ct} | ${fmt(s.m4)} |`;
const group = (list, keyOf, order = null) => { const m = new Map(); for (const x of list) { const k = keyOf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } const keys = order ? order.filter((k) => m.has(k)) : [...m.keys()].sort(); return keys.map((k) => [k, m.get(k)]); };
const table = (title, list, keyOf, order, simOf) => { T.push(`\n**${title}**\n\n${HEAD}`); for (const [k, xs] of group(list, keyOf, order)) T.push(line(k, stats(xs, simOf))); T.push(line("all", stats(list, simOf))); };

const RO = rows.filter((r) => r.cls === "room_only"), RP = rows.filter((r) => r.cls === "room_plus"), TR = rows.filter((r) => r.cls === "traded");
const bucket = (x) => (!finite(x.corridor_atr) ? "n/a" : x.corridor_atr < 0.5 ? "<0.5" : x.corridor_atr < 0.75 ? "0.5–0.75" : x.corridor_atr < 1 ? "0.75–1.0" : x.corridor_atr < 1.25 ? "1.0–1.25" : ">1.25");
const BUCKETS = ["<0.5", "0.5–0.75", "0.75–1.0", "1.0–1.25", ">1.25", "n/a"];
T.push(`\n### Replay of room-blocked WAITs (since 2026-11-17; v4 market entry, plan stop and tp1, PM off, 72h)\n\n${HEAD}`);
T.push(line("room only (main set)", stats(RO)));
T.push(line("room plus other checks", stats(RP)));
T.push(line("room only + room plus", stats([...RO, ...RP])));
T.push(line("comparison: traded BUY/SELL", stats(TR)));
T.push(line("comparison: traded SELL", stats(TR.filter((x) => x.side === "short"))));
T.push(line("comparison: traded BUY", stats(TR.filter((x) => x.side === "long"))));
T.push(line("room only, since 11-23", stats(RO.filter((x) => x.bar_close >= "2026-11-23"))));
T.push(line("traded, since 11-23", stats(TR.filter((x) => x.bar_close >= "2026-11-23"))));
const liftT = RO.filter((x) => x.lifted?.trades);
T.push(line("room only, current decide() would trade (room lifted)", stats(liftT, (x) => x.lifted.sim)));
T.push(line("room only, decide() still holds (agents/arm veto)", stats(RO.filter((x) => !x.lifted?.trades))));

table("Room only by corridor_atr bucket", RO, bucket, BUCKETS);
table("Room only by trading mode × active room (room_atr)", RO, (x) => `${x.mode} @ ${x.room_atr}${x.room_atr_recorded ? "" : " (not recorded: default)"}`);
table("Room only by 1H regime", RO, (x) => x.regime);
table("Room only by quorum side", RO, (x) => (x.side === "long" ? "BUY side" : "SELL side"));
table("Room only by breakout (close beyond the previous bar's corridor edge, quorum's direction)", RO, (x) => (x.breakout_b1 ? "breakout (b1)" : "inside"));
table("Room only by breakout within the last hour (close beyond any of the last 4 bars' corridor edge)", RO, (x) => (x.breakout_b4 ? "breakout (b4)" : "inside"));
table("Room only by room ahead (trade direction) in ATR(1H)", RO, (x) => (!finite(x.ahead_atr) ? "n/a" : x.ahead_atr < 0.25 ? "<0.25" : x.ahead_atr < 0.5 ? "0.25–0.5" : x.ahead_atr < 0.75 ? "0.5–0.75" : "≥0.75"), ["<0.25", "0.25–0.5", "0.5–0.75", "≥0.75", "n/a"]);
table("Room only by trend witness (TREND_TF) vs the trade", RO, (x) => x.trend_side);
table("Room only by day", RO, (x) => x.bar_close.slice(0, 10));
table("Comparison (traded) by corridor_atr bucket", TR, bucket, BUCKETS);
table("Comparison (traded) by day", TR, (x) => x.bar_close.slice(0, 10));

// ---------------------------------------------------------------- 3. variants (release = room-only decisions the variant passes)
const V = [
  ["(a) room ahead only, ≥ 0.25 ATR", (x) => finite(x.ahead_atr) && x.ahead_atr >= 0.25],
  ["(a) room ahead only, ≥ 0.5 ATR", (x) => finite(x.ahead_atr) && x.ahead_atr >= 0.5],
  ["(a) room ahead only, ≥ 1.0 ATR (the current number)", (x) => finite(x.ahead_atr) && x.ahead_atr >= 1],
  ["(b) waived on a breakout close (b1: previous bar's corridor)", (x) => x.breakout_b1],
  ["(b) waived on a breakout close (b4: any of the last hour's corridors)", (x) => x.breakout_b4],
  ["(c) corridor_atr 0.75", (x) => finite(x.corridor_atr) && x.corridor_atr >= 0.75],
  ["(c) corridor_atr 0.5", (x) => finite(x.corridor_atr) && x.corridor_atr >= 0.5],
  ["(d1) with-trend only (TREND_TF with the trade), no room", (x) => x.trend_side === "with"],
  ["(d2) corridor_atr 0.75 and with-trend", (x) => finite(x.corridor_atr) && x.corridor_atr >= 0.75 && x.trend_side === "with"],
  ["(d3) corridor_atr 0.5 and with-trend", (x) => finite(x.corridor_atr) && x.corridor_atr >= 0.5 && x.trend_side === "with"],
  ["(d5) the plan's tp1 lies inside the room ahead (target before the opposing zone)", (x) => finite(x.rebuilt?.tp_atr) && finite(x.ahead_atr) && x.rebuilt.tp_atr <= x.ahead_atr + 1e-9],
  ["(d6) (b4) breakout and with-trend", (x) => x.breakout_b4 && x.trend_side === "with"],
  ["(d4) room guard off (every room-only WAIT)", () => true]
];
// Traded positions (the comparison replay) on a side, as [fill, exit] spans: a release inside one adds no new position live.
const lastMs = Date.parse(meta.last_bar);
const spans = TR.filter((x) => traded(x.sim)).map((x) => { const f = Date.parse(x.bar_close) + x.sim.wait_min * 60_000; return { side: x.side, from: f, to: x.sim.hold_min != null ? f + x.sim.hold_min * 60_000 : lastMs }; });
const covered = (x) => spans.some((s) => s.side === x.side && Date.parse(x.bar_close) >= s.from && Date.parse(x.bar_close) < s.to);
// One position at a time: the first release of each episode (releases more than 60 minutes apart start a new one).
const firstOfEpisodes = (list) => { const out = []; let prev = -Infinity; for (const x of [...list].sort((a, b) => a.bar_close.localeCompare(b.bar_close))) { const t = Date.parse(x.bar_close); if (t - prev > 60 * 60_000) out.push(x); prev = t; } return out; };
const VHEAD = "| variant | released | replayed | mean R | total R | win | counter-trend | not inside a traded position | first per episode (of those): n / replayed / mean R / total R / win |\n|---|---|---|---|---|---|---|---|---|";
const vline = (label, list, simOf = (x) => x.sim) => { const s = stats(list, simOf); const inc = list.filter((x) => !covered(x)); const e = stats(firstOfEpisodes(inc), simOf);
  return `| ${label} | ${s.n} | ${s.traded} | ${fmt(s.mean_r)} | ${s.total_r} | ${s.win == null ? "–" : `${s.win}%`} | ${s.ct} | ${inc.length} | ${e.n} / ${e.traded} / ${fmt(e.mean_r)} / ${e.total_r} / ${e.win == null ? "–" : `${e.win}%`} |`; };
T.push(`\n### Softer variants: the room-only WAITs each would release (same replay)\n\n${VHEAD}`);
for (const [label, keep] of V) T.push(vline(label, RO.filter(keep)));
{ const s = stats(TR), e = stats(firstOfEpisodes(TR)); T.push(`| **baseline: traded BUY/SELL** | ${s.n} | ${s.traded} | ${s.mean_r} | ${s.total_r} | ${s.win}% | ${s.ct} | – | ${e.n} / ${e.traded} / ${e.mean_r} / ${e.total_r} / ${e.win}% |`); }
T.push(`\n**The same, only the releases the current decide() would also trade (room lifted; the agents' and arm vetoes as now; R of that trade)**\n\n${VHEAD}`);
for (const [label, keep] of V) T.push(vline(label, RO.filter((x) => keep(x) && x.lifted?.trades), (x) => x.lifted.sim));
T.push(`\n**Variants in full (rebuilt plan)**\n\n${HEAD}`);
for (const [label, keep] of V) T.push(line(label, stats(RO.filter(keep))));

// Overlaps.
const sets = [...V.slice(0, 7), V[10]].map(([label, keep]) => [label.split(" ")[0] + " " + label.split(", ").at(-1).replace(/\(.*?\)/g, "").trim(), new Set(RO.filter(keep).map((x) => x.decision_key))]);
T.push(`\n**Overlaps between variants (room-only releases in both)**\n\n| | ${sets.map(([l]) => l).join(" | ")} |\n|---|${sets.map(() => "---").join("|")}|`);
for (const [la, a] of sets) T.push(`| ${la} | ${sets.map(([, b]) => [...a].filter((k) => b.has(k)).length).join(" | ")} |`);

// ---------------------------------------------------------------- 4. not replayed
const why = (list) => Object.fromEntries(group(list.filter((x) => !traded(x.sim)), (x) => `${x.sim?.status}:${x.sim?.gate ?? x.sim?.exit}`).map(([k, v]) => [k, v.length]));
T.push(`\n### Not replayed\n\nroom only: ${JSON.stringify(why(RO))}\n\nroom plus: ${JSON.stringify(why(RP))}\n\ntraded: ${JSON.stringify(why(TR))}`);
T.push(`\ncurrent decide() with the room lifted (room only): ${JSON.stringify(Object.fromEntries(group(RO, (x) => (x.lifted?.trades ? (x.lifted.same_as_rebuild ? "trades, same plan as the rebuild" : "trades, another plan") : `held: ${x.lifted?.held}`)).map(([k, v]) => [k, v.length])))}`);
T.push(`\nexits: room only ${JSON.stringify(Object.fromEntries(group(RO.filter((x) => traded(x.sim)), (x) => x.sim.exit).map(([k, v]) => [k, v.length])))}; traded ${JSON.stringify(Object.fromEntries(group(TR.filter((x) => traded(x.sim)), (x) => x.sim.exit).map(([k, v]) => [k, v.length])))}`);
T.push(`\nmeta: ${JSON.stringify({ ...meta, last_bar: meta.last_bar.slice(0, 16), first_feed: meta.first_feed.slice(0, 16) })}`);
const text = T.join("\n");
fs.writeFileSync(path.join(DATA, "..", "out", "tables.md"), text + "\n");
console.log(text);
