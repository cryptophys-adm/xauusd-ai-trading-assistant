import { BellRing } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const EVENT_WORD: Record<string, string> = { setup: "Setup active", entry: "Entry reached", exit: "TP1, stop or time limit", closed: "TP2 part closed", cancelled: "Setup cancelled" };
const when = (t?: string | null) => (t ? `${t.slice(5, 16).replace("T", " ")} UTC` : "");

/** Backlog 11.2: the Telegram alerts of the Signal Ledger. Read-only: this page never sends. */
export default function Alerts() {
  const { data, loading, error } = usePoll(() => get("/api/alerts"), 60_000);
  const v = (data as any)?.alerts;
  const state = !v ? null : v.enabled ? { tone: "green" as const, text: "sending to Telegram" }
    : !v.switch_on ? { tone: "slate" as const, text: "switched off" } : { tone: "amber" as const, text: "Telegram bot not configured" };
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Alerts" icon={<BellRing className="h-3.5 w-3.5 text-cyan-300" />} right={state ? <Badge tone={state.tone}>{state.text}</Badge> : null}>
        <p className="text-[12px] leading-relaxed text-slate-400">
          Each Signal Ledger event goes to the owner's Telegram once: a strategy setup triggered, the entry reached, TP1 / the stop / the time limit reached, the TP2 part closed, or a setup cancelled. The H1 decision has its own Telegram message. The first run records the events that already exist without sending them; at most 5 messages a run, and a failed send is retried. Advisory only: no order is placed and no position size is given.
        </p>
        {v && !v.bot_configured ? <p className="mt-2 text-[12px] text-amber-200">The AI Worker has no Telegram bot configured (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID). The owner sets them in the Cloudflare dashboard; nothing is sent until then.</p> : null}
      </Panel>
      {loading && !data ? <Panel><Skeleton rows={4} /></Panel> : error && !data ? <Panel><p className="text-[12px] text-rose-300">Alerts unavailable: {error}</p></Panel> : !v ? <Panel><Empty>No data yet.</Empty></Panel> : (
        <>
          <Panel title="Next to send" right={<Badge tone="cyan">{v.pending.length}</Badge>}>
            {!v.started ? <Empty>The alerts have not started yet: the first run after the bot is configured records the existing events without sending them.</Empty>
              : !v.pending.length ? <Empty>Nothing waiting. New ledger events are sent by the next sweep (every 15 minutes).</Empty> : (
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
          <Panel title={`Recorded, last ${v.window_days} days`}>
            {!v.recorded.length ? <Empty>No alert recorded yet.</Empty> : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>When</th><th>Event</th><th>Source</th><th>Side</th><th>Status</th><th>Message</th></tr></thead>
                  <tbody>
                    {v.recorded.map((r: any) => (
                      <tr key={r.signal_id + r.event}>
                        <td className="mono">{when(r.at)}</td><td>{EVENT_WORD[r.event] ?? r.event}</td><td>{r.source ?? ""}</td><td className="mono">{r.side ?? ""}</td>
                        <td>{r.status === "sent" ? <span className="text-emerald-300">sent</span> : <span className="text-slate-500">recorded at the start</span>}</td>
                        <td className="max-w-[520px] whitespace-pre-wrap text-[11px] text-slate-400">{r.text ?? "(signal older than the window)"}</td>
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
