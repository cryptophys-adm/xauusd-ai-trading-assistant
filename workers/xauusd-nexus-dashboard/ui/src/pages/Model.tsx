import { ArrowRight, BookOpen, Brain, Database, GitBranch, Layers, Lightbulb, ShieldCheck, Trees } from "lucide-react";
import { Badge, Empty, Hint, Kpi, Panel, Skeleton } from "../components/ui";
import { C, DivergingBar } from "../components/charts";
import { get } from "../lib/api";
import { ago, utc } from "../lib/format";
import { usePoll } from "../lib/usePoll";

// Model & Learning (owner 2026-11-13: "pastikan semua ada visualisasi, sehingga owner/user mengetahui dan
// memahami"): how the platform learns from its own decisions, on one page. Read-only, from the AI Worker:
//   - the dataset (/api/model/dataset/summary): one row per Decision Engine decision, labeled by what price did next;
//   - the baseline (/api/model/baseline): retrained every hour, connects itself to the council once it passes its gate;
//   - the decision model (/api/model/gbm): LightGBM, trained daily by GitHub Actions, shadow only;
//   - the learned notes that went live by themselves (/api/tuning → learned_live).
// No price anywhere: labels are in R (multiples of the stop) and features are named, never valued.

const IDS = ["tight_long", "tight_short", "wide_long", "wide_short"] as const;
const ID_TEXT: Record<string, string> = { tight_long: "Tight · long", tight_short: "Tight · short", wide_long: "Wide · long", wide_short: "Wide · short" };
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const sgn = (x: number | null | undefined, d = 3) => (num(x) ? `${x > 0 ? "+" : ""}${x.toFixed(d)}` : "—");
const r2 = (x: number | null | undefined) => (num(x) ? `${x > 0 ? "+" : ""}${x.toFixed(2)}R` : "—");

/** The four steps of the loop, each with its live state, so the owner sees where the platform is. */
function Pipeline({ dataset, baseline, gbm, live }: { dataset: any; baseline: any; gbm: any; live: any }) {
  const labeled = (dataset?.by_status ?? []).find((s: any) => s.label_status === "labeled")?.n ?? 0;
  const promoted = baseline?.promotion?.status === "promoted";
  const liveNotes = (live?.items ?? []).filter((i: any) => i.status === "live").length;
  const steps = [
    { icon: <Database className="h-4 w-4" />, title: "Record", text: "Each 15m decision is saved with its features and labeled in R.", state: `${labeled} labeled`, tone: labeled ? "green" : "slate" },
    { icon: <Brain className="h-4 w-4" />, title: "Learn", text: "Hourly baseline and daily LightGBM learn which setups hit target.", state: `${baseline?.model_id ? "baseline ok" : "baseline —"} · ${gbm?.model_id ? "gbm ok" : "gbm —"}`, tone: baseline?.model_id || gbm?.model_id ? "green" : "slate" },
    { icon: <ShieldCheck className="h-4 w-4" />, title: "Validate", text: "Scored on unseen live decisions; must beat the base rate.", state: promoted ? `passed (${baseline.promotion.set})` : "not yet", tone: promoted ? "green" : "amber" },
    { icon: <Lightbulb className="h-4 w-4" />, title: "Apply", text: "Passing models advise the council; proven notes go live.", state: `${promoted ? "advising" : "shadow only"} · ${liveNotes} live note${liveNotes === 1 ? "" : "s"}`, tone: promoted || liveNotes ? "cyan" : "slate" }
  ] as const;
  return (
    <div className="grid gap-2 md:grid-cols-4">
      {steps.map((s, i) => (
        <div key={s.title} className="glass relative p-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-slate-200"><span className="text-cyan-300">{s.icon}</span>{s.title}</div>
          <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{s.text}</p>
          <div className="mt-2"><Badge tone={s.tone}>{s.state}</Badge></div>
          {i < steps.length - 1 && <ArrowRight className="absolute -right-2.5 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-slate-600 md:block" />}
        </div>
      ))}
    </div>
  );
}

/** Rows of the dataset by label status, and what price did after each decision (both sides, tight labels). */
function Dataset({ d }: { d: any }) {
  if (!d) return <Empty>No data yet.</Empty>;
  const by = Object.fromEntries((d.by_status ?? []).map((s: any) => [s.label_status, s]));
  const total = (d.by_status ?? []).reduce((s: number, x: any) => s + (x.n ?? 0), 0);
  const first = (d.by_status ?? []).map((s: any) => s.first).filter(Boolean).sort()[0];
  const out = (side: string) => {
    const rows = (d.outcomes ?? []).filter((o: any) => o.side === side);
    const n = rows.reduce((s: number, o: any) => s + (o.n ?? 0), 0);
    return { n, rows };
  };
  const OUT_COLOR: Record<string, string> = { target: C.bull, stop: C.bear, expired: C.muted };
  const wide = Object.fromEntries((d.wide_by_status ?? []).map((s: any) => [s.status ?? "pending", s.n]));
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-4">
        <Kpi label="Decisions" value={String(total)} sub={first ? `since ${utc(first)}` : undefined} color={C.cyan} />
        <Kpi label="Labeled (tight)" value={String(by.labeled?.n ?? 0)} sub={`${by.pending?.n ?? 0} pending (${d.rules ? d.rules.horizon_ms / 3_600_000 : 4}h)`} color={C.bull} />
        <Kpi label="Labeled (wide)" value={String(wide.labeled ?? 0)} sub={`${wide.pending ?? 0} pending (${d.wide_rules ? d.wide_rules.horizon_ms / 3_600_000 : 12}h)`} color={C.violet} />
        <Kpi label="Features" value={String(d.latest_feature_count ?? "—")} sub={`${d.shadow_predictions ?? 0} with predictions`} color={C.wait} />
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {["long", "short"].map((side) => {
          const o = out(side);
          return (
            <div key={side} className="glass-inner p-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                <span className="font-semibold capitalize text-slate-200">{side} outcomes</span>
                <span className="text-slate-500">{o.n} labeled</span>
              </div>
              <div className="flex h-3 w-full overflow-hidden rounded-full" style={{ background: C.track }}>
                {o.rows.map((r: any) => <div key={r.outcome} title={`${r.outcome} ${r.n}`} style={{ width: `${o.n ? (r.n / o.n) * 100 : 0}%`, background: OUT_COLOR[r.outcome] ?? C.muted }} className="h-full border-r border-black/30 last:border-r-0" />)}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-3 text-[10.5px] text-slate-400">
                {o.rows.map((r: any) => <span key={r.outcome}><span style={{ color: OUT_COLOR[r.outcome] ?? C.muted }}>■</span> {r.outcome} {r.n} ({o.n ? Math.round((r.n / o.n) * 100) : 0}%) · mean {r2(r.mean_r)}</span>)}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** One model's scores per label set and side: walk-forward (old rows → newer rows) and prospective (live). */
function ModelTable({ checks, prospective, top, gate, importance }: { checks: any; prospective: any; top: any; gate?: any; importance: "weight" | "gain" }) {
  const minN = gate?.min_n ?? 300;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Model</th>
            <th title="Trained on the oldest 70 % of rows, judged on the newest 30 %. Skill > 0 = better than always guessing the base rate.">Walk-forward</th>
            <th title="Area under the ROC curve: 0.5 = no ranking ability, 1 = perfect.">AUC</th>
            <th title="Mean R of the rows the model would pick (p ≥ 0.5) against the mean R of all rows.">Picked vs all</th>
            <th title="Predicted before each decision, scored once the outcome is known.">Live</th>
            <th>Top features</th>
          </tr>
        </thead>
        <tbody>
          {IDS.map((id) => {
            const c = checks?.[id], p = prospective?.[id];
            const feats = (top?.[id] ?? []).slice(0, 4);
            return (
              <tr key={id}>
                <td className="whitespace-nowrap font-semibold text-slate-200">{ID_TEXT[id]}</td>
                <td className="min-w-[150px]">
                  {c?.status === "ok" ? (
                    <div className="flex items-center gap-2">
                      <div className="w-20"><DivergingBar value={c.skill} max={0.3} height={6} /></div>
                      <span className="mono text-[11px]" style={{ color: num(c.skill) && c.skill > 0 ? C.bull : C.bear }}>{sgn(c.skill)}</span>
                      <span className="text-[10px] text-slate-500">n {c.n}</span>
                    </div>
                  ) : c ? <span className="text-[11px] text-slate-500">{c.rows ?? 0} of {c.needed ?? 150} rows</span> : <span className="text-slate-600">—</span>}
                </td>
                <td className="mono text-[11px]">{c?.status === "ok" ? (num(c.auc) ? c.auc.toFixed(2) : "—") : "—"}</td>
                <td className="mono whitespace-nowrap text-[11px]">{c?.status === "ok" ? <><span style={{ color: num(c.picked_mean_r) && num(c.all_mean_r) && c.picked_mean_r > c.all_mean_r ? C.bull : C.bear }}>{r2(c.picked_mean_r)}</span> <span className="text-slate-500">vs {r2(c.all_mean_r)} · {c.picked} picked</span></> : "—"}</td>
                <td className="min-w-[170px]">
                  {p ? (
                    <div>
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="mono" style={{ color: num(p.skill) && p.skill > 0 ? C.bull : C.bear }}>{sgn(p.skill)}</span>
                        <span className="text-slate-500">AUC {num(p.auc) ? p.auc.toFixed(2) : "—"}{num(p.p_value) ? ` · p ${p.p_value}` : ""}</span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full" style={{ background: C.track }} title={`${p.n} of ${minN} decisions the gate needs`}>
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, (p.n / minN) * 100)}%`, background: p.n >= minN ? C.bull : C.cyan }} />
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-500">{p.n} / {minN} decisions</div>
                    </div>
                  ) : <span className="text-[11px] text-slate-500">pending</span>}
                </td>
                <td className="text-[10.5px] text-slate-400">{feats.length ? feats.map((f: any) => <span key={f.feature} className="mr-1.5 inline-block mono" title={`${importance} ${f[importance]}`}>{f.feature}</span>) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The baseline's gate: connected to the council or not, why, and the rules it must pass. */
function Gate({ b }: { b: any }) {
  const pr = b?.promotion, g = b?.gate;
  const on = pr?.status === "promoted";
  return (
    <div className={`glass-inner mb-3 flex flex-wrap items-start gap-3 p-3 ${on ? "border-emerald-400/30" : ""}`}>
      <Badge tone={on ? "green" : "amber"}>{on ? `CONNECTED · ${pr.set}` : "NOT CONNECTED"}</Badge>
      <div className="min-w-0 flex-1 text-[11px] text-slate-300">
        <div className="flex items-center gap-1.5">{on ? `Advising the council since ${utc(pr.since)}` : "Shadow only"}{g && <Hint text={`Gate: both sides, ≥ ${g.min_n} unseen decisions, p < ${g.alpha}, AUC ≥ ${g.min_auc}.`} />}</div>
        {pr?.reason && <div className="mt-1 text-[10.5px] text-slate-500">{pr.reason}</div>}
      </div>
    </div>
  );
}

function LearnedLive({ l }: { l: any }) {
  const items = l?.items ?? [];
  return (
    <>
      {!items.length ? <Empty>No notes live yet.</Empty> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Note</th><th>For</th><th>Status</th><th>Since</th><th>Text</th></tr></thead>
            <tbody>
              {items.map((n: any) => (
                <tr key={`${n.item_id}@${n.version}`}>
                  <td className="mono text-[11px] text-slate-200">{n.item_id} v{n.version}</td>
                  <td className="text-[11px]">{(n.agents ?? []).join(", ") || "—"} · {n.chart === "15" ? "15m" : n.chart === "60" ? "1H" : n.chart ?? "—"}</td>
                  <td>{n.status === "live" ? <Badge tone="green">live</Badge> : <Badge tone="slate">retired</Badge>}{n.status !== "live" && n.reason && <div className="mt-0.5 text-[10px] text-slate-500">{n.reason}</div>}</td>
                  <td className="whitespace-nowrap text-[11px] text-slate-400">{n.status === "live" ? ago(n.promoted_at) : `${ago(n.promoted_at)} → ${ago(n.retired_at)}`}</td>
                  <td className="max-w-[420px] text-[11px] text-slate-400">{n.text ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function Model() {
  const dataset = usePoll(() => get("/api/model/dataset/summary"), 300_000);
  const baseline = usePoll(() => get("/api/model/baseline"), 300_000);
  const gbm = usePoll(() => get("/api/model/gbm"), 300_000);
  const tuning = usePoll(() => get("/api/tuning"), 300_000);
  const d = (dataset.data as any)?.dataset ?? null;
  const b = (baseline.data as any)?.baseline ?? null;
  const g = (gbm.data as any)?.gbm ?? null;
  const l = (tuning.data as any)?.learned_live ?? null;
  const loading = dataset.loading && !dataset.data;
  const hrs = (r: any, dflt: number) => (r ? r.horizon_ms / 3_600_000 : dflt);
  const labelHint = d ? `Tight: ${d.rules?.target_atr ?? 1.5} ATR target / ${d.rules?.stop_atr ?? 1} ATR stop, ${hrs(d.rules, 4)}h. Wide: ${d.wide_rules?.target_atr ?? 4.5} / ${d.wide_rules?.stop_atr ?? 3} ATR, ${hrs(d.wide_rules, 12)}h.` : undefined;
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Learning pipeline" icon={<GitBranch className="h-3.5 w-3.5 text-cyan-300" />}>
        {loading ? <Skeleton rows={3} /> : <Pipeline dataset={d} baseline={b} gbm={g} live={l} />}
      </Panel>

      <Panel title="Dataset" icon={<Database className="h-3.5 w-3.5 text-cyan-300" />} hint={labelHint}>
        {loading ? <Skeleton rows={4} /> : <Dataset d={d} />}
      </Panel>

      <Panel title="Baseline model" icon={<Layers className="h-3.5 w-3.5 text-cyan-300" />} hint="Logistic regression, retrained hourly. The bar other models must beat."
        right={b ? <Badge tone="slate">{b.model_id} · {b.rows} rows · trained {ago(b.trained_at)}</Badge> : null}>
        {baseline.loading && !baseline.data ? <Skeleton rows={4} /> : !b ? <Empty>No baseline yet.</Empty> : (
          <>
            <Gate b={b} />
            <ModelTable checks={b.checks} prospective={b.prospective} top={b.top_features} gate={b.gate} importance="weight" />
          </>
        )}
      </Panel>

      <Panel title="Decision model" icon={<Trees className="h-3.5 w-3.5 text-violet-300" />} hint="LightGBM, trained daily at 04:17 UTC. Shadow only until it passes the gate."
        right={g ? <div className="flex gap-1.5"><Badge tone="slate">{g.model_id} · {g.rows} rows · {g.features} features · trained {ago(g.trained_at)}</Badge><Badge tone="amber">SHADOW</Badge></div> : null}>
        {gbm.loading && !gbm.data ? <Skeleton rows={4} /> : !g ? <Empty>No model yet.</Empty> : (
          <>
            <ModelTable checks={g.checks} prospective={g.prospective} top={g.top_features} importance="gain" />
          </>
        )}
      </Panel>

      <Panel title="Live knowledge notes" icon={<BookOpen className="h-3.5 w-3.5 text-cyan-300" />}
        hint={`Shadow-tested notes go live when better than active${l?.rules ? `; retired if worse live (p < ${l.rules.alpha}, ${l.rules.min_decided} calls)` : ""}.`}
        right={l ? <Badge tone={l.mode === "on" ? "green" : "slate"}>mode {l.mode ?? "—"}</Badge> : null}>
        {tuning.loading && !tuning.data ? <Skeleton rows={3} /> : <LearnedLive l={l} />}
      </Panel>
    </div>
  );
}
