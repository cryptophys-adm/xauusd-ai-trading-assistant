// SV1a: what the strategy-agent vetoes (overruled.by strategy_agents / strategy_arm) held back, replayed with v4's entry
// and the broker's stop and target (Position Manager off). Read-only study: reads the JSON saved under ./data, imports the
// repository's own functions, writes <data>/../out/*.json and prints the tables in the SV1b PR body (#563 era, 2026-11-24).
//   node scripts/studies/sv1a-veto-replay.mjs --data <dir> [--repo <checkout>] [--horizon-h 72]
// <dir> holds feed_bars.json (D1 ledger_bars_1m), corpus_bars.json (D1 corpus_bars, the broker's demo bars; pass the
// series key with --corpus-key), decisions.json (D1 decision records since 2026-11-17) and ledger_omega4.json, each pulled
// with read-only SELECTs (see sv1a-extract.mjs). Market data and decision records only; no account fields.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const REPO = path.resolve(arg("--repo", path.join(here, "..", "..")));
const DATA = path.resolve(arg("--data", path.join(here, "data")));
const CORPUS_KEY = arg("--corpus-key", "<broker-corpus-key>");
const HORIZON_MS = Number(arg("--horizon-h", 72)) * 3600_000;
const SINCE = "2026-11-17T00:00:00.000Z";

const { replayOmega4, decisionFromRow } = await import(`${REPO}/src/ledger-omega4.mjs`);
const { decide, tradeFor, LEAN, MIN_CONFIDENCE } = await import(`${REPO}/src/decision-engine.mjs`);
const { planIntents, OMEGA_DEFAULTS } = await import(`${REPO}/src/omega-engine.mjs`);
const { DEFAULT_AGENT } = await import(`${REPO}/src/strategy-agents.mjs`);

const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
const r2 = (x) => Math.round(x * 100) / 100, r3 = (x) => Math.round(x * 1000) / 1000;
const finite = (x) => typeof x === "number" && Number.isFinite(x);

// ---------------------------------------------------------------- bars
// The feed's 1m bars (D1 ledger_bars_1m) start 2026-11-17 23:04 UTC. Before that, the broker's demo GOLD bars
// (D1 corpus_bars) shifted by the median feed-minus-broker basis over the minutes both have.
const feed = read("feed_bars.json").bars.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const corpus = (read("corpus_bars.json").bars[CORPUS_KEY] ?? []).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
const feedAt = new Map(feed.map((b) => [b.t, b]));
const diffs = corpus.filter((b) => feedAt.has(b.t)).map((b) => feedAt.get(b.t).c - b.c).sort((a, b) => a - b);
const BASIS = diffs.length ? Math.round(diffs[diffs.length >> 1] / 0.005) * 0.005 : 0;
const firstFeed = feed[0].t;
const shifted = corpus.filter((b) => b.t < firstFeed).map((b) => ({ t: b.t, o: r3(b.o + BASIS), h: r3(b.h + BASIS), l: r3(b.l + BASIS), c: r3(b.c + BASIS) }));
const m1 = [...shifted, ...feed].sort((a, b) => a.t - b.t);
const lastBarMs = m1.at(-1).t;

// ---------------------------------------------------------------- decisions
const rows = read("decisions.json").filter((r) => r.bar_close >= SINCE);
const ledger = new Map(read("ledger_omega4.json").rows.map((r) => [r.decision_key, r]));
const VETOES = ["strategy_agents", "strategy_arm"];
const recs = rows.map((r) => JSON.parse(r.decision_json));
const blocks = recs.filter((d) => VETOES.includes(d.overruled?.by));
const passed = recs.filter((d) => d.stance === "SELL" && !d.overruled && d.trade);

const cardOf = (d, key) => (d.witnesses || []).find((w) => w.key === key) ?? null;
const plansOf = (side) => Object.fromEntries(Object.entries(side || {}).map(([id, p]) => {
  const { status, ...plan } = p;
  return [id, { status, plan: finite(plan.entry) ? { ...plan, agent: id } : null }];
}));
/** The guards decide() reads, rebuilt from the record (allowed, checks, plans, reward rule, consensus, arms, confidences). */
function guardsOf(d) {
  const sa = cardOf(d, "STRATEGY_AGENTS");
  const g = (side) => ({ allowed: d.guardrails?.[side]?.allowed === true, checks: d.guardrails?.[side]?.checks ?? [], plans: plansOf(d.strategy_plans?.[side]),
    min_rrr: d.rules?.min_rrr, target_rule: d.trading_mode === "scalp" ? "nearest" : "rrr", entry_trigger: d.guardrails?.[side]?.entry_trigger ?? null });
  return {
    long: g("long"), short: g("short"), strategy_execution: d.strategy_execution === true,
    consensus: sa ? { lean: sa.lean, long: sa.voices?.long ?? [], short: sa.voices?.short ?? [] } : null,
    ...(d.armed ? { arms: { mode: d.armed.mode, version: d.armed.version, ids: d.armed.ids ?? [], known: true } } : {}),
    agent_confidence: d.agent_confidence ?? null
  };
}
// The council's own answer is not stored beyond stance and confidence: every recorded SELL is a limit, tp1 (or the mode's
// alternative), so the rebuilt answer is the same; the council's strategy choice is unknown (null: the strongest voice).
const answerOf = (d) => ({ stance: "SELL", bias: d.bias, confidence: d.confidence, entry_type: "limit", target: "tp1" });
/** decide() on the record with `edit(guards)` applied: the current code's outcome with one rule changed. */
function decideWith(d, edit = (g) => g) {
  const guards = edit(guardsOf(d));
  return decide({ answer: answerOf(d), guards, strategy: d.strategy, quorum: d.quorum });
}

/** Facts per decision for the splits. */
function factsOf(d) {
  const sa = cardOf(d, "STRATEGY_AGENTS");
  const lean = finite(sa?.lean) ? sa.lean : null;
  const opp = sa?.voices?.long ?? [], own = sa?.voices?.short ?? [];
  const armedIds = d.armed?.mode === "live" ? d.armed.ids ?? [] : [];
  const armedOpp = opp.filter((x) => armedIds.includes(x.id)).map((x) => ({ id: x.id, conf_long: d.agent_confidence?.[x.id]?.long ?? null }));
  const h1 = cardOf(d, "H1")?.lean, trend = cardOf(d, "TREND_TF")?.lean;
  const word = (v) => (!finite(v) ? "n/a" : v <= -LEAN ? "with (bearish)" : v >= LEAN ? "against (bullish)" : "neutral");
  return {
    lean, lean_against: finite(lean) ? r2(lean) : null, opp_n: opp.length, own_n: own.length, opp_ids: opp.map((x) => x.id), own_ids: own.map((x) => x.id),
    opp_voice: r2(opp.reduce((s, x) => s + x.voice, 0)), own_voice: r2(own.reduce((s, x) => s + x.voice, 0)),
    default_opposes: opp.some((x) => x.id === DEFAULT_AGENT), arm_mode: d.armed?.mode === "live" ? (armedIds.length ? "armed" : "auto") : "none", armed_ids: armedIds, armed_opp: armedOpp,
    mode: d.trading_mode, regime: d.context?.regime_1h ?? "n/a", regime_kind: String(d.context?.regime_1h ?? "n/a").split("-").pop(),
    h1_lean: h1 ?? null, h1_side: word(h1), trend_lean: trend ?? null, trend_side: word(trend), quorum_score: d.quorum?.score ?? null, atr_h1: d.strategy?.atr_h1 ?? null
  };
}

/** The trade the brief asks for: the strongest wanted-side speaker's plan, else the default agent's; tp1 under the mode's reward rule. */
function rebuildTrade(d) {
  const g = guardsOf(d).short;
  const speakers = [...(cardOf(d, "STRATEGY_AGENTS")?.voices?.short ?? [])].sort((a, b) => (b.voice - a.voice) || (a.id === DEFAULT_AGENT ? -1 : b.id === DEFAULT_AGENT ? 1 : 0));
  const sp = speakers.find((x) => g.plans?.[x.id]?.plan);
  const id = sp ? sp.id : g.plans?.[DEFAULT_AGENT]?.plan ? DEFAULT_AGENT : null;
  if (!id) return { trade: null, from: "none", why: "no wanted-side speaker and no default plan on the record" };
  const opts = { entryType: "limit", target: "tp1", minRrr: finite(g.min_rrr) ? g.min_rrr : 0 };
  const t = tradeFor("SELL", g.plans[id].plan, opts);
  if (t) return { trade: { ...t, agent: id }, from: sp ? "speaker" : "default", rule_ok: true };
  // The mode's reward rule refuses both targets: replayed on tp1 anyway, flagged (rule_ok false).
  const p = g.plans[id].plan;
  return { trade: { side: "SELL", action: "ENTER_LIMIT", entry: p.entry, stop: p.stop, target: "tp1", tp: p.tp1, tp1: p.tp1, tp2: p.tp2, rrr: p.rrr?.tp1 ?? null, at_level: p.at_level === true, agent: id }, from: sp ? "speaker" : "default", rule_ok: false };
}

// ---------------------------------------------------------------- replay (v4 entry; the broker's SL/TP only)
const SETTINGS = { ...OMEGA_DEFAULTS, pm_fast_1m: "off", reentry_1m: "off" };
function replay(d, trade) {
  const synthetic = { decision_key: d.decision_key, stance: "SELL", decided_at: d.decided_at, bar_close: d.bar_close, confidence: d.confidence, trade,
    guardrails: { long: { entry_trigger: d.guardrails?.long?.entry_trigger ?? null }, short: { entry_trigger: d.guardrails?.short?.entry_trigger ?? null } },
    quorum: d.quorum, key_levels: d.key_levels ?? [], agent_confidence: d.agent_confidence ?? null, agent_confidence_prev: d.agent_confidence_prev ?? null,
    trading_mode: d.trading_mode, strategy_execution: d.strategy_execution === true, context: { regime_1h: d.context?.regime_1h ?? null }, strategy: { atr_h1: d.strategy?.atr_h1 ?? null } };
  const D = decisionFromRow({ decision_json: JSON.stringify(synthetic) });
  const opens = [];
  // The Position Manager, the strategy exits, the ladder and every other management intent are dropped: only v4's open
  // reaches the simulated account, which then exits at the broker's stop or target (or is marked at the horizon).
  const plan = (input) => { const out = planIntents(input); const keep = out.intents.filter((it) => it.kind === "open"); for (const it of keep) opens.push(it); return { ...out, intents: keep }; };
  const res = replayOmega4({ bars: m1, decisions: [D], from: D.close_ms, to: D.close_ms + HORIZON_MS, settings: SETTINGS, balanceAt: () => 100_000, plan });
  const rec = res.records[d.decision_key];
  if (!rec) return { status: "no_record" };
  const j = JSON.parse(rec.omega4_json || "{}");
  if (rec.omega4_status === "skipped" || rec.omega4_status === "pending") return { status: rec.omega4_status, gate: rec.omega4_gate };
  const it = opens[0];
  const stopDist = it ? Math.abs(it.entry - it.sl) : null, atr = d.strategy?.atr_h1;
  const toAtr = (r) => (finite(r) && finite(stopDist) && finite(atr) && atr > 0 ? r2((r * stopDist) / atr) : null);
  const open = rec.omega4_status === "open";
  const R = open ? j.open_r : rec.r_omega4;
  return { status: rec.omega4_status, exit: open ? "open_at_horizon" : rec.omega4_exit, r: finite(R) ? r3(R) : null, filled_at: rec.omega4_filled_at, closed_at: rec.omega4_closed_at,
    wait_min: Math.round((Date.parse(rec.omega4_filled_at) - D.close_ms) / 60_000), hold_min: rec.omega4_closed_at ? Math.round((Date.parse(rec.omega4_closed_at) - Date.parse(rec.omega4_filled_at)) / 60_000) : null,
    stop_source: it?.stop_source ?? null, stop_atr: finite(stopDist) && finite(atr) ? r2(stopDist / atr) : null, tp_r: it && stopDist ? r2(Math.abs(it.tp - it.entry) / stopDist) : null,
    mfe_r: j.mfe_r, mae_r: j.mae_r, mfe_atr: toAtr(j.mfe_r), mae_atr: toAtr(j.mae_r), entry_notes: j.entry_notes ?? [] };
}

// ---------------------------------------------------------------- run
const out = [];
for (const d of blocks) {
  const f = factsOf(d);
  const rb = rebuildTrade(d);
  const sim = rb.trade ? replay(d, rb.trade) : { status: "not_rebuilt", gate: rb.why };
  // Checks of the rebuild: decide() on the record as it was must give the recorded veto.
  const asWas = decideWith(d);
  const reproduced = asWas.overruled?.by === d.overruled.by && asWas.overruled?.failed?.[0]?.detail === d.overruled.failed?.[0]?.detail;
  // The current code with this veto lifted (lean ignored; the armed agents' setups on the other side ignored).
  const lifted = decideWith(d, (g) => ({ ...g, consensus: g.consensus ? { ...g.consensus, lean: null, long: [] } : g.consensus }));
  // SV1b: the lean veto only with >= 2 opposing speakers or a lean against >= 0.35; the arm veto only when an armed agent
  // on the other side has confidence >= MIN_CONFIDENCE there.
  const leanVeto = finite(f.lean) && f.lean >= LEAN && (f.opp_n >= 2 || f.lean >= 0.35);
  const armVeto = f.armed_opp.some((x) => finite(x.conf_long) && x.conf_long >= MIN_CONFIDENCE);
  const sv1b = decideWith(d, (g) => ({ ...g, consensus: g.consensus ? { ...g.consensus, lean: leanVeto ? g.consensus.lean : null, long: armVeto ? g.consensus.long : [] } : g.consensus }));
  const tradeSame = (t) => t && rb.trade && t.agent === rb.trade.agent && t.entry === rb.trade.entry && t.stop === rb.trade.stop && t.tp === rb.trade.tp;
  const simOf = (t) => (!t ? null : tradeSame(t) ? sim : replay(d, t));
  out.push({
    decision_key: d.decision_key, bar_close: d.bar_close, by: d.overruled.by, detail: d.overruled.failed?.[0]?.detail ?? null, confidence: d.confidence, ...f,
    rebuilt: rb.trade ? { from: rb.from, agent: rb.trade.agent, target: rb.trade.target, rrr: rb.trade.rrr, at_level: rb.trade.at_level, rule_ok: rb.rule_ok } : null, sim,
    reproduced, lifted: { overruled: lifted.overruled ? lifted.overruled.failed?.[0]?.detail : null, agent: lifted.trade?.agent ?? null, same_as_rebuild: Boolean(tradeSame(lifted.trade)), sim: simOf(lifted.trade) },
    sv1b: { lean_veto: leanVeto, arm_veto: armVeto, overruled: sv1b.overruled ? `${sv1b.overruled.by}: ${sv1b.overruled.failed?.[0]?.detail}` : null, agent: sv1b.trade?.agent ?? null, sim: simOf(sv1b.trade) }
  });
}

const cmp = [];
for (const d of passed) {
  const f = factsOf(d);
  const sim = replay(d, d.trade);
  const l = ledger.get(d.decision_key);
  cmp.push({ decision_key: d.decision_key, bar_close: d.bar_close, ...f, agent: d.trade.agent ?? null, sim, ledger_v4: l ? { status: l.omega4_status, gate: l.omega4_gate, exit: l.omega4_exit, r: l.r_omega4 } : null });
}

fs.mkdirSync(path.join(DATA, "..", "out"), { recursive: true });
fs.writeFileSync(path.join(DATA, "..", "out", "blocks.json"), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(DATA, "..", "out", "passed_sells.json"), JSON.stringify(cmp, null, 1));

// ---------------------------------------------------------------- tables
const traded = (s) => s && (s.status === "closed" || s.status === "open") && finite(s.r);
function stats(list, simOf = (x) => x.sim) {
  const t = list.map(simOf).filter(traded);
  const R = t.map((s) => s.r);
  const mean = (xs) => (xs.length ? r2(xs.reduce((a, x) => a + x, 0) / xs.length) : null);
  return { n: list.length, traded: t.length, total_r: r2(R.reduce((a, x) => a + x, 0)), mean_r: mean(R), win: t.length ? Math.round((R.filter((x) => x > 0).length / t.length) * 100) : null,
    mfe_atr: mean(t.map((s) => s.mfe_atr).filter(finite)), mae_atr: mean(t.map((s) => s.mae_atr).filter(finite)), open: t.filter((s) => s.status === "open").length };
}
const line = (label, s) => `| ${label} | ${s.n} | ${s.traded} | ${s.total_r} | ${s.mean_r ?? "–"} | ${s.win ?? "–"}% | ${s.mfe_atr ?? "–"} | ${s.mae_atr ?? "–"} | ${s.open} |`;
const HEAD = "| split | n | traded | total R | mean R | win | MFE ATR | MAE ATR | open at horizon |\n|---|---|---|---|---|---|---|---|---|";
const group = (list, keyOf, order = null) => {
  const m = new Map();
  for (const x of list) { const k = keyOf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  const keys = order ? order.filter((k) => m.has(k)) : [...m.keys()].sort();
  return keys.map((k) => [k, m.get(k)]);
};
const bucket = (x) => (!finite(x.lean) || x.lean < 0.15 ? "<15" : x.lean < 0.25 ? "15–24" : x.lean < 0.35 ? "25–34" : x.lean < 0.5 ? "35–49" : "≥50");
const oppB = (x) => (x.opp_n >= 3 ? "3+" : String(x.opp_n));
const T = [];
const table = (title, list, keyOf, order) => { T.push(`\n**${title}**\n\n${HEAD}`); for (const [k, xs] of group(list, keyOf, order)) T.push(line(k, stats(xs))); T.push(line("all", stats(list))); };

T.push(`bars: ${m1.length} (feed ${feed.length}, broker demo before the feed ${shifted.length}, basis ${BASIS}); horizon ${HORIZON_MS / 3600_000}h; last bar ${new Date(lastBarMs).toISOString()}`);
T.push(`blocks: ${out.length} (${out.filter((x) => x.by === "strategy_agents").length} strategy_agents, ${out.filter((x) => x.by === "strategy_arm").length} strategy_arm); decide() reproduces the recorded veto on ${out.filter((x) => x.reproduced).length}`);
const ag = out.filter((x) => x.by === "strategy_agents");
table("By veto source", out, (x) => x.by);
table("By veto source x lean bucket", out, (x) => `${x.by} ${bucket(x)}`);
table("strategy_agents by lean-against bucket", ag, bucket, ["15–24", "25–34", "35–49", "≥50"]);
table("All blocks by opposing speakers", out, oppB, ["0", "1", "2", "3+"]);
table("All blocks by trading mode", out, (x) => x.mode);
table("All blocks by 1H regime", out, (x) => x.regime);
table("All blocks by the H1 room's lean (vs the SELL)", out, (x) => x.h1_side);
table("All blocks by the trend witness (TREND_TF) lean", out, (x) => x.trend_side);
table("By day", out, (x) => x.bar_close.slice(0, 10));
T.push(`\n**Comparison: SELLs that passed (same days, same replay)**\n\n${HEAD}`);
T.push(line("passed SELLs (replay)", stats(cmp)));
for (const [k, xs] of group(cmp, (x) => x.bar_close.slice(0, 10))) T.push(line(`passed ${k}`, stats(xs)));
const lv = cmp.filter((x) => x.ledger_v4?.status === "closed");
T.push(`\npassed SELLs the live v4 ledger closed (PM on, one account): ${lv.length}, total R ${r2(lv.reduce((a, x) => a + x.ledger_v4.r, 0))}, mean ${lv.length ? r2(lv.reduce((a, x) => a + x.ledger_v4.r, 0) / lv.length) : "–"}; this replay on the same ${lv.length}: ${JSON.stringify(stats(lv))}`);
T.push(`\n**Lifting the veto under the current code (decide() with that veto off)**`);
const liftOk = out.filter((x) => !x.lifted.overruled);
T.push(`would trade: ${liftOk.length}; still held by the next check: ${out.length - liftOk.length} (${JSON.stringify(Object.fromEntries(group(out.filter((x) => x.lifted.overruled), (x) => x.lifted.overruled).map(([k, v]) => [k, v.length])))}); same trade as the rebuild: ${liftOk.filter((x) => x.lifted.same_as_rebuild).length}`);
T.push(`${HEAD}\n${line("lifted, would trade", stats(liftOk, (x) => x.lifted.sim))}`);
T.push(`\n**SV1b (lean veto only with >= 2 opposing speakers or lean >= 0.35; arm veto only with the armed agent's confidence on that side >= ${MIN_CONFIDENCE})**`);
const sv = out.filter((x) => !x.sv1b.overruled);
T.push(`pass SV1b's veto rule: lean ${out.filter((x) => x.by === "strategy_agents" && !x.sv1b.lean_veto).length}/${ag.length}, arm ${out.filter((x) => x.by === "strategy_arm" && !x.sv1b.arm_veto).length}/${out.length - ag.length}; then trade under the current code: ${sv.length}; still held: ${JSON.stringify(Object.fromEntries(group(out.filter((x) => x.sv1b.overruled), (x) => x.sv1b.overruled).map(([k, v]) => [k, v.length])))}`);
T.push(`${HEAD}\n${line("SV1b passes", stats(sv, (x) => x.sv1b.sim))}\n${line("SV1b still blocked (rebuild)", stats(out.filter((x) => x.sv1b.overruled)))}`);
// Alternatives.
const alt = (label, keep) => { const l = out.filter(keep); T.push(line(label, stats(l))); };
T.push(`\n**Alternatives (rebuilt trade, blocks that would pass the veto rule)**\n\n${HEAD}`);
alt("A1 lean veto only when lean >= 0.25", (x) => x.by === "strategy_agents" && x.lean < 0.25);
alt("A2 lean veto only when >= 2 opposing speakers", (x) => x.by === "strategy_agents" && x.opp_n < 2);
alt("A3 lean veto only when >= 3 opposing speakers", (x) => x.by === "strategy_agents" && x.opp_n < 3);
alt("A4 no lean veto when a wanted-side speaker exists", (x) => x.by === "strategy_agents" && x.own_n >= 1);
alt("A5 arm veto off", (x) => x.by === "strategy_arm");
// The default agent speaks on both sides in most blocks; "one-sided" agents speak only against the SELL.
const oneSided = (x) => x.opp_ids.filter((i) => !x.own_ids.includes(i));
alt("A6 lean veto only with >= 2 one-sided opposing agents", (x) => x.by === "strategy_agents" && oneSided(x).length < 2);
alt("A7 arm veto ignores an armed agent that also speaks for the SELL", (x) => x.by === "strategy_arm" && x.armed_opp.length > 0 && x.armed_opp.every((a) => x.own_ids.includes(a.id)));
alt("A6 + A7", (x) => (x.by === "strategy_agents" && oneSided(x).length < 2) || (x.by === "strategy_arm" && x.armed_opp.length > 0 && x.armed_opp.every((a) => x.own_ids.includes(a.id))));
T.push(`\ndefault agent (${DEFAULT_AGENT}) speaks on both sides: blocks ${out.filter((x) => x.opp_ids.includes(DEFAULT_AGENT) && x.own_ids.includes(DEFAULT_AGENT)).length}/${out.length}, passed SELLs ${cmp.filter((x) => x.opp_ids.includes(DEFAULT_AGENT) && x.own_ids.includes(DEFAULT_AGENT)).length}/${cmp.length}`);
T.push(`one-sided opposing agents (strategy_agents blocks): ${JSON.stringify(Object.fromEntries(group(ag, (x) => String(oneSided(x).length)).map(([k, v]) => [k, v.length])))}`);
const meanOf = (xs) => (xs.length ? r2(xs.reduce((a, x) => a + x, 0) / xs.length) : null);
T.push(`mean TP1 distance in R of the stop at the fill: blocks ${meanOf(out.map((x) => x.sim).filter(traded).map((s) => s.tp_r))}, passed SELLs ${meanOf(cmp.map((x) => x.sim).filter(traded).map((s) => s.tp_r))}`);
let episodes = 0, prevMs = 0;
for (const x of out) { const t = Date.parse(x.bar_close); if (t - prevMs > 30 * 60_000) episodes += 1; prevMs = t; }
T.push(`episodes (blocks more than 30 minutes apart start a new one): ${episodes}`);
T.push(`\n**Passed SELLs by the agents' lean (controls nearest the veto)**\n\n${HEAD}`);
for (const [k, xs] of group(cmp, (x) => (!finite(x.lean) ? "no lean" : x.lean <= -0.15 ? "lean <= -15 (with)" : x.lean < 0 ? "lean -15..0" : "lean 0..+14"))) T.push(line(k, stats(xs)));
for (const [k, xs] of group(cmp, (x) => x.regime)) T.push(line(`passed ${k}`, stats(xs)));
T.push(`\n**Not replayed**: ${JSON.stringify(Object.fromEntries(group(out.filter((x) => !traded(x.sim)), (x) => `${x.sim.status}:${x.sim.gate}`).map(([k, v]) => [k, v.length])))}; passed SELLs not replayed: ${JSON.stringify(Object.fromEntries(group(cmp.filter((x) => !traded(x.sim)), (x) => `${x.sim.status}:${x.sim.gate}`).map(([k, v]) => [k, v.length])))}`);
T.push(`rebuild: ${JSON.stringify(Object.fromEntries(group(out, (x) => `${x.rebuilt?.from}:${x.rebuilt?.agent}:rule_ok=${x.rebuilt?.rule_ok}`).map(([k, v]) => [k, v.length])))}`);
T.push(`exits (blocks): ${JSON.stringify(Object.fromEntries(group(out.filter((x) => traded(x.sim)), (x) => x.sim.exit).map(([k, v]) => [k, v.length])))}; exits (passed): ${JSON.stringify(Object.fromEntries(group(cmp.filter((x) => traded(x.sim)), (x) => x.sim.exit).map(([k, v]) => [k, v.length])))}`);
const text = T.join("\n");
fs.writeFileSync(path.join(DATA, "..", "out", "tables.md"), text + "\n");
console.log(text);
