import { Dot } from "./ui";
import { EZ_CODES, gmt7ClockOf, plannerDetail } from "../lib/entryZone";
import { ENGINE_OFF_TEXT, engineOffText } from "../lib/omegaLean";

// Why Omega is or is not entering right now (owner 2026-11-13: "pastikan semua ada visualisasi, sehingga
// owner/user mengetahui dan memahami"). The planner (src/omega-engine.mjs planIntents) leaves short codes on
// every sync; this turns the current ones into plain sentences. "block" stops a new entry, "adjust" changes
// how an entry is placed, "info" is context.
type Kind = "block" | "adjust" | "info";
const CODES: Record<string, { kind: Kind; text: string }> = {
  kill: { kind: "block", text: "Kill switch: every position is being closed and nothing new opens." },
  // OM-LEAN (the reviewer's final ruling): the wording branches on which switch is off (omegaReason's envEnabled).
  engine_off: { kind: "block", text: ENGINE_OFF_TEXT.local },
  executor_stale: { kind: "block", text: "The MT5 terminal has not reported recently, so Omega does not act blind." },
  ea_local_management: { kind: "info", text: "The EA manages its positions locally." },
  mean_reversal_exit: { kind: "adjust", text: "A position is being closed because the decision's power reversed." },
  lean_flip: { kind: "adjust", text: "The Decision Engine's lean turned against the system's positions on that side: they are all being closed." },
  confidence_drop: { kind: "adjust", text: "A winning position is being closed: its strategy agent's confidence dropped at this 15m evaluation." },
  no_side: { kind: "block", text: "The Decision Engine says WAIT: there is no BUY or SELL to follow." },
  symbol_unverified: { kind: "block", text: "The terminal's trade symbol is not verified USD gold (exact name, profit currency USD, contract size 1-100 oz): no new entries. See Symbol on the bridge card." },
  htf_against: { kind: "block", text: "A range strategy's trade against the H4/D1 trend: range strategies fade only with the trend (counter-trend trades are the reversal probation's)." },
  htf_unknown: { kind: "block", text: "The H4/D1 trend is unknown (too few bars), so no range strategy trades." },
  cell_collecting: { kind: "block", text: "This range strategy's side in this H4/D1 context is still collecting evidence (30 replayed setups needed): no live trade yet." },
  cell_below_bar: { kind: "block", text: "This range strategy's side in this H4/D1 context is under the +0.10R bar over 30+ setups: held until its record improves." },
  range_breakout: { kind: "block", text: "Range mode, but the 1H regime is no longer ranging (a breakout): no range trade. The mode returns to the previous one within 5 minutes." },
  range_mode_agent: { kind: "block", text: "Range mode: only the range strategies (Range fade, Sweep reversal) trade; this decision's trade is another strategy's." },
  probation_unconfirmed: { kind: "block", text: "A counter-trend sweep reversal waits for a change of structure (CHoCH/BOS) on a closed H1 or H4 candle before its probation trade." },
  probation_reverted: { kind: "block", text: "Reversal probation is reverted for this cell: its last 5 probation trades averaged under 0R. It trades against the trend again only once its record passes." },
  probation_busy: { kind: "block", text: "A probation trade is already open: one at a time." },
  probation_hedge: { kind: "block", text: "A probation trade never hedges: a position is open on the other side." },
  symbol_price_mismatch: { kind: "block", text: "The account's own gold symbol does not price within 2% of the reference gold price: no new entries. Check the symbol set in Setup → Connection & EA." },
  tick_value_mismatch: { kind: "block", text: "The broker's tick value does not match the contract (contract size × tick size in USD, or that in cents): the loss at the stop cannot be trusted, so no new entries." },
  spec_unvalidated: { kind: "block", text: "The account's broker spec (contract, lot limits, leverage, margin mode) is new or changed: no new entries until it validates and holds for a minute. Open positions are still managed. See Account on the bridge card." },
  ea_outdated: { kind: "block", text: "OmegaExecutor is older than the minimum version for entries (1.16: it checks margin, stops and freeze level before sending): no new entries until it is updated on the VPS." },
  reentry_cooldown: { kind: "block", text: "The Position Manager just closed a position on this side (weakening or cut loss): a new entry on the same side waits until the next M5 candle closes after the exit." },
  profile_review_pending: { kind: "block", text: "A downgrade of the risk profile is waiting for the profile council's review: no new entries until it decides (at most 10 minutes)." },
  bad_signal: { kind: "block", text: "The signal is incomplete." },
  expired: { kind: "block", text: "The signal expired before it could be entered." },
  signal_too_old: { kind: "block", text: "The signal is too old to enter safely." },
  blackout: { kind: "block", text: "News blackout: a high-impact release is too close." },
  paused: { kind: "block", text: "Omega is paused." },
  live_not_armed: { kind: "block", text: "A live account is connected but live trading is not armed (owner only)." },
  already_opened: { kind: "block", text: "This signal was already entered." },
  max_positions: { kind: "block", text: "The maximum number of positions is open." },
  spread: { kind: "block", text: "The spread is wider than allowed." },
  rollover_quarantine: { kind: "block", text: "Daily rollover window: spreads are unreliable, entries wait." },
  liquidity_spread_spike: { kind: "block", text: "The live spread is far above this hour's norm on this broker (liquidity lens): new entries wait." },
  liquidity_modify_deferred: { kind: "info", text: "A stop or target change waits for the spread spike to pass (at most 10 minutes); closes and hard guards are never held." },
  same_side_unprotected: { kind: "block", text: "No stacking: a position on the same side is not yet protected (its stop is not at break-even or better)." },
  strategy_has_position: { kind: "block", text: "Strategy arm: this strategy already has an open position (one position per strategy)." },
  opposing_position: { kind: "block", text: "Strategy arm: an Omega position on the other side is still open or being closed; the entry waits for it to go." },
  bad_input: { kind: "block", text: "Account or symbol data from the terminal is incomplete." },
  daily_loss_limit: { kind: "block", text: "The daily loss limit is reached: no new entries today." },
  daily_risk_budget: { kind: "block", text: "Today's risk budget is used up by the open positions' stops." },
  plan_wrong_side: { kind: "block", text: "The plan's stop and target are on the wrong side of the entry." },
  stops_level: { kind: "block", text: "The stop or target is closer than the broker allows." },
  waiting_for_pullback: { kind: "block", text: "Limit entry: price is too far from the entry; waiting for a pullback into the band." },
  price_past_entry: { kind: "block", text: "Limit entry: price already ran past the entry toward the stop; waiting for it to come back inside the band." },
  stop_breached: { kind: "block", text: "Price is already beyond the plan's stop." },
  volume_below_min: { kind: "block", text: "The risk per trade gives less than the broker's minimum lot, and the minimum lot would risk more than the account's profile allows: the setup is skipped." },
  min_lot_within_cap: { kind: "adjust", text: "The risk per trade gives less than the minimum lot; the minimum lot is used because its real risk stays within the profile's hard cap." },
  open_risk_cap: { kind: "block", text: "The open positions already use the profile's total open risk: no new entry." },
  lot_capped_open_risk: { kind: "adjust", text: "The lot is capped by the profile's total open risk." },
  stop_5m: { kind: "adjust", text: "Market entry: the stop moves to the broker's 5m structure (tighter than the plan's)." },
  adaptive_stop: { kind: "adjust", text: "The stop is widened to 0.75 ATR to avoid noise; the target keeps the plan's reward-to-risk." },
  lot_capped_5m: { kind: "adjust", text: "The lot is capped because the 5m stop is tighter than the plan's." },
  lot_capped_daily_budget: { kind: "adjust", text: "The lot is capped by the day's remaining risk budget." },
  vol_regime_high: { kind: "info", text: "Volatility is high." },
  vol_regime_low: { kind: "info", text: "Volatility is low." },
  // EZ1 and EZ1b (owner 2026-11-23, the approved mockup): where the limit rests in the decision's entry zone (broker
  // scale), or why it does not. A placement is "adjust" (the order's price differs from the plan's); a refusal "block".
  limit_in_zone: { kind: "adjust", text: "Limit in the entry zone: the plan's level was through price (or inside the stops level); stop and TP1 kept." },
  limit_zone_edge: { kind: "adjust", text: "Limit at the zone's near edge: the plan's level is out of the placement band; stop and TP1 kept." },
  zone_passed: { kind: "block", text: "Refused: price already passed the entry zone." },
  zone_tight: { kind: "block", text: "Refused: zone too tight. A limit inside it keeps under half the plan's risk." },
  zone_rr: { kind: "block", text: "Refused: R:R below the minimum. A limit inside the zone pays under 1R to TP1." }
};
const EZ = new Set<string>(EZ_CODES);
// In the status tones; info is ok, as severityTone (owner 2026-11-22).
const TONE: Record<Kind, "fault" | "late" | "ok"> = { block: "fault", adjust: "late", info: "ok" };

/** A planner code in words. `envEnabled` (broker.engine.env_enabled) picks engine_off's wording: false is the server switch. */
export function omegaReason(code: string, envEnabled?: unknown) {
  if (code === "engine_off") return { kind: "block" as Kind, text: engineOffText(envEnabled) };
  return CODES[code] ?? { kind: "info" as Kind, text: code.replace(/_/g, " ") };
}

/**
 * The planner's current notes (Details → Signal, the mockup's "Planner, since 14:06 UTC"): one line each with a dot in
 * its kind's tone (block red, adjust amber, info cyan), the sentence, the code and its detail. `sinceMs` is when they
 * last changed. The first screen's one-line verdict is lib/omegaLean.ts verdict over the same codes.
 */
export default function OmegaWhy({ codes, sinceMs, details, envEnabled }: { codes: string[] | null | undefined; sinceMs?: number | null; details?: Record<string, string> | null; envEnabled?: unknown }) {
  if (!codes?.length) return <p className="text-[11px] text-muted">No planner notes yet.</p>;
  const items = codes.filter((c) => typeof c === "string" && c !== "").map((c) => ({ code: c, ...omegaReason(c, envEnabled) }));
  const blocked = items.some((i) => i.kind === "block");
  return (
    <div className="space-y-1.5" aria-label="Why Omega is or is not entering now">
      <div className="text-[11px] text-fg-2">
        {`Planner${blocked ? ", not entering" : ""}${sinceMs ? `, since ${new Date(sinceMs).toISOString().slice(11, 16)} UTC · ${gmt7ClockOf(sinceMs)} GMT+7` : ""}`}
      </div>
      <ul className="space-y-1">
        {items.map((i) => { const detail = plannerDetail(i.code, details?.[i.code]); return (
          <li key={i.code} className="flex items-start gap-2 text-[11.5px] text-slate-300" data-kind={i.kind}>
            <span className="mt-1"><Dot tone={TONE[i.kind]} /></span>
            <span className="min-w-0 flex-1">
              {i.text} <span className="mono text-[10px] text-muted">{i.code}</span>
              {detail ? <span className={EZ.has(i.code) ? "mono mt-0.5 block text-[10.5px] text-fg-2" : "block text-[11px] text-slate-400"}>{detail}</span> : null}
            </span>
          </li>
        ); })}
      </ul>
    </div>
  );
}
