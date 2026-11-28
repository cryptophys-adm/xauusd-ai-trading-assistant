import { get } from "./api";
import { usePoll } from "./usePoll";
import { WORKERS } from "./names";

/** A lane's state in the status tones (as the header): ok cyan, late amber, fault red, off grey (idle, market closed). */
export type Tone = "ok" | "late" | "fault" | "off";
export type HealthItem = { key: string; label: string; tone: Tone; detail: string; worker?: string };

/** Gold, the dollar and yields do not trade from Friday 17:30 to Sunday 18:00 New York (as the pull adapter). */
const NY_WEEK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function marketClosed(now = Date.now()): boolean {
  const p = Object.fromEntries(NY_WEEK.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const m = Number(p.hour) * 60 + Number(p.minute);
  return (p.weekday === "Fri" && m >= 17 * 60 + 30) || p.weekday === "Sat" || (p.weekday === "Sun" && m < 18 * 60);
}
const age = (iso?: string | null) => { const t = Date.parse(String(iso ?? "")); return Number.isFinite(t) ? Date.now() - t : null; };
const mins = (ms: number | null) => (ms == null ? "never" : ms < 120_000 ? `${Math.round(ms / 1000)}s ago` : ms < 7_200_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`);

/** Pure: the health of every lane from /api/status and the pull adapter diagnostics (/api/local-lane). */
export function healthItems(status: any, lane: any, now = Date.now()): HealthItem[] {
  const ai = status?.ai_worker ?? {}, ing = status?.ingestion_worker ?? {};
  const closed = marketClosed(now);
  const items: HealthItem[] = [];
  if (status) {
    items.push({ key: "ai", label: "AI Worker", worker: WORKERS.ai.name, tone: ai.status === "ok" ? "ok" : "fault", detail: ai.status === "ok" ? "answering" : "not answering" });
    const pull = ing.last_scheduled_ingest ?? null;
    const pullBad = pull && !["ok", "empty"].includes(pull.status);
    items.push({ key: "news", label: "News Worker", worker: WORKERS.news.name, tone: ing.status !== "ok" ? "fault" : pullBad ? "late" : "ok", detail: ing.status !== "ok" ? "not answering" : `last hourly pull ${pull?.status ?? "none"} ${mins(age(pull?.checked_at ?? null))}` });
    items.push({ key: "oauth", label: "TradingView MCP OAuth", worker: WORKERS.news.name, tone: ing.oauth_authorized ? "ok" : "fault", detail: ing.oauth_authorized ? "authorized" : "not authorized: the news and the bars stop" });
    // S5 (parity removal): /api/status keeps only local_lane.fresh (local 1H records exist for a recent closed candle);
    // the parity rows and texts are gone.
    items.push({
      key: "lane", label: "Local lane", worker: WORKERS.pull.name,
      tone: ai.local_lane?.fresh ? "ok" : closed ? "off" : "fault",
      detail: ai.local_lane?.fresh ? "local 1H records for the latest bars" : closed ? "market closed: no new 1H bar" : "no local 1H record for the last two bars"
    });
  }
  if (lane) {
    const r = lane.last_refresh ?? {};
    const okStatus = ["ok", "up_to_date"].includes(r.status);
    items.push({
      key: "pull", label: "Pull adapter", worker: WORKERS.pull.name, tone: okStatus ? "ok" : r.status === "partial" ? "late" : closed && r.status === "daily_budget_exhausted" ? "off" : r.status ? "fault" : "late",
      detail: `${r.status ?? "no refresh yet"} · ${mins(age(r.checked_at))}`
    });
    const used = Number(lane.budget?.used) || 0, daily = Number(lane.budget?.daily);
    const known = Number.isFinite(daily) && daily > 0;
    items.push({ key: "budget", label: "TradingView MCP budget", worker: WORKERS.news.name, tone: !known ? "off" : used >= daily ? "fault" : used >= 0.9 * daily ? "late" : "ok", detail: known ? `${used} of ${daily} calls today (UTC)` : `${used} calls today (UTC), limit not reported` });
    const m1 = (lane.series ?? []).find((s: any) => s.series === "OANDA:XAUUSD|1m");
    const a = age(m1?.latest_close_time);
    items.push({ key: "bars", label: "OANDA:XAUUSD bars", worker: WORKERS.pull.name, tone: closed ? "off" : a != null && a <= 15 * 60_000 ? "ok" : a != null && a <= 60 * 60_000 ? "late" : "fault", detail: closed ? "market closed" : `last 1m close ${mins(a)}` });
  }
  return items;
}

/** The live health, shared by the System status page and the War Room's issue panel. */
export function useSystemHealth() {
  const status = usePoll(() => get("/api/status"), 30_000);
  const lane = usePoll(() => get("/api/local-lane"), 60_000);
  return { status: status.data as any, lane: lane.data as any, items: healthItems(status.data, lane.data), loading: status.loading && !status.data, error: status.error, poll: status, lanePoll: lane };
}
