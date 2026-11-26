import type { ISeriesPrimitive, ISeriesPrimitivePaneRenderer, ISeriesPrimitivePaneView, SeriesAttachedParameter, Time, ISeriesApi, SeriesType } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { firstClear } from "./lines-primitive";
import type { Box } from "./zones-primitive";
import { T, rgba } from "./tokens";

/**
 * One opening range on an Intelligence chart (Track C4, components/IntelChart.tsx), as the owner-approved mockup draws
 * it:
 * - the box over the range's bars, from the first bar `from` to the last `to` (candle open times), between `high` and
 *   `low`: an fg-2 outline on the track fill;
 * - its two edges dashed from the box to the bar `until` (the window's last bar, or the last candle when the window
 *   ends after it), the broken edge in its breakout colour (`broken` "high" or "low" with `brokenColor`), the other
 *   grey; the midpoint dotted;
 * - `label` beside the box ("London · to 11:45 NY": its end time), clear of the labels before it.
 * `alpha` dims the whole drawing (a stale read).
 */
export type ChartBox = {
  from: Time; to: Time; until: Time; high: number; low: number; mid: number | null;
  label: string; broken?: "high" | "low" | null; brokenColor?: string; alpha?: number;
};

/** The edge and box colours: the text colour fg-2 for the outline and the unbroken edges, the track for the fill. */
const OUTLINE = T.fg2;
const FILL = T.track;

/** Pure: where a box's label goes: left of its top edge, else above it at its left or right, else below it. */
export function boxLabelSpots(x0: number, x1: number, top: number, bottom: number, w: number, fs: number): { x: number; y: number }[] {
  return [{ x: x0 - w - 6, y: top + fs - 1 }, { x: x1 - w, y: top - 5 }, { x: x0, y: top - 5 }, { x: x0, y: bottom + fs + 3 }, { x: x1 - w, y: bottom + fs + 3 }];
}

type Geo = { b: ChartBox; x0: number; x1: number; xe: number; yh: number; yl: number; ym: number | null; a: number };

class BoxesRenderer implements ISeriesPrimitivePaneRenderer {
  /** `labels`: this renderer draws the labels (above the candles); else the boxes (behind them). */
  constructor(private readonly owner: BoxesPrimitive, private readonly labels: boolean) {}
  /** Each box's coordinates in the pane (CSS pixels); a box out of the candles is left out. */
  private geometry(): Geo[] {
    const series = this.owner.series, ts = this.owner.chart?.timeScale();
    if (!series || !ts) return [];
    const half = Math.max(1, ts.options().barSpacing / 2);
    const out: Geo[] = [];
    for (const b of this.owner.boxes) {
      const xa = ts.timeToCoordinate(b.from), xb = ts.timeToCoordinate(b.to), xu = ts.timeToCoordinate(b.until);
      const yh = series.priceToCoordinate(b.high), yl = series.priceToCoordinate(b.low);
      if (xa == null || xb == null || yh == null || yl == null) continue;
      const x1 = xb + half;
      out.push({ b, x0: xa - half, x1, xe: xu == null ? x1 : Math.max(x1, xu + half), yh, yl, ym: b.mid == null ? null : series.priceToCoordinate(b.mid), a: b.alpha ?? 1 });
    }
    return out;
  }
  /** The labels, above the candles, each with a dark halo. */
  draw(target: CanvasRenderingTarget2D): void {
    if (!this.labels || !this.owner.boxes.length) return;
    const geo = this.geometry();
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      const W = mediaSize.width, H = mediaSize.height;
      const fs = W < 480 ? 9 : 10;
      ctx.font = `${fs}px ui-monospace, JetBrains Mono, monospace`;
      ctx.textBaseline = "alphabetic";
      const placed: Box[] = [];
      for (const { b, x0, x1, yh, yl, a } of geo) {
        if (!b.label) continue;
        const w = ctx.measureText(b.label).width;
        const spot = firstClear(boxLabelSpots(x0, x1, Math.min(yh, yl), Math.max(yh, yl), w, fs), w, fs, W, H, placed);
        if (!spot) continue;
        placed.push(spot.box);
        ctx.lineWidth = 3;
        ctx.strokeStyle = T.ground;
        ctx.strokeText(b.label, spot.x, spot.y);
        ctx.fillStyle = rgba(T.fg, a);
        ctx.fillText(b.label, spot.x, spot.y);
      }
      ctx.restore();
    });
  }
  /** The boxes, their edges and midpoints, behind the candles. */
  drawBackground(target: CanvasRenderingTarget2D): void {
    if (this.labels || !this.owner.boxes.length) return;
    const geo = this.geometry();
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.save();
      for (const { b, x0, x1, xe, yh, yl, ym, a } of geo) {
        const top = Math.min(yh, yl), bottom = Math.max(yh, yl);
        ctx.globalAlpha = a;
        ctx.fillStyle = FILL;
        ctx.fillRect(x0, top, x1 - x0, bottom - top);
        ctx.strokeStyle = rgba(OUTLINE, 0.9);
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.strokeRect(Math.round(x0) + 0.5, Math.round(top) + 0.5, Math.round(x1 - x0), Math.round(bottom - top));
        // The edges and the midpoint, from the box to the window's last bar (or the last candle).
        if (xe > x1) {
          const edge = (y: number, color: string, alpha: number, dash: number[]) => {
            ctx.strokeStyle = rgba(color, alpha);
            ctx.setLineDash(dash);
            ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(xe, y); ctx.stroke();
          };
          edge(yh, b.broken === "high" && b.brokenColor ? b.brokenColor : OUTLINE, b.broken === "high" ? 0.95 : 0.75, [5, 4]);
          edge(yl, b.broken === "low" && b.brokenColor ? b.brokenColor : OUTLINE, b.broken === "low" ? 0.95 : 0.75, [5, 4]);
          if (ym != null) edge(ym, OUTLINE, 0.6, [1, 3]);
        }
      }
      ctx.restore();
    });
  }
}

/** The boxes behind the candles ("bottom"), their labels above them ("top"). */
class BoxesPaneView implements ISeriesPrimitivePaneView {
  private readonly r: BoxesRenderer;
  constructor(owner: BoxesPrimitive, private readonly labels: boolean) { this.r = new BoxesRenderer(owner, labels); }
  zOrder() { return this.labels ? ("top" as const) : ("bottom" as const); }
  renderer() { return this.r; }
}

/**
 * The opening ranges as boxes behind the candles (Track C4): a lightweight-charts series primitive, its boxes drawn below
 * the candles and its labels above them in a dark halo. No price tag of its own: the plan's lines carry the tags (lines-primitive.ts).
 */
export class BoxesPrimitive implements ISeriesPrimitive<Time> {
  boxes: ChartBox[] = [];
  series: ISeriesApi<SeriesType> | null = null;
  chart: SeriesAttachedParameter<Time>["chart"] | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new BoxesPaneView(this, false), new BoxesPaneView(this, true)];
  attached(p: SeriesAttachedParameter<Time>): void { this.series = p.series; this.chart = p.chart; this.requestUpdate = p.requestUpdate; }
  detached(): void { this.series = null; this.chart = null; this.requestUpdate = null; }
  paneViews() { return this.views; }
  updateAllViews(): void { /* coordinates are read at draw time */ }
  setBoxes(boxes: ChartBox[]): void { this.boxes = boxes; this.requestUpdate?.(); }
}
