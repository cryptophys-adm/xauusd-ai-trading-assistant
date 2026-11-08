import { useEffect, useRef, useState } from "react";
import { createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { CandlestickChart } from "lucide-react";
import clsx from "clsx";
import { Panel } from "./ui";
import { get } from "../lib/api";
import { useMarket } from "../lib/market";
import { ZonesPrimitive, type ChartZone } from "../lib/zones-primitive";
import { bandSeries, type Bar } from "../lib/indicators";

const ZONE_COLOR: Record<string, string> = { support: "#34d399", resistance: "#fb7185", "at price": "#22d3ee" };
const ZONE_ALPHA: Record<string, number> = { strong: 0.16, medium: 0.1, weak: 0.06 };
const fmt = (z: any) => (z.low === z.high ? z.low.toFixed(2) : `${z.low.toFixed(2)}–${z.high.toFixed(2)}`);

const TFS = [["M5", "5m"], ["M15", "15m"], ["H1", "1H"], ["H4", "4H"], ["D1", "1D"]] as const;
/** The HUD snapshot whose chart plane serves each chart (no 5m snapshot: the 5m chart reads the 15m plane). */
const PLANE_TF: Record<string, string> = { M5: "15", M15: "15", H1: "60", H4: "240", D1: "1D" };
const PLANE_LABEL: Record<string, string> = { "15": "15m", "60": "1H", "240": "4H", "1D": "D1" };
/** The strategy states in which the Fibonacci layer shows by itself (owner decision 2026-11-08). */
const SETUP_STATES = new Set(["SETUP_FORMING", "SETUP_READY", "TRIGGERED", "LOW_REWARD", "LOW_CONFIDENCE"]);

type Layers = { bands: boolean; volume: boolean; vwap: boolean; liquidity: boolean; session: boolean; fib: "auto" | "on" | "off" };
/** Defaults (owner decision 2026-11-08): zones and plan, KWW band, EMA 114 and the session volume profile; Fibonacci on a setup. */
const DEFAULT_LAYERS: Layers = { bands: true, volume: true, vwap: false, liquidity: false, session: false, fib: "auto" };
const readLayers = (): Layers => { try { return { ...DEFAULT_LAYERS, ...JSON.parse(localStorage.getItem("nexus.chartLayers") || "{}") }; } catch { return DEFAULT_LAYERS; } };

type LineKey = "kwwMean" | "kwwUp1" | "kwwDn1" | "kwwUp1618" | "kwwDn1618" | "ema114" | "vwap";
const LINE_STYLE: Record<LineKey, { color: string; width: 1 | 2; style: LineStyle; title: string }> = {
  kwwMean: { color: "rgba(250,204,21,0.9)", width: 2, style: LineStyle.Solid, title: "KWW" },
  kwwUp1: { color: "rgba(250,204,21,0.35)", width: 1, style: LineStyle.Solid, title: "" },
  kwwDn1: { color: "rgba(250,204,21,0.35)", width: 1, style: LineStyle.Solid, title: "" },
  kwwUp1618: { color: "rgba(52,211,153,0.85)", width: 2, style: LineStyle.Solid, title: "+1.618σ" },
  kwwDn1618: { color: "rgba(52,211,153,0.85)", width: 2, style: LineStyle.Solid, title: "−1.618σ" },
  ema114: { color: "rgba(255,152,0,0.95)", width: 2, style: LineStyle.Solid, title: "EMA 114" },
  vwap: { color: "rgba(34,211,238,0.9)", width: 1, style: LineStyle.Solid, title: "VWAP" }
};

/**
 * XAUUSD closed TradingView bars from the pull adapter (MarketDataReader RPC): never a forming bar.
 * Over them: the Key Level Agent's candidate zones as bands behind the candles and the strategy
 * plan's entry, stop and targets as price lines ("Zones", owner request 2026-11-06), and the GMI
 * chart layers (owner decision 2026-11-08): Bands (Z-KWW and EMA 114), Volume (the session POC,
 * VAH and VAL), Fib (the OTE band and the extensions; by itself while a setup forms), VWAP,
 * Liquidity (whale zones, FVG targets, QM and RBS/SBR) and Session (the true opens). The moving
 * lines are computed from these bars; the levels come from the HUD snapshot's chart plane.
 */
export default function PriceChart() {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lines = useRef<Partial<Record<LineKey, ISeriesApi<"Line">>>>({});
  const [tf, setTf] = useState<string>(() => { try { return localStorage.getItem("nexus.chartTf") || "H1"; } catch { return "H1"; } });
  const zonesRef = useRef<ZonesPrimitive | null>(null);
  const layerZonesRef = useRef<ZonesPrimitive | null>(null);
  const planLines = useRef<IPriceLine[]>([]);
  const layerLines = useRef<IPriceLine[]>([]);
  const [bars, setBars] = useState<Bar[]>([]);
  const [plane, setPlane] = useState<any>(null);
  const [showZones, setShowZones] = useState<boolean>(() => { try { return localStorage.getItem("nexus.chartZones") !== "off"; } catch { return true; } });
  const [layers, setLayers] = useState<Layers>(readLayers);
  const { global: g } = useMarket();
  const [head, setHead] = useState<{ last?: number; change?: number; pct?: number; basis?: string; closed?: string; error?: string }>({});

  const setLayer = <K extends keyof Layers>(k: K, v: Layers[K]) => setLayers((cur) => {
    const next = { ...cur, [k]: v };
    try { localStorage.setItem("nexus.chartLayers", JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
    return next;
  });

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
    layerZonesRef.current = new ZonesPrimitive();
    candles.current.attachPrimitive(layerZonesRef.current);
    for (const [key, s] of Object.entries(LINE_STYLE) as [LineKey, (typeof LINE_STYLE)[LineKey]][]) {
      lines.current[key] = c.addLineSeries({ color: s.color, lineWidth: s.width, lineStyle: s.style, title: s.title, priceLineVisible: false, lastValueVisible: Boolean(s.title), crosshairMarkerVisible: false });
    }
    volume.current = c.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => { c.remove(); chart.current = null; zonesRef.current = null; layerZonesRef.current = null; planLines.current = []; layerLines.current = []; lines.current = {}; };
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
        const d = await get<{ candles: Bar[]; timeframe: string; basis: string; latest_close_time: string }>(`/api/ohlcv?timeframe=${tf}&limit=400`);
        const cs = d.candles || [];
        candles.current?.setData(cs.map((x) => ({ time: x.time as UTCTimestamp, open: x.open, high: x.high, low: x.low, close: x.close })));
        volume.current?.setData(cs.filter((x) => x.volume != null).map((x) => ({ time: x.time as UTCTimestamp, value: x.volume as number, color: x.close >= x.open ? "rgba(63,185,80,0.35)" : "rgba(248,81,73,0.35)" })));
        setBars(cs);
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

  // The chart plane of the chart's HUD snapshot (the levels GMI draws), refreshed every minute.
  const planeTf = PLANE_TF[tf] ?? "60";
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await get<{ levels?: { chart_plane?: any } }>(`/api/hud/levels?tf=${planeTf}`);
        if (alive) setPlane(d.levels?.chart_plane ?? null);
      } catch { if (alive) setPlane(null); }
    };
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [planeTf]);

  // The moving lines: Z-KWW, EMA 114 and VWAP from the chart's own bars.
  const vwapAllowed = tf === "M5" || tf === "M15" || tf === "H1";
  useEffect(() => {
    const s = bandSeries(bars);
    const show: Record<LineKey, boolean> = {
      kwwMean: layers.bands, kwwUp1: layers.bands, kwwDn1: layers.bands, kwwUp1618: layers.bands, kwwDn1618: layers.bands,
      ema114: layers.bands, vwap: layers.vwap && vwapAllowed
    };
    for (const key of Object.keys(LINE_STYLE) as LineKey[]) {
      lines.current[key]?.setData(show[key] ? s[key].map((p) => ({ time: p.time as UTCTimestamp, value: p.value })) : []);
    }
  }, [bars, layers.bands, layers.vwap, vwapAllowed]);

  // The plane's levels: Volume, Fib, Liquidity and Session.
  const fibShown = layers.fib === "on" || (layers.fib === "auto" && SETUP_STATES.has(String(strategy?.state ?? "")));
  useEffect(() => {
    const series = candles.current;
    if (!series) return;
    for (const l of layerLines.current) series.removePriceLine(l);
    layerLines.current = [];
    const zones: ChartZone[] = [];
    // Each level is named on the price axis; the FVG targets (up to six) stay unlabelled to keep the axis readable.
    const line = (price: unknown, title: string, color: string, style = LineStyle.Dashed, axis = true) => {
      if (typeof price === "number" && Number.isFinite(price)) layerLines.current.push(series.createPriceLine({ price, title, color, lineWidth: 1, lineStyle: style, axisLabelVisible: axis }));
    };
    const p = plane;
    if (p) {
      if (layers.volume) {
        const vp = p.session?.profile?.current;
        line(vp?.poc, "POC", "#e879f9", LineStyle.Solid);
        line(vp?.vah, "VAH", "#c084fc", LineStyle.Dashed);
        line(vp?.val, "VAL", "#c084fc", LineStyle.Dashed);
      }
      if (fibShown && p.projection?.fib?.levels) {
        const f = p.projection.fib.levels;
        if (typeof f["0.618"] === "number" && typeof f["0.786"] === "number") {
          zones.push({ low: Math.min(f["0.618"], f["0.786"]), high: Math.max(f["0.618"], f["0.786"]), color: "#38bdf8", alpha: 0.1, label: `Fib OTE 0.618–0.786 (${PLANE_LABEL[planeTf]} ${p.projection.fib.direction} leg)` });
        }
        line(f["0.5"], "Fib 0.5", "#4ade80", LineStyle.Dotted);
        line(f["1.272"], "Fib 1.272", "#81c784", LineStyle.Dotted);
        line(f["1.618"], "Fib 1.618", "#2962ff", LineStyle.Dotted);
      }
      if (layers.liquidity) {
        const liq = p.liquidity || {};
        for (const z of (liq.whale_zones || []).slice(0, 4)) {
          zones.push({ low: z.bottom, high: z.top, color: z.role === "support" ? "#22d3ee" : "#f43f5e", alpha: z.state === "active" ? 0.14 : 0.07, label: z.state === "active" ? `whale ${z.role}` : `mitigation block (${z.role})` });
        }
        for (const f of (liq.fvg?.bull || []).slice(0, 3)) line(f.price, "", "#34d399", LineStyle.Dotted, false);
        for (const f of (liq.fvg?.bear || []).slice(0, 3)) line(f.price, "", "#fb7185", LineStyle.Dotted, false);
        line(liq.gabfx?.qm_buy, "QM buy", "#22d3ee");
        line(liq.gabfx?.qm_sell, "QM sell", "#e879f9");
        line(liq.gabfx?.rbs, "RBS", "#22d3ee", LineStyle.Solid);
        line(liq.gabfx?.sbr, "SBR", "#e879f9", LineStyle.Solid);
      }
      if (layers.session) {
        const o = p.session?.opens || {};
        line(o.day, "Day open", "#94a3b8", LineStyle.Dotted);
        line(o.week, "Week open", "#cbd5e1", LineStyle.Dotted);
        line(o.month, "Month open", "#f1f5f9", LineStyle.Dotted);
      }
    }
    layerZonesRef.current?.setZones(zones);
  }, [plane, planeTf, layers.volume, layers.liquidity, layers.session, fibShown]);

  const up = (head.change ?? 0) >= 0;
  const chip = (on: boolean) => clsx("rounded-md border px-2 py-1 text-[11px] font-semibold transition", on ? "border-violet-400/40 bg-violet-400/10 text-violet-100" : "border-white/10 text-slate-500 hover:text-white");
  const fibNext: Record<Layers["fib"], Layers["fib"]> = { auto: "on", on: "off", off: "auto" };
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
      <div className="mb-2 flex flex-wrap items-center gap-1" aria-label="Chart layers">
        <button type="button" aria-pressed={showZones} title="Key Level Agent zones and the strategy plan" className={chip(showZones)}
          onClick={() => setShowZones((v) => { try { localStorage.setItem("nexus.chartZones", v ? "off" : "on"); } catch { /* per-viewer convenience only */ } return !v; })}>Zones</button>
        <button type="button" aria-pressed={layers.bands} title="Z-KWW mean, ±1σ and ±1.618σ, and EMA 114" className={chip(layers.bands)} onClick={() => setLayer("bands", !layers.bands)}>Bands</button>
        <button type="button" aria-pressed={layers.volume} title="The session volume profile: POC, VAH and VAL" className={chip(layers.volume)} onClick={() => setLayer("volume", !layers.volume)}>Volume</button>
        <button type="button" aria-pressed={layers.fib !== "off"} title="Fibonacci OTE band and extensions. Auto: shown while a setup forms" className={chip(fibShown)} onClick={() => setLayer("fib", fibNext[layers.fib])}>Fib · {layers.fib}</button>
        <button type="button" aria-pressed={layers.vwap} disabled={!vwapAllowed} title={vwapAllowed ? "Session VWAP" : "VWAP is for the 5m to 1H charts"} className={clsx(chip(layers.vwap && vwapAllowed), !vwapAllowed && "opacity-40")} onClick={() => setLayer("vwap", !layers.vwap)}>VWAP</button>
        <button type="button" aria-pressed={layers.liquidity} title="Whale zones, FVG targets, QM and RBS/SBR" className={chip(layers.liquidity)} onClick={() => setLayer("liquidity", !layers.liquidity)}>Liquidity</button>
        <button type="button" aria-pressed={layers.session} title="True day, week and month opens" className={chip(layers.session)} onClick={() => setLayer("session", !layers.session)}>Session</button>
      </div>
      <div ref={el} className="h-[300px] w-full sm:h-[400px]" />
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-600">
        <span>{head.error ? <span className="text-rose-300">Chart data unavailable: {head.error}</span> : `TradingView closed bars · ${head.basis ?? "…"}`}</span>
        <span className="normal-case tracking-normal">{plane ? `GMI levels from the ${PLANE_LABEL[planeTf]} snapshot` : "GMI levels: waiting for the chart plane"}</span>
        {head.closed && <span className="mono normal-case tracking-normal">last closed bar {new Date(head.closed).toISOString().replace("T", " ").slice(0, 16)} UTC</span>}
      </div>
    </Panel>
  );
}
