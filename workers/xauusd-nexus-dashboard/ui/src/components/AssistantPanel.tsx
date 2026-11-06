import { useEffect, useState } from "react";
import { Activity, Clock3, Compass, Gauge, Globe2, Globe, Layers3, Radar, Users } from "lucide-react";
import { Badge, Panel, Skeleton } from "./ui";
import { Stance, stanceColor } from "./Stance";
import { C, DivergingBar, Donut, LevelLadder, RegimeRadar, SentimentGauge, StackedBar, leanColor } from "./charts";
import { useMarket, roomLean, stanceMix, m5Lean, leanLabel, interpretation } from "../lib/market";
import { useWarRoom } from "../lib/warroom";
import { useTab, tabLabel, TAB_HUD_TF } from "../lib/tab";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { candleWhen, pct, utc } from "../lib/format";

const side = (x: any) => (x?.buy_confirmed ? "buy confirmed" : x?.sell_confirmed ? "sell confirmed" : "none");

/**
 * Global Conclusion (owner decision 2026-11-06): the multi-timeframe summary of the D1, 4H, 1H
 * and 15m War Rooms and the news, from GET /api/conclusion/global. The action stays bound by the
 * authoritative H1 decision; the validated H1 levels show only when it is BUY or SELL.
 */
function GlobalConclusion() {
  const { global: g, loading } = useMarket();
  const { room, h1: latest } = useWarRoom();
  const cf = room?.confirmations;
  const h1 = g?.h1_decision;
  const lv = latest && h1 && latest.candle_key === h1.candle_key && (latest.decision === "BUY" || latest.decision === "SELL") && latest.entry_price ? latest : null;
  return (
    <Panel title="Global conclusion" icon={<Globe className="h-3.5 w-3.5 text-cyan-300" />} right={g && <Badge tone={g.bias === "BULLISH" ? "green" : g.bias === "BEARISH" ? "red" : "slate"}>bias {String(g.bias).toLowerCase()}</Badge>}>
      {loading && !g ? <Skeleton rows={3} /> : !g ? <p className="text-[12px] text-slate-500">The Global Conclusion is not available yet.</p> : (
        <>
          <div className="flex items-center gap-3">
            <div className="flex flex-col">
              <div className={`mono text-[40px] font-extrabold leading-none ${stanceColor(g.action)}`} style={{ textShadow: "0 0 24px currentColor" }}>{g.action}</div>
              <div className="mt-1 text-[11px] text-slate-500">{g.bias === "NEUTRAL" ? "timeframes split" : `${g.alignment.with_bias} of ${g.alignment.of} timeframes agree`}</div>
            </div>
            <div className="ml-auto grid grid-cols-5 gap-1" role="img" aria-label="Lean per timeframe">
              {g.timeframes.map((t: any) => (
                <div key={t.key} className="flex flex-col items-center gap-1" title={`${t.label}: ${leanLabel(t.lean)}${t.action ? `, ${t.action}` : ""}`}>
                  <div className="h-8 w-7 rounded-md border border-white/10" style={{ background: t.available ? `${leanColor(t.lean)}${t.stale ? "33" : "88"}` : "transparent" }} />
                  <span className="mono text-[9px] text-slate-400">{t.label}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="glass-inner mt-3 px-3 py-2.5 text-[12px] leading-relaxed text-slate-300">{g.summary}</p>
          {h1 && (
            <div className="mt-2 space-y-1 text-[11px] text-slate-400">
              <div className="flex flex-wrap items-center gap-2"><span className="eyebrow text-[9px]">H1 decision</span><Stance value={h1.decision} /><span className="mono">{pct(h1.confidence)}</span><span>· {candleWhen(h1.candle_key)}</span></div>
              {lv && <div className="mono text-slate-300">entry {lv.entry_price} · stop {lv.stop_loss} · target {lv.take_profit}</div>}
              {cf && <div><Activity className="mr-1 inline h-3 w-3" />R38 H1 {side(cf.h1_prophet_r38)} · 5m {side(cf.m5_prophet_r38)}{cf.m5_prophet_r38 && !cf.m5_prophet_r38.verified ? " (unverified)" : ""}</div>}
            </div>
          )}
          <p className="mt-2 text-[9px] uppercase tracking-widest text-slate-600">Advisory only · levels only from the validated H1 chain · no orders</p>
        </>
      )}
    </Panel>
  );
}

function SentimentCard() {
  const { global: g, news, loading } = useMarket();
  const c = news?.counts ?? {};
  const score = g?.score ?? null;
  return (
    <Panel title="Market sentiment" icon={<Gauge className="h-3.5 w-3.5 text-cyan-300" />}>
      {loading && !g ? <Skeleton rows={3} /> : (
        <>
          <SentimentGauge value={score} label={leanLabel(score)} />
          <p className="-mt-1 text-center text-[10px] text-slate-500">Rooms weighted D1 30 · 4H 25 · 1H 20 · 15m 15 · News 10</p>
          <div className="glass-inner mt-3 flex items-center gap-3 px-3 py-2.5">
            <Donut size={78} center={String((c.bullish ?? 0) + (c.bearish ?? 0) + (c.neutral ?? 0))} sub="headlines"
              parts={[{ label: "bullish", value: c.bullish ?? 0, color: C.bull }, { label: "bearish", value: c.bearish ?? 0, color: C.bear }, { label: "neutral", value: c.neutral ?? 0, color: C.muted }]} />
            <div className="min-w-0 flex-1 space-y-1 text-[11px]">
              <div className="flex items-center justify-between"><span className="eyebrow text-[9px]">News 24h</span>{news?.tldr?.status === "ok" && <Stance value={news.tldr.stance} />}</div>
              {([["Bullish", c.bullish, C.bull], ["Bearish", c.bearish, C.bear], ["Neutral", c.neutral, C.muted]] as const).map(([name, n, col]) => (
                <div key={name} className="flex justify-between text-slate-400"><span><i className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: col }} />{name}</span><span className="mono">{n ?? 0}</span></div>
              ))}
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

/** The five timeframes, from macro to confirmation: room lean, moderator action, one line. */
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

function TrendLadder({ ladder }: { ladder: ReturnType<typeof useLadder> }) {
  const { loading } = useMarket();
  const { tab } = useTab();
  return (
    <Panel title="Trend by timeframe" icon={<Compass className="h-3.5 w-3.5 text-violet-300" />}>
      {loading ? <Skeleton rows={5} /> : (
        <div className="space-y-2">
          {ladder.map((r) => (
            <div key={r.key} className={`glass-inner px-3 py-2 ${r.key === tab ? "border-cyan-400/40" : ""}`}>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="flex items-baseline gap-2"><span className="mono text-[12px] font-bold text-slate-100">{r.label}</span><span className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{r.role}</span></div>
                <div className="flex items-center gap-1.5"><span className="text-[10px]" style={{ color: leanColor(r.lean) }}>{leanLabel(r.lean)}</span>{r.action && <Stance value={r.action} />}</div>
              </div>
              <DivergingBar value={r.lean} />
              {r.note && <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-slate-400" title={r.note}>{r.note}</p>}
            </div>
          ))}
          <p className="text-[10px] text-slate-600">Bar: the agents' confidence-weighted lean in each room (left bearish, right bullish). Chip: the room's decision (the bar is its bias).</p>
        </div>
      )}
    </Panel>
  );
}

const BAND_TEXT: Record<string, string> = {
  above_h6: "above H6", h5_h6: "between H5 and H6", h4_h5: "in the H4–H5 breakout zone", h3_h4: "between H3 and H4", l3_h3: "inside the H3–L3 range",
  l4_l3: "between L4 and L3", l5_l4: "in the L4–L5 breakdown zone", l6_l5: "between L6 and L5", below_l6: "below L6"
};

/** Camarilla/CPR ladder and regime radar of the active tab's chart (News reads the 1-hour chart). */
function useLevels() {
  const { tab } = useTab();
  const tf = TAB_HUD_TF[tab];
  const { data, loading } = usePoll(() => get(`/api/hud/levels?tf=${tf}`).catch(() => null), 60_000, [tf]);
  return { tab, tf, levels: (data as any)?.levels ?? null, loading: loading && !data };
}

const chartName = (tab: string) => (tab === "NEWS" ? "1H" : tabLabel(tab as any));

function LevelsCard({ levels, loading, tab }: { levels: any; loading: boolean; tab: string }) {
  const [pick, setPick] = useState<string | null>(null);
  const sets = levels?.camarilla ?? [];
  const set = sets.find((s: any) => s.tf === pick) ?? sets[0];
  useEffect(() => setPick(null), [tab]);
  const verified = levels?.calibration?.levels === "computed_from_verified_bars";
  return (
    <Panel title={`Levels · ${chartName(tab)}`} icon={<Layers3 className="h-3.5 w-3.5 text-amber-300" />}
      right={levels && <Badge tone={verified ? "green" : "slate"}>{verified ? "from verified bars" : "not yet calibrated"}</Badge>}>
      {loading ? <Skeleton rows={5} /> : !set ? <p className="text-[12px] text-slate-500">No HUD snapshot for this chart yet.</p> : (
        <>
          {sets.length > 1 && (
            <div className="mb-2 flex gap-1">
              {sets.map((s: any) => (
                <button key={s.tf} type="button" onClick={() => setPick(s.tf)}
                  className={`rounded-md border px-2 py-0.5 text-[10px] ${s.tf === set.tf ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100" : "border-white/10 text-slate-400 hover:text-slate-200"}`}>{s.label}</button>
              ))}
            </div>
          )}
          <LevelLadder levels={set.levels} close={levels.close} daily={levels.cpr?.daily} weekly={levels.cpr?.weekly} />
          <p className="mt-1 text-[11px] text-slate-400">
            Close <span className="mono text-slate-200">{levels.close?.toFixed(2) ?? "—"}</span> is {BAND_TEXT[set.band] ?? "off the ladder"} of the {String(set.label).toLowerCase()} Camarilla
            {levels.cpr?.daily?.position ? `, ${levels.cpr.daily.position === "above_tc" ? "above" : levels.cpr.daily.position === "below_bc" ? "below" : "inside"} the daily pivot range` : ""}.
          </p>
          <p className="mt-1 text-[10px] text-slate-600">Snapshot {utc(levels.computed_at)} · Camarilla and pivots are formulas of closed bars.</p>
        </>
      )}
    </Panel>
  );
}

function regimeText(axes: any[]) {
  const v = Object.fromEntries(axes.map((a) => [a.key, a.value]));
  if (v.trend == null) return null;
  const trend = v.trend > 0.6 ? "trending" : v.trend < 0.45 ? "mean-reverting" : "weakly trending";
  const flow = v.efficiency == null ? "" : v.efficiency > 0.5 ? ", with efficient, directional movement" : ", with noisy movement";
  return `The market is ${trend}${flow}.`;
}

function RegimeCard({ levels, loading, tab }: { levels: any; loading: boolean; tab: string }) {
  const axes = levels?.regime?.axes ?? [];
  const text = regimeText(axes);
  return (
    <Panel title={`Regime · ${chartName(tab)}`} icon={<Radar className="h-3.5 w-3.5 text-cyan-300" />}
      right={levels?.regime?.chaos ? <Badge tone="red">chaos</Badge> : levels ? <Badge tone="slate">not yet calibrated</Badge> : null}>
      {loading ? <Skeleton rows={4} /> : !axes.length || axes.every((a: any) => a.value == null) ? <p className="text-[12px] text-slate-500">No regime sensors for this chart yet.</p> : (
        <>
          <div className="flex justify-center"><RegimeRadar axes={axes} color={levels.regime.chaos ? C.bear : C.cyan} /></div>
          {text && <p className="text-[11px] text-slate-400">{text}{levels.regime.z != null ? ` Price sits ${Math.abs(levels.regime.z).toFixed(2)} standard deviations ${levels.regime.z >= 0 ? "above" : "below"} its mean.` : ""}</p>}
          <p className="mt-1 text-[10px] text-slate-600">Engine sensors (Hurst, efficiency, z-score, volume, cycles, entropy), each scaled 0–100.</p>
        </>
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

/**
 * Right panel, charts only: the Global Conclusion first, then sentiment, trend by timeframe, the
 * level ladder and regime radar of the active tab's chart, agent consensus, macro drivers and the
 * session clock.
 */
export default function AssistantPanel({ className }: { className?: string }) {
  const ladder = useLadder();
  const { tab, levels, loading } = useLevels();
  return (
    <div className={className}>
      <div className="space-y-4">
        <GlobalConclusion />
        <SentimentCard />
        <TrendLadder ladder={ladder} />
        <LevelsCard levels={levels} loading={loading} tab={tab} />
        <RegimeCard levels={levels} loading={loading} tab={tab} />
        <ConsensusCard ladder={ladder} />
        <MacroDrivers />
        <SessionClock />
      </div>
    </div>
  );
}
