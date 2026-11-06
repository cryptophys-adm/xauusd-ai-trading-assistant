import { Check, Minus, ShieldAlert, Target, X } from "lucide-react";
import { Badge, Panel, Skeleton } from "./ui";
import { Stance, stanceColor } from "./Stance";
import { DivergingBar, leanColor } from "./charts";
import { useMarket, leanLabel } from "../lib/market";
import { useWarRoom } from "../lib/warroom";
import { candleWhen, pct } from "../lib/format";

const STATE_TEXT: Record<string, { label: string; tone: "green" | "amber" | "red" | "cyan" | "slate" | "purple" }> = {
  TRIGGERED: { label: "triggered", tone: "green" },
  SETUP_READY: { label: "setup ready", tone: "cyan" },
  SETUP_FORMING: { label: "setup forming", tone: "purple" },
  LOW_REWARD: { label: "reward too small", tone: "amber" },
  LOW_CONFIDENCE: { label: "weak alignment", tone: "amber" },
  BLOCKED: { label: "blocked", tone: "red" },
  NO_LEVELS: { label: "no levels", tone: "slate" },
  NO_SETUP: { label: "no setup", tone: "slate" }
};

function Pass({ v }: { v: boolean | null | undefined }) {
  if (v === true) return <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300" aria-label="passes" />;
  if (v === false) return <X className="h-3.5 w-3.5 shrink-0 text-rose-300" aria-label="fails" />;
  return <Minus className="h-3.5 w-3.5 shrink-0 text-slate-600" aria-label="not applicable" />;
}

/** The trade plan as a price ladder: targets above, entry, stop below (mirrored for a short). */
function PlanLadder({ plan, long, minRrr }: { plan: any; long: boolean; minRrr: number }) {
  const rows = [
    { k: "TP2", price: plan.tp2, note: plan.tp2_note, rr: plan.rrr?.tp2, tone: "text-emerald-300" },
    { k: "TP1", price: plan.tp1, note: plan.tp1_note, rr: plan.rrr?.tp1, tone: "text-emerald-300/80" },
    { k: "Entry", price: plan.entry, note: plan.entry_note, rr: null, tone: "text-cyan-200" },
    { k: "Stop", price: plan.stop, note: plan.stop_note, rr: null, tone: "text-rose-300" }
  ];
  const ordered = long ? rows : [...rows].reverse();
  return (
    <div className="glass-inner mt-3 divide-y divide-white/5" role="table" aria-label="Key levels of the trade plan">
      {ordered.map((r) => (
        <div key={r.k} className="flex items-center gap-2 px-3 py-1.5" role="row">
          <span className={`w-11 text-[10px] font-semibold uppercase tracking-[0.14em] ${r.tone}`}>{r.k}</span>
          <span className="mono w-16 text-[12.5px] font-semibold text-slate-100">{r.price?.toFixed?.(2) ?? "—"}</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-slate-500" title={r.note}>{r.note}</span>
          {r.rr != null && <span className={`mono text-[11px] ${r.rr >= minRrr ? "text-emerald-300" : "text-amber-300"}`}>{r.rr}R</span>}
        </div>
      ))}
      <div className="flex items-center justify-between px-3 py-1.5 text-[10.5px] text-slate-500">
        <span>risk {plan.risk?.toFixed?.(2)} · reward-to-risk needed {minRrr}R</span>
        {!plan.at_level && <span className="text-violet-300">planned pullback entry</span>}
      </div>
    </div>
  );
}

/**
 * Global decision (owner decision 2026-11-06: the Global Conclusion and the strategy engine were
 * redundant, so they are one card). From GET /api/conclusion/global, which carries the strategy:
 * the decision, its state and direction; the global bias and score of every room's agents and the
 * news; one row per timeframe with its lean (the confidence-weighted mean of the agents' biases)
 * and whether it passes the strategy; the plan with its key levels and RRR; vetoes and cautions.
 */
export default function GlobalDecision() {
  const { global: g, loading } = useMarket();
  const { room } = useWarRoom();
  const s = g?.strategy ?? null;
  const st = s ? STATE_TEXT[s.state] ?? { label: String(s.state).toLowerCase(), tone: "slate" as const } : null;
  const news = g?.timeframes?.find((t: any) => t.key === "NEWS");
  const cf = room?.confirmations;
  const rows = [
    ...(s?.layers ?? []).map((l: any) => ({ key: l.key, label: l.label, role: l.role, lean: l.lean, pass: l.pass, note: l.note, stale: l.stale })),
    ...(news ? [{ key: "NEWS", label: "News", role: "24h", lean: news.lean, pass: null, note: news.summary ?? "no TLDR yet", stale: news.stale }] : [])
  ];
  const decision = s?.decision ?? g?.action ?? "WAIT";
  return (
    <Panel title="Global decision" icon={<Target className="h-3.5 w-3.5 text-cyan-300" />} right={st && <Badge tone={st.tone}>{st.label}</Badge>}>
      {loading && !g ? <Skeleton rows={5} /> : !g ? <p className="text-[12px] text-slate-500">The global decision is not available yet.</p> : (
        <>
          <div className="flex items-end gap-4">
            <div className="flex flex-col">
              <span className="eyebrow text-[9px]">Decision</span>
              <div className={`mono text-[40px] font-extrabold leading-none ${stanceColor(decision)}`} style={{ textShadow: "0 0 24px currentColor" }}>{decision}</div>
            </div>
            {s && (
              <div className="flex flex-col gap-1 pb-1">
                <span className="eyebrow text-[9px]">Direction</span>
                <span className={`mono text-[15px] font-bold ${s.direction === "LONG" ? "text-emerald-300" : s.direction === "SHORT" ? "text-rose-300" : "text-slate-400"}`}>{s.direction}</span>
              </div>
            )}
            <div className="flex flex-col gap-1 pb-1">
              <span className="eyebrow text-[9px]" title="The weighted lean of every room and the news">Bias</span>
              <span className={`mono text-[15px] font-bold ${stanceColor(g.bias)}`}>{g.bias}{g.score != null ? ` ${g.score > 0 ? "+" : ""}${Math.round(g.score * 100)}` : ""}</span>
            </div>
          </div>
          {s && (
            <div className="mono mt-2 text-[11px] text-slate-400">
              confidence {pct(s.confidence)}{s.price != null ? ` · price ${s.price.toFixed(2)}` : ""}{s.atr_h1 != null ? ` · 1H ATR ${s.atr_h1}` : ""}
            </div>
          )}
          <p className="glass-inner mt-3 px-3 py-2.5 text-[12px] leading-relaxed text-slate-200">{s?.headline ?? g.summary}</p>

          <div className="mt-3 space-y-1.5" role="list" aria-label="Timeframes: lean and strategy check">
            {rows.map((r) => (
              <div key={r.key} className="flex items-center gap-2 text-[11px]" role="listitem" title={r.note}>
                <Pass v={r.pass} />
                <span className="mono w-9 shrink-0 font-bold text-slate-100">{r.label}</span>
                <span className="w-20 shrink-0 truncate text-[9.5px] uppercase tracking-[0.12em] text-slate-500">{r.role}</span>
                <div className={`min-w-0 flex-1 ${r.stale ? "opacity-40" : ""}`}><DivergingBar value={r.lean} height={6} /></div>
                <span className="w-28 shrink-0 text-right text-[10px]" style={{ color: leanColor(r.lean) }}>{leanLabel(r.lean)}{r.lean != null ? ` ${r.lean > 0 ? "+" : ""}${Math.round(r.lean * 100)}` : ""}</span>
              </div>
            ))}
            <p className="pt-0.5 text-[9.5px] text-slate-600">Lean: the confidence-weighted mean of the agents' biases in that room, −100 bearish to +100 bullish. Hover a row for its note.</p>
          </div>

          {s?.plan && <PlanLadder plan={s.plan} long={s.direction === "LONG"} minRrr={s.min_rrr ?? 1.5} />}

          {!!(s?.vetoes?.length || s?.cautions?.length) && (
            <ul className="mt-3 space-y-1 text-[11px]">
              {s.vetoes.map((v: string, i: number) => <li key={"v" + i} className="flex gap-1.5 text-rose-300"><ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />{v}</li>)}
              {s.cautions.map((c: string, i: number) => <li key={"c" + i} className="flex gap-1.5 text-amber-200"><ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />{c}</li>)}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            {g.h1_decision && <><span className="eyebrow text-[9px]">H1 chain (reference)</span><Stance value={g.h1_decision.decision} /><span className="mono">{pct(g.h1_decision.confidence)}</span>{g.h1_decision.candle_key && <span>· {candleWhen(g.h1_decision.candle_key)}</span>}</>}
            {cf && <span>· R38 H1 {cf.h1_prophet_r38?.buy_confirmed ? "buy" : cf.h1_prophet_r38?.sell_confirmed ? "sell" : "none"} · 5m {cf.m5_prophet_r38?.buy_confirmed ? "buy" : cf.m5_prophet_r38?.sell_confirmed ? "sell" : "none"}{cf.m5_prophet_r38 && !cf.m5_prophet_r38.verified ? " (unverified)" : ""}</span>}
          </div>
          <p className="mt-2 text-[9px] uppercase tracking-widest text-slate-600">Advisory only · computed from closed bars and every agent's bias · no orders, no position size</p>
        </>
      )}
    </Panel>
  );
}
