import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { get } from "../lib/api";
import { usePoll } from "../lib/usePoll";

const IMPACT_TONE: Record<string, string> = { High: "text-rose-300", Medium: "text-amber-200", Low: "text-slate-400", Holiday: "text-slate-500" };
const day = (t: string) => new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
const hm = (t: string) => t.slice(11, 16);

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
      {loading && !data ? <Panel><Skeleton rows={6} /></Panel> : error && !data ? <Panel><p className="text-[12px] text-rose-300">Calendar unavailable: {error}</p></Panel>
        : !events.length ? <Panel><Empty>{v?.fetched_at ? "No matching event this week." : "The calendar has not been fetched yet."}</Empty></Panel> : (
        <Panel title={all ? "All events" : "High-impact USD events"}>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Day</th><th>Time</th><th>Currency</th><th>Impact</th><th>Event</th><th>Forecast</th><th>Previous</th></tr></thead>
              <tbody>
                {events.map((e) => {
                  const past = Date.parse(e.time) < now - 30 * 60_000;
                  return (
                    <tr key={e.title + e.time} className={active.has(e.title + e.time) ? "bg-amber-500/10" : past ? "opacity-50" : ""}>
                      <td>{day(e.time)}</td><td className="mono">{hm(e.time)}</td><td className="mono">{e.currency}</td>
                      <td className={IMPACT_TONE[e.impact] ?? "text-slate-400"}>{e.impact}</td><td>{e.title}</td>
                      <td className="mono">{e.forecast ?? ""}</td><td className="mono">{e.previous ?? ""}</td>
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
