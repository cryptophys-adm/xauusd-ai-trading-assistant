import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarDays, CandlestickChart, LineChart, Scale, Sunrise } from "lucide-react";
import clsx from "clsx";
import { Badge, Empty, Hint, Panel, PollBody } from "../components/ui";
import IntelChart, { barsOf, type IntelBar, type IntelMarker } from "../components/IntelChart";
import type { ChartLine } from "../lib/lines-primitive";
import type { ChartZone } from "../lib/zones-primitive";
import type { ChartBox } from "../lib/boxes-primitive";
import { usePoll, type Poll } from "../lib/usePoll";
import { PLAN_TICK_MS, localNow, markKey, planMark } from "../lib/pollState";
import { T, type Tone } from "../lib/tokens";
import { gmt7ClockOf } from "../lib/entryZone";
import { ORB_READS, PATTERN_BREAKER_MIN, ROLE_WORD, arr, intelGet, num, nyClock, nyOffsetHours, obj, pc, price, priceRange, roleOf, signed, str, utcTime, words } from "../lib/intel";

// Opening range (Intelligence, Track C4; owner 2026-11-22: "ketiganya dibuat panel visualisasi sendiri terpisah dalam
// Intelligence"), as the owner-approved mockup: the London and New York opening ranges of gold's 15m chart and the
// orb_breakout agent that trades their breakouts. Read-only, no arm control (arming stays on Strategy agents). Four
// reads, each polled once (lib/intel.ts ORB_READS, GET only): /api/orb (cryptophys.orb-view.v1, backend B14: the
// ranges, their breakouts, the agent's plans, its records per session and its recent setups), /api/strategy-agents
// (orb_breakout's status), /api/engine/decision (armed.ids and the selection's candidates) and the feed's 15m candles.
//
// OrbView is pure and null-safe (the page render check renders it over test/fixtures/nexus-intel/orb*.json and their
// variants). Every price is the feed's (scale.prices "feed") and says so; times are New York's (the session clock),
// then UTC and GMT+7. A session whose window is over is shown as it stood at its last bar (B14).

export const SCHEMA = "cryptophys.orb-view.v1";
/** A stale read's drawing: dimmed to this share of its strength (PriceChart's planMark). */
const DIM = 0.45;

export type Mark = ReturnType<typeof planMark>;
const LIVE: Mark = { show: true, dim: false, suffix: "", note: null };

/** A /api/orb body with a view in it. */
export const orbReady = (d: any): boolean => d != null && typeof d === "object" && (d.status === "ok" || d.schema === SCHEMA) && d.status !== "not_found";
/** The AI Worker's answer while INTEL_VIEWS is off. */
export const intelViewsOff = (d: any): boolean => d?.status === "not_found" && d?.reason === "intel_views_off";

// ---------------------------------------------------------------- sessions, sides and the rules

export const SESSIONS = ["london", "new_york"] as const;
export type SessionKey = (typeof SESSIONS)[number];
export const SESSION_NAME: Record<SessionKey, string> = { london: "London", new_york: "New York" };
const sessionKey = (x: unknown): SessionKey | null => (x === "london" || x === "new_york" ? x : null);
/** A variant's session: orb_london is London, orb_new_york New York. */
export const variantSession = (v: unknown): SessionKey | null => (v === "orb_london" ? "london" : v === "orb_new_york" ? "new_york" : null);
export const SIDES = ["long", "short"] as const;
export type SideKey = (typeof SIDES)[number];
const SIDE_WORD: Record<SideKey, string> = { long: "▲ long", short: "▼ short" };
const SIDE_GLYPH: Record<SideKey, string> = { long: "▲", short: "▼" };
const SIDE_TEXT: Record<SideKey, string> = { long: "text-bull", short: "text-bear" };
const SIDE_FILL: Record<SideKey, string> = { long: T.bullFill, short: T.bearFill };
const sideKey = (x: unknown): SideKey | null => (x === "long" || x === "short" ? x : null);

/** The agent's rules (B14 rules: AGENT_RULES.orb, ORB_READING_BANDS), these when the view carries none. */
export const ORB_RULES = { range_bars: 3, min_width_atr: 0.25, max_width_atr: 3.5, beyond_atr: 0.1, retest_atr: 0.15 } as const;
const rule = (d: any, k: keyof typeof ORB_RULES): number => (num(d?.rules?.[k]) ? d.rules[k] : ORB_RULES[k]);
/** The width gauge's scale: 0 to 4 ATR (1H), the band 0.25 to 3.5 inside it (the mockup's). */
export const GAUGE_MAX_ATR = 4;
/** The council's confidence floor (src/strategy-engine.mjs STRATEGY_PARAMS.min_confidence), when the decision has none. */
export const MIN_CONFIDENCE = 0.4;

const sessionOf = (d: any, k: SessionKey): any => obj(d?.sessions?.[k]);
const plansOf = (s: any): Record<SideKey, any> => ({ long: obj(s?.plans?.long), short: obj(s?.plans?.short) });
const hasPlan = (s: any): boolean => SIDES.some((x) => plansOf(s)[x] != null);

// ---------------------------------------------------------------- clocks: New York, UTC and GMT+7

const two = (n: number) => String(n).padStart(2, "0");
/** "03:00": New York's clock at an instant. */
export const nyTime = (ms: unknown): string => { if (!num(ms)) return "—"; const c = nyClock(ms); return `${two(c.hour)}:${two(c.minute)}`; };
const gmt7 = (ms: unknown): string => (num(ms) ? gmt7ClockOf(ms) : "—");
const utc = (ms: unknown): string => (num(ms) ? utcTime(ms) : "—");
/** "08:00–08:45 UTC · 15:00–15:45 GMT+7". */
const spanUtcGmt7 = (a: unknown, b: unknown): string => `${utc(a)}–${utc(b)} UTC · ${gmt7(a)}–${gmt7(b)} GMT+7`;
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Fri 20 Nov" from a New York date "2026-11-20". */
export function nyDateText(date: unknown): string {
  const m = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) return "—";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAY[d.getUTCDay()].slice(0, 3)} ${m[3]} ${MONTHS[d.getUTCMonth()]}`;
}
/** "15:00 UTC · 22:00 GMT+7". */
const clockUtcGmt7 = (ms: unknown): string => (num(ms) ? `${utcTime(ms)} UTC · ${gmt7ClockOf(ms)} GMT+7` : "—");

// ---------------------------------------------------------------- a session in words

/** A session's status in words, the code's details in the ⓘ (status_detail). */
export function statusWord(s: any): string {
  const st = str(s?.status);
  if (st === "range_event") {
    const t = Date.parse(String(arr(s?.events_in_range)[0]?.time ?? ""));
    return Number.isFinite(t) ? `range event (high-impact USD ${nyTime(t)} NY)` : "range event";
  }
  if (st === "session_clock_mismatch") {
    const summer = num(s?.open_ms) && nyOffsetHours(s.open_ms) === -4;
    return `clock mismatch (${summer ? "New York on summer time, London not" : "London on summer time, New York not"})`;
  }
  const W: Record<string, string> = { ok: "ok", not_formed: "forming", window_over: "window over", market_paused: "market paused", range_incomplete: "range incomplete", too_narrow: "too narrow", too_wide: "too wide" };
  return st ? W[st] ?? words(st) : "no status";
}
/** The status tones: ok cyan; not traded by an event, the clock or a missing bar amber; out of the band or over grey. */
export const STATUS_TONE: Record<string, Tone> = {
  ok: "ok", not_formed: "plain", range_event: "late", session_clock_mismatch: "late", range_incomplete: "late",
  too_narrow: "off", too_wide: "off", window_over: "off", market_paused: "off"
};
const statusTone = (s: any): Tone => STATUS_TONE[str(s?.status) ?? ""] ?? "plain";

/** "building 2 of 3 bars", "window · 9 bars left", "ended". */
export function phaseText(d: any, s: any): string {
  const ph = str(s?.phase);
  if (ph === "forming") return `building ${num(s?.bars_built) ? s.bars_built : 0} of ${rule(d, "range_bars")} bars`;
  if (ph === "live") return num(s?.bars_left) ? `window · ${s.bars_left} ${s.bars_left === 1 ? "bar" : "bars"} left` : "window";
  if (ph === "over") return "ended";
  return "—";
}

/** Why a session has no plan at all, in one line ("not traded: clock mismatch"), or null when its sides say it. */
export function noPlanLine(d: any, s: any): string | null {
  const st = str(s?.status);
  const NOT: Record<string, string> = {
    range_event: "not traded: an event inside the range", session_clock_mismatch: "not traded: clock mismatch",
    too_narrow: "not traded: the range is too narrow", too_wide: "not traded: the range is too wide",
    range_incomplete: "not traded: a bar of the range is missing", market_paused: "not traded: gold is not trading",
    window_over: "no plan: the window is over"
  };
  if (st === "not_formed") return `no plan until the range sets at ${nyTime(s?.range_end_ms)} NY`;
  if (st && st !== "ok") return NOT[st] ?? `not traded: ${words(st)}`;
  if (st === "ok" && sideKey(s?.breakout?.side) == null) return s?.phase === "over" ? "no plan: no breakout" : "no plan: no breakout yet";
  return st === "ok" ? null : "no plan";
}

/** Both windows live: the London and New York overlap (New York's open to London's window end). */
export const overlapActive = (d: any): boolean => SESSIONS.every((k) => sessionOf(d, k)?.phase === "live");
/** The session that holds a side in the overlap (B14 overlap: whose plan the agent gives it), or null. */
const holderOf = (d: any, side: SideKey): SessionKey | null => sessionKey(d?.overlap?.[side]);

/** Why one side of a session has no plan, in words. */
export function sideReason(d: any, k: SessionKey, side: SideKey): string {
  const s = sessionOf(d, k);
  if (s?.invalidated?.[side] === true) return "invalidated";
  const holder = holderOf(d, side);
  if (overlapActive(d) && holder && holder !== k) return "stands aside";
  if (str(s?.status) !== "ok") return "no plan";
  if (sideKey(s?.breakout?.side) !== side) return `no ${SIDE_GLYPH[side]} breakout`;
  if (d?.records?.[k]?.held_by_breaker === true) return "held back by the breaker";
  return "no plan in the latest decision";
}

/** The breakout in words: "▲ up · 19 bars ago · held"; "none by 11:45 NY" once the window is over. */
function BreakoutText({ s }: { s: any }) {
  const side = sideKey(s?.breakout?.side);
  if (!side) {
    if (str(s?.status) !== "ok") return <Muted>—</Muted>;
    return <Muted>{s?.phase === "over" ? `none by ${nyTime(s?.end_ms)} NY` : "none yet"}</Muted>;
  }
  const n = s.breakout.bars_since;
  const ago = num(n) ? (n === 0 ? "on the last bar" : `${n} ${n === 1 ? "bar" : "bars"} ago`) : null;
  const STATE: Record<string, string> = { held: "held", retesting: "retesting", back_inside: "back inside the range", invalidated: "invalidated" };
  const state = str(s.breakout.state);
  return (
    <>
      <span className={SIDE_TEXT[side]}>{side === "long" ? "▲ up" : "▼ down"}</span>
      {ago ? <> <Muted>·</Muted> {ago}</> : null}
      {state && state !== "none" ? <> <Muted>·</Muted> {state === "invalidated" ? <span className="text-off">{STATE[state]}</span> : STATE[state] ?? words(state)}</> : null}
      {state === "invalidated" ? <> <Hint text="A 15m close back through the range's middle ends that side for the window." /></> : null}
    </>
  );
}

// ---------------------------------------------------------------- small pieces

const Muted = ({ children }: { children: ReactNode }) => <span className="text-muted">{children}</span>;
function Kv({ k, children, hint }: { k: ReactNode; children: ReactNode; hint?: string }) {
  return <div className="flex min-w-0 flex-col gap-0.5"><span className="flex items-center gap-1.5 text-[11px] text-muted">{k}{hint ? <Hint text={hint} /> : null}</span><span className="mono text-[12px] leading-normal text-slate-300">{children}</span></div>;
}
const tdSans = "border-b border-white/5 px-2 py-2 align-top text-[12px] leading-normal text-slate-300";
const td = `mono ${tdSans}`;
const th = "whitespace-nowrap border-b border-white/10 px-2 py-2 align-bottom text-[11px] font-medium text-muted";
const SubTitle = ({ children, hint }: { children: ReactNode; hint?: string }) => <div className="flex items-center gap-1.5 text-[12px] font-semibold text-fg">{children}{hint ? <Hint text={hint} /> : null}</div>;
const AGENT_TONE: Record<string, Tone> = { live: "ok", shadow: "shadow", suspended: "late", off: "off" };
const icon = (I: typeof Sunrise) => <I className="h-3.5 w-3.5 text-cyan-300" />;

/** The width against the band: the track 0 to 4 ATR (1H), the band 0.25 to 3.5 lighter, the width a tick. */
function WidthGauge({ d, w }: { d: any; w: number }) {
  const pos = (x: number) => `${(Math.max(0, Math.min(GAUGE_MAX_ATR, x)) / GAUGE_MAX_ATR) * 100}%`;
  const lo = rule(d, "min_width_atr"), hi = rule(d, "max_width_atr");
  return (
    <span aria-hidden="true" className="relative mt-[5px] block h-1.5 w-[88px] rounded-full bg-white/6">
      <span className="absolute inset-y-0 rounded-full bg-white/14" style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})` }} />
      <span className="absolute -bottom-[3px] -top-[3px] w-[2px] bg-fg" style={{ left: pos(w) }} />
    </span>
  );
}

// ---------------------------------------------------------------- the heading

function Heading({ chips }: { chips?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="flex items-center gap-2.5 text-[20px] font-semibold text-fg"><Sunrise className="h-[18px] w-[18px] text-cyan-300" />Opening range</h1>
        <span className="text-[11px] text-muted">Intelligence · ORB agent · London and New York · 15m</span>
      </div>
      {chips ? <div className="flex flex-wrap items-center gap-1.5">{chips}</div> : null}
    </div>
  );
}

/** orb_breakout in /api/strategy-agents, or null. */
export const orbAgent = (agents: any): any => arr(agents?.agents).find((a) => a?.id === "orb_breakout") ?? null;
/** The agent's status: suspended when the breaker holds the agent back, else its own. */
const agentStatus = (a: any): string | null => (a?.suspended === true ? "suspended" : str(a?.status));

/**
 * The arm, from the latest decision's armed.ids (/api/engine/decision): "armed" when orb_breakout is armed; "not armed"
 * when others are armed (its plans are recorded, not traded); "auto" with none armed (every live agent may be picked);
 * null without a decision.
 */
export function armOf(decision: any): "armed" | "not armed" | "auto" | null {
  const a = obj(decision?.decision?.armed);
  if (!a) return null;
  const ids = arr(a.ids);
  return ids.includes("orb_breakout") ? "armed" : ids.length ? "not armed" : "auto";
}

function headingChips(d: any, agents: any, decision: any) {
  const st = agentStatus(orbAgent(agents));
  const arm = armOf(decision);
  return (
    <>
      {st ? <Badge tone={AGENT_TONE[st] ?? "plain"}>{st}</Badge> : null}
      {arm === "armed" ? <Badge tone="ok">armed</Badge> : arm === "not armed" ? <Badge tone="plain">not armed: plans are recorded, not traded</Badge> : arm === "auto" ? <Badge tone="plain">no strategy armed: the best plan of all is picked</Badge> : null}
      {d?.levels_mode === "off" ? <Badge tone="off">ORB levels off</Badge> : str(d?.levels_mode) ? <Badge tone="ok">ORB levels on</Badge> : null}
      <Hint text={`The first ${rule(d, "range_bars")} closed 15m bars of the London (03:00 New York) and New York (08:00 New York) sessions. A 15m close beyond an edge by ${rule(d, "beyond_atr")} ATR (1H) is the breakout; the plan enters on the retest of the broken edge and lapses when the session's window ends. ORB levels: the edges as key levels while a window is live. Every price on the feed scale.`} />
    </>
  );
}

// ---------------------------------------------------------------- panel: sessions

function planCells(plan: any) {
  return {
    entry: <><span className="text-ok">{price(plan.entry)}</span><br /><Muted>{plan.entry_type === "at_level" ? "at price" : plan.entry_type === "limit" ? "limit at the edge" : "—"}</Muted></>,
    stop: <span className="text-bear">{price(plan.stop)}</span>,
    tps: <><span className="text-bull">{price(plan.tp1)}</span><br /><span className="text-bull">{price(plan.tp2)}</span></>,
    rr: num(plan.rrr) ? plan.rrr.toFixed(1) : "—",
    lapse: num(plan.lapse_ms) ? `${nyTime(plan.lapse_ms)} NY` : "—"
  };
}
/** A plan's role under its side: "holds the side" in the overlap, "picked" by the latest decision, else its status. */
function roleText(d: any, k: SessionKey, side: SideKey, plan: any): string {
  if (overlapActive(d) && holderOf(d, side) === k) return "holds the side";
  if (plan?.picked === true) return "picked";
  return str(plan?.role) ?? "plan";
}
function SideLabel({ d, k, side, plan }: { d: any; k: SessionKey; side: SideKey; plan: any }) {
  const off = sessionOf(d, k)?.invalidated?.[side] === true;
  return <><span className={off ? "text-off" : SIDE_TEXT[side]}>{SIDE_WORD[side]}</span><br /><Muted>{plan ? roleText(d, k, side, plan) : sideReason(d, k, side)}</Muted></>;
}

function Plans({ d, k }: { d: any; k: SessionKey }) {
  const s = sessionOf(d, k);
  const plans = plansOf(s);
  if (!hasPlan(s)) {
    const line = noPlanLine(d, s);
    if (line) return <div className="mono text-[12px] text-muted">{line}</div>;
    return (
      <div className="flex flex-col gap-1.5">
        {SIDES.map((side) => {
          const off = s?.invalidated?.[side] === true;
          return <div key={side} className="mono text-[12px] text-muted"><span className={off ? "text-off" : SIDE_TEXT[side]}>{SIDE_WORD[side]}</span> {sideReason(d, k, side)} · no plan</div>;
        })}
      </div>
    );
  }
  const holderNote = (side: SideKey) => { const h = holderOf(d, side); return h && h !== k && overlapActive(d) ? `${SESSION_NAME[h]} holds the ${side} side` : "no plan"; };
  return (
    <>
      <table className="hidden w-full border-collapse text-left sm:table">
        <thead><tr>
          <th scope="col" className={th}>Side</th><th scope="col" className={th}>Entry</th><th scope="col" className={clsx(th, "text-right")}>Stop</th>
          <th scope="col" className={clsx(th, "text-right")}>TP1<br />TP2</th><th scope="col" className={clsx(th, "text-right")}><span className="inline-flex items-center gap-1">R:R<Hint text="Reward to risk at TP1." /></span></th><th scope="col" className={clsx(th, "text-right")}>Lapses</th>
        </tr></thead>
        <tbody>{SIDES.map((side) => {
          const p = plans[side];
          if (!p) return <tr key={side}><td className={clsx(td, "px-1.5")}><SideLabel d={d} k={k} side={side} plan={null} /></td><td className={clsx(td, "px-1.5 text-muted")} colSpan={5}>{holderNote(side)}</td></tr>;
          const c = planCells(p);
          return (
            <tr key={side}>
              <td className={clsx(td, "whitespace-nowrap px-1.5")}><SideLabel d={d} k={k} side={side} plan={p} /></td>
              <td className={clsx(td, "whitespace-nowrap px-1.5")}>{c.entry}</td>
              <td className={clsx(td, "px-1.5 text-right")}>{c.stop}</td>
              <td className={clsx(td, "px-1.5 text-right")}>{c.tps}</td>
              <td className={clsx(td, "px-1.5 text-right")}>{c.rr}</td>
              <td className={clsx(td, "whitespace-nowrap px-1.5 text-right")}>{c.lapse}</td>
            </tr>
          );
        })}</tbody>
      </table>
      <div className="flex flex-col gap-3 sm:hidden">
        {SIDES.map((side) => {
          const p = plans[side];
          const off = s?.invalidated?.[side] === true;
          if (!p) return <div key={side} className="mono text-[12px] text-muted"><span className={off ? "text-off" : SIDE_TEXT[side]}>{SIDE_WORD[side]}</span> {sideReason(d, k, side)} · {holderNote(side)}</div>;
          const c = planCells(p);
          return (
            <div key={side} className="flex flex-col gap-2">
              <div className="mono text-[12px]"><span className={SIDE_TEXT[side]}>{SIDE_WORD[side]}</span> <Muted>{roleText(d, k, side, p)}</Muted></div>
              <div className="grid grid-cols-3 gap-x-3 gap-y-2.5">
                <Kv k="Entry">{c.entry}</Kv><Kv k="Stop">{c.stop}</Kv><Kv k="Lapses">{c.lapse}</Kv>
                <Kv k="TP1"><span className="text-bull">{price(p.tp1)}</span></Kv><Kv k="TP2"><span className="text-bull">{price(p.tp2)}</span></Kv><Kv k="R:R" hint="Reward to risk at TP1.">{c.rr}</Kv>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function SessionCard({ d, k }: { d: any; k: SessionKey }) {
  const s = sessionOf(d, k);
  if (!s) return <div className="glass-inner p-3.5"><Empty when="The view carries no card for this session.">{`No ${SESSION_NAME[k]} session`}</Empty></div>;
  const detail = str(s.status_detail);
  return (
    <div className="glass-inner flex min-w-0 flex-col gap-3 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-fg">{SESSION_NAME[k]}</span>
          <Badge tone={statusTone(s)}>{statusWord(s)}</Badge>
          {detail ? <Hint text={detail} /> : null}
        </span>
        <span className="mono ml-auto text-[12px] text-fg-2">{phaseText(d, s)}</span>
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
        <Kv k="Range">{nyTime(s.open_ms)}–{nyTime(s.range_end_ms)} NY<br /><Muted>{spanUtcGmt7(s.open_ms, s.range_end_ms)}</Muted></Kv>
        <Kv k="Window ends">{nyTime(s.end_ms)} NY<br /><Muted>{utc(s.end_ms)} UTC · {gmt7(s.end_ms)} GMT+7</Muted></Kv>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
        <Kv k="High">{price(s.high)}</Kv>
        <Kv k="Low">{price(s.low)}</Kv>
        <Kv k="Mid">{price(s.mid)}</Kv>
        <Kv k="Width" hint={`Traded between ${rule(d, "min_width_atr")} and ${rule(d, "max_width_atr")} ATR (1H).`}>{num(s.width_atr) ? <>{s.width_atr.toFixed(2)} ATR<WidthGauge d={d} w={s.width_atr} /></> : "—"}</Kv>
      </div>
      <Kv k="Breakout"><BreakoutText s={s} /></Kv>
      <div className="border-t border-white/5 pt-2.5"><Plans d={d} k={k} /></div>
    </div>
  );
}

/** "London's range is building; New York's sets at 08:45 NY (13:45 UTC)." */
export function noSetupText(d: any): string {
  const parts = SESSIONS.map((k) => {
    const s = sessionOf(d, k), n = SESSION_NAME[k];
    if (!s) return null;
    if (s.phase === "forming") return num(s.bars_built) && s.bars_built > 0 ? `${n}'s range is building` : `${n}'s sets at ${nyTime(s.range_end_ms)} NY (${utc(s.range_end_ms)} UTC)`;
    if (s.phase === "over") return `${n}'s window is over`;
    if (s.phase === "live") {
      if (str(s.status) !== "ok") return `${n} is not traded today (${statusWord(s)})`;
      if (!sideKey(s.breakout?.side)) return `${n}'s range is set, no breakout yet`;
      return s.breakout.state === "invalidated" ? `${n}'s breakout is invalidated` : `${n} has no plan on its breakout`;
    }
    return null;
  }).filter((x): x is string => x != null);
  return parts.length ? `${parts.join("; ")}.` : "The agent plans at each 15m close inside a London or New York window.";
}

/** "The London range sets Monday 03:45 New York (08:45 UTC, 15:45 GMT+7)." */
export function nextRangeText(d: any): string {
  const nr = obj(d?.market?.next_range), k = sessionKey(nr?.session);
  if (!nr || !k || !num(nr.open_ms)) return "The next range sets when gold reopens.";
  const t = nr.open_ms + rule(d, "range_bars") * 15 * 60_000;
  return `The ${SESSION_NAME[k]} range sets ${WEEKDAY[nyClock(t).wd]} ${nyTime(t)} New York (${utc(t)} UTC, ${gmt7(t)} GMT+7).`;
}

function SessionsPanel({ d, poll }: { d: any; poll?: Poll }) {
  if (d?.market?.open === false) {
    return (
      <Panel title="Sessions" icon={icon(Sunrise)} right={<Badge tone="off">market closed</Badge>}>
        <Empty when={nextRangeText(d)}>Market closed</Empty>
      </Panel>
    );
  }
  const atr = num(d?.atr_h1) ? ` · ATR (1H) ${d.atr_h1.toFixed(2)}` : "";
  const both = overlapActive(d);
  const held = SIDES.filter((x) => holderOf(d, x) != null);
  const ny = sessionOf(d, "new_york"), ldn = sessionOf(d, "london");
  return (
    <Panel title="Sessions" icon={icon(Sunrise)} poll={poll} live right={<Badge tone="plain">feed scale{atr}</Badge>}>
      <div className="flex flex-col gap-3">
        {!SESSIONS.some((k) => hasPlan(sessionOf(d, k))) ? <Empty when={noSetupText(d)}>No ORB setup yet</Empty> : null}
        <div className="grid gap-3 lg:grid-cols-2">{SESSIONS.map((k) => <SessionCard key={k} d={d} k={k} />)}</div>
        {both ? (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-slate-300">
            <span className="mono text-muted">Overlap {nyTime(ny?.open_ms)}–{nyTime(ldn?.end_ms)} NY</span>
            <span>{held.length ? held.map((x) => `${SESSION_NAME[holderOf(d, x)!]} holds the ${x} side`).join(" · ") : "Neither session holds a side yet"}</span>
            <Hint text="While both windows are live, New York wins a side where both have a plan." />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- panel: the chart (pure drawing)

/**
 * The opening ranges as boxes on the candles: each formed range from its first to its last bar, its edges to the
 * window's last bar (the last candle when the window ends after it, the label carrying the end time), the broken edge in
 * its breakout colour (grey once invalidated). A range whose bars are not on the candles is left out.
 */
export function orbBoxes(d: any, bars: IntelBar[], mark: Mark): ChartBox[] {
  if (!mark.show || !bars.length) return [];
  const times = new Set(bars.map((b) => b.time)), last = bars[bars.length - 1].time;
  const out: ChartBox[] = [];
  for (const k of SESSIONS) {
    const s = sessionOf(d, k);
    if (!s || !num(s.high) || !num(s.low) || !num(s.open_ms) || !num(s.range_end_ms)) continue;
    const from = s.open_ms / 1000, to = s.range_end_ms / 1000 - 900;
    if (!times.has(from) || !times.has(to)) continue;
    const until = num(s.end_ms) ? Math.min(s.end_ms / 1000 - 900, last) : last;
    const side = sideKey(s.breakout?.side);
    const color = side ? (s.breakout.state === "invalidated" ? T.offFill : SIDE_FILL[side]) : undefined;
    out.push({
      from: from as any, to: to as any, until: Math.max(to, until) as any, high: s.high, low: s.low, mid: num(s.mid) ? s.mid : null,
      label: `${SESSION_NAME[k]} · to ${nyTime(s.end_ms)} NY${mark.suffix}`, broken: side === "long" ? "high" : side === "short" ? "low" : null, brokenColor: color, alpha: mark.dim ? DIM : 1
    });
  }
  return out;
}

/** The breakout bars as circles in their breakout colour (grey once invalidated), on the candles only. */
export function orbMarkers(d: any, bars: IntelBar[], mark: Mark): IntelMarker[] {
  if (!mark.show) return [];
  const times = new Set(bars.map((b) => b.time));
  const out: IntelMarker[] = [];
  for (const k of SESSIONS) {
    const s = sessionOf(d, k), side = sideKey(s?.breakout?.side);
    if (!side || !num(s.breakout.bar_ms) || !times.has(s.breakout.bar_ms / 1000)) continue;
    out.push({ time: s.breakout.bar_ms / 1000, above: side === "short", color: s.breakout.state === "invalidated" ? T.offFill : SIDE_FILL[side], shape: "circle" });
  }
  return out;
}

/** The plan the chart draws: the one the latest decision picked, else the overlap holder's, else the first. */
export function chartPlan(d: any): { k: SessionKey; side: SideKey; plan: any } | null {
  const all = SESSIONS.flatMap((k) => SIDES.map((side) => ({ k, side, plan: plansOf(sessionOf(d, k))[side] }))).filter((x) => x.plan && num(x.plan.entry) && num(x.plan.stop));
  return all.find((x) => x.plan.picked === true) ?? all.find((x) => holderOf(d, x.side) === x.k) ?? all[0] ?? null;
}

/** The plan's lines (IntelChart's opt-in `plan`): Entry, Stop, TP1 and TP2, each with its tag; none without a plan. */
export function orbPlanLines(d: any, mark: Mark): ChartLine[] {
  const p = chartPlan(d);
  if (!p || !mark.show) return [];
  const a = mark.dim ? DIM : 0.95, sfx = mark.suffix;
  const out: ChartLine[] = [];
  const add = (x: unknown, label: string, color: string, text: string, dash?: number[]) => { if (num(x)) out.push({ p0: x, p1: x, color, alpha: a, width: 1.2, dash, label: label + sfx, text, place: "level" }); };
  add(p.plan.entry, "Entry", T.okFill, T.ok);
  add(p.plan.stop, "Stop", T.bearFill, T.bear, [5, 4]);
  add(p.plan.tp1, "TP1", T.bullFill, T.bull, [5, 4]);
  add(p.plan.tp2, "TP2", T.bullFill, T.bull, [2, 3]);
  return out;
}

/** The page draws no band: one constant, so the chart's bands are set once. */
const NO_ZONES: ChartZone[] = [];

function LineSwatch({ color, dash }: { color: string; dash?: string }) {
  return <svg aria-hidden="true" width="16" height="8" viewBox="0 0 16 8"><line x1="0" x2="16" y1="4" y2="4" stroke={color} strokeWidth="1.5" strokeDasharray={dash} /></svg>;
}
const Item = ({ swatch, children }: { swatch?: ReactNode; children: ReactNode }) => <span className="inline-flex items-center gap-1.5 whitespace-nowrap">{swatch}{children}</span>;

function ChartPanel({ d, candles, mark, poll }: { d: any; candles: any; mark: Mark; poll?: Poll }) {
  const bars = useMemo(() => barsOf(candles), [candles]);
  const boxes = useMemo(() => orbBoxes(d, bars, mark), [d, bars, mark]);
  const markers = useMemo(() => orbMarkers(d, bars, mark), [d, bars, mark]);
  const plan = useMemo(() => orbPlanLines(d, mark), [d, mark]);
  const fit = useMemo(() => [...boxes.flatMap((b) => [b.high, b.low]), ...plan.map((l) => l.p0)], [boxes, plan]);
  const p = chartPlan(d);
  const broken = SESSIONS.map((k) => sideKey(sessionOf(d, k)?.breakout?.side)).filter((x): x is SideKey => x != null);
  const label = `15m candles on the feed scale with the London and New York opening ranges${plan.length && p ? ` and the ${SESSION_NAME[p.k]} ${p.side} plan's lines` : ""}`;
  return (
    <Panel title="Ranges on the chart" icon={icon(CandlestickChart)} poll={poll} live hint="The candles are the feed's closed 15m bars (/api/ohlcv); the ranges, edges and plan come from /api/orb.">
      <IntelChart poll={poll} bars={bars} zones={NO_ZONES} boxes={boxes} markers={markers} plan={plan} fit={fit} label={label} />
      {bars.length ? (
        <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1.5 text-[11px] text-fg-2">
          <Item swatch={<span aria-hidden="true" className="inline-block h-2 w-3 shrink-0 border border-fg-2 bg-white/7" />}>range</Item>
          <Item swatch={<LineSwatch color={T.fg2} dash="4 3" />}>edge</Item>
          {[...new Set(broken)].map((x) => <Item key={x} swatch={<LineSwatch color={SIDE_FILL[x]} dash="4 3" />}><span className={SIDE_TEXT[x]}>{SIDE_GLYPH[x]} broken edge</span></Item>)}
          <Item swatch={<LineSwatch color={T.fg2} dash="1 2" />}>mid</Item>
          {markers.length ? <Item swatch={<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke={T.fg} strokeWidth="1.5" /></svg>}>breakout</Item> : null}
          {plan.length ? (
            <>
              <Item swatch={<LineSwatch color={T.okFill} />}>Entry</Item>
              <Item swatch={<LineSwatch color={T.bearFill} dash="4 3" />}>Stop</Item>
              <Item swatch={<LineSwatch color={T.bullFill} dash="4 3" />}>TP1</Item>
              <Item swatch={<LineSwatch color={T.bullFill} dash="2 2" />}>TP2</Item>
            </>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------- panel: records per session

function RecordsPanel({ d, poll }: { d: any; poll?: Poll }) {
  const rows = SESSIONS.map((k) => ({ k, r: obj(d?.records?.[k]) }));
  const r = (x: unknown) => (num(x) ? `${signed(x)}R` : "—");
  const setups = (x: any) => (num(x?.setups) ? x.setups : "—");
  const held = (x: any) => (x?.held_by_breaker === true ? <Badge tone="late">held back</Badge> : <Muted>—</Muted>);
  const hint = `The plan learner's record of each session's setups (control arm). Target rate over filled setups. A session is held back when its own record is below 0R over ${PATTERN_BREAKER_MIN} setups; the other session trades on.`;
  return (
    <Panel title="Records per session" icon={icon(LineChart)} poll={poll} hint={hint}>
      {!rows.some((x) => x.r) ? <Empty when="The plan learner writes them as the agent's setups resolve.">No record yet</Empty> : (
        <>
          <table className="hidden w-full border-collapse text-left sm:table">
            <thead><tr>
              <th scope="col" className={th}>Session</th>
              {["Setups", "Fill rate", "Target rate", "Mean R"].map((h) => <th key={h} scope="col" className={clsx(th, "text-right")}>{h}</th>)}
              <th scope="col" className={th}>Held back</th>
            </tr></thead>
            <tbody>{rows.map(({ k, r: x }) => (
              <tr key={k}>
                <td className={clsx(tdSans, "font-semibold text-fg")}>{SESSION_NAME[k]}</td>
                <td className={clsx(td, "text-right")}>{setups(x)}</td>
                <td className={clsx(td, "text-right")}>{pc(x?.fill_rate)}</td>
                <td className={clsx(td, "text-right")}>{pc(x?.target_rate)}</td>
                <td className={clsx(td, "text-right")}>{r(x?.mean_r)}</td>
                <td className={tdSans}>{held(x)}</td>
              </tr>
            ))}</tbody>
          </table>
          <table className="w-full border-collapse text-left sm:hidden">
            <thead><tr><th scope="col" className={th}>Session<br />setups</th><th scope="col" className={clsx(th, "text-right")}>Fill</th><th scope="col" className={clsx(th, "text-right")}>Target</th><th scope="col" className={clsx(th, "text-right")}>Mean R</th><th scope="col" className={th}>Held</th></tr></thead>
            <tbody>{rows.map(({ k, r: x }) => (
              <tr key={k}>
                <td className={clsx(td, "px-1.5")}>{SESSION_NAME[k]}<br /><Muted>{setups(x)}</Muted></td>
                <td className={clsx(td, "px-1.5 text-right")}>{pc(x?.fill_rate)}</td>
                <td className={clsx(td, "px-1.5 text-right")}>{pc(x?.target_rate)}</td>
                <td className={clsx(td, "px-1.5 text-right")}>{r(x?.mean_r)}</td>
                <td className={clsx(tdSans, "px-1.5")}>{held(x)}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- panel: recent sessions

/** The control arm's exits (src/signal-ledger.mjs simulateSignal) in words; outcomes never carry a direction colour. */
export const EXIT_WORD: Record<string, string> = {
  target: "TP1", stop: "stop", lapse: "lapsed in profit", time: "time limit", unfilled: "lapsed, no fill",
  target_before_entry: "target before entry", invalidated: "stop before entry", invalid: "invalid plan"
};
export function outcomeText(x: any): string {
  if (x?.status === "open") return "open";
  const e = str(x?.exit);
  return e ? EXIT_WORD[e] ?? words(e) : str(x?.status) ? words(x.status) : "—";
}
/** An outcome's R: none for a setup that never filled. */
const rOf = (x: any): string => (x?.filled === false || !num(x?.r) ? "—" : `${signed(x.r, 1)}R`);

function RecentPanel({ d, poll }: { d: any; poll?: Poll }) {
  const list = arr(d?.recent).filter((x) => x != null && typeof x === "object");
  const name = (x: any) => { const k = sessionKey(x.session); return k ? SESSION_NAME[k] : "—"; };
  const side = (x: any) => { const s = sideKey(x.side); return s ? <span className={SIDE_TEXT[s]}>{SIDE_WORD[s]}</span> : <Muted>—</Muted>; };
  const entry = (x: any) => (x.entry_type === "at_level" ? "at price" : x.entry_type === "limit" ? "limit at the edge" : "—");
  return (
    <Panel title="Recent sessions" icon={icon(CalendarDays)} poll={poll} right={<Badge tone="plain">last 10</Badge>}
      hint="The agent's setups, newest first: one per session side it planned, with the control arm's exit and R (R over the plan's own risk; none without a fill).">
      {!list.length ? <Empty when="Each setup of the agent shows here once its plan is recorded.">No ORB setup recorded yet</Empty> : (
        <>
          <table className="hidden w-full border-collapse text-left sm:table">
            <thead><tr>
              <th scope="col" className={th}>Date (NY)</th><th scope="col" className={th}>Session</th><th scope="col" className={th}>Side</th>
              <th scope="col" className={th}>Entry</th><th scope="col" className={th}>Outcome</th><th scope="col" className={clsx(th, "text-right")}>R</th>
            </tr></thead>
            <tbody>{list.map((x, i) => (
              <tr key={`${x.opened_at ?? i}-${i}`}>
                <td className={clsx(td, "whitespace-nowrap")}>{nyDateText(x.date_ny)}</td>
                <td className={tdSans}>{name(x)}</td>
                <td className={clsx(td, "whitespace-nowrap")}>{side(x)}</td>
                <td className={td}>{entry(x)}</td>
                <td className={td}>{outcomeText(x)}</td>
                <td className={clsx(td, "text-right")}>{rOf(x)}</td>
              </tr>
            ))}</tbody>
          </table>
          <table className="w-full border-collapse text-left sm:hidden">
            <thead><tr><th scope="col" className={th}>Date (NY)<br />session</th><th scope="col" className={th}>Side<br />outcome</th><th scope="col" className={clsx(th, "text-right")}>R</th></tr></thead>
            <tbody>{list.map((x, i) => (
              <tr key={`${x.opened_at ?? i}-${i}`}>
                <td className={clsx(td, "whitespace-nowrap px-1.5")}>{nyDateText(x.date_ny)}<br /><Muted>{name(x)}</Muted></td>
                <td className={clsx(td, "px-1.5")}>{side(x)}<br />{outcomeText(x)}</td>
                <td className={clsx(td, "px-1.5 text-right")}>{rOf(x)}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- panel: where it counted

/** A candidate's name: the registry's label, the opening range with its session ("Opening range · New York"). */
function candidateName(id: unknown, agents: any, dec: any, d: any): string {
  if (id === "orb_breakout") {
    const fromTrade = dec?.trade?.strategy === "orb_breakout" ? variantSession(dec.trade.pattern) : null;
    const side: SideKey | null = dec?.stance === "BUY" ? "long" : dec?.stance === "SELL" ? "short" : null;
    const k = fromTrade ?? (side ? holderOf(d, side) : null);
    return k ? `Opening range · ${SESSION_NAME[k]}` : "Opening range";
  }
  return str(arr(agents?.agents).find((a) => a?.id === id)?.label) ?? words(id);
}

function SelectionBlock({ d, agents, decision }: { d: any; agents: any; decision: any }) {
  const dec = obj(decision?.decision);
  const sel = obj(dec?.selection);
  const list = arr(sel?.candidates).filter((c) => c != null && typeof c === "object");
  const min = num(dec?.rules?.min_confidence) ? dec!.rules.min_confidence : MIN_CONFIDENCE;
  if (!list.length) return <Empty when={str(sel?.reason) ?? "The latest decision picked no strategy: a WAIT, or no strategy saw its setup."}>No strategy pick in the latest decision</Empty>;
  const why = (c: any) => (num(c.confidence) && c.confidence < min ? `under ${pc(min)}` : c.zone_ahead === false ? "an opposing zone ahead" : "no plan that pays");
  const eligible = (c: any) => (c.eligible === true ? "yes" : <>no<br /><Muted>{why(c)}</Muted></>);
  const chosen = (c: any) => (sel?.agent === c.id ? <Badge tone="ok">chosen</Badge> : <Muted>—</Muted>);
  const name = (c: any) => <span className={c.id === "orb_breakout" ? "font-semibold text-fg" : undefined}>{candidateName(c.id, agents, dec, d)}</span>;
  const n2 = (x: unknown) => (num(x) ? x.toFixed(2) : "—");
  return (
    <>
      <table className="hidden w-full border-collapse text-left sm:table">
        <thead><tr>
          <th scope="col" className={th}>Candidate</th>
          {["Confidence", "Confluence", "Score", "R:R"].map((h) => <th key={h} scope="col" className={clsx(th, "text-right")}>{h}</th>)}
          <th scope="col" className={th}>Eligible</th><th scope="col" className={th}>Chosen</th>
        </tr></thead>
        <tbody>{list.map((c, i) => (
          <tr key={`${c.id}-${i}`}>
            <td className={tdSans}>{name(c)}</td>
            <td className={clsx(td, "text-right")}>{pc(c.confidence)}</td>
            <td className={clsx(td, "text-right")}>{n2(c.confluence)}</td>
            <td className={clsx(td, "text-right")}>{n2(c.score)}</td>
            <td className={clsx(td, "text-right")}>{num(c.rrr) ? c.rrr.toFixed(1) : "—"}</td>
            <td className={td}>{eligible(c)}</td>
            <td className={tdSans}>{chosen(c)}</td>
          </tr>
        ))}</tbody>
      </table>
      <table className="w-full border-collapse text-left sm:hidden">
        <thead><tr><th scope="col" className={th}>Candidate</th><th scope="col" className={clsx(th, "text-right")}>Confidence<br />confluence</th><th scope="col" className={th}>Eligible</th><th scope="col" className={th}><span className="sr-only">Chosen</span></th></tr></thead>
        <tbody>{list.map((c, i) => (
          <tr key={`${c.id}-${i}`}>
            <td className={clsx(tdSans, "px-1.5")}>{name(c)}<br /><span className="mono text-muted">score {n2(c.score)}</span></td>
            <td className={clsx(td, "px-1.5 text-right")}>{pc(c.confidence)}<br /><Muted>{n2(c.confluence)}</Muted></td>
            <td className={clsx(td, "px-1.5")}>{eligible(c)}</td>
            <td className={clsx(tdSans, "px-1.5")}>{chosen(c)}</td>
          </tr>
        ))}</tbody>
      </table>
    </>
  );
}

/** Each range edge that sits in a key zone (B14 edges_in_zones), with the edge's price and the zone. */
export function edgeRows(d: any): { k: SessionKey; edge: "high" | "low"; price: number | null; z: any }[] {
  return SESSIONS.flatMap((k) => {
    const s = sessionOf(d, k);
    return arr(s?.edges_in_zones).filter((z) => (z?.edge === "high" || z?.edge === "low") && num(z?.low) && num(z?.high))
      .map((z) => ({ k, edge: z.edge as "high" | "low", price: num(s?.[z.edge]) ? s![z.edge] : null, z }));
  });
}

function EdgesBlock({ d }: { d: any }) {
  const rows = edgeRows(d);
  if (!rows.length) return <Empty when="Each formed range's high and low are checked against the Key Level Agent's zones.">No range edge in a key zone</Empty>;
  const zone = (z: any) => {
    const role = roleOf(z.low, z.high, num(d?.price) ? d.price : null);
    const tone = role === "support" ? "text-bull" : role === "resistance" ? "text-bear" : "text-ok";
    return <><span className={tone}>{ROLE_WORD[role]}</span><br />{priceRange(z.low, z.high)}{z.candidate === true ? <><br /><Muted>candidate</Muted></> : null}</>;
  };
  return (
    <table className="w-full border-collapse text-left">
      <thead><tr><th scope="col" className={th}>Edge</th><th scope="col" className={clsx(th, "text-right")}>Price</th><th scope="col" className={th}>Key zone</th></tr></thead>
      <tbody>{rows.map((x, i) => (
        <tr key={`${x.k}-${x.edge}-${i}`}>
          <td className={clsx(td, "px-1.5")}>{SESSION_NAME[x.k]} {x.edge}</td>
          <td className={clsx(td, "px-1.5 text-right")}>{price(x.price)}</td>
          <td className={clsx(td, "px-1.5")}>{zone(x.z)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function SessionRangeBlock({ d }: { d: any }) {
  const sr = obj(d?.decision?.session_range);
  if (!sr) return <Empty when="The council reads it only inside a London or New York window (none for London in a clock-mismatch week).">No session range in the latest decision</Empty>;
  const k = sessionKey(sr.session);
  const b = obj(sr.breakout), way = b?.way === "up" ? "long" : b?.way === "down" ? "short" : null;
  const range = obj(sr.range);
  const stateWord = b?.retesting === true ? "retesting" : b?.held === true ? "held" : b?.held === false ? "back inside" : null;
  return (
    <div className="glass-inner grid grid-cols-2 gap-x-4 gap-y-2.5 p-3">
      <Kv k="Session">{k ? SESSION_NAME[k] : "—"}</Kv>
      <Kv k="Range">{num(range?.bars) ? `${range!.bars} ${range!.bars === 1 ? "bar" : "bars"}` : "—"} <Muted>·</Muted> {statusWord({ status: range?.status })}</Kv>
      <Kv k="Width">{num(range?.width_atr) ? `${range!.width_atr.toFixed(2)} ATR` : "—"}</Kv>
      <Kv k="Breakout">{way ? <><span className={SIDE_TEXT[way]}>{way === "long" ? "▲ up" : "▼ down"}</span>{num(b?.bars_since) ? <> <Muted>·</Muted> {b!.bars_since} {b!.bars_since === 1 ? "bar" : "bars"} ago</> : null}{stateWord ? <> <Muted>·</Muted> {stateWord}</> : null}{sr.invalidated === true ? <> <Muted>·</Muted> <span className="text-off">invalidated</span></> : null}</> : b ? <Muted>none yet</Muted> : <Muted>—</Muted>}</Kv>
      <Kv k="Window">{num(sr.bars_left) ? `${sr.bars_left} ${sr.bars_left === 1 ? "bar" : "bars"} left` : "—"}</Kv>
    </div>
  );
}

function CountedPanel({ d, agents, decision, poll }: { d: any; agents: any; decision: any; poll?: Poll }) {
  const close = Date.parse(String(d?.decision?.bar_close ?? ""));
  const right = <span className="flex flex-wrap items-center gap-1.5"><Badge tone="plain">feed scale</Badge>{Number.isFinite(close) ? <Badge tone="plain">decision {clockUtcGmt7(close)}</Badge> : null}</span>;
  return (
    <Panel title="Where it counted" icon={icon(Scale)} poll={poll} right={right}>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          <SubTitle hint="The latest decision's strategy pick (/api/engine/decision): score = confidence × confluence; the best eligible candidate is chosen.">Selection</SubTitle>
          <SelectionBlock d={d} agents={agents} decision={decision} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-2">
            <SubTitle hint="A range edge inside a Key Level Agent zone, from /api/orb.">Edges in key zones</SubTitle>
            <EdgesBlock d={d} />
          </div>
          <div className="flex flex-col gap-2">
            <SubTitle hint="The opening range as the council read it at the latest decision (Track A PR 9): distances in ATR (1H), never a price.">session_range</SubTitle>
            <SessionRangeBlock d={d} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- the view

export type Polls = { orb?: Poll; agents?: Poll; decision?: Poll; candles?: Poll };

function Page({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  return <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">{heading}{children}</div>;
}

/**
 * The Opening range page from its four reads. Pure and null-safe: any body, any path null or any array empty renders
 * (the page render check). `mark` is the view read's planMark (stale: the drawing dimmed, its labels kept readable with
 * " · stale 7m"; past 2 hours hidden).
 */
export function OrbView({ d, agents = null, decision = null, candles = null, mark = LIVE, polls = {} }: {
  d: any; agents?: any; decision?: any; candles?: any; mark?: Mark; polls?: Polls;
}) {
  if (!orbReady(d)) {
    return (
      <Page heading={<Heading />}>
        <Panel title="Opening range" icon={icon(Sunrise)}>
          {intelViewsOff(d) ? <Empty when="The Intelligence views are off on the AI Worker.">intel_views_off</Empty>
            : <Empty when="The London and New York ranges are read at each 15m close.">No opening range view yet</Empty>}
        </Panel>
      </Page>
    );
  }
  const off = d?.mode === "off";
  return (
    <Page heading={<Heading chips={headingChips(d, agents, decision)} />}>
      {off ? (
        <Panel title="Opening range" icon={icon(Sunrise)} right={<Badge tone="off">ORB off</Badge>}>
          <Empty when="Switched off by the owner: no range is read and the ORB agent makes no plan.">Opening range off</Empty>
        </Panel>
      ) : (
        <>
          <SessionsPanel d={d} poll={polls.orb} />
          <ChartPanel d={d} candles={candles} mark={mark} poll={polls.candles} />
        </>
      )}
      <RecordsPanel d={d} poll={polls.orb} />
      <RecentPanel d={d} poll={polls.orb} />
      <CountedPanel d={d} agents={agents} decision={decision} poll={polls.decision} />
    </Page>
  );
}

/**
 * The page before its first good read: the skeleton while it loads, else the shared error box with the route and its
 * code ("/api/orb 500 orb_unavailable", "/api/orb 404 Not found" before the route is deployed).
 */
export function OrbUnread({ poll }: { poll: Poll }) {
  return (
    <Page heading={<Heading />}>
      <Panel title="Opening range" icon={icon(Sunrise)} poll={poll}>
        <PollBody poll={poll} skeleton={4} empty={<Empty when="The London and New York ranges are read at each 15m close.">No opening range view yet</Empty>}>{null}</PollBody>
      </Panel>
    </Page>
  );
}

// ---------------------------------------------------------------- the page (the polls)

export default function Orb() {
  const R = ORB_READS;
  // One poll per read (GET only, lib/intel.ts ORB_READS): the page's only requests.
  const orb = usePoll(() => intelGet(R, "orb"), R.orb.everyMs);
  const agents = usePoll(() => intelGet(R, "agents"), R.agents.everyMs);
  const decision = usePoll(() => intelGet(R, "decision"), R.decision.everyMs);
  const candles = usePoll(() => intelGet(R, "candles"), R.candles.everyMs);
  // The view read's planMark (as the War Room chart's plan): dimmed with " · stale 7m" while stale, hidden past 2 hours.
  // A 1 s clock renders only when the mark changes.
  const facts = { hasData: orb.data != null, error: orb.error, lastOk: orb.lastOk, intervalMs: orb.intervalMs };
  const mark = planMark(facts, localNow());
  const markNow = useRef({ facts, key: markKey(mark) });
  markNow.current = { facts, key: markKey(mark) };
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => { if (markKey(planMark(markNow.current.facts, localNow())) !== markNow.current.key) setTick((n) => n + 1); }, PLAN_TICK_MS);
    return () => window.clearInterval(t);
  }, []);
  // One mark object per state, so the chart's drawing is rebuilt only when the mark changes.
  const mk = markKey(mark);
  const stableMark = useMemo(() => mark, [mk]);
  if (orb.data == null) return <OrbUnread poll={orb} />;
  return <OrbView d={orb.data} agents={agents.data} decision={decision.data} candles={candles.data} mark={stableMark} polls={{ orb, agents, decision, candles }} />;
}
