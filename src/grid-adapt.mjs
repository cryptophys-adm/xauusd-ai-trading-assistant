// Automatic entry and stop adaptation from the Entry and Stop Grid (owner 2026-11-17, relayed: "keputusan jangan
// ditangan saya, council strategy agent yang harus otomatis menyesuaikan"; confirmed in the session: "Setuju, bangun
// begitu" with the strict evidence gate below). Per strategy agent x 1H regime, a cell other than the plan
// (entry 0..0.3 1H ATR deeper, stop x0.5..x1.25 of the plan's distance) is used only when ALL hold on the plan
// learner's replays (plan_setups, the same setups for the cell and the plan, in R of the PLAN's stop so units agree):
//   1. at least GATE.min_fills filled setups of the cell in the slice;
//   2. its mean per-setup gain over the plan is above GATE.margin_r and the bootstrap's 2.5% bound is above 0;
//   3. the gain is above 0 on the latest GATE.holdout_share of the slice's setups (time order), on >= holdout_min;
//   4. its neighbours agree: the mean gain of the adjacent cells (one step of entry or stop) is above 0.
// Re-evaluated once a UTC day; a slice keeps its cell unless another beats it by GATE.switch_margin_r; a slice whose
// live grid trades lose (GATE.revert_trades closed, mean Omega R below 0) reverts to the plan and is held for
// GATE.hold_days. One Nexus Telegram line per adoption or revert. The Decision Engine's plan is not changed (the
// learner keeps learning on it): the signal moves its entry and stop, Omega's sizing (risk_pct), its stop floors,
// max_positions and the Position Manager apply as to any entry, and the open intent records stop_source
// "grid:<cell>". GRID_ADAPT_MODE "off" (code default) leaves the plan; "live" acts. Never throws.
import { CONTROL_ARM, ENTRY_SHIFTS, STOP_SCALES, armId, DEFAULT_PLAN_AGENT, ensurePlanLearningSchema } from "./plan-learning.mjs";

export const GRID_ADAPT_KEY = "grid-adapt:v1";
export const GATE = Object.freeze({
  min_fills: 40, margin_r: 0.05, switch_margin_r: 0.05, holdout_share: 0.25, holdout_min: 10,
  bootstrap: 2000, revert_trades: 10, hold_days: 7, learn_days: 90
});
const DAY = 86_400_000;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const parse = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };

export function gridAdaptMode(env) {
  return String(env?.GRID_ADAPT_MODE ?? "off").trim().toLowerCase() === "live" ? "live" : "off";
}

/** Pure: a cell's levels for a plan ({ side, entry, stop, atr_h1 }), as the plan learner's variantOf. */
export function cellLevels(plan, e, k) {
  const dir = plan?.side === "BUY" ? 1 : plan?.side === "SELL" ? -1 : 0;
  if (!dir || ![plan.entry, plan.stop, plan.atr_h1].every(finite) || plan.atr_h1 <= 0) return null;
  const risk0 = dir * (plan.entry - plan.stop);
  if (!(risk0 > 0)) return null;
  const entry = r2(plan.entry - dir * e * plan.atr_h1), stop = r2(plan.entry - dir * k * risk0), risk = dir * (entry - stop);
  return risk > 0 ? { entry, stop, risk, risk0 } : null;
}

/** Pure: one setup's cell result in R of the plan's stop (0 when not filled), or null when the cell does not fit. */
export function planR(setup, e, k) {
  const a = setup?.results?.[armId(e, k)];
  if (!finite(a?.r)) return null;
  const lv = cellLevels(setup, e, k);
  return lv ? { r: a.r * lv.risk / lv.risk0, f: a.f ? 1 : 0 } : null;
}

/** Pure: a seeded bootstrap's 2.5% bound of the mean. */
export function bootstrapLow(values, { B = GATE.bootstrap, seed = 7 } = {}) {
  const n = values.length;
  if (!n) return null;
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const means = [];
  for (let b = 0; b < B; b += 1) { let sum = 0; for (let i = 0; i < n; i += 1) sum += values[Math.floor(rnd() * n)]; means.push(sum / n); }
  means.sort((x, y) => x - y);
  return means[Math.floor(0.025 * B)];
}

/** Pure: every cell's evidence against the plan on one slice's setups (oldest first). */
export function sliceEvidence(setups) {
  const cells = {};
  for (const e of ENTRY_SHIFTS) for (const k of STOP_SCALES) {
    const id = armId(e, k);
    if (id === CONTROL_ARM) continue;
    const pairs = [];
    for (const s of setups) { const c = planR(s, e, k), p = planR(s, 0, 1); if (c && p) pairs.push({ d: c.r - p.r, f: c.f }); }
    const n = pairs.length, d = pairs.map((x) => x.d), fills = pairs.reduce((a, x) => a + x.f, 0);
    const h = Math.max(0, n - Math.max(Math.ceil(n * GATE.holdout_share), 0)), hold = d.slice(h);
    cells[id] = { e, k, n, fills, gain: n ? r3(d.reduce((a, x) => a + x, 0) / n) : null, low: null,
      holdout: hold.length ? r3(hold.reduce((a, x) => a + x, 0) / hold.length) : null, holdout_n: hold.length, _d: d };
  }
  // Neighbours: one step of entry or of stop.
  for (const c of Object.values(cells)) {
    const ei = ENTRY_SHIFTS.indexOf(c.e), ki = STOP_SCALES.indexOf(c.k);
    const nb = [[ei - 1, ki], [ei + 1, ki], [ei, ki - 1], [ei, ki + 1]].filter(([a, b]) => a >= 0 && b >= 0 && a < ENTRY_SHIFTS.length && b < STOP_SCALES.length)
      .map(([a, b]) => armId(ENTRY_SHIFTS[a], STOP_SCALES[b])).map((id) => (id === CONTROL_ARM ? { gain: 0 } : cells[id])).filter((x) => finite(x?.gain));
    c.neighbours = nb.length ? r3(nb.reduce((a, x) => a + x.gain, 0) / nb.length) : null;
    const cheap = c.fills >= GATE.min_fills && finite(c.gain) && c.gain > GATE.margin_r
      && c.holdout_n >= GATE.holdout_min && finite(c.holdout) && c.holdout > 0 && finite(c.neighbours) && c.neighbours > 0;
    // The bootstrap (the costly check) only for a cell that passed every other one (a Worker's CPU budget).
    if (cheap) c.low = r3(bootstrapLow(c._d));
    c.passes = cheap && finite(c.low) && c.low > 0;
  }
  for (const c of Object.values(cells)) delete c._d;
  return cells;
}

/** Pure: the slice's choice: the passing cell with the best gain, kept unless another beats it by the switch margin. */
export function chooseCell(cells, current = null) {
  const passing = Object.entries(cells).filter(([, c]) => c.passes).sort((a, b) => b[1].gain - a[1].gain);
  const best = passing[0] ?? null;
  if (current && cells[current]?.passes) {
    if (!best || best[0] === current || best[1].gain < cells[current].gain + GATE.switch_margin_r) return current;
  }
  return best ? best[0] : null;
}

/** Pure: the signal with the slice's cell applied (entry, stop and limit action), or the signal unchanged. */
export function applyGridChoice(sig, { decision, choices } = {}) {
  if (!sig || (sig.side !== "BUY" && sig.side !== "SELL")) return sig;
  const agent = (typeof sig.trade_agent === "string" && sig.trade_agent) || DEFAULT_PLAN_AGENT;
  const regime = typeof decision?.context?.regime_1h === "string" ? decision.context.regime_1h : null;
  const cell = choices?.slices?.[`${agent}|${regime}`]?.cell ?? null;
  const atr = Number(decision?.strategy?.atr_h1);
  if (!cell || !regime || !finite(atr) || atr <= 0) return sig;
  const m = /^e([\d.]+)@s([\d.]+)$/.exec(cell);
  if (!m) return sig;
  const e = Number(m[1]), k = Number(m[2]);
  const lv = cellLevels({ side: sig.side, entry: sig.entry, stop: sig.stop, atr_h1: atr }, e, k);
  const dir = sig.side === "BUY" ? 1 : -1;
  if (!lv || !(dir * (sig.tp1 - lv.entry) > 0)) return sig;
  return { ...sig, entry: lv.entry, stop: lv.stop, action: e > 0 ? "ENTER_LIMIT" : sig.action, grid_cell: cell, grid_slice: `${agent}|${regime}`, plan_entry: sig.entry, plan_stop: sig.stop };
}

/** The stored choices, or null. */
export async function readGridChoices(env) {
  try { return parse(await env?.SIGNAL_CACHE?.get?.(GRID_ADAPT_KEY)); } catch { return null; }
}

/**
 * Once a UTC day: evaluates every agent x regime slice, applies the live revert, writes the choices and sends one
 * Telegram line per adoption or revert. Returns { status, adopted, reverted }.
 */
export async function runGridAdapt(env, { now = Date.now(), send = null, force = false } = {}) {
  if (gridAdaptMode(env) === "off") return { status: "disabled" };
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    const prev = (await readGridChoices(env)) ?? { slices: {}, held: {} };
    const day = new Date(now).toISOString().slice(0, 10);
    if (!force && prev.day === day) return { status: "fresh" };
    // MS2: the live setups only (a shadow mode's setups are the mode selector's evidence, never a grid's).
    await ensurePlanLearningSchema(db);
    const rows = (await db.prepare("SELECT agent, regime, side, entry, stop, atr_h1, results_json, opened_at FROM plan_setups WHERE status = 'resolved' AND source = 'live' AND opened_at >= ? ORDER BY opened_at")
      .bind(new Date(now - GATE.learn_days * DAY).toISOString()).all()).results ?? [];
    const bySlice = {};
    for (const r of rows) {
      if (!r.regime) continue;
      const s = { side: r.side, entry: Number(r.entry), stop: Number(r.stop), atr_h1: Number(r.atr_h1), results: parse(r.results_json) ?? {} };
      (bySlice[`${r.agent ?? DEFAULT_PLAN_AGENT}|${r.regime}`] ??= []).push(s);
    }
    // The live check of the slices in use: their last closed grid trades in Omega's own R.
    const live = {};
    try {
      const trades = (await db.prepare("SELECT json_extract(i.payload, '$.grid_slice') AS slice, l.r_omega AS r FROM omega_intents i JOIN signal_ledger l ON l.candle_key = 'OANDA:XAUUSD:15:' || CAST(json_extract(i.payload, '$.signal_issued_ms') AS INTEGER) WHERE i.kind = 'open' AND json_extract(i.payload, '$.grid_slice') IS NOT NULL AND l.omega_status = 'closed' ORDER BY i.created_ms DESC LIMIT 500").all()).results ?? [];
      for (const t of trades) { const a = (live[t.slice] ??= []); if (a.length < GATE.revert_trades && finite(Number(t.r))) a.push(Number(t.r)); }
    } catch { /* no live record yet */ }
    const held = { ...(prev.held ?? {}) };
    for (const [k, until] of Object.entries(held)) if (Date.parse(until) <= now) delete held[k];
    const slices = {}, adopted = [], reverted = [];
    for (const [slice, setups] of Object.entries(bySlice)) {
      const current = prev.slices?.[slice]?.cell ?? null;
      const l = live[slice] ?? [];
      if (current && l.length >= GATE.revert_trades && l.reduce((a, x) => a + x, 0) / l.length < 0) {
        held[slice] = new Date(now + GATE.hold_days * DAY).toISOString();
        reverted.push({ slice, cell: current, reason: `live: ${l.length} trades, mean ${r3(l.reduce((a, x) => a + x, 0) / l.length)}R` });
        continue;
      }
      if (held[slice]) continue;
      const cells = sliceEvidence(setups);
      const cell = chooseCell(cells, current);
      if (!cell && current) reverted.push({ slice, cell: current, reason: "the evidence gate no longer holds" });
      if (cell) {
        slices[slice] = { cell, since: cell === current ? prev.slices[slice].since : new Date(now).toISOString(), setups: setups.length, evidence: cells[cell] };
        if (cell !== current) adopted.push({ slice, cell, from: current, evidence: cells[cell] });
      }
    }
    const doc = { version: "cryptophys.grid-adapt.v1", day, computed_at: new Date(now).toISOString(), mode: "live", gate: GATE, slices, held };
    await kv.put(GRID_ADAPT_KEY, JSON.stringify(doc));
    if (typeof send === "function") {
      for (const a of adopted) { try { await send(`XAUUSD SYSTEM · Grid adopted for ${a.slice.replace("|", " in ")}: ${a.cell} (was ${a.from ?? "the plan"}). Gain +${a.evidence.gain}R per setup over the plan (bootstrap low ${a.evidence.low}, holdout ${a.evidence.holdout}, ${a.evidence.fills} fills).`); } catch { /* best effort */ } }
      for (const r of reverted) { try { await send(`XAUUSD SYSTEM · Grid reverted for ${r.slice.replace("|", " in ")}: ${r.cell} back to the plan (${r.reason}).`); } catch { /* best effort */ } }
    }
    return { status: "computed", slices: Object.keys(slices).length, adopted: adopted.map((a) => `${a.slice}:${a.cell}`), reverted: reverted.map((r) => `${r.slice}:${r.cell}`) };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}
