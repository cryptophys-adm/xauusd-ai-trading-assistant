import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const IMPACT_TONE: Record<string, string> = { High: "text-rose-300", Medium: "text-amber-200", Low: "text-slate-400", Holiday: "text-slate-500" };
const day = (t: string) => new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
const hm = (t: string) => t.slice(11, 16);
const arrow = (x?: number | null) => (x == null ? <span className="text-slate-500">tone</span> : x > 0 ? <span className="text-emerald-300">gold ▲</span> : x < 0 ? <span className="text-rose-300">gold ▼</span> : <span className="text-slate-500">flat</span>);
const STATUS: Record<string, string> = { upcoming: "upcoming", imminent: "within 2 h", released: "released", past: "past" };

/** Backlog 11.1: the week's economic calendar (ForexFactory export) and the event-risk gate. */
export default function Calendar() {
  const { data, loading, error } = usePoll(() => get("/api/calendar"), 300_000);
  const [all, setAll] = useState(false);
  const v = data as any;
  const events: any[] = (v?.events ?? []).filter((e: any) => all || (e.currency === "USD" && e.impact === "High"));
  const gate = v?.risk?.gate;
  const active = new Set((v?.risk?.active ?? []).map((e: any) => e.title + e.time));
  const now = Date.now();
  return (
    <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
      <Panel title="Economic calendar" icon={<CalendarDays className="h-3.5 w-3.5 text-cyan-300" />} right={v?.risk?.active?.length ? <Badge tone="amber">event risk now</Badge> : <Badge tone="cyan">no event risk now</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">
          The week's events from the ForexFactory export, refreshed hourly (last {v?.fetched_at ? `${v.fetched_at.slice(5, 16).replace("T", " ")} UTC` : "not yet"}).
          {gate ? ` A ${gate.impacts.join("/")}-impact ${gate.currencies.join("/")} event is a caution for the strategy engine from ${gate.before_minutes / 60} hours before to ${gate.after_minutes} minutes after it; it never forces a wait.` : ""} Times in UTC.
        </p>
        <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-[12px] text-slate-300"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show every currency and impact</label>
      </Panel>
      {v?.outlook ? (
        <Panel title="Calendar Agent" right={v.outlook.released?.length ? <Badge tone={v.outlook.surprise_lean > 0 ? "green" : v.outlook.surprise_lean < 0 ? "red" : "slate"}>{v.outlook.surprise_lean > 0 ? "released surprise: gold up" : v.outlook.surprise_lean < 0 ? "released surprise: gold down" : "released in line"}</Badge> : <Badge tone={v.outlook.consensus_lean > 0 ? "green" : v.outlook.consensus_lean < 0 ? "red" : "slate"}>{v.outlook.consensus_lean > 0 ? "consensus leans gold up" : v.outlook.consensus_lean < 0 ? "consensus leans gold down" : "no consensus lean"}</Badge>}>
          <p className="text-[12px] leading-relaxed text-slate-300">{v.outlook.summary}</p>
          <p className="mt-1 text-[11px] text-slate-500">Projection by fixed rules per event kind: stronger US data or a hawkish Fed lift the dollar and yields, which weighs on gold; weaker data or a dovish Fed do the opposite. After the release, the actual comes from TradingView's economic calendar: the surprise against the forecast (in the series' own standard deviations) and the rule give the effect on gold. The horizon is learned per event kind from gold's moves after the past releases (1 to 24 hours, in 1H ATR); until 5 are measured it is 2 hours before to 4 hours after. Context only; it never places a trade.</p>
          {v.releases?.history ? <p className="mt-1 text-[11px] text-slate-500">History: {v.releases.history.with_actual} releases with an actual{v.releases.history.since ? ` since ${String(v.releases.history.since).slice(0, 10)}` : ""}.</p> : null}
          {v.releases?.horizons && Object.keys(v.releases.horizons).length ? (
            <div className="table-wrap mt-2">
              <table className="tbl">
                <thead><tr><th>Event kind</th><th>Releases</th><th title="The longest horizon where gold still followed the rule at least 55% of the time">Learned horizon</th><th>Strongest</th><th>1h</th><th>4h</th><th>24h</th></tr></thead>
                <tbody>
                  {Object.entries(v.releases.horizons).map(([kind, st]: [string, any]) => (
                    <tr key={kind}>
                      <td>{kind.replace("_", " ")}</td><td className="mono">{st.samples}</td>
                      <td className="mono">{st.horizon_hours == null ? "measuring" : st.horizon_hours ? `${st.horizon_hours}h` : "none"}</td>
                      <td className="mono">{st.peak ? `${st.peak.at} · ${Math.round(st.peak.hit_rate * 100)}%` : "—"}</td>
                      {["1h", "4h", "24h"].map((h) => <td key={h} className="mono text-[11px]">{st.horizons?.[h] ? `${st.horizons[h].mean_atr > 0 ? "+" : ""}${st.horizons[h].mean_atr} ATR · ${Math.round(st.horizons[h].hit_rate * 100)}%` : "—"}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {v.outlook.events?.length ? (
            <ul className="mt-2 space-y-1.5">
              {v.outlook.events.map((p: any) => (
                <li key={p.title + p.time} className="glass-inner px-3 py-2 text-[11.5px] text-slate-300">
                  <span className="mono text-slate-400">{day(p.time)} {hm(p.time)}</span> · <b className="text-slate-100">{p.title}</b> <span className="text-slate-500">({STATUS[p.status] ?? p.status})</span>
                  {p.release ? <div className="mono mt-0.5 text-[11px] text-slate-200">actual {p.release.actual} · forecast {p.release.forecast ?? "—"} · surprise {p.release.surprise_z != null ? `${p.release.surprise_z > 0 ? "+" : ""}${p.release.surprise_z}σ` : "—"} · gold {p.release.gold_direction > 0 ? "up" : p.release.gold_direction < 0 ? "down" : "neutral"} · horizon {p.horizon?.hours_after}h{p.horizon?.learned ? " (learned)" : ""}</div> : null}
                  <div className="mt-0.5 text-slate-400">{p.text}</div>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}
      {loading && !data ? <Panel><Skeleton rows={6} /></Panel> : error && !data ? <Panel><p className="text-[12px] text-rose-300">Calendar unavailable: {error}</p></Panel>
        : !events.length ? <Panel><Empty>{v?.fetched_at ? "No matching event this week." : "The calendar has not been fetched yet."}</Empty></Panel> : (
        <Panel title={all ? "All events" : "High-impact USD events"}>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Day</th><th>Time</th><th>Currency</th><th>Impact</th><th>Event</th><th>Actual</th><th>Forecast</th><th>Previous</th><th title="Projected move of gold if the actual is above / below the forecast">Above / below forecast</th></tr></thead>
              <tbody>
                {events.map((e) => {
                  const past = Date.parse(e.time) < now - 30 * 60_000;
                  return (
                    <tr key={e.title + e.time} className={active.has(e.title + e.time) ? "bg-amber-500/10" : past ? "opacity-50" : ""}>
                      <td>{day(e.time)}</td><td className="mono">{hm(e.time)}</td><td className="mono">{e.currency}</td>
                      <td className={IMPACT_TONE[e.impact] ?? "text-slate-400"}>{e.impact}</td><td>{e.title}</td>
                      <td className="mono">{e.projection?.release?.actual ?? ""}</td><td className="mono">{e.forecast ?? ""}</td><td className="mono">{e.previous ?? ""}</td>
                      <td className="text-[11px]">{e.projection ? <>{arrow(e.projection.gold_if_above_forecast)} / {arrow(e.projection.gold_if_below_forecast)}</> : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
