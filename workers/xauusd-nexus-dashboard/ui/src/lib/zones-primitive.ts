import type { ISeriesPrimitive, ISeriesPrimitivePaneRenderer, ISeriesPrimitivePaneView, SeriesAttachedParameter, Time, ISeriesApi, SeriesType } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

/**
 * One horizontal band on the chart: a Key Level Agent zone. The optional fields are the Intelligence pages' (Track C2,
 * components/IntelChart.tsx); a zone without them draws as before.
 * - `outline`: the edges only, no fill (a key zone); `dash`: dashed edges (a management candidate, a whale zone);
 * - `from`: the band starts at this bar's time instead of the left edge (a whale zone since it formed);
 * - `text`: the label's colour (a text token; default the zone's colour), drawn with a dark halo above the candles.
 */
export type ChartZone = { low: number; high: number; color: string; alpha: number; label: string; outline?: boolean; dash?: number[]; from?: Time; text?: string };

/** How a primitive places its labels: "first" (as before: top left, zones close together share one) or "anchored". */
export type LabelMode = "first" | "anchored";

const rgba = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/** A label's box in the pane (CSS pixels). */
export type Box = { x0: number; y0: number; x1: number; y1: number };
const hit = (a: Box, b: Box) => !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0);

/**
 * Pure: where a band's label goes ("anchored" mode, mockup review round 2): next to its own band, above its top edge
 * or below its bottom edge, at the left, the right or a third of the way in, the first spot clear of the labels
 * already placed; each spot clamped inside the plot. With no clear spot, the first spot that fits. Returns the
 * baseline-left point, or null when the band is out of view.
 */
export function placeLabel(band: { top: number; bottom: number; left?: number }, w: number, fs: number, width: number, height: number, placed: Box[]): { x: number; y: number; box: Box } | null {
  const xs = [Math.max(6, (band.left ?? 0) + 4), width - 6 - w, Math.max(width * 0.35, (band.left ?? 0) + 4)];
  const ys = [band.top - 3, band.bottom + fs + 1];
  let first: { x: number; y: number; box: Box } | null = null;
  for (const y of ys) {
    for (const x0 of xs) {
      const x = Math.max(3, Math.min(x0, width - 3 - w));
      const box = { x0: x - 1, y0: y - fs - 1, x1: x + w + 1, y1: y + 0.3 * fs + 1 };
      if (box.y0 < 0 || box.y1 > height) continue;
      const spot = { x, y, box };
      if (!first) first = spot;
      if (!placed.some((p) => hit(p, box))) return spot;
    }
  }
  return first;
}

class ZonesRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(private readonly owner: ZonesPrimitive) {}
  /** The anchored labels, above the candles (the "first" mode draws its labels with the bands, behind them). */
  draw(target: CanvasRenderingTarget2D): void {
    const series = this.owner.series;
    if (!series || this.owner.mode !== "anchored" || !this.owner.zones.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      const fs = mediaSize.width < 480 ? 9 : 10;
      ctx.font = `${fs}px ui-monospace, JetBrains Mono, monospace`;
      ctx.textBaseline = "alphabetic";
      const placed: Box[] = [];
      for (const z of this.owner.zones) {
        if (!z.label) continue;
        const yHigh = series.priceToCoordinate(z.high), yLow = series.priceToCoordinate(z.low);
        if (yHigh == null || yLow == null) continue;
        const top = Math.min(yHigh, yLow), bottom = Math.max(yHigh, yLow);
        if (bottom < 0 || top > mediaSize.height) continue;
        const left = z.from != null ? this.owner.chart?.timeScale().timeToCoordinate(z.from) ?? 0 : 0;
        const spot = placeLabel({ top, bottom, left }, ctx.measureText(z.label).width, fs, mediaSize.width, mediaSize.height, placed);
        if (!spot) continue;
        placed.push(spot.box);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#05070c";
        ctx.strokeText(z.label, spot.x, spot.y);
        ctx.fillStyle = z.text ?? z.color;
        ctx.fillText(z.label, spot.x, spot.y);
      }
      ctx.restore();
    });
  }
  drawBackground(target: CanvasRenderingTarget2D): void {
    const series = this.owner.series;
    if (!series || !this.owner.zones.length) return;
    const anchored = this.owner.mode === "anchored";
    const timeScale = this.owner.chart?.timeScale();
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      ctx.save();
      ctx.font = `${Math.round(10 * vr)}px ui-monospace, JetBrains Mono, monospace`;
      ctx.textBaseline = "bottom";
      // Labels only where there is room: zones close together share the first label.
      let lastLabel = -Infinity;
      const zones = anchored ? this.owner.zones : [...this.owner.zones].sort((a, b) => b.high - a.high);
      for (const z of zones) {
        const yHigh = series.priceToCoordinate(z.high), yLow = series.priceToCoordinate(z.low);
        if (yHigh == null || yLow == null) continue;
        const top = Math.round(Math.min(yHigh, yLow) * vr);
        const height = Math.max(Math.round(2 * vr), Math.round(Math.abs(yLow - yHigh) * vr));
        if (top + height < 0 || top > bitmapSize.height) continue;
        const fromX = z.from != null && timeScale ? timeScale.timeToCoordinate(z.from) : null;
        const x0 = fromX != null ? Math.max(0, Math.round(fromX * hr)) : 0;
        const w = bitmapSize.width - x0;
        const edge = Math.max(1, Math.round(vr));
        if (!z.outline) {
          ctx.fillStyle = rgba(z.color, z.alpha);
          ctx.fillRect(x0, top, w, height);
        }
        ctx.fillStyle = rgba(z.color, Math.min(1, z.alpha * (z.outline ? 1 : 2.2)));
        if (z.dash?.length) {
          ctx.strokeStyle = ctx.fillStyle;
          ctx.lineWidth = edge;
          ctx.setLineDash(z.dash.map((d) => d * hr));
          for (const y of [top + edge / 2, top + height - edge / 2]) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(bitmapSize.width, y); ctx.stroke(); }
          ctx.setLineDash([]);
        } else {
          ctx.fillRect(x0, top, w, edge);
          ctx.fillRect(x0, top + height - edge, w, edge);
          if (z.outline) { ctx.fillRect(x0, top, edge, height); ctx.fillRect(bitmapSize.width - edge, top, edge, height); }
        }
        if (!anchored && top - lastLabel >= Math.round(13 * vr)) {
          ctx.fillStyle = rgba(z.color, 0.95);
          ctx.fillText(z.label, Math.round(6 * hr), top - Math.round(2 * vr));
          lastLabel = top;
        }
      }
      ctx.restore();
    });
  }
}

class ZonesPaneView implements ISeriesPrimitivePaneView {
  private readonly r: ZonesRenderer;
  constructor(owner: ZonesPrimitive) { this.r = new ZonesRenderer(owner); }
  zOrder() { return "bottom" as const; }
  renderer() { return this.r; }
}

/**
 * Key Level Agent zones as horizontal bands behind the candles (owner request 2026-11-06:
 * "can the zones be drawn on the chart"). A lightweight-charts series primitive. With `mode` "anchored" (the
 * Intelligence charts) each label sits next to its own band, inside the plot, clear of the labels before it in the
 * list (placeLabel): the caller lists the zones in the order their labels have the first pick.
 */
export class ZonesPrimitive implements ISeriesPrimitive<Time> {
  zones: ChartZone[] = [];
  series: ISeriesApi<SeriesType> | null = null;
  chart: SeriesAttachedParameter<Time>["chart"] | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new ZonesPaneView(this)];
  constructor(readonly mode: LabelMode = "first") {}
  attached(p: SeriesAttachedParameter<Time>): void { this.series = p.series; this.chart = p.chart; this.requestUpdate = p.requestUpdate; }
  detached(): void { this.series = null; this.chart = null; this.requestUpdate = null; }
  paneViews() { return this.views; }
  updateAllViews(): void { /* coordinates are read at draw time */ }
  setZones(zones: ChartZone[]): void { this.zones = zones; this.requestUpdate?.(); }
}
