import { Trophy } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const p = (x?: number | null) => (x == null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const tone = (a?: number | null, n = 0) => (!n ? "text-slate-500" : (a ?? 0) >= 0.55 ? "text-emerald-300" : (a ?? 0) < 0.45 ? "text-rose-300" : "text-slate-200");
const CHECK: Record<string, string> = { order_wording: "order or size wording", stance_bias_conflict: "stance against its bias", calibration_talk: "talks about calibration", natural_language: "field names in text", data_scope: "outside its own HUD" };
const CHART: Record<string, string> = { "15": "15m", "60": "1H", "240": "4H", "1D": "D1" };

/** Agent compliance (RFC_AETHER_KNOWLEDGE_GUARDIAN A1): deterministic rule breaks per 100 room messages. */
function Compliance() {
  const { data } = usePoll(() => get("/api/compliance?days=7"), 300_000);
  const c = (data as any)?.compliance;
  if (!c) return null;
  const rows = (c.agents as any[]).filter((a) => a.violations > 0).slice(0, 20);
  return (
    <Panel title="Agent compliance (7 days)" right={<Badge tone={c.total.violations ? "amber" : "green"}>{c.total.rate_per_100 ?? 0} per 100 messages</Badge>}>
      <p className="mb-3 text-[12px] text-slate-400">Deterministic checks of what each agent said against its role and the owner's rules. A check never changes a message or a decision; Aether's guardian reads these rates.</p>
      {!rows.length ? <Empty>No rule break in {c.total.messages} room messages.</Empty> : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Agent</th><th>Room</th><th>Messages</th><th>Rule breaks</th><th>Per 100</th><th>Most frequent</th></tr></thead>
            <tbody>{rows.map((a) => {
              const top = Object.entries(a.by_check as Record<string, any>).sort((x, y) => y[1].count - x[1].count)[0];
              return (
                <tr key={a.chart + a.agent}>
                  <td className="text-slate-200">{a.agent}</td><td className="mono">{CHART[a.chart] ?? a.chart}</td><td className="mono">{a.messages}</td><td className="mono">{a.violations}</td>
                  <td className={`mono ${(a.rate_per_100 ?? 0) >= 20 ? "text-rose-300" : "text-amber-200"}`}>{a.rate_per_100 ?? "n/a"}</td>
                  <td className="text-slate-400">{top ? `${CHECK[top[0]] ?? top[0]} (${top[1].count}${top[1].example ? `, e.g. "${top[1].example}"` : ""})` : ""}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

const SUBJECT: Record<string, string> = {
  "chain:h1": "H1 decision (Reasoner)", "indicator:prophet_r38": "Prophet R38 direction", "indicator:prophet_r37": "Prophet R37 direction", "indicator:gmi_v12_70": "GMI v12.70 verdict"
};

function AgentTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <Empty>No scored calls yet: an agent's calls are scored once the next four candles have closed.</Empty>;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr><th>Agent</th><th>Family</th><th>Decisive calls</th><th>Accuracy</th><th>BUY/SELL hit rate</th><th>WAIT accuracy</th><th>Brier</th><th>Crowd weight</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="text-slate-200">{r.name}</td><td className="text-slate-400">{r.family}</td>
              <td className="mono">{r.decisive}</td><td className={`mono ${tone(r.accuracy, r.decisive)}`}>{p(r.accuracy)}</td>
              <td className="mono">{p(r.hit_rate)}</td><td className="mono">{p(r.wait_accuracy)}</td>
              <td className="mono">{r.brier ?? "n/a"}</td><td className="mono">×{r.weight}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Scorecards (P7, RFC_INDICATOR_AGENT_PLATFORM §7): every room agent's 30-day track record, the
 * weight it carries in the crowd line, the H1 decision and the indicators. Scores come from prices
 * only, never from model text.
 */
export default function Scorecards() {
  const { data, loading, error } = usePoll(() => get("/api/scorecards?days=30"), 300_000);
  const d = data as any;
  const rooms = d?.reputation?.rooms ?? {};
  const others = ((d?.subjects ?? []) as any[]).filter((s) => SUBJECT[s.subject]);
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Scorecards" icon={<Trophy className="h-3.5 w-3.5 text-amber-300" />} right={<Badge tone="purple">last 30 days · prices only</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">
          Every call is scored on the next {d?.scoring?.horizon ?? 4} closed candles. A BUY or SELL is a hit when price moves {d?.scoring?.thresholdAtr ?? 0.5} × ATR its way first, a miss when it moves against it first.
          A WAIT is right when no {d?.scoring?.waitTargetAtr ?? 1} × ATR move came, and a missed move when one did. Accuracy is over the decisive calls.
          The crowd weight is twice the accuracy shrunk toward 50 % with {d?.reputation?.prior ?? 10} neutral calls, between ×{d?.reputation?.weight_range?.[0] ?? 0.25} and ×{d?.reputation?.weight_range?.[1] ?? 2}: an agent earns its weight with its sample.
        </p>
      </Panel>
      {loading && !d ? <Panel><Skeleton rows={6} /></Panel> : error && !d ? <Panel><p className="text-[12px] text-rose-300">Scorecards unavailable: {error}</p></Panel> : (
        <>
          <Panel title="1H War Room agents"><AgentTable rows={rooms["1H"] ?? []} /></Panel>
          <Panel title="15m Live War Room agents"><AgentTable rows={rooms["15m"] ?? []} /></Panel>
          <Panel title="H1 decision and indicators">
            {!others.length ? <Empty>No scored H1 calls yet.</Empty> : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Subject</th><th>Scored</th><th>BUY/SELL hit rate</th><th>WAIT accuracy</th><th>Brier</th></tr></thead>
                  <tbody>{others.map((s) => (
                    <tr key={s.subject + s.timeframe}><td className="text-slate-200">{SUBJECT[s.subject]}</td><td className="mono">{s.n}</td><td className="mono">{p(s.directional?.hit_rate)} ({s.directional?.n ?? 0})</td><td className="mono">{p(s.wait?.accuracy)} ({s.wait?.n ?? 0})</td><td className="mono">{s.brier ?? "n/a"}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Panel>
          <Compliance />
          {!!d?.stuck_states?.length && (
            <Panel title="Caution: stuck states" right={<Badge tone="amber">{d.stuck_states.length} open</Badge>}>
              <ul className="space-y-1 text-[12px] text-slate-300">{d.stuck_states.map((s: any, i: number) => <li key={i}>{s.field}: unchanged for {s.candles} candles while price moved {s.atr ? Math.round((s.price_range / s.atr) * 10) / 10 : "?"} × ATR</li>)}</ul>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
