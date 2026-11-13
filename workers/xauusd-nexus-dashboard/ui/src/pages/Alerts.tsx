import { BellRing } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const EVENT_WORD: Record<string, string> = { setup: "Setup", entry: "Entry", exit: "TP1 / stop / timeout", closed: "TP2 closed", cancelled: "Cancelled" };
const when = (t?: string | null) => (t ? `${t.slice(5, 16).replace("T", " ")} UTC` : "");

/** Backlog 11.2: the Telegram alerts of the Signal Ledger. Read-only: this page never sends. */
export default function Alerts() {
  const { data, loading, error } = usePoll(() => get("/api/alerts"), 60_000);
  const v = (data as any)?.alerts;
  const state = !v ? null : v.enabled ? { tone: "green" as const, text: "active" }
    : !v.switch_on ? { tone: "slate" as const, text: "off" } : { tone: "amber" as const, text: "bot not configured" };
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Alerts" icon={<BellRing className="h-3.5 w-3.5 text-cyan-300" />} hint="Each Signal Ledger event is sent to Telegram once, at most 5 messages per run. No orders are placed." right={state ? <Badge tone={state.tone}>{state.text}</Badge> : null}>
        {v && !v.bot_configured ? <p className="text-[12px] text-amber-200">Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to start sending.</p> : null}
      </Panel>
      {loading && !data ? <Panel><Skeleton rows={4} /></Panel> : error && !data ? <Panel><p className="text-[12px] text-rose-300">Alerts unavailable: {error}</p></Panel> : !v ? <Panel><Empty>No data yet.</Empty></Panel> : (
        <>
          <Panel title="Pending" hint="Sent on the next sweep, every 15 minutes." right={<Badge tone="cyan">{v.pending.length}</Badge>}>
            {!v.started ? <Empty>Not started yet.</Empty>
              : !v.pending.length ? <Empty>Nothing pending.</Empty> : (
              <ul className="flex flex-col gap-2">
                {v.pending.map((p: any) => (
                  <li key={p.signal_id + p.event} className="rounded border border-white/10 bg-white/[0.02] p-2">
                    <div className="mb-1 text-[11px] text-slate-500">{EVENT_WORD[p.event] ?? p.event} · <span className="mono">{p.signal_id}</span></div>
                    <pre className="whitespace-pre-wrap text-[12px] text-slate-200">{p.text}</pre>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={`History, ${v.window_days}d`}>
            {!v.recorded.length ? <Empty>No alerts yet.</Empty> : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>When</th><th>Event</th><th>Source</th><th>Side</th><th>Status</th><th>Message</th></tr></thead>
                  <tbody>
                    {v.recorded.map((r: any) => (
                      <tr key={r.signal_id + r.event}>
                        <td className="mono">{when(r.at)}</td><td>{EVENT_WORD[r.event] ?? r.event}</td><td>{r.source ?? ""}</td><td className="mono">{r.side ?? ""}</td>
                        <td>{r.status === "sent" ? <span className="text-emerald-300">sent</span> : <span className="text-slate-500">baseline</span>}</td>
                        <td className="max-w-[520px] whitespace-pre-wrap text-[11px] text-slate-400">{r.text ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
