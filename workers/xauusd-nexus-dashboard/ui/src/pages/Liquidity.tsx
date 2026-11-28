import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type SVGProps } from "react";
import { Activity, CandlestickChart, Droplets, Gauge, GitBranch, Grid3x3, Info, Layers, Scale, Target, ToggleRight } from "lucide-react";
import clsx from "clsx";
import { Badge, Empty, Hint, Panel, PollBody } from "../components/ui";
import IntelChart, { barsOf, type IntelMarker } from "../components/IntelChart";
import { LensHeader, LensView, lensReady } from "../components/LensPanel";
import type { ChartZone } from "../lib/zones-primitive";
import { usePoll, type Poll } from "../lib/usePoll";
import { PLAN_TICK_MS, localNow, markKey, planMark } from "../lib/pollState";
import { T, rgba, type Tone } from "../lib/tokens";
import { gmt7ClockOf } from "../lib/entryZone";
import {
  LIQUIDITY_READS, LENS_MIN_N, ROLE_WORD, SCALE, WEEKDAYS, ZONE_COLOR, ZONE_TEXT, ageText, arr, atrDistance, clockPair, closedHour,
  LIQUIDITY_CARD_MAX, cardSummary, conditionText, conditionTone, levelsText, roomsNote, sessionText, timesText, cardWeightText, feedLevels, intelGet, kindWord, kindsInOrder, knownBasis, leanReasonText, localDayTime, localTime, marketClosedAt, nextOpenMs, num, nyClock,
  nyHourOfWeek, nyZoneText, obj, openText, pc, pctl, price, priceRange, roleOf, scoreKindWord, signed, str, utcDayTime, utcTime, words, zoneLabel,
  type FeedLevel, type Role
} from "../lib/intel";

// Liquidity (Intelligence, Track C2; owner 2026-11-22: "ketiganya dibuat panel visualisasi sendiri terpisah dalam
// Intelligence"), as the owner-approved mockup: lens B of the Positioning & Liquidity analyst on its own page, read-only.
// Five reads, each polled once (lib/intel.ts LIQUIDITY_READS, GET only): /api/liquidity (cryptophys.liquidity-view.v1,
// backend B8), /api/lens, the feed's 15m candles, the 15m chart plane and the latest decision.
//
// LiquidityView is pure and null-safe (the page render check renders it over test/fixtures/nexus-intel/liquidity.json
// and its variants). B17-B19 are live. effects.level_moves is null only while LENS_LEVEL_READINGS is off: the panel says
// "Not recorded: LENS_LEVEL_READINGS is off." with a link to Feature switches, and an unscored skip says the switch is
// off. effects.pm_actions (and management) are always arrays; a null one reads a null-safe "Not in this answer", never
// an error. Since B19 the level moves are a table per action (ladder lock, key level lock): each move's time in New
// York, UTC and GMT+7, its side in its direction colour, its mode, and its outcome in a neutral chip; no price. B15's
// LIQUIDITY card and quorum with liquidity are null when the latest decision has no decision.liquidity (the switch off;
// lens B off, floored or stale; a decision before B15): an Empty says so.
//
// Prices: every one carries its scale (feed or broker). The chart is the feed's, so lens B's bands come only from
// low_feed / high_feed, and none is drawn while the broker-to-feed basis is unknown. Liquidity never opens, sizes or
// prices an entry: no order line or order price is drawn or written here.

/** Lens B's state older than this is ignored by Omega (src/liquidity-lens.mjs LIQUIDITY_STATE_FRESH_MS). */
const STATE_FRESH_MS = 15 * 60_000;
/** A stale read's bands: dimmed to this share of their strength, their labels kept readable (PriceChart's planMark). */
const DIM = 0.45;

export type Mark = ReturnType<typeof planMark>;
const LIVE: Mark = { show: true, dim: false, suffix: "", note: null };

/** A /api/liquidity body with a view in it. */
export const liquidityReady = (d: any): boolean => d != null && typeof d === "object" && (d.status === "ok" || d.schema === "cryptophys.liquidity-view.v1") && d.status !== "not_found";
/** The AI Worker's answer while INTEL_VIEWS is off. */
export const intelViewsOff = (d: any): boolean => d?.status === "not_found" && d?.reason === "intel_views_off";

/** Whether lens B's state is older than Omega reads it (state.fresh false, or older than 15 minutes by this clock). */
export const stateOld = (d: any, now: number): boolean => { const at = d?.state?.at_ms; return d?.state?.fresh === false || (num(at) && now - at > STATE_FRESH_MS); };

/**
 * Why Omega ignores lens B's levels now, or null while state.on (the signal's liquidity_on: the switch on, the weight
 * above its floor, a fresh state with facts). The reason: the owner's switch (/api/lens), the floor (score.floored),
 * the state's age; else "lens B not on".
 */
export function ignoredWhy(d: any, lens: any, now: number): { reason: string; tone: Tone } | null {
  if (d?.state?.on === true) return null;
  if (lensReady(lens) && lens.switches?.liquidity_enabled === false) return { reason: "lens B off", tone: "off" };
  if (d?.score?.floored === true || (lensReady(lens) && lens.liquidity?.floored === true)) return { reason: "lens B at its floor", tone: "late" };
  const at = d?.state?.at_ms;
  if (stateOld(d, now)) return { reason: num(at) ? `state ${ageText(now - at)} old` : "state old", tone: "late" };
  return { reason: "lens B not on", tone: "off" };
}

// ---------------------------------------------------------------- small pieces

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("flex flex-wrap items-center gap-1.5", className)}>{children}</div>;
}
const Muted = ({ children }: { children: ReactNode }) => <span className="text-muted">{children}</span>;
const Swatch = ({ style }: { style: CSSProperties }) => <span aria-hidden="true" className="inline-block h-2 w-3 shrink-0" style={style} />;
const Item = ({ swatch, children }: { swatch?: ReactNode; children: ReactNode }) => <span className="inline-flex items-center gap-1.5">{swatch}{children}</span>;
/** The cyan time of a read, as the Panel's live tag, for a part with no poll of its own. */
const LiveTime = ({ ms }: { ms: number }) => <span className="mono inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fg-2"><span className="inline-flex h-2 w-2 rounded-full bg-ok-fill" />{clockPair(ms)}</span>;

/** A count of outcomes as chips: hit ok, miss fault, neutral off (the ones above 0). */
function Outcomes({ o }: { o: any }) {
  const x = obj(o);
  if (!x) return <span className="text-fg-2">—</span>;
  const parts: [Tone, string][] = [];
  if (num(x.hit) && x.hit > 0) parts.push(["ok", `${x.hit} hit`]);
  if (num(x.miss) && x.miss > 0) parts.push(["fault", `${x.miss} miss`]);
  if (num(x.neutral) && x.neutral > 0) parts.push(["off", `${x.neutral} neutral`]);
  if (!parts.length) return <span className="text-fg-2">none scored yet</span>;
  return <span className="inline-flex flex-wrap gap-1">{parts.map(([t, s]) => <Badge key={s} tone={t}>{s}</Badge>)}</span>;
}

// ---------------------------------------------------------------- the heading

function Heading({ chips }: { chips?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="flex items-center gap-2.5 text-[20px] font-semibold text-fg"><Droplets className="h-[18px] w-[18px] text-cyan-300" />Liquidity</h1>
        <span className="text-[11px] text-muted">Intelligence · lens B · broker M1</span>
      </div>
      {chips ? <Row>{chips}</Row> : null}
      <div className="flex items-center gap-2 text-[12px] text-fg-2"><Info className="h-3.5 w-3.5 shrink-0 text-fg-2" aria-hidden="true" />Liquidity never opens, sizes or prices an entry.</div>
    </div>
  );
}

function baselineChip(b: any, prefix = ""): ReactNode {
  const status = str(b?.status), weeks = num(b?.weeks) ? b.weeks : 0, need = num(b?.sufficient_weeks) ? b.sufficient_weeks : 4;
  if (status === "sufficient") return <Badge tone="ok">{prefix}sufficient · {weeks} of {need} weeks</Badge>;
  if (status === "insufficient") return <Badge tone="late">{prefix}insufficient · {weeks} of {need} weeks</Badge>;
  return <Badge tone="off">{prefix}unavailable</Badge>;
}

const basisText = (b: number) => `basis ${signed(b)} (broker − feed)`;

// ---------------------------------------------------------------- panel 2: score against the floor

function ScoreBlock({ title, score, floored }: { title: string; score: any; floored: boolean }) {
  const s = obj(score);
  const floor = num(s?.score_floor) ? s!.score_floor : 0.45;
  const share = num(s?.share) ? s!.share : null;
  const tone: Tone = share != null && share >= floor ? "ok" : "late";
  const kinds = kindsInOrder(s?.kinds);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-fg">{title}</span>
        {floored ? <Badge tone="late">at floor</Badge> : null}
      </div>
      {!s ? <Empty>No scored reading yet.</Empty> : (
        <>
          <div className="flex items-baseline gap-2.5">
            <span className={clsx("mono text-[22px] font-semibold", share == null ? "text-fg-2" : tone === "ok" ? "text-ok" : "text-late")}>{pc(share)}</span>
            <span className="mono text-[11px] text-fg-2">n {num(s.n) ? s.n : 0} / {LENS_MIN_N} · {num(s.hits) ? s.hits : 0} hit · {num(s.misses) ? s.misses : 0} miss</span>
          </div>
          <div className="relative h-[22px]" title={`Score floor ${pc(floor)}`}>
            <div className="absolute inset-x-0 top-[7px] h-2 rounded bg-white/7" />
            {share != null ? <div className={clsx("absolute left-0 top-[7px] h-2 rounded", tone === "ok" ? "bg-ok-fill" : "bg-late-fill")} style={{ width: `${Math.min(100, share * 100)}%` }} /> : null}
            <div className="absolute top-px h-5 w-0.5 -translate-x-1/2 bg-fg" style={{ left: `${floor * 100}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-muted"><span>0</span><span>Score floor {pc(floor)}</span><span>100</span></div>
          <div className="flex flex-col gap-1.5">
            {kinds.map(([k, v]) => {
              const hits = num(v?.hits) ? v.hits : 0, n = hits + (num(v?.misses) ? v.misses : 0);
              const ks = n > 0 ? hits / n : null;
              const kt: Tone = ks != null && ks >= floor ? "ok" : "late";
              return (
                <div key={k} className="mono grid grid-cols-[56px_minmax(0,1fr)_96px] items-center gap-2.5 text-[11px] text-fg-2">
                  <span>{scoreKindWord(k)}</span>
                  <div className="relative h-1.5 rounded-sm bg-white/7">
                    {ks != null ? <div className={clsx("absolute left-0 top-0 h-1.5 rounded-sm", kt === "ok" ? "bg-ok-fill/70" : "bg-late-fill/70")} style={{ width: `${ks * 100}%` }} /> : null}
                    <div className="absolute -top-[3px] h-3 w-px bg-fg-2" style={{ left: `${floor * 100}%` }} />
                  </div>
                  <span className={clsx("text-right", kt === "late" ? "text-late" : "text-slate-300")}>{hits}/{n} · {pc(ks)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** Lens B's score: /api/liquidity's (the floor step's own read), split by kind with /api/lens's kinds when it has them. */
export function lensBScore(d: any, lens: any): any {
  const own = obj(d?.score);
  const kinds = lensReady(lens) ? obj(lens.liquidity?.score?.kinds) : null;
  if (own) return { ...own, kinds };
  return lensReady(lens) ? obj(lens.liquidity?.score) : null;
}

function ScorePanel({ d, lens, poll }: { d: any; lens: any; poll?: Poll }) {
  const b = lensBScore(d, lens);
  return (
    <Panel title="Score against the floor" icon={<Gauge className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} live className="h-full">
      <div className="flex flex-col gap-4">
        <ScoreBlock title="Lens B · Liquidity" score={b} floored={d?.score?.floored === true || (lensReady(lens) && lens.liquidity?.floored === true)} />
        <div className="h-px bg-white/5" />
        {lensReady(lens) ? <ScoreBlock title="Lens A · Positioning" score={lens.positioning?.score} floored={lens.positioning?.floored === true} />
          : <Empty when="The ledger step writes it every 5 minutes.">No lens state yet</Empty>}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- panel 3: levels on the chart

/** One zone of today's management level set, on the feed scale (from *_feed only), with its broker values. */
export type ManagementZone = { low: number; high: number; lowBroker: number | null; highBroker: number | null; source: string; kind: string | null; role: Role; keyZone: boolean };

/**
 * Today's management level set (management[]: the decision's key zones, source key_level, and lens B's own levels,
 * source liquidity) on the feed scale: from *_feed only, none without a known basis. A key zone that holds a lens B
 * level marked in_key_zone is the liquidity family's (outlined in its role colour on the chart).
 */
export function managementOf(d: any, levels: FeedLevel[], last: number | null): ManagementZone[] {
  if (knownBasis(d?.scale) == null) return [];
  const inKey = levels.filter((l) => l.inKeyZone);
  return arr(d?.management).filter((m) => num(m?.low_feed) && num(m?.high_feed) && m.low_feed <= m.high_feed).map((m) => {
    const source = m.source === "liquidity" ? "liquidity" : "key_level";
    return {
      low: m.low_feed, high: m.high_feed, lowBroker: num(m.low) ? m.low : null, highBroker: num(m.high) ? m.high : null, source, kind: str(m.kind),
      role: roleOf(m.low_feed, m.high_feed, last), keyZone: source === "key_level" && inKey.some((l) => l.low <= m.high_feed && l.high >= m.low_feed)
    };
  });
}

/** A band's label: "<kind> · broker <its middle on the broker scale>", the stale suffix after it. */
export const bandLabel = (l: FeedLevel, suffix = "") => `${l.kind} · broker ${price(l.brokerMid)}${suffix}`;
/** A chart-plane zone's label: "whale zone · feed 2,677.30–2,678.50", "FVG · feed 2,690.75". */
export const planeLabel = (name: string, lo: number, hi: number) => `${name} · feed ${priceRange(lo, hi)}`;
/** The management levels' label: Omega manages an open position with them, never an entry. */
export const MANAGEMENT_LABEL = "management only, never an entry";

/** The chart's bands, in the order their labels pick a spot: the plane's zones (when on), lens B's levels, the management candidates. */
export function chartZones({ levels, management, plane, zonesOn, dim, suffix, show, candleTimes }: {
  levels: FeedLevel[]; management: ManagementZone[]; plane: any; zonesOn: boolean; dim: boolean; suffix: string; show: boolean; candleTimes: number[];
}): ChartZone[] {
  const k = dim ? DIM : 1;
  const out: ChartZone[] = [];
  if (zonesOn) {
    const liq = obj(plane?.levels?.chart_plane?.liquidity);
    const since = (age: unknown) => (num(age) && candleTimes.length ? candleTimes[Math.max(0, candleTimes.length - 1 - Math.round(age))] : undefined);
    for (const z of arr(liq?.whale_zones).slice(0, 4)) {
      if (!num(z?.top) || !num(z?.bottom)) continue;
      const lo = Math.min(z.top, z.bottom), hi = Math.max(z.top, z.bottom);
      const role = z.role === "resistance" ? "resistance" : "support";
      out.push({ low: lo, high: hi, color: ZONE_COLOR[role], alpha: 0.08, dash: [2, 3], from: since(z.age_bars) as any, text: ZONE_TEXT[role], label: planeLabel(z.state === "active" || z.state == null ? "whale zone" : "whale mitigation block", lo, hi) });
    }
    for (const [side, list] of [["bull", liq?.fvg?.bull], ["bear", liq?.fvg?.bear]] as const) {
      for (const f of arr(list).slice(0, 3)) {
        const lo = num(f?.bottom) ? f.bottom : f?.price, hi = num(f?.top) ? f.top : f?.price;
        if (!num(lo) || !num(hi)) continue;
        const color = side === "bull" ? T.bullFill : T.bearFill;
        out.push({ low: Math.min(lo, hi), high: Math.max(lo, hi), color, alpha: 0.08, dash: [2, 3], from: since(f.age_bars) as any, text: side === "bull" ? T.bull : T.bear, label: planeLabel("FVG", Math.min(lo, hi), Math.max(lo, hi)) });
      }
    }
  }
  if (show) {
    // Lens B's own levels in the management set are its bands already; the key zones are drawn once each: outlined in
    // their role colour when they hold a lens B level (the liquidity family's), else grey and dashed.
    for (const l of levels) {
      const line = l.high - l.low < 0.2;
      out.push({ low: l.low, high: l.high, color: ZONE_COLOR[l.role], alpha: (line ? 0.34 : 0.14) * k, text: ZONE_TEXT[l.role], label: bandLabel(l, suffix) });
    }
    for (const m of management.filter((x) => x.source === "key_level")) {
      out.push(m.keyZone
        ? { low: m.low, high: m.high, color: ZONE_COLOR[m.role], alpha: 0.6 * k, outline: true, text: T.fg2, label: MANAGEMENT_LABEL + suffix }
        : { low: m.low, high: m.high, color: T.fg2, alpha: 0.06 * k, dash: [5, 4], text: T.fg2, label: MANAGEMENT_LABEL + suffix });
    }
  }
  return out;
}

function ZonesToggle({ on, onToggle }: { on: boolean; onToggle?: () => void }) {
  return (
    <button type="button" aria-pressed={on} onClick={onToggle} disabled={!onToggle}
      className={clsx("inline-flex min-h-8 items-center gap-2 rounded-md border px-2.5 text-[12px] font-semibold", on ? "border-ok-fill/40 bg-ok-fill/10 text-white" : "border-white/10 bg-white/4 text-slate-300 hover:text-white")}>
      <span aria-hidden="true" className={clsx("h-2 w-2 rounded-[2px]", on ? "bg-ok-fill" : "border border-fg-2")} />Whale zones &amp; FVG
    </button>
  );
}

function ChartLegend({ management }: { management: boolean }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1.5 text-[11px] text-fg-2">
      <span>Prices on the feed scale; band labels on the broker scale</span>
      <Item swatch={<Swatch style={{ background: rgba(T.bullFill, 0.35) }} />}><span className="text-bull">▲ support</span></Item>
      <Item swatch={<Swatch style={{ background: rgba(T.bearFill, 0.35) }} />}><span className="text-bear">▼ resistance</span></Item>
      <Item swatch={<Swatch style={{ background: rgba(T.okFill, 0.35) }} />}><span className="text-ok">at price</span></Item>
      <Item swatch={<Swatch style={{ border: `1px solid ${T.fg2}` }} />}>key zone (liquidity family), outlined in its role colour</Item>
      {management ? <Item swatch={<Swatch style={{ borderTop: `1px dashed ${T.fg2}`, borderBottom: `1px dashed ${T.fg2}` }} />}>management candidate</Item> : null}
    </div>
  );
}

function KeyChip() { return <Badge tone="plain">in key zone</Badge>; }

/** A management zone in words: "management · key zone", "management · HVN". */
const mgmtWord = (m: ManagementZone) => `management · ${m.source === "key_level" ? "key zone" : kindWord(m.kind)}`;

function LevelsTable({ levels, raw, management, last, atr }: { levels: FeedLevel[]; raw: any[]; management: ManagementZone[]; last: number | null; atr: unknown }) {
  // The broker values as the backend sends them (low, high), matched to each drawn level.
  const brokerOf = (l: FeedLevel) => { const r = raw.find((x) => x?.low_feed === l.low && x?.high_feed === l.high); return r && num(r.low) && num(r.high) ? priceRange(r.low, r.high) : "—"; };
  const rows = [...levels].sort((a, b) => b.low - a.low);
  const dash = <svg aria-hidden="true" width="14" height="6" viewBox="0 0 14 6"><line x1="0" x2="14" y1="1" y2="1" stroke={T.fg2} strokeDasharray="3 2" /><line x1="0" x2="14" y1="5" y2="5" stroke={T.fg2} strokeDasharray="3 2" /></svg>;
  const td = "mono whitespace-nowrap border-b border-white/5 px-2.5 py-1.5 align-top text-[12px]";
  const th = "whitespace-nowrap border-b border-white/10 px-1.5 py-2 text-[11px] font-medium text-muted";
  return (
    <>
      <table className="hidden w-full border-collapse text-left sm:table">
        <thead><tr><th scope="col" className={th}>Level</th><th scope="col" className={clsx(th, "text-right")}>Feed scale</th><th scope="col" className={clsx(th, "text-right")}>Broker scale</th><th scope="col" className={clsx(th, "text-right")}>ATR distance</th><th scope="col" className={th}>Key zone</th></tr></thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={`${l.low}-${l.high}-${i}`}>
              <td className={td} style={{ color: ZONE_TEXT[l.role] }}>{ROLE_WORD[l.role]} · {l.kind}</td>
              <td className={clsx(td, "text-right text-slate-300")}>{priceRange(l.low, l.high)}</td>
              <td className={clsx(td, "text-right text-slate-300")}>{brokerOf(l)}</td>
              <td className={clsx(td, "text-right text-fg")}>{signed(atrDistance(l.low, l.high, last, atr))}</td>
              <td className={clsx(td, "text-fg-2")}>{l.inKeyZone ? <KeyChip /> : "—"}</td>
            </tr>
          ))}
          {management.map((m, i) => (
            <tr key={`m${i}`} className="text-fg-2">
              <td className={td}><span className="inline-flex items-center gap-1.5">{dash}{mgmtWord(m)}</span></td>
              <td className={clsx(td, "text-right")}>{priceRange(m.low, m.high)}</td>
              <td className={clsx(td, "text-right")}>{priceRange(m.lowBroker, m.highBroker)}</td>
              <td className={clsx(td, "text-right")}>{signed(atrDistance(m.low, m.high, last, atr))}</td>
              <td className={td}>{m.keyZone ? <KeyChip /> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full border-collapse text-left sm:hidden">
        <thead><tr><th scope="col" className={th}>Level</th><th scope="col" className={clsx(th, "text-right")}>Feed scale<br />broker scale</th><th scope="col" className={clsx(th, "text-right")}>ATR<br />distance</th></tr></thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={`${l.low}-${l.high}-${i}`}>
              <td className={clsx(td, "whitespace-normal")}><span style={{ color: ZONE_TEXT[l.role] }}>{l.role === "support" ? "▲ " : l.role === "resistance" ? "▼ " : ""}{l.kind}</span><br /><Muted>{l.role}</Muted>{l.inKeyZone ? <><br /><KeyChip /></> : null}</td>
              <td className={clsx(td, "px-1.5 text-right text-slate-300")}>{priceRange(l.low, l.high)}<br /><span className="text-fg-2">{brokerOf(l)}</span></td>
              <td className={clsx(td, "text-right text-fg")}>{signed(atrDistance(l.low, l.high, last, atr))}</td>
            </tr>
          ))}
          {management.map((m, i) => (
            <tr key={`m${i}`} className="text-fg-2">
              <td className={clsx(td, "whitespace-normal")}><span className="inline-flex items-center gap-1.5">{dash}management</span><br /><Muted>{m.source === "key_level" ? "key zone" : kindWord(m.kind)}</Muted>{m.keyZone ? <><br /><KeyChip /></> : null}</td>
              <td className={clsx(td, "px-1.5 text-right")}>{priceRange(m.low, m.high)}<br />{priceRange(m.lowBroker, m.highBroker)}</td>
              <td className={clsx(td, "text-right")}>{signed(atrDistance(m.low, m.high, last, atr))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function LevelsPanel({ d, candles, plane, mark, ignored, zonesOn, onToggleZones, polls }: {
  d: any; candles: any; plane: any; mark: Mark; ignored: { reason: string; tone: Tone } | null; zonesOn: boolean; onToggleZones?: () => void; polls: Polls;
}) {
  const bars = useMemo(() => barsOf(candles), [candles]);
  // The last price on the feed scale: the view's price.feed, else the last closed candle's.
  const last = num(d?.price?.feed) ? d.price.feed : bars.length ? bars[bars.length - 1].close : null;
  const basis = knownBasis(d?.scale);
  const available = d?.facts?.available === true;
  const levels = useMemo(() => (available ? feedLevels(d?.levels, d?.scale, last) : []), [available, d?.levels, d?.scale, last]);
  const management = useMemo(() => managementOf(d, levels, last), [d, levels, last]);
  const dim = mark.dim || ignored != null;
  const zones = useMemo(() => chartZones({ levels, management, plane, zonesOn, dim, suffix: mark.suffix, show: mark.show, candleTimes: bars.map((b) => b.time) }),
    [levels, management, plane, zonesOn, dim, mark.suffix, mark.show, bars]);
  const markers = useMemo<IntelMarker[]>(() => {
    if (!bars.length) return [];
    const first = bars[0].time;
    return arr(d?.sweeps).filter((s) => num(s?.at_ms) && (s.side === "sell_side" || s.side === "buy_side")).map((s) => {
      const t = Math.floor(s.at_ms / 900_000) * 900;
      return { time: t, above: s.side === "buy_side", color: s.side === "buy_side" ? T.bearFill : T.bullFill };
    }).filter((m) => m.time >= first && bars.some((b) => b.time === m.time));
  }, [d?.sweeps, bars]);
  const fit = useMemo(() => (mark.show ? [...levels.flatMap((l) => [l.low, l.high]), ...management.flatMap((m) => [m.low, m.high])] : []), [levels, management, mark.show]);
  const atr = d?.atr_m15;
  const at = d?.state?.at_ms;
  const body = (() => {
    if (!available) return <Empty when="Lens B writes them each minute while the market is open.">No levels yet</Empty>;
    if (basis == null) return <Empty when="the broker-to-feed basis is unknown">Levels hidden</Empty>;
    if (!mark.show) return <Empty when="The last good liquidity read is older than 2 hours.">Levels hidden</Empty>;
    if (!levels.length) return <Empty when="Lens B finds no pool, HVN or sweep near the price this minute.">No levels yet</Empty>;
    return (
      <>
        <Row>
          <Badge tone="plain">{basisText(basis)}</Badge>
          <Badge tone="plain">ATR (15m) {num(atr) ? atr.toFixed(2) : "—"} · feed scale</Badge>
        </Row>
        {/* Lens B's own levels in the management set are its rows already: the table adds the key zones. */}
        <LevelsTable levels={levels} raw={arr(d?.levels)} management={management.filter((m) => m.source === "key_level")} last={last} atr={atr} />
        <div className="text-[11px] leading-normal text-muted">ATR distance: from the level's middle to the last close, {price(last)} {SCALE.feed}</div>
        {d?.management == null ? <Empty>Management levels not in this answer</Empty> : null}
      </>
    );
  })();
  return (
    <Panel title="Levels on the chart" icon={<CandlestickChart className="h-3.5 w-3.5 text-cyan-300" />} poll={polls.liquidity} live
      right={<span className="flex flex-wrap items-center gap-2"><ZonesToggle on={zonesOn} onToggle={onToggleZones} />{!polls.liquidity && num(at) ? <LiveTime ms={at} /> : null}</span>}>
      {ignored && levels.length && basis != null ? <div className="mb-2"><Badge tone={ignored.tone}>Omega ignores these levels ({ignored.reason})</Badge></div> : null}
      <IntelChart poll={polls.candles} bars={bars} zones={zones} markers={markers} fit={fit} label="15m candles on the feed scale with the liquidity bands" />
      {bars.length ? <ChartLegend management={management.some((m) => m.source === "key_level") && mark.show} /> : null}
      <div className="mt-3.5 flex flex-col gap-2">{body}</div>
    </Panel>
  );
}

// ---------------------------------------------------------------- panel 4: facts, last 24 hours

const M15 = 900_000;
const DAY = 96 * M15;

/** The facts chart of the last 24 hours, one SVG per width (the phone's with fewer time ticks). Pure. */
function FactsSvg({ readings, sweeps, phone, id, widen = null }: { readings: any[]; sweeps: any[]; phone: boolean; id: string; widen?: number | null }) {
  const W = phone ? 334 : 640, H = phone ? 200 : 230;
  const left = 30, right = 34, top = 10, bot = 34;
  const pw = W - left - right, ph = H - top - bot;
  const end = readings[readings.length - 1].at_ms as number;
  const start = end - DAY;
  const x = (t: number) => left + ((t - start) / (end - start)) * pw;
  const y = (v: number) => top + (1 - Math.max(0, Math.min(1, v))) * ph;
  const ys = (s: number) => top + (1 - Math.max(0, Math.min(4, s)) / 4) * ph;
  const runs = (pred: (r: any) => boolean) => {
    const out: any[][] = []; let cur: any[] = [];
    for (const r of readings) { if (pred(r)) cur.push(r); else if (cur.length) { out.push(cur); cur = []; } }
    if (cur.length) out.push(cur);
    return out;
  };
  // A gap where a reading is unavailable or its minute excluded; hatched "closed" over the daily break and the rollover.
  const excluded = (r: any) => str(r?.excluded) != null || r?.available === false;
  const closed = (r: any) => r?.excluded === "market_paused" || r?.excluded === "rollover_quarantine" || (r?.available === false && marketClosedAt(r.at_ms));
  const lines = (key: string, f: (v: number) => number) => runs((r) => !excluded(r) && num(r?.[key])).map((seg) => seg.map((r) => `${x(r.at_ms).toFixed(1)},${f(r[key]).toFixed(1)}`).join(" "));
  const ticks = (phone ? [16, 48, 80] : [8, 24, 40, 56, 72, 88]).map((k) => start + k * M15);
  const local = (t: number) => { const u = utcDayTime(t).slice(0, 3), l = localDayTime(t); return l.slice(0, 3) !== u ? l : localTime(t); };
  const wide = num(widen) && widen > 0 && widen <= 4 ? widen : null;
  return (
    <svg role="img" aria-label="Tick volume percentile, 15m volume percentile and spread against the hour's median, last 24 hours" viewBox={`0 0 ${W} ${H}`} className={clsx("block h-auto w-full", phone ? "sm:hidden" : "hidden sm:block")} style={{ fontFamily: "ui-monospace, JetBrains Mono, monospace" }}>
      <defs><pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.5" height="5" fill={rgba(T.offFill, 0.25)} /></pattern></defs>
      {runs(closed).map((seg, i) => { const a = x(seg[0].at_ms) - 2, b = x(seg[seg.length - 1].at_ms) + 2; return <g key={`c${i}`}><rect x={a} y={top} width={b - a} height={ph} fill={`url(#${id})`} stroke="rgba(255,255,255,0.06)" /><text x={(a + b) / 2} y={top + 10} fontSize="9" fill={T.off} textAnchor="middle">closed</text></g>; })}
      {runs((r) => !excluded(r) && r?.thin === true).map((seg, i) => { const a = x(seg[0].at_ms) - 2, b = x(seg[seg.length - 1].at_ms) + 2; return <g key={`t${i}`}><rect x={a} y={top} width={b - a} height={ph} fill={rgba(T.offFill, 0.14)} /><text x={(a + b) / 2} y={top + 10} fontSize="9" fill={T.off} textAnchor="middle">thin</text></g>; })}
      {[0, 0.5, 1].map((v) => <g key={v}><line x1={left} x2={left + pw} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.05)" /><text x={left - 5} y={y(v) + 3} fontSize="9" fill={T.fg2} textAnchor="end">{v * 100}</text></g>)}
      {[1, 2, 3, 4].map((s) => <text key={s} x={left + pw + 5} y={ys(s) + 3} fontSize="9" fill={s === wide ? T.late : T.fg2}>{s}x</text>)}
      {/* The mode's spread_widen (conditions.spread.widen, B16): a dashed amber line on the spread axis, only with that field. */}
      {wide != null ? <line x1={left} x2={left + pw} y1={ys(wide)} y2={ys(wide)} stroke={T.lateFill} strokeWidth="1" strokeDasharray="4 3" /> : null}
      {wide != null && ![1, 2, 3, 4].includes(wide) ? <text x={left + pw + 5} y={ys(wide) + 3} fontSize="9" fill={T.late}>{Number(wide.toFixed(2))}x</text> : null}
      <text x={left - 4} y={top + ph + 13} fontSize="8" fill={T.muted} textAnchor="end">UTC</text>
      <text x={left - 4} y={top + ph + 24} fontSize="8" fill={T.muted} textAnchor="end">{zoneLabel(end)}</text>
      {ticks.map((t) => <g key={t}><text x={x(t)} y={top + ph + 13} fontSize="9" fill={T.fg2} textAnchor="middle">{utcTime(t)}</text><text x={x(t)} y={top + ph + 24} fontSize="9" fill={T.muted} textAnchor="middle">{local(t)}</text></g>)}
      {lines("spread_ratio", ys).map((p, i) => <polyline key={`s${i}`} points={p} fill="none" stroke={T.fg2} strokeWidth="1" strokeDasharray="1 2.5" strokeLinecap="round" />)}
      {lines("vol_pctl_15m", y).map((p, i) => <polyline key={`q${i}`} points={p} fill="none" stroke={T.fg2} strokeWidth="1.25" />)}
      {lines("vol_pctl", y).map((p, i) => <polyline key={`v${i}`} points={p} fill="none" stroke={T.fg} strokeWidth="1.5" />)}
      {readings.filter((r) => !excluded(r) && r?.vol_spike === true && num(r?.vol_pctl)).map((r) => <circle key={`k${r.at_ms}`} cx={x(r.at_ms)} cy={y(r.vol_pctl)} r="3" fill={T.lateFill} />)}
      {readings.filter((r) => !excluded(r) && r?.spread_spike === true && num(r?.spread_ratio)).map((r) => <circle key={`w${r.at_ms}`} cx={x(r.at_ms)} cy={ys(r.spread_ratio)} r="2.5" fill="none" stroke={T.lateFill} strokeWidth="1.25" />)}
      {sweeps.filter((s) => num(s?.at_ms) && s.at_ms >= start && s.at_ms <= end && (s.side === "sell_side" || s.side === "buy_side")).map((s, i) => (
        <text key={`w${s.at_ms}${s.side}${i}`} x={x(s.at_ms)} y={top + ph - 3} fontSize="10" fill={s.side === "sell_side" ? T.bull : T.bear} textAnchor="middle">{s.side === "sell_side" ? "▲" : "▼"}</text>
      ))}
    </svg>
  );
}

/**
 * The facts chart's legend. With B16's conditions it names the mode's thresholds (spread.widen, activity.spike_pctl,
 * depth.thin_pctl; "thresholds of the intraday mode") and the chart draws the widen line; without them, the marks are
 * the facts' own flags and no threshold is named.
 */
function FactsLegend({ mode, c }: { mode: string | null; c: any }) {
  const sw = (props: SVGProps<SVGLineElement>) => <svg aria-hidden="true" width="18" height="6" viewBox="0 0 18 6"><line x1="0" x2="18" y1="3" y2="3" {...props} /></svg>;
  const widen = num(c?.spread?.widen) && c.spread.widen > 0 ? c.spread.widen : null;
  const spike = num(c?.activity?.spike_pctl) ? c.activity.spike_pctl : null;
  const thin = num(c?.depth?.thin_pctl) ? c.depth.thin_pctl : null;
  const cmode = str(c?.mode);
  return (
    <div className="mb-2 flex flex-wrap gap-x-3.5 gap-y-1.5 text-[11px] text-fg-2">
      <Item swatch={sw({ stroke: T.fg, strokeWidth: 1.5 })}>Tick volume percentile</Item>
      <Item swatch={sw({ stroke: T.fg2, strokeWidth: 1.25 })}>15m volume percentile</Item>
      <Item swatch={sw({ stroke: T.fg2, strokeWidth: 1.25, strokeDasharray: "1 2.5" })}>Spread vs the hour's median (right axis)</Item>
      {widen != null ? <Item swatch={sw({ stroke: T.lateFill, strokeWidth: 1, strokeDasharray: "4 3" })}>Spread {timesText(widen)} (widened)</Item> : null}
      <Item swatch={<svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="2.6" fill="none" stroke={T.lateFill} strokeWidth="1.25" /></svg>}>{widen != null ? `Spread above ${timesText(widen)}` : "Spread widened"}</Item>
      <Item swatch={<span aria-hidden="true" className="inline-block h-[7px] w-[7px] rounded-full bg-late-fill" />}>{spike != null ? `Spike, ${pctl(spike)} or more` : "Volume spike"}</Item>
      <Item swatch={<Swatch style={{ background: rgba(T.offFill, 0.25) }} />}>{thin != null ? `Thin, ${pctl(thin)} or less` : "Thin"}</Item>
      <Item swatch={<Swatch style={HATCH} />}>Closed: daily break and rollover</Item>
      <Item swatch={<span><span className="text-bull">▲</span><span className="text-bear">▼</span></span>}>Sweep</Item>
      {cmode && (widen != null || spike != null || thin != null) ? <span className="text-muted">thresholds of the {cmode} mode</span> : mode ? <span className="text-muted">as lens B flags them in the {mode} mode</span> : null}
    </div>
  );
}

const TONE_TEXT: Record<string, string> = { fault: "text-fault", late: "text-late" };

/**
 * Lens B's conditions (backend B16, /api/liquidity `conditions`): spread, depth and activity in words with their ratio or
 * percentile (a status tone only on a warning, conditionTone), the session and the levels in one line each, then the
 * mode, the baseline and the time once, quietly; stale (older than 15 minutes) in the late tone with its age.
 */
function ConditionsBlock({ c, now, need }: { c: any; now: number; need: number }) {
  const at = num(c?.at_ms) ? c.at_ms : null;
  const age = at != null ? now - at : null;
  const stale = c?.stale === true || (age != null && age > STATE_FRESH_MS);
  const baseline = str(c?.baseline);
  const weeks = num(c?.baseline_weeks) ? c.baseline_weeks : null;
  const meta = [str(c?.mode) ? `${c.mode} mode` : null, baseline ? `baseline ${baseline}${baseline !== "sufficient" && weeks != null ? `, ${weeks} of ${need} weeks` : ""}` : null].filter(Boolean).join(" · ");
  return (
    <div className="mb-3 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-fg">
        {(["spread", "depth", "activity"] as const).map((k) => {
          const tone = conditionTone(k, c?.[k]?.state);
          return <span key={k} className={tone ? TONE_TEXT[tone] : undefined}>{conditionText(k, c?.[k])}</span>;
        })}
      </div>
      <div className="text-[12px] text-fg-2">{sessionText(c?.session)}</div>
      <div className="text-[12px] text-fg-2">{levelsText(c?.levels)}</div>
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
        {meta ? <span>{meta}</span> : null}
        {at != null ? <span className="mono whitespace-nowrap text-fg-2">{clockPair(at)}</span> : null}
        {stale ? <span className="text-late">stale{age != null ? ` ${ageText(age)}` : ""}</span> : null}
      </div>
    </div>
  );
}

/** The words the 15m and 1H risk desks and moderators read (conditions.line), or why the rooms are not reading them. */
function RoomsLine({ c }: { c: any }) {
  const line = str(c?.line);
  if (!line) return null;
  const note = roomsNote(c);
  return (
    <div className="mt-3 flex flex-col gap-1 border-t border-white/5 pt-2.5">
      <span className="text-[11px] text-muted">{note ?? "What the rooms read"}</span>
      <p className="text-[12px] leading-snug text-fg-2">{line}</p>
    </div>
  );
}

const BASIS_WORDS: Record<string, string> = {
  hour_of_week: "percentile basis: hour of the week",
  rolling_hour_of_day: "percentile basis: same New York hour, rolling (baseline insufficient)",
  rolling_all: "percentile basis: every hour, rolling (baseline insufficient)"
};

/** Facts unavailable: the market closed (the weekend, the daily break), the archive stale, or no bars yet. */
export function factsGone(d: any, now: number): { title: string; when: string; chip: ReactNode } | null {
  const f = obj(d?.facts);
  if (!f || f.available === true) return null;
  const at = num(d?.state?.at_ms) ? d.state.at_ms : now;
  if (marketClosedAt(at)) return { title: "Market closed", when: `Facts resume ${openText(nextOpenMs(at))}.`, chip: <Badge tone="off">market closed</Badge> };
  if (f.reason === "archive_stale") {
    const last = Date.parse(String(f.minute_at ?? ""));
    const age = Number.isFinite(last) ? Math.round((at - last) / 60_000) : null;
    return { title: "No recent broker bars", when: `The newest broker M1 bar is ${age != null ? `${age} minutes` : "more than 30 minutes"} old; facts resume with the next bar.`, chip: <Badge tone="late">{age != null ? `archive ${age}m old` : "archive stale"}</Badge> };
  }
  return { title: "No broker bars yet", when: "Facts start with Omega's first broker M1 bars.", chip: <Badge tone="off">no broker bars</Badge> };
}

function FactsPanel({ d, now, polls }: { d: any; now: number; polls: Polls }) {
  const f = obj(d?.facts);
  // Lens B's conditions (B16): null while its facts are unavailable (then factsGone's Empty says why).
  const c = obj(d?.conditions);
  const gone = factsGone(d, now);
  const readings = arr(d?.readings).filter((r) => num(r?.at_ms)).sort((a, b) => a.at_ms - b.at_ms);
  const at = d?.state?.at_ms;
  const body = (() => {
    if (gone) return <Empty when={gone.when}>{gone.title}</Empty>;
    if (!f) return <Empty when="Lens B writes them each minute while the market is open.">No facts yet</Empty>;
    return (
      <>
        {c ? (
          <>
            <ConditionsBlock c={c} now={now} need={num(d?.baseline?.sufficient_weeks) ? d.baseline.sufficient_weeks : 4} />
            {str(f.basis) ? <Row className="mb-2.5"><Badge tone="plain">{BASIS_WORDS[f.basis] ?? `percentile basis: ${words(f.basis)}`}</Badge></Row> : null}
          </>
        ) : (
        <Row className="mb-2.5">
          <Badge tone={f.vol_spike ? "late" : "plain"}>tick volume {pctl(f.vol_pctl)}{f.vol_spike ? " · spike" : ""}</Badge>
          <Badge tone={f.thin ? "off" : "plain"}>15m volume {pctl(f.vol_pctl_15m)}{f.thin ? " · thin" : ""}</Badge>
          <Badge tone={f.spread_spike ? "late" : "plain"}>{num(f.spread_ratio) ? `spread ${f.spread_ratio}x the hour's median${f.spread_spike ? " · widened" : ""}` : "spread unmeasured"}</Badge>
          {str(f.basis) ? <Badge tone="plain">{BASIS_WORDS[f.basis] ?? `percentile basis: ${words(f.basis)}`}</Badge> : null}
          {str(f.excluded) ? <Badge tone="off">excluded minute ({words(f.excluded)})</Badge> : null}
        </Row>
        )}
        {!c ? <div className="mb-2.5"><Empty when="The AI Worker gives none while lens B has no available facts.">No conditions yet</Empty></div> : null}
        <FactsLegend mode={str(d?.state?.mode)} c={c} />
        {readings.length ? (
          <>
            <FactsSvg readings={readings} sweeps={arr(d?.sweeps)} phone={false} id="liq-hatch-wide" widen={c?.spread?.widen} />
            <FactsSvg readings={readings} sweeps={arr(d?.sweeps)} phone id="liq-hatch-phone" widen={c?.spread?.widen} />
          </>
        ) : <Empty when="The ledger step records one every 5 minutes while the market is open.">No readings in the last 24 hours</Empty>}
        {c ? <RoomsLine c={c} /> : null}
      </>
    );
  })();
  return (
    <Panel title="Facts, last 24 hours" icon={<Activity className="h-3.5 w-3.5 text-cyan-300" />} poll={polls.liquidity} live className="h-full"
      right={gone ? <span className="flex items-center gap-2">{gone.chip}{!polls.liquidity && num(at) ? <LiveTime ms={at} /> : null}</span> : !polls.liquidity && num(at) ? <LiveTime ms={at} /> : undefined}>
      {body}
    </Panel>
  );
}

// ---------------------------------------------------------------- panel 5: sweeps and outcomes

const OUTCOME_TONE: Record<string, Tone> = { hit: "ok", miss: "fault", neutral: "off", pending: "plain" };
/** "Scored": counted in the score (a hit or a miss in its window), a neutral never, a pending sweep not yet. */
export const scoredText = (s: any): string => (s?.scored === true ? "counted" : s?.outcome === "pending" || s?.outcome == null ? "not yet" : "not counted");

function SweepsPanel({ d, polls }: { d: any; polls: Polls }) {
  const sweeps = arr(d?.sweeps).filter((s) => num(s?.at_ms)).sort((a, b) => b.at_ms - a.at_ms).slice(0, 50);
  const td = "mono border-b border-white/5 px-1.5 py-1.5 align-top text-[12px] text-slate-300";
  const th = "border-b border-white/10 px-1.5 py-2 text-left align-bottom text-[11px] font-medium text-muted";
  return (
    <Panel title="Sweeps and outcomes" icon={<Target className="h-3.5 w-3.5 text-cyan-300" />} poll={polls.liquidity} right={<Badge tone="plain">last 50</Badge>} className="h-full">
      {!sweeps.length ? <Empty when="A sweep shows once a wick is reclaimed on a volume spike within the mode's lookback.">No sweep yet</Empty> : (
        <table className="w-full border-collapse">
          <thead><tr><th scope="col" className={th}>Time</th><th scope="col" className={th}>Side<br />volume percentile</th><th scope="col" className={th}>Outcome<br />scored · replay</th></tr></thead>
          <tbody>
            {sweeps.map((s, i) => {
              const o = str(s.outcome) ?? "pending";
              return (
                <tr key={`${s.at_ms}-${i}`}>
                  <td className={td}>{utcDayTime(s.at_ms)} UTC<br /><Muted>{localDayTime(s.at_ms)} {zoneLabel(s.at_ms)}</Muted></td>
                  <td className={td}>{s.side === "sell_side" ? <span className="text-bull">▲ sell-side</span> : s.side === "buy_side" ? <span className="text-bear">▼ buy-side</span> : <span>· {words(s.side)}</span>}<br /><Muted>{pctl(s.vol_pctl)}</Muted></td>
                  <td className={td}><Badge tone={OUTCOME_TONE[o] ?? "plain"}>{words(o)}</Badge><br /><Muted>{scoredText(s)}</Muted>{s.replay === true ? <><br /><Muted>replay</Muted></> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- panel 6: the baseline per New York hour of the week

/** The archive's one-time backfill: done ok, copied with the rebuild pending late, failed fault, none off. */
function BackfillChip({ b }: { b: Record<string, any> }) {
  const added = num(b.added) ? ` · ${b.added.toLocaleString("en-US")} bars` : "";
  if (b.status === "done") return <Badge tone="ok">backfill done{added}</Badge>;
  if (b.status === "backfilled") return <Badge tone="late">backfill copied · rebuild pending</Badge>;
  if (b.status === "failed") return <Badge tone="fault">backfill failed</Badge>;
  return <Badge tone="off">no backfill</Badge>;
}

const HATCH: CSSProperties = { backgroundImage: `repeating-linear-gradient(135deg, ${rgba(T.offFill, 0.25)} 0px, ${rgba(T.offFill, 0.25)} 1.5px, transparent 1.5px, transparent 5px)`, border: `1px solid ${T.borderSoft}` };
const cellStyle = (w: number | null): CSSProperties =>
  w == null ? HATCH : w >= 4 ? { background: rgba(T.okFill, 0.42) } : w >= 1 ? { background: rgba(T.lateFill, 0.5), color: "white" } : { background: rgba(T.offFill, 0.2), border: `1px solid ${rgba(T.offFill, 0.35)}`, color: T.fg };

function BaselinePanel({ d, now }: { d: any; now: number }) {
  const b = obj(d?.baseline);
  // Each New York hour of the week's weeks of data (baseline.hours[i].weeks, i = the hour of the week); null where gold
  // is closed (hatched), whatever the entry says.
  const hours: (number | null)[] = Array.from({ length: 168 }, (_, i) => { const e = arr(b?.hours).find((x) => x?.hour === i) ?? b?.hours?.[i]; return closedHour(i) ? null : num(e?.weeks) ? e.weeks : 0; });
  const counts = { ok: hours.filter((w) => w != null && w >= 4).length, late: hours.filter((w) => w != null && w >= 1 && w < 4).length, zero: hours.filter((w) => w === 0).length, closed: hours.filter((w) => w == null).length };
  const nowHow = nyHourOfWeek(now);
  const ny = nyClock(now);
  const backfill = obj(d?.state?.backfill);
  const updated = b?.updated_ms;
  const right = b ? (
    <span className="flex flex-wrap items-center gap-1.5">
      {baselineChip(b)}
      {backfill ? <BackfillChip b={backfill} /> : null}
      {num(updated) ? <Badge tone="plain">updated {clockPair(updated)}</Badge> : null}
    </span>
  ) : undefined;
  const sq = (st: CSSProperties) => <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-[2px]" style={{ boxSizing: "border-box", ...st }} />;
  return (
    <Panel title="Baseline per New York hour of the week" icon={<Grid3x3 className="h-3.5 w-3.5 text-cyan-300" />} right={right}>
      {!b || !Array.isArray(b.hours) ? <Empty when="The ledger step builds it hourly from the broker's M1 archive.">No baseline yet</Empty> : (
        <>
          <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-[11px] text-fg-2">
            <Item swatch={sq(cellStyle(4))}>4 weeks or more <span className="mono text-ok">{counts.ok}</span></Item>
            <Item swatch={sq(cellStyle(2))}>1–3 weeks <span className="mono text-late">{counts.late}</span></Item>
            <Item swatch={sq(cellStyle(0))}>no data <span className="mono text-off">{counts.zero}</span></Item>
            <Item swatch={sq(HATCH)}>closed <span className="mono">{counts.closed}</span></Item>
            <Item swatch={sq({ outline: `1.5px solid ${T.fg}`, outlineOffset: -1 })}>now, {WEEKDAYS[ny.wd]} {String(ny.hour).padStart(2, "0")}:00 New York</Item>
          </div>
          <div className="mt-2.5 grid grid-cols-[26px_repeat(24,minmax(0,1fr))] items-center gap-px sm:grid-cols-[34px_repeat(24,minmax(0,1fr))] sm:gap-0.5">
            <div />
            {Array.from({ length: 24 }, (_, h) => <div key={h} className="mono h-3 text-[9px] text-fg-2">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</div>)}
            {WEEKDAYS.map((day, di) => [
              <div key={day} className="mono text-[10px] text-fg-2">{day}</div>,
              ...Array.from({ length: 24 }, (_, h) => {
                const i = di * 24 + h, w = hours[i];
                const tip = `${day} ${String(h).padStart(2, "0")}:00 New York · ${w == null ? "closed" : `${w} week${w === 1 ? "" : "s"}`}`;
                return (
                  <div key={`${day}${h}`} title={tip} className="mono flex h-2.5 items-center justify-center rounded-[2px] text-[9px] font-semibold sm:h-5" style={{ boxSizing: "border-box", ...cellStyle(w), ...(i === nowHow ? { outline: `1.5px solid ${T.fg}`, outlineOffset: -1 } : {}) }}>
                    {w != null && w < 4 ? <><span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-current sm:hidden" /><span className="hidden sm:inline">{w}</span></> : null}
                  </div>
                );
              })
            ])}
          </div>
          <div className="mt-2.5 text-[11px] leading-normal text-muted">
            Rows: day of the week. Columns: New York hour, {nyZoneText(now)} on {WEEKDAYS[ny.wd]} {ny.date}. Sufficient once every trading hour has 4 weeks.
          </div>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- panel 7: what it changed in Omega

function EffectsTable({ rows }: { rows: { action: string; why: string; n: ReactNode; out: ReactNode }[] }) {
  const td = "border-b border-white/5 px-2.5 py-1.5 align-top text-[12px] text-slate-300";
  const th = "whitespace-nowrap border-b border-white/10 px-1.5 py-2 text-left text-[11px] font-medium text-muted";
  return (
    <>
      <table className="hidden w-full border-collapse sm:table">
        <thead><tr><th scope="col" className={th}>Change</th><th scope="col" className={th}>Why</th><th scope="col" className={clsx(th, "text-right")}>7 days</th><th scope="col" className={th}>Outcomes</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.action}><td className={clsx(td, "mono whitespace-nowrap")}>{r.action}</td><td className={clsx(td, "mono text-fg-2")}>{r.why}</td><td className={clsx(td, "mono text-right")}>{r.n}</td><td className={td}>{r.out}</td></tr>)}</tbody>
      </table>
      <table className="w-full border-collapse sm:hidden">
        <thead><tr><th scope="col" className={th}>Change</th><th scope="col" className={clsx(th, "text-right")}>7 days</th><th scope="col" className={th}>Outcomes</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.action}><td className={clsx(td, "mono max-w-[170px]")}>{r.action}<br /><Muted>{r.why}</Muted></td><td className={clsx(td, "mono text-right")}>{r.n}</td><td className={td}>{r.out}</td></tr>)}</tbody>
      </table>
    </>
  );
}

/** The effects of the last 7 days (the view sends up to 50 a kind, 14 days). */
const EFFECTS_MS = 7 * 86_400_000;
const recent = (list: unknown, now: number): any[] => arr(list).filter((r) => num(r?.at_ms) && r.at_ms > now - EFFECTS_MS && r.at_ms <= now + 60_000);
/** Outcome counts of effect rows: { hit, miss, neutral, pending }. */
export function outcomeCounts(rows: any[]): Record<string, number> {
  const out: Record<string, number> = { hit: 0, miss: 0, neutral: 0, pending: 0 };
  for (const r of rows) { const o = str(r?.outcome); out[o && o in out ? o : "pending"] += 1; }
  return out;
}
/** No row of a kind in the window. */
const NoneIn7 = () => <span className="whitespace-nowrap text-fg-2">none in 7 days</span>;
/**
 * The outcomes of effect rows as chips: hit ok, miss fault, neutral off, and pending plain (B8's outcomeOf reads
 * anything else, a NULL included, as "pending": not yet scored, never a miss).
 */
function OutcomeChips({ rows }: { rows: any[] }) {
  if (!rows.length) return <NoneIn7 />;
  const c = outcomeCounts(rows);
  const scored = c.hit + c.miss + c.neutral;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {scored ? <Outcomes o={c} /> : null}
      {c.pending ? <Badge tone="plain">{c.pending} pending</Badge> : null}
    </span>
  );
}
/** A Position Manager action in words; no order word (lens B never places one). */
const PM_ACTION: Record<string, string> = { sl: "protective level moved", tp: "target moved", close: "closed", hold: "held" };
const STATUS_TONE: Record<string, Tone> = { applied: "ok", held: "late", pending: "late", failed: "fault", rejected: "fault" };
/** Rows grouped by `key`: one row per value with its count and its statuses (or outcomes) as chips. */
function grouped(rows: any[], key: (r: any) => string, why: string, by: "status" | "outcome") {
  const groups = new Map<string, any[]>();
  for (const r of rows) { const k = key(r); groups.set(k, [...(groups.get(k) ?? []), r]); }
  return [...groups.entries()].map(([action, list]) => ({
    action, why, n: list.length,
    out: by === "outcome" ? <OutcomeChips rows={list} /> : (
      <span className="inline-flex flex-wrap gap-1">
        {[...new Set(list.map((r) => str(r?.status) ?? "recorded"))].map((st) => <Badge key={st} tone={STATUS_TONE[st] ?? "plain"}>{list.filter((r) => (str(r?.status) ?? "recorded") === st).length} {words(st)}</Badge>)}
      </span>
    )
  }));
}

/**
 * B19's level moves: the protective locks Omega moved to a lens B level (src/liquidity-lens.mjs scoreLevelHold:
 * LEVEL_HOLD_BARS_15M 8 closed 15m bars, LEVEL_HOLD_ATR 0.1). No order word (the page forbids them).
 */
export const LEVEL_MOVES_HINT = "Each row is a protective lock Omega moved to a lens B level; hit = no 15m close beyond it by more than 0.1 × ATR15 for 2 hours (8 closed bars), miss = one did, neutral = no ATR or bars missing. Target moves are not recorded.";
/** "Mon 09:20 NY" and "14:20 UTC · 21:20 GMT+7": New York first, as the Opening range page writes it. */
export const nyDayTime = (ms: number): string => { const c = nyClock(ms); return `${WEEKDAYS[c.wd] ?? ""} ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")} NY`.trim(); };
const utcGmt7 = (ms: number): string => `${utcTime(ms)} UTC · ${gmt7ClockOf(ms)} GMT+7`;
/** A move's side, the position's: long ▲ bullish, short ▼ bearish (sideWord BUY / SELL). */
function MoveSide({ side }: { side: unknown }) {
  if (side === "BUY") return <span className="text-bull">▲ long</span>;
  if (side === "SELL") return <span className="text-bear">▼ short</span>;
  return <span className="text-fg-2">—</span>;
}
/** An outcome word: hit, miss or neutral, anything else pending (B8's outcomeOf). */
const outcomeWord = (o: unknown): string => { const s = str(o); return s === "hit" || s === "miss" || s === "neutral" ? s : "pending"; };
/** The outcome counts of a group, neutral chips only: an outcome is never green or red. */
function NeutralCounts({ rows }: { rows: any[] }) {
  const c = outcomeCounts(rows);
  return <span className="inline-flex flex-wrap gap-1">{(["hit", "miss", "neutral", "pending"] as const).filter((k) => c[k] > 0).map((k) => <Badge key={k} tone="plain">{c[k]} {k}</Badge>)}</span>;
}
/** The level moves, grouped by action as they arrive (newest first): the group's count and outcomes, then each move. */
function LevelMovesTable({ rows }: { rows: any[] }) {
  const groups = new Map<string, any[]>();
  for (const r of [...rows].sort((a, b) => b.at_ms - a.at_ms)) { const k = words(r?.action ?? r?.kind ?? "level"); groups.set(k, [...(groups.get(k) ?? []), r]); }
  const td = "mono border-b border-white/5 px-1.5 py-1.5 align-top text-[12px] text-slate-300 sm:px-2.5";
  const th = "whitespace-nowrap border-b border-white/10 px-1.5 py-2 text-left align-bottom text-[11px] font-medium text-muted";
  return (
    <table className="w-full border-collapse">
      <thead><tr><th scope="col" className={th}>Time</th><th scope="col" className={th}>Side<br />mode</th><th scope="col" className={th}>Outcome</th></tr></thead>
      {[...groups.entries()].map(([action, list]) => (
        <tbody key={action}>
          <tr>
            <th scope="rowgroup" colSpan={3} className="border-b border-white/10 px-1.5 pb-1.5 pt-2.5 text-left font-normal sm:px-2.5">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                <span className="mono font-semibold text-fg">{action}</span>
                <span className="mono text-fg-2">{list.length}</span>
                <span className="mono text-muted">past a lens B level</span>
                <NeutralCounts rows={list} />
              </span>
            </th>
          </tr>
          {list.map((m, i) => {
            const t = num(m?.at_ms) ? m.at_ms : null;
            return (
              <tr key={`${t}-${i}`}>
                <td className={td}>{t == null ? "—" : <>{nyDayTime(t)}<br /><span className="whitespace-nowrap text-[11px] text-muted">{utcGmt7(t)}</span></>}</td>
                <td className={td}><MoveSide side={m?.side} /><br /><Muted>{words(m?.mode)}</Muted></td>
                <td className={td}><Badge tone="plain">{outcomeWord(m?.outcome)}</Badge></td>
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}

/** LENS_LEVEL_READINGS off: no skip or hold reading is recorded or scored, with the way to the switch (Zones' off state). */
function LevelReadingsOff() {
  return (
    <div className="glass-inner flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3.5 py-2.5">
      <span className="min-w-0 text-[12px] text-off">Not recorded: LENS_LEVEL_READINGS is off.</span>
      <a href="/#/switches" className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-white/10 bg-white/4 px-2.5 text-[12px] font-medium text-fg transition hover:border-white/20 hover:bg-white/8 sm:h-8">
        <ToggleRight className="h-3.5 w-3.5 text-ok" aria-hidden="true" />Feature switches
      </a>
    </div>
  );
}

function EffectsPanel({ d, now }: { d: any; now: number }) {
  const e = obj(d?.effects);
  const blocks = recent(e?.blocks, now), makers = recent(e?.makers, now), skips = recent(e?.skips, now), deferrals = recent(e?.deferrals, now);
  const held = deferrals.reduce((n, x) => n + (num(x?.intents) ? x.intents : 0), 0);
  // B19 scores each skip once its outcome is known; while LENS_LEVEL_READINGS is off (level_moves null) none is scored.
  const skipScored = skips.some((x) => str(x?.outcome) != null);
  const readingsOff = e != null && e.level_moves == null;
  const skipOut = !skips.length ? <NoneIn7 /> : skipScored ? <OutcomeChips rows={skips} />
    : readingsOff ? <span className="inline-flex flex-wrap items-center gap-1"><Badge tone="plain">not scored</Badge><Muted>LENS_LEVEL_READINGS off</Muted></span>
    : <Empty when="Each skip is scored once its outcome is known.">Not scored yet</Empty>;
  const rows = e ? [
    { action: "block", why: "spread widened against the hour's median", n: blocks.length, out: <OutcomeChips rows={blocks} /> },
    { action: "deferral", why: "spread spike: an open position's level change held up to 10 min (closes never wait)", n: deferrals.length, out: deferrals.length ? <span className="inline-flex flex-wrap gap-1"><Badge tone="plain">not scored</Badge>{held ? <Muted>{held} change{held === 1 ? "" : "s"} held</Muted> : null}</span> : <NoneIn7 /> },
    { action: "maker", why: "15m thin · maker R against taker R", n: makers.length, out: <OutcomeChips rows={makers} /> },
    { action: "skip", why: "sweep against, last 15 min", n: skips.length, out: skipOut }
  ] : [];
  const sub = (t: string) => <div className="mt-1 text-[12px] font-semibold text-fg">{t}</div>;
  const moves = e?.level_moves == null ? null : recent(e.level_moves, now);
  const pm = e?.pm_actions == null ? null : recent(e.pm_actions, now);
  return (
    <Panel title="What it changed in Omega" icon={<GitBranch className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="plain">last 7 days</Badge>} className="h-full">
      {!e ? <Empty when="The bridge sync records each block, deferral, maker and skip choice.">No change yet</Empty> : (
        <>
          <EffectsTable rows={rows} />
          <div className="mt-3 flex flex-col gap-2">
            <div className="mt-1 flex items-center gap-1.5 text-[12px] font-semibold text-fg">Level moves<Hint text={LEVEL_MOVES_HINT} /></div>
            {moves == null ? <LevelReadingsOff /> : moves.length ? <LevelMovesTable rows={moves} /> : <Empty>No level move in the last 7 days.</Empty>}
            {sub("Position Manager actions")}
            {pm == null ? <Empty>Not in this answer</Empty> : pm.length ? <EffectsTable rows={grouped(pm, (r) => PM_ACTION[str(r?.action) ?? ""] ?? words(r?.action), "on a sweep against", "status")} /> : <Empty>No Position Manager action on a sweep in the last 7 days.</Empty>}
          </div>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- panel 8: in the latest decision

function Kv({ k, children, sub }: { k: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted">{k}</span><span className="mono text-[13px] text-fg">{children}</span>
      {sub ? <span className="text-balance text-[11px] text-muted">{sub}</span> : null}
    </div>
  );
}
const share2 = (x: unknown) => (num(x) ? x.toFixed(2) : "—");

const SIDE_TONE: Record<string, string> = { BULLISH: "text-bull", BEARISH: "text-bear", NEUTRAL: "text-neutral" };
const SIDE_GLYPH: Record<string, string> = { BULLISH: "▲", BEARISH: "▼", NEUTRAL: "·" };
/** The card's side: the contract's `side`, else the lean's sign. */
const sideOfCard = (c: any): string | null => {
  const s = str(c?.side);
  if (s && SIDE_TONE[s]) return s;
  return num(c?.lean) ? (c.lean > 0 ? "BULLISH" : c.lean < 0 ? "BEARISH" : "NEUTRAL") : null;
};
/** A sweep's side: sell-side reads bullish (green), buy-side bearish (red) (sweepFor's rule). */
const SWEEP: Record<string, { glyph: string; text: string; tone: string }> = {
  sell_side: { glyph: "▲", text: "sell-side", tone: "text-bull" },
  buy_side: { glyph: "▼", text: "buy-side", tone: "text-bear" }
};
const SmallClock = ({ label, ms }: { label: string; ms: number }) => <span className="whitespace-nowrap"><span className="text-muted">{label}</span> <span className="mono text-fg-2">{clockPair(ms)}</span></span>;

/**
 * The LIQUIDITY card (backend B15: /api/liquidity `card`, from the latest decision's decision.liquidity): lens B's
 * council-only card. counts is false, so it never counts toward the quorum; the card says so once, in words. Its weight
 * (min(0.06, 0.1 × lens_weight)), lean (0 or ±0.60, toned by `side`), the sweep it read and why it leans, in words with
 * the lean_reason code beside them. Stale (`stale`, or its time older than 15 minutes by this clock): the late tone and
 * no direction colour. `decisionClose` is the panel's own decision bar close: the card's bar shows only when it differs.
 */
function LiquidityCard({ card, now, decisionClose }: { card: any; now: number; decisionClose: number }) {
  const at = num(card?.at_ms) ? card.at_ms : null;
  const age = at != null ? now - at : null;
  const stale = card?.stale === true || (age != null && age > STATE_FRESH_MS);
  const side = sideOfCard(card);
  const tone = (t: string | undefined) => (stale ? "text-fg-2" : t);
  const lean = card?.lean;
  const sw = SWEEP[str(card?.sweep) ?? ""];
  const code = str(card?.lean_reason);
  const summary = cardSummary(card?.summary);
  const barClose = Date.parse(String(card?.bar_close ?? ""));
  const lensW = card?.lens_weight;
  return (
    <div className="glass-inner flex min-w-0 flex-[1_1_320px] flex-col gap-3 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mono text-[13px] font-semibold text-fg">LIQUIDITY</span>
        {stale ? <Badge tone="late">stale{age != null ? ` ${ageText(age)}` : ""}</Badge> : <Badge tone="ok">fresh{age != null ? ` ${ageText(age)}` : ""}</Badge>}
      </div>
      {card?.counts === false ? <div className="-mt-1.5 text-[12px] text-fg-2">Council only: it never counts toward the quorum.</div> : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(110px,100%),1fr))] gap-3">
        <Kv k="weight" sub={num(lensW) ? `a tenth of lens B's ${lensW.toFixed(2)}, at most ${LIQUIDITY_CARD_MAX.toFixed(2)}` : null}>{cardWeightText(card?.weight)}</Kv>
        <Kv k="lean">{num(lean) ? <span className={tone(side ? SIDE_TONE[side] : undefined)}>{side ? SIDE_GLYPH[side] : "·"} {signed(lean)}{side ? ` ${side.toLowerCase()}` : ""}</span> : "—"}</Kv>
        <Kv k="sweep" sub={sw && num(card?.sweep_age_min) ? `${card.sweep_age_min} min ago` : null}>{sw ? <span className={tone(sw.tone)}>{sw.glyph} {sw.text}</span> : "none"}</Kv>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] text-muted">reason</span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[13px] text-fg">{leanReasonText(code, card?.agreeing)}</span>
          {code ? <span className="mono text-[11px] text-muted">{code}</span> : null}
          {summary ? <Hint text={summary} /> : null}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {at != null ? <SmallClock label="made" ms={at} /> : null}
        {Number.isFinite(barClose) && barClose !== decisionClose ? <SmallClock label="decision" ms={barClose} /> : null}
        {num(card?.state_at_ms) ? <SmallClock label="lens B state" ms={card.state_at_ms} /> : null}
      </div>
    </div>
  );
}

function QuorumBlock({ title, q, needs, children, note }: { title: string; q: any; needs: unknown; children: ReactNode; note?: ReactNode }) {
  return (
    <>
      <div className={clsx("text-[12px] font-semibold text-fg", note ? "mb-1" : "mb-2.5")}>{title}</div>
      {note ? <div className="mb-2.5 text-[11px] text-fg-2">{note}</div> : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(84px,100%),1fr))] gap-3">
        <Kv k="long"><span className="text-bull">▲ {share2(q?.long_share)}</span></Kv>
        <Kv k="short"><span className="text-bear">▼ {share2(q?.short_share)}</span></Kv>
        <Kv k="neutral"><span className="text-neutral">· {share2(q?.neutral_share)}</span></Kv>
        <Kv k="needs above">{share2(needs)}</Kv>
        {children}
      </div>
    </>
  );
}

/** quorum_with_liquidity's check: which side's quorum would hold with the card added ("▲ long", "▼ short", "both sides", "no"). */
function metText(q: any): ReactNode {
  if (q?.long_met === true && q?.short_met === true) return "both sides";
  if (q?.long_met === true) return <span className="text-bull">▲ long</span>;
  if (q?.short_met === true) return <span className="text-bear">▼ short</span>;
  return q?.met === false || q?.long_met === false || q?.short_met === false ? "no" : q?.met === true ? "yes" : "—";
}

function DecisionPanel({ d, decision, now, polls }: { d: any; decision: any; now: number; polls: Polls }) {
  const dec = obj(decision?.decision);
  const close = Date.parse(String(dec?.bar_close ?? ""));
  const q = obj(dec?.quorum);
  const stance = str(dec?.stance);
  const qw = obj(d?.quorum_with_liquidity);
  const bias = str(qw?.bias);
  return (
    <Panel title="In the latest decision" icon={<Scale className="h-3.5 w-3.5 text-cyan-300" />} poll={polls.decision}
      right={Number.isFinite(close) ? <Badge tone="plain">decision {clockPair(close)}</Badge> : undefined}>
      <div className="flex flex-wrap items-stretch gap-3">
        {d?.card == null ? (
          <div className="min-w-0 flex-[1_1_300px]">
            <Empty when="None while the switch is off, lens B is off, floored or stale, or the decision came before the card (B15).">No LIQUIDITY card in the latest decision</Empty>
          </div>
        ) : <LiquidityCard card={d.card} now={now} decisionClose={close} />}
        <div className="glass-inner min-w-0 flex-[1_1_320px] p-3.5">
          {!q ? <Empty when="The Decision Engine decides at each 15m close.">No decision yet</Empty> : (
            <QuorumBlock title="Quorum" q={q} needs={num(q.share_needed_above) ? q.share_needed_above : dec?.rules?.quorum_min}>
              <Kv k="stance"><span className={stance === "BUY" ? "text-bull" : stance === "SELL" ? "text-bear" : "text-neutral"}>{stance ?? "—"}</span></Kv>
            </QuorumBlock>
          )}
          {qw ? (
            <div className="mt-3">
              <QuorumBlock title="Quorum with liquidity" q={qw} needs={num(qw.quorum_min) ? qw.quorum_min : qw.share_needed_above}
                note="Informational: the quorum with the LIQUIDITY card added at its weight. No gate reads it.">
                <Kv k="met" sub={num(qw.score) ? <>score <span className={clsx("mono", bias ? SIDE_TONE[bias] : undefined)}>{signed(qw.score)}</span></> : null}>{metText(qw)}</Kv>
              </QuorumBlock>
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- the view

export type Polls = { liquidity?: Poll; lens?: Poll; candles?: Poll; plane?: Poll; decision?: Poll };

/**
 * The Liquidity page from its five reads. Pure and null-safe: any body, any path null or any array empty renders (the
 * page render check). `now` is the wall clock (lens B's state is aged against it); `mark` is the liquidity read's
 * planMark (stale: the bands dimmed, their labels kept readable with " · stale 7m"; past 2 hours hidden).
 */
export function LiquidityView({ d, lens = null, decision = null, candles = null, plane = null, now = Date.now(), mark = LIVE, polls = {}, zonesOn = false, onToggleZones }: {
  d: any; lens?: any; decision?: any; candles?: any; plane?: any; now?: number; mark?: Mark; polls?: Polls; zonesOn?: boolean; onToggleZones?: () => void;
}) {
  if (!liquidityReady(d)) {
    return (
      <Page heading={<Heading />}>
        <Panel title="Liquidity" icon={<Droplets className="h-3.5 w-3.5 text-cyan-300" />}>
          {intelViewsOff(d) ? <Empty when="The Intelligence views are off on the AI Worker.">intel_views_off</Empty>
            : <Empty when="The ledger step writes lens B's state every 5 minutes.">No liquidity view yet</Empty>}
        </Panel>
      </Page>
    );
  }
  const ignored = ignoredWhy(d, lens, now);
  const at = d?.state?.at_ms;
  const old = stateOld(d, now);
  // state.on: lens B counts now (the switch on, above its floor, a fresh state with facts); off reads grey "lens B off".
  const on = d?.state?.on === true;
  const lensOff = ignored?.reason === "lens B off";
  const floored = ignored?.reason === "lens B at its floor";
  const basis = knownBasis(d?.scale);
  const chips = (
    <>
      <Badge tone={on ? "ok" : "off"}>{on ? "lens B on" : "lens B off"}</Badge>
      {baselineChip(d?.baseline ?? { status: d?.state?.baseline }, "baseline ")}
      <Badge tone={basis == null ? "late" : "plain"}>{basis == null ? "basis unknown" : basisText(basis)}</Badge>
      {num(at) ? <Badge tone={old ? "late" : "plain"}>{old ? `state ${ageText(now - at)} · Omega ignores it after 15m` : `state ${clockPair(at)}`}</Badge> : <Badge tone="off">no state yet</Badge>}
    </>
  );
  const lensRight = (
    <span className="flex flex-wrap items-center gap-1.5">
      <LensHeader d={lens} />
      {lensOff ? <Badge tone="off">lens B off</Badge> : floored ? <Badge tone="late">at floor</Badge> : old && num(at) ? <Badge tone="late">state {ageText(now - at)}</Badge> : null}
    </span>
  );
  return (
    <Page heading={<Heading chips={chips} />}>
      <div className="grid gap-4 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-8">
          <Panel title="Positioning & Liquidity analyst" icon={<Layers className="h-3.5 w-3.5 text-cyan-300" />} poll={polls.lens} live right={lensRight} className="h-full"
            hint="One analyst, two lenses: the CFTC positioning report and the broker's own tick volume and spread. Each weight moves per mode within its doctrine bound; a poor score drops it to the floor until Aether sends a newer value. Neither lens ever opens a position.">
            <LensView d={lens} liquidityNote={old && !lensOff ? <Badge tone="late">Omega ignores it after 15m</Badge> : null} />
          </Panel>
        </div>
        <div className="min-w-0 xl:col-span-4"><ScorePanel d={d} lens={lens} poll={polls.lens} /></div>
        <div className="min-w-0 xl:col-span-12">
          <LevelsPanel d={d} candles={candles} plane={plane} mark={mark} ignored={ignored} zonesOn={zonesOn} onToggleZones={onToggleZones} polls={polls} />
        </div>
        <div className="min-w-0 xl:col-span-7"><FactsPanel d={d} now={now} polls={polls} /></div>
        <div className="min-w-0 xl:col-span-5"><SweepsPanel d={d} polls={polls} /></div>
        <div className="min-w-0 self-start xl:col-span-7"><BaselinePanel d={d} now={now} /></div>
        <div className="min-w-0 self-start xl:col-span-5"><EffectsPanel d={d} now={now} /></div>
        <div className="min-w-0 xl:col-span-12"><DecisionPanel d={d} decision={decision} now={now} polls={polls} /></div>
      </div>
    </Page>
  );
}

function Page({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  return <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">{heading}{children}</div>;
}

// ---------------------------------------------------------------- the page (the polls)

const ZONES_KEY = "nexus.liquidityZones";

export default function Liquidity() {
  const R = LIQUIDITY_READS;
  // One poll per read (GET only, lib/intel.ts LIQUIDITY_READS): the page's only requests.
  const liquidity = usePoll(() => intelGet(R, "liquidity"), R.liquidity.everyMs);
  const lens = usePoll(() => intelGet(R, "lens"), R.lens.everyMs);
  const candles = usePoll(() => intelGet(R, "candles"), R.candles.everyMs);
  const plane = usePoll(() => intelGet(R, "plane"), R.plane.everyMs);
  const decision = usePoll(() => intelGet(R, "decision"), R.decision.everyMs);
  const [zonesOn, setZonesOn] = useState<boolean>(() => { try { return localStorage.getItem(ZONES_KEY) === "on"; } catch { return false; } });
  const toggle = () => setZonesOn((on) => { try { localStorage.setItem(ZONES_KEY, on ? "off" : "on"); } catch { /* per-viewer convenience */ } return !on; });
  // The liquidity read's planMark (as the War Room chart's plan): dimmed with " · stale 7m" while stale, hidden past 2
  // hours. A 1 s clock renders only when the mark changes; lens B's state age follows a 15 s wall clock.
  const facts = { hasData: liquidity.data != null, error: liquidity.error, lastOk: liquidity.lastOk, intervalMs: liquidity.intervalMs };
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
  if (liquidity.data == null) {
    return (
      <Page heading={<Heading />}>
        <Panel title="Liquidity" icon={<Droplets className="h-3.5 w-3.5 text-cyan-300" />} poll={liquidity}>
          <PollBody poll={liquidity} skeleton={4} empty={<Empty when="The ledger step writes lens B's state every 5 minutes.">No liquidity view yet</Empty>}>{null}</PollBody>
        </Panel>
      </Page>
    );
  }
  return <LiquidityView d={liquidity.data} lens={lens.data} decision={decision.data} candles={candles.data} plane={plane.data} now={now} mark={mark}
    polls={{ liquidity, lens, candles, plane, decision }} zonesOn={zonesOn} onToggleZones={toggle} />;
}
