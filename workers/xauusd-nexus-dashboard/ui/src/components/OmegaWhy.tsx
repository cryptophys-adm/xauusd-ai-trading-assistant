import { Badge } from "./ui";

// Why Omega is or is not entering right now (owner 2026-11-13: "pastikan semua ada visualisasi, sehingga
// owner/user mengetahui dan memahami"). The planner (src/omega-engine.mjs planIntents) leaves short codes on
// every sync; this turns the current ones into plain sentences. "block" stops a new entry, "adjust" changes
// how an entry is placed, "info" is context.
type Kind = "block" | "adjust" | "info";
const CODES: Record<string, { kind: Kind; text: string }> = {
  kill: { kind: "block", text: "Kill switch: every position is being closed and nothing new opens." },
  engine_off: { kind: "block", text: "The engine is switched off (server switch or the setting below)." },
  executor_stale: { kind: "block", text: "The MT5 terminal has not reported recently, so Omega does not act blind." },
  ea_local_management: { kind: "info", text: "The EA manages its positions locally." },
  mean_reversal_exit: { kind: "adjust", text: "A position is being closed because the decision's power reversed." },
  no_side: { kind: "block", text: "The Decision Engine says WAIT: there is no BUY or SELL to follow." },
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
  same_side_unprotected: { kind: "block", text: "No stacking: a position on the same side is not yet protected (its stop is not at break-even or better)." },
  bad_input: { kind: "block", text: "Account or symbol data from the terminal is incomplete." },
  daily_loss_limit: { kind: "block", text: "The daily loss limit is reached: no new entries today." },
  daily_risk_budget: { kind: "block", text: "Today's risk budget is used up by the open positions' stops." },
  plan_wrong_side: { kind: "block", text: "The plan's stop and target are on the wrong side of the entry." },
  stops_level: { kind: "block", text: "The stop or target is closer than the broker allows." },
  waiting_for_pullback: { kind: "block", text: "Limit entry: price is too far from the entry; waiting for a pullback into the band." },
  price_past_entry: { kind: "block", text: "Limit entry: price already ran past the entry toward the stop; waiting for it to come back inside the band." },
  stop_breached: { kind: "block", text: "Price is already beyond the plan's stop." },
  volume_below_min: { kind: "block", text: "The risk per trade gives less than the broker's minimum lot." },
  stop_5m: { kind: "adjust", text: "Market entry: the stop moves to the broker's 5m structure (tighter than the plan's)." },
  adaptive_stop: { kind: "adjust", text: "The stop is widened to 0.75 ATR to avoid noise; the target keeps the plan's reward-to-risk." },
  lot_capped_5m: { kind: "adjust", text: "The lot is capped because the 5m stop is tighter than the plan's." },
  lot_capped_daily_budget: { kind: "adjust", text: "The lot is capped by the day's remaining risk budget." },
  vol_regime_high: { kind: "info", text: "Volatility is high." },
  vol_regime_low: { kind: "info", text: "Volatility is low." }
};
const TONE: Record<Kind, "red" | "amber" | "cyan"> = { block: "red", adjust: "amber", info: "cyan" };

export function omegaReason(code: string) {
  return CODES[code] ?? { kind: "info" as Kind, text: code.replace(/_/g, " ") };
}

/** The planner's current notes as a short list; `sinceMs` is when they last changed. */
export default function OmegaWhy({ codes, sinceMs }: { codes: string[] | null | undefined; sinceMs?: number | null }) {
  if (!codes?.length) return <p className="text-[11px] text-slate-500">No planner notes yet.</p>;
  const items = codes.map((c) => ({ code: c, ...omegaReason(c) }));
  const blocked = items.some((i) => i.kind === "block");
  return (
    <div className="space-y-1.5" aria-label="Why Omega is or is not entering now">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Badge tone={blocked ? "amber" : "green"}>{blocked ? "NOT ENTERING" : "READY / MANAGING"}</Badge>
        {sinceMs ? <span className="text-slate-500">since {new Date(sinceMs).toISOString().slice(11, 16)} UTC</span> : null}
      </div>
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i.code} className="flex items-start gap-2 text-[11.5px] text-slate-300">
            <span className="mt-0.5"><Badge tone={TONE[i.kind]}>{i.kind === "block" ? "why" : i.kind}</Badge></span>
            <span className="min-w-0 flex-1">{i.text} <span className="mono text-[10px] text-slate-600">{i.code}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
