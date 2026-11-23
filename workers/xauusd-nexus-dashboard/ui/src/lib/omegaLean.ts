// OM-LEAN (owner-approved mockup 1795450033-0f25, 2026-11-23: "Setuju, bangun (Rekomendasi)"): the Omega page as one
// screen that answers four questions (running and connected? what is open or resting and its risk? the signal and what
// Omega did, in one line? the last few actions?), everything else behind one Details disclosure. The page's pure parts:
// the connection state, the state chip, the engine-off wording, the risk at the stop (positions and mapped orders), the
// "At stops" sum, the signal line and Omega's verdict, and the Last actions list. Display only: every value is a field
// of GET /omega/api/overview the page already reads. No React, no request.
import { isNum, type Side, type Zone, signalZoneOf, zoneToBroker, utcClockOf, gmt7ClockOf } from "./entryZone.ts";

export type StatusTone = "ok" | "late" | "fault" | "off";

// ---------------------------------------------------------------- numbers

/** Money to the cent with a sign and a true minus ("+25.40", "−11.40", "0.00"); "—" without a number. Neutral: no colour. */
export function signedMoney(v: unknown): string {
  if (!isNum(v)) return "—";
  const r = Math.round(v * 100) / 100;
  if (r === 0) return "0.00";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}`;
}
/** An amount with thousands separators and two decimals ("10,014.00"); "—" without a number. */
export const amount = (v: unknown): string => (isNum(v) ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");
/** A % with one decimal and its sign ("+0.1%", "−3.0%"). */
export const signedPct = (v: unknown): string => (isNum(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%` : "—");

/** An age as the header says it: "3s", "4 min", "2 h". */
export function shortAge(ms: unknown): string {
  if (!isNum(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(1, s)}s`;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

// ---------------------------------------------------------------- 1. running and connected?

/** The terminal's state is stale from 60 s (the server sets terminal_connected and trade_allowed false there). */
export const STATE_STALE_MS = 60_000;
export type ConnKey = "disconnected" | "stale" | "algo_off" | "connected";
export type Conn = { key: ConnKey; tone: StatusTone; label: string; detail: string };

/**
 * The header's one status, decided in this order (reviewer's ruling 2): Disconnected when the bridge has not synced
 * for 2 minutes (`bridge.seen` false, BRIDGE_SEEN_MS) or the terminal reports an error; else Stale when the terminal's
 * state is 60 s old or more (or there is none); else Algo off when the terminal does not allow algo trading; else
 * Connected. "Algo off" is the page's wording, not a planner code.
 */
export function connState(br: any): Conn {
  const b = br && typeof br === "object" ? br : {};
  const err = typeof b.terminal_error === "string" && b.terminal_error.trim() !== "";
  if (b.seen !== true || err) {
    return { key: "disconnected", tone: "fault", label: "Disconnected", detail: isNum(b.synced_age_ms) ? `last sync ${shortAge(b.synced_age_ms)}` : "never synced" };
  }
  if (!isNum(b.state_age_ms) || b.state_age_ms >= STATE_STALE_MS) {
    return { key: "stale", tone: "late", label: "Stale", detail: isNum(b.state_age_ms) ? `terminal state ${Math.round(b.state_age_ms / 1000)} s old` : "no terminal state" };
  }
  const sync = `sync ${shortAge(b.synced_age_ms)}`;
  if (b.trade_allowed !== true) return { key: "algo_off", tone: "late", label: "Algo off", detail: sync };
  return { key: "connected", tone: "ok", label: "Connected", detail: sync };
}

/** Every account that is not demo (real or contest) trades only once live is armed (omega-engine.mjs: trade_mode !== "demo"). */
export const isLiveAccount = (tradeMode: unknown): boolean => typeof tradeMode === "string" && tradeMode !== "" && tradeMode !== "demo";

/** The scale, stated once in the header. */
export function scaleNote(basis: number | null): string {
  if (!isNum(basis)) return "prices: broker · basis unknown";
  return `prices: broker · chart feed = broker ${basis >= 0 ? "−" : "+"} ${Math.abs(basis).toFixed(2)}`;
}

// ---------------------------------------------------------------- the state chip and the engine switch

export type Chip = { key: "killed" | "paused" | "engine_off_server" | "engine_off" | "active"; label: string; tone: StatusTone };

/**
 * One state chip from the control mode, the kill switch, the engine switch and the server switch (env_enabled):
 * Killed (and "· server" for EA_SIGNALS_ENABLED), Paused, Engine off · server, Engine off, else Active.
 */
export function stateChip(controlMode: unknown, engine: any, signal?: any): Chip {
  const e = engine && typeof engine === "object" ? engine : {};
  const s = signal && typeof signal === "object" ? signal : {};
  if (controlMode === "killed" || s.kill === true) return { key: "killed", label: s.kill === true && s.kill_source === "env" ? "Killed · server" : "Killed", tone: "fault" };
  if (controlMode === "paused") return { key: "paused", label: "Paused", tone: "late" };
  if (e.env_enabled === false) return { key: "engine_off_server", label: "Engine off · server", tone: "off" };
  if (e.enabled !== true) return { key: "engine_off", label: "Engine off", tone: "off" };
  return { key: "active", label: "Active", tone: "ok" };
}

/** Why the engine is off, by which switch: the page's toggle (local) or the Worker's OMEGA_ENGINE_ENABLED (server). */
export const ENGINE_OFF_TEXT = {
  local: "The engine is switched off. Turn it on with the Engine switch, or in Setup.",
  server: "The server switch is off (OMEGA_ENGINE_ENABLED). Only the Worker setting turns it on."
} as const;
export const engineOffText = (envEnabled: unknown): string => (envEnabled === false ? ENGINE_OFF_TEXT.server : ENGINE_OFF_TEXT.local);

// ---------------------------------------------------------------- 2. open and resting, and the risk

export type Risk = { locked: boolean; amount: number; pct: number | null; dist: number };

/**
 * A position's money at its stop (owner 2026-11-18): the loss to the SL in money and % of equity (to 1 decimal), or,
 * once the stop is at or beyond the entry (break-even or a lock), the profit it locks. `dist` keeps the signed distance
 * (BUY entry − stop, SELL stop − entry: > 0 the stop loses, ≤ 0 it locks). Null without a stop, a side or a tick value.
 */
export function riskToSl(p: any, br: any): Risk | null {
  const open = Number(p?.entry ?? p?.open_price), sl = Number(p?.sl), vol = Number(p?.volume);
  const tick = Number(br?.tick_size), value = Number(br?.tick_value);
  if (p?.side !== "BUY" && p?.side !== "SELL") return null;
  if (!(open > 0) || !(sl > 0) || !(vol > 0) || !(tick > 0) || !(value > 0)) return null;
  const dist = Math.round((p.side === "BUY" ? open - sl : sl - open) * 1e8) / 1e8;
  const amt = Math.round((Math.abs(dist) / tick) * value * vol * 100) / 100;
  const eq = Number(br?.equity);
  return dist > 0 ? { locked: false, amount: amt, pct: eq > 0 ? Math.round((amt / eq) * 1000) / 10 : null, dist } : { locked: true, amount: amt, pct: null, dist };
}

/** A pending order in riskToSl's shape: its price, stop, current volume and the side its type names (BUY_LIMIT → BUY). */
export function orderAsPosition(o: any): { ticket: unknown; entry: unknown; sl: unknown; volume: unknown; side: Side | null } {
  const t = typeof o?.type === "string" ? o.type : "";
  return { ticket: o?.ticket, entry: o?.price_open, sl: o?.sl, volume: o?.volume_current ?? o?.volume_initial, side: t.startsWith("BUY") ? "BUY" : t.startsWith("SELL") ? "SELL" : null };
}

/** An order's type in words: BUY_LIMIT → { side: BUY, kind: "limit" }, SELL_STOP_LIMIT → { SELL, "stop limit" }. */
export function orderKind(type: unknown): { side: Side | null; kind: string } {
  const t = typeof type === "string" ? type : "";
  const side = t.startsWith("BUY") ? "BUY" : t.startsWith("SELL") ? "SELL" : null;
  const kind = t.split("_").slice(1).join(" ").toLowerCase() || "order";
  return { side, kind };
}

export type AtStops = { amount: number | null; pct: number | null; noStop: number; text: string };

/**
 * "At stops": the open positions' loss at their stops, summed (a locked stop adds nothing), with its % of equity. A
 * position without a stop is never hidden: the sum then reads "38.20 + 1 without stop" (the engine counts such a
 * position as the whole account). Positions only: a resting order's risk stays on its own row.
 */
export function atStops(positions: unknown, br: any): AtStops {
  const list = Array.isArray(positions) ? positions : [];
  let sum = 0, known = true, noStop = 0;
  for (const p of list) {
    if (!(Number(p?.sl) > 0)) { noStop += 1; continue; }
    const r = riskToSl(p, br);
    if (!r) { known = false; continue; }
    if (!r.locked) sum += r.amount;
  }
  sum = Math.round(sum * 100) / 100;
  if (!known) return { amount: null, pct: null, noStop, text: noStop ? `— + ${noStop} without stop` : "—" };
  const eq = Number(br?.equity);
  const pct = sum > 0 && eq > 0 ? Math.round((sum / eq) * 1000) / 10 : null;
  const text = noStop ? `${sum.toFixed(2)} + ${noStop} without stop` : pct != null ? `${sum.toFixed(2)} (${pct}%)` : sum.toFixed(2);
  return { amount: sum, pct, noStop, text };
}

/** Who a position or order belongs to: Omega, manual, a manual one delegated to Omega, or external. */
export function sourceOf(p: any, delegatedTickets: unknown): "Omega" | "manual" | "delegated" | "external" {
  const manual = p?.source === "manual" || p?.magic === 0;
  if (manual) return (Array.isArray(delegatedTickets) ? delegatedTickets : []).map(Number).includes(Number(p?.ticket)) ? "delegated" : "manual";
  if (p?.source === "omega" || p?.magic === 920200 || String(p?.intent_id ?? "").startsWith("open:") || String(p?.comment ?? "").startsWith("e:")) return "Omega";
  return "external";
}

// ---------------------------------------------------------------- the daily loss cap

/**
 * The daily loss cap's state on the limits line: reached when the planner says daily_loss_limit or the day's P&L
 * (accounts[].day_pl_pct, equity against the day's reference) is at or below −cap; the budget variant when the planner
 * says daily_risk_budget; the profile agent's upgrade block after a daily loss (upgrade_block_reason, _until_ms).
 */
export function dailyLoss({ codes, dayPct, cap, blockReason, blockUntil, now }: { codes: unknown; dayPct: unknown; cap: unknown; blockReason: unknown; blockUntil: unknown; now: number }) {
  const list = Array.isArray(codes) ? codes : [];
  const reached = list.includes("daily_loss_limit") || (isNum(dayPct) && isNum(cap) && cap > 0 && dayPct <= -cap);
  const budget = !reached && list.includes("daily_risk_budget");
  const blockedUntil = blockReason === "daily_loss_limit" && isNum(blockUntil) && blockUntil > now ? blockUntil : null;
  return { reached, budget, blockedUntil };
}

// ---------------------------------------------------------------- 3. the signal and what Omega did

export type SignalLine = { side: Side | null; kind: string; entry: number | null; zone: Zone | null; scale: "broker" | "feed"; expires: string | null };

/**
 * The signal in one line on the header's scale: its side and order kind ("limit", "market"), the entry and the entry
 * zone converted to the broker (+ basis) when the basis is known, else on the feed (marked so), and when it expires.
 */
export function signalLine(s: any, basis: number | null, now: number): SignalLine {
  const sig = s && typeof s === "object" ? s : {};
  const side = sig.side === "BUY" || sig.side === "SELL" ? sig.side : null;
  const act = typeof sig.action === "string" ? sig.action : "";
  const kind = act === "ENTER_LIMIT" ? "limit" : act === "ENTER_MARKET" ? "market" : act.replace(/^ENTER_/, "").toLowerCase();
  const known = isNum(basis);
  const entry = isNum(sig.entry) && sig.entry > 0 ? (known ? Math.round((sig.entry + basis) * 100) / 100 : sig.entry) : null;
  const fz = signalZoneOf(sig);
  const zone = known ? zoneToBroker(fz, basis) : fz;
  let expires: string | null = null;
  if (side && isNum(sig.expires_ms) && sig.expires_ms > 0) {
    const left = sig.expires_ms - now;
    expires = left <= 0 ? "expired" : left < 60_000 ? "expires in under 1 min" : `expires in ${Math.round(left / 60_000)} min`;
  }
  return { side, kind, entry, zone, scale: known ? "broker" : "feed", expires };
}

type Kind = "block" | "adjust" | "info";
export type Verdict = { tone: StatusTone; text: string; code: string | null; kind: Kind | null };

/** Lower-cases a sentence's first letter for "Omega is not entering: …", leaving names and acronyms (Omega…, MT5, R:R). */
function lowerFirst(t: string): string {
  return /^(Omega|[A-Z0-9:]{2,}\b)/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1);
}

/**
 * Omega's verdict on the signal, one sentence (the OmegaWhy wording): the first blocking note, else the first note.
 * Its tone follows OmegaWhy (block red, adjust amber, info cyan), WAIT amber. `reason(code)` is OmegaWhy's omegaReason.
 */
export function verdict({ codes, envEnabled, resting, reason }: { codes: unknown; envEnabled: unknown; resting: { ticket: number | null; price: number } | null; reason: (c: string) => { kind: Kind; text: string } }): Verdict {
  const list = (Array.isArray(codes) ? codes : []).filter((c): c is string => typeof c === "string" && c !== "");
  if (!list.length) return { tone: "off", text: "No planner notes yet.", code: null, kind: null };
  const items = list.map((c) => ({ code: c, ...reason(c) }));
  const it = items.find((i) => i.kind === "block") ?? items[0];
  const where = resting ? `${resting.ticket != null ? `limit #${resting.ticket}` : "a limit"} at ${resting.price.toFixed(2)}` : null;
  const tone: StatusTone = it.kind === "block" ? (it.code === "no_side" ? "late" : "fault") : it.kind === "adjust" ? "late" : "ok";
  const v = (text: string): Verdict => ({ tone, text, code: it.code, kind: it.kind });
  switch (it.code) {
    case "kill": return v(it.text);
    case "paused": return v("Omega is not entering: paused. Open positions are still managed.");
    case "engine_off": return v(`Omega is not entering: ${lowerFirst(engineOffText(envEnabled))}`);
    case "limit_in_zone": return v(where ? `Omega placed ${where} in the zone; the plan's level was through price.` : `Omega: ${lowerFirst(it.text)}`);
    case "limit_zone_edge": return v(where ? `Omega placed ${where} at the zone's near edge; the plan's level is out of the placement band.` : `Omega: ${lowerFirst(it.text)}`);
    case "zone_passed": case "zone_tight": case "zone_rr": return v(`Omega refused it: ${it.text.replace(/^Refused:\s*/, "")}`);
  }
  return v(it.kind === "block" ? `Omega is not entering: ${lowerFirst(it.text)}` : `Omega: ${lowerFirst(it.text)}`);
}

// ---------------------------------------------------------------- 4. the last actions

export type Action = { ms: number; utc: string; gmt7: string; verb: string; ticket: number | null; side: Side | null; lot: number | null; price: number | null; extra: string; fault: boolean; intent: string | null };

const two = (x: number) => x.toFixed(2);
const sideOf = (x: unknown): Side | null => (x === "BUY" || x === "SELL" ? x : null);
const ticketOf = (x: unknown): number | null => (isNum(Number(x)) && Number(x) > 0 && x !== null && x !== "" ? Number(x) : null);

const LIMIT_VERB: Record<string, string> = { placed: "Limit placed", moved: "Limit moved", cancelled: "Limit cancelled", filled: "Limit filled" };
const DEAL_VERB: Record<string, string> = { tp: "Closed at TP", sl: "Closed at SL" };

function intentVerb(i: any): string {
  const kind = typeof i?.kind === "string" ? i.kind : "";
  const id = typeof i?.id === "string" ? i.id : "";
  const status = i?.status;
  const base: string = kind === "place_limit" ? (status === "expired" ? "Limit expired" : status === "done" ? "Limit placed" : "Limit sent")
    : kind === "open" ? "Opened" : kind === "close" ? "Closed" : kind === "close_all" ? "Closed all" : kind === "partial_close" ? "Partly closed"
    : kind === "modify_sl" || (kind === "modify" && /:sl$/.test(id)) ? "Stop set"
    : kind === "modify_tp" || (kind === "modify" && /:tp$/.test(id)) ? "Target set"
    : kind === "modify_sltp" ? "Stop and target set" : kind === "modify" ? "Modified"
    : kind === "modify_order" ? "Limit moved" : kind === "delete_order" ? "Limit cancelled"
    : kind ? kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, " ") : "Intent";
  if (status === "failed") return `${base} failed`;
  if (status === "expired" && kind !== "place_limit") return `${base} expired`;
  return base;
}

function intentDetail(i: any, verb: string): string {
  const bits: string[] = [];
  if (/^Stop set/.test(verb) && isNum(i?.sl)) bits.push(`SL ${two(i.sl)}`);
  else if (/^Target set/.test(verb) && isNum(i?.tp)) bits.push(`TP ${two(i.tp)}`);
  else if (/^(Stop and target set|Modified)/.test(verb)) { if (isNum(i?.sl)) bits.push(`SL ${two(i.sl)}`); if (isNum(i?.tp)) bits.push(`TP ${two(i.tp)}`); }
  if (i?.status === "failed") bits.push(typeof i?.result?.error === "string" && i.result.error ? i.result.error : "failed");
  else if (i?.status === "pending" || i?.status === "sent") bits.push(i.status);
  return bits.join(" · ");
}

/**
 * The last actions, newest first: Omega's intents (at their last update), the limit events (entry_order.recent), the
 * control changes and the closed deals, merged. De-duplicated by intent id, then by ticket and minute (an intent and
 * the limit event of the same order in the same minute are one line: the event's verb, the intent's side, lot and price).
 */
export function lastActions(d: any, limit = 5): Action[] {
  const b = d?.broker && typeof d.broker === "object" ? d.broker : {};
  const intents: any[] = Array.isArray(b.intents) ? b.intents.filter((x: any) => x && typeof x === "object") : [];
  const out: Action[] = [];
  const mk = (ms: number, a: Partial<Action>): Action => ({ ms, utc: utcClockOf(ms), gmt7: gmt7ClockOf(ms), verb: "", ticket: null, side: null, lot: null, price: null, extra: "", fault: false, intent: null, ...a });
  const byTicket = new Map<number, any>();
  const seenIds = new Set<string>();
  for (const i of intents) {
    const id = typeof i.id === "string" ? i.id : null;
    if (id) { if (seenIds.has(id)) continue; seenIds.add(id); }
    const ms = isNum(i.updated_ms) && i.updated_ms > 0 ? i.updated_ms : isNum(i.created_ms) && i.created_ms > 0 ? i.created_ms : null;
    const ticket = ticketOf(i.result?.ticket) ?? ticketOf(i.ticket);
    if (ticket != null && (i.kind === "place_limit" || i.kind === "open") && !byTicket.has(ticket)) byTicket.set(ticket, i);
    if (ms == null) continue;
    const verb = intentVerb(i);
    const lot = isNum(i.lot) ? i.lot : isNum(i.volume) ? i.volume : null;
    const opens = i.kind === "place_limit" || i.kind === "open";
    out.push(mk(ms, { verb, ticket, side: opens ? sideOf(i.side) : null, lot: opens ? lot : null, price: opens && isNum(i.entry) ? i.entry : null, extra: intentDetail(i, verb), fault: i.status === "failed", intent: id }));
  }
  const recent: any[] = Array.isArray(b.entry_order?.recent) ? b.entry_order.recent : [];
  for (const r of recent) {
    if (!r || !isNum(r.ms) || r.ms <= 0) continue;
    const ticket = ticketOf(r.ticket);
    const src = ticket != null ? byTicket.get(ticket) : null;
    const extra = [isNum(r.gap_r) ? `gap ${r.gap_r}R` : "", typeof r.reason === "string" && r.reason ? r.reason : ""].filter(Boolean).join(" · ");
    const a = typeof r.action === "string" ? r.action : "";
    out.push(mk(r.ms, { verb: LIMIT_VERB[a] ?? `Limit ${a || "event"}`, ticket, side: sideOf(src?.side), lot: isNum(src?.lot) ? src.lot : null, price: a === "filled" || a === "placed" ? (isNum(src?.entry) ? src.entry : null) : null, extra }));
  }
  const ctl: any[] = Array.isArray(d?.control_events) ? d.control_events : [];
  for (const c of ctl) {
    const ms = Date.parse(typeof c?.at === "string" ? c.at : "");
    if (!Number.isFinite(ms)) continue;
    const verb = c.mode === "paused" ? "Paused" : c.mode === "killed" ? "Killed" : c.mode === "active" ? "Resumed" : "Control changed";
    const who = typeof c.actor === "string" && c.actor ? c.actor : "";
    const why = typeof c.reason === "string" && c.reason ? `"${c.reason}"` : "";
    out.push(mk(ms, { verb, extra: [who, why].filter(Boolean).join(": ") }));
  }
  const deals: any[] = Array.isArray(d?.deals) ? d.deals : [];
  for (const x of deals) {
    if (!x || !isNum(x.closed_ms) || x.closed_ms <= 0) continue;
    const net = (isNum(x.profit) ? x.profit : 0) + (isNum(x.commission) ? x.commission : 0) + (isNum(x.swap) ? x.swap : 0);
    const reason = typeof x.reason === "string" ? x.reason : "";
    out.push(mk(x.closed_ms, { verb: DEAL_VERB[reason] ?? (reason ? `Closed (${reason.replace(/_/g, " ")})` : "Closed"), ticket: ticketOf(x.position_ticket) ?? ticketOf(x.deal_ticket), side: sideOf(x.side), lot: isNum(x.volume) ? x.volume : null, extra: signedMoney(net) }));
  }
  // Ticket and minute: an intent and an event of another list (a limit event, a deal) on the same ticket in the same
  // minute are one line, at the first one's place: the event's verb and note, the intent's side, lot and price.
  const merged: Action[] = [];
  const at = new Map<string, number>();
  for (const a of out) {
    const key = a.ticket != null ? `${a.ticket}|${Math.floor(a.ms / 60_000)}` : null;
    const k = key != null ? at.get(key) : undefined;
    const prev = k != null ? merged[k] : null;
    if (k == null || !prev || Boolean(prev.intent) === Boolean(a.intent)) { if (key != null && k == null) at.set(key, merged.length); merged.push(a); continue; }
    at.delete(key!); // one pair per line: a third event on the ticket in that minute is its own line
    const event = prev.intent ? a : prev, intent = prev.intent ? prev : a;
    const ms = Math.max(prev.ms, a.ms);
    merged[k] = { ...intent, ms, utc: utcClockOf(ms), gmt7: gmt7ClockOf(ms), verb: event.verb, extra: event.extra || intent.extra, side: intent.side ?? event.side, lot: intent.lot ?? event.lot, price: intent.price ?? event.price, fault: prev.fault || a.fault };
  }
  return merged.sort((x, y) => y.ms - x.ms).slice(0, limit);
}
