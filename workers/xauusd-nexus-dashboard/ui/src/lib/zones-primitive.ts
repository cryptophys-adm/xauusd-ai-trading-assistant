import type { ISeriesPrimitive, ISeriesPrimitivePaneRenderer, ISeriesPrimitivePaneView, SeriesAttachedParameter, Time, ISeriesApi, SeriesType } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

/** One horizontal band on the chart: a Key Level Agent zone. */
export type ChartZone = { low: number; high: number; color: string; alpha: number; label: string };

const rgba = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

class ZonesRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(private readonly owner: ZonesPrimitive) {}
  draw(): void { /* the bands are drawn behind the candles, in drawBackground */ }
  drawBackground(target: CanvasRenderingTarget2D): void {
    const series = this.owner.series;
    if (!series || !this.owner.zones.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      ctx.save();
      ctx.font = `${Math.round(10 * vr)}px ui-monospace, JetBrains Mono, monospace`;
      ctx.textBaseline = "bottom";
      // Labels only where there is room: zones close together share the first label.
      let lastLabel = -Infinity;
      const zones = [...this.owner.zones].sort((a, b) => b.high - a.high);
      for (const z of zones) {
        const yHigh = series.priceToCoordinate(z.high), yLow = series.priceToCoordinate(z.low);
        if (yHigh == null || yLow == null) continue;
        const top = Math.round(Math.min(yHigh, yLow) * vr);
        const height = Math.max(Math.round(2 * vr), Math.round(Math.abs(yLow - yHigh) * vr));
        if (top + height < 0 || top > bitmapSize.height) continue;
        ctx.fillStyle = rgba(z.color, z.alpha);
        ctx.fillRect(0, top, bitmapSize.width, height);
        ctx.fillStyle = rgba(z.color, Math.min(1, z.alpha * 2.2));
        ctx.fillRect(0, top, bitmapSize.width, Math.max(1, Math.round(vr)));
        ctx.fillRect(0, top + height - Math.max(1, Math.round(vr)), bitmapSize.width, Math.max(1, Math.round(vr)));
        if (top - lastLabel >= Math.round(13 * vr)) {
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
 * "can the zones be drawn on the chart"). A lightweight-charts series primitive.
 */
export class ZonesPrimitive implements ISeriesPrimitive<Time> {
  zones: ChartZone[] = [];
  series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new ZonesPaneView(this)];
  attached(p: SeriesAttachedParameter<Time>): void { this.series = p.series; this.requestUpdate = p.requestUpdate; }
  detached(): void { this.series = null; this.requestUpdate = null; }
  paneViews() { return this.views; }
  updateAllViews(): void { /* coordinates are read at draw time */ }
  setZones(zones: ChartZone[]): void { this.zones = zones; this.requestUpdate?.(); }
}
