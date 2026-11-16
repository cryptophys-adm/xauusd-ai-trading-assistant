import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileSearch, Lightbulb, ScrollText, Users } from "lucide-react";
import { Badge, Empty, Hint, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { ago, utc } from "../lib/format";
import { usePoll } from "../lib/usePoll";

// Call for Councils (owner 2026-11-16: "jangan ditampilkan di omega, buat menu navigator sendiri Call for Councils";
// docs/RFC_CALL_FOR_COUNCILS.md, phase P1 "evidence only, no model call"). Read-only, from the AI Worker:
//   - /api/council/suggestions: the topics the deterministic flags suggested, the mode and the catalogue of topic keys;
//   - /api/council/evidence?topic=<key>: the evidence pack a session on that topic would read (no price in it);
//   - /api/strategy-agents: the strategy agents and their patterns, for the topic picker.
// Sessions (the agents' discussion with the owner) start in a later phase; nothing here writes.

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const human = (k: string) => k.replace(/_/g, " ").replace(/\br\b/g, "R").replace(/^./, (c) => c.toUpperCase());
const TYPE_TONE: Record<string, "cyan" | "amber" | "red" | "green" | "purple" | "slate"> = {
  strategy: "cyan", risk: "red", engine: "purple", execution: "amber", news: "amber", data: "slate", cost: "slate", seat: "green", knowledge: "green", free: "slate"
};
const TYPE_TEXT: Record<string, string> = {
  strategy: "A strategy agent, one of its patterns, its exits or one market condition",
  seat: "A room or desk seat: its scored statements, crowd weight and compliance findings",
  engine: "The Decision Engine (engine:15) or the self-trained baseline's gate (engine:model)",
  risk: "The ledger's trades in one session, trading mode or 1H regime",
  news: "Trades around high-impact releases",
  execution: "Omega and the EA: recoveries, failed intents, fills, SL+ in practice",
  data: "Stuck states, parity, market data and the TradingView budget",
  cost: "Workers AI usage of one meter source, or the shadow arms",
  knowledge: "A learned note: its verdicts and its shadow test",
  free: "A topic the owner writes (its sections come with the sessions)"
};

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
    // An exit tally inside a table cell: each exit with its count.
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
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr>{cols.map((c) => <th key={c}>{human(c)}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className="whitespace-nowrap align-top">{c in r ? <Cell k={c} v={r[c]} /> : <span className="text-slate-600">—</span>}</td>)}</tr>)}
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
              <div className="text-[9.5px] uppercase tracking-wider text-slate-500">{human(k)}</div>
              <div className={`${num(x) ? "mono text-[13px] font-semibold" : "text-[11.5px]"} break-words text-slate-200`}>{fmtValue(k, x)}</div>
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

function SuggestionCard({ s, onPick, picked }: { s: any; onPick: (k: string) => void; picked: boolean }) {
  return (
    <div className={`glass-inner flex flex-col gap-1.5 p-3 ${picked ? "outline outline-1 outline-cyan-400/50" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <Badge tone={TYPE_TONE[s.type] ?? "slate"}>{s.type}</Badge>
        <span className="flex items-center gap-1">{s.active ? <Badge tone="amber">still firing</Badge> : <Badge tone="slate">quiet</Badge>}<Badge tone="slate">{s.status}</Badge></span>
      </div>
      <div className="mono break-all text-[12px] font-semibold text-slate-100">{s.topic_key}</div>
      <div className="text-[11.5px] text-slate-300">{s.signal?.summary ?? s.rule}</div>
      <div className="flex items-center justify-between gap-2 text-[10.5px] text-slate-500">
        <span title={s.created_at}>suggested {ago(s.created_at)} · seen {ago(s.last_seen_at)}</span>
        <button type="button" className="btn border-cyan-400/30 bg-cyan-400/10 text-cyan-200" onClick={() => onPick(s.topic_key)}>Evidence</button>
      </div>
    </div>
  );
}

const inputCls = "rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-none";

/** The topic picker: a type, then a key from the catalogue (a strategy agent from the registry, its pattern or exits, a market condition). */
function Picker({ catalog, agents, onPick }: { catalog: any; agents: any[]; onPick: (k: string) => void }) {
  const types: string[] = Object.keys(catalog ?? {});
  const [type, setType] = useState("strategy");
  const [agent, setAgent] = useState("zone_pullback");
  const [focus, setFocus] = useState("");
  const [context, setContext] = useState("");
  const [key, setKey] = useState("");
  const [typed, setTyped] = useState("");
  const keys: string[] = catalog?.[type]?.keys ?? [];
  const agent_ = agents.find((a) => a.id === agent);
  useEffect(() => { setKey(keys[0] ?? ""); setTyped(""); /* a new type starts from its first key */ }, [type, catalog]); // eslint-disable-line react-hooks/exhaustive-deps
  const strategyKey = `strategy:${agent}${focus ? `:${focus}` : ""}${context ? `@${context}` : ""}`;
  const chosen = typed.trim() || (type === "strategy" ? strategyKey : key);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-slate-500">Type
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>{types.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        </label>
        {type === "strategy" ? (
          <>
            <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-slate-500">Strategy agent
              <select className={inputCls} value={agent} onChange={(e) => { setAgent(e.target.value); setFocus(""); }}>{agents.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.status})</option>)}</select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-slate-500">Focus
              <select className={inputCls} value={focus} onChange={(e) => setFocus(e.target.value)}>
                <option value="">the whole agent</option>
                <option value="exits">its exits</option>
                {(agent_?.patterns ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-slate-500">Market condition
              <select className={inputCls} value={context} onChange={(e) => setContext(e.target.value)}>
                <option value="">every condition</option>
                {(catalog?.strategy?.contexts ?? []).map((c: string) => <option key={c} value={c}>{c.replace("|", " · ")}</option>)}
              </select>
            </label>
          </>
        ) : keys.length ? (
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-slate-500">Topic
            <select className={inputCls} value={key} onChange={(e) => setKey(e.target.value)}>{keys.map((k) => <option key={k} value={k}>{k}</option>)}</select>
          </label>
        ) : null}
        <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[10px] uppercase tracking-wider text-slate-500">Or a topic key
          <input className={inputCls} maxLength={120} placeholder={catalog?.[type]?.free_form ?? "e.g. strategy:zone_pullback:exits"} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <button type="button" className="btn border-cyan-400/30 bg-cyan-400/10 text-cyan-200 disabled:opacity-40" disabled={!chosen} onClick={() => onPick(chosen)}>Build the evidence pack</button>
      </div>
      <div className="text-[11px] text-slate-400">{TYPE_TEXT[type] ?? ""} · <span className="mono text-slate-300">{chosen || "—"}</span></div>
    </div>
  );
}

function Pack({ pack }: { pack: any }) {
  const sections = Object.entries(pack.sections ?? {});
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
        {[["Topic", <span key="t" className="mono">{pack.topic}</span>], ["Type", pack.type], ["As of", utc(pack.as_of)], ["sha256", <span key="s" className="mono" title={pack.sha256}>{String(pack.sha256).slice(0, 16)}…</span>]].map(([k, v]) => (
          <div key={String(k)}><div className="text-[10px] uppercase tracking-wider text-slate-500">{k as string}</div><div className="break-all text-slate-200">{v as ReactNode}</div></div>
        ))}
      </div>
      {sections.map(([name, value]) => (
        <div key={name} className="glass-inner p-3">
          <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-slate-100">{human(name)}{(value as any)?.unavailable ? <Badge tone="slate">unavailable</Badge> : null}</div>
          <Value v={value} depth={1} />
        </div>
      ))}
      <details className="glass-inner p-3">
        <summary className="cursor-pointer text-[12px] font-semibold text-slate-200">Evidence refs ({(pack.refs ?? []).length})</summary>
        <div className="mt-2 max-h-[320px] overflow-auto">
          {(pack.refs ?? []).map((r: string) => <div key={r} className="mono break-all text-[10.5px] text-slate-400">{r}</div>)}
        </div>
        <div className="mt-2 text-[10.5px] text-slate-500">Full sha256: <span className="mono break-all">{pack.sha256}</span></div>
      </details>
    </div>
  );
}

export default function Councils() {
  const sugPoll = usePoll(() => get("/api/council/suggestions"), 120_000);
  const agentsPoll = usePoll(() => get("/api/strategy-agents"), 300_000);
  const [topic, setTopic] = useState<string | null>(null);
  const packPoll = usePoll(() => (topic ? get(`/api/council/evidence?topic=${encodeURIComponent(topic)}`) : Promise.resolve(null)), 0, [topic]);
  const s = sugPoll.data as any, pk = packPoll.data as any;
  const suggestions: any[] = s?.suggestions ?? [];
  const agents: any[] = useMemo(() => (agentsPoll.data as any)?.agents ?? (s?.catalog?.strategy?.agents ?? []).map((a: any) => ({ ...a, status: "—" })), [agentsPoll.data, s]);
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Call for Councils" icon={<Users className="h-3.5 w-3.5 text-cyan-300" />}
        hint="The owner calls the relevant agents into a retrospective on a topic. Phase P1 is evidence only: the system suggests topics from deterministic flags and builds the evidence pack a session would read. No model is called."
        right={s ? <Badge tone={s.mode === "off" ? "red" : "slate"}>mode {s.mode}</Badge> : null}>
        <div className="text-[12px] text-slate-300">
          Read-only. Sessions, where the agents discuss a topic with the owner, start in a later phase; this page shows the topics the system suggests and the evidence a session would cite.
          No price is shown: every figure is in R, shares, counts, ATR multiples or times. A suggestion starts nothing.
        </div>
      </Panel>

      <Panel title="Suggested topics" icon={<Lightbulb className="h-3.5 w-3.5 text-cyan-300" />}
        hint="Checked once an hour while the market is open: a strategy agent or pattern whose last 20 resolved trades ended at the stop or SL+ 65% of the time or more, a breaker, a losing market condition, the engine's hit rate, a seat at the weight floor, execution, data and cost signals. One open card per topic, the same signal at most once in 7 days, at most 3 new a day."
        right={s ? <Badge tone="slate">{suggestions.filter((x) => x.status === "open").length} open</Badge> : null}>
        {sugPoll.loading && !s ? <Skeleton rows={3} /> : sugPoll.error && !s ? <Empty>Unavailable ({sugPoll.error}).</Empty> : !suggestions.length ? <Empty>No topic suggested yet{s?.mode === "off" ? " (the flags are off)" : ""}.</Empty> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {suggestions.map((x) => <SuggestionCard key={x.id} s={x} picked={topic === x.topic_key} onPick={setTopic} />)}
          </div>
        )}
      </Panel>

      <Panel title="Topic" icon={<FileSearch className="h-3.5 w-3.5 text-cyan-300" />} hint="Pick a type and a topic; a strategy topic can be any agent, one of its patterns, its exits, or one market condition (trading mode and 1H regime).">
        {!s?.catalog ? <Skeleton rows={2} /> : <Picker catalog={s.catalog} agents={agents} onPick={setTopic} />}
      </Panel>

      <Panel title="Evidence pack" icon={<ScrollText className="h-3.5 w-3.5 text-cyan-300" />}
        hint="Built now from the stored records, deterministically: the same evidence gives the same sha256. Omega's stop locked behind passed key levels is the headline SL+; the ledger's breakeven SL+ stands beside it."
        right={pk?.pack ? <span className="flex items-center gap-1.5"><Hint text="council_pack.v1; refs follow ev:xauusd/<source>/<id>[@<as_of>][#<field>]" /><Badge tone="slate">{Object.keys(pk.pack.sections ?? {}).length} sections</Badge></span> : null}>
        {!topic ? <Empty>Pick a suggested topic or build one above.</Empty>
          : packPoll.loading ? <Skeleton rows={5} />
          : packPoll.error ? <Empty>Unavailable ({packPoll.error}).</Empty>
          : pk?.pack ? <Pack pack={pk.pack} /> : <Empty>No pack.</Empty>}
      </Panel>
    </div>
  );
}
