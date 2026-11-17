// Council proposals, phase 2 (docs/RFC_COUNCIL_PROPOSALS.md; owner 2026-11-17: "Live otomatis + rollback otomatis").
//
// An accepted knob change (D1 council_proposals, kind policy_parameter, state queued_shadow) is tested in shadow on the
// recorded decisions: each 15m decision is replayed with the candidate value, and where the trade it would take
// differs from the one it took, the difference is measured in the plan's own R (plan_setups, the plan as is: e0@s1),
// the same unit for a trade taken and one not taken. The gate is grid auto-adapt's (src/grid-adapt.mjs): enough changed
// decisions, a mean gain, the newest quarter not worse, a bootstrap 2.5% bound above 0. A value that passes goes live
// by itself (KV council-knobs:v1, read by the Decision Engine at each decision, clamped again to the registry's
// bounds); a live value whose decisions since then did worse than the old value's replay rolls back by itself and is
// never tried again. Every step: one Telegram line and a typed_proposal.v1 state update to the platform.
//
// The replay. A stricter value is exact: a trade taken under the old value that fails the new one drops out. A looser
// value is an estimate: a side counts as newly allowed only where the knob's own check was the one that failed (every
// other recorded check passed) and the council's bias was on that side. Never throws.
import { knobById, KNOBS_KEY, resetKnobCache } from "./council-knobs.mjs";
import { bootstrapLow } from "./grid-adapt.mjs";
import { publishToPlatform } from "./platform-reports.mjs";
import { proposalReport, ensureSessionSchema } from "./cfc-session.mjs";

export const KNOB_GATE = Object.freeze({ min_changed: 30, min_gain_r: 0.05, recent_share: 0.25, recent_min: 10, learn_days: 60, wait_days: 30, live_window: 20 });
/** The knobs the replay can test; the others are code for the platform. */
export const TESTABLE_KNOBS = Object.freeze(["decision.min_confidence", "decision.min_rrr.intraday", "decision.min_rrr.swing", "decision.quorum_min.scalp", "decision.quorum_min.intraday", "decision.quorum_min.swing"]);
const DAY = 86_400_000;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const parse = (s, d = null) => { try { return typeof s === "string" ? JSON.parse(s) : (s ?? d); } catch { return d; } };
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const clip = (s, n) => String(s ?? "").slice(0, n);

// The live values are read through src/council-knobs.mjs (readKnobOverrides), shared with the Decision Engine.
export { readKnobOverrides, knobValues, KNOBS_KEY } from "./council-knobs.mjs";

// --- the replay -----------------------------------------------------------------------------------------------------
const SIDES = { BUY: "long", SELL: "short" };
/** Pure: one recorded decision as the replay reads it; r = the plan as is (e0@s1) per side, 0 when not filled. */
export function decisionRow(rec, setups = {}) {
  const d = typeof rec.decision_json === "string" ? parse(rec.decision_json, {}) : (rec.decision ?? rec);
  const checksOf = (g) => Object.fromEntries((Array.isArray(g?.checks) ? g.checks : []).map((c) => [c.id, c.pass === true]));
  const rOf = (side) => { const a = parse(setups?.[side], null)?.["e0@s1"]; return finite(a?.r) ? (a.f ? a.r : 0) : null; };
  const plansRrr = (side) => { const p = d?.strategy_plans?.[side]?.zone_pullback?.rrr; return finite(p?.tp2) || finite(p?.tp1) ? Math.max(finite(p.tp1) ? p.tp1 : 0, finite(p.tp2) ? p.tp2 : 0) : null; };
  return {
    key: rec.decision_key ?? d?.decision_key, at: rec.decided_at ?? d?.decided_at, mode: d?.trading_mode ?? null,
    stance: d?.stance ?? "WAIT", bias: d?.bias ?? "NEUTRAL", confidence: finite(d?.confidence) ? d.confidence : null,
    quorum: { long_share: d?.quorum?.long_share ?? 0, short_share: d?.quorum?.short_share ?? 0, score: d?.quorum?.score ?? 0 },
    lean: finite(d?.rules?.lean) ? d.rules.lean : 0.15,
    checks: { long: checksOf(d?.guardrails?.long), short: checksOf(d?.guardrails?.short) },
    trade_rrr: finite(d?.trade?.rrr) ? d.trade.rrr : null,
    // What the council wanted when a guardrail turned it into WAIT, and which checks failed.
    overruled: d?.overruled?.wanted === "BUY" || d?.overruled?.wanted === "SELL" ? { wanted: d.overruled.wanted, checks: (Array.isArray(d.overruled.failed) ? d.overruled.failed : []).map((f) => f?.check) } : null,
    plan_rrr: { long: plansRrr("long"), short: plansRrr("short") },
    r: { BUY: rOf("BUY"), SELL: rOf("SELL") }
  };
}

const knobMode = (id) => /\.(scalp|intraday|swing)$/.exec(id)?.[1] ?? null;
function quorumPasses(row, side, qmin) {
  const dir = side === "BUY" ? 1 : -1;
  const share = side === "BUY" ? row.quorum.long_share : row.quorum.short_share;
  const opposing = side === "BUY" ? row.quorum.short_share : row.quorum.long_share;
  return share > qmin || (dir * row.quorum.score >= row.lean && share > opposing);
}
/** Pure: the side this decision would trade with the knob at `value` (null: no trade); the recorded side otherwise. */
export function sideUnder(row, knobId, value) {
  const traded = row.stance === "BUY" || row.stance === "SELL" ? row.stance : null;
  const mode = knobMode(knobId);
  if (mode && row.mode !== mode) return traded;
  if (knobId === "decision.min_confidence") {
    if (traded) return finite(row.confidence) && row.confidence < value ? null : traded;
    // Looser (exact): the council wanted a side and only its confidence was below the floor then.
    const o = row.overruled;
    return o && o.checks.length === 1 && o.checks[0] === "confidence" && finite(row.confidence) && row.confidence >= value ? o.wanted : null;
  }
  const check = knobId.startsWith("decision.quorum_min.") ? "quorum" : knobId.startsWith("decision.min_rrr.") ? "reward" : null;
  if (!check) return traded;
  const passes = (side) => (check === "quorum" ? quorumPasses(row, side, value) : finite(row.plan_rrr[SIDES[side]]) && row.plan_rrr[SIDES[side]] >= value);
  if (traded) {
    if (check === "reward") return finite(row.trade_rrr) && row.trade_rrr < value ? null : traded;
    return passes(traded) ? traded : null;
  }
  // Looser (an estimate): the bias's side, where only this check failed and it now passes.
  const side = row.bias === "BULLISH" ? "BUY" : row.bias === "BEARISH" ? "SELL" : null;
  if (!side) return null;
  const c = row.checks[SIDES[side]] ?? {};
  const others = Object.entries(c).filter(([id]) => id !== check);
  if (c[check] !== false || !others.length || others.some(([, ok]) => !ok)) return null;
  return passes(side) ? side : null;
}

/** Pure: the evidence for a knob value over the rows (oldest first): the decisions whose trade changes, and the gate. */
export function knobEvidence(rows, knobId, value, { gate = KNOB_GATE } = {}) {
  const diffs = [];
  let removed = 0, added = 0, switched = 0;
  for (const row of rows) {
    const control = row.stance === "BUY" || row.stance === "SELL" ? row.stance : null;
    const cand = sideUnder(row, knobId, value);
    if (control === cand) continue;
    const rc = control ? row.r[control] : 0, rn = cand ? row.r[cand] : 0;
    if (!finite(rc) || !finite(rn)) continue;
    diffs.push(rn - rc);
    if (control && !cand) removed += 1; else if (!control && cand) added += 1; else switched += 1;
  }
  const n = diffs.length;
  const mean = n ? diffs.reduce((a, b) => a + b, 0) / n : null;
  const k = Math.max(gate.recent_min, Math.ceil(n * gate.recent_share));
  const recent = n >= k ? diffs.slice(-k).reduce((a, b) => a + b, 0) / k : null;
  let low = null, reason;
  if (n < gate.min_changed) reason = `${n} of ${gate.min_changed} changed decisions measured`;
  else if (!(mean > gate.min_gain_r)) reason = `mean gain ${r3(mean)}R is not above ${gate.min_gain_r}R`;
  else if (!(recent >= 0)) reason = `the newest ${k} changed decisions lose (${r3(recent)}R)`;
  else { low = bootstrapLow(diffs); reason = low > 0 ? null : `bootstrap 2.5% bound ${r3(low)}R is not above 0`; }
  return { knob: knobId, value, changed: n, removed, added, switched, mean_gain_r: r3(mean), recent_gain_r: r3(recent), bootstrap_low_r: r3(low), pass: n >= gate.min_changed && reason == null, reason };
}

// --- the daily run --------------------------------------------------------------------------------------------------
async function readDoc(env) { try { return parse(await env.SIGNAL_CACHE.get(KNOBS_KEY)) ?? { version: 1, live: {}, held: {}, retired: [] }; } catch { return { version: 1, live: {}, held: {}, retired: [] }; } }

async function loadRows(db, sinceIso) {
  const decisions = (await db.prepare("SELECT decision_key, decided_at, decision_json FROM engine_decisions WHERE decided_at >= ? ORDER BY decided_at").bind(sinceIso).all()).results ?? [];
  const setups = (await db.prepare("SELECT decision_key, side, results_json FROM plan_setups WHERE agent = 'zone_pullback' AND status = 'resolved' AND decided_at >= ?").bind(sinceIso).all()).results ?? [];
  const by = new Map();
  for (const s of setups) { if (!by.has(s.decision_key)) by.set(s.decision_key, {}); by.get(s.decision_key)[s.side] = s.results_json; }
  return decisions.map((d) => decisionRow(d, by.get(d.decision_key) ?? {}));
}

async function setState(db, id, state, note, now) {
  await db.prepare("UPDATE council_proposals SET state = ?, note = ?, updated_ms = ? WHERE id = ?").bind(state, clip(note, 300), now, id).run();
}

/**
 * Once a UTC day (the ledger cron): test the queued knob proposals, apply the ones that pass, roll back a live value
 * that does worse. Returns what it did. `send` posts one Telegram line; `publish` sends the state to the platform.
 */
export async function runKnobProposals(env, { now = Date.now(), send = null, publish = publishToPlatform, force = false } = {}) {
  const db = env?.DB;
  if (!db || !env?.SIGNAL_CACHE) return { status: "unavailable" };
  try {
    await ensureSessionSchema(db);
    const doc = await readDoc(env);
    const day = new Date(now).toISOString().slice(0, 10);
    if (!force && doc.day === day) return { status: "fresh" };
    const rows = await loadRows(db, new Date(now - KNOB_GATE.learn_days * DAY).toISOString());
    const actions = [];
    const tell = async (p, text) => {
      try { if (send) await send(text); } catch { /* best effort */ }
      try { await publish(env, "xauusd-moderator", proposalReport(p)); } catch { /* best effort */ }
    };
    // 1. Roll back a live value whose decisions since it went live did worse than the old value's replay.
    for (const [id, live] of Object.entries(doc.live ?? {})) {
      const since = rows.filter((r) => Date.parse(r.at) >= Number(live.since_ms));
      const back = knobEvidence(since, id, live.from, { gate: { ...KNOB_GATE, min_changed: KNOB_GATE.live_window } });
      // back.mean_gain_r: what the OLD value would have gained over the live one on the changed decisions.
      if (back.changed >= KNOB_GATE.live_window && back.mean_gain_r > 0) {
        delete doc.live[id];
        doc.retired = [...(doc.retired ?? []), { knob: id, value: live.value, proposal_id: live.proposal_id, at: new Date(now).toISOString(), reason: `the old value would have gained ${back.mean_gain_r}R per changed decision` }].slice(-50);
        const p = await db.prepare("SELECT * FROM council_proposals WHERE id = ?").bind(live.proposal_id).first();
        if (p) { await setState(db, p.id, "rolled_back", `rolled back: the old value ${live.from} did better on ${back.changed} changed decisions (${back.mean_gain_r}R each)`, now); await tell({ ...p, state: "rolled_back" }, `Council knob rolled back: ${id} ${live.value} → ${live.from} (the old value did better on ${back.changed} decisions)`); }
        actions.push({ knob: id, action: "rolled_back", evidence: back });
      }
    }
    // 2. Test the queued proposals (the newest per knob; an older one on the same knob is superseded).
    const queued = (await db.prepare("SELECT * FROM council_proposals WHERE kind = 'policy_parameter' AND state IN ('queued_shadow', 'shadow') ORDER BY accepted_ms DESC").all()).results ?? [];
    const seen = new Set();
    for (const p of queued) {
      if (seen.has(p.knob)) { await setState(db, p.id, "superseded", "a newer accepted proposal changes the same knob", now); continue; }
      seen.add(p.knob);
      if (!TESTABLE_KNOBS.includes(p.knob) || !knobById(p.knob)) { await setState(db, p.id, "rejected", "this knob has no shadow test; it needs code (a repository task)", now); continue; }
      if ((doc.retired ?? []).some((x) => x.knob === p.knob && Number(x.value) === Number(p.value))) { await setState(db, p.id, "rejected", "this value was rolled back before and is not tried again", now); continue; }
      const ev = knobEvidence(rows, p.knob, Number(p.value));
      const age = now - Number(p.accepted_ms);
      if (ev.pass) {
        doc.live = { ...(doc.live ?? {}), [p.knob]: { value: Number(p.value), from: Number(p.from_value), proposal_id: p.id, since_ms: now } };
        await setState(db, p.id, "live", `live since ${new Date(now).toISOString().slice(0, 16)}Z: ${ev.changed} changed decisions, +${ev.mean_gain_r}R each (bootstrap low ${ev.bootstrap_low_r}R)`, now);
        await tell({ ...p, state: "live" }, `Council knob live: ${p.knob} ${p.from_value} → ${p.value} (${ev.changed} decisions in shadow, +${ev.mean_gain_r}R each). It rolls back by itself if it does worse.`);
        actions.push({ knob: p.knob, action: "live", evidence: ev });
      } else if (ev.changed >= KNOB_GATE.min_changed || age > KNOB_GATE.wait_days * DAY) {
        await setState(db, p.id, "rejected", `did not prove better: ${ev.reason}`, now);
        await tell({ ...p, state: "rejected" }, `Council knob not applied: ${p.knob} ${p.from_value} → ${p.value} (${ev.reason})`);
        actions.push({ knob: p.knob, action: "rejected", evidence: ev });
      } else {
        await setState(db, p.id, "shadow", `in shadow: ${ev.reason}`, now);
        actions.push({ knob: p.knob, action: "shadow", evidence: ev });
      }
    }
    doc.day = day; doc.updated_ms = now;
    await env.SIGNAL_CACHE.put(KNOBS_KEY, JSON.stringify(doc));
    resetKnobCache();
    return { status: "ok", rows: rows.length, actions };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}
