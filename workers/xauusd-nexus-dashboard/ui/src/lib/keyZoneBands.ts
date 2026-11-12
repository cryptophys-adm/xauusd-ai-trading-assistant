import type {
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

/**
 * The War Room's key-level zones on the Omega chart as transparent blocks, not lines (owner 2026-11-12: "ubah key
 * level di chart omega menjadi block zone transparans, jangan berupa garis supaya tidak ambigu dengan garis posisi").
 * A series primitive (lightweight-charts 4.1+) draws each zone as a translucent band from its low to its high across
 * the pane, behind the candles, with a small label above it (role, strength, price range); it draws no price line and
 * no axis label, so the lines on
 * the chart stay the bid, ask, plan and positions only.
 */
export interface ZoneBand {
  low: number;
  high: number;
  /** "rgba(...)" fill, already translucent. */
  fill: string;
  /** Label colour (opaque enough to read). */
  text: string;
  label: string;
}

/** A zone thinner than this (CSS px) is still drawn this tall, so a single-price zone stays visible. */
const MIN_HEIGHT_PX = 3;
/** The labels' backing: the chart's background, nearly opaque. */
const LABEL_BACKING = "rgba(6, 10, 18, 0.78)";

export class KeyZoneBands implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private zones: ZoneBand[] = [];
  private readonly bandView: ISeriesPrimitivePaneView;
  private readonly labelView: ISeriesPrimitivePaneView;
  private readonly views: readonly ISeriesPrimitivePaneView[];

  constructor() {
    // Two views: the bands at the bottom (behind the candles), the labels on top on a dark backing, so a candle
    // never hides them. A view's zOrder places both its draw and drawBackground, hence one view per layer.
    const bands: ISeriesPrimitivePaneRenderer = { draw: (target: CanvasRenderingTarget2D) => this.drawZones(target) };
    const labels: ISeriesPrimitivePaneRenderer = { draw: (target: CanvasRenderingTarget2D) => this.drawLabels(target) };
    this.bandView = { zOrder: () => "bottom", renderer: () => bands };
    this.labelView = { zOrder: () => "top", renderer: () => labels };
    this.views = [this.bandView, this.labelView];
  }

  attached({ series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = null;
  }

  setZones(zones: ZoneBand[]): void {
    this.zones = zones;
    this.requestUpdate?.();
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this.views;
  }

  private drawZones(target: CanvasRenderingTarget2D): void {
    const series = this.series;
    if (!series || !this.zones.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vpr, horizontalPixelRatio: hpr }) => {
      for (const z of this.zones) {
        const yHigh = series.priceToCoordinate(z.high);
        const yLow = series.priceToCoordinate(z.low);
        if (yHigh === null || yLow === null) continue;
        let top = Math.min(yHigh, yLow);
        let height = Math.abs(yLow - yHigh);
        if (height < MIN_HEIGHT_PX) {
          top -= (MIN_HEIGHT_PX - height) / 2;
          height = MIN_HEIGHT_PX;
        }
        const y = Math.round(top * vpr);
        const h = Math.max(1, Math.round(height * vpr));
        if (y > bitmapSize.height || y + h < 0) continue;
        ctx.fillStyle = z.fill;
        ctx.fillRect(0, y, bitmapSize.width, h);
      }
    });
  }

  /** Each zone's label just above its top edge (owner 2026-11-12: "label rentang harga juga ditampilkan di atas zone"). */
  private drawLabels(target: CanvasRenderingTarget2D): void {
    const series = this.series;
    if (!series || !this.zones.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio: vpr, horizontalPixelRatio: hpr }) => {
      ctx.font = `${Math.round(9.5 * vpr)}px ui-monospace, JetBrains Mono, monospace`;
      ctx.textBaseline = "bottom";
      for (const z of this.zones) {
        if (!z.label) continue;
        const yHigh = series.priceToCoordinate(z.high);
        const yLow = series.priceToCoordinate(z.low);
        if (yHigh === null || yLow === null) continue;
        let top = Math.min(yHigh, yLow);
        const height = Math.abs(yLow - yHigh);
        if (height < MIN_HEIGHT_PX) top -= (MIN_HEIGHT_PX - height) / 2;
        const baseline = Math.round(top * vpr) - Math.round(1 * vpr);
        const x = Math.round(6 * hpr);
        const lineH = Math.round(12 * vpr);
        if (baseline < 0 || baseline - lineH > bitmapSize.height) continue;
        const w = Math.ceil(ctx.measureText(z.label).width) + Math.round(6 * hpr);
        ctx.fillStyle = LABEL_BACKING;
        ctx.fillRect(x - Math.round(3 * hpr), baseline - lineH, w, lineH);
        ctx.fillStyle = z.text;
        ctx.fillText(z.label, x, baseline);
      }
    });
  }
}
