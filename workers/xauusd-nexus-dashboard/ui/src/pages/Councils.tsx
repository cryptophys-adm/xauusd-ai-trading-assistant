import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileSearch, Lightbulb, ScrollText, Users } from "lucide-react";
import { Badge, Empty, Hint, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { useConfirm } from "../components/ConfirmDialog";
import { ago, utc } from "../lib/format";
import { usePoll } from "../lib/usePoll";

// Call for Councils (owner 2026-11-16: "jangan ditampilkan di omega, buat menu navigator sendiri Call for Councils";
// docs/RFC_CALL_FOR_COUNCILS.md, phase P1 "evidence only, no model call"). Read-only, from the AI Worker:
//   - /api/council/suggestions: the topics the deterministic flags suggested, the mode and the catalogue of topic keys;
//   - /api/council/evidence?topic=<key>: the evidence pack a session on that topic would read (no price in it);
//   - /api/strategy-agents: the strategy agents and their patterns, for the topic picker.
// Sessions (P2, owner 2026-11-17 "Setuju + topik bebas"): each agent's own opinion as a card, evidence behind a link;
// the owner opens, writes and switches through POST /omega/api/council (owner only); the pick is made in Cerebrum.

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

function SuggestionCard({ s, onPick, picked }: { s: any; onPick: (k: string) => void; picked: boolean }) {
  return (
    <div className={`glass-inner flex flex-col gap-1.5 p-3 ${picked ? "outline-solid outline-1 outline-cyan-400/50" : ""}`}>
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

const inputCls = "rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-slate-100 focus:border-cyan-400/50 focus:outline-hidden";

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

const ownerPost = async (body: unknown) => {
  const r = await fetch("/omega/api/council", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.ok === false) throw new Error(d?.error || `HTTP ${r.status}`);
  return d;
};
const STANCE: Record<string, { text: string; tone: "green" | "red" | "amber" | "slate" }> = {
  support: { text: "agree", tone: "green" }, oppose: { text: "disagree", tone: "red" }, amend: { text: "agree, with a change", tone: "amber" }, abstain: { text: "abstain", tone: "slate" }
};
const KIND: Record<string, { text: string; tone: "green" | "red" | "amber" | "slate" }> = {
  policy_parameter: { text: "knob change · shadow test first", tone: "green" }, repository_task: { text: "new code · built by Cryptophys", tone: "amber" }, no_change: { text: "no change", tone: "slate" }
};
const PROPOSAL_STATE: Record<string, string> = {
  queued_shadow: "waiting for its shadow test", handoff_pending: "being sent to the platform", handed_off: "with the platform's evolution loop", closed: "recorded, nothing changes",
  shadow: "in its shadow test", live: "live", rolled_back: "rolled back by itself", rejected: "not applied", superseded: "replaced by a newer proposal on the same knob"
};
// The platform's state of a handed-off proposal (council.decisions.read, platform V3).
const PLATFORM_STATE: Record<string, { text: string; tone: "green" | "red" | "amber" | "slate" }> = {
  received: { text: "received", tone: "slate" }, queued: { text: "queued", tone: "slate" }, waiting_external: { text: "waiting: repo not built by the platform yet", tone: "amber" },
  in_progress: { text: "being built", tone: "amber" }, proposed: { text: "change proposed", tone: "amber" }, merged: { text: "merged", tone: "green" },
  deployed: { text: "deployed", tone: "green" }, deployed_unmeasured: { text: "deployed, not measured yet", tone: "green" }, closed: { text: "closed", tone: "slate" },
  rejected: { text: "rejected", tone: "red" }, refused: { text: "refused", tone: "red" }, unfit: { text: "unfit", tone: "red" }, reverted: { text: "reverted", tone: "red" }
};
const ROUND: Record<string, string> = { position: "Opening opinions", rebuttal: "Responses to each other", answer: "Answers to the owner" };
const STATE_TEXT: Record<string, string> = { positions: "the agents are giving their opinions…", rebuttals: "the agents are responding to each other…", synthesis: "the moderator is writing the options…", awaiting_owner: "waiting for your pick (in Cerebrum)", aborted: "stopped", decided: "decided", expired: "expired", closed: "closed" };
const TERMINAL = ["aborted", "expired", "decided", "closed"];

/** One agent's opinion: who, the stance, what it thinks in its own words, what it would try; evidence behind a link. */
function OpinionCard({ m }: { m: any }) {
  const [ev, setEv] = useState(false);
  const st = STANCE[m.stance] ?? { text: m.stance ?? "", tone: "slate" as const };
  if (m.round === "notice") return (
    <div className="rounded-lg border border-amber-400/25 bg-amber-400/5 p-3 text-[12px] text-amber-100"><div className="mb-1 text-[10.5px] uppercase tracking-wider text-amber-300">Could not answer</div>{m.opinion}</div>
  );
  if (m.round === "owner") return (
    <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-3 text-[12px] text-slate-200"><div className="mb-1 text-[10.5px] uppercase tracking-wider text-cyan-300">You{m.reply_to?.length ? ` → ${m.reply_to.join(", ")}` : ""}</div>{m.opinion}</div>
  );
  return (
    <div className="glass-inner p-3">
      <div className="flex items-center justify-between gap-2"><div className="text-[13px] font-semibold text-slate-100">{m.name}</div><Badge tone={st.tone}>{st.text}</Badge></div>
      {m.reply_to?.length ? <div className="mt-0.5 text-[10.5px] text-slate-500">replying to {m.reply_to.join(", ")}</div> : null}
      <p className="mt-2 text-[12.5px] leading-relaxed text-slate-200">{m.opinion}</p>
      {m.proposal ? <div className="mt-2 text-[11.5px] text-slate-300"><span className="text-slate-500">Would try: </span>{m.proposal}</div> : null}
      {m.refs?.length ? (<div className="mt-1.5 text-[10.5px]"><button type="button" className="text-slate-500 underline-offset-2 hover:underline" onClick={() => setEv((x) => !x)}>evidence ({m.refs.length})</button>
        {ev ? <ul className="mono mt-1 space-y-0.5 text-slate-500">{m.refs.map((r: string) => <li key={r}>{r}</li>)}</ul> : null}</div>) : null}
    </div>
  );
}

/** One session: the rounds as opinion cards, the moderator's options, and the owner's box. */
function SessionView({ id, onOpen, enabled }: { id: string; onOpen: (id: string) => void; enabled: boolean }) {
  const [tick, setTick] = useState(0);
  const poll = usePoll(() => get(`/api/council/session?id=${encodeURIComponent(id)}`), 10_000, [id, tick]);
  const s = (poll.data as any)?.session;
  const [text, setText] = useState(""); const [to, setTo] = useState<string[]>([]); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [confirm, dialog] = useConfirm();
  if (poll.loading && !s) return <Skeleton rows={4} />;
  if (!s) return <Empty>Session not found.</Empty>;
  const rounds = ["position", "rebuttal", "answer"].map((r) => [r, s.messages.filter((m: any) => m.round === r || (r === "answer" && (m.round === "owner" || m.round === "notice")))] as const).filter(([, ms]) => ms.length);
  const terminal = s.terminal ?? TERMINAL.includes(s.state);
  const send = async () => { setBusy(true); setErr(null); try { const r = await ownerPost({ action: "message", session_id: id, text, to }); setText(""); setTo([]); if (r?.stale) setErr("Sent. This session's evidence is older than 24 hours: re-open the topic for answers on fresh evidence."); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); setTick((t) => t + 1); } };
  const accept = async (o: any) => {
    const what = o.kind === "policy_parameter" ? <>The knob <span className="mono text-emerald-200">{o.knob}</span> moves from {o.from} to {o.value} only after a shadow test on the recorded decisions shows it does better; it then goes live by itself and rolls back by itself if it does worse.</>
      : o.kind === "repository_task" ? <>This needs new code. It is handed to the platform's evolution loop, so Cryptophys builds it, not an outside party. Nothing in trading changes until it is built and tested.</>
      : <>Nothing changes. The decision is recorded.</>;
    if (!(await confirm({ title: `Accept "${o.title}"?`, body: <><p>{what}</p><p className="mt-2 text-slate-400">The session ends with this pick.</p></>, confirmLabel: "Accept", tone: "emerald" }))) return;
    setBusy(true); setErr(null); try { await ownerPost({ action: "accept", session_id: id, option_id: o.option_id }); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); setTick((t) => t + 1); } };
  const control = async (action: "close" | "reopen") => {
    if (action === "close" && !(await confirm({ title: "Close this session?", body: "It ends here: no more answers and no pick. It frees a slot and does not count toward the 4 sessions a day.", confirmLabel: "Close session", tone: "amber" }))) return;
    setBusy(true); setErr(null); try { const r = await ownerPost({ action, session_id: id }); if (action === "reopen" && r?.session_id) onOpen(r.session_id); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); setTick((t) => t + 1); } };
  return (
    <div className="flex flex-col gap-3">
      {dialog}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        {s.pack_stale ? <span className="text-amber-300">{Number(s.pack_refs) === 0 ? "This session ran on no evidence." : "This session's evidence is older than 24 hours."}</span> : null}
        <button type="button" disabled={busy || !enabled} onClick={() => control("reopen")} title={enabled ? "Open a new session on the same topic and agents, with fresh evidence; this one is closed" : "Turn sessions on first"}
          className="rounded-md bg-cyan-500/20 px-2.5 py-0.5 font-semibold text-cyan-200 ring-1 ring-cyan-400/40 disabled:opacity-40">Re-open with fresh evidence</button>
        {!enabled ? <span className="text-slate-400">Sessions are off: turn them on above to re-open.</span> : null}
        {!terminal ? <button type="button" disabled={busy} onClick={() => control("close")} title="End this session; it frees a slot and does not count toward the day"
          className="rounded-md bg-slate-700/60 px-2.5 py-0.5 font-semibold text-slate-200 ring-1 ring-slate-500/40 disabled:opacity-40">Close</button> : null}
        {err ? <span className="text-rose-300">{err}</span> : null}
      </div>
      <div className="text-[13px] text-slate-200"><span className="font-semibold">{s.question}</span> <span className="text-[11px] text-slate-500">· {s.topic_key} · {s.calls}/16 calls · {STATE_TEXT[s.state] ?? s.state}{s.reason ? ` (${s.reason})` : ""}</span></div>
      {terminal && rounds.length ? (
        <div className="text-[11.5px] text-slate-400">This session is {s.state}; its messages are hidden.{" "}
          <button type="button" className="text-cyan-300 underline-offset-2 hover:underline" onClick={() => setShowOld((x) => !x)}>{showOld ? "Hide them" : "Show them"}</button></div>
      ) : null}
      {(!terminal || showOld) && rounds.map(([r, ms]) => (
        <div key={r}><div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-slate-500">{ROUND[r]}</div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{ms.map((m: any) => <OpinionCard key={m.id} m={m} />)}</div></div>
      ))}
      {s.options && (!terminal || showOld || s.state === "decided") ? (
        <div><div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-slate-500">The moderator's options (pick in Cerebrum)</div>
          {s.options.summary ? <p className="mb-2 text-[12px] text-slate-300">{s.options.summary}</p> : null}
          <div className="grid gap-2 md:grid-cols-2">{(s.options.options ?? []).map((o: any) => (
            <div key={o.option_id} className="glass-inner flex flex-col gap-1 p-3 text-[12px]">
              <div className="flex items-start justify-between gap-2"><div className="font-semibold text-slate-100">{o.rank}. {o.title}</div>{o.kind && KIND[o.kind] ? <Badge tone={KIND[o.kind].tone}>{KIND[o.kind].text}</Badge> : null}</div>
              <div className="text-slate-300">{o.hypothesis}</div>
              {o.kind === "policy_parameter" ? <div className="mono text-[11px] text-emerald-200">{o.knob}: {o.from} → {o.value} {o.unit ?? ""}</div> : null}
              {o.kind === "repository_task" && o.spec ? <div className="text-[11px] text-amber-100/90">To build: {o.spec}</div> : null}
              <div className="text-[11px] text-slate-400">Change: {o.change} · Risk: {o.risk}{o.dissent ? ` · Dissent: ${o.dissent}` : ""}</div>
              {s.state === "awaiting_owner" ? <div><button type="button" disabled={busy} onClick={() => accept(o)} className="mt-1 rounded-md bg-emerald-500/20 px-2.5 py-0.5 text-[11.5px] font-semibold text-emerald-200 ring-1 ring-emerald-400/40 disabled:opacity-40">Accept</button></div> : null}
            </div>))}</div></div>
      ) : null}
      {!terminal ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5 text-[11px]">{s.participants.map((p: any) => (
            <button key={p.id} type="button" onClick={() => setTo((x) => x.includes(p.id) ? x.filter((y) => y !== p.id) : x.length < 2 ? [...x, p.id] : x)}
              className={`rounded-sm px-2 py-0.5 ring-1 ${to.includes(p.id) ? "bg-cyan-500/20 text-cyan-200 ring-cyan-400/40" : "text-slate-300 ring-slate-600/50"}`}>{p.name}</button>))}</div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={1000} placeholder="Write to the agents (pick 1 or 2 above to answer)" className="rounded-md bg-slate-900/60 p-2 text-[12px] text-slate-200 ring-1 ring-slate-700" />
          <div className="flex items-center gap-2"><button type="button" disabled={busy || !text.trim() || !to.length} onClick={send} className="rounded-md bg-cyan-500/20 px-3 py-1 text-[12px] font-semibold text-cyan-200 ring-1 ring-cyan-400/40 disabled:opacity-40">Send</button>{!to.length ? <span className="text-[11px] text-slate-500">pick an agent to answer</span> : null}</div>
        </div>
      ) : null}
    </div>
  );
}

/** The options the owner accepted and where each stands. */
function Proposals({ tick }: { tick: number }) {
  const poll = usePoll(() => get("/api/council/proposals"), 30_000, [tick]);
  const rows = ((poll.data as any)?.proposals ?? []) as any[];
  const live = Object.entries(((poll.data as any)?.live_knobs ?? {}) as Record<string, number>);
  if (!rows.length && !live.length) return null;
  return (
    <div><div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-slate-500">Accepted proposals</div>
      {live.length ? <div className="mb-2 text-[11.5px] text-emerald-200">Live knob values (tested in shadow first; each rolls back by itself if it does worse): {live.map(([k, v]) => `${k} = ${v}`).join(" · ")}</div> : null}
      <div className="grid gap-2 md:grid-cols-2">{rows.map((p) => (
        <div key={p.id} className="glass-inner p-3 text-[12px]">
          <div className="flex items-start justify-between gap-2"><div className="font-semibold text-slate-100">{p.title ?? p.option_id}</div>{KIND[p.kind] ? <Badge tone={KIND[p.kind].tone}>{KIND[p.kind].text}</Badge> : null}</div>
          {p.kind === "policy_parameter" ? <div className="mono mt-1 text-[11px] text-emerald-200">{p.knob}: {p.from_value} → {p.value}</div> : null}
          <div className="mt-1 text-[11px] text-slate-400">{PROPOSAL_STATE[p.state] ?? p.state} · accepted {String(p.accepted_at).slice(0, 16).replace("T", " ")} UTC{p.note ? ` · ${p.note}` : ""}</div>
          {p.platform ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
              <span>Platform:</span><Badge tone={PLATFORM_STATE[p.platform.state]?.tone ?? "slate"}>{PLATFORM_STATE[p.platform.state]?.text ?? p.platform.state}</Badge>
              <span>{String(p.platform.at).slice(0, 16).replace("T", " ")} UTC</span>
              {p.platform.reason ? <span className="w-full text-slate-500">{p.platform.reason}</span> : null}
              {p.platform.refs?.merge_sha ? <span className="mono text-slate-500">merge {String(p.platform.refs.merge_sha).slice(0, 7)}</span> : null}
            </div>
          ) : null}
        </div>))}</div>
      {(poll.data as any)?.platform_poll && !(poll.data as any).platform_poll.on ? <div className="mt-1.5 text-[10.5px] text-slate-500">The platform's progress on handed-off proposals shows here once its return path is live.</div> : null}</div>
  );
}

/** The sessions: the owner's switch, a new session (the picked topic or free text), the list and the open one. */
function Sessions({ topic }: { topic: string | null }) {
  const [tick, setTick] = useState(0);
  const poll = usePoll(() => get("/api/council/sessions"), 30_000, [tick]);
  const d = poll.data as any;
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, dialog] = useConfirm();
  const [text, setText] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  // Open the newest live session by default; a page of closed sessions starts clean.
  useEffect(() => { if (!open) { const live = d?.sessions?.find((x: any) => !TERMINAL.includes(x.state)); if (live) setOpen(live.id); } }, [d, open]);
  const act = async (body: unknown) => { setBusy(true); setErr(null); try { const r = await ownerPost(body); if (r?.session_id) setOpen(r.session_id); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); setTick((t) => t + 1); } };
  return (
    <div className="flex flex-col gap-3">
      {dialog}
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-slate-400">
        <span>Sessions:</span>
        <span className={`rounded-md px-2 py-0.5 font-semibold ring-1 ${d?.enabled ? "bg-emerald-500/20 text-emerald-200 ring-emerald-400/40" : "bg-slate-700/60 text-slate-200 ring-slate-500/40"}`}>{d?.enabled ? "On" : "Off"}</span>
        <button type="button" disabled={busy || d?.mode !== "on"} onClick={async () => { if (d?.enabled && !(await confirm({ title: "Turn council sessions off?", body: "Running sessions stop at their next step. You can turn them on again at any time.", confirmLabel: "Turn off", tone: "rose" }))) return; act({ action: "switch", on: !d?.enabled }); }}
          className="rounded-md px-2 py-0.5 text-slate-300 ring-1 ring-slate-600/50 hover:text-slate-100 disabled:opacity-40">{d?.enabled ? "Turn off" : "Turn on"}</button>
        <span>at most 6 agents and 16 calls a session, 4 sessions a day (closed sessions do not count)</span>
      </div>
      {d?.enabled ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || !topic} onClick={() => act({ action: "start", topic_key: topic })} className="rounded-md bg-cyan-500/20 px-3 py-1 text-[12px] font-semibold text-cyan-200 ring-1 ring-cyan-400/40 disabled:opacity-40">Open a session on {topic ?? "the picked topic"}</button>
            <span className="text-[11px] text-slate-500">or write your own topic:</span>
          </div>
          <div className="flex gap-2"><input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="e.g. Key Level entry SL / SL+" className="flex-1 rounded-md bg-slate-900/60 px-2 py-1 text-[12px] text-slate-200 ring-1 ring-slate-700" />
            <button type="button" disabled={busy || !text.trim()} onClick={() => act({ action: "start", text })} className="rounded-md bg-cyan-500/20 px-3 py-1 text-[12px] font-semibold text-cyan-200 ring-1 ring-cyan-400/40 disabled:opacity-40">Open</button></div>
        </div>
      ) : null}
      {err ? <div className="text-[11px] text-rose-300">{err}</div> : null}
      {d?.sessions?.length ? (
        <div className="flex flex-wrap gap-1.5">{d.sessions.map((x: any) => (
          <button key={x.id} type="button" onClick={() => setOpen(x.id)} className={`rounded-sm px-2 py-0.5 text-[11px] ring-1 ${open === x.id ? "bg-cyan-500/20 text-cyan-200 ring-cyan-400/40" : "text-slate-300 ring-slate-600/50"}`}>{x.topic_text ?? x.topic_key} · {x.state}</button>))}
          {open ? <button type="button" onClick={() => setOpen(null)} className="rounded-sm px-2 py-0.5 text-[11px] text-slate-500 ring-1 ring-slate-700/50 hover:text-slate-300">Hide</button> : null}</div>
      ) : <Empty>No session yet.</Empty>}
      {open ? <SessionView id={open} enabled={Boolean(d?.enabled)} onOpen={(x) => { setOpen(x); setTick((t) => t + 1); }} /> : null}
      <Proposals tick={tick} />
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
        hint="The owner calls the relevant agents into a retrospective on a topic (suggested by the system or written by the owner). Each agent gives its own opinion; the evidence stays behind its refs."
        right={s ? <Badge tone={s.mode === "off" ? "red" : "slate"}>mode {s.mode}</Badge> : null}>
        <div className="text-[12px] text-slate-300">
          Open a session below on a suggested topic or on your own words. The agents speak in turn; the evidence each one cites stays behind its card's link and in the evidence pack further down.
          No price is shown: every figure is in R, shares, counts, ATR multiples or times. A suggestion starts nothing; a session never changes trading by itself.
        </div>
      </Panel>

      <Panel title="Sessions" icon={<Users className="h-3.5 w-3.5 text-cyan-300" />}
        hint="Each agent says what it thinks in its own words; the evidence sits behind each card's link. Opening opinions, then responses to each other, then the moderator's options (always including 'no change'). You can write to the agents; your pick is made in Cerebrum. A session never changes trading by itself.">
        <Sessions topic={topic} />
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
