import { useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { AlertTriangle, Info, RotateCcw, ToggleRight } from "lucide-react";
import { PollError, PollStrip, Skeleton, phaseOf } from "../components/ui";
import { useConfirm } from "../components/ConfirmDialog";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { CHIP } from "../lib/tokens";
import {
  FS_PATH, FS_POLL_MS, MARK_ERA, MARK_EV, MARK_STOP, PROPAGATION_NOTE, canChange, configOnlyValue, canReset, clockText, columnsOf, confirmText, controlKind, errorWords, flipped, halves,
  optionsOf, postBody, postSwitch, resetLabel, resetTarget, switchesOf, tipOf, toggledTokens, valueText, wideControl,
  type Change, type ConfirmText, type Source, type SwitchGroup, type SwitchRow
} from "../lib/featureSwitches";

// Settings › Feature switches (FS1; owner 2026-11-25, relayed: "supaya bisa dikontrol perlu panel khusus pengaturan on off
// untuk semua fitur ini"; the owner-reviewed mockup "Nexus FS1 Feature switches"). Every owner-facing switch from GET
// /omega/api/feature-switches (src/feature-switch-store.mjs), each row only its label and key, its control on the same
// line, a source chip and the era / ev / emergency-stop marks; everything else in its ⓘ tooltip (owner: no cosmetic
// text). Controls only when viewer.can_control, never on a read-only row; every change confirms, and the one write is
// POST /omega/api/feature-switches (lib/featureSwitches.ts postSwitch), from these controls only.

/** A row's save state after the owner's change. */
export type RowStatus = { phase: "saving" } | { phase: "saved"; at: number; changed: boolean; era: boolean } | { phase: "failed"; error: string };

const SOURCE_CHIP: Record<Source, string> = { override: CHIP.late, config: CHIP.plain, default: CHIP.off };
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ok-fill";
const noop = () => {};

function Marks({ r }: { r: SwitchRow }) {
  return (
    <span className="col-start-2 row-start-1 flex items-center gap-1.5">
      {r.era_switch ? <span className="mono rounded-sm border border-white/15 px-1 text-[10.5px] leading-[14px] text-fg-2" title={MARK_ERA}>era</span> : null}
      {r.restarts_mode_evidence ? <span className="mono rounded-sm border border-dashed border-white/15 px-1 text-[10.5px] leading-[14px] text-fg-2" title={MARK_EV}>ev</span> : null}
      {r.emergency_stop ? <span role="img" aria-label="Emergency stop" title={MARK_STOP} className="inline-flex text-late"><AlertTriangle className="h-3.5 w-3.5" /></span> : null}
    </span>
  );
}

function Toggle({ r, busy, onChange }: { r: SwitchRow; busy: boolean; onChange: (c: Change) => void }) {
  const on = r.value === "on";
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" role="switch" aria-checked={on} aria-label={`${r.label} (${r.key})`} disabled={busy} onClick={() => onChange({ value: flipped(r) })}
        className={clsx("relative h-6 w-11 shrink-0 rounded-full border p-0 transition disabled:cursor-wait disabled:opacity-60 sm:h-5 sm:w-9", FOCUS,
          on ? "border-ok-fill/55 bg-ok-fill/20" : "border-off-fill/35 bg-off-fill/12")}>
        <span className={clsx("absolute top-[3px] h-4 w-4 rounded-full transition-all sm:h-3 sm:w-3", on ? "left-[23px] bg-ok sm:left-[19px]" : "left-[3px] bg-off")} />
      </button>
      <span className="mono min-w-[34px] text-[11.5px] leading-4 text-fg">{valueText(r.value)}</span>
    </span>
  );
}

function Segmented({ r, busy, onChange }: { r: SwitchRow; busy: boolean; onChange: (c: Change) => void }) {
  // A config-only value in force (ZONE_AHEAD_MODE "record"): shown as text beside the settable values, none pressed.
  const fixed = configOnlyValue(r);
  return (
    <span className="inline-flex items-center gap-2">
      {fixed ? <span className="mono text-[11.5px] text-fg" title="Set in the config; not settable here">{fixed}</span> : null}
      <div role="group" aria-label={`${r.label} (${r.key})`} className="inline-flex gap-0.5 rounded-lg border border-white/10 bg-black/30 p-0.5">
        {optionsOf(r).map((v) => {
          const pressed = r.value === v;
          return (
            <button key={v} type="button" aria-pressed={pressed} disabled={busy} onClick={() => { if (!pressed) onChange({ value: v }); }}
              className={clsx("mono rounded-md border px-2.5 py-[7px] text-[11.5px] leading-4 transition disabled:cursor-wait sm:px-[9px] sm:py-[3px]", FOCUS,
                pressed ? "border-white/30 bg-white/8 text-fg" : "border-transparent text-fg-2 hover:text-fg")}>
              {v}
            </button>
          );
        })}
      </div>
    </span>
  );
}

function Tokens({ r, busy, onChange }: { r: SwitchRow; busy: boolean; onChange: (c: Change) => void }) {
  const on = Array.isArray(r.value) ? r.value : [];
  return (
    <div role="group" aria-label={`${r.label} (${r.key}), the tokens on`} className="flex flex-wrap justify-end gap-1">
      {optionsOf(r).map((t) => {
        const pressed = on.includes(t);
        return (
          <button key={t} type="button" aria-pressed={pressed} disabled={busy} onClick={() => onChange({ value: toggledTokens(r, t) })}
            className={clsx("mono rounded-md border px-2.5 py-2 text-[11px] leading-4 transition disabled:cursor-wait sm:px-[7px] sm:py-[3px]", FOCUS,
              pressed ? "border-ok-fill/50 bg-ok-fill/12 text-ok" : "border-off-fill/25 bg-off-fill/6 text-off hover:text-fg")}>
            {t}
          </button>
        );
      })}
    </div>
  );
}

/** The value as text: a viewer's page, and a read-only row. */
function ValueText({ r }: { r: SwitchRow }) {
  const v = Array.isArray(r.value) && r.value.length === 0 ? "none on" : valueText(r.value);
  return <span className="mono min-w-0 text-right text-[12px] text-fg wrap-anywhere">{v}</span>;
}

function Control({ r, canControl, busy, onChange }: { r: SwitchRow; canControl: boolean; busy: boolean; onChange: (c: Change) => void }) {
  if (!canChange(r, canControl)) return <ValueText r={r} />;
  const kind = controlKind(r);
  if (kind === "toggle") return <Toggle r={r} busy={busy} onChange={onChange} />;
  if (kind === "segmented") return <Segmented r={r} busy={busy} onChange={onChange} />;
  return <Tokens r={r} busy={busy} onChange={onChange} />;
}

function Tip({ r, id, open, saved }: { r: SwitchRow; id: string; open: boolean; saved: boolean }) {
  const { dl, notes: base } = tipOf(r);
  // After a save of a feature-switch row: the propagation note (Omega settings are read from D1 by the next run).
  const notes = saved && r.write === "feature-switch" ? [...base, PROPAGATION_NOTE] : base;
  return (
    <div id={id} role="tooltip"
      className={clsx("z-30 col-span-full rounded-[10px] border border-white/15 bg-bar px-3 py-2.5 text-[12px] leading-[17px] text-slate-300 shadow-[0_12px_32px_rgba(0,0,0,0.55)] sm:absolute sm:left-0 sm:top-full sm:mt-0.5 sm:w-[340px] sm:max-w-full",
        open ? "block" : "hidden md:peer-hover:block md:peer-focus-visible:block")}>
      <div className="mono text-[11px] text-fg-2">{r.key}</div>
      {r.description ? <div className="mt-1">{r.description}</div> : null}
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5">
        {dl.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="mono break-words text-fg">{v}</dd></div>)}
      </dl>
      {notes.map((n) => <div key={n} className={clsx("mt-1.5", n === MARK_STOP ? "text-late" : "text-fg-2")}>{n}</div>)}
    </div>
  );
}

function StatusLine({ r, s }: { r: SwitchRow; s?: RowStatus }) {
  if (!s) return null;
  const cls = "mono col-span-full text-[12px] leading-4";
  if (s.phase === "saving") return <p className={clsx(cls, "text-fg-2")} aria-live="polite">saving…</p>;
  if (s.phase === "saved") {
    return (
      <p className={cls} aria-live="polite">
        <span className="text-ok" title={s.changed && r.write === "feature-switch" ? PROPAGATION_NOTE : undefined}>{s.changed ? "saved" : "no change"}</span>
        <span className="text-fg-2"> {clockText(s.at)} · owner{s.changed && s.era ? " · new parity era" : ""}</span>
      </p>
    );
  }
  return <p className={cls} role="alert"><span className="text-fault">{s.error}</span><span className="text-fg-2"> · {errorWords(s.error, r)}</span></p>;
}

export type RowProps = { r: SwitchRow; canControl: boolean; open: boolean; status?: RowStatus; onTip: (key: string) => void; onChange: (r: SwitchRow, c: Change) => void };

/**
 * One switch. Desktop (sm and up), one line: label over key, marks, ⓘ, the control, the source chip, the reset. A phone:
 * label, marks, chip and ⓘ, then the key with the control and the reset. A long token list takes its own line.
 */
export function SwitchRowView({ r, canControl, open, status, onTip, onChange }: RowProps) {
  const tipId = `fs-tip-${r.key}`;
  const busy = status?.phase === "saving";
  const own = wideControl(r);
  const reset = canReset(r, canControl);
  return (
    <div className={clsx("relative grid items-center gap-x-2.5 gap-y-1.5 border-t border-white/5 py-2 first:border-t-0 sm:py-[7px]",
      "grid-cols-[minmax(0,auto)_auto_minmax(0,1fr)_auto_auto] sm:grid-cols-[auto_auto_auto_minmax(0,1fr)_64px_24px]")} aria-busy={busy || undefined}>
      <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-px">
        <span className="text-[13px] font-medium leading-[17px] text-fg sm:text-[12.5px] sm:leading-[15px]">{r.label}</span>
        <span className="mono hidden text-[11px] leading-[13px] text-muted sm:block">{r.key}</span>
      </div>
      <Marks r={r} />
      <button type="button" aria-label={`About ${r.key}`} aria-expanded={open} aria-controls={tipId} aria-describedby={tipId} onClick={() => onTip(r.key)}
        className={clsx("peer col-start-5 row-start-1 inline-flex h-9 w-9 items-center justify-center rounded-md border transition sm:col-start-3 sm:h-6 sm:w-6", FOCUS,
          open ? "border-ok-fill/40 bg-ok-fill/8 text-ok" : "border-transparent text-fg-2 hover:border-white/10 hover:text-fg")}>
        <Info className="h-3.5 w-3.5" />
      </button>
      <div className={clsx("col-start-1 col-span-4 row-start-2 flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1.5", own ? "sm:row-start-2" : "sm:col-start-4 sm:col-span-1 sm:row-start-1")}>
        <span className={clsx("mono mr-auto min-w-0 break-all text-[11px] text-muted sm:hidden", own && "w-full")}>{r.key}</span>
        <Control r={r} canControl={canControl} busy={busy} onChange={(c) => onChange(r, c)} />
      </div>
      <span className="col-start-4 row-start-1 flex justify-center sm:col-start-5">
        {r.source ? <span className={clsx("chip min-w-16 justify-center", SOURCE_CHIP[r.source])}>{r.source}</span> : null}
      </span>
      <span className="col-start-5 row-start-2 flex justify-center sm:col-start-6 sm:row-start-1">
        {reset ? (
          <button type="button" aria-label={`${resetLabel(r)}: ${r.key}`} title={`${resetLabel(r)} (${valueText(resetTarget(r))})`} disabled={busy} onClick={() => onChange(r, { reset: true })}
            className={clsx("inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 text-fg-2 transition hover:text-fg disabled:cursor-wait sm:h-6 sm:w-6", FOCUS)}>
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </span>
      <Tip r={r} id={tipId} open={open} saved={status?.phase === "saved" && status.changed} />
      <StatusLine r={r} s={status} />
    </div>
  );
}

type Handlers = { canControl: boolean; open: string | null; status: Record<string, RowStatus>; onTip: (key: string) => void; onChange: (r: SwitchRow, c: Change) => void };

function GroupCard({ g, h, wide = false }: { g: SwitchGroup; h: Handlers; wide?: boolean }) {
  const pinned = g.rows.some((r) => r.key === h.open);
  const row = (r: SwitchRow) => <SwitchRowView key={r.key} r={r} canControl={h.canControl} open={h.open === r.key} status={h.status[r.key]} onTip={h.onTip} onChange={h.onChange} />;
  const [a, b] = halves(g.rows);
  return (
    <section aria-label={g.label} className={clsx("glass relative min-w-0 px-3.5 pb-1.5 pt-3 hover:z-20 focus-within:z-20 sm:px-4 sm:pt-3.5", pinned && "z-20")}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="panel-title">{g.label} <span className="mono font-normal text-muted">{g.rows.length}</span></h2>
        {wide ? <span className="mono text-[11px] text-muted" title="Saved through the Omega settings write path: its validation, audit row and era start.">omega_settings</span> : null}
      </div>
      {wide
        ? <div className="grid grid-cols-1 xl:grid-cols-2 xl:gap-x-8"><div className="min-w-0">{a.map(row)}</div><div className="min-w-0 border-t border-white/5 xl:border-t-0">{b.map(row)}</div></div>
        : g.rows.map(row)}
    </section>
  );
}

/** The page's heading: the title, who reads it, the overrides (the owner) or "read only", and the payload's time. */
export function SwitchesHeading({ d, right }: { d: any; right?: ReactNode }) {
  const sw = switchesOf(d);
  const loaded = d != null && typeof d === "object" && Array.isArray(d.switches);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="flex items-center gap-2.5 text-[20px] font-semibold text-fg"><ToggleRight className="h-[18px] w-[18px] text-ok" aria-hidden="true" />Feature switches</h1>
          <span className="text-[11px] text-muted">Settings{loaded ? ` · ${sw.canControl ? "owner" : "viewer"}` : ""}</span>
        </div>
        {right}
      </div>
      {loaded ? (
        <div className="flex flex-wrap items-center gap-2">
          {sw.canControl
            ? <span className={clsx("chip", sw.overrides ? CHIP.late : CHIP.off)}>{sw.overrides} {sw.overrides === 1 ? "override" : "overrides"}</span>
            : <span className={clsx("chip", CHIP.off)} title="viewer.can_control is false: the owner alone changes a switch.">read only</span>}
          <span className="mono text-[11px] text-fg-2">as of {clockText(sw.at)}</span>
        </div>
      ) : null}
    </div>
  );
}

export type ViewProps = { d: any; status?: Record<string, RowStatus>; open?: string | null; onTip?: (key: string) => void; onChange?: (r: SwitchRow, c: Change) => void; right?: ReactNode };

/** The page over one GET body (pure; the render check's view): the heading, the cards in two columns, the wide Omega card. */
export function SwitchesView({ d, status = {}, open = null, onTip = noop, onChange = noop, right }: ViewProps) {
  const sw = switchesOf(d);
  const { left, right: col2, wide } = columnsOf(sw.groups);
  const h: Handlers = { canControl: sw.canControl, open, status, onTip, onChange };
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-3 px-3 py-3.5 sm:gap-4 sm:px-6 sm:py-5">
      <SwitchesHeading d={d} right={right} />
      {sw.rows.length === 0
        ? <p className="py-3 text-[12px] text-muted">No feature switches in this answer.</p>
        : (
          <>
            <div className="grid grid-cols-1 items-start gap-3 sm:gap-4 xl:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-3 sm:gap-4">{left.map((g) => <GroupCard key={g.id} g={g} h={h} />)}</div>
              <div className="flex min-w-0 flex-col gap-3 sm:gap-4">{col2.map((g) => <GroupCard key={g.id} g={g} h={h} />)}</div>
            </div>
            {wide.map((g) => <GroupCard key={g.id} g={g} h={h} wide />)}
          </>
        )}
    </div>
  );
}

/** The confirm's body: what changes, then the era, mode-evidence and emergency-stop lines. */
export function ConfirmBody({ t }: { t: ConfirmText }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="mono break-all text-fg">{t.change}</div>
      {t.lines.map((l) => <div key={l} className="text-late">{l}</div>)}
      {t.caution ? <div className="text-fault">{t.caution}</div> : null}
    </div>
  );
}

/** The first load (the heading and a skeleton) and a failed GET with nothing on screen (the shared error box). */
export function SwitchesLoading() {
  return <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3.5 sm:px-6 sm:py-5"><SwitchesHeading d={null} /><div className="glass p-4"><Skeleton rows={4} /></div></div>;
}

export default function Switches() {
  const poll = usePoll(() => get(FS_PATH), FS_POLL_MS);
  const [confirm, dialog] = useConfirm();
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [open, setOpen] = useState<string | null>(null);
  // A saved row's answer shows until the next GET (read at once after the save) brings the row itself.
  const [saved, setSaved] = useState<{ at: unknown; rows: Record<string, SwitchRow> }>({ at: null, rows: {} });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const d = poll.data as any;
  const phase = phaseOf(poll);
  if (phase === "error") return <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3.5 sm:px-6 sm:py-5"><SwitchesHeading d={null} /><PollError poll={poll} /></div>;
  if (d == null) return <SwitchesLoading />;
  const shown = saved.at === d?.at && Array.isArray(d?.switches)
    ? { ...d, switches: d.switches.map((x: any) => saved.rows[x?.key] ?? x) }
    : d;

  // The page's one write: a control's change, confirmed, then POST /omega/api/feature-switches and a fresh GET.
  const change = async (r: SwitchRow, c: Change) => {
    if (!canChange(r, switchesOf(d).canControl)) return;
    const t = confirmText(r, c);
    const ok = await confirm({ title: t.title, tone: t.tone, confirmLabel: t.confirmLabel, typed: t.typed ?? undefined, body: <ConfirmBody t={t} /> });
    if (!ok) return;
    setStatus((s) => ({ ...s, [r.key]: { phase: "saving" } }));
    const res = await postSwitch(postBody(r, c));
    if (!res.ok) { setStatus((s) => ({ ...s, [r.key]: { phase: "failed", error: res.error } })); return; }
    if (res.row) { const row = res.row; setSaved((v) => ({ at: d?.at, rows: { ...(v.at === d?.at ? v.rows : {}), [row.key]: row } })); }
    setStatus((s) => ({ ...s, [r.key]: { phase: "saved", at: Date.now(), changed: res.changed, era: r.era_switch } }));
    await poll.refresh();
  };

  return (
    <>
      <SwitchesView d={shown} status={status} open={open} onTip={(k) => setOpen((o) => (o === k ? null : k))} onChange={change} right={<PollStrip poll={poll} className="mb-0!" />} />
      {dialog}
    </>
  );
}
