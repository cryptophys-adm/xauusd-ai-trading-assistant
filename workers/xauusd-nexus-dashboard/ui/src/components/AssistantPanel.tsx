import { useEffect, useState } from "react";
import { Activity, Clock3, Compass, Gauge, Globe2, ShieldCheck, Users } from "lucide-react";
import { Panel, Skeleton } from "./ui";
import { Stance } from "./Stance";
import { C, DivergingBar, Donut, SentimentGauge, StackedBar, leanColor } from "./charts";
import { useMarket, roomLean, stanceMix, newsLean, m5Lean, compositeSentiment, leanLabel, interpretation } from "../lib/market";
import { useWarRoom } from "../lib/warroom";
import { candleWhen, pct } from "../lib/format";

/** The five timeframes of the trend ladder, from macro to confirmation. */
function useLadder() {
  const { threads, m5 } = useMarket();
  const { room } = useWarRoom();
  const tf = (key: "D1" | "H4" | "H1", label: string, role: string) => {
    const t = threads[key];
    return { key, label, role, lean: roomLean(t?.openings), action: t?.conclusion?.status === "ok" ? t.conclusion.stance : null, note: interpretation(t?.conclusion), mix: stanceMix(t?.openings) };
  };
  const m15 = { key: "M15", label: "15m", role: "Structure", lean: roomLean(room?.openings), action: room?.conclusion?.status === "ok" ? room.conclusion.stance : null, note: interpretation(room?.conclusion), mix: stanceMix(room?.openings) };
  const confirm = m5?.buy_confirmed ? "buy confirmed" : m5?.sell_confirmed ? "sell confirmed" : "no confirmation";
  const m5row = { key: "M5", label: "5m", role: "Confirmation", lean: m5Lean(m5), action: m5?.buy_confirmed ? "BUY" : m5?.sell_confirmed ? "SELL" : null, note: m5 ? `Bias ${String(m5.bias ?? "neutral").toLowerCase()}, ${confirm} on the last closed 5m candle.` : null, mix: {} as Record<string, number> };
  return [tf("D1", "D1", "Macro trend"), tf("H4", "4H", "Intraday trend"), tf("H1", "1H", "Swing trend"), m15, m5row];
}

function SentimentCard({ ladder }: { ladder: ReturnType<typeof useLadder> }) {
  const { news, loading } = useMarket();
  const byKey = Object.fromEntries(ladder.map((r) => [r.key, r.lean]));
  const nl = newsLean(news?.counts);
  const composite = compositeSentiment({ D1: byKey.D1, H4: byKey.H4, H1: byKey.H1, M15: byKey.M15, NEWS: nl });
  const c = news?.counts ?? {};
  return (
    <Panel title="Market sentiment" icon={<Gauge className="h-3.5 w-3.5 text-cyan-300" />}>
      {loading ? <Skeleton rows={3} /> : (
        <>
          <SentimentGauge value={composite} label={leanLabel(composite)} />
          <p className="-mt-1 text-center text-[10px] text-slate-500">Rooms weighted D1 30 · 4H 25 · 1H 20 · 15m 15 · News 10</p>
          <div className="glass-inner mt-3 flex items-center gap-3 px-3 py-2.5">
            <Donut size={78} center={String((c.bullish ?? 0) + (c.bearish ?? 0) + (c.neutral ?? 0))} sub="headlines"
              parts={[{ label: "bullish", value: c.bullish ?? 0, color: C.bull }, { label: "bearish", value: c.bearish ?? 0, color: C.bear }, { label: "neutral", value: c.neutral ?? 0, color: C.muted }]} />
            <div className="min-w-0 flex-1 space-y-1 text-[11px]">
              <div className="flex items-center justify-between"><span className="eyebrow text-[9px]">News 24h</span>{news?.tldr?.status === "ok" && <Stance value={news.tldr.stance} />}</div>
              <div className="flex justify-between text-slate-400"><span><i className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: C.bull }} />Bullish</span><span className="mono">{c.bullish ?? 0}</span></div>
              <div className="flex justify-between text-slate-400"><span><i className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: C.bear }} />Bearish</span><span className="mono">{c.bearish ?? 0}</span></div>
              <div className="flex justify-between text-slate-400"><span><i className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: C.muted }} />Neutral</span><span className="mono">{c.neutral ?? 0}</span></div>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

function TrendLadder({ ladder }: { ladder: ReturnType<typeof useLadder> }) {
  const { loading } = useMarket();
  const known = ladder.filter((r) => r.lean != null && Math.abs(r.lean) >= 0.1);
  const bull = known.filter((r) => (r.lean as number) > 0).length, bear = known.length - bull;
  const align = known.length ? (bull >= bear ? `${bull} of 5 lean bullish` : `${bear} of 5 lean bearish`) : "no timeframe leans yet";
  return (
    <Panel title="Trend by timeframe" icon={<Compass className="h-3.5 w-3.5 text-violet-300" />} right={<span className="text-[10px] text-slate-500">{align}</span>}>
      {loading ? <Skeleton rows={5} /> : (
        <div className="space-y-2.5">
          {ladder.map((r) => (
            <div key={r.key} className="glass-inner px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="flex items-baseline gap-2"><span className="mono text-[12px] font-bold text-slate-100">{r.label}</span><span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{r.role}</span></div>
                <div className="flex items-center gap-1.5"><span className="text-[10px]" style={{ color: leanColor(r.lean) }}>{leanLabel(r.lean)}</span>{r.action && <Stance value={r.action} />}</div>
              </div>
              <DivergingBar value={r.lean} />
              {r.note && <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-slate-400" title={r.note}>{r.note}</p>}
            </div>
          ))}
          <p className="text-[10px] text-slate-600">Bar: the agents' confidence-weighted lean in each room (left bearish, right bullish). Chip: the moderator's action.</p>
        </div>
      )}
    </Panel>
  );
}

function ConsensusCard({ ladder }: { ladder: ReturnType<typeof useLadder> }) {
  const rows = ladder.filter((r) => Object.keys(r.mix).length);
  return (
    <Panel title="Agent consensus" icon={<Users className="h-3.5 w-3.5 text-emerald-300" />}>
      {!rows.length ? <p className="text-[12px] text-slate-500">No room has opened yet.</p> : (
        <div className="space-y-2">
          {rows.map((r) => {
            const total = Object.values(r.mix).reduce((s, n) => s + n, 0);
            const top = Object.entries(r.mix).sort((a, b) => b[1] - a[1])[0];
            return (
              <div key={r.key} className="flex items-center gap-2.5">
                <span className="mono w-8 text-[11px] font-bold text-slate-300">{r.label}</span>
                <div className="flex-1"><StackedBar mix={r.mix} /></div>
                <span className="mono w-16 text-right text-[10px] text-slate-500">{top ? `${Math.round((top[1] / total) * 100)}% ${top[0]}` : ""}</span>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[10px] text-slate-500">
            {["BUY", "WAIT", "HOLD", "CLOSE", "SELL"].map((k) => <span key={k}><i className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: ({ BUY: C.bull, SELL: C.bear, CLOSE: C.cyan } as Record<string, string>)[k] ?? C.wait }} />{k}</span>)}
          </div>
        </div>
      )}
    </Panel>
  );
}

function MacroDrivers() {
  const { news } = useMarket();
  const ctx = news?.context ?? {};
  const rows = [["gold", "Gold"], ["dollar", "DXY"], ["oil", "WTI oil"], ["usdt", "USDT.D"]].map(([k, name]) => ({ name, v: ctx[k]?.change_24h_percent as number | undefined }));
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.v ?? 0)));
  const g = ctx.gold?.change_24h_percent, d = ctx.dollar?.change_24h_percent;
  const link = g == null || d == null ? null : Math.sign(g) === -Math.sign(d) ? "Gold and the dollar move opposite ways: the usual inverse link holds." : "Gold and the dollar move the same way: the inverse link is off today.";
  return (
    <Panel title="Macro drivers · 24h" icon={<Globe2 className="h-3.5 w-3.5 text-amber-300" />}>
      {rows.every((r) => r.v == null) ? <p className="text-[12px] text-slate-500">No market context yet.</p> : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.name} className="flex items-center gap-2.5">
              <span className="w-14 text-[11px] text-slate-300">{r.name}</span>
              <div className="flex-1"><DivergingBar value={r.v ?? null} max={max} /></div>
              <span className="mono w-14 text-right text-[11px]" style={{ color: leanColor(r.v == null ? null : r.v / max) }}>{r.v == null ? "—" : `${r.v > 0 ? "+" : ""}${r.v.toFixed(2)}%`}</span>
            </div>
          ))}
          {link && <p className="pt-1 text-[10px] text-slate-500">{link}</p>}
        </div>
      )}
    </Panel>
  );
}

/** New York clock hours of the sessions, as the Chronos Matrix defines them. */
const SESSIONS = [
  { name: "Tokyo", from: 19, to: 28, color: C.violet, r: 28 },
  { name: "London", from: 3, to: 12, color: C.cyan, r: 36 },
  { name: "New York", from: 8, to: 17, color: C.wait, r: 44 },
];
function nyHour(d: Date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(d);
  return Number(p.find((x) => x.type === "hour")?.value ?? 0) + Number(p.find((x) => x.type === "minute")?.value ?? 0) / 60;
}
const pt = (r: number, h: number) => { const a = ((h * 15 - 90) * Math.PI) / 180; return [60 + r * Math.cos(a), 60 + r * Math.sin(a)] as const; };
const arcH = (r: number, a: number, b: number) => { const [x0, y0] = pt(r, a), [x1, y1] = pt(r, b); return `M ${x0} ${y0} A ${r} ${r} 0 ${(b - a) * 15 > 180 ? 1 : 0} 1 ${x1} ${y1}`; };

function SessionClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(t); }, []);
  const h = nyHour(now);
  const active = SESSIONS.filter((s) => (h >= s.from && h < s.to) || (h + 24 >= s.from && h + 24 < s.to));
  const [nx, ny] = pt(46, h);
  return (
    <Panel title="Session clock" icon={<Clock3 className="h-3.5 w-3.5 text-cyan-300" />}>
      <div className="flex items-center gap-3">
        <svg viewBox="0 0 120 120" width={112} height={112} role="img" aria-label={`Active sessions: ${active.map((s) => s.name).join(", ") || "none"}`}>
          {SESSIONS.map((s) => <path key={s.name} d={arcH(s.r, s.from, s.to)} stroke={s.color} strokeWidth="6" fill="none" strokeLinecap="round" opacity={active.includes(s) ? 1 : 0.3} />)}
          {[0, 6, 12, 18].map((t) => { const [x, y] = pt(53, t); return <text key={t} x={x} y={y + 3} textAnchor="middle" fontSize="7" fill={C.muted}>{t}</text>; })}
          <line x1="60" y1="60" x2={nx} y2={ny} stroke="#e2e8f0" strokeWidth="2" strokeLinecap="round" />
          <circle cx="60" cy="60" r="3.5" fill="#e2e8f0" />
        </svg>
        <div className="min-w-0 flex-1 space-y-1.5 text-[11px]">
          {SESSIONS.map((s) => (
            <div key={s.name} className="flex items-center justify-between">
              <span className={active.includes(s) ? "text-slate-200" : "text-slate-500"}><i className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}</span>
              <span className="mono text-[10px] text-slate-500">{String(s.from % 24).padStart(2, "0")}–{String(s.to % 24).padStart(2, "0")}</span>
            </div>
          ))}
          <p className="pt-1 text-[10px] text-slate-500">{active.length > 1 ? `${active.map((s) => s.name).join(" and ")} overlap: the most liquid hours.` : active.length ? `${active[0].name} session.` : "Between sessions: thin liquidity."} New York time.</p>
        </div>
      </div>
    </Panel>
  );
}

function DecisionStrip() {
  const { room, h1: latest } = useWarRoom();
  const h1 = room?.h1 ?? latest;
  const cf = room?.confirmations;
  const lv = latest && h1 && latest.candle_key === h1.candle_key && (latest.decision === "BUY" || latest.decision === "SELL") && latest.entry_price ? latest : null;
  const side = (x: any) => (x?.buy_confirmed ? "buy confirmed" : x?.sell_confirmed ? "sell confirmed" : "none");
  if (!h1) return null;
  return (
    <Panel title="H1 decision" icon={<ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />} right={<span className="text-[10px] text-slate-500">{candleWhen(h1.candle_key)}</span>}>
      <div className="flex items-center gap-3">
        <Donut size={64} center={pct(h1.confidence)} parts={[{ label: "confidence", value: Number(h1.confidence) || 0, color: h1.decision === "BUY" ? C.bull : h1.decision === "SELL" ? C.bear : C.wait }, { label: "rest", value: 1 - (Number(h1.confidence) || 0), color: "transparent" }]} />
        <div className="min-w-0 flex-1 space-y-1 text-[11px] text-slate-400">
          <Stance value={h1.decision} />
          {lv && <div className="mono text-slate-300">entry {lv.entry_price} · stop {lv.stop_loss} · target {lv.take_profit}</div>}
          {cf && <div><Activity className="mr-1 inline h-3 w-3" />R38 H1 {side(cf.h1_prophet_r38)} · 5m {side(cf.m5_prophet_r38)}{cf.m5_prophet_r38 && !cf.m5_prophet_r38.verified ? " (unverified)" : ""}</div>}
        </div>
      </div>
      <p className="mt-2 text-[9px] uppercase tracking-widest text-slate-600">Advisory only · levels only from the validated H1 chain · no orders</p>
    </Panel>
  );
}

/** Right panel: the trading assistant, as charts: sentiment, trend by timeframe, consensus, macro, sessions. */
export default function AssistantPanel({ className }: { className?: string }) {
  const ladder = useLadder();
  return (
    <div className={className}>
      <div className="space-y-4">
        <SentimentCard ladder={ladder} />
        <TrendLadder ladder={ladder} />
        <DecisionStrip />
        <ConsensusCard ladder={ladder} />
        <MacroDrivers />
        <SessionClock />
      </div>
    </div>
  );
}
