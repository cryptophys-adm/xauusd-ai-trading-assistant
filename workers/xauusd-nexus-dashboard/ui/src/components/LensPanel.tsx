import type { ReactNode } from "react";
import { Layers } from "lucide-react";
import { Badge, Empty, Panel, PollBody } from "./ui";
import { get } from "../lib/api";
import { ago } from "../lib/format";
import type { Tone } from "../lib/tokens";
import { usePoll } from "../lib/usePoll";

// The Positioning & Liquidity analyst (docs/RFC_POSITIONING_LIQUIDITY.md §10; owner 2026-11-20, breakglass live): one
// agent, two lenses. Read-only, from the AI Worker's GET /api/lens: per lens the weight per mode and where it comes from
// (Aether's anchor, Aether's value, the floor after a poor score, the owner's switch off), the outcome score, whether
// it is at its floor, lens B's baseline, the CFTC report's freshness and the owner's switches. No price.
//
// Track C1: LensView is pure and null-safe (any body, any path null), so the page render check (ui/scripts/render-check.mjs)
// renders it over test/fixtures/nexus-intel/lens.json and its variants; LensPanel is the polled wrapper. Every state is
// a status tone (ok / late / off), never the bull green.

const MODES = ["scalp", "intraday", "swing", "range"] as const;
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const str = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);
const pc = (x: unknown) => (num(x) ? `${Math.round(x * 100)}%` : "—");
const count = (x: unknown) => (num(x) ? x : 0);
/** A key in words: "crowded_long" reads "crowded long". */
const words = (x: unknown) => str(x)?.replace(/_/g, " ") ?? null;
/** Sentence case: "intraday" reads "Intraday". */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const SOURCE: Record<string, string> = { anchor: "Anchor", aether: "Aether", floor_rollback: "Floor", switch_off: "Off", anchor_baseline_insufficient: "Anchor (baseline)" };
const sourceLabel = (x: unknown) => { const k = str(x); return k == null ? "—" : SOURCE[k] ?? sentence(words(k) ?? k); };

/** The mode in sentence case ("Intraday"), or null. */
export const modeLabel = (x: unknown): string | null => { const w = words(x); return w == null ? null : sentence(w); };
/** Lens B's baseline as a status: sufficient ok, insufficient late, anything else (unavailable) off. */
export const BASELINE_TONE: Record<string, Tone> = { sufficient: "ok", insufficient: "late" };
export const baselineTone = (x: unknown): Tone => BASELINE_TONE[str(x) ?? ""] ?? "off";
/** A body with lens state: the route's { status: "ok", … }. Anything else (not_found, error, none) reads "No lens state yet". */
export const lensReady = (d: any): boolean => d != null && typeof d === "object" && d.status === "ok";

function NoLens() {
  return <Empty when="The ledger step writes it every 5 minutes.">No lens state yet</Empty>;
}

function Lens({ title, lens, on, extra }: { title: string; lens: any; on: boolean; extra: ReactNode }) {
  const s = lens?.score;
  return (
    <div className="glass-inner p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-semibold text-slate-100">{title}</span>
        <span className="flex gap-1.5">
          <Badge tone={on ? "ok" : "off"}>{on ? "on" : "switched off"}</Badge>
          {lens?.floored === true ? <Badge tone="late">at floor</Badge> : null}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-2 text-[11px]">
        {MODES.map((m) => {
          const w = lens?.weights?.[m];
          return (
            <div key={m}>
              <div className="text-[11px] font-medium text-muted">{modeLabel(m)}</div>
              <div className="mono text-[13px] font-semibold text-slate-200">{num(w?.weight) ? w.weight.toFixed(2) : "—"}</div>
              <div className="text-[10px] text-slate-500">{sourceLabel(w?.source)}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[11px] text-slate-400">
        Score {pc(s?.share)} over {count(s?.n)} readings ({count(s?.hits)} hit, {count(s?.misses)} miss) · floor {pc(s?.score_floor)} · window {num(s?.score_window) ? s.score_window : "—"}
      </div>
      <div className="mt-1 text-[11px] text-slate-400">{extra}</div>
    </div>
  );
}

/** Lens A's report line: its date and age, the series, fresh (ok) or stale (late), and crowding and divergence. */
function CotLine({ p }: { p: any }) {
  const cot = p?.cot;
  const facts = p?.facts;
  const crowd = words(facts?.crowding), div = words(facts?.divergence);
  const said = facts ? [crowd, div ? `divergence ${div}` : null].filter(Boolean).join(", ") : "";
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span>Report {str(cot?.as_of) ?? "none yet"}{num(cot?.age_days) ? ` (${Math.round(cot.age_days)} days old)` : ""} · {str(cot?.series) ?? "—"}</span>
      {cot?.stale === true ? <Badge tone="late">stale</Badge> : cot?.stale === false ? <Badge tone="ok">fresh</Badge> : null}
      {said ? <span>· {said}</span> : null}
    </span>
  );
}

/** Lens B's baseline (sufficient ok, insufficient late, else off), its weeks, when the ledger step updated it, and its line. */
function BaselineLine({ l }: { l: any }) {
  const b = str(l?.baseline);
  return (
    <>
      <span className="inline-flex flex-wrap items-center gap-1">
        Baseline: <Badge tone={baselineTone(b)}>{b ?? "—"}</Badge> ({count(l?.baseline_weeks)} of 4 weeks){str(l?.updated_at) ? ` · updated ${ago(l.updated_at)}` : ""}
      </span>
      {str(l?.line) ? <div className="mt-1 text-slate-500">{l.line}</div> : null}
    </>
  );
}

/** The panel's header chip: the mode in force and where the weights come from (Aether's last pull, or the anchors). */
export function LensHeader({ d }: { d: any }) {
  if (!lensReady(d)) return null;
  const mode = modeLabel(d.mode);
  const pulled = str(d.policy_pulled_at);
  return <Badge tone="plain">{mode ? `${mode} mode` : "Mode unknown"}{pulled ? ` · Aether ${ago(pulled)}` : " · anchors"}</Badge>;
}

/** The two lenses from a /api/lens body. Pure and null-safe: a body without lens state reads "No lens state yet". */
export function LensView({ d }: { d: any }) {
  if (!lensReady(d)) return <NoLens />;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Lens title="Lens A · Positioning (CFTC)" lens={d.positioning} on={d.switches?.positioning_enabled !== false} extra={<CotLine p={d.positioning} />} />
      <Lens title="Lens B · Liquidity (broker M1)" lens={d.liquidity} on={d.switches?.liquidity_enabled !== false} extra={<BaselineLine l={d.liquidity} />} />
    </div>
  );
}

export function LensPanel() {
  const poll = usePoll(() => get("/api/lens"), 120_000);
  const d: any = poll.data;
  return (
    <Panel title="Positioning & Liquidity" icon={<Layers className="h-3.5 w-3.5 text-cyan-300" />} poll={poll} live
      hint="One analyst, two lenses: the CFTC positioning report (a small Decision Engine witness) and the broker's own tick volume and spread (a spread-spike filter, liquidity key levels and the councils' measured reasons). Each weight moves per mode within its doctrine bound; a poor score drops it to the floor until Aether sends a newer value. Neither lens ever opens a position."
      right={<LensHeader d={d} />}>
      <PollBody poll={poll} skeleton={3} empty={!lensReady(d) && <NoLens />}>{() => <LensView d={d} />}</PollBody>
    </Panel>
  );
}
