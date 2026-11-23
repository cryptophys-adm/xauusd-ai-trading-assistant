import type { ISeriesPrimitive, ISeriesPrimitiveAxisView, ISeriesPrimitivePaneRenderer, ISeriesPrimitivePaneView, SeriesAttachedParameter, Time, ISeriesApi, SeriesType } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { Box } from "./zones-primitive";
import { T, rgba, tagText } from "./tokens";

/**
 * One line on an Intelligence chart (Track C3, components/IntelChart.tsx): a pattern's boundary from one bar to another
 * (sloped), or a level from a bar (or the left edge) to the right edge.
 * - `from`/`to`: the bars' times (a candle's open time); none is the plot's left or right edge;
 * - `p0`/`p1`: the prices at `from` and `to` (the same for a level);
 * - `label` with `text` (its colour, default the line's) placed at the line's start ("start", a pattern's name) or beside
 *   the level as a band's label ("level"); labels pick their spot in list order, clear of the ones before;
 * - `tag`: a price tag on the price axis in the line's colour (the plan's lines only, an opt-in of IntelChart).
 */
export type ChartLine = {
  from?: Time | null; to?: Time | null; p0: number; p1: number;
  color: string; alpha?: number; width?: number; dash?: number[];
  label?: string; text?: string; place?: "start" | "level"; tag?: boolean;
};

const hit = (a: Box, b: Box) => !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0);

/** Pure: the first spot of `spots` (baseline-left points) clear of `placed`, inside the plot; else the first that fits. */
export function firstClear(spots: { x: number; y: number }[], w: number, fs: number, width: number, height: number, placed: Box[]): { x: number; y: number; box: Box } | null {
  let first: { x: number; y: number; box: Box } | null = null;
  for (const s of spots) {
    const x = Math.max(3, Math.min(s.x, width - 3 - w));
    const box = { x0: x - 1, y0: s.y - fs - 1, x1: x + w + 1, y1: s.y + 0.3 * fs + 1 };
    if (box.y0 < 0 || box.y1 > height) continue;
    const spot = { x, y: s.y, box };
    if (!first) first = spot;
    if (!placed.some((p) => hit(p, box))) return spot;
  }
  return first;
}

class LinesRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(private readonly owner: LinesPrimitive) {}
  draw(target: CanvasRenderingTarget2D): void {
    const series = this.owner.series, ts = this.owner.chart?.timeScale();
    if (!series || !ts || !this.owner.lines.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      const W = mediaSize.width, H = mediaSize.height;
      const fs = W < 480 ? 9 : 10;
      const xOf = (t: Time | null | undefined, edge: number) => (t == null ? edge : ts.timeToCoordinate(t));
      const drawn: { l: ChartLine; x0: number; y0: number; x1: number; y1: number }[] = [];
      for (const l of this.owner.lines) {
        const x0 = xOf(l.from, 0), x1 = xOf(l.to, W);
        const y0 = series.priceToCoordinate(l.p0), y1 = series.priceToCoordinate(l.p1);
        if (x0 == null || x1 == null || y0 == null || y1 == null) continue;
        ctx.strokeStyle = rgba(l.color, l.alpha ?? 0.95);
        ctx.lineWidth = l.width ?? 1.5;
        ctx.setLineDash(l.dash ?? []);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        drawn.push({ l, x0, y0, x1, y1 });
      }
      ctx.setLineDash([]);
      ctx.font = `${fs}px ui-monospace, JetBrains Mono, monospace`;
      ctx.textBaseline = "alphabetic";
      const placed: Box[] = [];
      for (const { l, x0, y0, x1, y1 } of drawn) {
        if (!l.label) continue;
        const w = ctx.measureText(l.label).width;
        const left = Math.min(x0, x1), top = Math.min(y0, y1), bottom = Math.max(y0, y1);
        const spots = l.place === "start"
          ? [{ x: x0, y: y0 - 5 }, { x: x0, y: y0 + fs + 3 }, { x: x0 - w - 4, y: y0 - 5 }, { x: x0 - w - 4, y: y0 + fs + 3 }, { x: x0, y: y0 - fs - 8 }, { x: x0, y: y0 + 2 * fs + 6 }]
          : [top - 3, bottom + fs + 1].flatMap((y) => [left + 4, W - 6 - w, Math.max(W * 0.35, left + 4), Math.max(W * 0.6, left + 4), Math.max(W * 0.15, left + 4)].map((x) => ({ x, y })));
        const spot = firstClear(spots, w, fs, W, H, placed);
        // A plan line's label is always drawn; another line's only where it is clear of the labels before it.
        if (!spot || (!l.tag && placed.some((p) => hit(p, spot.box)))) continue;
        placed.push(spot.box);
        ctx.lineWidth = 3;
        ctx.strokeStyle = T.ground;
        ctx.strokeText(l.label, spot.x, spot.y);
        ctx.fillStyle = l.text ?? l.color;
        ctx.fillText(l.label, spot.x, spot.y);
      }
      ctx.restore();
    });
  }
}

class LinesPaneView implements ISeriesPrimitivePaneView {
  private readonly r: LinesRenderer;
  constructor(owner: LinesPrimitive) { this.r = new LinesRenderer(owner); }
  zOrder() { return "normal" as const; }
  renderer() { return this.r; }
}

/** A line's price tag on the axis: its price on the line's colour, the text dark or white as reads better. */
class TagView implements ISeriesPrimitiveAxisView {
  y = 0;
  constructor(private readonly owner: LinesPrimitive, readonly line: ChartLine) {}
  update(): void { this.y = this.owner.series?.priceToCoordinate(this.line.p0) ?? -100; }
  coordinate(): number { return this.y; }
  text(): string { return this.owner.format(this.line.p0); }
  textColor(): string { return tagText(this.line.color); }
  backColor(): string { return (this.line.alpha ?? 1) < 0.6 ? rgba(this.line.color, 0.55) : this.line.color; }
  visible(): boolean { return true; }
  tickVisible(): boolean { return true; }
}

/**
 * The Intelligence charts' lines (Track C3): pattern boundaries, measured targets and, when a page opts in, the plan's
 * lines with their price tags. A lightweight-charts series primitive drawn above the candles; labels carry a dark halo.
 */
export class LinesPrimitive implements ISeriesPrimitive<Time> {
  lines: ChartLine[] = [];
  series: ISeriesApi<SeriesType> | null = null;
  chart: SeriesAttachedParameter<Time>["chart"] | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views = [new LinesPaneView(this)];
  private tags: TagView[] = [];
  constructor(readonly format: (p: number) => string) {}
  attached(p: SeriesAttachedParameter<Time>): void { this.series = p.series; this.chart = p.chart; this.requestUpdate = p.requestUpdate; }
  detached(): void { this.series = null; this.chart = null; this.requestUpdate = null; }
  paneViews() { return this.views; }
  priceAxisViews() { return this.tags; }
  updateAllViews(): void { for (const t of this.tags) t.update(); }
  setLines(lines: ChartLine[]): void {
    this.lines = lines;
    this.tags = lines.filter((l) => l.tag).map((l) => new TagView(this, l));
    this.requestUpdate?.();
  }
}
