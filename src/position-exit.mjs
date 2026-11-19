// The notice of every Omega position that leaves the book (owner 2026-11-19, relayed: a position closed at the
// broker's take-profit or stop said nothing on Telegram). Read from the exit deals the terminal reports: a deal
// stored for the first time (storeDeal's `stored`), recent, of an Omega or delegated position that is no longer open.
// One Telegram line and one omega_events row ("position_closed") per position; never the account number.
// Read by the Omega sync (src/omega-broker.mjs); no model call.
import { DEAL_PROFIT_SQL, DEAL_NET_SQL } from "./gold-symbol.mjs";

/** Only deals closed this recently are announced: a newly connected terminal's history says nothing. */
export const EXIT_NOTICE_MAX_AGE_MS = 30 * 60_000;
/** At most this many notices a sync. */
export const EXIT_NOTICE_MAX = 5;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
const PIP = 0.1;

/** Pure: an Omega close intent's reason in plain words. */
export function omegaCloseReasonText(reason) {
  const known = {
    pm_cut_loss: "Position Manager: loss cut",
    pm_take_profit_weakening: "Position Manager: profit taken, the momentum was weakening",
    opposite: "an opposite signal",
    lean_flip: "the quorum's lean flipped",
    confidence_drop: "the strategy agent's confidence dropped",
    mean_reversal: "a reversal or early-exit signal",
    power_reversal: "a power reversal",
    kill: "the kill switch",
    kill_or_daily_loss: "the kill switch or the daily loss limit",
    range_breakout: "the range broke out",
    owner_modify: "the owner"
  };
  const r = String(reason ?? "");
  return known[r] ?? (r ? r.replace(/_/g, " ") : "an Omega close");
}

/**
 * Pure: why the position left the book, from the exit deal's reason and the Omega close intent's reason (when the
 * deal reason is "expert", Omega closed it). `profit` tells a stop in profit (a locked stop) from a loss.
 */
export function exitReasonText(dealReason, intentReason = null, profit = null) {
  switch (String(dealReason ?? "").toLowerCase()) {
    case "tp": return "take-profit hit at the broker";
    case "sl": return isNum(profit) && profit > 0 ? "stop hit at the broker (a stop locked in profit)" : "stop-loss hit at the broker";
    case "stop_out":
    case "stopout": return "stop-out by the broker (margin)";
    case "manual": return "closed by hand in the terminal";
    case "expert": return intentReason ? `closed by Omega: ${omegaCloseReasonText(intentReason)}` : "closed by the EA";
    default: return intentReason ? `closed by Omega: ${omegaCloseReasonText(intentReason)}` : `closed (${dealReason || "reason not reported"})`;
  }
}

/** Pure: the exit deals that make a notice: newly stored, recent, Omega's or delegated, and the position gone. */
export function exitDealsToAnnounce(deals = [], { openTickets = [], delegated = [], now = Date.now() } = {}) {
  const open = new Set(openTickets.map(Number)), deleg = new Set(delegated.map(Number));
  const seen = new Set(), out = [];
  for (const d of deals) {
    const pos = Number(d?.position_ticket);
    if (!Number.isInteger(pos) || pos <= 0 || open.has(pos) || seen.has(pos)) continue;
    if (!(d?.source === "omega" || deleg.has(pos))) continue;
    if (!isNum(d?.closed_ms) || now - d.closed_ms > EXIT_NOTICE_MAX_AGE_MS) continue;
    seen.add(pos);
    out.push(d);
    if (out.length >= EXIT_NOTICE_MAX) break;
  }
  return out;
}

/** Pure: the facts of one exit, from its last deal and the position's total over all its exit deals. */
export function exitFacts(d, { total = null, intentReason = null } = {}) {
  const buy = String(d.side).toUpperCase() === "BUY";
  const entry = isNum(d.entry_price) && d.entry_price > 0 ? d.entry_price : null;
  const exit = isNum(d.exit_price) && d.exit_price > 0 ? d.exit_price : null;
  const pips = entry != null && exit != null ? Math.round(((buy ? exit - entry : entry - exit) / PIP) * 10) / 10 : null;
  const profit = isNum(total?.profit) ? total.profit : isNum(d.profit) ? d.profit : 0;
  const net = isNum(total?.net) ? total.net : profit + (isNum(d.commission) ? d.commission : 0) + (isNum(d.swap) ? d.swap : 0);
  return {
    ticket: Number(d.position_ticket), deal_ticket: Number(d.deal_ticket), side: buy ? "BUY" : "SELL",
    volume: isNum(total?.volume) ? r2(total.volume) : isNum(d.volume) ? d.volume : null,
    entry, exit, pips, profit: r2(profit), net: r2(net), currency: isNum(total?.profit) ? "USD" : d.currency || "USD",
    deal_reason: d.reason ?? null, intent_reason: intentReason, reason: exitReasonText(d.reason, intentReason, profit),
    partial_exits: Number.isInteger(total?.deals) && total.deals > 1 ? total.deals : null, delegated: d.source !== "omega", closed_ms: d.closed_ms
  };
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const signed = (v) => `${v >= 0 ? "+" : ""}${v}`;

/** Pure: the Telegram text (HTML) of one exit. */
export function exitNoticeMessage(x, label = "") {
  return [
    `${x.net >= 0 ? "💰" : "🔻"} <b>Omega Position Closed${label ? ` · ${esc(label)}` : ""}</b>`,
    `Ticket: <code>#${x.ticket}</code> ${x.side}${x.volume != null ? ` · <code>${x.volume}</code> lot` : ""}${x.delegated ? " (delegated)" : ""}`,
    `Reason: <b>${esc(x.reason)}</b>`,
    `Entry: <code>${x.entry ?? "—"}</code> → Exit: <code>${x.exit ?? "—"}</code>${x.pips != null ? ` (${signed(x.pips)} pips)` : ""}`,
    `Result: <code>${signed(x.profit)} ${esc(x.currency)}</code>${x.net !== x.profit ? ` · net <code>${signed(x.net)}</code> after commission and swap` : ""}${x.partial_exits ? ` · over ${x.partial_exits} exits` : ""}`
  ].join("\n");
}

/**
 * The notices of this sync's new exits. `deals` are the deals storeDeal stored for the first time. Writes one
 * omega_events row per position and sends one line. Never throws.
 */
export async function announceExits(db, deals, { openTickets = [], delegated = [], now = Date.now(), label = "", send = null, log = null } = {}) {
  const sent = [];
  for (const d of exitDealsToAnnounce(deals, { openTickets, delegated, now })) {
    try {
      const pos = Number(d.position_ticket);
      const total = await db.prepare(`SELECT COUNT(*) AS deals, SUM(volume) AS volume, SUM(${DEAL_PROFIT_SQL}) AS profit, SUM(${DEAL_NET_SQL}) AS net FROM ea_deals WHERE position_ticket = ? AND closed_ms > ?`).bind(pos, now - 7 * 86_400_000).first();
      const intent = await db.prepare("SELECT json_extract(payload, '$.reason') AS reason FROM omega_intents WHERE kind = 'close' AND status IN ('done', 'sent') AND json_extract(payload, '$.ticket') = ? ORDER BY updated_ms DESC LIMIT 1").bind(pos).first();
      const x = exitFacts(d, { total: total && Number(total.deals) > 0 ? { deals: Number(total.deals), volume: Number(total.volume), profit: Number(total.profit), net: Number(total.net) } : null, intentReason: intent?.reason ?? null });
      if (log) await log("position_closed", { ticket: x.ticket, deal_ticket: x.deal_ticket, side: x.side, volume: x.volume, entry: x.entry, exit: x.exit, pips: x.pips, profit: x.profit, net: x.net, currency: x.currency, deal_reason: x.deal_reason, intent_reason: x.intent_reason, reason: x.reason, delegated: x.delegated });
      if (send) await send(exitNoticeMessage(x, label));
      sent.push(x);
    } catch { /* the deal is stored; the notice is lost */ }
  }
  return sent;
}
