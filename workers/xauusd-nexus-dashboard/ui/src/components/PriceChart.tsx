import { useEffect, useRef, useState } from "react";
import { createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { CandlestickChart } from "lucide-react";
import clsx from "clsx";
import { Panel } from "./ui";
import { get } from "../lib/api";
import { useMarket } from "../lib/market";
import { ZonesPrimitive, type ChartZone } from "../lib/zones-primitive";

const ZONE_COLOR: Record<string, string> = { support: "#34d399", resistance: "#fb7185", "at price": "#22d3ee" };
const ZONE_ALPHA: Record<string, number> = { strong: 0.16, medium: 0.1, weak: 0.06 };
const fmt = (z: any) => (z.low === z.high ? z.low.toFixed(2) : `${z.low.toFixed(2)}–${z.high.toFixed(2)}`);

const TFS = [["M5", "5m"], ["M15", "15m"], ["H1", "1H"], ["H4", "4H"], ["D1", "1D"]] as const;
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number | null };

/**
 * XAUUSD closed TradingView bars from the pull adapter (MarketDataReader RPC): never a forming bar.
 * Over them (owner request 2026-11-06): the Key Level Agent's candidate zones as bands behind the
 * candles, and the strategy plan's entry, stop and targets as price lines. "Zones" toggles both.
 */
export default function PriceChart() {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [tf, setTf] = useState<string>(() => { try { return localStorage.getItem("nexus.chartTf") || "H1"; } catch { return "H1"; } });
  const zonesRef = useRef<ZonesPrimitive | null>(null);
  const planLines = useRef<IPriceLine[]>([]);
  const [showZones, setShowZones] = useState<boolean>(() => { try { return localStorage.getItem("nexus.chartZones") !== "off"; } catch { return true; } });
  const { global: g } = useMarket();
  const [head, setHead] = useState<{ last?: number; change?: number; pct?: number; basis?: string; closed?: string; error?: string }>({});

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#8b949e", fontFamily: "ui-monospace, JetBrains Mono, monospace" },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    candles.current = c.addCandlestickSeries({
      upColor: "#3fb950", downColor: "#f85149", borderUpColor: "#3fb950", borderDownColor: "#f85149", wickUpColor: "#3fb950", wickDownColor: "#f85149",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    zonesRef.current = new ZonesPrimitive();
    candles.current.attachPrimitive(zonesRef.current);
    volume.current = c.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => { c.remove(); chart.current = null; zonesRef.current = null; planLines.current = []; };
  }, []);

  // The zones and the plan follow the Global Conclusion (refreshed every 60 s).
  const strategy = g?.strategy ?? null;
  useEffect(() => {
    const series = candles.current;
    if (!series) return;
    const candidates: any[] = showZones ? strategy?.key_levels?.candidates ?? [] : [];
    const zones: ChartZone[] = candidates.map((z) => ({
      low: z.low, high: z.high, color: ZONE_COLOR[z.role] ?? "#64748b", alpha: ZONE_ALPHA[z.strength] ?? 0.08,
      label: `${fmt(z)} · ${z.strength} · ${z.sources} sources`
    }));
    zonesRef.current?.setZones(zones);
    for (const l of planLines.current) series.removePriceLine(l);
    planLines.current = [];
    const p = showZones ? strategy?.plan : null;
    if (p) {
      const line = (price: number | null | undefined, title: string, color: string, style: LineStyle) => {
        if (typeof price === "number") planLines.current.push(series.createPriceLine({ price, title, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true }));
      };
      line(p.entry, p.at_level ? "Entry" : "Entry (pullback)", "#22d3ee", LineStyle.Solid);
      line(p.stop, "Stop", "#fb7185", LineStyle.Dashed);
      line(p.tp1, `TP1 ${p.rrr?.tp1 ?? ""}R`, "#34d399", LineStyle.Dashed);
      line(p.tp2, `TP2 ${p.rrr?.tp2 ?? ""}R`, "#34d399", LineStyle.Dotted);
    }
  }, [strategy, showZones]);

  useEffect(() => {
    let fit = true;
    const load = async () => {
      try {
        const d = await get<{ candles: Candle[]; timeframe: string; basis: string; latest_close_time: string }>(`/api/ohlcv?timeframe=${tf}&limit=400`);
        const cs = d.candles || [];
        candles.current?.setData(cs.map((x) => ({ time: x.time as UTCTimestamp, open: x.open, high: x.high, low: x.low, close: x.close })));
        volume.current?.setData(cs.filter((x) => x.volume != null).map((x) => ({ time: x.time as UTCTimestamp, value: x.volume as number, color: x.close >= x.open ? "rgba(63,185,80,0.35)" : "rgba(248,81,73,0.35)" })));
        if (fit) chart.current?.timeScale().fitContent();
        fit = false;
        const last = cs.at(-1), prev = cs.at(-2);
        setHead({ last: last?.close, change: last && prev ? last.close - prev.close : undefined, pct: last && prev ? ((last.close - prev.close) / prev.close) * 100 : undefined, basis: `${d.timeframe} · ${d.basis}`, closed: d.latest_close_time });
      } catch (e) { setHead({ error: e instanceof Error ? e.message : String(e) }); }
    };
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => window.clearInterval(t);
  }, [tf]);

  const up = (head.change ?? 0) >= 0;
  return (
    <Panel
      title={<span className="flex items-baseline gap-3 normal-case tracking-normal"><span className="text-[13px] font-semibold text-slate-100">XAUUSD · OANDA</span>
        {head.last != null && <span className="mono text-[20px] font-bold text-white">{head.last.toFixed(2)}</span>}
        {head.change != null && <span className={clsx("mono text-[12px]", up ? "text-emerald-400" : "text-rose-400")}>{up ? "+" : ""}{head.change.toFixed(2)} ({up ? "+" : ""}{head.pct?.toFixed(2)}%)</span>}</span>}
      icon={<CandlestickChart className="h-4 w-4 text-amber-300" />}
      right={
        <div className="flex gap-1">
        <button type="button" aria-pressed={showZones} title="Key Level Agent zones and the strategy plan"
          onClick={() => setShowZones((v) => { try { localStorage.setItem("nexus.chartZones", v ? "off" : "on"); } catch { /* per-viewer convenience only */ } return !v; })}
          className={clsx("mr-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition", showZones ? "border-violet-400/40 bg-violet-400/10 text-violet-100" : "border-white/10 text-slate-500 hover:text-white")}>Zones</button>
        <div className="flex gap-1" role="tablist" aria-label="Chart timeframe">
          {TFS.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tf === key}
              onClick={() => { setTf(key); try { localStorage.setItem("nexus.chartTf", key); } catch { /* per-viewer convenience only */ } }}
              className={clsx("rounded-md border px-2.5 py-1 text-[11px] font-semibold transition", tf === key ? "border-cyan-400/40 bg-cyan-400/10 text-white" : "border-white/10 text-slate-400 hover:text-white")}>{label}</button>
          ))}
        </div>
        </div>
      }>
      <div ref={el} className="h-[300px] w-full sm:h-[400px]" />
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-600">
        <span>{head.error ? <span className="text-rose-300">Chart data unavailable: {head.error}</span> : `TradingView closed bars · ${head.basis ?? "…"}`}</span>
        {head.closed && <span className="mono normal-case tracking-normal">last closed bar {new Date(head.closed).toISOString().replace("T", " ").slice(0, 16)} UTC</span>}
      </div>
    </Panel>
  );
}
