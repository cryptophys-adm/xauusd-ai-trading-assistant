// CDG, the confidence-drop gate (owner 2026-11-25, relayed by the orchestrator, verbatim: "Learned gate, hold otherwise
// (Recommended)"). Omega's strategy exit `confidence_drop` (src/omega-engine.mjs strategyExits) closed a winning
// position whenever its strategy agent's confidence for the position's side dropped between two 15m decisions. The
// measurement before this ruling found the drops come in steps of the setup term of agentConfidence
// (src/strategy-agents.mjs: 0.35 x {1, 0.5, 0}): 0.175 when the agent's at_level flips, 0.35 when it switches sides; and
// that holding to the plan beat the actual confidence_drop exits.
//
// P0 (the hold): with the Omega setting `cd_gate` "on" (the default), a confidence_drop close is emitted only when the
// learned gate passes for the position's agent x side x drop bucket. Otherwise nothing happens: no close, no stop move,
// no break-even. The position follows its plan's stop and target, SLG1's profit-lock gate and the Position Manager, as
// any position without a drop. "off" is the rule before CDG byte for byte.
//
// The drop: prev - now of the agent's confidence for the position's side, on the decision the signal carries
// (agent_conf) and the one 15 minutes before it (agent_conf_prev), the two confidenceTrend reads for the exit.
// Buckets (CD_GATE_RULE.buckets): 0.15-0.25 and >=0.25. A drop below 0.15 has no bucket: never gated, always held.
//
// The learned gate, by lift (gateCells): over the decisions of the window (the last 30 days, or as many as exist), for
// each decision with both confidences, each agent and side whose drop falls in a bucket is one sample of its cell
// "agent|side|bucket". A sample is adverse when the broker's 1m close 1 hour after the decision (the bar at or before
// decided minute + 59) is against the side, measured from the close of the minute before the decided minute (both
// bars at most 5 minutes old, at least 50 minutes apart): the replay scripts' definition (cdg-gate.js). base_rate(side)
// is the share of ALL decisions of the same window (measured the same way) where the price 1 hour later was against that
// side. A cell passes when n >= 30 and adverse_rate - base_rate >= 0.10 (the lift).
//
// The daily job (runCdGate, once a UTC day on the 5-minute ledger step beside RM1b's revert; no cron of its own) writes
// the gate to KV CD_GATE_KEY, each pass/fail change to omega_events (actor agent:cd-gate) with one Telegram line, and a
// history of the passing cells (CD_GATE_HISTORY_KEY, one entry per change) so v4 (src/ledger-omega4.mjs) replays the
// gate in force at each bar (gateAt).
//
// The held-drop log (D1 omega_cd_holds, one row per ticket and decision bar): every confidence_drop the gate holds and
// every one it lets close, with the cell, at_level_flip (the agent's at_level for the side, from the two decisions'
// strategy_plans) and the price, so the old rule's exit R (cf_r) can be compared with what holding gave.
//
// The named auto-revert (cdGateRevert, on the same step): the first CD_GATE_REVERT.outcomes (15) positions with a CDG
// event since cd_gate went live (its key_meta time when the owner set it, else since the first event). A held
// position's outcome is the R it realised on the volume held (ea_deals, the closes from its first event on); a gated
// close's is its counterfactual. When their mean R is below the old rule's (the same positions' cf_r), cd_gate is set to
// "off" (writeSettings, actor agent:cd-gate) with one Omega event and one Telegram line, once per window.
// Every KV key and the table are written only by this Worker at run time.

export const CD_GATE_MODES = Object.freeze(["on", "off"]);
export const CD_GATE_KEY = "cd-gate:v1";
export const CD_GATE_HISTORY_KEY = "cd-gate:history:v1";
export const CD_GATE_REVERT_KEY = "cd-gate:revert:v1";
const M1 = 60_000;
/** Every threshold of the gate in one table. */
export const CD_GATE_RULE = Object.freeze({
  min_n: 30, min_lift: 0.10, window_days: 30,
  // The 1h horizon: the close at decided minute + 59 against the close of the minute before the decided minute.
  horizon_min: 59, before_min: 1, bar_tol_ms: 5 * M1, min_span_ms: 50 * M1,
  buckets: Object.freeze([Object.freeze({ id: "0.15-0.25", lo: 0.15 }), Object.freeze({ id: ">=0.25", lo: 0.25 })])
});
export const CD_GATE_REVERT = Object.freeze({ outcomes: 15 });
export const CD_GATE_HISTORY_MAX = 400;
const DAY = 86_400_000;
const EPS = 1e-9;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const parse = (s, fallback = null) => { if (s == null) return fallback; if (typeof s !== "string") return s; try { return JSON.parse(s); } catch { return fallback; } };
const isoAt = (ms) => new Date(ms).toISOString();

/** Pure: whether CDG holds (cd_gate "on", the default); "off" is the rule before CDG. */
export function cdGateOn(settings) {
  return settings?.cd_gate !== "off";
}

/** Pure: the drop of a confidence (prev - now, 3 places), or null without both. */
export function cdDrop(now, prev) {
  return finite(now) && finite(prev) ? r3(prev - now) : null;
}

/** Pure: the drop's bucket ("0.15-0.25" or ">=0.25"), or null below 0.15 (never gated). */
export function dropBucket(drop) {
  if (!finite(drop)) return null;
  let id = null;
  for (const b of CD_GATE_RULE.buckets) if (drop >= b.lo - EPS) id = b.id;
  return id;
}

/** Pure: a cell's key, "agent|side|bucket" (side long or short). */
export const cellKey = (agent, side, bucket) => `${agent}|${side}|${bucket}`;

/**
 * Pure: the gate's verdict for one drop: { drop, bucket, key, cell, pass }. `gate` is { cells: { key: { pass, n, lift } } };
 * a missing cell or a drop without a bucket never passes.
 */
export function cdGateVerdict(gate, { agent, side, now, prev }) {
  const drop = cdDrop(now, prev);
  const bucket = dropBucket(drop);
  const key = bucket ? cellKey(agent, side, bucket) : null;
  const cell = key && gate?.cells && typeof gate.cells === "object" ? gate.cells[key] ?? null : null;
  return { drop, bucket, key, cell, pass: Boolean(cell && cell.pass === true) };
}

/**
 * Pure: the gate in force at `t` from its history ([{ at_ms, pass: [keys] }], oldest first): { cells } with each
 * passing key, or undefined before the first entry (no gate then: the rule before CDG).
 */
export function gateAt(history, t) {
  if (!Array.isArray(history) || !finite(t)) return undefined;
  let hit = null;
  for (const h of history) { if (finite(h?.at_ms) && h.at_ms <= t) { if (!hit || h.at_ms >= hit.at_ms) hit = h; } }
  if (!hit) return undefined;
  return { cells: Object.fromEntries((Array.isArray(hit.pass) ? hit.pass : []).filter((k) => typeof k === "string").map((k) => [k, { pass: true }])) };
}

/** Pure: the broker's 1m closes ({ t, c }), one per minute (the first seen), oldest first. */
export function closeSeries(rows = []) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = Number(r?.t), c = Number(r?.c);
    if (finite(t) && finite(c) && !by.has(t)) by.set(t, { t, c });
  }
  return [...by.values()].sort((a, b) => a.t - b.t);
}

/**
 * Pure: the gate's cells over a window. `decisions` [{ bar_close_ms, decided_ms, ac, acp }] (ac/acp the decision's
 * agent_confidence and agent_confidence_prev, { agent: { long, short } }), `bars` the broker's 1m closes ({ t, c }).
 * Returns { window: { from_ms, to_ms, decisions, measured }, base: { long: { n, adverse, rate }, short }, cells: { key:
 * { n, adverse, adverse_rate, base_rate, lift, pass } } }, the keys sorted.
 */
export function gateCells({ decisions = [], bars = [], now = Date.now(), windowDays = CD_GATE_RULE.window_days } = {}) {
  const series = closeSeries(bars);
  const fromMs = now - windowDays * DAY;
  const idxAt = (t) => { let lo = 0, hi = series.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (series[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
  const closeAt = (t) => { const i = idxAt(t); return i >= 0 && t - series[i].t <= CD_GATE_RULE.bar_tol_ms ? series[i] : null; };
  const base = { long: { n: 0, adverse: 0 }, short: { n: 0, adverse: 0 } };
  const raw = {};
  let seen = 0, measured = 0;
  const list = (Array.isArray(decisions) ? decisions : []).filter((d) => finite(d?.bar_close_ms) && d.bar_close_ms >= fromMs && d.bar_close_ms <= now).sort((a, b) => a.bar_close_ms - b.bar_close_ms);
  for (const d of list) {
    seen += 1;
    const da = finite(d.decided_ms) ? d.decided_ms : d.bar_close_ms + 5 * M1;
    const m = Math.floor(da / M1) * M1;
    const p0 = closeAt(m - CD_GATE_RULE.before_min * M1), p1 = closeAt(m + CD_GATE_RULE.horizon_min * M1);
    if (!p0 || !p1 || p1.t - p0.t < CD_GATE_RULE.min_span_ms || p1.t + M1 > now) continue;
    measured += 1;
    const move = p1.c - p0.c;
    base.long.n += 1; base.short.n += 1;
    if (move < 0) base.long.adverse += 1;
    if (move > 0) base.short.adverse += 1;
    const ac = d.ac && typeof d.ac === "object" ? d.ac : null, acp = d.acp && typeof d.acp === "object" ? d.acp : null;
    if (!ac || !acp) continue;
    for (const [agent, v] of Object.entries(ac)) {
      for (const side of ["long", "short"]) {
        const bucket = dropBucket(cdDrop(v?.[side], acp?.[agent]?.[side]));
        if (!bucket) continue;
        const key = cellKey(agent, side, bucket);
        raw[key] ??= { n: 0, adverse: 0 };
        raw[key].n += 1;
        if ((side === "long" ? 1 : -1) * move < 0) raw[key].adverse += 1;
      }
    }
  }
  const rate = (x) => (x.n ? x.adverse / x.n : null);
  const cells = {};
  for (const key of Object.keys(raw).sort()) {
    const c = raw[key], side = key.split("|")[1];
    const a = rate(c), b = rate(base[side]);
    const lift = finite(a) && finite(b) ? a - b : null;
    cells[key] = { n: c.n, adverse: c.adverse, adverse_rate: r3(a), base_rate: r3(b), lift: r3(lift), pass: c.n >= CD_GATE_RULE.min_n && finite(lift) && lift >= CD_GATE_RULE.min_lift - EPS };
  }
  return {
    window: { from_ms: list.length ? list[0].bar_close_ms : null, to_ms: list.length ? list.at(-1).bar_close_ms : null, decisions: seen, measured },
    base: { long: { ...base.long, rate: r3(rate(base.long)) }, short: { ...base.short, rate: r3(rate(base.short)) } },
    cells
  };
}

/** Pure: the passing cells' keys, sorted. */
export function passKeys(cells) {
  return Object.entries(cells && typeof cells === "object" ? cells : {}).filter(([, c]) => c?.pass === true).map(([k]) => k).sort();
}

/** Pure: the cells whose pass changed from `before` to `after` ([{ key, from, to, n, lift }]; a new cell counts as from false). */
export function gateChanges(before, after) {
  const out = [];
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  for (const key of keys) {
    const from = before?.[key]?.pass === true, to = after?.[key]?.pass === true;
    if (from !== to) out.push({ key, from, to, n: after?.[key]?.n ?? 0, lift: after?.[key]?.lift ?? null });
  }
  return out;
}

// ---------------------------------------------------------------- the held-drop log (D1)

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS omega_cd_holds (ticket INTEGER NOT NULL, bar_ms INTEGER NOT NULL, intent_id TEXT, agent TEXT NOT NULL, side TEXT NOT NULL, drop_conf REAL, bucket TEXT, cell_n INTEGER, cell_lift REAL, cell_pass INTEGER NOT NULL DEFAULT 0, at_level_flip INTEGER, price REAL, open_price REAL, volume REAL, r_dist REAL, cf_r REAL, action TEXT NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (ticket, bar_ms))`,
  `CREATE INDEX IF NOT EXISTS omega_cd_holds_at ON omega_cd_holds (at_ms)`
];
const schemaReady = new WeakSet();
export async function ensureCdSchema(db) {
  if (!db || schemaReady.has(db)) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  schemaReady.add(db);
}

/** Pure: the counterfactual R of the old rule's close at `price` (null without a stop distance). */
export function cfR({ side, price, open_price, r_dist }) {
  const dir = side === "BUY" || side === "long" ? 1 : -1;
  return finite(price) && finite(open_price) && finite(r_dist) && r_dist > 0 ? r3((dir * (price - open_price)) / r_dist) : null;
}

/** Pure: the at_level of an agent's plan for a side in a decision's strategy_plans (false without a plan; null without plans read). */
export function atLevelOf(plans, agent, side) {
  if (plans === undefined) return null;
  return plans?.[side]?.[agent]?.at_level === true;
}

/** Pure: whether the agent's at_level for the side flipped between two decisions' strategy_plans (null when either is unknown). */
export function atLevelFlip(prevPlans, nowPlans, agent, side) {
  const a = atLevelOf(prevPlans, agent, side), b = atLevelOf(nowPlans, agent, side);
  return a == null || b == null ? null : a !== b;
}

let logged = new WeakMap();
export function resetCdMemoForTests() { logged = new WeakMap(); liveMemo = new WeakMap(); }
/**
 * The plan's CDG events into omega_cd_holds, once per (ticket, decision bar): a hold is inserted once; a gated close
 * replaces a hold of the same bar (never the other way). `events` planIntents' cd_gate; `positions` the executor's;
 * `meta` the positions' meta by intent id (r_dist). Best effort, never throws; returns the rows written.
 */
export async function recordCdEvents(db, { events = [], positions = [], meta = {}, now = Date.now() } = {}) {
  if (!db || !Array.isArray(events) || !events.length) return 0;
  let memo = logged.get(db);
  if (!memo) { memo = new Map(); logged.set(db, memo); }
  let written = 0;
  try {
    await ensureCdSchema(db);
    for (const e of events) {
      const mk = `${e.ticket}:${e.bar_ms}`;
      const was = memo.get(mk);
      if (was === "closed" || (was === "held" && e.action === "held")) continue;
      const p = (Array.isArray(positions) ? positions : []).find((x) => x?.ticket === e.ticket) ?? {};
      const rd = Number(meta?.[p.intent_id]?.r_dist);
      const open = Number(p.open_price ?? p.entry);
      const r_dist = finite(rd) && rd > 0 ? rd : null;
      let flip = null;
      try { flip = await decisionsFlip(db, e); } catch { flip = null; }
      const row = [e.ticket, e.bar_ms, typeof p.intent_id === "string" ? p.intent_id : null, e.agent, e.side, e.drop, e.bucket, e.cell?.n ?? null, e.cell?.lift ?? null, e.cell?.pass === true ? 1 : 0, flip == null ? null : flip ? 1 : 0, finite(e.price) ? e.price : null, finite(open) ? open : null, finite(Number(p.volume)) ? Number(p.volume) : null, r_dist, cfR({ side: e.side, price: e.price, open_price: open, r_dist }), e.action, now];
      await db.prepare("INSERT INTO omega_cd_holds (ticket, bar_ms, intent_id, agent, side, drop_conf, bucket, cell_n, cell_lift, cell_pass, at_level_flip, price, open_price, volume, r_dist, cf_r, action, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ticket, bar_ms) DO UPDATE SET action = excluded.action, cell_n = excluded.cell_n, cell_lift = excluded.cell_lift, cell_pass = excluded.cell_pass, price = excluded.price, cf_r = excluded.cf_r, at_ms = excluded.at_ms WHERE omega_cd_holds.action = 'held' AND excluded.action = 'closed'")
        .bind(...row).run();
      memo.set(mk, e.action);
      if (memo.size > 500) memo.delete(memo.keys().next().value);
      written += 1;
    }
  } catch { /* the plan stands */ }
  return written;
}

/** The at_level flip of an event from its two decisions (the bar and the one 15 minutes before), or null. */
async function decisionsFlip(db, e) {
  const now = isoAt(e.bar_ms * M1), prev = isoAt(e.bar_ms * M1 - 15 * M1);
  const rows = (await db.prepare("SELECT bar_close, json_extract(decision_json, '$.strategy_plans') AS sp FROM engine_decisions WHERE bar_close IN (?, ?)").bind(now, prev).all()).results ?? [];
  const of = (iso) => { const r = rows.find((x) => x.bar_close === iso); return r ? parse(r.sp, null) : undefined; };
  return atLevelFlip(of(prev), of(now), e.agent, e.side);
}

// ---------------------------------------------------------------- the gate in force for the live sync

let liveMemo = new WeakMap();
const LIVE_MEMO_MS = 5 * M1;
/**
 * The live gate for the sync ({ cells }), read from KV at most every 5 minutes per isolate. A missing or unreadable gate
 * is { cells: {} }: nothing passes, every drop is held (the ruling: close only when the learned gate passes).
 */
export async function readCdGateLive(env, { now = Date.now() } = {}) {
  const kv = env?.SIGNAL_CACHE;
  const m = kv ? liveMemo.get(kv) : null;
  if (m && now - m.at < LIVE_MEMO_MS) return m.gate;
  let gate = { cells: {} };
  try {
    const doc = parse(await kv?.get?.(CD_GATE_KEY), null);
    if (doc?.cells && typeof doc.cells === "object") gate = { cells: doc.cells, computed_at: doc.computed_at ?? null };
  } catch { gate = { cells: {} }; }
  if (kv) liveMemo.set(kv, { at: now, gate });
  return gate;
}

/** The gate's history for v4 ([{ at_ms, pass }], oldest first; [] when none or unreadable). */
export async function readCdGateHistory(env) {
  try {
    const h = parse(await env?.SIGNAL_CACHE?.get?.(CD_GATE_HISTORY_KEY), []);
    return Array.isArray(h) ? h.filter((x) => finite(x?.at_ms) && Array.isArray(x?.pass)) : [];
  } catch { return []; }
}

// ---------------------------------------------------------------- the daily job

const DECISIONS_SQL = "SELECT bar_close, json_extract(decision_json, '$.decided_at') AS da, json_extract(decision_json, '$.agent_confidence') AS ac, json_extract(decision_json, '$.agent_confidence_prev') AS acp FROM engine_decisions WHERE bar_close >= ? ORDER BY bar_close";
const BARS_SQL = "SELECT minute_ms AS t, c FROM broker_bars_1m WHERE source = ? AND minute_ms >= ? ORDER BY minute_ms";
// The broker's 1m bars of the measurement (src/liquidity-lens.mjs's archive): the corpus source with the most minutes in
// the window (Omega's own broker and symbol; no name is written here).
const SOURCE_SQL = "SELECT source, COUNT(*) AS n FROM broker_bars_1m WHERE minute_ms >= ? GROUP BY source ORDER BY n DESC, source LIMIT 1";

async function omegaEvent(db, now, action, detail) {
  try { await db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(now, "agent:cd-gate", action, JSON.stringify(detail)).run(); } catch { /* best effort */ }
}

/** The Telegram line of the gate's changes (words and rates only, no price). */
export function gateChangeLine(changes) {
  const part = (c) => `${c.key.replace(/\|/g, " ")} ${c.to ? "passes" : "no longer passes"} (n ${c.n}, lift ${c.lift == null ? "n/a" : `${c.lift > 0 ? "+" : ""}${c.lift}`})`;
  return `XAUUSD OMEGA · Confidence-drop gate (CDG): ${changes.slice(0, 8).map(part).join("; ")}${changes.length > 8 ? `; and ${changes.length - 8} more` : ""}. A confidence drop closes a winner only in a passing cell; every other drop is held.`;
}

/**
 * The gate's daily computation: the decisions and broker bars of the window, the cells (gateCells), KV CD_GATE_KEY, the
 * history entry and one Omega event per pass/fail change (one Telegram line). Idempotent: once a UTC day (`force` to
 * run again), and the same evidence writes no change. Returns { status: fresh | unchanged | changed | unavailable |
 * failed, ... }. Never throws.
 */
export async function computeCdGate(env, { now = Date.now(), send = null, force = false } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    const day = isoAt(now).slice(0, 10);
    const prev = parse(await kv.get(CD_GATE_KEY), null);
    if (!force && prev?.day === day) return { status: "fresh" };
    const fromMs = now - CD_GATE_RULE.window_days * DAY;
    const drows = (await db.prepare(DECISIONS_SQL).bind(isoAt(fromMs)).all()).results ?? [];
    const decisions = drows.map((r) => ({ bar_close_ms: Date.parse(String(r.bar_close ?? "")), decided_ms: Date.parse(String(r.da ?? "")), ac: parse(r.ac, null), acp: parse(r.acp, null) }))
      .map((d) => ({ ...d, decided_ms: finite(d.decided_ms) ? d.decided_ms : null }));
    const source = (await db.prepare(SOURCE_SQL).bind(fromMs - 10 * M1).first())?.source ?? null;
    const bars = source ? (await db.prepare(BARS_SQL).bind(source, fromMs - 10 * M1).all()).results ?? [] : [];
    const g = gateCells({ decisions, bars, now });
    const changes = gateChanges(prev?.cells ?? {}, g.cells);
    const doc = { computed_at: isoAt(now), day, window: { ...g.window, from: g.window.from_ms != null ? isoAt(g.window.from_ms) : null, to: g.window.to_ms != null ? isoAt(g.window.to_ms) : null, days: CD_GATE_RULE.window_days }, base: g.base, cells: g.cells, rule: { min_n: CD_GATE_RULE.min_n, min_lift: CD_GATE_RULE.min_lift, buckets: CD_GATE_RULE.buckets.map((b) => b.id), horizon_min: 60 } };
    await kv.put(CD_GATE_KEY, JSON.stringify(doc));
    // The history: one entry at the first computation and at each change of the passing set.
    const history = await readCdGateHistory(env);
    const pass = passKeys(g.cells);
    const last = history.at(-1);
    if (!last || JSON.stringify(last.pass) !== JSON.stringify(pass)) {
      history.push({ at_ms: now, pass });
      await kv.put(CD_GATE_HISTORY_KEY, JSON.stringify(history.slice(-CD_GATE_HISTORY_MAX)));
    }
    if (!changes.length) return { status: "unchanged", cells: Object.keys(g.cells).length, passing: pass.length };
    for (const c of changes) await omegaEvent(db, now, "cd_gate_cell", { cell: c.key, pass: c.to, n: c.n, lift: c.lift });
    console.log("cd_gate", JSON.stringify({ changes: changes.map((c) => `${c.key}:${c.to ? "pass" : "fail"}`) }));
    if (typeof send === "function") { try { await send(gateChangeLine(changes)); } catch { /* best effort */ } }
    return { status: "changed", changes, passing: pass.length };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * Pure: the revert's outcomes over the log's rows (oldest first) and each ticket's deals ({ ticket: [{ side, volume,
 * entry_price, exit_price, closed_ms }] }): the first `outcomes` tickets by their first event, each { ticket, cf_r,
 * outcome_r, action }. A ticket whose first event has no cf_r is left out; one still held open (its closes after the first
 * event cover less than the volume held) stops the list there (the window waits for it). Returns { list, ready, n,
 * mean_r, mean_cf_r, revert }.
 */
export function revertOutcomes(rows = [], deals = {}, { outcomes = CD_GATE_REVERT.outcomes } = {}) {
  const first = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!finite(Number(r?.ticket))) continue;
    const t = Number(r.ticket);
    if (!first.has(t) || Number(r.at_ms) < Number(first.get(t).at_ms)) first.set(t, r);
  }
  const order = [...first.values()].filter((r) => finite(Number(r.cf_r))).sort((a, b) => Number(a.at_ms) - Number(b.at_ms) || Number(a.ticket) - Number(b.ticket));
  const list = [];
  for (const r of order) {
    if (list.length >= outcomes) break;
    const cf = Number(r.cf_r);
    if (r.action === "closed") { list.push({ ticket: Number(r.ticket), cf_r: cf, outcome_r: cf, action: "closed" }); continue; }
    const dir = r.side === "long" || r.side === "BUY" ? 1 : -1;
    const held = Number(r.volume), rd = Number(r.r_dist);
    const ds = (deals?.[r.ticket] ?? deals?.[String(r.ticket)] ?? []).filter((d) => Number(d.exit_price) > 0 && Number(d.closed_ms) >= Number(r.at_ms));
    const vol = ds.reduce((a, d) => a + Number(d.volume || 0), 0);
    if (!(rd > 0) || !(held > 0) || vol < held - 1e-9) break;
    const pl = ds.reduce((a, d) => a + dir * (Number(d.exit_price) - Number(d.entry_price)) * Number(d.volume || 0), 0);
    list.push({ ticket: Number(r.ticket), cf_r: cf, outcome_r: r3(pl / (rd * held)), action: "held" });
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
  const m = mean(list.map((x) => x.outcome_r)), c = mean(list.map((x) => x.cf_r));
  const ready = list.length >= outcomes;
  return { list, ready, n: list.length, mean_r: r3(m), mean_cf_r: r3(c), revert: ready && m < c - EPS };
}

/** The Telegram line of the revert (R only, no price, no person). */
export function cdRevertLine(v) {
  const s = (x) => `${x > 0 ? "+" : ""}${x}R`;
  return `XAUUSD OMEGA · Confidence-drop gate (cd_gate) off: its first ${v.n} outcomes averaged ${s(v.mean_r)}, below the ${s(v.mean_cf_r)} the earlier rule's confidence_drop closes would have given on the same positions. The earlier rule is back; the owner may turn the gate on again.`;
}

/**
 * The named auto-revert, on every ledger step until its window has a verdict (then never again for that window). The
 * window starts when cd_gate went live: its key_meta time when the owner (or anyone) last set it, else 0 (the default
 * "on" from the deploy; the log has rows only since then). `write(body, actor)` saves the settings (writeSettings).
 * Returns { status: inactive | waiting | kept | reverted | done | unavailable | failed, ... }. Never throws.
 */
export async function cdGateRevert(env, { now = Date.now(), send = null, write = null } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv) return { status: "unavailable" };
  try {
    const row = await db.prepare("SELECT settings, key_meta FROM omega_settings WHERE id = 1").first();
    const settings = parse(row?.settings, {}) ?? {};
    if (!cdGateOn(settings)) return { status: "inactive" };
    const at = Date.parse(String(parse(row?.key_meta, {})?.cd_gate?.at ?? ""));
    const windowSince = finite(at) ? at : 0;
    const state = parse(await kv.get(CD_GATE_REVERT_KEY), null);
    if (state?.window_since === windowSince && (state.status === "kept" || state.status === "reverted")) return { status: "done", verdict: state.status };
    await ensureCdSchema(db);
    const rows = (await db.prepare("SELECT ticket, side, cf_r, action, volume, r_dist, at_ms FROM omega_cd_holds WHERE at_ms >= ? ORDER BY at_ms, ticket LIMIT 2000").bind(windowSince).all()).results ?? [];
    const tickets = [...new Set(rows.map((r) => Number(r.ticket)).filter(finite))].slice(0, 200);
    const deals = {};
    for (let i = 0; i < tickets.length; i += 50) {
      const part = tickets.slice(i, i + 50);
      for (const d of (await db.prepare(`SELECT position_ticket AS ticket, side, volume, entry_price, exit_price, closed_ms FROM ea_deals WHERE position_ticket IN (${part.map(() => "?").join(", ")}) AND exit_price > 0`).bind(...part).all()).results ?? []) (deals[d.ticket] ??= []).push(d);
    }
    const v = revertOutcomes(rows, deals);
    const summary = { n: v.n, mean_r: v.mean_r, mean_cf_r: v.mean_cf_r };
    if (!v.ready) return { status: "waiting", ...summary };
    if (!v.revert) {
      await kv.put(CD_GATE_REVERT_KEY, JSON.stringify({ window_since: windowSince, status: "kept", ...summary, at: isoAt(now) }));
      await omegaEvent(db, now, "cd_gate_kept", summary);
      return { status: "kept", ...summary };
    }
    let saved = false;
    if (typeof write === "function") { try { saved = (await write({ cd_gate: "off" }, "agent:cd-gate"))?.ok === true; } catch { saved = false; } }
    if (!saved) return { status: "failed", reason: "the settings could not be saved", ...summary };
    await kv.put(CD_GATE_REVERT_KEY, JSON.stringify({ window_since: windowSince, status: "reverted", ...summary, at: isoAt(now) }));
    await omegaEvent(db, now, "cd_gate_reverted", { value: "off", from: "on", ...summary });
    if (typeof send === "function") { try { await send(cdRevertLine(v)); } catch { /* best effort */ } }
    return { status: "reverted", ...summary };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/** The ledger step's CDG work: the daily gate, then the auto-revert check. Never throws. */
export async function runCdGate(env, { now = Date.now(), send = null, write = null, force = false } = {}) {
  const gate = await computeCdGate(env, { now, send, force });
  const revert = await cdGateRevert(env, { now, send, write });
  return { gate, revert };
}

/**
 * Read only (GET /api/strategy-agents `cd_gate`): the gate's cells, window and base rates as computed, the passing keys,
 * the history's length and last change, the held-drop log's counts and the revert's state. SELECT and KV reads only.
 */
export async function cdGateStatus(env) {
  const kv = env?.SIGNAL_CACHE;
  const doc = parse(await kv?.get?.(CD_GATE_KEY), null);
  const history = await readCdGateHistory(env);
  const revert = parse(await kv?.get?.(CD_GATE_REVERT_KEY), null);
  let log = null;
  try {
    const rows = (await env.DB.prepare("SELECT action, COUNT(*) AS n FROM omega_cd_holds GROUP BY action").all()).results ?? [];
    log = { held: Number(rows.find((r) => r.action === "held")?.n || 0), closed: Number(rows.find((r) => r.action === "closed")?.n || 0) };
  } catch { log = null; }
  return {
    computed_at: doc?.computed_at ?? null, window: doc?.window ?? null, base: doc?.base ?? null, cells: doc?.cells ?? {}, passing: passKeys(doc?.cells),
    history: { entries: history.length, last_change_at: history.length ? isoAt(history.at(-1).at_ms) : null },
    log, revert: revert ? { status: revert.status ?? null, n: revert.n ?? null, mean_r: revert.mean_r ?? null, mean_cf_r: revert.mean_cf_r ?? null, at: revert.at ?? null } : null,
    rule: { min_n: CD_GATE_RULE.min_n, min_lift: CD_GATE_RULE.min_lift, buckets: CD_GATE_RULE.buckets.map((b) => b.id), window_days: CD_GATE_RULE.window_days, revert_outcomes: CD_GATE_REVERT.outcomes }
  };
}
