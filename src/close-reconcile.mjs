// CA1 (2026-11-25): a close the EA executed whose result line never reached the Worker. Measured over 2026-11-18 to
// 2026-11-25: 10 of 28 close intents expired with no result although ea_deals shows the ticket's closing deal 0.3 to
// 1.2 s after the intent, with the deal reason "expert" (the EA's own trade). The terminal's deal is its word that the
// close ran, so such an intent is recorded as done from the deal, once, under every condition below. The bridge and
// the EA are unchanged. Read by the Omega sync (src/omega-broker.mjs bridgeSync) and the 5-minute ledger step (the
// one-time backfill); no model call, no price in an event.
//
// An intent is reconciled to done only when ALL of these hold:
//   1. it is a `close`, `pending`, `sent` or `expired`, with no result (a `failed` or `done` intent is never touched);
//   2. the deal is that ticket's closing deal: the position's last exit deal in ea_deals (the EA reports exit deals
//      only: DEAL_ENTRY_OUT, OUT_BY, INOUT), the position is no longer open in the terminal's report, and the
//      position's exit deals cover its opened volume when the open intent records it (a partial close never counts);
//   3. the deal reason is "expert" and its time is at or after the intent's created_ms and at most
//      CLOSE_RECONCILE.window_ms (5 s) after it (sl, tp, stop_out, manual and every other reason never reconcile);
//   4. one deal, one intent: among the close, partial_close and close_all intents whose window holds the deal, only the
//      earliest may take it, and only when it is a close with no result; a deal another intent already took is never
//      used again.
// The result carries `reconciled_from: "ea_deals"` and the deal's ticket, so a reconciled done reads apart from an
// acked done; the event is `intent_reconciled` (actor "engine"), never an EA acknowledgement. A later EA result does not
// change a done intent (the bridge result path updates pending, sent and expired only).

/** The rule's numbers. live_lookback_ms bounds the sync's pass; backfill_days the one-time pass. */
export const CLOSE_RECONCILE = Object.freeze({ window_ms: 5_000, reason: "expert", live_lookback_ms: 30 * 60_000, backfill_days: 30, deal_lookback_ms: 7 * 86_400_000, limit: 200, backfill_limit: 500 });
/** KV marker of the one-time 30-day backfill (its presence: never run again). */
export const CLOSE_RECONCILE_BACKFILL_KEY = "omega:close_reconcile:backfill:v1";
/** The result's marker. */
export const RECONCILED_FROM = "ea_deals";

const DAY_MS = 86_400_000;
const BACKFILL_PAGES = 10;
const VOL_EPS = 1e-9;
const RECONCILABLE = new Set(["pending", "sent", "expired"]);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const parse = (text, fallback = null) => { try { return text == null ? fallback : JSON.parse(text); } catch { return fallback; } };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Pure: whether an omega_intents row may be reconciled (a close with no result, not failed and not done). */
export function reconcilableClose(row) {
  return row?.kind === "close" && RECONCILABLE.has(row?.status) && (row?.result == null || row.result === "");
}

/** Pure: the opened volume an open or place_limit payload records, or null (a manual position has none). */
export function openedVolume(kind, payload) {
  const p = typeof payload === "string" ? parse(payload, {}) : (payload ?? {});
  if (kind === "place_limit") {
    const lot = num(p.lot);
    if (lot != null && lot > 0) return lot;
    const m = /^\s*([0-9]*\.?[0-9]+)\s*@/.exec(String(p.volume ?? ""));
    return m ? Number(m[1]) : null;
  }
  const v = num(p.volume);
  return v != null && v > 0 ? v : null;
}

/** Pure: the result a reconciled close records (the deal's time and exit price, the marker and the deal's ticket). */
export function reconciledResult(intent, deal) {
  const closed = num(deal?.closed_ms), created = num(intent?.created_ms), exit = num(deal?.exit_price);
  return {
    ok: true,
    ticket: num(intent?.ticket) ?? num(deal?.position_ticket),
    error: null,
    executed_ms: closed,
    fill_price: exit != null && exit > 0 ? exit : null,
    slippage_pts: null,
    latency_ms: closed != null && created != null ? Math.max(0, closed - created) : null,
    reconciled: true,
    reconciled_from: RECONCILED_FROM,
    deal_ticket: num(deal?.deal_ticket)
  };
}

/**
 * Pure: which close intents the deals reconcile. `intents` are omega_intents rows { id, kind, status, result,
 * created_ms, ticket } (close, partial_close and close_all, every status, covering each candidate's window);
 * `deals` ea_deals rows { deal_ticket, position_ticket, volume, reason, closed_ms, exit_price }, every exit deal of the
 * candidates' positions; `openVolumes` { [ticket]: opened volume } where an open intent records it; `openTickets` the
 * tickets open in the terminal's report. Only candidates created within [sinceMs, untilMs] are reconciled.
 * Returns { matches: [{ id, ticket, deal_ticket, result }], skipped: [{ ticket, why }] }.
 */
export function planCloseReconcile({ intents = [], deals = [], openVolumes = {}, openTickets = new Set(), sinceMs = -Infinity, untilMs = Infinity, windowMs = CLOSE_RECONCILE.window_ms } = {}) {
  const rows = (Array.isArray(intents) ? intents : []).map((r) => ({ ...r, ticket: num(r?.ticket), created_ms: num(r?.created_ms) })).filter((r) => typeof r.id === "string" && r.created_ms != null);
  const open = openTickets instanceof Set ? new Set([...openTickets].map(Number)) : new Set((Array.isArray(openTickets) ? openTickets : []).map(Number));
  // Every exit deal per position, once per deal ticket, oldest first.
  const byPos = new Map(), seenDeal = new Set();
  for (const d of Array.isArray(deals) ? deals : []) {
    const pos = num(d?.position_ticket), dt = num(d?.deal_ticket), at = num(d?.closed_ms);
    if (!(pos > 0) || !(dt > 0) || at == null || seenDeal.has(dt)) continue;
    seenDeal.add(dt);
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push({ ...d, position_ticket: pos, deal_ticket: dt, closed_ms: at, volume: num(d.volume) ?? 0 });
  }
  for (const list of byPos.values()) list.sort((a, b) => a.closed_ms - b.closed_ms || a.deal_ticket - b.deal_ticket);
  // A deal one intent already took is never used again (one-to-one).
  const claimed = new Set(rows.map((r) => num(parse(r.result, null)?.deal_ticket)).filter((t) => t > 0));
  const candidates = rows.filter((r) => reconcilableClose(r) && r.ticket > 0 && r.created_ms >= sinceMs && r.created_ms <= untilMs);
  const matches = [], skipped = [];
  for (const ticket of [...new Set(candidates.map((r) => r.ticket))]) {
    const skip = (why) => skipped.push({ ticket, why });
    if (open.has(ticket)) { skip("position_open"); continue; }
    const list = byPos.get(ticket);
    if (!list?.length) { skip("no_deal"); continue; }
    const last = list.at(-1);
    if (String(last.reason ?? "").toLowerCase() !== CLOSE_RECONCILE.reason) { skip("deal_reason"); continue; }
    if (claimed.has(last.deal_ticket)) { skip("deal_taken"); continue; }
    const opened = num(openVolumes?.[ticket]);
    const closedVol = list.reduce((s, d) => s + (d.volume > 0 ? d.volume : 0), 0);
    if (opened != null && opened > 0 && closedVol + VOL_EPS < opened) { skip("partial_volume"); continue; }
    // Every intent that could have sent this deal: created at most windowMs before it, never after it.
    const inWindow = rows.filter((r) => (r.kind === "close_all" || ((r.kind === "close" || r.kind === "partial_close") && r.ticket === ticket))
      && r.created_ms <= last.closed_ms && last.closed_ms <= r.created_ms + windowMs)
      .sort((a, b) => a.created_ms - b.created_ms || String(a.id).localeCompare(String(b.id)));
    const first = inWindow[0];
    if (!first) { skip("outside_window"); continue; }
    if (first.kind !== "close" || !reconcilableClose(first) || first.created_ms < sinceMs || first.created_ms > untilMs) { skip("earlier_intent"); continue; }
    claimed.add(last.deal_ticket);
    matches.push({ id: first.id, ticket, deal_ticket: last.deal_ticket, result: reconciledResult(first, last) });
  }
  return { matches, skipped };
}

const chunks = (list, n = 50) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

async function writeEvent(db, now, detail) {
  try { await db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(now, "engine", "intent_reconciled", JSON.stringify(detail)).run(); } catch { /* the intent is recorded; the audit row is lost */ }
}

/**
 * Reconciles the lost close acks among the close intents created within [sinceMs, untilMs], at most `limit` of them.
 * `openTickets` (a Set) is the terminal's open positions; without it nothing is done (status "no_state"). Idempotent:
 * a reconciled intent has a result and is never a candidate again. `log(action, detail)` writes the audit row (default:
 * an omega_events row `intent_reconciled`, actor "engine"). Never throws.
 * Returns { status: "none" | "ran" | "no_state" | "failed", candidates, reconciled, ids, last_created_ms }.
 */
export async function reconcileLostCloses(db, { now = Date.now(), openTickets = null, sinceMs = now - CLOSE_RECONCILE.live_lookback_ms, untilMs = now, limit = CLOSE_RECONCILE.limit, log = null, backfill = false } = {}) {
  if (!(openTickets instanceof Set)) return { status: "no_state", candidates: 0, reconciled: 0, ids: [] };
  try {
    const n = Math.max(1, Math.min(1000, Math.round(Number(limit) || CLOSE_RECONCILE.limit)));
    const cands = (await db.prepare("SELECT id, created_ms, json_extract(payload, '$.ticket') AS ticket FROM omega_intents WHERE status IN ('pending', 'sent', 'expired') AND created_ms >= ? AND created_ms <= ? AND kind = 'close' AND result IS NULL ORDER BY created_ms, id LIMIT ?")
      .bind(sinceMs, untilMs, n).all()).results ?? [];
    if (!cands.length) return { status: "none", candidates: 0, reconciled: 0, ids: [] };
    const minC = Math.min(...cands.map((r) => Number(r.created_ms))), maxC = Math.max(...cands.map((r) => Number(r.created_ms)));
    const tickets = [...new Set(cands.map((r) => Number(r.ticket)).filter((t) => Number.isInteger(t) && t > 0))];
    const windowMs = CLOSE_RECONCILE.window_ms;
    // Every intent that could compete for a candidate's deal (created at most windowMs before it).
    const intents = (await db.prepare("SELECT id, kind, status, result, created_ms, json_extract(payload, '$.ticket') AS ticket FROM omega_intents WHERE created_ms >= ? AND created_ms <= ? AND kind IN ('close', 'partial_close', 'close_all')")
      .bind(minC - windowMs, maxC).all()).results ?? [];
    const deals = [], openVolumes = {};
    const since = minC - CLOSE_RECONCILE.deal_lookback_ms;
    for (const part of chunks(tickets)) {
      const marks = part.map(() => "?").join(", ");
      deals.push(...((await db.prepare(`SELECT deal_ticket, position_ticket, volume, reason, closed_ms, exit_price FROM ea_deals WHERE closed_ms >= ? AND position_ticket IN (${marks})`).bind(since, ...part).all()).results ?? []));
      for (const r of (await db.prepare(`SELECT kind, payload, json_extract(result, '$.ticket') AS ticket FROM omega_intents WHERE kind IN ('open', 'place_limit') AND created_ms >= ? AND json_extract(result, '$.ticket') IN (${marks})`).bind(since, ...part).all()).results ?? []) {
        const v = openedVolume(r.kind, r.payload);
        if (v != null && openVolumes[Number(r.ticket)] == null) openVolumes[Number(r.ticket)] = v;
      }
    }
    const { matches } = planCloseReconcile({ intents, deals, openVolumes, openTickets, sinceMs, untilMs, windowMs });
    const ids = [];
    for (const m of matches) {
      const res = await db.prepare("UPDATE omega_intents SET status = 'done', result = ?, updated_ms = ? WHERE id = ? AND kind = 'close' AND result IS NULL AND status IN ('pending', 'sent', 'expired')")
        .bind(JSON.stringify(m.result), now, m.id).run();
      if (!(Number(res?.meta?.changes ?? 1) > 0)) continue;
      ids.push(m.id);
      const detail = { id: m.id, kind: "close", ticket: m.ticket, deal_ticket: m.deal_ticket, from: RECONCILED_FROM, ...(backfill ? { backfill: true } : {}) };
      if (typeof log === "function") { try { await log("intent_reconciled", detail); } catch { /* the intent is recorded */ } } else await writeEvent(db, now, detail);
    }
    return { status: "ran", candidates: cands.length, reconciled: ids.length, ids, last_created_ms: maxC };
  } catch (e) {
    return { status: "failed", candidates: 0, reconciled: 0, ids: [], error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Pure: the open tickets of a stored executor state (omega_bridge.state), or null when it cannot be read. */
export function openTicketsOf(state) {
  const s = typeof state === "string" ? parse(state, null) : state;
  if (!s || typeof s !== "object" || !Array.isArray(s.positions)) return null;
  return new Set(s.positions.map((p) => Number(p?.ticket)).filter((t) => Number.isInteger(t) && t > 0));
}

/**
 * The one-time backfill (CA1): the same reconcile over the close intents of the last CLOSE_RECONCILE.backfill_days
 * days, from the 5-minute ledger step, guarded by the KV marker CLOSE_RECONCILE_BACKFILL_KEY (present: nothing is read
 * or written again). The open tickets are the last stored terminal state's; without a readable state, or when the pass
 * met its limit, the marker is not written and the next run goes on (each run is idempotent). Never throws.
 */
export async function closeReconcileBackfill(env, { now = Date.now() } = {}) {
  const kv = env?.SIGNAL_CACHE, db = env?.DB;
  if (!db || !kv?.get || !kv?.put) return { status: "unavailable" };
  try {
    const marker = await kv.get(CLOSE_RECONCILE_BACKFILL_KEY);
    if (marker) return { status: "done" };
    let row = null;
    try { row = await db.prepare("SELECT state FROM omega_bridge WHERE id = 1").first(); } catch { row = null; }
    const openTickets = openTicketsOf(row?.state ?? null);
    if (!openTickets) return { status: "no_state" };
    const limit = CLOSE_RECONCILE.backfill_limit;
    const sinceMs = now - CLOSE_RECONCILE.backfill_days * DAY_MS;
    // Pages of `limit` candidates, oldest first, at most BACKFILL_PAGES a run; the marker only once the window is read.
    let from = sinceMs, candidates = 0, reconciled = 0, complete = false;
    for (let page = 0; page < BACKFILL_PAGES; page++) {
      const r = await reconcileLostCloses(db, { now, openTickets, sinceMs: from, untilMs: now, limit, backfill: true });
      if (r.status === "failed" || r.status === "no_state") return { status: r.status, error: r.error ?? null, candidates, reconciled };
      candidates += r.candidates; reconciled += r.reconciled;
      if (r.candidates < limit) { complete = true; break; }
      // The next page starts at the last page's newest created_ms (inclusive: rows of that same millisecond are read
      // again, which changes nothing); a page that cannot advance ends the run.
      if (!(Number(r.last_created_ms) > from)) break;
      from = Number(r.last_created_ms);
    }
    if (!complete) return { status: "partial", candidates, reconciled };
    await kv.put(CLOSE_RECONCILE_BACKFILL_KEY, JSON.stringify({ at_ms: now, since_ms: sinceMs, candidates, reconciled }));
    return { status: "ran", candidates, reconciled };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}
