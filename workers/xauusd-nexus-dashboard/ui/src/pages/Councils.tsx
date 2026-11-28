import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { ArrowRight, Loader2, Users } from "lucide-react";
import { Badge, Empty, Hint, PollError, PollStrip, Skeleton, phaseOf } from "../components/ui";
import { get } from "../lib/api";
import { useConfirm } from "../components/ConfirmDialog";
import { humanKey, utc } from "../lib/format";
import { usePoll, type Poll } from "../lib/usePoll";
import { CHIP, FILL, TEXT } from "../lib/tokens";
import { CorrectionControl, ROW, useOwnerGate } from "../components/Correction";
import { councilOpinionTarget, councilOptionsTarget } from "../lib/corrections";
import {
  ACTIVE_FILTERS, activeOf, agoText, archiveOf, archivePath, archiveStatuses, archivedOf, chainFor, decideKey, decideRequest, decideResult, decidedByText, detailOf,
  endedAt, endedText, kindText, mergeArchive, oneLine, postCouncil, sessionsOf, splitArchive, stanceOf, statusText, suggestionsOf, summaryText, tallyText, toneOf, whenText,
  type Archive, type Chain, type DecideResult, type Decision, type Detail, type SessionRow, type Sessions, type Suggestion, type Suggestions, type Tally, type Tone
} from "../lib/councilArchive";

// Call for Councils, CF2 (the owner approved the mockup on 2026-11-28, "approved"; the API is CFC-A PR1, #677). The
// council runs itself: the flags suggest topics, the owner approves or rejects each one (both behind a confirm, owner
// "Pakai konfirmasi"), an approved topic opens a session at once and the seats decide; topics expire. Three tabs:
//   - Suggestions: the open topics, soonest expiry first, each with its countdown (late amber under 1 h) and, for the
//     owner only, Approve and Reject; then the recent ones that still need someone, the rest in one Archive line;
//   - Sessions: the running ones with each seat's progress, then the ended ones with who decided and the stance tally;
//     a session's detail shows the council's options read-only, its pick marked, and the seats' votes;
//   - Archive: the chains (topic -> session -> proposal) that need someone; the ended ones behind one line, paged.
// Every API field is read through lib/councilArchive.ts. The owner gate is the feature-switch read's viewer.can_control
// (components/Correction.tsx useOwnerGate), the one the correction control already reads. The owner's writes go to POST
// /omega/api/council (decide, switch, close, reopen, message). A session never changes trading by itself. No price.

const human = humanKey;
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const noop = () => {};

/** A value of the pack, formatted by what its key says it is: a share or rate as a percentage, an R value with its sign. */
function fmtValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (num(v)) {
    if (/(share|rate|accuracy)$/.test(key) && v >= 0 && v <= 1) return `${Math.round(v * 1000) / 10}%`;
    if (/(_r|^r|mean_r|total_r|mean_diff_r)$/.test(key)) return `${v > 0 ? "+" : ""}${v.toFixed(2)}R`;
    return String(Math.round(v * 1000) / 1000);
  }
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}T/.test(v) ? utc(v) : v;
  return "";
}
const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
/** An object's scalar fields on one line: "n 24 · stop share 66.7% · mean R +0.20". */
const inline = (o: Record<string, unknown>) => Object.entries(o).filter(([, v]) => isScalar(v)).map(([k, v]) => `${human(k)} ${fmtValue(k, v)}`).join(" · ");

function Cell({ k, v }: { k: string; v: unknown }) {
  if (isScalar(v)) return <span className={num(v) ? "mono" : ""}>{fmtValue(k, v)}</span>;
  if (Array.isArray(v)) {
    if (v.every(isScalar)) return <span>{v.map((x) => fmtValue(k, x)).join(", ") || "—"}</span>;
    if (v.every((x) => x && typeof x === "object" && "exit" in x)) return <span className="text-[10.5px]">{v.map((x: any) => `${x.exit} ${x.n}`).join(" · ") || "—"}</span>;
    return <span className="text-slate-500">{v.length} items</span>;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("unavailable" in o) return <span className="text-slate-500">unavailable</span>;
    const exits = Array.isArray(o.exits) ? ` · ${(o.exits as any[]).map((x) => `${x.exit} ${x.n}`).join(", ")}` : "";
    return <span className="text-[10.5px] text-slate-300">{inline(o)}{exits}</span>;
  }
  return null;
}

function Table({ rows }: { rows: Array<Record<string, unknown>> }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))];
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr>{cols.map((c) => <th key={c}>{human(c)}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className="whitespace-nowrap align-top">{r && c in r ? <Cell k={c} v={r[c]} /> : <span className="text-slate-600">—</span>}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

/** Any part of the pack as readable blocks: its scalar fields as a grid, its lists as tables, its parts as sub-blocks. */
function Value({ v, depth = 0 }: { v: unknown; depth?: number }): JSX.Element {
  if (isScalar(v)) return <span>{fmtValue("", v)}</span>;
  if (Array.isArray(v)) {
    if (!v.length) return <span className="text-[11px] text-slate-500">none</span>;
    if (v.every(isScalar)) return <span className="text-[11.5px] text-slate-300">{v.map((x) => fmtValue("", x)).join(", ")}</span>;
    return <Table rows={v as Array<Record<string, unknown>>} />;
  }
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o.unavailable === "string") return <div className="text-[11.5px] text-slate-500">Unavailable: {o.unavailable}</div>;
  const scalars = Object.entries(o).filter(([, x]) => isScalar(x));
  const parts = Object.entries(o).filter(([, x]) => !isScalar(x));
  return (
    <div className="flex flex-col gap-2">
      {scalars.length ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3 xl:grid-cols-4">
          {scalars.map(([k, x]) => (
            <div key={k} className="min-w-0">
              <div className="text-[11px] font-medium text-muted">{human(k)}</div>
              <div className={`${num(x) ? "mono text-[13px] font-semibold" : "text-[11.5px]"} wrap-break-word text-slate-200`}>{fmtValue(k, x)}</div>
            </div>
          ))}
        </div>
      ) : null}
      {parts.map(([k, x]) => (
        depth >= 3 ? <div key={k} className="text-[11px]"><span className="text-slate-500">{human(k)}: </span><Cell k={k} v={x} /></div> : (
          <div key={k} className={depth ? "border-l border-white/10 pl-3" : "glass-inner p-2.5"}>
            <div className="eyebrow mb-1.5">{human(k)}</div>
            <Value v={x} depth={depth + 1} />
          </div>
        )
      ))}
    </div>
  );
}

/** The evidence pack of one topic (GET /api/council/evidence): what a session on it reads. No price in it. */
export function Pack({ pack }: { pack: any }) {
  const sections = Object.entries(pack?.sections ?? {});
  const refs: string[] = Array.isArray(pack?.refs) ? pack.refs : [];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
        {[["Topic", <span key="t" className="mono">{pack?.topic ?? "—"}</span>], ["Type", pack?.type ?? "—"], ["As of", utc(pack?.as_of)], ["sha256", <span key="s" className="mono" title={pack?.sha256 ?? ""}>{String(pack?.sha256 ?? "—").slice(0, 16)}…</span>]].map(([k, v]) => (
          <div key={String(k)}><div className="text-[11px] font-medium text-muted">{k as string}</div><div className="break-all text-slate-200">{v as ReactNode}</div></div>
        ))}
      </div>
      {sections.map(([name, value]) => (
        <div key={name} className="glass-inner p-3">
          <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-slate-100">{human(name)}{(value as any)?.unavailable ? <Badge tone="off">unavailable</Badge> : null}</div>
          <Value v={value} depth={1} />
        </div>
      ))}
      <details className="glass-inner p-3">
        <summary className="cursor-pointer text-[12px] font-semibold text-slate-200">Evidence refs ({refs.length})</summary>
        <div className="mt-2 max-h-[320px] overflow-auto">{refs.map((r) => <div key={r} className="mono break-all text-[10.5px] text-slate-400">{r}</div>)}</div>
      </details>
    </div>
  );
}

// ------------------------------------------------------------------ small parts
function Chip({ tone, children, dot = false, mono = false, title }: { tone: Tone; children: ReactNode; dot?: boolean; mono?: boolean; title?: string }) {
  return <span title={title} className={clsx("chip whitespace-nowrap", CHIP[tone], mono && "mono")}>{dot ? <span className={clsx("h-[7px] w-[7px] shrink-0 rounded-full", FILL[tone])} aria-hidden="true" /> : null}{children}</span>;
}
/** The countdown bar's width, in 5% steps (no inline style: the CSP). */
const WIDTHS = ["w-0", "w-[5%]", "w-[10%]", "w-[15%]", "w-[20%]", "w-[25%]", "w-[30%]", "w-[35%]", "w-[40%]", "w-[45%]", "w-[50%]", "w-[55%]", "w-[60%]", "w-[65%]", "w-[70%]", "w-[75%]", "w-[80%]", "w-[85%]", "w-[90%]", "w-[95%]", "w-full"];
const widthOf = (f: number) => WIDTHS[Math.min(20, Math.max(0, Math.round(f * 20)))];
const Spin = () => <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />;
const linkCls = "text-[12px] text-ok underline-offset-2 hover:underline";
function Section({ title, hint, right, children, className, id }: { title: ReactNode; hint?: string; right?: ReactNode; children: ReactNode; className?: string; id: string }) {
  return (
    <section aria-labelledby={id} className={clsx("glass flex flex-col gap-3 p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="flex items-center gap-2 text-[13px] font-semibold text-fg">{title}{hint ? <Hint text={hint} /> : null}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ the header and the tabs
export type TabKey = "suggestions" | "sessions" | "archive";
export function CouncilHeader({ mode, sessions, canControl, busy = false, error = null, onSwitch = noop }: { mode: string | null; sessions: Sessions | null; canControl: boolean; busy?: boolean; error?: string | null; onSwitch?: (on: boolean) => void }) {
  const on = sessions?.enabled === true;
  const runs = mode === "on" || mode === "auto";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="flex items-center gap-2 text-[16px] font-semibold text-fg">
        <Users className="h-4 w-4 text-ok" aria-hidden="true" />Call for Councils
        <Hint text={`The council runs itself: the flags suggest topics, ${canControl ? "you approve" : "the owner approves"} or reject${canControl ? "" : "s"} each one, an approved topic opens a session and the seats decide. A session never changes trading by itself; a knob goes through its shadow test first.`} />
      </h1>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2">
        <Chip tone={mode === "off" ? "off" : "plain"} mono>CFC_MODE {mode ?? "—"}</Chip>
        <Chip tone={on ? "ok" : "off"} dot>{sessions?.enabled == null ? "sessions —" : on ? "sessions on" : "sessions off"}</Chip>
        {sessions ? <span className="mono" title={`Sessions started today, of ${sessions.perDay} a day (closed sessions do not count)`}>{sessions.today}/{sessions.perDay} today</span> : null}
        {canControl && sessions?.enabled != null ? (
          <button type="button" className="btn min-h-[30px] px-2.5 py-1" disabled={busy || (!on && !runs)} title={!on && !runs ? "CFC_MODE must be on or auto to run sessions" : undefined} onClick={() => onSwitch(!on)}>{on ? "Turn off" : "Turn on"}</button>
        ) : null}
        {error ? <span role="alert" className="mono text-fault">{error}</span> : null}
      </div>
    </div>
  );
}

export function Tabs({ tab, open, running, onTab = noop }: { tab: TabKey; open: number | null; running: number | null; onTab?: (t: TabKey) => void }) {
  const items: [TabKey, string, number | null][] = [["suggestions", "Suggestions", open], ["sessions", "Sessions", running], ["archive", "Archive", null]];
  return (
    <nav aria-label="Call for Councils" className="flex gap-1 rounded-[10px] border border-white/8 bg-black/25 p-1 sm:rounded-none sm:border-x-0 sm:border-t-0 sm:bg-transparent sm:p-0 sm:pb-1.5">
      {items.map(([k, label, n]) => (
        <button key={k} type="button" aria-current={tab === k ? "page" : undefined} onClick={() => onTab(k)}
          className={clsx("inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg px-3.5 text-[13px] font-medium sm:min-h-[40px] sm:flex-none",
            tab === k ? "bg-white/7 text-fg shadow-[inset_0_-2px_0_#22d3ee]" : "text-fg-2 hover:bg-white/4 hover:text-fg")}>
          {label}{n ? <Chip tone="late" mono>{n}</Chip> : null}
        </button>
      ))}
    </nav>
  );
}

// ------------------------------------------------------------------ Suggestions
export type CardState = { sending?: Decision | null; result?: DecideResult | null; decision?: Decision };
export function SuggestionCard({ s, now, canControl, state = {}, onDecide = noop, onEvidence = noop, onOpenSession = noop }: { s: Suggestion; now: number; canControl: boolean; state?: CardState; onDecide?: (s: Suggestion, d: Decision) => void; onEvidence?: (topic: string) => void; onOpenSession?: (id: string) => void }) {
  const open = s.status === "open";
  const cd = s.countdown;
  const soon = cd?.soon === true;
  const sending = state.sending ?? null;
  const r = state.result ?? null;
  return (
    <article className={clsx("glass-inner flex flex-col gap-2.5 p-3.5", soon && "border-late-fill/30", s.status === "expired" && "bg-black/10")}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5"><Chip tone={s.status === "expired" ? "off" : "plain"}>{s.type}</Chip><span className="mono truncate text-[11px] text-fg-2">{s.rule}</span></span>
        {open ? <Chip tone="late" dot={soon}>{soon ? "expiring" : "open"}</Chip> : <Chip tone={s.tone}>{s.status}</Chip>}
      </div>
      <div className={clsx("mono break-all text-[12.5px] font-semibold", open ? "text-fg" : s.status === "expired" ? "text-fg-2" : "text-slate-300")}>{s.topicKey}</div>
      {s.summary ? <div className={clsx("text-[12px] leading-snug sm:min-h-[34px]", open ? "text-slate-300" : "text-fg-2")}>{s.summary}</div> : null}
      {open && cd ? (
        <div className="flex flex-col gap-1.5">
          <div className="h-[3px] overflow-hidden rounded-sm bg-white/7"><div className={clsx("h-[3px]", widthOf(cd.remaining), soon ? "bg-late-fill" : "bg-off-fill/55")} /></div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
            <span className={clsx("mono text-[12px] font-semibold", soon ? "text-late" : "text-fg")} title={cd.at}>expires in {cd.left}</span>
            <span className="mono text-[10.5px] text-muted">{cd.at}</span>
          </div>
        </div>
      ) : null}
      {open ? (
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          <span>suggested {agoText(s.createdAt, now)} · seen {agoText(s.lastSeenAt, now)}</span>
          <button type="button" className={linkCls} onClick={() => onEvidence(s.topicKey)}>Evidence</button>
        </div>
      ) : (
        <div className="mono text-[11px] leading-relaxed text-muted">{decidedByText(s.decidedBy, s.status)}<br />{whenText(endedAt(s), now)}</div>
      )}
      {!open && s.sessionId ? (
        <div className="flex items-center justify-between gap-2 border-t border-white/6 pt-2"><span className="mono text-[11.5px] text-slate-300">{s.sessionId}</span><button type="button" className={linkCls} onClick={() => onOpenSession(s.sessionId!)}>Open session</button></div>
      ) : !open && s.status === "rejected" ? <div className="text-[11px] text-muted">No session opened.</div> : null}
      {open && canControl ? (
        <div className="flex gap-2 pt-0.5">
          <button type="button" className="btn btn-approve min-h-[36px] flex-1 justify-center" disabled={sending != null} aria-busy={sending === "approve" || undefined} onClick={() => onDecide(s, "approve")}>{sending === "approve" ? <><Spin />Approving</> : "Approve"}</button>
          <button type="button" className="btn min-h-[36px] flex-1 justify-center" disabled={sending != null} aria-busy={sending === "reject" || undefined} onClick={() => onDecide(s, "reject")}>{sending === "reject" ? <><Spin />Rejecting</> : "Reject"}</button>
        </div>
      ) : null}
      {r && r.kind !== "ok" ? <DecideNote r={r} onRetry={r.retry && canControl && open && state.decision ? () => onDecide(s, state.decision!) : undefined} /> : null}
    </article>
  );
}
/** A decide answer that is not a success, under the card's buttons: the code in mono, then what it means. */
export function DecideNote({ r, onRetry }: { r: DecideResult; onRetry?: () => void }) {
  const fault = r.tone === "fault";
  return (
    <div role={fault ? "alert" : "status"} className={clsx("flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11.5px] leading-snug", fault ? "border-fault-fill/30 bg-fault-fill/8 text-fault" : "border-late-fill/30 bg-late-fill/7 text-late")}>
      <span className="mono whitespace-nowrap font-semibold">{r.code}</span><span className="flex-1">{r.words}</span>
      {onRetry ? <button type="button" className="btn min-h-[28px] px-2.5 py-0.5 text-[11.5px]" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

/** The recent suggestions: the ones whose chain still needs someone are listed; the ended ones are one Archive line. */
export function RecentList({ recent, archive, now, onOpenArchive = noop, onOpenSession = noop }: { recent: Suggestion[]; archive: Archive | null; now: number; onOpenArchive?: () => void; onOpenSession?: (id: string) => void }) {
  const rows = recent.map((s) => ({ s, c: s.id != null ? chainFor(archive, { suggestionId: s.id }) : null }));
  // A known chain decides; an unloaded one: an approved topic still needs the council, a rejected or expired one no one.
  const listed = rows.filter(({ s, c }) => (c ? !c.terminal : s.status === "approved"));
  const ended = rows.filter((r) => !listed.includes(r));
  const by = new Map<string, number>();
  for (const { s, c } of ended) { const k = c ? c.text : s.status; by.set(k, (by.get(k) ?? 0) + 1); }
  const line = [...by.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k, n]) => `${n} ${k}`).join(" · ");
  const when = (s: Suggestion) => whenText(endedAt(s), now);
  return (
    <div className="flex flex-col gap-2">
      {listed.length ? (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="tbl">
              <thead><tr><th className="w-[110px]">Status</th><th>Topic</th><th>Source</th><th>When</th><th>Session</th></tr></thead>
              <tbody>{listed.map(({ s, c }) => (
                <tr key={s.id ?? s.topicKey}>
                  <td><Chip tone={c ? c.tone : s.tone}>{c ? c.text : s.status}</Chip></td>
                  <td className="mono text-fg">{s.topicKey}</td>
                  <td className="mono text-fg-2">{s.type} · {s.rule}</td>
                  <td className="mono whitespace-nowrap text-fg-2">{when(s)}</td>
                  <td className="mono">{s.sessionId ? <button type="button" className="mono text-[12px] text-ok underline-offset-2 hover:underline" onClick={() => onOpenSession(s.sessionId!)}>{s.sessionId}</button> : "—"}</td>
                </tr>))}</tbody>
            </table>
          </div>
          <div className="glass-inner flex flex-col px-3 md:hidden">{listed.map(({ s, c }) => (
            <div key={s.id ?? s.topicKey} className="flex items-center justify-between gap-2.5 border-b border-white/5 py-2.5 last:border-b-0">
              <div className="flex min-w-0 flex-col gap-0.5"><span className="mono truncate text-[12px] text-fg">{s.topicKey}</span><span className="mono text-[10.5px] text-muted">{when(s)}</span></div>
              <Chip tone={c ? c.tone : s.tone}>{c ? c.text : s.status}</Chip>
            </div>))}</div>
        </>
      ) : <p className="text-[12px] text-muted">No recent topic needs anyone now.</p>}
      {ended.length ? <button type="button" onClick={onOpenArchive} className="mono self-start text-left text-[12px] text-fg-2 underline-offset-2 hover:text-fg hover:underline">Recent: {line}</button> : null}
    </div>
  );
}

export function SuggestionsView({ sug, archive, now, canControl, cards = {}, notice = null, pack = null, onDecide, onEvidence = noop, onOpenArchive, onOpenSession, poll }: {
  sug: Suggestions; archive: Archive | null; now: number; canControl: boolean; cards?: Record<number, CardState>; notice?: { topic: string; r: DecideResult } | null; pack?: ReactNode;
  onDecide?: (s: Suggestion, d: Decision) => void; onEvidence?: (t: string) => void; onOpenArchive?: () => void; onOpenSession?: (id: string) => void; poll?: Poll;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Section id="cfc-open" title="Open" hint={`Checked once an hour while the market is open. One open card per topic, the same signal at most once in 7 days, at most 3 new a day. An open card expires if nobody decides${canControl ? "" : "; only the owner approves or rejects"}.`}
        right={<span className="mono text-[11px] text-muted">soonest expiry first</span>}>
        {poll ? <PollStrip poll={poll} className="mb-0" /> : null}
        {sug.mode === "off" ? <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2"><Chip tone="off" mono>CFC_MODE off</Chip>No new suggestions and no sessions. The archive stays readable.</div> : null}
        {notice ? (
          <div role="status" className={clsx("flex flex-wrap items-center gap-2 text-[12px]", notice.r.kind === "ok" ? "text-ok" : "text-late")}>
            <span className="mono font-semibold">{notice.topic}</span><span>{notice.r.words}</span>
            {notice.r.sessionId && onOpenSession ? <button type="button" className={linkCls} onClick={() => onOpenSession(notice.r.sessionId!)}>Open session</button> : null}
          </div>
        ) : null}
        {sug.open.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {sug.open.map((s) => <SuggestionCard key={s.id ?? s.topicKey} s={s} now={now} canControl={canControl} state={s.id != null ? cards[s.id] : undefined} onDecide={onDecide} onEvidence={onEvidence} onOpenSession={onOpenSession} />)}
          </div>
        ) : <Empty when="The flags run once an hour while the market is open.">0 open suggestions</Empty>}
      </Section>
      <Section id="cfc-recent" title="Recent" hint="The last 7 days of decided and expired suggestions. Only the ones that still need someone are listed; the whole chain of each one is in Archive."
        right={onOpenArchive ? <button type="button" className={linkCls} onClick={onOpenArchive}>Archive</button> : null}>
        <RecentList recent={sug.recent} archive={archive} now={now} onOpenArchive={onOpenArchive} onOpenSession={onOpenSession} />
      </Section>
      {pack}
    </div>
  );
}

// ------------------------------------------------------------------ Sessions
function TallyLine({ t }: { t: Tally }) {
  return (
    <span className="mono inline-flex flex-wrap gap-x-2.5 text-[11.5px]">
      <span className="text-ok" title="agree">{t.support} agree</span><span className="text-late" title="agree, with a change">{t.amend} change</span>
      <span className="text-fault" title="disagree">{t.oppose} disagree</span><span className="text-off" title="abstain">{t.abstain} abstain</span>
    </span>
  );
}
function TallyBar({ t }: { t: Tally }) {
  const seg = (n: number, cls: string) => Array.from({ length: n }, (_, i) => <span key={`${cls}${i}`} className={clsx("h-2 w-[18px] rounded-[2px] sm:w-[22px]", cls)} />);
  return <span role="img" aria-label={`Tally: ${tallyText(t)}`} className="flex gap-[3px]">{seg(t.support, "bg-ok-fill")}{seg(t.amend, "bg-late-fill")}{seg(t.oppose, "bg-fault-fill")}{seg(t.abstain, "bg-off-fill")}</span>;
}

/** A running session: the question, its step and calls, and each seat's progress (opinion, response) and stance so far. */
export function RunningCard({ row, detail, now, callsMax, onOpen = noop }: { row: SessionRow; detail: Detail | null; now: number; callsMax: number; onOpen?: (id: string) => void }) {
  const waiting = row.state === "awaiting_owner";
  return (
    <article className="glass-inner flex flex-col gap-3.5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-[13.5px] font-semibold text-fg">{row.topicText ?? row.question ?? row.topicKey}</div>
          <div className="mono break-all text-[11.5px] text-fg-2">{row.topicKey} · {row.id}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="late" dot>{waiting ? "awaiting pick" : "running"}</Chip>
          {detail?.step ? <Chip tone="plain" mono>{detail.step}</Chip> : null}
          <span className="mono text-[12px] text-slate-300" title={`Model calls used, of ${callsMax}`}>{row.calls ?? "—"}/{callsMax} calls</span>
          <span className="mono text-[11px] text-muted">started {whenText(row.createdAt, now)}</span>
          <button type="button" className={linkCls} onClick={() => onOpen(row.id)}>Open</button>
        </div>
      </div>
      {detail?.seats.length ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {detail.seats.map((p) => { const st = p.stance ? stanceOf(p.stance) : stanceOf(null); return (
            <div key={p.id} className="flex flex-col gap-2 rounded-[10px] border border-white/6 bg-white/1.5 p-2.5">
              <div className="truncate text-[12px] font-semibold text-fg">{p.name}</div>
              <div className="flex items-center gap-1" title="opinion, response">
                <span className={clsx("h-2 w-2 rounded-[2px]", p.opinion ? "bg-off-fill" : "bg-white/10")} /><span className={clsx("h-2 w-2 rounded-[2px]", p.response ? "bg-off-fill" : "bg-white/10")} />
                <span className="mono ml-1 text-[10.5px] text-muted">{p.response ? "responded" : p.opinion ? "opinion" : "waiting"}</span>
              </div>
              <span className="self-start"><Chip tone={st.tone}>{st.text}</Chip></span>
            </div>); })}
        </div>
      ) : detail ? null : <Skeleton rows={1} />}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px] bg-off-fill" />given</span>
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px] bg-white/10" />not yet</span>
        <span>stance: the seat&apos;s vote on the topic so far</span>
      </div>
    </article>
  );
}

const decidedBy = (row: SessionRow, c: Chain | null): string => (row.state === "decided" ? c?.proposal?.decidedBy ?? "—" : row.state === "closed" ? "owner" : "—");
export function SessionsView({ sessions, archive, now, details = {}, onOpen = noop, poll, renderRunning }: { sessions: Sessions; archive: Archive | null; now: number; details?: Record<string, Detail | null>; onOpen?: (id: string) => void; poll?: Poll; renderRunning?: (row: SessionRow) => ReactNode }) {
  const live = [...sessions.running, ...sessions.waiting];
  return (
    <div className="flex flex-col gap-4">
      <Section id="cfc-running" title="Running" hint={`Opening opinions, then responses to each other, then the moderator's options (always including no change); the seats then vote and the council decides. At most 6 seats and ${sessions.callsMax} calls a session.`}
        right={<span className="mono text-[11px] text-muted">refreshes every 10s</span>}>
        {poll ? <PollStrip poll={poll} className="mb-0" /> : null}
        {live.length ? live.map((r) => renderRunning ? <div key={r.id}>{renderRunning(r)}</div> : <RunningCard key={r.id} row={r} detail={details[r.id] ?? null} now={now} callsMax={sessions.callsMax} onOpen={onOpen} />)
          : <Empty when={sessions.enabled === false ? "Sessions are off." : "A session opens when a topic is approved."}>No session running</Empty>}
      </Section>
      <Section id="cfc-ended" title="Ended" hint="Decided by the council, aborted by a step (its reason on hover), or closed. Each decided session's pick is a proposal: its progress is in Archive."
        right={<span className="mono text-[11px] text-muted">newest first</span>}>
        {sessions.ended.length ? (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="tbl">
                <thead><tr><th className="w-[96px]">Status</th><th>Topic</th><th>Decided by</th><th>Tally</th><th>Pick</th><th>Ended</th><th><span className="sr-only">Open</span></th></tr></thead>
                <tbody>{sessions.ended.map((r) => { const c = chainFor(archive, { sessionId: r.id }); const t = c?.session?.tally ?? null; return (
                  <tr key={r.id}>
                    <td><Chip tone={toneOf(r.state)} title={r.reason ?? undefined}>{statusText(r.state)}</Chip></td>
                    <td><div className="mono break-all text-fg">{r.topicKey}</div><div className="mono text-[10.5px] text-muted">{r.id}</div></td>
                    <td className="mono text-slate-300">{decidedBy(r, c)}</td>
                    <td>{t ? <TallyLine t={t} /> : <span className="text-muted">—</span>}</td>
                    <td className="text-fg">{c?.proposal?.title ?? "—"}</td>
                    <td className="mono whitespace-nowrap text-fg-2">{whenText(r.updatedAt, now)}</td>
                    <td><button type="button" className={linkCls} onClick={() => onOpen(r.id)}>Open</button></td>
                  </tr>); })}</tbody>
              </table>
            </div>
            <div className="flex flex-col gap-2 md:hidden">{sessions.ended.map((r) => { const c = chainFor(archive, { sessionId: r.id }); const t = c?.session?.tally ?? null; return (
              <article key={r.id} className="glass-inner flex flex-col gap-1.5 p-3">
                <div className="flex items-center justify-between gap-2"><Chip tone={toneOf(r.state)} title={r.reason ?? undefined}>{statusText(r.state)}</Chip><button type="button" className={linkCls} onClick={() => onOpen(r.id)}>Open</button></div>
                <div className="mono break-all text-[12px] text-fg">{r.topicKey}</div>
                <div className="mono text-[10.5px] text-muted">{r.id}</div>
                <div className="mono text-[11px] text-fg-2">by {decidedBy(r, c)} · {whenText(r.updatedAt, now)}</div>
                {c?.proposal?.title ? <div className="text-[12px] text-fg">{c.proposal.title}</div> : null}
                {t ? <TallyLine t={t} /> : null}
              </article>); })}</div>
          </>
        ) : <Empty>No ended session yet.</Empty>}
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------ one session (the read-only option pick)
/** One agent's opinion: who, the stance, what it thinks in its own words, what it would try; evidence behind a link. */
export function OpinionCard({ m }: { m: any }) {
  const [ev, setEv] = useState(false);
  const st = stanceOf(m.stance);
  if (m.round === "notice") return (
    <div className="rounded-lg border border-amber-400/25 bg-amber-400/5 p-3 text-[12px] text-amber-100"><div className="mb-1 text-[11px] font-medium text-late">Could not answer</div>{m.opinion}</div>
  );
  if (m.round === "owner") return (
    <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-3 text-[12px] text-slate-200"><div className="mb-1 text-[11px] font-medium text-cyan-300">You{m.reply_to?.length ? ` → ${m.reply_to.join(", ")}` : ""}</div>{m.opinion}</div>
  );
  return (
    <div className="glass-inner p-3">
      <div className="flex items-center justify-between gap-2"><div className="text-[13px] font-semibold text-slate-100">{m.name}</div><Badge tone={st.tone}>{st.text}</Badge></div>
      {m.reply_to?.length ? <div className="mt-0.5 text-[10.5px] text-slate-500">replying to {m.reply_to.join(", ")}</div> : null}
      <p className="mt-2 text-[12.5px] leading-relaxed text-slate-200">{m.opinion}</p>
      {m.proposal ? <div className="mt-2 text-[11.5px] text-slate-300"><span className="text-slate-500">Would try: </span>{m.proposal}</div> : null}
      {/* H3f: the owner's Rate / correct (the message's own ev_ref; its cited refs as evidence), beside the evidence line. */}
      {m.refs?.length ? (
        <div className="mt-1.5 flex items-end justify-between gap-2 text-[10.5px]">
          <div className="min-w-0"><button type="button" className="text-slate-500 underline-offset-2 hover:underline" onClick={() => setEv((x) => !x)}>evidence ({m.refs.length})</button>
            {ev ? <ul className="mono mt-1 space-y-0.5 break-all text-slate-500">{m.refs.map((r: string) => <li key={r}>{r}</li>)}</ul> : null}</div>
          <CorrectionControl target={councilOpinionTarget(m)} />
        </div>) : <CorrectionControl target={councilOpinionTarget(m)} className={`mt-1.5 ${ROW}`} />}
    </div>
  );
}

export type DetailActions = { busy?: boolean; error?: string | null; onBack?: () => void; onClose?: () => void; onReopen?: () => void; onSend?: (text: string, to: string[]) => void };
/** One session: the header, the options the council weighed (read-only, its pick marked), the seats' votes, the rounds. */
export function SessionDetailView({ d, chain, now, canControl, enabled, actions = {} }: { d: Detail; chain: Chain | null; now: number; canControl: boolean; enabled: boolean; actions?: DetailActions }) {
  const s = d.raw;
  const [text, setText] = useState(""); const [to, setTo] = useState<string[]>([]);
  const t = chain?.session?.tally ?? null;
  const pickWord = d.pickedBy === "owner" ? "owner's pick" : d.pickedBy === "council" ? "council's pick" : "pick";
  return (
    <div className="flex flex-col gap-4">
      {actions.onBack ? <button type="button" className={clsx(linkCls, "self-start")} onClick={actions.onBack}>Sessions</button> : null}
      <section aria-labelledby="cfc-detail" className="glass flex flex-col gap-3.5 p-4 sm:p-[18px]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 id="cfc-detail" className="text-[16px] font-semibold text-fg">{d.question}</h2>
            <div className="mono break-all text-[11.5px] text-fg-2">{d.topicKey} · {d.id}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={d.tone} dot={d.tone === "late"}>{d.statusText}</Chip>
            {d.step ? <Chip tone="plain" mono>{d.step}</Chip> : null}
            {d.pickedBy ? <span className="mono text-[12px] text-slate-300" title="decided_by">decided by <span className="font-semibold text-fg">{d.pickedBy}</span></span> : null}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 border-t border-white/6 pt-3 md:grid-cols-5">
          <div><div className="eyebrow">{chain?.topic.decidedAt && chain.topic.decidedBy === "owner" ? "Approved" : "Started"}</div><div className="mono text-[12px]">{whenText(chain?.topic.decidedBy === "owner" ? chain.topic.decidedAt : d.createdAt, now)}</div></div>
          <div><div className="eyebrow">{d.state === "decided" ? "Decided" : d.terminal ? "Ended" : "Updated"}</div><div className="mono text-[12px]">{whenText(d.updatedAt, now)}</div></div>
          <div><div className="eyebrow">Calls</div><div className="mono text-[12px]">{d.calls ?? "—"}/16</div></div>
          <div><div className="eyebrow">Evidence</div><div className="mono text-[12px]">{d.refs ?? 0} refs{d.packHash ? <span className="text-fg-2" title="pack sha256"> · {d.packHash.slice(0, 12)}…</span> : null}</div></div>
          <div><div className="eyebrow">Proposal</div>{chain?.proposal ? <div className="flex flex-wrap items-center gap-1.5"><Chip tone={chain.proposal.step.tone}>{chain.proposal.step.text}</Chip><span className="mono text-[11px] text-slate-300">next {chain.nextActor}</span></div> : <div className="mono text-[12px] text-muted">—</div>}</div>
        </div>
        {d.stale && !d.terminal ? <div className="text-[11px] text-late">{d.refs === 0 ? "This session ran on no evidence." : "This session's evidence is older than 24 hours."}</div> : null}
        {d.reason && d.state !== "decided" ? <div className="text-[11.5px] text-fg-2">{d.state === "aborted" ? "Stopped: " : ""}{d.reason}</div> : null}
        {canControl ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <button type="button" disabled={actions.busy || !enabled} onClick={actions.onReopen} title={enabled ? "Open a new session on the same topic and agents, with fresh evidence; this one is closed" : "Turn sessions on first"} className="btn min-h-[30px] px-2.5 py-1">Re-open with fresh evidence</button>
            {!d.terminal ? <button type="button" disabled={actions.busy} onClick={actions.onClose} title="End this session; it frees a slot and does not count toward the day" className="btn min-h-[30px] px-2.5 py-1">Close</button> : null}
            {actions.error ? <span role="alert" className="mono text-fault">{actions.error}</span> : null}
          </div>
        ) : null}
      </section>

      {d.options.length ? (
        <section aria-labelledby="cfc-options" className="glass flex flex-col gap-3 p-4 sm:p-[18px]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="cfc-options" className="flex items-center gap-2 text-[13px] font-semibold text-fg">Options the council weighed<Hint text="The moderator's options (always including no change). The seats voted; the council picked one. Read-only: nothing to accept here. A knob change runs its shadow test first, then goes live by itself and rolls back by itself if it does worse." /></h2>
            {t ? <div className="flex flex-wrap items-center gap-2.5"><span className="eyebrow">Tally</span><TallyBar t={t} /><span className="mono text-[11.5px] text-slate-300">{tallyText(t)}</span><Hint text="The stances of the opening opinions. The tally per option comes with the council's own pick." /></div> : null}
          </div>
          <div className="flex flex-col gap-3">
          {d.summary ? <p className="text-[12px] leading-normal text-slate-300">{d.summary}</p> : null}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{d.options.map((o) => (
            <article key={o.id} className={clsx("glass-inner flex flex-col gap-2 p-3.5", o.picked && "border-ok-fill/50 ring-1 ring-ok-fill/25")}>
              <div className="flex items-start justify-between gap-2">
                <div className="text-[13px] font-semibold text-fg"><span className="mono text-muted">{o.rank ?? "—"}</span> {o.title}</div>
                {o.picked ? <Chip tone="ok">{pickWord}</Chip> : null}
              </div>
              {kindText(o.kind) ? <span className="self-start"><Chip tone={o.kind === "no_change" ? "off" : "plain"}>{kindText(o.kind)}</Chip></span> : null}
              {o.hypothesis ? <div className="text-[12px] leading-normal text-slate-300">{o.hypothesis}</div> : null}
              {o.knob ? <div className="mono rounded-md bg-white/3 px-2 py-1.5 text-[11.5px] text-fg">{o.knob}</div> : null}
              {o.kind === "repository_task" && o.spec ? <div className="text-[11px] text-slate-300">To build: {o.spec}</div> : null}
              <div className="text-[11px] leading-normal text-fg-2">Change: {o.change ?? "—"} · Risk: {o.risk ?? "—"}<br />Dissent: {o.dissent ?? "—"}</div>
            </article>))}</div>
          {/* H3f: the owner's Rate / correct under the moderator's options (the session's ev_ref; each option's as evidence). */}
          <CorrectionControl target={councilOptionsTarget(s)} className={`mt-[12px] ${ROW}`} /></div>
        </section>
      ) : null}

      {d.seats.length ? (
        <section aria-labelledby="cfc-seats" className="glass flex flex-col gap-2 p-4 sm:p-[18px]">
          <h2 id="cfc-seats" className="flex items-center gap-2 text-[13px] font-semibold text-fg">Seat votes<Hint text="Each seat's latest stance and what it would try. The evidence each one cites sits behind the rounds below." /></h2>
          <div className="hidden overflow-x-auto md:block">
            <table className="tbl">
              <thead><tr><th className="w-[190px]">Seat</th><th className="w-[170px]">Vote</th><th>Would try</th><th className="w-[90px]">Evidence</th><th className="w-[90px]"><span className="sr-only">Rate or correct</span></th></tr></thead>
              <tbody>{d.seats.map((p) => { const st = stanceOf(p.stance); return (
                <tr key={p.id}>
                  <td className="font-semibold text-fg">{p.name}</td>
                  <td><Chip tone={st.tone}>{st.text}</Chip></td>
                  <td>{p.proposal ?? "—"}</td>
                  <td className="mono text-[11.5px]">{p.refs} refs</td>
                  <td>{p.message ? <CorrectionControl target={councilOpinionTarget(p.message)} /> : null}</td>
                </tr>); })}</tbody>
            </table>
          </div>
          <div className="flex flex-col md:hidden">{d.seats.map((p) => { const st = stanceOf(p.stance); return (
            <div key={p.id} className="flex flex-col gap-1.5 border-b border-white/5 py-2.5 last:border-b-0">
              <div className="flex items-center justify-between gap-2"><span className="text-[12.5px] font-semibold text-fg">{p.name}</span><Chip tone={st.tone}>{st.text}</Chip></div>
              <div className="text-[12px] text-slate-300">{p.proposal ?? "—"}</div>
              <div className="flex items-center justify-between gap-2"><span className="mono text-[11px] text-muted">{p.refs} refs</span>{p.message ? <CorrectionControl target={councilOpinionTarget(p.message)} /> : null}</div>
            </div>); })}</div>
        </section>
      ) : null}

      {d.rounds.length ? (
        <section className="glass flex flex-col p-1">
          {d.rounds.map((r, i) => (
            <details key={r.round} className={clsx("px-3 py-2.5", i && "border-t border-white/6")}>
              <summary className="cursor-pointer text-[12.5px] font-semibold text-fg">{r.title} <span className="mono font-normal text-muted">{r.messages.length}</span></summary>
              <div className="mt-2.5 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{r.messages.map((m: any) => <OpinionCard key={m.id} m={m} />)}</div>
            </details>
          ))}
        </section>
      ) : null}

      {canControl && !d.terminal ? (
        <section aria-label="Write to the agents" className="glass flex flex-col gap-2 p-4">
          <div className="flex flex-wrap gap-1.5 text-[11px]">{d.participants.map((p) => (
            <button key={p.id} type="button" onClick={() => setTo((x) => x.includes(p.id) ? x.filter((y) => y !== p.id) : x.length < 2 ? [...x, p.id] : x)}
              className={clsx("rounded-sm px-2 py-1 ring-1", to.includes(p.id) ? "bg-cyan-500/20 text-cyan-200 ring-cyan-400/40" : "text-slate-300 ring-slate-600/50")}>{p.name}</button>))}</div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={1000} placeholder="Write to the agents (pick 1 or 2 above to answer)" className="rounded-md bg-slate-900/60 p-2 text-[12px] text-slate-200 ring-1 ring-slate-700" />
          <div className="flex items-center gap-2"><button type="button" disabled={actions.busy || !text.trim() || !to.length} onClick={() => { actions.onSend?.(text, to); setText(""); setTo([]); }} className="btn btn-approve min-h-[32px] px-3 py-1">Send</button>{!to.length ? <span className="text-[11px] text-muted">pick an agent to answer</span> : null}</div>
        </section>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ Archive
const Arrow = ({ on }: { on: boolean }) => <ArrowRight className={clsx("h-[14px] w-[14px]", on ? "text-off/60" : "text-white/10")} aria-hidden="true" />;
const actorCls = (a: string) => (a === "owner" ? "text-late" : a === "none" ? "text-muted" : "text-slate-300");
const CHAIN_GRID = "grid grid-cols-[minmax(0,1.25fr)_18px_minmax(0,1fr)_18px_minmax(0,1.45fr)_110px_120px_150px] items-center gap-x-2 px-3 py-2.5";
function ChainRow({ c, now }: { c: Chain; now: number }) {
  return (
    <div className={clsx(CHAIN_GRID, "border-b border-white/5 hover:bg-white/2")}>
      <div className="flex min-w-0 flex-col gap-1">{c.topic.step ? <span className="self-start"><Chip tone={c.topic.step.tone}>{c.topic.step.text}</Chip></span> : <span className="self-start"><Chip tone="plain">owner topic</Chip></span>}<span className="mono truncate text-[11.5px] text-fg" title={c.topic.key}>{c.topic.key}</span></div>
      <Arrow on={c.session != null} />
      <div className="flex min-w-0 flex-col gap-1">{c.session ? <><span className="self-start"><Chip tone={c.session.step.tone}>{c.session.step.text}</Chip></span><span className="mono truncate text-[11.5px] text-fg-2">{c.session.id}{c.session.reopenedAs ? ` → ${c.session.reopenedAs}` : ""}</span></> : <span className="text-muted">—</span>}</div>
      <Arrow on={c.proposal != null} />
      <div className="flex min-w-0 flex-col gap-1">{c.proposal ? <><span className="flex items-center gap-1.5"><Chip tone={c.proposal.step.tone}>{c.proposal.step.text}</Chip>{c.proposal.kindText ? <span className="text-[10.5px] text-muted">{c.proposal.kindText}</span> : null}</span><span className="truncate text-[12px] text-fg" title={c.proposal.knob ?? c.proposal.title ?? ""}>{c.proposal.knob ?? c.proposal.title ?? "—"}</span></> : <span className="text-muted">—</span>}</div>
      <span className={clsx("mono text-[11.5px]", actorCls(c.nextActor))}>{c.nextActor}</span>
      <span className="mono truncate text-[11.5px] text-fg-2" title={c.proposal?.closeCode ?? ""}>{c.proposal?.closeCode ?? "—"}</span>
      <span className="mono text-[11px] leading-snug text-fg-2">{whenText(c.updatedAt, now)}</span>
    </div>
  );
}
function ChainCard({ c, now }: { c: Chain; now: number }) {
  const link = (label: string, chip: ReactNode, sub: ReactNode, last = false) => (
    <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5">
      <div className="flex flex-col items-center"><i className="mt-[5px] h-[9px] w-[9px] rounded-full border-[1.5px] border-off" />{last ? null : <b className="my-[3px] w-[1.5px] flex-1 bg-off/30" />}</div>
      <div className="flex flex-col gap-1 pb-2.5"><span className="flex items-center gap-1.5"><span className="w-[52px] text-[10.5px] text-muted">{label}</span>{chip}</span>{sub}</div>
    </div>
  );
  return (
    <article className="flex flex-col rounded-[14px] border border-white/8 bg-panel/80 px-3.5 py-3">
      {link("Topic", c.topic.step ? <Chip tone={c.topic.step.tone}>{c.topic.step.text}</Chip> : <Chip tone="plain">owner topic</Chip>, <span className="mono break-all text-[12px] text-fg">{c.topic.key}</span>)}
      {link("Session", c.session ? <Chip tone={c.session.step.tone}>{c.session.step.text}</Chip> : <span className="text-muted">—</span>, <span className="mono text-[11.5px] text-fg-2">{c.session?.id ?? "—"}</span>)}
      {link("Proposal", c.proposal ? <Chip tone={c.proposal.step.tone}>{c.proposal.step.text}</Chip> : <span className="text-muted">—</span>, <span className="text-[12px] text-fg">{c.proposal?.knob ?? c.proposal?.title ?? "—"}</span>, true)}
      <div className="mono flex justify-between gap-2 border-t border-white/6 pt-2 text-[11px] text-fg-2"><span>next <span className={actorCls(c.nextActor)}>{c.nextActor}</span></span><span>{c.proposal?.closeCode ?? "—"}</span><span className="text-muted">{whenText(c.updatedAt, now)}</span></div>
    </article>
  );
}
/** An expired or rejected chain: one line, the topic, its chip, when it ended. */
export function OneLine({ c, now }: { c: Chain; now: number }) {
  return (
    <div data-line="one" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/5 px-3 py-2">
      <span className="mono min-w-0 flex-1 basis-[55%] truncate text-[12px] text-fg-2 md:basis-0" title={c.topic.key}>{c.topic.key}</span>
      <Chip tone={c.tone}>{c.text}</Chip>
      <span className="mono text-[11px] text-muted">{endedText(c, now)}</span>
    </div>
  );
}
const ChainHead = () => <div className={clsx(CHAIN_GRID, "border-b border-white/10 text-[11px] font-medium text-muted")}><span>Topic</span><span /><span>Session</span><span /><span>Proposal</span><span>Next actor</span><span>Close code</span><span>Updated</span></div>;
function ChainList({ chains, now }: { chains: Chain[]; now: number }) {
  const full = chains.filter((c) => !oneLine(c)), lines = chains.filter(oneLine);
  return (
    <div className="flex flex-col gap-2">
      {full.length ? (
        <>
          <div className="hidden overflow-x-auto md:block"><div className="min-w-[940px]"><ChainHead />{full.map((c) => <ChainRow key={c.id} c={c} now={now} />)}</div></div>
          <div className="flex flex-col gap-2.5 md:hidden">{full.map((c) => <ChainCard key={c.id} c={c} now={now} />)}</div>
        </>
      ) : null}
      {lines.length ? <div className="glass-inner flex flex-col">{lines.map((c) => <OneLine key={c.id} c={c} now={now} />)}</div> : null}
    </div>
  );
}

export type ArchiveUi = { open?: boolean; filter?: string; active?: string; loadingMore?: boolean; moreError?: string | null };
export function ArchiveView({ a, now, ui = {}, onToggle = noop, onFilter = noop, onActive = noop, onLoadMore = noop, poll }: { a: Archive; now: number; ui?: ArchiveUi; onToggle?: () => void; onFilter?: (f: string) => void; onActive?: (f: string) => void; onLoadMore?: () => void; poll?: Poll }) {
  const sp = splitArchive(a);
  const af = ui.active ?? "all", f = ui.filter ?? "all", open = ui.open === true;
  const active = activeOf(sp.active, af);
  const statuses = archiveStatuses(sp, a.statuses);
  const shown = archivedOf(sp, statuses.includes(f) ? f : "all");
  if (!sp.loaded) return (
    <Section id="cfc-archive" title="Archive" right={<span className="mono text-[11px] text-muted">0 chains</span>}>
      <Empty when="A chain starts when a suggestion is approved, rejected or expires.">0 chains</Empty>
    </Section>
  );
  return (
    <div className="flex flex-col gap-4">
      <Section id="cfc-active" title={<>Needs someone <span className="mono text-[11px] font-normal text-muted">{active.length} of {sp.active.length}</span></>}
        hint="Each row is one chain: the suggested topic, the session it opened, the proposal the council picked. Each step has one status. Next actor: who moves the chain next. Only chains that need someone are listed; the ended ones are in the Archive line below."
        right={<div className="flex flex-wrap items-center gap-1.5">{ACTIVE_FILTERS.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={af === k} onClick={() => onActive(k)} className={clsx("min-h-[30px] rounded-full border px-2.5 text-[11.5px] font-medium max-sm:min-h-[36px]", af === k ? "border-ok-fill/45 bg-ok-fill/8 text-ok" : "border-white/10 text-fg-2")}>{label}</button>))}</div>}>
        {poll ? <PollStrip poll={poll} className="mb-0" /> : null}
        {active.length ? <ChainList chains={active} now={now} /> : <Empty>{sp.active.length ? "No chain in this filter." : "Nothing needs anyone now."}</Empty>}
        <button type="button" aria-expanded={open} aria-controls="cfc-archive-list" onClick={onToggle}
          className="mono flex items-center gap-2 self-start rounded-lg border border-white/8 bg-black/20 px-3 py-2 text-left text-[12px] text-fg-2 hover:text-fg">
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>{summaryText(sp)}
        </button>
      </Section>
      {open ? (
        <Section id="cfc-archive" title={<>Archive <span className="mono text-[11px] font-normal text-muted">{shown.length} of {sp.archived.length} ended{sp.exact ? "" : `, of ${sp.loaded} loaded`}</span></>}
          hint={`The ended chains of the last ${a.windowDays ?? 90} days: no one acts on them any more. Expired and rejected topics are one line each. Close code: the platform's code for why a task ended, as sent.`}
          right={<label className="flex items-center gap-2 text-[11.5px] text-fg-2">Status
            <select className="mono min-h-[34px] rounded-lg border border-white/12 bg-black/35 px-2.5 text-[12px] text-fg" value={statuses.includes(f) ? f : "all"} onChange={(e) => onFilter(e.target.value)}>
              {statuses.map((o) => <option key={o} value={o}>{o === "all" ? "all" : statusText(o)}</option>)}
            </select></label>}>
          <div id="cfc-archive-list">{shown.length ? <ChainList chains={shown} now={now} /> : <p className="mono text-[12px] text-fg">0 chains · {f}</p>}</div>
          {a.nextCursor ? (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn min-h-[34px]" disabled={ui.loadingMore} onClick={onLoadMore}>{ui.loadingMore ? <><Spin />Loading</> : "Load more"}</button>
              <span className="mono text-[11px] text-muted">{sp.loaded} of {sp.total ?? "?"} chains loaded</span>
              {ui.moreError ? <span role="alert" className="mono text-[11px] text-fault">{ui.moreError}</span> : null}
            </div>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

/** The archive read failed: a 404 is a Worker without the route (the rest of the page works), else the error box. */
export function ArchiveUnread({ poll }: { poll: Poll }) {
  if (/ 404\b/.test(poll.error ?? "")) return (
    <Section id="cfc-archive" title="Archive"><Empty when="The archive is not on this Worker yet. Suggestions and Sessions still work.">{poll.error}</Empty></Section>
  );
  return <Section id="cfc-archive" title="Archive" right={<Chip tone="fault" dot>error</Chip>}><PollError poll={poll} /></Section>;
}

// ------------------------------------------------------------------ the page
const useNow = (every = 30_000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), every); return () => window.clearInterval(t); }, [every]);
  return now;
};
const errorOf = (r: { status: number | null; body: any }) => (r.status === 200 && r.body?.ok !== false ? null : `${r.status ?? "network"} ${r.body?.error ?? r.body?.code ?? "failed"}`);

/** A running session's seats: its own read every 10 s. */
function RunningSession({ row, now, callsMax, onOpen }: { row: SessionRow; now: number; callsMax: number; onOpen: (id: string) => void }) {
  const poll = usePoll(() => get(`/api/council/session?id=${encodeURIComponent(row.id)}`), 10_000, [row.id]);
  return <RunningCard row={row} detail={detailOf((poll.data as any)?.session)} now={now} callsMax={callsMax} onOpen={onOpen} />;
}

function SessionDetail({ id, archive, now, canControl, enabled, onBack, onOpen }: { id: string; archive: Archive | null; now: number; canControl: boolean; enabled: boolean; onBack: () => void; onOpen: (id: string) => void }) {
  const [tick, setTick] = useState(0);
  const poll = usePoll(() => get(`/api/council/session?id=${encodeURIComponent(id)}`), 10_000, [id, tick]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [confirm, dialog] = useConfirm();
  const d = detailOf((poll.data as any)?.session, chainFor(archive, { sessionId: id }));
  const act = async (body: unknown) => {
    setBusy(true); setError(null);
    const r = await postCouncil(body);
    setError(errorOf(r)); setBusy(false); setTick((t) => t + 1);
    return r;
  };
  const actions: DetailActions = {
    busy, error, onBack,
    onClose: async () => { if (await confirm({ title: "Close this session?", body: "It ends here: no more answers and no pick. It frees a slot and does not count toward the 4 sessions a day.", confirmLabel: "Close session", tone: "late" })) await act({ action: "close", session_id: id }); },
    onReopen: async () => { const r = await act({ action: "reopen", session_id: id }); if (r.body?.session_id) onOpen(r.body.session_id); },
    onSend: (text, to) => { void act({ action: "message", session_id: id, text, to }); }
  };
  if (phaseOf(poll) === "error") return <div className="flex flex-col gap-3"><button type="button" className={clsx(linkCls, "self-start")} onClick={onBack}>Sessions</button><PollError poll={poll} /></div>;
  if (!d) return poll.error != null ? <PollError poll={poll} /> : poll.loading ? <Skeleton rows={4} /> : <Empty>Session not found.</Empty>;
  return <>{dialog}<PollStrip poll={poll} className="mb-0" /><SessionDetailView d={d} chain={chainFor(archive, { sessionId: id })} now={now} canControl={canControl} enabled={enabled} actions={actions} /></>;
}

export default function Councils() {
  const now = useNow();
  const canControl = useOwnerGate();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const sugPoll = usePoll(() => get("/api/council/suggestions"), 60_000, [tick]);
  const sesPoll = usePoll(() => get("/api/council/sessions"), 30_000, [tick]);
  const arcPoll = usePoll(() => get(archivePath()), 60_000, [tick]);
  const [more, setMore] = useState<Archive | null>(null);
  const [tab, setTab] = useState<TabKey>("suggestions");
  const [openId, setOpenId] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [aui, setAui] = useState<ArchiveUi>({ open: false, filter: "all", active: "all" });
  const [cards, setCards] = useState<Record<number, CardState & { key?: string; decision?: Decision }>>({});
  const [notice, setNotice] = useState<{ topic: string; r: DecideResult } | null>(null);
  const [sw, setSw] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [confirm, dialog] = useConfirm();
  const packPoll = usePoll(() => (topic ? get(`/api/council/evidence?topic=${encodeURIComponent(topic)}`) : Promise.resolve(null)), 0, [topic]);

  const sug = useMemo(() => suggestionsOf(sugPoll.data, now), [sugPoll.data, now]);
  const sessions = useMemo(() => sesPoll.data ? sessionsOf(sesPoll.data, now) : null, [sesPoll.data, now]);
  const archive = useMemo(() => { const first = arcPoll.data ? archiveOf(arcPoll.data) : null; return first && more ? mergeArchive(first, more) : first; }, [arcPoll.data, more]);

  const decide = async (s: Suggestion, decision: Decision) => {
    if (s.id == null) return;
    const id = s.id;
    const approve = decision === "approve";
    const ok = await confirm({
      title: approve ? "Approve this topic?" : "Reject this topic?",
      body: <><div className="mono font-semibold text-fg">{s.topicKey}</div><p className="mt-1.5">{approve ? "A session opens at once on fresh evidence and the seats decide. A session never changes trading by itself." : "No session opens. The same signal is not suggested again for 7 days."}</p></>,
      ...(approve ? { confirmLabel: "Approve", tone: "ok" } : { confirmLabel: "Reject", tone: "late" })
    } as const);
    if (!ok) return;
    // One key per click intent; a retry of the same intent after an unanswered or refused send sends it again.
    const prev = cards[id];
    const key = prev?.key && prev.decision === decision && prev.result?.retry ? prev.key : decideKey(id, decision);
    setCards((c) => ({ ...c, [id]: { sending: decision, result: null, key, decision } }));
    const r = await postCouncil(decideRequest(id, decision, key));
    const res = decideResult(r.status, r.body, decision, Date.now());
    setCards((c) => ({ ...c, [id]: { sending: null, result: res, key, decision } }));
    if (res.kind === "ok" || res.kind === "already_decided" || res.kind === "expired") setNotice({ topic: s.topicKey, r: res });
    if (res.refresh) refresh();
  };
  const onSwitch = async (on: boolean) => {
    if (!on && !(await confirm({ title: "Turn council sessions off?", body: "Running sessions stop at their next step. You can turn them on again at any time.", confirmLabel: "Turn off", tone: "fault" }))) return;
    setSw({ busy: true, error: null });
    const r = await postCouncil({ action: "switch", on });
    setSw({ busy: false, error: errorOf(r) });
    refresh();
  };
  const loadMore = async () => {
    if (!archive?.nextCursor) return;
    setAui((u) => ({ ...u, loadingMore: true, moreError: null }));
    try { const page = archiveOf(await get(archivePath(archive.nextCursor))); setMore((m) => (m ? mergeArchive(m, page) : page)); setAui((u) => ({ ...u, loadingMore: false })); }
    catch (e) { setAui((u) => ({ ...u, loadingMore: false, moreError: e instanceof Error ? e.message : String(e) })); }
  };
  const openSession = (id: string) => { setOpenId(id); setTab("sessions"); };
  const openArchive = () => { setTab("archive"); setAui((u) => ({ ...u, open: true })); };
  const pk = packPoll.data as any;
  const packPanel = topic ? (
    <Section id="cfc-pack" title="Evidence pack" hint="Built now from the stored records, deterministically: the same evidence gives the same sha256. No price is in it."
      right={<button type="button" className={linkCls} onClick={() => setTopic(null)}>Hide</button>}>
      {packPoll.error && !pk ? <PollError poll={packPoll} /> : packPoll.loading ? <Skeleton rows={5} /> : pk?.pack ? <Pack pack={pk.pack} /> : <Empty>No pack.</Empty>}
    </Section>
  ) : null;

  const body = (poll: Poll, view: () => ReactNode) => (phaseOf(poll) === "error" ? <PollError poll={poll} /> : poll.data == null ? <Skeleton rows={3} /> : view());
  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-3.5 py-3.5 sm:px-6 sm:py-5">
      {dialog}
      <CouncilHeader mode={sug.mode ?? sessions?.mode ?? null} sessions={sessions} canControl={canControl} busy={sw.busy} error={sw.error} onSwitch={onSwitch} />
      <Tabs tab={tab} open={sugPoll.data ? sug.open.length : null} running={sessions ? sessions.running.length + sessions.waiting.length : null} onTab={(t) => { setTab(t); if (t === "sessions") setOpenId(null); }} />
      {tab === "suggestions" ? body(sugPoll, () => (
        <SuggestionsView sug={sug} archive={archive} now={now} canControl={canControl} cards={cards} notice={notice} pack={packPanel} poll={sugPoll}
          onDecide={decide} onEvidence={setTopic} onOpenArchive={openArchive} onOpenSession={openSession} />
      )) : tab === "sessions" ? (openId ? (
        <SessionDetail id={openId} archive={archive} now={now} canControl={canControl} enabled={sessions?.enabled === true} onBack={() => setOpenId(null)} onOpen={setOpenId} />
      ) : body(sesPoll, () => sessions ? (
        <SessionsView sessions={sessions} archive={archive} now={now} poll={sesPoll} onOpen={setOpenId}
          renderRunning={(r) => <RunningSession row={r} now={now} callsMax={sessions.callsMax} onOpen={setOpenId} />} />
      ) : null)) : (
        phaseOf(arcPoll) === "error" ? <ArchiveUnread poll={arcPoll} /> : !archive ? <Skeleton rows={4} /> : (
          <ArchiveView a={archive} now={now} ui={aui} poll={arcPoll} onToggle={() => setAui((u) => ({ ...u, open: !u.open }))} onFilter={(f) => setAui((u) => ({ ...u, filter: f }))}
            onActive={(f) => setAui((u) => ({ ...u, active: f }))} onLoadMore={loadMore} />
        )
      )}
    </div>
  );
}
