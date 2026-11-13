import { ArrowRight, BookOpen, Brain, Database, GitBranch, Layers, Lightbulb, ShieldCheck, Trees } from "lucide-react";
import { Badge, Empty, Kpi, Panel, Skeleton } from "../components/ui";
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
    { icon: <Database className="h-4 w-4" />, title: "1 · Record", text: "Every 15m decision is saved with ~100 numbers it knew at that close, then labeled by what price did next (in R).", state: `${labeled} labeled`, tone: labeled ? "green" : "slate" },
    { icon: <Brain className="h-4 w-4" />, title: "2 · Learn", text: "A baseline (hourly) and a decision model (daily, LightGBM) learn which situations reached the target before the stop.", state: `${baseline?.model_id ? "baseline ok" : "baseline —"} · ${gbm?.model_id ? "gbm ok" : "gbm —"}`, tone: baseline?.model_id || gbm?.model_id ? "green" : "slate" },
    { icon: <ShieldCheck className="h-4 w-4" />, title: "3 · Prove", text: "Each prediction is made before the decision and scored after (prospective). Only a model that beats the base rate on 300+ unseen decisions per side passes.", state: promoted ? `passed (${baseline.promotion.set})` : "not yet", tone: promoted ? "green" : "amber" },
    { icon: <Lightbulb className="h-4 w-4" />, title: "4 · Use", text: "A model that passed advises the AI council (never trades by itself); a knowledge note that proved better goes live for the agents it was tested on, and retires if it gets worse.", state: `${promoted ? "advising" : "shadow only"} · ${liveNotes} live note${liveNotes === 1 ? "" : "s"}`, tone: promoted || liveNotes ? "cyan" : "slate" }
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
  if (!d) return <Empty>The dataset is not available.</Empty>;
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
        <Kpi label="Decisions recorded" value={String(total)} sub={first ? `since ${utc(first)}` : undefined} color={C.cyan} />
        <Kpi label="Labeled (tight)" value={String(by.labeled?.n ?? 0)} sub={`${by.pending?.n ?? 0} waiting for the next ${d.rules ? d.rules.horizon_ms / 3_600_000 : 4} h`} color={C.bull} />
        <Kpi label="Labeled (wide)" value={String(wide.labeled ?? 0)} sub={`${wide.pending ?? 0} waiting for the next ${d.wide_rules ? d.wide_rules.horizon_ms / 3_600_000 : 12} h`} color={C.violet} />
        <Kpi label="Features per decision" value={String(d.latest_feature_count ?? "—")} sub={`${d.shadow_predictions ?? 0} rows carry model predictions`} color={C.wait} />
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {["long", "short"].map((side) => {
          const o = out(side);
          return (
            <div key={side} className="glass-inner p-3">
              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                <span className="font-semibold text-slate-200">A {side} from every decision's close</span>
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
      <p className="mt-2 text-[10.5px] text-slate-500">
        Labels: <b>tight</b> = target {d.rules?.target_atr ?? 1.5} ATR before stop {d.rules?.stop_atr ?? 1} ATR within {d.rules ? d.rules.horizon_ms / 3_600_000 : 4} h; <b>wide</b> = {d.wide_rules?.target_atr ?? 4.5} ATR before {d.wide_rules?.stop_atr ?? 3} ATR within {d.wide_rules ? d.wide_rules.horizon_ms / 3_600_000 : 12} h. They measure the market after each decision, whatever the decision was, so a model can also learn when to wait.
      </p>
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
            <th title="Trained on the oldest 70 % of rows, judged on the newest 30 %. Skill > 0 = better than always guessing the base rate.">Walk-forward skill</th>
            <th title="Area under the ROC curve: 0.5 = no ranking ability, 1 = perfect.">AUC</th>
            <th title="Mean R of the rows the model would pick (p ≥ 0.5) against the mean R of all rows.">Picked vs all</th>
            <th title="Predictions made before each decision, scored once its outcome is known: the honest record.">Prospective (live)</th>
            <th>Leans on</th>
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
                  ) : <span className="text-[11px] text-slate-500">waiting for outcomes</span>}
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
        <div>{on ? `Advising the Decision Engine council since ${utc(pr.since)}: the council sees its long and short probabilities next to the witnesses. The guardrails still decide what can trade.` : "Shadow only: its predictions are recorded and scored, but the council does not see them yet."}</div>
        {pr?.reason && <div className="mt-1 text-[10.5px] text-slate-500">Why: {pr.reason}</div>}
        {g && <div className="mt-1 text-[10.5px] text-slate-500">Gate (connects and disconnects by itself): both sides of one label set, ≥ {g.min_n} decisions it had not seen, better than the base rate with p &lt; {g.alpha}, AUC ≥ {g.min_auc}.</div>}
      </div>
    </div>
  );
}

function LearnedLive({ l }: { l: any }) {
  const items = l?.items ?? [];
  return (
    <>
      <p className="mb-2 text-[11px] text-slate-400">
        A knowledge note from Aether is first tested in shadow (one extra AI call with the note, against the real answer, on the same bar). When it reads <b>better than active</b> it goes live by itself for the agents and chart it was tested on{l?.rules ? `, and retires by itself if it stops being in Aether's pack or is worse live (p < ${l.rules.alpha} over ${l.rules.min_decided} decided calls)` : ""}. Mode: <Badge tone={l?.mode === "on" ? "green" : "slate"}>{l?.mode ?? "—"}</Badge>
      </p>
      {!items.length ? <Empty>No note has gone live yet. Notes in shadow testing are on the Shadow versions page.</Empty> : (
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
  return (
    <div className="flex flex-col gap-4">
      <Panel title="How the platform learns" icon={<GitBranch className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="purple">automatic · no price · advice only</Badge>}>
        {loading ? <Skeleton rows={3} /> : <Pipeline dataset={d} baseline={b} gbm={g} live={l} />}
      </Panel>

      <Panel title="1 · The dataset" icon={<Database className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="slate">every 5 min</Badge>}>
        {loading ? <Skeleton rows={4} /> : <Dataset d={d} />}
      </Panel>

      <Panel title="2 · Baseline model (logistic regression)" icon={<Layers className="h-3.5 w-3.5 text-cyan-300" />}
        right={b ? <Badge tone="slate">{b.model_id} · {b.rows} rows · trained {ago(b.trained_at)}</Badge> : null}>
        {baseline.loading && !baseline.data ? <Skeleton rows={4} /> : !b ? <Empty>No baseline yet (it needs 150 decisive rows per side).</Empty> : (
          <>
            <Gate b={b} />
            <ModelTable checks={b.checks} prospective={b.prospective} top={b.top_features} gate={b.gate} importance="weight" />
            <p className="mt-2 text-[10.5px] text-slate-500">Retrained every hour from every labeled row; small enough to run inside the Worker. It is the bar every other model must beat.</p>
          </>
        )}
      </Panel>

      <Panel title="2b · Decision model (LightGBM)" icon={<Trees className="h-3.5 w-3.5 text-violet-300" />}
        right={g ? <div className="flex gap-1.5"><Badge tone="slate">{g.model_id} · {g.rows} rows · {g.features} features · trained {ago(g.trained_at)}</Badge><Badge tone="amber">SHADOW</Badge></div> : null}>
        {gbm.loading && !gbm.data ? <Skeleton rows={4} /> : !g ? <Empty>No decision model yet: it is trained daily at 04:17 UTC by GitHub Actions once there are enough labeled rows.</Empty> : (
          <>
            <ModelTable checks={g.checks} prospective={g.prospective} top={g.top_features} importance="gain" />
            <p className="mt-2 text-[10.5px] text-slate-500">Gradient-boosted trees, trained daily outside Cloudflare (free) and evaluated by the Worker itself. Shadow only: it is recorded next to every decision and judged on outcomes it had not seen; it needs about 1000–2000 labeled rows to be worth much. Later it runs in the EA (ONNX), still as advice until it passes the same gate.</p>
          </>
        )}
      </Panel>

      <Panel title="3 · Knowledge notes that went live by themselves" icon={<BookOpen className="h-3.5 w-3.5 text-cyan-300" />}>
        {tuning.loading && !tuning.data ? <Skeleton rows={3} /> : <LearnedLive l={l} />}
      </Panel>
    </div>
  );
}
