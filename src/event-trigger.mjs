// ET1, the 5-minute event trigger (owner 2026-11-28 via the orchestrator, "setuju semua", PR C; the 27 Nov wedge: the
// 17:00Z decision WAITed for the 5m confirmation, which fired at 17:05Z, and nothing acted on it until the next 15m close).
// Deterministic, in the 5-minute ledger step, no model call.
//
// The event: the latest 15m decision WAITed; on a side whose guardrails all passed (`guardrails[side].allowed`), its
// entry trigger had not fired (it was waiting for the 5m confirmation); and a verified 5m Prophet confirmation on that
// side (liveM5Inputs: the 5m context of the latest closed 5m bar, verified while the 5m Prophet is trusted) closed after
// that decision's bar and before the next 15m close. One row per decision and side (D1 event_triggers): the decision
// key, side, the 5m bar's time, the mode and the side's plan (the default agent's, else the first plan recorded), and its
// counterfactual R: the plan at market from that 5m bar through the plan learner's market replay (setupOutcome: the
// control arm, the plan's own stop and TP1 distances from the fill, its fill window), resolved by a later step.
//
// EVENT_TRIGGER_MODE (FS1, group agents; wrangler "record", code default "off"): "record" the rows and their R only;
// "off" nothing. There is no "on" yet (orchestrator 2026-11-28): the out-of-cycle council run needs its own decision key
// through the signal path, the ledger and Omega, a separate PR with its own design note; until then "on" reads as
// "record", so no mode is offered that does nothing.
import { liveM5Inputs } from "./strategy-engine.mjs";
import { setupOutcome } from "./plan-learning.mjs";
import { ledgerSeries } from "./signal-ledger.mjs";

export const EVENT_TRIGGER_SWITCH = "EVENT_TRIGGER_MODE";
export const EVENT_TRIGGER_MODES = Object.freeze(["record", "off"]);
const M15 = 15 * 60_000;
const DEFAULT_AGENT = "zone_pullback";

const s = (v) => String(v ?? "").trim().toLowerCase();
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const parse = (x) => { if (x == null) return null; if (typeof x !== "string") return x; try { return JSON.parse(x); } catch { return null; } };

/** Pure: EVENT_TRIGGER_MODE as the env holds it ("on" reads as "record" until the out-of-cycle run exists; else "off"). */
export function eventTriggerMode(env) {
  const v = s(env?.EVENT_TRIGGER_MODE);
  return v === "record" || v === "on" ? "record" : "off";
}

/** Pure: the side's plan from a decision record (the default agent's, else the first one recorded), or null. */
export function sidePlanOf(record, side) {
  const plans = record?.strategy_plans?.[side];
  if (!plans || typeof plans !== "object") return null;
  const pick = plans[DEFAULT_AGENT] ? [DEFAULT_AGENT, plans[DEFAULT_AGENT]] : Object.entries(plans).find(([, p]) => p && typeof p === "object") ?? null;
  if (!pick) return null;
  const [agent, p] = pick;
  return [p?.entry, p?.stop, p?.tp1].every(finite) ? { agent, entry: p.entry, stop: p.stop, tp1: p.tp1 } : null;
}

/**
 * Pure: the sides that could still have an event at `now`, from the decision alone (no 5m read): the latest decision is a
 * WAIT inside its 15m window, and the side's guardrails all passed with its entry trigger not fired. [] when none.
 */
export function candidateSidesOf(record, now) {
  if (!record || record.stance !== "WAIT") return [];
  const closeMs = Date.parse(String(record.bar_close ?? ""));
  if (!finite(closeMs) || !(now >= closeMs && now < closeMs + M15)) return [];
  return ["long", "short"].filter((side) => record.guardrails?.[side]?.allowed === true && record.guardrails?.[side]?.entry_trigger?.fired !== true);
}

/**
 * Pure: the events of one step: [{ side, event_ms, plan }] for each side where the latest decision WAITed, the side's
 * guardrails all passed, its entry trigger had not fired, and the verified 5m confirmation on that side (`live`, as
 * liveM5Inputs returns it) closed after the decision's bar and before the next 15m close (`now` too).
 */
export function eventsOf(record, live, now) {
  const sides = candidateSidesOf(record, now);
  if (!sides.length) return [];
  const closeMs = Date.parse(String(record.bar_close ?? ""));
  const c = live?.confirmation;
  const at = Date.parse(String(c?.candle_time ?? ""));
  if (c?.verified !== true || !finite(at) || !(at > closeMs && at < closeMs + M15)) return [];
  const out = [];
  for (const [side, flag] of [["long", "buy_confirmed"], ["short", "sell_confirmed"]]) {
    if (!sides.includes(side) || c[flag] !== true) continue;
    const plan = sidePlanOf(record, side);
    if (!plan) continue;
    const atr = Number(record.strategy?.atr_h1);
    out.push({ side, event_ms: at, plan: { ...plan, ...(finite(live?.price) ? { price: live.price } : {}), ...(finite(atr) && atr > 0 ? { atr_h1: atr } : {}) } });
  }
  return out;
}

/** Pure: the plan learner's setup for an event's counterfactual: the plan at market from the 5m bar. */
export function eventSetup(row) {
  const p = parse(row.plan_json) ?? {};
  const t = Number(row.event_ms);
  const entry = finite(p.price) ? p.price : p.entry;
  const d = entry - p.entry;
  return { side: row.side === "long" ? "BUY" : "SELL", entry, stop: p.stop + d, tp1: p.tp1 + d, atr_h1: p.atr_h1, at_level: true, opened_ms: t, decided_ms: t, last_seen_ms: t };
}

let schemaReady = new WeakSet();
export const resetEventTriggerSchemaForTests = () => { schemaReady = new WeakSet(); };
async function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS event_triggers (
    decision_key TEXT NOT NULL, side TEXT NOT NULL, event_ms INTEGER NOT NULL, recorded_at TEXT NOT NULL, mode TEXT NOT NULL,
    plan_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', result_json TEXT, r REAL, resolved_at TEXT,
    PRIMARY KEY (decision_key, side))`).run();
  schemaReady.add(db);
}

/**
 * One step: the new events (rows written once per decision and side), then the open rows' counterfactual R.
 * { status, recorded, resolved }. The 5m context is read only while a side is a candidate. Never throws.
 */
export async function runEventTrigger(env, { now = Date.now(), live = undefined, record = undefined, bars = null } = {}) {
  const mode = eventTriggerMode(env);
  if (mode === "off") return { status: "inactive" };
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  try {
    await ensureSchema(db);
    const rec = record !== undefined ? record : parse(await env?.SIGNAL_CACHE?.get?.("decision-engine:latest"));
    const lv = live !== undefined ? live : candidateSidesOf(rec, now).length ? await liveM5Inputs(env, { now }) : null;
    let recorded = 0;
    for (const e of eventsOf(rec, lv, now)) {
      const ins = await db.prepare("INSERT OR IGNORE INTO event_triggers (decision_key, side, event_ms, recorded_at, mode, plan_json) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(rec.decision_key, e.side, e.event_ms, new Date(now).toISOString(), mode, JSON.stringify(e.plan)).run();
      if (!Number(ins?.meta?.changes)) continue;
      recorded += 1;
      console.log(JSON.stringify({ event: "event_trigger", decision_key: rec.decision_key, side: e.side, mode }));
    }
    // The counterfactual R of the open rows (the 1m ledger series), at most 20 a step.
    const open = (await db.prepare("SELECT * FROM event_triggers WHERE status = 'open' AND event_ms <= ? ORDER BY event_ms LIMIT 20").bind(now - M15).all()).results ?? [];
    let resolved = 0;
    if (open.length) {
      const series = bars ?? (await ledgerSeries(env)).bars;
      for (const row of open) {
        const out = setupOutcome(eventSetup(row), series, { now });
        if (out.status === "open") continue;
        const x = Object.values(out.results ?? {})[0] ?? null;
        await db.prepare("UPDATE event_triggers SET status = ?, result_json = ?, r = ?, resolved_at = ? WHERE decision_key = ? AND side = ?")
          .bind(out.status, JSON.stringify(out.results ?? {}), finite(x?.r) ? x.r : null, new Date(now).toISOString(), row.decision_key, row.side).run();
        resolved += 1;
      }
    }
    return { status: "ok", mode, recorded, resolved };
  } catch (e) {
    return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Read only: the rows of the last `days` with their R (no price), newest first, and the totals. */
export async function eventTriggerReport(env, { now = Date.now(), days = 14 } = {}) {
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  try {
    await ensureSchema(db);
    const rows = (await db.prepare("SELECT decision_key, side, event_ms, mode, status, r FROM event_triggers WHERE event_ms >= ? ORDER BY event_ms DESC LIMIT 200").bind(now - days * 86_400_000).all()).results ?? [];
    const rs = rows.filter((r) => r.status === "resolved" && finite(r.r)).map((r) => r.r);
    return { status: "ok", mode: eventTriggerMode(env), n: rows.length, resolved: rs.length, mean_r: rs.length ? Math.round((rs.reduce((a, x) => a + x, 0) / rs.length) * 1000) / 1000 : null, rows };
  } catch (e) { return { status: "failed", reason: String(e?.message ?? e).slice(0, 200) }; }
}
