import { useState, useEffect } from "react";
import { Check, Minus, ShieldAlert, Target, X } from "lucide-react";
import { Badge, Panel, Skeleton } from "./ui";
import { Stance, stanceColor } from "./Stance";
import { DivergingBar, leanColor } from "./charts";
import { useMarket, leanLabel } from "../lib/market";
import { useWarRoom } from "../lib/warroom";
import { candleWhen, pct, utc } from "../lib/format";

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

const CHECK_TEXT: Record<string, string> = { fresh: "rooms current", quorum: "quorum", confirmation: "confirmation", no_veto: "no veto", levels: "key-level plan", reward: "reward ≥ 1.5R", confidence: "confidence" };

/** The Decision Engine's guardrails for one side: one chip per check. */
function Guardrails({ side, g }: { side: string; g: any }) {
  if (!g) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
      <span className={`mono w-10 shrink-0 font-bold ${side === "BUY" ? "text-emerald-300" : "text-rose-300"}`}>{side}</span>
      {(g.checks ?? []).map((c: any) => (
        <span key={c.id} title={c.detail} className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 ${c.pass ? "border-emerald-400/20 text-emerald-200/90" : "border-rose-400/25 text-rose-200/90"}`}>
          {c.pass ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}{CHECK_TEXT[c.id] ?? c.id}
        </span>
      ))}
    </div>
  );
}

/** The trade of a decision as the plan ladder's input (the chosen target carries its note). */
function tradePlan(t: any) {
  return { entry: t.entry, stop: t.stop, tp1: t.tp1, tp2: t.tp2, risk: t.risk, rrr: t.rrr_all, at_level: t.at_level, entry_note: t.entry_note, stop_note: t.stop_note, tp1_note: t.target === "tp1" ? `target · ${t.tp_note ?? ""}` : "", tp2_note: t.target === "tp2" ? `target · ${t.tp_note ?? ""}` : "" };
}

/**
 * Decision Engine (owner decisions 2026-11-09): the ONE decision, the single SSOT for the EA, Telegram,
 * the ledger and this card. The AI council decides at every 15m close from every witness (the D1, 4H,
 * 1H and 15m rooms, News Daily, the Macro room, the strategy engine) within deterministic guardrails.
 * Below it, the witnesses with their weight and lean. Without an engine decision (DECISION_ENGINE
 * off), the card shows the strategy engine's view as before. From GET /api/conclusion/global.
 */
export default function GlobalDecision() {
  const { global: g, engine: e, loading } = useMarket();
  const { room } = useWarRoom();
  const s = g?.strategy ?? null;
  const st = s ? STATE_TEXT[s.state] ?? { label: String(s.state).toLowerCase(), tone: "slate" as const } : null;
  const news = g?.timeframes?.find((t: any) => t.key === "NEWS");
  const macro = g?.timeframes?.find((t: any) => t.key === "MACRO");
  const cf = room?.confirmations;
  const strategyRows = [
    ...(s?.layers ?? []).map((l: any) => ({ key: l.key, label: l.label, role: l.role, lean: l.lean, pass: l.pass, note: l.note, stale: l.stale, weight: null, trigger: l.key === "M5" ? (l.note ?? "") : null })),
    ...(news ? [{ key: "NEWS", label: "News", role: "24h", lean: news.lean, pass: null, note: news.summary ?? "no TLDR yet", stale: news.stale, weight: null }] : []),
    ...(macro?.available ? [{ key: "MACRO", label: "Macro", role: "context", lean: macro.lean, pass: null, note: macro.summary ?? "", stale: macro.stale, weight: null }] : [])
  ];
  const witnessRows = (e?.witnesses ?? []).map((w: any) => ({ trigger: null as string | null, key: w.key, label: w.key === "STRATEGY" ? "Strat" : w.label, role: w.decision ? `${w.role ?? ""}`.slice(0, 18) : w.role, lean: w.lean, pass: w.available && !w.stale ? (w.lean == null ? null : e.stance === "BUY" ? w.lean >= 0.15 : e.stance === "SELL" ? w.lean <= -0.15 : null) : false, note: [w.decision ? `decision ${w.decision}` : null, w.summary].filter(Boolean).join(" · "), stale: w.stale || !w.available, weight: w.weight }));
  // The 5m row is the entry trigger (a Prophet R38 confirmation), not a lean: it shows its state.
  const m5 = e?.context?.m5_trigger;
  const m5Text = !e ? null : !m5 ? "no fresh 5m bar" : m5.buy_confirmed || m5.sell_confirmed ? `${m5.buy_confirmed ? "buy" : "sell"} confirmed${m5.verified ? "" : " (unverified)"}` : "no confirmation";
  const rows = e ? [...witnessRows, { key: "M5", label: "5m", role: "trigger", lean: null, pass: m5 && (m5.buy_confirmed || m5.sell_confirmed) ? m5.verified : null, note: `the Prophet R38 confirmation of the latest closed 5m bar${m5?.candle_time ? ` (${utc(m5.candle_time)})` : ""}`, stale: false, weight: null, trigger: m5Text }] : strategyRows;
  const decision = e?.stance ?? s?.decision ?? g?.action ?? "WAIT";
  const [mode, setMode] = useState<string>(e?.trading_mode ?? "intraday");
  useEffect(() => { fetch("/api/trading-mode", { credentials: "include" }).then((r) => r.json()).then((d) => { if (d?.mode) setMode(d.mode); else console.warn("trading-mode no data", d); }).catch((e) => console.warn("trading-mode fetch failed", e)); }, []);
  const lead = e ? (e.stance === "SELL" ? "short" : e.stance === "BUY" ? "long" : (e.quorum?.short_share ?? 0) > (e.quorum?.long_share ?? 0) ? "short" : "long") : null;
  return (
    <Panel title={e ? "Decision Engine" : "Global decision"} icon={<Target className="h-3.5 w-3.5 text-cyan-300" />}
      right={e ? <div className="flex items-center gap-1.5"><Badge tone="slate">{mode}</Badge><Badge tone={e.source === "council" ? "cyan" : "amber"}>{e.source === "council" ? "AI council" : "fallback"}</Badge></div> : st && <Badge tone={st.tone}>{st.label}</Badge>}>
      {loading && !g && !e ? <Skeleton rows={5} /> : !g && !e ? <p className="text-[12px] text-slate-500">The decision is not available yet.</p> : (
        <>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div className="flex flex-col">
              <span className="eyebrow text-[9px]">Decision</span>
              <div className={`mono whitespace-nowrap ${String(decision).length > 5 ? "text-[24px]" : "text-[32px]"} font-extrabold leading-none ${stanceColor(decision)}`} style={{ textShadow: "0 0 18px currentColor" }}>{decision}</div>
            </div>
            {e ? (
              <>
                <div className="flex flex-col gap-1 pb-1">
                  <span className="eyebrow text-[9px]">Bias</span>
                  <span className={`mono whitespace-nowrap text-[13px] font-bold ${stanceColor(e.bias)}`}>{e.bias}</span>
                </div>
                <div className="flex flex-col gap-1 pb-1">
                  <span className="eyebrow text-[9px]" title="The witnesses' weighted lean">Quorum</span>
                  <span className="mono whitespace-nowrap text-[13px] font-bold text-slate-200">{e.quorum?.score != null ? `${e.quorum.score > 0 ? "+" : ""}${Math.round(e.quorum.score * 100)}` : "—"}<span className="ml-1 text-[10px] font-normal text-slate-500">▲{pct(e.quorum?.long_share)} ▼{pct(e.quorum?.short_share)}</span></span>
                </div>
              </>
            ) : (
              <>
                {s && (
                  <div className="flex flex-col gap-1 pb-1">
                    <span className="eyebrow text-[9px]">Direction</span>
                    <span className={`mono whitespace-nowrap text-[13px] font-bold ${s.direction === "LONG" ? "text-emerald-300" : s.direction === "SHORT" ? "text-rose-300" : "text-slate-400"}`}>{s.direction}</span>
                  </div>
                )}
                <div className="flex flex-col gap-1 pb-1">
                  <span className="eyebrow text-[9px]" title="The weighted lean of every room and the news">Bias</span>
                  <span className={`mono whitespace-nowrap text-[13px] font-bold ${stanceColor(g.bias)}`}>{g.bias}{g.score != null ? ` ${g.score > 0 ? "+" : ""}${Math.round(g.score * 100)}` : ""}</span>
                </div>
              </>
            )}
          </div>
          {e ? (
            <div className="mono mt-2 text-[11px] text-slate-400">
              confidence {pct(e.confidence)} · 15m close {utc(e.bar_close)} · decided in {e.latency_seconds}s{e.strategy?.price != null ? ` · price ${e.strategy.price.toFixed(2)}` : ""}
            </div>
          ) : s && (
            <div className="mono mt-2 text-[11px] text-slate-400">
              confidence {pct(s.confidence)}{s.price != null ? ` · price ${s.price.toFixed(2)}` : ""}{s.atr_h1 != null ? ` · 1H ATR ${s.atr_h1}` : ""}
            </div>
          )}
          {e && (
            <div className="glass-inner mt-3 flex flex-wrap items-center gap-2 px-3 py-2 text-[11px] text-slate-300">
              <span className="eyebrow text-[9px]">Mode</span>
              <select className="rounded border border-white/10 bg-slate-900 px-2 py-1 text-[11px] text-slate-200" value={mode} onChange={async (ev) => { await fetch("/api/trading-mode?mode=" + encodeURIComponent(ev.target.value)); window.location.reload(); }} title="Active selector (stored in KV)">
                <option value="scalp">scalp</option>
                <option value="intraday">intraday</option>
                <option value="swing">swing</option>
              </select>
              <span className="ml-2 eyebrow text-[9px]">Live metrics</span>
              <span className="mono">conf {pct(e.confidence)} · quorum {pct(e.quorum?.long_share)}/{pct(e.quorum?.short_share)} · latency {e.latency_seconds}s</span>
            </div>
          )}
          <p className="glass-inner mt-3 px-3 py-2.5 text-[11.5px] leading-relaxed text-slate-200">{e?.summary ?? s?.headline ?? g.summary}</p>
          {e && !!(e.reasons?.length || e.risks?.length) && (
            <ul className="mt-2 space-y-1 text-[11px]">
              {(e.reasons ?? []).map((r: string, i: number) => <li key={"r" + i} className="flex gap-1.5 text-slate-300"><Check className="mt-0.5 h-3 w-3 shrink-0 text-cyan-300" />{r}</li>)}
              {(e.risks ?? []).map((r: string, i: number) => <li key={"k" + i} className="flex gap-1.5 text-amber-200"><ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />{r}</li>)}
            </ul>
          )}
          {e?.overruled && (
            <p className="mt-2 rounded-md border border-amber-400/25 bg-amber-400/5 px-2.5 py-1.5 text-[11px] text-amber-200">
              Guardrail: the council's {e.overruled.wanted} was held back — {(e.overruled.failed ?? []).map((f: any) => f.detail).join("; ")}.
            </p>
          )}
          {e && (
            <div className="mt-3 space-y-1.5" aria-label="Guardrails">
              <Guardrails side={lead === "short" ? "SELL" : "BUY"} g={lead === "short" ? e.guardrails?.short : e.guardrails?.long} />
              <ul className="mt-1 space-y-0.5 text-[10px] text-slate-500">
                {(lead === "short" ? e.guardrails?.short?.checks : e.guardrails?.long?.checks ?? []).map((c: any) => (
                  <li key={c.id}><span className="mono text-slate-400">{c.id}</span>: {c.detail}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3 space-y-1.5" role="list" aria-label={e ? "Witnesses: weight and lean" : "Timeframes: lean and strategy check"}>
            {rows.map((r: any) => (
              <div key={r.key} className="flex items-center gap-2 text-[11px]" role="listitem" title={r.note}>
                <Pass v={r.pass} />
                <span className="mono w-9 shrink-0 font-bold text-slate-100">{r.label}</span>
                <span className="w-20 shrink-0 truncate text-[9.5px] uppercase tracking-[0.12em] text-slate-500">{r.weight != null ? `${Math.round(r.weight * 100)}% · ${r.role ?? ""}` : r.role}</span>
                {r.trigger != null ? (
                  <span className="min-w-0 flex-1 truncate text-right text-[10px] text-slate-300">{r.trigger}</span>
                ) : (
                  <>
                    <div className={`min-w-0 flex-1 ${r.stale ? "opacity-40" : ""}`}><DivergingBar value={r.lean} height={6} /></div>
                    <span className="w-28 shrink-0 text-right text-[10px]" style={{ color: leanColor(r.lean) }}>{leanLabel(r.lean)}{r.lean != null ? ` ${r.lean > 0 ? "+" : ""}${Math.round(r.lean * 100)}` : ""}</span>
                  </>
                )}
              </div>
            ))}
            <p className="pt-0.5 text-[9.5px] text-slate-600">{e ? "Witnesses: each room, the news, the macro room and the strategy engine, with its weight in the quorum. Hover a row for its own decision and summary." : "Lean: the confidence-weighted mean of the agents' biases in that room, −100 bearish to +100 bullish. Hover a row for its note."}</p>
          </div>

          {e?.trade ? <PlanLadder plan={tradePlan(e.trade)} long={e.trade.side === "BUY"} minRrr={e.rules?.min_rrr ?? 1.5} /> : !e && s?.plan && <PlanLadder plan={s.plan} long={s.direction === "LONG"} minRrr={s.min_rrr ?? 1.5} />}

          {e ? !!e.cautions?.length && (
            <ul className="mt-3 space-y-1 text-[11px]">
              {e.cautions.map((c: string, i: number) => <li key={"c" + i} className="flex gap-1.5 text-amber-200"><ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />{c}</li>)}
            </ul>
          ) : !!(s?.vetoes?.length || s?.cautions?.length) && (
            <ul className="mt-3 space-y-1 text-[11px]">
              {s.vetoes.map((v: string, i: number) => <li key={"v" + i} className="flex gap-1.5 text-rose-300"><ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />{v}</li>)}
              {s.cautions.map((c: string, i: number) => <li key={"c" + i} className="flex gap-1.5 text-amber-200"><ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />{c}</li>)}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            {e?.strategy && st && <><span className="eyebrow text-[9px]">Strategy (witness)</span><Badge tone={st.tone}>{st.label}</Badge></>}
            {g?.h1_decision && <><span className="eyebrow text-[9px]">{e ? "1H room (witness)" : "H1 chain (reference)"}</span><Stance value={g.h1_decision.decision} /><span className="mono">{pct(g.h1_decision.confidence)}</span>{g.h1_decision.candle_key && <span>· {candleWhen(g.h1_decision.candle_key)}</span>}</>}
            {cf && <span>· R38 H1 {cf.h1_prophet_r38?.buy_confirmed ? "buy" : cf.h1_prophet_r38?.sell_confirmed ? "sell" : "none"} · 5m {cf.m5_prophet_r38?.buy_confirmed ? "buy" : cf.m5_prophet_r38?.sell_confirmed ? "sell" : "none"}{cf.m5_prophet_r38 && !cf.m5_prophet_r38.verified ? " (unverified)" : ""}</span>}
          </div>
          <p className="mt-2 text-[9px] uppercase tracking-widest text-slate-600">{e ? "One decision for the EA, Telegram and the ledger · the AI decides inside guardrails · no position size" : "Advisory only · computed from closed bars and every agent's bias · no orders, no position size"}</p>
        </>
      )}
    </Panel>
  );
}
