// RM1a (read-only study): is the room (squeeze) guardrail too strict? Replays every WAIT whose quorum side failed the
// "room" check (alone, or with other checks) since 2026-11-17 with v4's market entry and the plan's own stop and tp1
// (Position Manager, PM-1M and re-entry off), 72h horizon, and the decisions that traded, the same way. Reads only the
// JSON under ../data (pulled with read-only SELECTs, see rm1a-extract.mjs) and imports the repository's own functions.
//   RM1A_DATA=<data dir> node scripts/studies/rm1a/rm1a-replay.mjs   (writes <data dir>/../out/rows.json)
import fs from "node:fs";
import path from "node:path";
import { DATA, REPO, finite, loadBars, loadDecisions, quorumSide, failedOf, idxAtOrBefore } from "./common.mjs";

const HORIZON_MS = 72 * 3600_000;
const SINCE = "2026-11-17T00:00:00.000Z";
const { replayOmega4, decisionFromRow } = await import(`${REPO}/src/ledger-omega4.mjs`);
const { decide, tradeFor, LEAN, MIN_CONFIDENCE } = await import(`${REPO}/src/decision-engine.mjs`);
const { planIntents, OMEGA_DEFAULTS } = await import(`${REPO}/src/omega-engine.mjs`);
const { DEFAULT_AGENT } = await import(`${REPO}/src/strategy-agents.mjs`);
const r2 = (x) => Math.round(x * 100) / 100, r3 = (x) => Math.round(x * 1000) / 1000;

const { m1, basis, feedN, shiftedN, firstFeed } = loadBars();
const lastBarMs = m1.at(-1).t;
const all = loadDecisions();
const D = all.filter((d) => d.bar_close >= SINCE);
const idxOf = new Map(all.map((d, i) => [d.decision_key, i]));

const cardOf = (d, key) => (d.witnesses || []).find((w) => w.key === key) ?? null;
const plansOf = (side) => Object.fromEntries(Object.entries(side || {}).map(([id, p]) => { const { status, ...plan } = p; return [id, { status, plan: finite(plan.entry) ? { ...plan, agent: id } : null }]; }));
/** The guards decide() reads, rebuilt from the record (SV1a's guardsOf, both sides); `roomPass` forces the room check. */
function guardsOf(d, { roomPass = false } = {}) {
  const sa = cardOf(d, "STRATEGY_AGENTS");
  const g = (side) => {
    const checks = (d.guardrails?.[side]?.checks ?? []).map((c) => (roomPass && c.id === "room" ? { ...c, pass: true } : c));
    return { allowed: checks.every((c) => c.pass), checks, plans: plansOf(d.strategy_plans?.[side]), min_rrr: d.rules?.min_rrr, target_rule: d.trading_mode === "scalp" ? "nearest" : "rrr", entry_trigger: d.guardrails?.[side]?.entry_trigger ?? null };
  };
  return { long: g("long"), short: g("short"), strategy_execution: d.strategy_execution === true, veto_rule: "two_sided",
    consensus: sa ? { lean: sa.lean, long: sa.voices?.long ?? [], short: sa.voices?.short ?? [] } : null,
    ...(d.armed ? { arms: { mode: d.armed.mode, version: d.armed.version, ids: d.armed.ids ?? [], known: true } } : {}), agent_confidence: d.agent_confidence ?? null };
}
const stanceOf = (side) => (side === "long" ? "BUY" : "SELL");
/** The quorum side's trade under the current decide() with the room check passed; the council assumed to want that side. */
function decideLifted(d, side) {
  const conf = Math.max(d.confidence ?? 0, d.rules?.min_confidence ?? MIN_CONFIDENCE);
  return decide({ answer: { stance: stanceOf(side), bias: d.bias, confidence: conf, entry_type: "limit", target: "tp1" }, guards: guardsOf(d, { roomPass: true }), strategy: d.strategy, quorum: d.quorum, minConfidence: d.rules?.min_confidence ?? MIN_CONFIDENCE });
}
/** The quorum side's own plan (SV1a's rebuild): the strongest speaker's plan on the side, else the default agent's; tp1 under the mode's rule. */
function rebuildTrade(d, side) {
  const g = guardsOf(d)[side];
  const speakers = [...(cardOf(d, "STRATEGY_AGENTS")?.voices?.[side] ?? [])].sort((a, b) => (b.voice - a.voice) || (a.id === DEFAULT_AGENT ? -1 : b.id === DEFAULT_AGENT ? 1 : 0));
  const sp = speakers.find((x) => g.plans?.[x.id]?.plan);
  const id = sp ? sp.id : g.plans?.[DEFAULT_AGENT]?.plan ? DEFAULT_AGENT : null;
  if (!id) return { trade: null, from: "none", why: "no plan on the quorum side" };
  const st = stanceOf(side);
  const t = tradeFor(st, g.plans[id].plan, { entryType: "limit", target: "tp1", minRrr: finite(g.min_rrr) ? g.min_rrr : 0 });
  if (t) return { trade: { ...t, agent: id }, from: sp ? "speaker" : "default", rule_ok: true };
  const p = g.plans[id].plan;
  return { trade: { side: st, action: "ENTER_LIMIT", entry: p.entry, stop: p.stop, target: "tp1", tp: p.tp1, tp1: p.tp1, tp2: p.tp2, rrr: p.rrr?.tp1 ?? null, at_level: p.at_level === true, agent: id }, from: sp ? "speaker" : "default", rule_ok: false };
}

// ---------------------------------------------------------------- replay (v4 market entry; the plan's SL/TP only)
const SETTINGS = { ...OMEGA_DEFAULTS, pm_fast_1m: "off", reentry_1m: "off" };
function replay(d, trade) {
  const synthetic = { decision_key: d.decision_key, stance: trade.side, decided_at: d.decided_at, bar_close: d.bar_close, confidence: Math.max(d.confidence ?? 0, d.rules?.min_confidence ?? MIN_CONFIDENCE), trade,
    guardrails: { long: { entry_trigger: d.guardrails?.long?.entry_trigger ?? null }, short: { entry_trigger: d.guardrails?.short?.entry_trigger ?? null } },
    quorum: d.quorum, key_levels: d.key_levels ?? [], agent_confidence: d.agent_confidence ?? null, agent_confidence_prev: d.agent_confidence_prev ?? null,
    trading_mode: d.trading_mode, strategy_execution: d.strategy_execution === true, context: { regime_1h: d.context?.regime_1h ?? null }, strategy: { atr_h1: d.strategy?.atr_h1 ?? null },
    ...(d.entry_zone_mode ? { entry_zone_mode: d.entry_zone_mode } : {}) };
  const Dd = decisionFromRow({ decision_json: JSON.stringify(synthetic) });
  const opens = [];
  const plan = (input) => { const out = planIntents(input); const keep = out.intents.filter((it) => it.kind === "open"); for (const it of keep) opens.push(it); return { ...out, intents: keep }; };
  const res = replayOmega4({ bars: m1, decisions: [Dd], from: Dd.close_ms, to: Dd.close_ms + HORIZON_MS, settings: SETTINGS, balanceAt: () => 100_000, plan });
  const rec = res.records[d.decision_key];
  if (!rec) return { status: "no_record" };
  const j = JSON.parse(rec.omega4_json || "{}");
  if (rec.omega4_status === "skipped" || rec.omega4_status === "pending") return { status: rec.omega4_status, gate: rec.omega4_gate };
  const it = opens[0];
  const stopDist = it ? Math.abs(it.entry - it.sl) : null, atr = d.strategy?.atr_h1;
  const toAtr = (r) => (finite(r) && finite(stopDist) && finite(atr) && atr > 0 ? r2((r * stopDist) / atr) : null);
  const open = rec.omega4_status === "open";
  const R = open ? j.open_r : rec.r_omega4;
  const horizonCut = open && Dd.close_ms + HORIZON_MS > lastBarMs;
  return { status: rec.omega4_status, exit: open ? (horizonCut ? "open_at_data_end" : "time_out_72h") : rec.omega4_exit, r: finite(R) ? r3(R) : null,
    wait_min: Math.round((Date.parse(rec.omega4_filled_at) - Dd.close_ms) / 60_000), hold_min: rec.omega4_closed_at ? Math.round((Date.parse(rec.omega4_closed_at) - Date.parse(rec.omega4_filled_at)) / 60_000) : null,
    stop_atr: finite(stopDist) && finite(atr) ? r2(stopDist / atr) : null, tp_r: it && stopDist ? r2(Math.abs(it.tp - it.entry) / stopDist) : null,
    mfe_r: j.mfe_r ?? null, mae_r: j.mae_r ?? null, mfe_atr: toAtr(j.mfe_r), mae_atr: toAtr(j.mae_r) };
}

// ---------------------------------------------------------------- facts
function moveAtr(d, dir, hours) {
  const t0 = Date.parse(d.bar_close), atr = d.strategy?.atr_h1;
  const i0 = idxAtOrBefore(m1, t0 - 60_000), i1 = idxAtOrBefore(m1, t0 + hours * 3600_000 - 60_000);
  if (i0 < 0 || i1 < 0 || !finite(atr) || atr <= 0) return null;
  if (t0 - 60_000 - m1[i0].t > 5 * 60_000) return null; // no bar at the close
  if (t0 + hours * 3600_000 > lastBarMs + 60_000) return null; // the window has not run yet
  if (t0 + hours * 3600_000 - 60_000 - m1[i1].t > 90 * 60_000) return null; // a gap (weekend) at the end of the window
  return r2((dir * (m1[i1].c - m1[i0].c)) / atr);
}
const edgeOf = (sq, dir) => (!sq ? null : dir < 0 ? sq.below?.high ?? null : sq.above?.low ?? null);
function factsOf(d, side) {
  const dir = side === "long" ? 1 : -1, atr = d.strategy?.atr_h1, sq = d.squeeze, price = d.strategy?.price;
  const t0 = Date.parse(d.bar_close), i0 = idxAtOrBefore(m1, t0 - 60_000);
  const C = i0 >= 0 && t0 - 60_000 - m1[i0].t <= 5 * 60_000 ? m1[i0].c : null;
  // Room ahead (in the trade's direction) and behind, in 1H ranges, from the recorded corridor's facing edges.
  const ahead = sq && finite(edgeOf(sq, dir)) && finite(price) && finite(atr) ? r2((dir * (edgeOf(sq, dir) - price)) / atr) : null;
  const behind = sq && finite(edgeOf(sq, -dir)) && finite(price) && finite(atr) ? r2((-dir * (edgeOf(sq, -dir) - price)) / atr) : null;
  // Breakout: the close beyond the edge, in the quorum's direction, of the corridor recorded 1 bar (b1) or up to 4 bars
  // (b4, the last hour) before. The decision's own corridor is measured around that same close, so its edge is never crossed.
  const prevs = [];
  for (let k = 1; k <= 4; k++) { const p = all[idxOf.get(d.decision_key) - k]; if (p && t0 - Date.parse(p.bar_close) === k * 900_000) prevs.push({ k, p }); }
  const crossed = (p) => { const e = edgeOf(p.squeeze, dir); return finite(C) && finite(e) && dir * (C - e) > 0; };
  const b1 = prevs.some(({ k, p }) => k === 1 && crossed(p));
  const b4 = prevs.some(({ p }) => crossed(p));
  const ownCross = finite(C) && finite(edgeOf(sq, dir)) && dir * (C - edgeOf(sq, dir)) > 0;
  const trend = cardOf(d, "TREND_TF")?.lean, h1 = cardOf(d, "H1")?.lean;
  const sideWord = (v) => (!finite(v) ? "n/a" : dir * v >= LEAN ? "with" : dir * v <= -LEAN ? "against" : "neutral");
  return { side, dir, mode: d.trading_mode, room_atr: d.room_atr ?? 1, room_atr_recorded: d.room_atr != null, regime: d.context?.regime_1h ?? "n/a",
    corridor_atr: sq?.corridor_atr ?? null, squeezed: sq?.squeezed ?? null, ahead_atr: ahead, behind_atr: behind, own_edge_crossed: ownCross, breakout_b1: b1, breakout_b4: b4, prev_bars: prevs.length,
    trend_side: sideWord(trend), h1_side: sideWord(h1), counter_trend: sideWord(trend) === "against",
    move_1h: moveAtr(d, dir, 1), move_4h: moveAtr(d, dir, 4), confidence: d.confidence, overruled: d.overruled?.by ?? null };
}

// ---------------------------------------------------------------- classify and run
function classOf(d) {
  if (d.stance !== "WAIT") return "traded";
  const side = quorumSide(d);
  if (!side) return "no_quorum_side";
  const f = failedOf(d, side);
  if (f.includes("room")) return f.length === 1 ? "room_only" : "room_plus";
  if (f.length) return "other_guard";
  if (d.overruled) return `overruled_${d.overruled.by}`;
  return "council_wait_all_pass";
}
const rows = [];
for (const d of D) {
  const cls = classOf(d);
  const side = cls === "traded" ? (d.stance === "BUY" ? "long" : "short") : quorumSide(d);
  const base = { decision_key: d.decision_key, bar_close: d.bar_close, stance: d.stance, cls, failed: side ? failedOf(d, side) : [] };
  if (!side) { rows.push(base); continue; }
  const f = factsOf(d, side);
  let sim = null, rebuilt = null, lifted = null;
  if (cls === "room_only" || cls === "room_plus") {
    const rb = rebuildTrade(d, side);
    const px = d.strategy?.price, atr = d.strategy?.atr_h1, dir = side === "long" ? 1 : -1;
    rebuilt = rb.trade ? { from: rb.from, agent: rb.trade.agent, rule_ok: rb.rule_ok, rrr: rb.trade.rrr, at_level: rb.trade.at_level, tp_atr: finite(px) && finite(atr) ? r2((dir * (rb.trade.tp - px)) / atr) : null } : { why: rb.why };
    sim = rb.trade ? replay(d, rb.trade) : { status: "not_rebuilt", gate: rb.why };
    if (cls === "room_only") {
      const L = decideLifted(d, side);
      const same = L.trade && rb.trade && L.trade.agent === rb.trade.agent && L.trade.entry === rb.trade.entry && L.trade.stop === rb.trade.stop && L.trade.tp === rb.trade.tp;
      lifted = { trades: Boolean(L.trade), held: L.overruled ? `${L.overruled.by}:${L.overruled.failed?.map((x) => x.check).join("+")}` : null, agent: L.trade?.agent ?? null, same_as_rebuild: Boolean(same), sim: L.trade ? (same ? sim : replay(d, L.trade)) : null };
    }
  } else if (cls === "traded" && d.trade) {
    sim = replay(d, d.trade);
    rebuilt = { agent: d.trade.agent ?? null, tp_atr: finite(d.strategy?.price) && finite(d.strategy?.atr_h1) ? r2(((side === "long" ? 1 : -1) * (d.trade.tp - d.strategy.price)) / d.strategy.atr_h1) : null };
  }
  rows.push({ ...base, ...f, rebuilt, sim, lifted });
}
fs.mkdirSync(path.join(DATA, "..", "out"), { recursive: true });
fs.writeFileSync(path.join(DATA, "..", "out", "rows.json"), JSON.stringify({ meta: { bars: m1.length, feed: feedN, broker_shifted: shiftedN, first_feed: new Date(firstFeed).toISOString(), last_bar: new Date(lastBarMs).toISOString(), horizon_h: HORIZON_MS / 3600_000, since: SINCE }, rows }, null, 1));
const cnt = {}; for (const r of rows) cnt[r.cls] = (cnt[r.cls] || 0) + 1;
console.log(cnt, "last bar", new Date(lastBarMs).toISOString());
