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
 * the pane, behind the candles, with a small label inside; it draws no price line and no axis label, so the lines on
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

export class KeyZoneBands implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private zones: ZoneBand[] = [];
  private readonly view: ISeriesPrimitivePaneView;

  constructor() {
    const renderer: ISeriesPrimitivePaneRenderer = {
      // Behind the candles: drawBackground runs before the series is drawn.
      draw: () => {},
      drawBackground: (target: CanvasRenderingTarget2D) => this.drawZones(target),
    };
    this.view = { zOrder: () => "bottom", renderer: () => renderer };
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
    return [this.view];
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
        if (z.label) {
          ctx.fillStyle = z.text;
          ctx.font = `${Math.round(9.5 * vpr)}px ui-monospace, JetBrains Mono, monospace`;
          // Inside a band tall enough for it, else just above a thin one.
          ctx.textBaseline = height >= 12 ? "top" : "bottom";
          ctx.fillText(z.label, Math.round(6 * hpr), height >= 12 ? y + Math.round(1.5 * vpr) : y - Math.round(1 * vpr));
        }
      }
    });
  }
}
