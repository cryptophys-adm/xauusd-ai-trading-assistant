import { useEffect, useRef, useState } from "react";
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { CandlestickChart } from "lucide-react";
import clsx from "clsx";
import { Panel } from "./ui";
import { get } from "../lib/api";

const TFS = [["M5", "5m"], ["M15", "15m"], ["H1", "1H"], ["H4", "4H"], ["D1", "1D"]] as const;
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number | null };

/** XAUUSD closed TradingView bars from the pull adapter (MarketDataReader RPC): never a forming bar. */
export default function PriceChart() {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [tf, setTf] = useState<string>(() => { try { return localStorage.getItem("nexus.chartTf") || "H1"; } catch { return "H1"; } });
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
    volume.current = c.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => { c.remove(); chart.current = null; };
  }, []);

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
        <div className="flex gap-1" role="tablist" aria-label="Chart timeframe">
          {TFS.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tf === key}
              onClick={() => { setTf(key); try { localStorage.setItem("nexus.chartTf", key); } catch { /* per-viewer convenience only */ } }}
              className={clsx("rounded-md border px-2.5 py-1 text-[11px] font-semibold transition", tf === key ? "border-cyan-400/40 bg-cyan-400/10 text-white" : "border-white/10 text-slate-400 hover:text-white")}>{label}</button>
          ))}
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
