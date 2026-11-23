// V3L (owner 2026-11-23, relayed by the orchestrator, verbatim: "Make v3 follow the limit entry (Rekomendasi)"): the
// Signal Ledger's Omega policy v3 (src/signal-ledger.mjs simulateOmega) enters as live Omega enters under the Omega
// setting `entry_order` in force at the decision. "market" is v3 as before, byte for byte. "limit" and "council" rest a
// limit instead of a market fill, through the live engine's and the limit counterfactual's own functions (none copied):
//   council    the live entry council's recorded answer for the signal (D1 limit_council, kind entry; as v4 replays the
//              Position Council's recorded verdicts): under "limit" anything but place_limit skips (council_skip), and no
//              answer is the mechanical fallback, the limit placed (the counterfactual's rule); under "council" a skip
//              skips, place_limit rests a limit, enter_market or no answer (live's silent council) is v3's market entry;
//   placement  limitPlacement (src/omega-engine.mjs: the level on the feed's scale, basis 0, the placement band, EZ1's
//              zoneLimit inside the entry zone where the level is through price, EZ1b's zoneEdgeLimit at the zone's near
//              edge out of the band, zone_passed / zone_tight / zone_rr, limit_through_price, limit_out_of_band) at each
//              bar's open from the first bar after the decision (the minute it was made on 1m bars; not before the
//              council's answer), while the signal is live (until the next 15m close and max_signal_age after the
//              decision), as live planIntents tries again at every sync; the last refusal is the row's gate (a missed
//              entry, never a market fallback);
//   resting    from the next bar's open, limitCancelReason (src/ledger-omega-limit.mjs: pending_expired after the mode's
//              max_pending_life, decision_against, quorum_share_drop with CH1's thresholds), then SS1 (src/limit-
//              supersede.mjs, limit_supersede "on"): a newer decision on the row's side ends it (superseded_by_signal);
//   rules      EZ1, EZ1b and SS1 only from their own live deploys (V3L_RULES_FROM), entry_order from the settings' history:
//              the recompute reflects only the rules live had at each decision;
//   fill       limitFillPrice (src/ledger-omega-limit.mjs): a BUY when the ask's low reaches the level, a SELL when the
//              bid's high does; a gap through it fills at the open. The stop and the target stay where the placement
//              put them (the plan's, also for a level moved inside the zone), and v3's management runs from the fill, its R
//              on the risk from the fill to that stop.
// Not modelled: the council's keep and move of a resting order, the fill-time re-check of the hard guards, the broker's
// basis (feed scale). v3's own account gate (omegaGate) is decided at the fill, as for a market entry. No price is kept
// in omega_json: times, codes, R and the distance in R only.
import { decisionCloseMs, toMs, HOLD_MAX_MS, OMEGA_SIM } from "./signal-ledger.mjs";
import { limitPlacement, OMEGA_DEFAULTS } from "./omega-engine.mjs";
import { entryZoneFields } from "./ea-signal.mjs";
import { limitCancelReason, limitFillPrice } from "./ledger-omega-limit.mjs";
import { limitSupersedeOn, SUPERSEDE_REASON } from "./limit-supersede.mjs";
import { changeTokens, decisionHistory } from "./change-thresholds.mjs";

const M1 = 60_000, M15 = 15 * M1;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const iso = (ms) => new Date(ms).toISOString();
const spanMs = (b) => toMs(b.close_time) - toMs(b.open_time);
export const ENTRY_ORDERS = Object.freeze(["market", "limit", "council"]);
/** Whether an entry_order rests a limit (V3L: "limit" and "council"). */
export const isLimitEntry = (entryOrder) => entryOrder === "limit" || entryOrder === "council";

// ---------------------------------------------------------------------------
// The entry_order in force at a time, from the settings history Omega already audits (omega_events "settings": each
// save's whole settings, src/omega-broker.mjs writeSettings) and the stored settings (omega_settings id 1).

/**
 * Pure: entry_order at a time. `events` [{ ms, entry_order }] (any order; a value that is not an entry order is skipped),
 * `current` { entry_order, updated_ms } (the stored settings). At `ms`: the stored value from its save on; before it, the
 * last audited save at or before `ms`; before the first one (or with no history at all) "market", the default.
 */
export function entryOrderTimeline(events = [], current = null) {
  const list = (Array.isArray(events) ? events : []).filter((e) => finite(Number(e?.ms)) && ENTRY_ORDERS.includes(e?.entry_order)).map((e) => ({ ms: Number(e.ms), v: e.entry_order })).sort((a, b) => a.ms - b.ms);
  const cur = ENTRY_ORDERS.includes(current?.entry_order) ? current.entry_order : null, curMs = Number(current?.updated_ms);
  return (ms) => {
    if (cur && finite(curMs) && ms >= curMs) return cur;
    let v = "market";
    for (const e of list) { if (e.ms > ms) break; v = e.v; }
    return v;
  };
}

/** The entry_order timeline from D1 (never the actor: the settings' audit holds who saved them). Never throws: "market". */
export async function loadEntryOrders(env) {
  const db = env?.DB;
  let events = [], current = null;
  try { events = ((await db.prepare("SELECT ms, json_extract(detail, '$.entry_order') AS entry_order FROM omega_events WHERE action = 'settings' ORDER BY ms").all()).results ?? []); } catch { events = []; }
  try {
    const row = await db.prepare("SELECT settings, updated_ms FROM omega_settings WHERE id = 1").first();
    const s = row?.settings ? JSON.parse(row.settings) : null;
    if (s) current = { entry_order: s.entry_order ?? OMEGA_DEFAULTS.entry_order, updated_ms: Number(row.updated_ms) };
  } catch { current = null; }
  return entryOrderTimeline(events, current);
}

// ---------------------------------------------------------------------------
// The limit entry of one ledger row.

/** Pure: the decisions as limitCancelReason reads them: the quorum's shares and the history before each (CH1). */
export function withDecisionHistory(decisions = []) {
  const sorted = (Array.isArray(decisions) ? decisions : []).filter((d) => d && finite(d.close_ms)).slice().sort((a, b) => a.close_ms - b.close_ms);
  return sorted.map((d, i) => ({ ...d, decision_history: decisionHistory(d, i > 0 ? sorted[i - 1] : null, i > 1 ? sorted[i - 2] : null) }));
}

/**
 * The rules live Omega had only from their own deploys (orchestrator ruling on V3L, 2026-11-23: the recompute reflects
 * only the rules live actually had): each rule's first live millisecond, from the AI Worker's deploy job ("Validate and
 * deploy Cloudflare Worker", step "Deploy Worker" completed) of its merge commit, and SS1's from the orchestrator.
 *   ez1   EZ1, the limit inside the entry zone (#533, 3c301ff, merged 04:02:21Z, deployed 04:05:15Z);
 *   ez1b  EZ1b, the zone's near edge out of the band (#534, 8edcd37, merged 07:54:10Z, deployed 07:57:38Z);
 *   ss1   SS1, a newer same-side signal supersedes a resting limit (live deploy 15:43:27Z).
 * A rule is read at the moment it acts: EZ1/EZ1b at each placement attempt, SS1 at the bar the newer signal ends the
 * order and at the new decision's hold-back. Before it, v3 enters without it (as live did then).
 */
export const V3L_RULES_FROM = Object.freeze({
  ez1: Date.parse("2026-11-23T04:05:15Z"),
  ez1b: Date.parse("2026-11-23T07:57:38Z"),
  ss1: Date.parse("2026-11-23T15:43:27Z")
});
/** Pure: whether `rule` was live at `ms` (V3L_RULES_FROM by default; an unknown rule never is). */
export const ruleActive = (rule, ms, rulesFrom = V3L_RULES_FROM) => finite(rulesFrom?.[rule]) && finite(ms) && ms >= rulesFrom[rule];

/**
 * Pure: the signal limitPlacement reads, from a ledger row and its own decision (feed scale, basis 0), with the rules
 * live had at `atMs`: the entry zone only once EZ1 was live, its near edge only once EZ1b was.
 */
export function limitSignalOf(signal, own = null, { atMs = Infinity, rulesFrom = V3L_RULES_FROM } = {}) {
  const side = signal.side;
  const zone = ruleActive("ez1", atMs, rulesFrom) ? entryZoneFields({ entry_low: own?.entry_low, entry_high: own?.entry_high, entry: signal.entry, stop: signal.stop }, side) : {};
  return {
    side, entry: signal.entry, stop: signal.stop, tp1: signal.tp1, trading_mode: signal.trading_mode ?? own?.mode ?? null,
    feed_basis: 0, feed_basis_known: true, ...zone, ...(ruleActive("ez1b", atMs, rulesFrom) && own?.entry_zone_mode === "edge" && Object.keys(zone).length ? { entry_zone_edge: true } : {})
  };
}

/**
 * Pure: a ledger row's entry by a resting limit (see the header), on `bars` (the ledger's, oldest first) up to `now`.
 * `decisions` the stream with quorum shares (withDecisionHistory applied), `settings` the Omega settings (CH1 tokens,
 * limit_supersede). Returns omegaEntry's shape:
 *   { status: "filled", bar, fill, filled_at, sl, tp, limit }   sl/tp where the placement put them;
 *   { status: "skipped", gate, limit }                          refused at placement, cancelled, superseded or expired;
 *   { status: "pending", limit? }                               still waiting for the placement's bar or resting.
 * `limit` is what omega_json keeps of it: { placed_at, ended_at, life_min, wait_min, away_r, basis } (no price).
 */
export function limitEntry(signal, bars, { now = Date.now(), decisions = [], settings = OMEGA_DEFAULTS, spread = OMEGA_SIM.spread, own = null, verdict = null, entryOrder = "limit", rulesFrom = V3L_RULES_FROM } = {}) {
  const closeMs = decisionCloseMs(signal.candle_key);
  if (!finite(closeMs)) return { status: "skipped", gate: "no_decision_bar" };
  const opened = toMs(signal.opened_at);
  const decidedMs = finite(opened) ? Math.max(closeMs, opened) : closeMs;
  const k = bars.findIndex((b) => toMs(b.open_time) >= closeMs && (spanMs(b) >= M15 || toMs(b.open_time) >= decidedMs));
  if (k < 0 || toMs(bars[k].close_time) > now) return now - closeMs > HOLD_MAX_MS ? { status: "skipped", gate: "no_bars" } : { status: "pending" };
  // The live entry council's recorded answer for this signal: a skip skips it (as live, no order).
  if (verdict && councilRoute(entryOrder, verdict) === "skip") return { status: "skipped", gate: "council_skip", limit: { placed_at: null, council: String(verdict.rule ?? verdict.choice ?? "").slice(0, 60) || null } };
  const changes = changeTokens(settings);
  const side = signal.side, dir = side === "BUY" ? 1 : -1;
  const planStopDist = Math.abs(signal.entry - signal.stop);
  const sigAt = (t) => limitSignalOf(signal, own, { atMs: t, rulesFrom });
  let sig = null;
  // Live tries to place at every sync while the signal is live (planIntents' entryLive), and not before the council answered.
  const until = Math.min(closeMs + M15, decidedMs + (Number(settings?.max_signal_age_ms) || OMEGA_DEFAULTS.max_signal_age_ms));
  const askedMs = finite(Number(verdict?.at_ms)) ? Number(verdict.at_ms) : -Infinity;
  let j0 = bars.findIndex((b, i) => i >= k && toMs(b.open_time) >= askedMs);
  if (j0 < 0) return now < until ? { status: "pending" } : { status: "skipped", gate: "expired" };
  if (toMs(bars[j0].open_time) >= until) return { status: "skipped", gate: "expired" };
  let lim = null;
  for (;;) {
    const b = bars[j0];
    if (toMs(b.close_time) > now) return { status: "pending" };
    const sym = { digits: 2, point: 0.01, spread_points: Math.round(spread / 0.01), stops_level_points: 0, bid: r2(b.open), ask: r2(b.open + spread) };
    sig = sigAt(toMs(b.open_time));
    lim = limitPlacement({ signal: sig, sym, account: { margin_mode: "hedging" }, planStopDist, minDist: 0, changes });
    if (lim.ok) break;
    const next = j0 + 1;
    if (next >= bars.length || toMs(bars[next].open_time) >= until) break;
    j0 = next;
  }
  const k1 = j0, b0 = bars[k1], t0 = toMs(b0.open_time);
  const basis = lim.entry_basis === "zone_edge" ? "zone_edge" : lim.moved ? "zone" : "level";
  const meta = (extra = {}) => ({ placed_at: iso(t0), away_r: r3(lim.away_r), basis, life_min: lim.knobs?.max_pending_life ?? null, ...extra });
  if (!lim.ok) {
    // The data ends inside the signal's life: it may still be placed at a later bar.
    if (k1 + 1 >= bars.length && now < until) return { status: "pending" };
    return { status: "skipped", gate: lim.code, limit: { ...meta(), placed_at: null, tried_at: iso(t0) } };
  }
  const level = lim.price, sl = finite(lim.sl) ? lim.sl : signal.stop, tp = finite(lim.tp) ? lim.tp : signal.tp1;
  const own0 = (decisions.find((d) => d.close_ms === closeMs) ?? own) || null;
  const share0 = Number(own0?.quorum?.[side === "BUY" ? "long_share" : "short_share"]);
  const pending = { side, placed_ms: t0, close_ms: closeMs, issued_ms: closeMs, knobs: lim.knobs, share0, mode: sig.trading_mode, profile: null };
  const known = (d) => (finite(d.at_ms) ? d.at_ms : d.close_ms);
  const supersede = limitSupersedeOn(settings);
  let d = -1;
  for (let j = k1; j < bars.length; j++) {
    const b = bars[j], t = toMs(b.open_time);
    if (toMs(b.close_time) > now) return { status: "pending", limit: meta() };
    if (j > k1) {
      // At the bar's open, as the counterfactual's atOpen: the deterministic cancels, then a newer same-side signal (SS1).
      while (d + 1 < decisions.length && known(decisions[d + 1]) <= t) d += 1;
      const dec = d >= 0 ? decisions[d] : null;
      const gate = limitCancelReason({ pending, now: t, decision: dec, mode: "active", settings });
      if (gate) return { status: "skipped", gate, limit: meta({ ended_at: iso(t), wait_min: Math.round((t - t0) / M1) }) };
      if (supersede && ruleActive("ss1", t, rulesFrom) && dec && dec.close_ms > closeMs && dec.stance === side && dec.action) return { status: "skipped", gate: SUPERSEDE_REASON, limit: meta({ ended_at: iso(t), wait_min: Math.round((t - t0) / M1) }) };
    }
    const px = limitFillPrice({ side, level, bar: { o: b.open, h: b.high, l: b.low }, spread });
    if (px == null) continue;
    // A fill already past the placement's stop (a gap through both) never trades, as omegaEntry's stop_breached.
    if (!(dir * (px - sl) > 0)) return { status: "skipped", gate: "stop_breached", limit: meta({ ended_at: iso(t) }) };
    return { status: "filled", bar: j, fill: px, filled_at: b.open_time, sl, tp, limit: meta({ wait_min: Math.round((t - t0) / M1) }) };
  }
  // The bars end with the order still resting: pending inside its life, else expired.
  const lifeEnd = t0 + (lim.knobs?.max_pending_life ?? 0) * M1;
  return now < lifeEnd ? { status: "pending", limit: meta() } : { status: "skipped", gate: "pending_expired", limit: meta({ ended_at: iso(lifeEnd) }) };
}

/**
 * Pure: what the live entry council's recorded answer (limit_council kind entry: { choice, rule }) makes of a signal under
 * `entryOrder`: "skip", "market" or "limit". Under "limit" anything but place_limit is a skip (planIntents' council_skip);
 * no answer is the mechanical fallback, a limit (the counterfactual's rule). Under "council" a skip skips, place_limit
 * rests a limit, and enter_market or no answer (live: a silent council is today's market path) is v3's market entry.
 */
export function councilRoute(entryOrder, verdict) {
  const choice = verdict?.choice ?? null;
  if (entryOrder === "council") return choice === "skip" ? "skip" : choice === "place_limit" ? "limit" : "market";
  if (!choice) return "limit";
  return choice === "place_limit" ? "limit" : "skip";
}

/** The live entry council's answers since `sinceMs`, by open id ("open:<decision close ms>:<B|S>"). Never throws: empty. */
export async function loadEntryVerdicts(env, { sinceMs }) {
  const out = new Map();
  try {
    for (const r of (await env.DB.prepare("SELECT open_id, choice, rule, at_ms FROM limit_council WHERE kind = 'entry' AND status = 'answered' AND at_ms >= ?").bind(sinceMs).all()).results ?? []) {
      if (typeof r.open_id === "string" && r.open_id) out.set(r.open_id, { choice: r.choice ?? null, rule: r.rule ?? null, at_ms: Number(r.at_ms) });
    }
  } catch { /* none */ }
  return out;
}
/** The open id live Omega gives a decision's entry (its close ms and side). */
export const entryOpenId = (closeMs, side) => `open:${closeMs}:${side === "BUY" ? "B" : "S"}`;

// ---------------------------------------------------------------------------
// The parity check against the live account: v3 trade or no trade per decision, per UTC day.

/**
 * Pure: v3's trade/no-trade against live Omega's on the ledger's decision rows, per UTC day of the decision. `live` is
 * the set (or array) of the decision closes (signal_issued_ms) whose Omega entry filled live. A row counts once v3 is
 * final for it (skipped, open or closed); v3 traded = open or closed. Days newest first.
 */
export function v3LiveParity(rows = [], live = [], { sinceMs = -Infinity, days = 14 } = {}) {
  const set = live instanceof Set ? live : new Set((Array.isArray(live) ? live : []).map(Number).filter(finite));
  const by = new Map();
  for (const x of rows) {
    if (x?.source !== "decision" || !["skipped", "open", "closed"].includes(x.omega_status)) continue;
    const at = toMs(x.opened_at), close = decisionCloseMs(x.candle_key);
    if (!finite(at) || at < sinceMs || !finite(close)) continue;
    const day = iso(at).slice(0, 10);
    const g = by.get(day) ?? { day, decisions: 0, agree: 0, v3_traded: 0, live_traded: 0, both: 0, v3_only: 0, live_only: 0 };
    const v3 = x.omega_status !== "skipped", lv = set.has(close);
    g.decisions += 1; g.agree += v3 === lv ? 1 : 0; g.v3_traded += v3 ? 1 : 0; g.live_traded += lv ? 1 : 0;
    g.both += v3 && lv ? 1 : 0; g.v3_only += v3 && !lv ? 1 : 0; g.live_only += lv && !v3 ? 1 : 0;
    by.set(day, g);
  }
  const list = [...by.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, days).map((g) => ({ ...g, share: g.decisions ? r3(g.agree / g.decisions) : null }));
  const n = list.reduce((a, g) => a + g.decisions, 0), agree = list.reduce((a, g) => a + g.agree, 0);
  return { rule: "per decision: v3 traded (open or closed) against an Omega entry filled live for it (limit_filled, or a done market open); per UTC day", decisions: n, agree, share: n ? r3(agree / n) : null, days: list };
}

/** The decision closes (signal_issued_ms) whose Omega entry filled live since `sinceMs`. Never throws: an empty set. */
export async function loadLiveEntries(env, { sinceMs }) {
  const out = new Set(), db = env?.DB;
  try { for (const r of (await db.prepare("SELECT json_extract(detail, '$.signal_issued_ms') AS s FROM omega_events WHERE action = 'limit_filled' AND ms >= ?").bind(sinceMs).all()).results ?? []) if (finite(Number(r.s)) && r.s != null) out.add(Number(r.s)); } catch { /* none */ }
  try { for (const r of (await db.prepare("SELECT json_extract(payload, '$.signal_issued_ms') AS s FROM omega_intents WHERE kind = 'open' AND status = 'done' AND id LIKE 'open:%' AND created_ms >= ? AND CAST(json_extract(result, '$.ticket') AS INTEGER) > 0").bind(sinceMs).all()).results ?? []) if (finite(Number(r.s)) && r.s != null) out.add(Number(r.s)); } catch { /* none */ }
  return out;
}
