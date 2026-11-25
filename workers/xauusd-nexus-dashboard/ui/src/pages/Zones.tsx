import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { ArrowDownUp, ChevronDown, ChevronUp, Layers, ShieldHalf, ToggleRight, Zap } from "lucide-react";
import { Dot, Panel, PollError, Skeleton, phaseOf } from "../components/ui";
import { usePoll, type Poll } from "../lib/usePoll";
import { CHIP, type Tone } from "../lib/tokens";
import { ZONES_READS, intelGet } from "../lib/intel";
import {
  DEFAULT_SORT, armScale, armScaleText, armsOf, atr, blockedOf, breakerOf, cellTip, clockOf, nextSort, omegaOf, rText, rate, readingsOf, readingsOnByError,
  shortWhen, sortReadings, stancesOf, totals, zonesOff, zonesReady, type Breaker, type Check, type HoldCell, type Reading, type RuleArm, type Sort, type SortKey
} from "../lib/zones";

// Intelligence › Zones (ZN1, #/zones; the owner-approved mockup "ZN1 Zones page", 2026-11-25: "setuju mockup ZN1"). Z5's
// demand and supply zones on one read-only page: the decision-side zone breaker (one cell per holdable rule and its three
// checks), the readings by type x approach x strength, the two counterfactual tables (zone_blocked per side, the Z2b rule
// arms), the stances of the last 7 days and Omega's zone attribution. Two reads, GET only (lib/intel.ts ZONES_READS):
// /api/zones (src/zone-readings.mjs zonesView) and the read-only /api/feature-switches, whose zone_hold gives a hold's
// since and until while the view's breaker.held has none (a failed read of it only leaves the times out).
//
// ZonesView is pure and null-safe (the page render check renders it over test/fixtures/nexus-zones/*.json, the seed's real
// zonesView answers). Rates, outcomes and R are neutral, never green or red; a side's word may carry its direction colour.
// No price: the view carries words, ATR and R only. Explanations are in the ⓘ tooltips.

const CODE = "mono whitespace-nowrap rounded-sm border border-white/10 bg-white/4 px-[5px] text-[11px] leading-4 text-slate-300";
const TH = "whitespace-nowrap border-b border-white/10 p-2 text-left align-bottom text-[11px] font-medium text-muted";
const TD_BOX = "whitespace-nowrap border-b border-white/5 px-2 py-[7px] align-middle text-[12px]";
const TEXT_COLOUR = /(^|\s)text-(fg|fg-2|muted|slate-\d+|bull|bear|neutral|ok|late)(\s|$)/;
const SANS = /(^|\s)font-sans(\s|$)/;
/** A table cell: mono figures in slate-300 unless the extra classes name a colour, or font-sans for words (one class each, no conflict). */
const td = (...extra: (string | false | null | undefined)[]) => {
  const x = clsx(extra);
  return clsx(TD_BOX, !SANS.test(x) && "mono", !TEXT_COLOUR.test(x) && "text-slate-300", x);
};
const LAST = "border-b-0";
const Code = ({ children }: { children: ReactNode }) => <span className={CODE}>{children}</span>;
const Chip = ({ tone, title, children }: { tone: Tone; title?: string; children: ReactNode }) => <span className={clsx("chip", CHIP[tone])} title={title}>{children}</span>;
const DotChip = ({ tone, children }: { tone: Tone; children: ReactNode }) => <Chip tone={tone}><Dot tone={tone} />{children}</Chip>;

/** Nothing to show after a good read: what is missing over when it fills (the mockup's inner box). */
function EmptyBox({ title, when }: { title: string; when: string }) {
  return (
    <div className="glass-inner flex flex-col gap-1.5 px-3.5 py-3">
      <span className="mono text-[13px] text-fg">{title}</span>
      <span className="text-[12px] text-fg-2">{when}</span>
    </div>
  );
}

const SIDE: Record<string, { glyph: string; cls: string }> = { BUY: { glyph: "▲", cls: "text-bull" }, SELL: { glyph: "▼", cls: "text-bear" }, WAIT: { glyph: "", cls: "text-neutral" } };
/** A side or stance in its direction colour with its glyph ("▲ BUY", "▼ SELL", "WAIT"); any other word plain. */
function SideWord({ s }: { s: string }) {
  const x = SIDE[s];
  return x ? <span className={x.cls}>{x.glyph ? `${x.glyph} ` : ""}{s}</span> : <span>{s}</span>;
}

// ---------------------------------------------------------------- the heading

/** The title, what it is, the generated time (UTC · GMT+7), and the ZONE_READINGS chip with the view's schema. */
export function ZonesHeading({ v = null, mode = null }: { v?: any; mode?: "on" | "off" | null }) {
  const at = typeof v?.generated_at === "string" ? v.generated_at : null;
  const live = at && clockOf(at) !== "—"
    ? <span className="mono inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fg-2" title={`generated_at ${shortWhen(at)}`}><Dot tone="ok" />{clockOf(at)}</span>
    : null;
  const schema = typeof v?.schema === "string" ? v.schema.slice(0, 60) : null;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="flex items-center gap-2.5 text-[20px] font-semibold text-fg"><Layers className="h-[18px] w-[18px] text-cyan-300" aria-hidden="true" />Zones</h1>
        <span className="text-[11px] text-muted">Intelligence · Z5 · demand and supply zones</span>
        {live ? <span className="ml-auto hidden sm:inline-flex">{live}</span> : null}
      </div>
      {mode || schema || live ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {mode === "on" ? <Chip tone="ok" title="ZONE_READINGS on">zone readings on</Chip> : mode === "off" ? <Chip tone="off" title="ZONE_READINGS off">zone readings off</Chip> : null}
          {schema ? <span className={clsx(CODE, "text-fg-2")}>{schema}</span> : null}
          {live ? <span className="inline-flex sm:hidden">{live}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- the breaker

const BREAKER_HINT = "Hourly, decision side only. A hold stands at least 7 days, then returns when its record recovers, and at once when the owner changes a zone switch. The owner's switch values never change.";

function SwitchesLink() {
  return (
    <a href="/#/switches" title="The owner's values: Settings › Feature switches" className="inline-flex min-h-11 items-center gap-1.5 text-[12px] font-medium text-ok hover:text-cyan-200 sm:min-h-0">
      <ToggleRight className="h-3.5 w-3.5" aria-hidden="true" />Feature switches
    </a>
  );
}

function HoldSpan({ c }: { c: HoldCell }) {
  return (
    <div className="mono grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] text-slate-300">
      {c.since ? <><span className="text-muted">since</span><span>{shortWhen(c.since)}</span></> : null}
      {c.until ? <><span className="text-muted">until</span><span>{shortWhen(c.until)}</span></> : null}
    </div>
  );
}

/**
 * One holdable rule. Desktop: the rule and its state, "by" and the codes, then since and until (or "no hold"). A phone:
 * the rule, the codes and the state on one line, since and until under it while held.
 */
export function HoldCellView({ c }: { c: HoldCell }) {
  const codes = c.by.map((b) => <Code key={b}>{b}</Code>);
  const span = c.held && (c.since || c.until);
  return (
    <div className="glass-inner flex min-w-0 flex-col gap-1.5 px-2.5 py-[9px] sm:gap-2 sm:px-3 sm:py-2.5" title={cellTip(c)}>
      <div className="flex items-center gap-2">
        <span className="mono text-[13px] font-medium text-fg">{c.rule}</span>
        {c.held ? <span className="flex flex-wrap items-center gap-1.5 sm:hidden">{codes}</span> : null}
        <span className="ml-auto">{c.held ? <DotChip tone="late">held</DotChip> : <DotChip tone="ok">clear</DotChip>}</span>
      </div>
      <div className="hidden flex-wrap items-center gap-1.5 sm:flex"><span className="text-[11px] text-muted">by</span>{c.held && codes.length ? codes : <span className="mono text-[11px] text-muted">—</span>}</div>
      {span ? <HoldSpan c={c} /> : !c.held ? <div className="mono hidden text-[11px] text-muted sm:block">no hold</div> : null}
    </div>
  );
}

/** The three checks in a row (a phone: one per line): code, figure, the figures under it and the state chip. */
export function ChecksStrip({ checks }: { checks: Check[] }) {
  if (!checks.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-full text-[11px] font-medium text-muted sm:mr-1 sm:w-auto">Checks</span>
      {checks.map((k) => (
        <span key={k.code} title={k.tip}
          className="mono box-border inline-flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-white/8 bg-black/20 py-1 pl-2 pr-1.5 text-[11.5px] sm:w-auto sm:flex-nowrap">
          <span className="font-medium text-fg">{k.code}</span>
          <span className="text-slate-300">{k.main}</span>
          <span className="text-fg-2">{k.sub}</span>
          <span className="ml-auto sm:ml-0"><Chip tone={k.tone}>{k.word}</Chip></span>
        </span>
      ))}
    </div>
  );
}

export function BreakerPanel({ b, poll }: { b: Breaker | null; poll?: Poll }) {
  const right = (
    <div className="flex flex-wrap items-center gap-2">
      {b?.checkedAt ? <span className="mono text-[11px] text-fg-2" title="checked_at: the breaker's last hourly tick">checked {shortWhen(b.checkedAt)}</span> : null}
      <SwitchesLink />
    </div>
  );
  return (
    <Panel title="Zone breaker" icon={<ShieldHalf className="h-3.5 w-3.5 text-cyan-300" aria-hidden="true" />} poll={poll} right={right}
      hint={`${BREAKER_HINT}${b?.ruleVersion ? ` Rule version ${b.ruleVersion}.` : ""}`}>
      {b == null ? <EmptyBox title="no breaker tick yet" when="The breaker ticks hourly once ZONE_READINGS is on." /> : (
        <>
          <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">{b.cells.map((c) => <HoldCellView key={c.rule} c={c} />)}</div>
          <ChecksStrip checks={b.checks} />
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- readings

const OUT = [["held", "bg-[#c9d1d9]"], ["neither", "bg-fg-2"], ["broke", "bg-[#4d5560]"]] as const;
/** The outcomes of a group as one bar, held · neither · broke, in greys (an outcome is never green or red). */
export function OutcomeBar({ g, w = 120 }: { g: { held: number; neither: number; broke: number }; w?: number }) {
  const parts = OUT.map(([k, cls]) => [k, cls, g[k]] as const).filter(([, , n]) => n > 0);
  return (
    <div role="img" aria-label={`held ${g.held}, neither ${g.neither}, broke ${g.broke}`} className="flex h-2 gap-0.5" style={{ width: w }}>
      {parts.map(([k, cls, n]) => <span key={k} title={`${k} ${n}`} className={clsx("rounded-[2px]", cls)} style={{ flex: `${n} 1 0` }} />)}
    </div>
  );
}
function OutcomeLegend() {
  return (
    <span className="inline-flex items-center gap-2.5 text-[11px] text-fg-2">
      {OUT.map(([k, cls]) => <span key={k} className="inline-flex items-center gap-1.5"><span className={clsx("h-2 w-2.5 rounded-[2px]", cls)} />{k}</span>)}
    </span>
  );
}
function TypeWord({ t }: { t: string }) {
  if (t === "demand") return <><span className="text-bull">▲</span> demand</>;
  if (t === "supply") return <><span className="text-bear">▼</span> supply</>;
  return <><span className="text-muted">·</span> {t}</>;
}

function SortTh({ label, k, sort, onSort, right = true, tip, className }: { label: ReactNode; k: SortKey; sort: Sort; onSort: (k: SortKey) => void; right?: boolean; tip?: string; className?: string }) {
  const on = sort.key === k;
  const Icon = !on ? ArrowDownUp : sort.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <th scope="col" className={clsx(TH, right && "text-right", className)} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : undefined} title={tip}>
      <button type="button" onClick={() => onSort(k)} className={clsx("inline-flex items-center gap-1 text-left", on ? "text-fg" : "hover:text-fg")}>
        {label}<Icon className={clsx("h-[11px] w-[11px]", on ? "text-fg" : "text-dim")} aria-hidden="true" />
      </button>
    </th>
  );
}

const READINGS_HINT = "Each recorded key-level zone the decision bar touched, read on the next 8 closed 15m bars. held: a close 0.5 ATR(1H) past the near edge in the zone's direction before a close 0.1 ATR beyond the far edge; broke: that close first; else neither. MFE and MAE in ATR(1H) from the near edge.";

export function ReadingsPanel({ v, initialSort = DEFAULT_SORT }: { v: any; initialSort?: Sort }) {
  const [sort, setSort] = useState<Sort>(initialSort);
  const onSort = (k: SortKey) => setSort((s) => nextSort(s, k));
  const all = readingsOf(v);
  const rows = sortReadings(all, sort);
  const t = totals(all);
  const days = typeof v?.window_days === "number" ? v.window_days : 30;
  const prior = typeof v?.prior === "number" ? v.prior : 20;
  const win = <span className="mono text-[11px] text-fg-2" title={`window_days and prior: the shrunk rate pulls a held rate toward the overall rate with a prior of ${prior} readings`}>{days} days · prior {prior}</span>;
  if (!rows.length) {
    return (
      <Panel title="Readings" hint={READINGS_HINT} right={win}>
        <EmptyBox title={`0 readings · ${days} days`} when="Readings arrive once a decision's 8 closed 15m bars are in." />
      </Panel>
    );
  }
  const grouped = sort.key === "zone";
  const firstOfType = rows.map((g, i) => grouped && (i === 0 || rows[i - 1].zone_type !== g.zone_type));
  const low = (g: Reading) => g.n < prior;
  const p = { sort, onSort };
  return (
    <Panel title="Readings" hint={READINGS_HINT} right={<span className="flex flex-wrap items-center gap-2"><span className="hidden sm:inline-flex"><OutcomeLegend /></span>{win}</span>}>
      <div className="mb-2 sm:hidden"><OutcomeLegend /></div>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse">
          <thead><tr>
            <SortTh label="Type" k="zone" right={false} {...p} /><SortTh label="Approach" k="approach" right={false} {...p} /><SortTh label="Strength" k="strength" right={false} {...p} />
            <SortTh label="n" k="n" {...p} /><SortTh label="Held" k="held" {...p} /><SortTh label="Broke" k="broke" {...p} /><SortTh label="Neither" k="neither" {...p} />
            <th scope="col" className={TH}>Outcome</th>
            <SortTh label="Held rate" k="held_rate" tip="held / n" {...p} /><SortTh label="Shrunk" k="held_rate_shrunk" tip={`(held + ${prior} × overall rate) / (n + ${prior})`} {...p} />
            <SortTh label="MFE (ATR)" k="mfe_atr" {...p} /><SortTh label="MAE (ATR)" k="mae_atr" {...p} />
          </tr></thead>
          <tbody>
            {rows.map((g, i) => (
              <tr key={`${g.zone_type}|${g.approach}|${g.zone_strength}`}>
                <td className={td("font-sans", grouped && !firstOfType[i] ? "text-fg-2" : "text-fg")}><TypeWord t={g.zone_type} /></td>
                <td className={td()}>{g.approach}</td><td className={td()}>{g.zone_strength}</td>
                <td className={td("text-right", low(g) ? "text-muted" : "text-fg")}>{g.n}</td>
                <td className={td("text-right")}>{g.held}</td><td className={td("text-right")}>{g.broke}</td><td className={td("text-right")}>{g.neither}</td>
                <td className={td()}><OutcomeBar g={g} /></td>
                <td className={td("text-right", low(g) ? "text-fg-2" : "text-fg")}>{rate(g.held_rate)}</td>
                <td className={td("text-right text-fg")}>{rate(g.held_rate_shrunk)}</td>
                <td className={td("text-right")}>{atr(g.mfe_atr)}</td><td className={td("text-right")}>{atr(g.mae_atr)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} className={td(LAST, "font-sans font-semibold text-fg")}>All readings</td>
              <td className={td(LAST, "text-right text-fg")}>{t.n}</td><td className={td(LAST, "text-right")}>{t.held}</td><td className={td(LAST, "text-right")}>{t.broke}</td><td className={td(LAST, "text-right")}>{t.neither}</td>
              <td className={td(LAST)}><OutcomeBar g={t} /></td>
              <td className={td(LAST, "text-right text-fg")} title="The overall rate the shrunk rates pull toward">{rate(t.held_rate)}</td>
              <td className={td(LAST, "text-right text-muted")}>—</td>
              <td className={td(LAST, "text-right")}>{atr(t.mfe_atr)}</td><td className={td(LAST, "text-right")}>{atr(t.mae_atr)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <table className="w-full border-collapse sm:hidden">
        <thead><tr>
          <SortTh label="Zone" k="zone" right={false} className="pl-1" {...p} /><SortTh label="n" k="n" {...p} />
          <th scope="col" className={clsx(TH, "text-right")}>Held<br />shrunk</th><th scope="col" className={clsx(TH, "pr-1 text-right")}>MFE<br />MAE</th>
        </tr></thead>
        <tbody>
          {rows.map((g, i) => (
            <tr key={`${g.zone_type}|${g.approach}|${g.zone_strength}`}>
              <td className={td("py-[7px] pl-1 pr-[5px] font-sans")}>
                <div className="flex flex-col gap-[3px]">
                  <span className={clsx("text-[12px]", grouped && !firstOfType[i] ? "text-fg-2" : "text-fg")}><TypeWord t={g.zone_type} /></span>
                  <span className="mono text-[11px] text-fg-2">{g.approach} · {g.zone_strength}</span>
                  <OutcomeBar g={g} w={96} />
                </div>
              </td>
              <td className={td("px-[5px] text-right", low(g) ? "text-muted" : "text-slate-300")}>{g.n}</td>
              <td className={td("px-[5px] text-right")}><div className="flex flex-col gap-0.5"><span className={low(g) ? "text-fg-2" : "text-fg"}>{rate(g.held_rate)}</span><span className="text-fg-2">{rate(g.held_rate_shrunk)}</span></div></td>
              <td className={td("pr-1 text-right")}><div className="flex flex-col gap-0.5"><span>{atr(g.mfe_atr)}</span><span className="text-fg-2">{atr(g.mae_atr)}</span></div></td>
            </tr>
          ))}
          <tr>
            <td className={td(LAST, "pl-1 font-sans font-semibold text-fg")}>All</td>
            <td className={td(LAST, "px-[5px] text-right text-fg")}>{t.n}</td>
            <td className={td(LAST, "px-[5px] text-right text-fg")}>{rate(t.held_rate)}</td>
            <td className={td(LAST, "pr-1 text-right")}><div className="flex flex-col gap-0.5"><span>{atr(t.mfe_atr)}</span><span className="text-fg-2">{atr(t.mae_atr)}</span></div></td>
          </tr>
        </tbody>
      </table>
    </Panel>
  );
}

// ---------------------------------------------------------------- counterfactuals

const BLOCKED_HINT = "zone_blocked_setups: the WAIT decisions only zone_ahead held back. Each would-be plan is scored on plan learning's control arm; a limit that never fills scores 0R. Resolved setups, 30 days. The block check trips above +0.10R.";
const ARMS_HINT = "zone_rule_arms: the Z2b plans a rule moved, the acted plan against its base rebuilt from the entry, both on the same outcome step. Resolved arms, 30 days. A rule trips when its mean acted R is below its mean base R (30 or more).";

export function BlockedPanel({ v }: { v: any }) {
  const list = blockedOf(v);
  return (
    <Panel title={<>Held back <Code>zone_blocked</Code></>} hint={BLOCKED_HINT} className="min-w-0">
      {!list.length ? <EmptyBox title="0 resolved · 30 days" when="Fills once zone_ahead holds a decision back and its setup resolves." /> : (
        <table className="w-full border-collapse">
          <thead><tr><th scope="col" className={TH}>Side</th><th scope="col" className={clsx(TH, "text-right")}>n</th><th scope="col" className={clsx(TH, "text-right")}>Mean R</th><th scope="col" className={clsx(TH, "text-right")}>Fill rate</th></tr></thead>
          <tbody>{list.map((g) => (
            <tr key={g.side}><td className={td()}><SideWord s={g.side} /></td><td className={td("text-right")}>{g.n}</td><td className={td("text-right text-fg")}>{rText(g.mean_r)}</td><td className={td("text-right")}>{rate(g.fill_rate)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </Panel>
  );
}

/** Acted (filled dot) against base (ring) on the arms' R scale, a line between them and the 0R rule; greys only. */
export function Dumbbell({ a, scale, w = 120 }: { a: RuleArm; scale: { lo: number; hi: number }; w?: number }) {
  const x = (r: number) => Math.max(0, Math.min(w, ((r - scale.lo) / (scale.hi - scale.lo)) * w));
  const z = x(0);
  return (
    <svg role="img" aria-label={`acted ${rText(a.acted)}, base ${rText(a.base)}`} width={w} height={12} className="block overflow-visible">
      <line x1={z} y1={1} x2={z} y2={11} stroke="#484f58" strokeWidth={1} />
      {a.acted != null && a.base != null ? <line x1={x(a.acted)} y1={6} x2={x(a.base)} y2={6} stroke="#6e7681" strokeWidth={2} /> : null}
      {a.base != null ? <circle cx={x(a.base)} cy={6} r={4} fill="#0b0f18" stroke="#c9d1d9" strokeWidth={1.5} /> : null}
      {a.acted != null ? <circle cx={x(a.acted)} cy={6} r={4} fill="#c9d1d9" stroke="#0b0f18" strokeWidth={2} /> : null}
    </svg>
  );
}
function ArmsLegend() {
  return (
    <span className="hidden items-center gap-2.5 text-[11px] text-fg-2 sm:inline-flex">
      <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#c9d1d9]" />acted</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full border-[1.5px] border-[#c9d1d9]" />base</span>
    </span>
  );
}

export function ArmsPanel({ v }: { v: any }) {
  const list = armsOf(v);
  const scale = armScale(list);
  return (
    <Panel title={<>Rule arms <Code>zone_rule_arms</Code></>} hint={ARMS_HINT} right={list.length ? <ArmsLegend /> : undefined} className="min-w-0">
      {!list.length ? <EmptyBox title="0 resolved · 30 days" when="Fills while a Z2b rule (tp, stop) is on and its plans resolve." /> : (
        <table className="w-full border-collapse">
          <thead><tr>
            <th scope="col" className={TH}>Rule</th><th scope="col" className={clsx(TH, "text-right")}>n</th><th scope="col" className={clsx(TH, "text-right")}>Acted</th>
            <th scope="col" className={clsx(TH, "text-right")}>Base</th><th scope="col" className={clsx(TH, "text-right")}>Δ</th>
            <th scope="col" className={clsx(TH, "hidden sm:table-cell")}>{armScaleText(scale)}</th>
          </tr></thead>
          <tbody>{list.map((g) => (
            <tr key={g.rule}>
              <td className={td()}>{g.rule}</td><td className={td("text-right")}>{g.n}</td><td className={td("text-right text-fg")}>{rText(g.acted)}</td>
              <td className={td("text-right")}>{rText(g.base)}</td><td className={td("text-right text-fg")}>{rText(g.delta)}</td>
              <td className={td("hidden sm:table-cell")}><Dumbbell a={g} scale={scale} /></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- stances, Omega

const STANCES_HINT = "The Decision Engine's stances over the last 7 days, and how many carried $.zone_blocked (a WAIT that zone_ahead alone held back).";
const OMEGA_HINT = "Omega's trades a zone touched (an intent's level_source zone or zone reason, the Position Manager's zone rules), joined to their closed deals in R. Read-only, 30 days. Advisory: 15 or more closes with a mean below 0R; the owner may set zone_mgmt lower. No action is taken.";
const STANCE_FILL: Record<string, string> = { BUY: "bg-bull-fill", SELL: "bg-bear-fill", WAIT: "bg-neutral-fill" };

export function StancesPanel({ v }: { v: any }) {
  const list = stancesOf(v);
  const n = list.reduce((a, s) => a + s.n, 0), zb = list.reduce((a, s) => a + s.zone_blocked, 0);
  if (!list.length) return <Panel title="Stances" hint={STANCES_HINT} className="min-w-0"><EmptyBox title="0 decisions · 7 days" when="Fills from the Decision Engine's records." /></Panel>;
  return (
    <Panel title="Stances" hint={STANCES_HINT} right={<span className="mono text-[11px] text-fg-2">7 days · {n} decisions</span>} className="min-w-0">
      <div role="img" aria-label={list.map((s) => `${s.stance} ${rate(s.share)}`).join(", ")} className="mb-3 flex h-3 gap-0.5">
        {list.map((s) => <span key={s.stance} title={`${s.stance} ${s.n} · ${rate(s.share)}`} className={clsx("rounded-[3px]", STANCE_FILL[s.stance] ?? "bg-fg-2")} style={{ flex: `${s.n} 1 0` }} />)}
      </div>
      <table className="w-full border-collapse">
        <thead><tr><th scope="col" className={TH}>Stance</th><th scope="col" className={clsx(TH, "text-right")}>n</th><th scope="col" className={clsx(TH, "text-right")}>Share</th><th scope="col" className={clsx(TH, "text-right")}><Code>zone_blocked</Code></th></tr></thead>
        <tbody>
          {list.map((s) => <tr key={s.stance}><td className={td()}><SideWord s={s.stance} /></td><td className={td("text-right")}>{s.n}</td><td className={td("text-right text-fg")}>{rate(s.share)}</td><td className={td("text-right")}>{s.zone_blocked}</td></tr>)}
          <tr><td className={td(LAST, "font-sans font-semibold text-fg")}>All</td><td className={td(LAST, "text-right text-fg")}>{n}</td><td className={td(LAST, "text-right")}>100%</td><td className={td(LAST, "text-right text-fg")}>{zb}</td></tr>
        </tbody>
      </table>
    </Panel>
  );
}

export function OmegaPanel({ v }: { v: any }) {
  const o = omegaOf(v);
  const right = o.advisory
    ? <Chip tone="late" title="15 or more closes, mean below 0R: the owner may set zone_mgmt lower. No action taken.">advisory</Chip>
    : <Chip tone="plain">no advisory</Chip>;
  return (
    <Panel title="Omega attribution" icon={<Zap className="h-3.5 w-3.5 text-cyan-300" aria-hidden="true" />} hint={OMEGA_HINT} right={right} className="min-w-0">
      {!o.by.length ? <EmptyBox title="0 zone-attributed closes · 30 days" when="Fills when Omega closes a trade a zone placed or managed." /> : (
        <>
          <div className="mb-2.5 flex items-baseline gap-[18px]">
            <span className="flex flex-col gap-0.5"><span className="text-[11px] text-muted">Closes</span><span className="mono text-[20px] font-semibold text-fg">{o.closes}</span></span>
            <span className="flex flex-col gap-0.5"><span className="text-[11px] text-muted">Mean R</span><span className="mono text-[20px] font-semibold text-fg">{rText(o.mean_r, 3)}</span></span>
            <span className="mono text-[11px] text-fg-2">30 days</span>
          </div>
          <table className="w-full border-collapse">
            <thead><tr><th scope="col" className={TH}>Source</th><th scope="col" className={clsx(TH, "text-right")}>n</th><th scope="col" className={clsx(TH, "text-right")}>Mean R</th></tr></thead>
            <tbody>{o.by.map((x) => <tr key={x.source}><td className={td("whitespace-normal break-all")}>{x.source}</td><td className={td("text-right")}>{x.n}</td><td className={td("text-right text-fg")}>{rText(x.mean_r, 3)}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- the view and its states

function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-3 py-3.5 sm:gap-4 sm:px-6 sm:py-5">{children}</div>;
}

/** ZONE_READINGS off (GET /api/zones 404 zone_readings_off): nothing recorded and no hold, with the way to the switch. */
export function ZonesOff() {
  return (
    <Page>
      <ZonesHeading mode="off" />
      <section className="glass p-4">
        <div className="glass-inner flex flex-wrap items-center justify-between gap-3 p-3.5">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="mono text-[13px] text-fg">ZONE_READINGS off · nothing recorded, no hold reaches a decision</span>
            <span className="mono text-[11px] text-fg-2">/api/zones 404 · zone_readings_off</span>
          </div>
          <a href="/#/switches" className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-white/10 bg-white/4 px-2.5 text-[12px] font-medium text-fg transition hover:border-white/20 hover:bg-white/8 sm:h-8">
            <ToggleRight className="h-3.5 w-3.5 text-ok" aria-hidden="true" />Feature switches
          </a>
        </div>
      </section>
    </Page>
  );
}

/** The first load: the heading and a skeleton. */
export function ZonesLoading() {
  return <Page><ZonesHeading /><div className="glass p-4"><Skeleton rows={4} /></div></Page>;
}

/** A failed read with nothing on screen (the shared error box); a 500 zones_unavailable is past the gate, so readings are on. */
export function ZonesUnread({ poll }: { poll: Poll }) {
  return <Page><ZonesHeading mode={readingsOnByError(poll.error) ? "on" : null} /><section className="glass p-4"><PollError poll={poll} /></section></Page>;
}

export type ViewProps = { d: any; switches?: unknown; poll?: Poll; initialSort?: Sort };

/**
 * The page over one GET /api/zones body (pure; the render check's view) and the feature switches' body (or null).
 * `poll` puts the read's state (stale with the last good read and Retry now, or an error) on the breaker panel only.
 */
export function ZonesView({ d, switches = null, poll, initialSort }: ViewProps) {
  if (zonesOff(d)) return <ZonesOff />;
  if (!zonesReady(d)) {
    return (
      <Page>
        <ZonesHeading />
        <section className="glass p-4"><EmptyBox title="No zones view yet" when="GET /api/zones answers once the AI Worker serves Z5's view." /></section>
      </Page>
    );
  }
  return (
    <Page>
      <ZonesHeading v={d} mode="on" />
      <BreakerPanel b={breakerOf(d, switches)} poll={poll} />
      <ReadingsPanel v={d} initialSort={initialSort} />
      <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2"><BlockedPanel v={d} /><ArmsPanel v={d} /></div>
      <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-2"><StancesPanel v={d} /><OmegaPanel v={d} /></div>
    </Page>
  );
}

export default function Zones() {
  const R = ZONES_READS;
  // Two polls (GET only, lib/intel.ts ZONES_READS): the page's only requests.
  const zones = usePoll(() => intelGet(R, "zones"), R.zones.everyMs);
  const switches = usePoll(() => intelGet(R, "switches"), R.switches.everyMs);
  if (phaseOf(zones) === "error") return <ZonesUnread poll={zones} />;
  if (zones.data == null) return <ZonesLoading />;
  // A failed switches read keeps its last good body, or none: the holds then show no times.
  return <ZonesView d={zones.data} switches={switches.data ?? null} poll={zones} />;
}
