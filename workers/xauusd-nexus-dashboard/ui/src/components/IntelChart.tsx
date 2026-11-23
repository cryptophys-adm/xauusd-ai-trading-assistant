import { useEffect, useRef } from "react";
import { createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type SeriesMarker, type TickMarkType, type Time, type UTCTimestamp } from "lightweight-charts";
import { ChartCredit, Empty, PollBody } from "./ui";
import type { Poll } from "../lib/usePoll";
import { CANDLE, T, tagText } from "../lib/tokens";
import { ZonesPrimitive, type ChartZone } from "../lib/zones-primitive";
import { LinesPrimitive, type ChartLine } from "../lib/lines-primitive";
import { num, price, utcDayTime } from "../lib/intel";
import { gmt7ClockOf, gmt7Crosshair, gmt7Tick } from "../lib/entryZone";

// The Intelligence pages' chart (Track C2; C3 adds segments and markers, C4 boxes): the feed's closed candles with
// bands behind them (lib/zones-primitive.ts in its "anchored" label mode: each label next to its own band, inside the
// plot) and markers. The chart is built only in useEffect, never during render, so a page's pure view renders in the
// page render check (scripts/render-check.mjs, lightweight-charts on its stub). The only price line is the last close.
// C3 adds lines (lib/lines-primitive.ts: a pattern's boundaries from bar to bar, its measured targets) and the opt-in
// `plan` (owner ruling at the C3 mockup's approval): the lines of one agent plan, each with its price tag on the axis,
// which only the page of that plan's own chart passes. By default no order line of any kind is drawn (the Liquidity
// page passes none).
// Times (EZ1's helpers, as the War Room chart): the time axis and the crosshair in GMT+7 (lib/entryZone.ts gmt7Tick and
// gmt7Crosshair), and the last closed bar's time in UTC and GMT+7 under the chart. A pure axis-label change: the same on
// every page that draws this chart (Liquidity, Chart patterns).

export type IntelBar = { time: number; open: number; high: number; low: number; close: number };
/** A marker on a bar: a sweep (▲ below the bar or ▼ above it) or a breakout ("circle", on the bar), in its colour. */
export type IntelMarker = { time: number; above: boolean; color: string; shape?: "circle" };

/** The bars of an /api/ohlcv body that are whole candles, oldest first. */
export function barsOf(body: any): IntelBar[] {
  const list: any[] = Array.isArray(body?.candles) ? body.candles : [];
  return list.filter((b) => num(b?.time) && num(b?.open) && num(b?.high) && num(b?.low) && num(b?.close)).map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })).sort((a, b) => a.time - b.time);
}

/** The visible bars: about 52 on a phone, 112 on a wider chart (the mockup's 13 and 28 hours of 15m candles). */
const visibleBars = (width: number) => (width < 520 ? 52 : 112);
const NO_LINES: ChartLine[] = [];

/** "Mon 23 Nov 15:00 UTC · 22:00 GMT+7": a bar's close in UTC and GMT+7. */
export function closeText(openSec: number, intervalS: number): string {
  const ms = (openSec + intervalS) * 1000;
  const d = new Date(ms);
  return `${utcDayTime(ms).slice(0, 3)} ${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${utcDayTime(ms).slice(4)} UTC · ${gmt7ClockOf(ms)} GMT+7`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function IntelChart({ poll, bars, zones, markers = [], fit = [], caption = "feed scale", label, lines = NO_LINES, plan = NO_LINES, visible = visibleBars, timeVisible = true, intervalS = 900, emptyTitle = "No 15m candles yet", emptyWhen = "The feed's closed 15m candles load every minute." }: {
  /** The candles' poll: its skeleton, its error box, or its empty state while there is no candle. */
  poll?: Poll;
  bars: IntelBar[];
  /** The bands, in the order their labels pick a spot. */
  zones: ChartZone[];
  markers?: IntelMarker[];
  /** Prices the price scale keeps in view beside the candles (the nearest bands). */
  fit?: number[];
  /** The price axis' scale, shown over the axis in every state. */
  caption?: string;
  /** The chart's accessible name. */
  label: string;
  /** Lines over the candles (a pattern's boundaries, its measured targets), never with a price tag. */
  lines?: ChartLine[];
  /** Opt-in: one agent plan's lines, each with its price tag. Empty by default: no order line. */
  plan?: ChartLine[];
  /** The bars in view at a width. */
  visible?: (width: number) => number;
  /** The time of day on the time axis (off for daily bars). */
  timeVisible?: boolean;
  /** A bar's length in seconds, for the last closed bar's time (15m by default). */
  intervalS?: number;
  /** The empty state while there is no candle. */
  emptyTitle?: string;
  emptyWhen?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const prim = useRef<ZonesPrimitive | null>(null);
  const linesPrim = useRef<LinesPrimitive | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const lastLine = useRef<IPriceLine | null>(null);
  const fitRef = useRef<number[]>(fit);
  fitRef.current = fit;

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      // No library logo (its <style> is blocked by the CSP): the caption's "Charts by TradingView" link is the attribution.
      layout: { background: { color: "transparent" }, textColor: T.fg2, fontFamily: "ui-monospace, JetBrains Mono, monospace", fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)", scaleMargins: { top: 0.1, bottom: 0.06 } },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false, rightOffset: 2, tickMarkFormatter: (t: Time, type: TickMarkType) => gmt7Tick(t, type) },
      crosshair: { mode: 0 },
      // Prices as every other price on the page: "2,684.20"; the crosshair's time in GMT+7 (the time axis too).
      localization: { priceFormatter: (p: number) => price(p), timeFormatter: (t: Time) => gmt7Crosshair(t) },
      handleScroll: true, handleScale: true
    });
    const s = c.addCandlestickSeries({
      ...CANDLE, lastValueVisible: false, priceLineVisible: false, priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      // The price scale keeps the nearest bands in view beside the candles.
      autoscaleInfoProvider: (original: () => any) => {
        const r = original();
        const extra = fitRef.current.filter(num);
        if (!r?.priceRange || !extra.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...extra), maxValue: Math.max(r.priceRange.maxValue, ...extra) } };
      }
    });
    const p = new ZonesPrimitive("anchored");
    s.attachPrimitive(p);
    const lp = new LinesPrimitive((x: number) => price(x));
    s.attachPrimitive(lp);
    chart.current = c; series.current = s; prim.current = p; linesPrim.current = lp;
    return () => { c.remove(); chart.current = null; series.current = null; prim.current = null; linesPrim.current = null; lastLine.current = null; };
  }, []);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    if (lastLine.current) { s.removePriceLine(lastLine.current); lastLine.current = null; }
    const last = bars.at(-1);
    if (last) {
      // The last close, as the War Room chart draws it: dashed in the candle's colour, dark text on its axis tag.
      const color = last.close >= last.open ? T.bullFill : T.bearFill;
      lastLine.current = s.createPriceLine({ price: last.close, title: "", color, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, axisLabelTextColor: tagText(color) });
      const n = visibleRef.current(el.current?.clientWidth ?? 1000);
      chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - n), to: bars.length + 1 });
    }
  }, [bars]);

  useEffect(() => { prim.current?.setZones(zones); chart.current?.priceScale("right").applyOptions({}); }, [zones]);

  useEffect(() => { chart.current?.applyOptions({ timeScale: { timeVisible } }); }, [timeVisible]);

  // The plan's lines first (their labels pick first), each with its price tag; the other lines never carry one.
  useEffect(() => {
    linesPrim.current?.setLines([...plan.map((l) => ({ ...l, tag: true })), ...lines.map((l) => ({ ...l, tag: false }))]);
    chart.current?.priceScale("right").applyOptions({});
  }, [lines, plan]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const ms: SeriesMarker<Time>[] = [...markers].sort((a, b) => a.time - b.time).map((m) => ({
      time: m.time as UTCTimestamp, position: m.shape === "circle" ? "inBar" : m.above ? "aboveBar" : "belowBar", shape: m.shape === "circle" ? "circle" : m.above ? "arrowDown" : "arrowUp", color: m.color, size: 0.7
    }));
    s.setMarkers(ms);
  }, [markers]);

  const empty = bars.length === 0;
  return (
    <div className="relative">
      {empty ? (
        poll
          ? <PollBody poll={poll} skeleton="chart" empty={<Empty when={emptyWhen}>{emptyTitle}</Empty>}>{null}</PollBody>
          : <Empty when={emptyWhen}>{emptyTitle}</Empty>
      ) : null}
      <div className={empty ? "hidden" : "relative pt-6"}>
        {/* The price axis' scale in every state (mockup review, rule 7), over the axis; the time axis' zone below it. */}
        <span className="mono pointer-events-none absolute right-1 top-0 z-10 text-left text-[9px] leading-tight text-fg">{caption.split(" ").map((w) => <span key={w} className="block">{w}</span>)}</span>
        <div ref={el} role="img" aria-label={label} className="h-[340px] w-full sm:h-[440px]" />
        <span className="mono pointer-events-none absolute bottom-1 right-1 z-10 text-[9px] text-muted">GMT+7</span>
      </div>
      {!empty ? (
        <div className="mono mt-1 flex flex-wrap justify-end gap-x-3 gap-y-0.5 text-[10px] text-fg-2">
          <span>last closed bar {closeText(bars[bars.length - 1].time, intervalS)}</span>
          <ChartCredit />
        </div>
      ) : null}
    </div>
  );
}
