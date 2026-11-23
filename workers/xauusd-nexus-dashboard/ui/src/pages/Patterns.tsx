import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CandlestickChart, Cpu, Info, LineChart, Puzzle, Shapes } from "lucide-react";
import clsx from "clsx";
import { Badge, Empty, Panel, PollBody } from "../components/ui";
import IntelChart, { type IntelBar, type IntelMarker } from "../components/IntelChart";
import type { ChartZone } from "../lib/zones-primitive";
import type { ChartLine } from "../lib/lines-primitive";
import { usePoll, type Poll } from "../lib/usePoll";
import { PLAN_TICK_MS, localNow, markKey, planMark } from "../lib/pollState";
import { T, rgba, type Tone } from "../lib/tokens";
import {
  CHART_PATTERNS_READS, PATTERN_BREAKER_MIN, RECORD_RULES, SEAT_RULES, TF_KEYS, TF_LABEL, TF_ROOM, ageText, arr, atrFrom, clockPair, intelGet,
  marketClosedAt, nextOpenMs, num, nyClock, obj, openText, pc, price, priceRange, signed, snapToCandle, str, tfKey, words, type TfKey
} from "../lib/intel";
import { PATTERN_AGENT_CHARTS, agentLabel, planNotes } from "../lib/patternRules";

// Chart patterns (Intelligence, Track C3; owner 2026-11-22: "ketiganya dibuat panel visualisasi sendiri terpisah dalam
// Intelligence"), as the owner-approved mockup: the Projection Agent's chart patterns on the 15m, 1H, 4H and 1D charts,
// their measured record, its seat in the rooms and the pattern agents that trade them. Read-only. Three reads, each
// polled once (lib/intel.ts CHART_PATTERNS_READS, GET only): /api/chart-patterns (cryptophys.chart-patterns-view.v1,
// backend B9: the candles are its own 60 closed bars per chart and "armed" is its decision.trade_agent), the strategy
// agents (/api/strategy-agents) and the neuron allocation (/api/neuron-allocation, the seat per room).
//
// PatternsView is pure and null-safe (the page render check renders it over test/fixtures/nexus-intel/chart-patterns.json
// and its variants). A field a later backend PR fills (held, breakout_bars_ago, bars_since_breakout, horizon_bars,
// bars_left, seat.horizon_bars, plan.reach) is null until then and shows an Empty "Filled by a later backend PR",
// never an error.
//
// Prices: every one is the feed's (scale.prices "feed") and says so. TP1-KZ2: a pattern's measured target is a far
// target; "TP2" names only a plan's own tp2. A plan's lines (its entry zone, Entry, Stop, TP1, TP2) are drawn only on
// the chart of the plan's own pattern, through IntelChart's opt-in `plan`; the other charts point to it.

export const SCHEMA = "cryptophys.chart-patterns-view.v1";
/** A stale read's lines: dimmed to this share of their strength, their labels kept readable (PriceChart's planMark). */
const DIM = 0.45;
const LATER = "Filled by a later backend PR.";

export type Mark = ReturnType<typeof planMark>;
const LIVE: Mark = { show: true, dim: false, suffix: "", note: null };

/** A /api/chart-patterns body with a view in it. */
export const patternsReady = (d: any): boolean => d != null && typeof d === "object" && (d.status === "ok" || d.schema === SCHEMA) && d.status !== "not_found";
/** The AI Worker's answer while INTEL_VIEWS is off. */
export const intelViewsOff = (d: any): boolean => d?.status === "not_found" && d?.reason === "intel_views_off";

// ---------------------------------------------------------------- direction, prices and plans

type Dir = 1 | -1 | 0;
const dirOf = (x: unknown): Dir => (x === 1 ? 1 : x === -1 ? -1 : 0);
const GLYPH: Record<Dir, string> = { 1: "▲", [-1]: "▼", 0: "·" } as Record<Dir, string>;
const DIR_TEXT: Record<Dir, string> = { 1: "text-bull", [-1]: "text-bear", 0: "text-neutral" } as Record<Dir, string>;
const DIR_FILL: Record<Dir, string> = { 1: T.bullFill, [-1]: T.bearFill, 0: T.neutralFill } as Record<Dir, string>;
const DIR_COLOR: Record<Dir, string> = { 1: T.bull, [-1]: T.bear, 0: T.neutral } as Record<Dir, string>;
const DIR_WORD: Record<Dir, string> = { 1: "▲ up", [-1]: "▼ down", 0: "· not yet" } as Record<Dir, string>;
/** Two prices the same to the cent. */
const same = (a: unknown, b: unknown): boolean => num(a) && num(b) && Math.abs(a - b) < 0.005;
/** A plan's side: BUY 1, SELL −1 (B9 keeps the plan's own side). */
export const sideOf = (plan: any): Dir => (plan?.side === "BUY" ? 1 : plan?.side === "SELL" ? -1 : 0);
const sideWord = (s: Dir) => (s === 1 ? "▲ long" : s === -1 ? "▼ short" : "· no side");
/** An R multiple, one decimal: "1.4R". */
const rText = (x: unknown): string | null => (num(x) ? `${x.toFixed(1)}R` : null);
const nameOf = (p: any) => str(p?.name) ?? words(p?.id);

/** One agent plan of the latest decision, with its pattern and chart. */
export type PlanRow = { tf: TfKey; pattern: any; plan: any; armed: boolean };

/** Every pattern agent plan in the view (patterns[].plan), armed: the latest decision's trade agent. */
export function plansOf(d: any): PlanRow[] {
  const agent = str(d?.decision?.trade_agent);
  const out: PlanRow[] = [];
  for (const p of arr(d?.patterns)) {
    const tf = tfKey(p?.tf), plan = obj(p?.plan);
    if (!tf || !plan || !num(plan.entry) || !num(plan.stop)) continue;
    out.push({ tf, pattern: p, plan, armed: agent != null && plan.agent === agent });
  }
  return out;
}
/** The plan whose lines a chart draws: the armed one first, then a live one, then the first. */
export function leadPlan(rows: PlanRow[], tf: TfKey): PlanRow | null {
  const on = rows.filter((r) => r.tf === tf);
  return on.find((r) => r.armed) ?? on.find((r) => r.plan.status === "live") ?? on[0] ?? null;
}
/** The tab the page opens on: the chart of the armed plan, else of a plan, else 15m. */
export function defaultTab(d: any): TfKey {
  const rows = plansOf(d);
  return (rows.find((r) => r.armed) ?? rows[0])?.tf ?? "15";
}

/** A chart's whole candles, oldest first (the view's own closed bars). */
export function chartBars(d: any, tf: TfKey): IntelBar[] {
  return arr(d?.charts?.[tf]?.ohlcv).filter((b) => num(b?.time) && num(b?.open) && num(b?.high) && num(b?.low) && num(b?.close))
    .map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })).sort((a, b) => a.time - b.time);
}
const INTERVAL: Record<TfKey, number> = { "15": 900, "60": 3_600, "240": 14_400, D: 86_400 };
const intervalOf = (d: any, tf: TfKey) => (num(d?.charts?.[tf]?.interval_s) ? d.charts[tf].interval_s : INTERVAL[tf]);

// ---------------------------------------------------------------- the chart's lines (pure)

/**
 * The opt-in plan lines of a chart's lead plan (IntelChart `plan`): Entry (ok), Stop (bear, dashed), TP1 (bull, dashed)
 * and TP2 (bull, dotted), each labelled and tagged with its price; and the entry zone as a band behind the candles. "TP2"
 * is the plan's tp2 only; it names the measured target when the two are the same price.
 */
export function planDrawing(row: PlanRow | null, mark: Mark): { lines: ChartLine[]; band: ChartZone[]; fit: number[] } {
  if (!row || !mark.show) return { lines: [], band: [], fit: [] };
  const { plan, pattern } = row;
  const a = mark.dim ? DIM : 0.95, sfx = mark.suffix;
  const notes = planNotes(plan.agent, plan.at_level);
  const lines: ChartLine[] = [];
  const add = (p: unknown, label: string, color: string, text: string, dash?: number[]) => { if (num(p)) lines.push({ p0: p, p1: p, color, alpha: a, width: 1.2, dash, label: label + sfx, text, place: "level" }); };
  add(plan.entry, notes.entry, T.okFill, T.ok);
  add(plan.stop, "Stop", T.bearFill, T.bear, [5, 4]);
  add(plan.tp1, ["TP1", rText(plan.rrr?.tp1)].filter(Boolean).join(" "), T.bullFill, T.bull, [5, 4]);
  add(plan.tp2, [["TP2", rText(plan.rrr?.tp2)].filter(Boolean).join(" "), same(plan.tp2, plan.far_target) ? `measured target · ${nameOf(pattern)}` : null].filter(Boolean).join(" · "), T.bullFill, T.bull, [2, 3]);
  const band: ChartZone[] = num(plan.entry_low) && num(plan.entry_high) && plan.entry_low <= plan.entry_high
    ? [{ low: plan.entry_low, high: plan.entry_high, color: T.okFill, alpha: (mark.dim ? DIM : 1) * 0.12, label: "" }] : [];
  const fit = [plan.entry, plan.stop, plan.tp1, plan.tp2, plan.entry_low, plan.entry_high].filter(num);
  return { lines, band, fit };
}

/**
 * A chart's pattern lines: each pattern's two boundaries from line_from to line_to (each close time snapped to its
 * candle, not drawn outside the candles), in its direction's colour (forming dashed amber, busted grey); its measured
 * target dotted from its last turn to the right edge ("measured target · <name>"), a forming pattern's two faint
 * ("measured target if up", "if down"). The lead plan's own TP2 line carries its pattern's measured target. A later
 * backend PR's breakout bar is a circle; a held line says so with its bars left.
 */
export function patternDrawing(d: any, tf: TfKey, bars: IntelBar[], lead: PlanRow | null, mark: Mark): { lines: ChartLine[]; markers: IntelMarker[]; fit: number[] } {
  if (!mark.show || !bars.length) return { lines: [], markers: [], fit: [] };
  const times = bars.map((b) => b.time), iv = intervalOf(d, tf), raw = arr(d?.charts?.[tf]?.ohlcv);
  const k = mark.dim ? DIM : 1, sfx = mark.suffix;
  const lines: ChartLine[] = [], targets: ChartLine[] = [], markers: IntelMarker[] = [], fit: number[] = [];
  const groups: { price: number; names: string[]; from: number | null; color: string; text: string; busted: boolean }[] = [];
  // Busted first: the live patterns' lines draw over them.
  const list = arr(d?.patterns).filter((p) => p?.tf === tf).sort((a, b) => Number(b?.status === "busted") - Number(a?.status === "busted"));
  for (const p of list) {
    const dir = dirOf(p.direction), busted = p.status === "busted", forming = p.status === "forming";
    const fill = busted ? T.offFill : DIR_FILL[dir], text = busted ? T.off : DIR_COLOR[dir];
    const t0 = snapToCandle(p.line_from, times, iv), t1 = snapToCandle(p.line_to, times, iv);
    if (t0 != null && t1 != null && num(p.upper) && num(p.lower)) {
      const held = p.held === true && num(p.bars_left) ? ` · held · ${p.bars_left} bars left` : "";
      const label = `${GLYPH[dir]} ${nameOf(p)}${busted ? " · busted" : ""}${held}${sfx}`;
      const u0 = num(p.upper_from) ? p.upper_from : p.upper, l0 = num(p.lower_from) ? p.lower_from : p.lower;
      lines.push({ from: t0 as any, to: t1 as any, p0: u0, p1: p.upper, color: fill, alpha: 0.95 * k, dash: forming ? [6, 4] : undefined, label, text, place: "start" });
      lines.push({ from: t0 as any, to: t1 as any, p0: l0, p1: p.lower, color: fill, alpha: 0.95 * k, dash: forming ? [6, 4] : undefined });
      fit.push(u0, p.upper, l0, p.lower);
    }
    if (num(p.breakout_bars_ago) && p.breakout_bars_ago >= 0 && p.breakout_bars_ago < times.length) markers.push({ time: times[times.length - 1 - p.breakout_bars_ago], above: dir < 0, color: fill, shape: "circle" });
    if (forming) {
      const from = times[Math.max(0, times.length - 14)];
      for (const [word, tp] of [["if up", p.target_up], ["if down", p.target_down]] as const) {
        if (!num(tp)) continue;
        targets.push({ from: from as any, p0: tp, p1: tp, color: T.neutralFill, alpha: 0.45 * k, width: 1, dash: [2, 3], label: `measured target ${word}${sfx}`, text: T.fg2, place: "level" });
        fit.push(tp);
      }
      continue;
    }
    if (!num(p.far_target)) continue;
    if (lead && lead.pattern === p && same(lead.plan.tp2, p.far_target)) continue;
    const endT = num(p.end_bar) && num(raw[p.end_bar]?.time) && times.includes(raw[p.end_bar].time) ? raw[p.end_bar].time : t0;
    // Patterns with the same measured target share one line: "measured target · triple top and 2 more".
    const twin = groups.find((g) => same(g.price, p.far_target));
    if (twin) { twin.names.push(nameOf(p)); if (!busted && twin.busted) { twin.busted = false; twin.color = fill; twin.text = text; } if (endT != null && (twin.from == null || endT < twin.from)) twin.from = endT; continue; }
    groups.push({ price: p.far_target, names: [nameOf(p)], from: endT ?? null, color: fill, text, busted });
    fit.push(p.far_target);
  }
  for (const g of groups) {
    const names = g.names.length <= 2 ? g.names.join(" · ") : `${g.names[0]} and ${g.names.length - 1} more`;
    targets.push({ from: g.from as any, p0: g.price, p1: g.price, color: g.color, alpha: 0.9 * k, dash: [2, 3], label: `measured target · ${names}${sfx}`, text: g.text, place: "level" });
  }
  return { lines: [...lines, ...targets], markers, fit };
}

// ---------------------------------------------------------------- small pieces

const Muted = ({ children }: { children: ReactNode }) => <span className="text-muted">{children}</span>;
function Kv({ k, children }: { k: ReactNode; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-0.5"><span className="text-[11px] text-muted">{k}</span><span className="mono text-[12px] leading-normal text-slate-300">{children}</span></div>;
}
const tdSans = "border-b border-white/5 px-2 py-2 align-top text-[12px] leading-normal text-slate-300";
const td = `mono ${tdSans}`;
const th = "whitespace-nowrap border-b border-white/10 px-2 py-2 align-bottom text-[11px] font-medium text-muted";
const Note = ({ children }: { children: ReactNode }) => <div className="text-[11px] leading-normal text-muted">{children}</div>;

const STATUS_TONE: Record<string, Tone> = { forming: "plain", confirmed: "ok", busted: "off" };
const PLAN_TONE: Record<string, Tone> = { live: "ok", shadow: "shadow", off: "off" };
const AGENT_TONE: Record<string, Tone> = { live: "ok", shadow: "shadow", suspended: "late", off: "off" };

// ---------------------------------------------------------------- the heading

function Heading({ chips }: { chips?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="flex items-center gap-2.5 text-[20px] font-semibold text-fg"><Shapes className="h-[18px] w-[18px] text-cyan-300" />Chart patterns</h1>
        <span className="text-[11px] text-muted">Intelligence · Projection Agent · 15m, 1H, 4H, 1D</span>
      </div>
      {chips ? <div className="flex flex-wrap items-center gap-1.5">{chips}</div> : null}
      <div className="flex items-start gap-2 text-[12px] leading-normal text-fg-2"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-2" aria-hidden="true" />A plan&apos;s TP1 is the nearest key zone at 1R or more; its TP2 is the measured target when that lies beyond TP1.</div>
    </div>
  );
}

/** Whether any of the later backend PR's horizon fields is filled. */
const horizonOn = (d: any) => num(d?.seat?.horizon_bars) || arr(d?.patterns).some((p) => num(p?.horizon_bars));

function headingChips(d: any, now: number) {
  const computed = Date.parse(String(d?.calibration?.computed_at ?? ""));
  const close = Date.parse(String(d?.decision?.bar_close ?? ""));
  return (
    <>
      <Badge tone={d?.mode === "off" ? "off" : "ok"}>{d?.mode === "off" ? "patterns off" : "patterns on"}</Badge>
      <Badge tone={d?.calibration_mode === "off" ? "off" : "ok"}>{d?.calibration_mode === "off" ? "calibration off" : `calibration ${str(d?.calibration_mode) ?? "auto"}`}</Badge>
      {Number.isFinite(computed) ? <Badge tone="plain">{now >= computed ? `calibrated ${ageText(now - computed)} ago` : `calibrated ${clockPair(computed)}`}</Badge> : null}
      {/* While the horizon is not filled, its Empties say so (OM-LEAN: no chip repeating them). */}
      {horizonOn(d) ? <Badge tone="ok">horizon on</Badge> : null}
      {num(d?.price) ? <Badge tone="plain">price {price(d.price)} · feed scale</Badge> : null}
      {num(d?.atr_h1) ? <Badge tone="plain">ATR (1H) {d.atr_h1.toFixed(2)}</Badge> : null}
      {Number.isFinite(close) ? <Badge tone="plain">decision {clockPair(close)}</Badge> : null}
    </>
  );
}

// ---------------------------------------------------------------- the tabs

function Tabs({ tf, onTab }: { tf: TfKey; onTab?: (tf: TfKey) => void }) {
  return (
    <div role="group" aria-label="Chart" className="inline-flex gap-1">
      {TF_KEYS.map((k) => (
        <button key={k} type="button" aria-pressed={k === tf} onClick={onTab ? () => onTab(k) : undefined} disabled={!onTab}
          className={clsx("mono inline-flex min-h-8 min-w-[44px] items-center justify-center rounded-md border px-2.5 text-[12px] font-semibold", k === tf ? "border-ok-fill/40 bg-ok-fill/10 text-white" : "border-white/10 bg-white/4 text-slate-300 hover:text-white")}>
          {TF_LABEL[k]}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- panel: lines on the chart

const Swatch = ({ style }: { style: CSSProperties }) => <span aria-hidden="true" className="inline-block h-2 w-3 shrink-0" style={style} />;
function LineSwatch({ color, dash }: { color: string; dash?: string }) {
  return <svg aria-hidden="true" width="16" height="8" viewBox="0 0 16 8"><line x1="0" x2="16" y1="4" y2="4" stroke={color} strokeWidth="1.5" strokeDasharray={dash} /></svg>;
}
const Item = ({ swatch, children }: { swatch?: ReactNode; children: ReactNode }) => <span className="inline-flex items-center gap-1.5 whitespace-nowrap">{swatch}{children}</span>;

function Legend({ plan, band, later }: { plan: boolean; band: boolean; later: boolean }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1.5 text-[11px] text-fg-2">
      <Item swatch={<LineSwatch color={T.bullFill} />}><span className="text-bull">▲ up</span></Item>
      <Item swatch={<LineSwatch color={T.bearFill} />}><span className="text-bear">▼ down</span></Item>
      <Item swatch={<LineSwatch color={T.neutralFill} dash="4 3" />}><span className="text-neutral">· forming</span></Item>
      <Item swatch={<LineSwatch color={T.offFill} />}><span className="text-off">busted</span></Item>
      <Item swatch={<LineSwatch color={T.fg2} dash="2 2" />}>measured target</Item>
      <Item swatch={<LineSwatch color={rgba(T.neutralFill, 0.5)} dash="2 2" />}>measured target if up, if down</Item>
      {later ? <Item swatch={<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke={T.fg} strokeWidth="1.5" /></svg>}>breakout</Item> : null}
      {plan && band ? <Item swatch={<Swatch style={{ background: rgba(T.okFill, 0.25) }} />}>entry zone</Item> : null}
      {plan ? (
        <>
          <Item swatch={<LineSwatch color={T.okFill} />}>Entry</Item>
          <Item swatch={<LineSwatch color={T.bearFill} dash="4 3" />}>Stop</Item>
          <Item swatch={<LineSwatch color={T.bullFill} dash="4 3" />}>TP1</Item>
          <Item swatch={<LineSwatch color={T.bullFill} dash="2 2" />}>TP2</Item>
        </>
      ) : null}
    </div>
  );
}

/** A reach of a later backend PR in words; null until then. */
export const REACH: Record<string, string> = { retest: "retest", continuation: "at price (continuation)", beyond: "not traded: out of reach" };

/** The labels of the strategy agents (/api/strategy-agents), else the family rule's. */
const labelOf = (agents: any, id: unknown) => str(arr(agents?.agents).find((a) => a?.id === id)?.label) ?? agentLabel(id);

function PlanBox({ row, agents, drawn }: { row: PlanRow; agents: any; drawn: boolean }) {
  const { plan, pattern, tf } = row;
  const notes = planNotes(plan.agent, plan.at_level);
  const side = sideOf(plan);
  const zone = num(plan.entry_low) && num(plan.entry_high);
  const r1 = rText(plan.rrr?.tp1), r2 = rText(plan.rrr?.tp2);
  return (
    <div className="glass-inner p-3.5">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[12px] font-semibold text-fg">Agent plan</span>
        <span className="text-[12px] text-fg-2">{labelOf(agents, plan.agent)} · {TF_LABEL[tf]} {nameOf(pattern)} · <span className={side === 1 ? "text-bull" : side === -1 ? "text-bear" : "text-neutral"}>{sideWord(side)}</span></span>
        <Badge tone={PLAN_TONE[str(plan.status) ?? ""] ?? "plain"}>{str(plan.status) ?? "no status"}</Badge>
        {row.armed ? <Badge tone="ok">armed</Badge> : null}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
        <Kv k={notes.entry}><span className="text-ok">{price(plan.entry)}</span><br /><Muted>{notes.entryNote}</Muted>{zone ? <><br /><Muted>zone {priceRange(plan.entry_low, plan.entry_high)}</Muted></> : null}</Kv>
        <Kv k="Stop"><span className="text-bear">{price(plan.stop)}</span><br /><Muted>{notes.stopNote}</Muted></Kv>
        <Kv k={r1 ? `TP1 · ${r1}` : "TP1"}><span className="text-bull">{price(plan.tp1)}</span><br /><Muted>zone not available yet</Muted></Kv>
        <Kv k={r2 ? `TP2 · ${r2}` : "TP2"}><span className="text-bull">{price(plan.tp2)}</span><br /><Muted>{same(plan.tp2, plan.far_target) ? "measured target" : "not the measured target"}</Muted></Kv>
      </div>
      {!zone ? <div className="mt-2.5"><Empty when="This plan carries no entry_low or entry_high, so the entry zone cannot be drawn.">No entry zone yet</Empty></div> : null}
      {!drawn ? <div className="mt-2.5"><Note>Its lines are not drawn: a chart draws one plan&apos;s lines, the armed plan first.</Note></div> : null}
      <div className="mt-2.5"><Note>From /api/chart-patterns: the pattern&apos;s plan; armed: the latest decision&apos;s trade agent. Feed scale.</Note></div>
    </div>
  );
}

/** Where the plans' lines are when this chart has none: "The agent plan's lines show on the 1H chart, where its pattern is." */
export function pointerText(rows: PlanRow[]): string {
  const charts = TF_KEYS.filter((k) => rows.some((r) => r.tf === k)).map((k) => TF_LABEL[k]);
  if (charts.length === 1) return `The agent plan's lines show on the ${charts[0]} chart, where its pattern is.`;
  return `The agent plans' lines show on the ${charts.slice(0, -1).join(", ")} and ${charts[charts.length - 1]} charts, where their patterns are.`;
}

function FarTargets({ d, rows }: { d: any; rows: PlanRow[] }) {
  const list = arr(d?.far_targets).filter((f) => num(f?.price) && tfKey(f?.tf));
  const label = (f: any) => {
    const forming = f.status === "forming", dir = dirOf(f.direction);
    const glyph = forming ? "·" : GLYPH[dir];
    const tp2 = rows.some((r) => r.tf === f.tf && r.pattern?.id === f.id && same(r.plan.tp2, f.price));
    return (
      <>
        <span className={forming ? "text-neutral" : DIR_TEXT[dir]}>{glyph} {TF_LABEL[f.tf as TfKey]} {nameOf(f)}{forming ? ` · ${dir === -1 ? "if down" : "if up"}` : ""}</span>
        {tp2 ? <> <Badge tone="plain">TP2 of the plan</Badge></> : null}
      </>
    );
  };
  // Signed from the last price (B9's distance_atr is the distance without its side).
  const dist = (f: any) => { const x = atrFrom(f.price, d?.price, d?.atr_h1); return signed(x ?? (num(f.distance_atr) ? f.distance_atr : null)); };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[12px] font-semibold text-fg">Measured targets, every chart</div>
      {!list.length ? <Empty when="No pattern on any chart has a measured target now.">No measured target</Empty> : (
        <>
          <table className="hidden w-full border-collapse text-left sm:table">
            <thead><tr><th scope="col" className={th}>Measured target</th><th scope="col" className={clsx(th, "text-right")}>Feed scale</th><th scope="col" className={clsx(th, "text-right")}>ATR (1H)</th></tr></thead>
            <tbody>{list.map((f, i) => <tr key={`${f.tf}-${f.id}-${i}`}><td className={td}>{label(f)}</td><td className={clsx(td, "text-right")}>{price(f.price)}</td><td className={clsx(td, "text-right text-fg")}>{dist(f)}</td></tr>)}</tbody>
          </table>
          <table className="w-full border-collapse text-left sm:hidden">
            <thead><tr><th scope="col" className={th}>Measured target</th><th scope="col" className={clsx(th, "text-right")}>Feed scale<br />ATR (1H)</th></tr></thead>
            <tbody>{list.map((f, i) => <tr key={`${f.tf}-${f.id}-${i}`}><td className={clsx(td, "px-1.5")}>{label(f)}</td><td className={clsx(td, "px-1.5 text-right")}>{price(f.price)}<br /><Muted>{dist(f)}</Muted></td></tr>)}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

function ChartPanel({ d, tf, onTab, agents, mark, poll }: { d: any; tf: TfKey; onTab?: (tf: TfKey) => void; agents: any; mark: Mark; poll?: Poll }) {
  const bars = useMemo(() => chartBars(d, tf), [d, tf]);
  const rows = useMemo(() => plansOf(d), [d]);
  const lead = leadPlan(rows, tf);
  const plan = useMemo(() => planDrawing(lead, mark), [lead, mark]);
  const pats = useMemo(() => patternDrawing(d, tf, bars, lead, mark), [d, tf, bars, lead, mark]);
  const fit = useMemo(() => [...plan.fit, ...pats.fit], [plan.fit, pats.fit]);
  const here = rows.filter((r) => r.tf === tf).sort((a, b) => Number(b === lead) - Number(a === lead));
  const later = arr(d?.patterns).some((p) => p?.tf === tf && num(p?.breakout_bars_ago));
  const trade = str(d?.decision?.trade_agent);
  const plans = here.length
    ? here.map((r, i) => <PlanBox key={`${r.plan.agent}-${i}`} row={r} agents={agents} drawn={r === lead} />)
    : rows.length ? <div className="text-[12px] text-fg-2">{pointerText(rows)}</div>
      : <Empty when={trade ? `The latest decision's trade agent (${labelOf(agents, trade)}) has no pattern plan: no Entry, Stop or TP line.` : "The latest decision has no trade agent: no Entry, Stop or TP line."}>No agent plan</Empty>;
  return (
    <Panel title="Lines on the chart" icon={<CandlestickChart className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} live right={<Tabs tf={tf} onTab={onTab} />}>
      <IntelChart poll={poll} bars={bars} zones={plan.band} lines={pats.lines} plan={plan.lines} markers={pats.markers} fit={fit}
        label={`${TF_LABEL[tf]} candles on the feed scale with the chart patterns${plan.lines.length ? " and the agent plan's lines" : ""}`}
        visible={(w) => (w < 520 ? 52 : 60)} timeVisible={tf !== "D"} intervalS={intervalOf(d, tf)}
        emptyTitle={`No ${TF_LABEL[tf]} candles yet`} emptyWhen="The chart's closed bars come with /api/chart-patterns every 2 minutes." />
      {bars.length ? <Legend plan={plan.lines.length > 0} band={plan.band.length > 0} later={later} /> : null}
      <div className="mt-3 flex flex-col gap-3">
        {plans}
        <FarTargets d={d} rows={rows} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- panel: patterns on this chart

function recCell(r: any) {
  const x = obj(r);
  if (!x || !num(x.rate) || !num(x.n)) return <Muted>—</Muted>;
  return <>{pc(x.rate)} of {x.n}<br />{x.active === true ? <Muted>active</Muted> : <span className="text-off">too few</span>}</>;
}
function zoneCell(z: any) {
  const x = obj(z);
  if (!x || !num(x.low) || !num(x.high)) return <Muted>—</Muted>;
  const role = str(x.role);
  // The key zone's level labels as the Key Level Agent writes them, its "daily" chart read as 1D (owner ruling).
  const levels = arr(x.levels).map(str).filter((l): l is string => l != null).map((l) => l.replace(/^daily /, "1D "));
  return (
    <>
      {priceRange(x.low, x.high)}<br />
      {role === "support" ? <span className="text-bull">▲ support</span> : role === "resistance" ? <span className="text-bear">▼ resistance</span> : <span className="text-ok">{role ?? "at price"}</span>}
      {x.qualified === true ? <><br /><Badge tone="ok">qualified</Badge></> : x.candidate === true ? <><br /><Badge tone="plain">candidate</Badge></> : null}
      {levels.length ? <><br /><Muted>{levels.join(" · ")}</Muted></> : null}
    </>
  );
}
function targetCell(d: any, p: any, rows: PlanRow[]) {
  const dist = (x: number) => signed(atrFrom(x, d?.price, d?.atr_h1));
  if (p.status === "forming") {
    const parts = ([["if up", p.target_up], ["if down", p.target_down]] as const).filter(([, x]) => num(x));
    if (!parts.length) return <Muted>—</Muted>;
    return <>{parts.map(([w, x], i) => <span key={w}>{i ? <br /> : null}<Muted>{w}</Muted> {price(x)} <Muted>·</Muted> {dist(x as number)}</span>)}</>;
  }
  if (!num(p.far_target)) return <Muted>—</Muted>;
  const tp2 = rows.some((r) => r.pattern === p && same(r.plan.tp2, p.far_target));
  return <>{price(p.far_target)} <Muted>·</Muted> {dist(p.far_target)}{tp2 ? <><br /><Muted>TP2 of the plan</Muted></> : null}</>;
}
function planCell(agents: any, p: any) {
  const plan = obj(p.plan);
  if (!plan) return <Muted>{PATTERN_AGENT_CHARTS.includes(String(p.tf)) ? "no plan in the latest decision" : "pattern agents trade the 15m and 1H charts only"}</Muted>;
  const s = sideOf(plan);
  const reach = str(plan.reach);
  return (
    <>
      {labelOf(agents, plan.agent)}<br />
      <span className={s === 1 ? "text-bull" : s === -1 ? "text-bear" : "text-neutral"}>{sideWord(s)}</span> <Muted>·</Muted> {str(plan.status) ?? "—"}
      {reach ? <><br />{REACH[reach] ?? words(reach)}</> : null}
    </>
  );
}
function statusCell(p: any) {
  const s = str(p.status) ?? "unknown";
  return <span className="inline-flex flex-col items-start gap-1"><Badge tone={STATUS_TONE[s] ?? "plain"}>{s}</Badge>{p.held === true ? <Badge tone="ok">held</Badge> : null}</span>;
}
const sinceText = (p: any) => (num(p.bars_since_breakout) ? <>{p.bars_since_breakout}<br />{num(p.horizon_bars) ? p.horizon_bars : "—"} <Muted>·</Muted> {num(p.bars_left) ? p.bars_left : "—"}</> : <Muted>—</Muted>);

function PatternsPanel({ d, tf, agents, poll }: { d: any; tf: TfKey; agents: any; poll?: Poll }) {
  const pats = arr(d?.patterns).filter((p) => p?.tf === tf && p != null && typeof p === "object");
  const rows = plansOf(d);
  const n = arr(d?.charts?.[tf]?.ohlcv).length;
  // The active tab names the chart; B9's own label only where it differs ("(daily)" on 1D).
  const own = str(d?.charts?.[tf]?.label);
  const right = <Badge tone="plain">{own && own !== TF_LABEL[tf] ? `(${own}) · ` : ""}last {n} closed bars</Badge>;
  if (!pats.length) {
    return (
      <Panel title="Patterns on this chart" icon={<Shapes className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} right={right}>
        <Empty when={`The Projection Agent finds none in the chart's last ${n} closed bars; it reads them again at each close.`}>No pattern on the {TF_LABEL[tf]} chart</Empty>
      </Panel>
    );
  }
  const since = pats.some((p) => num(p.bars_since_breakout) || num(p.horizon_bars));
  const name = (p: any) => <span className={p.status === "busted" ? "text-off" : DIR_TEXT[dirOf(p.direction)]}>{nameOf(p)}</span>;
  const turn = (p: any) => (num(p.bars_ago) ? String(p.bars_ago) : "—");
  const empties: [string, string][] = [];
  if (!arr(d?.patterns).some((p) => p?.held != null)) empties.push(["No held breakouts yet", "Held lines, the breakout bar and bars since it are filled by a later backend PR."]);
  if (!arr(d?.patterns).some((p) => num(p?.horizon_bars))) empties.push(["No horizon yet", "Each breakout's horizon and its bars left are filled by a later backend PR."]);
  if (!rows.some((r) => str(r.plan.reach))) empties.push(["No plan reach yet", "Retest, at price or out of reach is filled by a later backend PR."]);
  return (
    <Panel title="Patterns on this chart" icon={<Shapes className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} right={right}>
      <div className="flex flex-col gap-3">
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full border-collapse text-left">
            <thead><tr>
              <th scope="col" className={th}>Pattern</th><th scope="col" className={th}>Status</th><th scope="col" className={th}>Direction</th>
              <th scope="col" className={clsx(th, "text-right")}>Bars since<br />last turn</th>
              {since ? <th scope="col" className={clsx(th, "text-right")}>Since breakout<br />horizon · left</th> : null}
              <th scope="col" className={th}>Measured target<br />feed scale · ATR (1H)</th><th scope="col" className={th}>Record here</th><th scope="col" className={th}>Pooled</th>
              <th scope="col" className={th}>Key zone holding<br />the pattern</th><th scope="col" className={th}>Plan</th>
            </tr></thead>
            <tbody>
              {pats.map((p, i) => (
                <tr key={`${p.id}-${i}`}>
                  <td className={clsx(td, "min-w-[120px]")}>{name(p)}</td><td className={tdSans}>{statusCell(p)}</td>
                  <td className={clsx(td, "whitespace-nowrap")}><span className={DIR_TEXT[dirOf(p.direction)]}>{DIR_WORD[dirOf(p.direction)]}</span></td>
                  <td className={clsx(td, "text-right")}>{turn(p)}</td>
                  {since ? <td className={clsx(td, "text-right")}>{sinceText(p)}</td> : null}
                  <td className={clsx(td, "whitespace-nowrap")}>{targetCell(d, p, rows)}</td>
                  <td className={clsx(td, "whitespace-nowrap")}>{recCell(p.record?.chart)}</td><td className={clsx(td, "whitespace-nowrap")}>{recCell(p.record?.pooled)}</td>
                  <td className={clsx(td, "min-w-[140px] max-w-[190px]")}>{zoneCell(p.zone)}</td><td className={clsx(td, "min-w-[130px] max-w-[180px]")}>{planCell(agents, p)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col gap-2 sm:hidden">
          {pats.map((p, i) => (
            <div key={`${p.id}-${i}`} className="glass-inner p-3.5">
              <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5"><span className={clsx("mono text-[12px] font-semibold", p.status === "busted" ? "text-off" : DIR_TEXT[dirOf(p.direction)])}>{GLYPH[dirOf(p.direction)]} {nameOf(p)}</span><Badge tone={STATUS_TONE[str(p.status) ?? ""] ?? "plain"}>{str(p.status) ?? "unknown"}</Badge>{p.held === true ? <Badge tone="ok">held</Badge> : null}</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                <Kv k="Direction"><span className={DIR_TEXT[dirOf(p.direction)]}>{DIR_WORD[dirOf(p.direction)]}</span></Kv>
                <Kv k="Bars since last turn">{turn(p)}</Kv>
                {since ? <Kv k="Since breakout · horizon · left">{sinceText(p)}</Kv> : null}
                <Kv k="Measured target · ATR (1H)">{targetCell(d, p, rows)}</Kv>
                <Kv k="Key zone holding the pattern">{zoneCell(p.zone)}</Kv>
                <Kv k="Record here">{recCell(p.record?.chart)}</Kv>
                <Kv k="Pooled">{recCell(p.record?.pooled)}</Kv>
                <Kv k="Plan">{planCell(agents, p)}</Kv>
              </div>
            </div>
          ))}
        </div>
        <Note>Bars since last turn: since the pattern&apos;s last swing high or low. Record: the share of breakouts that reached the measured target, here and pooled over all charts; active from {RECORD_RULES.min_sample} breakouts. Prices on the feed scale.</Note>
        {empties.length ? <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2">{empties.map(([a, b]) => <Empty key={a} when={b}>{a}</Empty>)}</div> : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- panel: measured record per chart

function SplitBar({ t, f, e }: { t: number; f: number; e: number }) {
  const n = t + f + e;
  if (!n) return <span aria-hidden="true" className="block h-2 rounded-full bg-white/5" />;
  const seg = (v: number, cls: string) => <span className={clsx("block h-full", cls)} style={{ width: `${(v / n) * 100}%` }} />;
  return <span aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-white/5">{seg(t, "bg-ok-fill")}{seg(f, "bg-fault-fill")}{seg(e, "bg-off-fill/60")}</span>;
}

/** A chart's record: its resolved breakouts and rate, and the reached/failed/expired split over its patterns. */
export function chartRecord(by: any) {
  const x = obj(by);
  if (!x) return null;
  let t = 0, f = 0, e = 0;
  for (const r of Object.values(obj(x.patterns) ?? {})) { t += num((r as any)?.target) ? (r as any).target : 0; f += num((r as any)?.failed) ? (r as any).failed : 0; e += num((r as any)?.expired) ? (r as any).expired : 0; }
  return { n: num(x.resolved) ? x.resolved : null, rate: num(x.rate) ? x.rate : null, median: x.bars_to_target?.median, p90: x.bars_to_target?.p90, t, f, e };
}

function RecordPanel({ d, poll }: { d: any; poll?: Poll }) {
  const c = obj(d?.calibration);
  const off = d?.calibration_mode === "off";
  const empty = !c || [c.version, c.computed_at, c.resolved, c.base_rate].every((x) => x == null);
  const right = off ? undefined : !empty ? (
    <span className="flex flex-wrap items-center gap-1.5">{num(c!.base_rate) && num(c!.resolved) ? <Badge tone="plain">pooled {pc(c!.base_rate)} of {c!.resolved}</Badge> : null}<Badge tone="plain">replayed hourly</Badge></span>
  ) : undefined;
  const body = (() => {
    if (off) return <Empty when="Calibration is switched off by the owner: every pattern keeps its default weights.">No measured record</Empty>;
    if (empty) return <Empty when="The hourly replay writes it from the cached bars; records show from the first run.">No measured record yet</Empty>;
    if (!obj(c!.by_tf)) return <Empty when="Each chart's own record comes with the hourly replay.">No record per chart yet</Empty>;
    const recs = TF_KEYS.map((tf) => ({ tf, r: chartRecord(c!.by_tf[tf]), open: c!.open == null ? null : arr(c!.open?.[tf]).length }));
    const counts = (r: NonNullable<ReturnType<typeof chartRecord>>) => <span className="whitespace-nowrap"><span className="text-ok">{r.t}</span> <Muted>·</Muted> <span className="text-fault">{r.f}</span> <Muted>·</Muted> <span className="text-off">{r.e}</span></span>;
    const bt = (r: any) => `${num(r?.median) ? r.median : "—"} · ${num(r?.p90) ? r.p90 : "—"}`;
    return (
      <>
        <table className="hidden w-full border-collapse text-left sm:table">
          <thead><tr><th scope="col" className={th}>Chart</th><th scope="col" className={clsx(th, "text-right")}>Breakouts</th><th scope="col" className={clsx(th, "text-right")}>Target rate</th><th scope="col" className={clsx(th, "text-right")}>Bars to target<br />median · p90</th><th scope="col" className={clsx(th, "text-right")}>Open</th><th scope="col" className={th}>Reached target<br />failed · expired</th></tr></thead>
          <tbody>{recs.map(({ tf, r, open }) => (
            <tr key={tf}>
              <td className={td}>{TF_LABEL[tf]}</td>
              {r ? <><td className={clsx(td, "text-right")}>{r.n ?? "—"}</td><td className={clsx(td, "text-right")}>{pc(r.rate)}</td><td className={clsx(td, "text-right")}>{bt(r)}</td></>
                : <td className={clsx(td, "text-muted")} colSpan={3}>no breakout resolved yet</td>}
              <td className={clsx(td, "text-right")}>{open ?? "—"}</td>
              <td className={td}>{r ? <span className="flex items-center gap-2.5"><span className="block w-[120px] shrink-0"><SplitBar t={r.t} f={r.f} e={r.e} /></span>{counts(r)}</span> : <Muted>—</Muted>}</td>
            </tr>
          ))}</tbody>
        </table>
        <table className="w-full border-collapse text-left sm:hidden">
          <thead><tr><th scope="col" className={th}>Chart<br />breakouts</th><th scope="col" className={clsx(th, "text-right")}>Target rate<br />median · p90</th><th scope="col" className={clsx(th, "text-right")}>Open</th><th scope="col" className={th}>Reached target<br />failed · expired</th></tr></thead>
          <tbody>{recs.map(({ tf, r, open }) => (
            <tr key={tf}>
              <td className={clsx(td, "px-1.5")}>{TF_LABEL[tf]}<br /><Muted>{r?.n ?? "—"}</Muted></td>
              <td className={clsx(td, "px-1.5 text-right")}>{r ? <>{pc(r.rate)}<br /><Muted>{bt(r)}</Muted></> : <Muted>none yet</Muted>}</td>
              <td className={clsx(td, "px-1.5 text-right")}>{open ?? "—"}</td>
              <td className={clsx(td, "px-1.5")}>{r ? <><span className="block w-[76px]"><SplitBar t={r.t} f={r.f} e={r.e} /></span>{counts(r)}</> : <Muted>—</Muted>}</td>
            </tr>
          ))}</tbody>
        </table>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-[11px] text-fg-2">
          <Item swatch={<span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-ok-fill" />}>reached target</Item>
          <Item swatch={<span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-fault-fill" />}>failed</Item>
          <Item swatch={<span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-off-fill" />}>expired, counted as a miss</Item>
          <span className="text-muted">followed {RECORD_RULES.horizon} to {RECORD_RULES.horizon_max} bars of its chart</span>
        </div>
      </>
    );
  })();
  return (
    <Panel title="Measured record per chart" icon={<LineChart className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} right={right} className="h-full">
      <div className="flex flex-col gap-3">{body}</div>
    </Panel>
  );
}

// ---------------------------------------------------------------- panel: the Projection Agent's seat

/** The seat of each room from /api/neuron-allocation: shadow where the Projection Agent is benched, live where it sits. */
export function seatOf(alloc: any, room: string): "live" | "shadow" | "not seated" | null {
  const a = arr(alloc?.agents).find((x) => x?.agent === "projection");
  if (!a) return null;
  if (arr(a.shadow_rooms).includes(room)) return "shadow";
  return arr(a.rooms).includes(room) ? "live" : "not seated";
}

function SeatPanel({ d, alloc, poll }: { d: any; alloc: any; poll?: Poll }) {
  const rules = obj(alloc?.rules);
  const demote = num(rules?.demote_below) ? rules!.demote_below : SEAT_RULES.demote_below;
  const promote = num(rules?.promote_at) ? rules!.promote_at : SEAT_RULES.promote_at;
  const min = num(rules?.min_scored) ? rules!.min_scored : SEAT_RULES.min_scored;
  const seat = obj(d?.seat);
  const horizon = num(seat?.horizon_bars) ? seat!.horizon_bars : null;
  const candles = num(seat?.scoring?.candles) ? seat!.scoring.candles : null;
  const days = num(seat?.scoring?.window_days) ? seat!.scoring.window_days : 30;
  const cols = "grid grid-cols-[40px_70px_minmax(0,1fr)_40px_74px] items-center gap-2";
  const tick = (v: number) => <span className="absolute -bottom-[3px] -top-[3px] w-[1.5px] bg-fg" style={{ left: `${v * 100}%` }} />;
  return (
    <Panel title="Projection seat" icon={<Cpu className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} className="h-full"
      right={<Badge tone="plain">{horizon != null ? `judged on its horizon (${horizon} bars)` : candles != null ? `judged on ${candles} bars` : "judged per bar"}</Badge>}>
      <div className="flex flex-col gap-2.5">
        {!seat ? <Empty when="The outcome scoring writes it as each room's calls resolve.">No seat record yet</Empty> : (
          <div>
            <div className={clsx(cols, "border-b border-white/10 pb-1.5 text-[11px] text-muted")}>
              <span>Room</span><span>Seat</span>
              <span className="relative block h-3.5"><span className="absolute -translate-x-full pr-[3px]" style={{ left: `${demote * 100}%` }}>{pc(demote)}</span><span className="absolute pl-[3px]" style={{ left: `${promote * 100}%` }}>{pc(promote)}</span></span>
              <span className="text-right">Hit rate</span><span className="text-right">Scored</span>
            </div>
            {TF_KEYS.map((tf) => {
              const room = TF_ROOM[tf], r = obj(seat.rooms?.[room]);
              const dl = obj(r?.directional);
              const scored = (num(dl?.hit) ? dl!.hit : 0) + (num(dl?.miss) ? dl!.miss : 0);
              const rate = num(dl?.hit_rate) ? dl!.hit_rate : null;
              const st = seatOf(alloc, room);
              const tone: Tone = st === "live" ? "ok" : st === "shadow" ? "shadow" : "off";
              return (
                <div key={room} className={clsx(cols, "border-b border-white/5 py-[7px]")}>
                  <span className="mono text-[12px] text-fg">{room}</span>
                  <span>{st ? <Badge tone={tone}>{st}</Badge> : <Muted>—</Muted>}</span>
                  <span aria-hidden="true" className="relative block h-2 rounded-full bg-white/6">
                    {rate != null ? <span className={clsx("absolute inset-y-0 left-0 rounded-full", tone === "shadow" ? "bg-ghost-fill/80" : "bg-ok-fill/80")} style={{ width: `${Math.min(1, rate) * 100}%` }} /> : null}
                    {tick(demote)}{tick(promote)}
                  </span>
                  <span className="mono text-right text-[12px] text-fg">{pc(rate)}</span>
                  <span className={clsx("mono text-right text-[12px]", scored < min ? "text-late" : "text-slate-300")}>n {scored} / {min}</span>
                </div>
              );
            })}
          </div>
        )}
        {horizon == null ? <Empty when={LATER}>No horizon for the seat yet</Empty> : null}
        <Note>Directional calls, last {days} days. To shadow below {pc(demote)} from {min} scored; back to live at {pc(promote)}. Hit rate from /api/chart-patterns, seat from /api/neuron-allocation.</Note>
        <a href="/#/neurons" className="inline-flex min-h-8 items-center gap-1.5 self-start text-[12px] font-medium text-cyan-300 hover:text-cyan-200">Neuron allocation</a>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- panel: pattern agents

/** The pattern agents of /api/strategy-agents (the eight families and inside the pattern), live first. */
export function patternAgents(agents: any): any[] {
  const list = arr(agents?.agents).filter((a) => typeof a?.id === "string" && a.id.startsWith("pattern_"));
  const rank = (a: any) => (a.suspended === true ? 2 : a.status === "live" ? 0 : a.status === "shadow" ? 1 : 3);
  return list.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
}
const agentStatus = (a: any): string => (a.suspended === true ? "suspended" : str(a.status) ?? "unknown");

function AgentsPanel({ d, agents, poll }: { d: any; agents: any; poll?: Poll }) {
  const list = patternAgents(agents);
  const trade = str(d?.decision?.trade_agent);
  const held = arr(agents?.suspended_patterns);
  const heldOf = (a: any) => held.filter((h) => h?.agent === a.id).map((h) => str(arr(a.patterns).find((p) => p?.id === h.id)?.name) ?? words(h.id));
  const filledOf = (rec: any) => (num(rec?.setups) && num(rec?.fill_rate) ? Math.round(rec.setups * rec.fill_rate) : null);
  const counts = ["live", "shadow", "suspended", "off"].map((s) => [s, list.filter((a) => agentStatus(a) === s).length] as const).filter(([, n]) => n > 0);
  const right = list.length ? <Badge tone="plain">{counts.map(([s, n]) => `${n} ${s}`).join(" · ")}</Badge> : undefined;
  const r = (x: unknown) => (num(x) ? `${signed(x)}R` : "—");
  const heldCell = (a: any) => { const h = heldOf(a); return h.length ? <><Badge tone="late">{h.length} held back</Badge><br /><Muted>{h.join(", ")}</Muted></> : <Muted>—</Muted>; };
  const armed = (a: any) => (trade === a.id ? <Badge tone="ok">armed</Badge> : <Muted>—</Muted>);
  const body = (() => {
    if (!list.length) {
      if (poll) return <PollBody poll={poll} skeleton={4} empty={<Empty when="The strategy agents' registry answers from /api/strategy-agents.">No pattern agent yet</Empty>}>{null}</PollBody>;
      return <Empty when="The strategy agents' registry answers from /api/strategy-agents.">No pattern agent yet</Empty>;
    }
    return (
      <>
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full border-collapse text-left">
            <thead><tr>
              <th scope="col" className={th}>Agent</th><th scope="col" className={th}>Status</th><th scope="col" className={th}>Armed</th>
              {["Setups", "Filled", "Fill rate", "Target rate", "Stop rate", "Mean R", ].map((h) => <th key={h} scope="col" className={clsx(th, "text-right")}>{h}</th>)}
              <th scope="col" className={th}>Held back</th>
            </tr></thead>
            <tbody>{list.map((a) => {
              const rec = obj(a.record);
              return (
                <tr key={a.id}>
                  <td className={clsx(tdSans, "font-semibold text-fg")}>{str(a.label) ?? agentLabel(a.id)}</td>
                  <td className={tdSans}><Badge tone={AGENT_TONE[agentStatus(a)] ?? "plain"}>{agentStatus(a)}</Badge></td>
                  <td className={tdSans}>{armed(a)}</td>
                  <td className={clsx(td, "text-right")}>{num(rec?.setups) ? rec!.setups : "—"}</td>
                  <td className={clsx(td, "text-right")}>{filledOf(rec) ?? "—"}</td>
                  <td className={clsx(td, "text-right")}>{pc(rec?.fill_rate)}</td>
                  <td className={clsx(td, "text-right")}>{pc(rec?.target_rate)}</td>
                  <td className={clsx(td, "text-right")}>{pc(rec?.stop_rate)}</td>
                  <td className={clsx(td, "text-right")}>{r(rec?.mean_r)}</td>
                  <td className={td}>{heldCell(a)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
        <div className="flex flex-col gap-2 sm:hidden">
          {list.map((a) => {
            const rec = obj(a.record);
            return (
              <div key={a.id} className="glass-inner p-3.5">
                <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5"><span className="text-[13px] font-semibold text-fg">{str(a.label) ?? agentLabel(a.id)}</span><Badge tone={AGENT_TONE[agentStatus(a)] ?? "plain"}>{agentStatus(a)}</Badge></div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                  <Kv k="Armed">{armed(a)}</Kv>
                  <Kv k="Setups · filled">{num(rec?.setups) ? rec!.setups : "—"} <Muted>·</Muted> {filledOf(rec) ?? "—"}</Kv>
                  <Kv k="Fill rate">{pc(rec?.fill_rate)}</Kv><Kv k="Target rate">{pc(rec?.target_rate)}</Kv>
                  <Kv k="Stop rate">{pc(rec?.stop_rate)}</Kv><Kv k="Mean R">{r(rec?.mean_r)}</Kv>
                  <Kv k="Held back">{heldCell(a)}</Kv>
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  })();
  return (
    <Panel title="Pattern agents" icon={<Puzzle className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} right={right}>
      <div className="flex flex-col gap-3">
        {body}
        {/* Filled mean R has no field in /api/strategy-agents yet, and no pattern agent trades the 4H or 1D chart: both
            are Empties that read nothing until the backend defines them. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
          <Empty when={LATER}>No filled mean R yet</Empty>
          <Empty when="A pattern agent for the 4H and 1D charts is not built yet.">No higher-chart pattern agent yet</Empty>
        </div>
        <Note>From /api/strategy-agents. Target and stop rates are over filled setups. Armed: the latest decision&apos;s trade agent, from /api/chart-patterns. Arming stays on Strategy agents. A pattern with a negative record over {PATTERN_BREAKER_MIN} setups is held back; its family trades on.</Note>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- the view

export type Polls = { patterns?: Poll; agents?: Poll; seat?: Poll };

function Page({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  return <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">{heading}{children}</div>;
}

function MarketClosed({ now }: { now: number }) {
  const next = nextOpenMs(now) + 15 * 60_000;
  const wd = nyClock(now).wd;
  const weekend = wd === 6 || wd === 0 || (wd === 5 && nyClock(now).hour >= 17);
  return (
    <Panel title="Chart patterns" icon={<Shapes className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="off">market closed</Badge>}>
      <div className="flex flex-col gap-3">
        <Empty when={`Patterns read closed bars. The next 15m bar closes ${openText(next)}.`}>Market closed</Empty>
        <div className="text-[12px] leading-normal text-fg-2">The charts keep {weekend ? "Friday's" : "the"} last bars and patterns until then.</div>
      </div>
    </Panel>
  );
}

/**
 * The Chart patterns page from its three reads. Pure and null-safe: any body, any path null or any array empty renders
 * (the page render check). `now` is the wall clock; `mark` is the view read's planMark (stale: the lines dimmed, their
 * labels kept readable with " · stale 7m"; past 2 hours hidden); `tf` the chart shown (default: the plan's chart).
 */
export function PatternsView({ d, agents = null, alloc = null, now = Date.now(), mark = LIVE, polls = {}, tf, onTab }: {
  d: any; agents?: any; alloc?: any; now?: number; mark?: Mark; polls?: Polls; tf?: TfKey | null; onTab?: (tf: TfKey) => void;
}) {
  if (!patternsReady(d)) {
    return (
      <Page heading={<Heading />}>
        <Panel title="Chart patterns" icon={<Shapes className="h-3.5 w-3.5 text-cyan-300" />}>
          {intelViewsOff(d) ? <Empty when="The Intelligence views are off on the AI Worker.">intel_views_off</Empty>
            : <Empty when="The Projection Agent's patterns are read at each 15m close.">No chart patterns view yet</Empty>}
        </Panel>
      </Page>
    );
  }
  const shown: TfKey = tf ?? defaultTab(d);
  const off = d?.mode === "off";
  return (
    <Page heading={<Heading chips={headingChips(d, now)} />}>
      {marketClosedAt(now) ? <MarketClosed now={now} /> : null}
      {off ? (
        <Panel title="Chart patterns" icon={<Shapes className="h-3.5 w-3.5 text-cyan-300" />}>
          <Empty when="Switched off by the owner: the Projection Agent reads no chart pattern. Its projection levels stay.">Chart patterns off</Empty>
        </Panel>
      ) : (
        <>
          <ChartPanel d={d} tf={shown} onTab={onTab} agents={agents} mark={mark} poll={polls.patterns} />
          <PatternsPanel d={d} tf={shown} agents={agents} poll={polls.patterns} />
        </>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
        <div className="min-w-0"><RecordPanel d={d} poll={polls.patterns} /></div>
        <div className="min-w-0"><SeatPanel d={d} alloc={alloc} poll={polls.seat} /></div>
      </div>
      <AgentsPanel d={d} agents={agents} poll={polls.agents} />
    </Page>
  );
}

/**
 * The page before its first good read: the skeleton while it loads, else the shared error box with the route and its
 * code ("/api/chart-patterns 500 chart_patterns_unavailable", "/api/chart-patterns 404 Not found" before the route is
 * deployed), as the Liquidity page shows its own.
 */
export function PatternsUnread({ poll }: { poll: Poll }) {
  return (
    <Page heading={<Heading />}>
      <Panel title="Chart patterns" icon={<Shapes className="h-3.5 w-3.5 text-cyan-300" />} poll={poll}>
        <PollBody poll={poll} skeleton={4} empty={<Empty when="The Projection Agent's patterns are read at each 15m close.">No chart patterns view yet</Empty>}>{null}</PollBody>
      </Panel>
    </Page>
  );
}

// ---------------------------------------------------------------- the page (the polls)

export default function Patterns() {
  const R = CHART_PATTERNS_READS;
  // One poll per read (GET only, lib/intel.ts CHART_PATTERNS_READS): the page's only requests.
  const patterns = usePoll(() => intelGet(R, "patterns"), R.patterns.everyMs);
  const agents = usePoll(() => intelGet(R, "agents"), R.agents.everyMs);
  const seat = usePoll(() => intelGet(R, "seat"), R.seat.everyMs);
  const [tf, setTf] = useState<TfKey | null>(null);
  // The view read's planMark (as the War Room chart's plan): dimmed with " · stale 7m" while stale, hidden past 2 hours.
  // A 1 s clock renders only when the mark changes; the market clock and the ages follow a 15 s wall clock.
  const facts = { hasData: patterns.data != null, error: patterns.error, lastOk: patterns.lastOk, intervalMs: patterns.intervalMs };
  const mark = planMark(facts, localNow());
  const markNow = useRef({ facts, key: markKey(mark) });
  markNow.current = { facts, key: markKey(mark) };
  const [, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => { if (markKey(planMark(markNow.current.facts, localNow())) !== markNow.current.key) setTick((n) => n + 1); }, PLAN_TICK_MS);
    const w = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => { window.clearInterval(t); window.clearInterval(w); };
  }, []);
  // One mark object per state, so the chart's lines are rebuilt only when the mark changes.
  const mk = markKey(mark);
  const stableMark = useMemo(() => mark, [mk]);
  if (patterns.data == null) return <PatternsUnread poll={patterns} />;
  return <PatternsView d={patterns.data} agents={agents.data} alloc={seat.data} now={now} mark={stableMark} polls={{ patterns, agents, seat }} tf={tf} onTab={setTf} />;
}
