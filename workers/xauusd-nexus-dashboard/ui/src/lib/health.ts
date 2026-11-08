import { get } from "./api";
import { usePoll } from "./usePoll";
import { WORKERS, engineTitle } from "./names";

export type Tone = "green" | "amber" | "red" | "slate";
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
  const registry: any[] = Array.isArray(ai.local_lane?.registry) ? ai.local_lane.registry : [];
  const h1 = registry.filter((x) => x.engine === "prophet" || x.engine === "gmi");
  const reEarning = !ai.local_lane?.fresh && h1.length > 0 && h1.every((x) => x.status !== "approved");
  const progress = h1.length ? Math.min(...h1.map((x) => Number(x.consecutive_matches) || 0)) : 0;
  const closed = marketClosed(now);
  const items: HealthItem[] = [];
  if (status) {
    items.push({ key: "ai", label: "AI Worker", worker: WORKERS.ai.name, tone: ai.status === "ok" ? "green" : "red", detail: ai.status === "ok" ? "answering" : "not answering" });
    const pull = ing.last_scheduled_ingest ?? null;
    const pullBad = pull && !["ok", "empty"].includes(pull.status);
    items.push({ key: "news", label: "News Worker", worker: WORKERS.news.name, tone: ing.status !== "ok" ? "red" : pullBad ? "amber" : "green", detail: ing.status !== "ok" ? "not answering" : `last hourly pull ${pull?.status ?? "none"} ${mins(age(pull?.checked_at ?? null))}` });
    items.push({ key: "oauth", label: "TradingView MCP OAuth", worker: WORKERS.news.name, tone: ing.oauth_authorized ? "green" : "red", detail: ing.oauth_authorized ? "authorized" : "not authorized: the news and the bars stop" });
    items.push({
      key: "lane", label: "Local lane", worker: WORKERS.pull.name,
      tone: ai.local_lane?.fresh ? "green" : reEarning ? "amber" : closed ? "slate" : "red",
      detail: ai.local_lane?.fresh ? "approved local 1H records for the latest bars" : reEarning ? `${h1.map((x) => engineTitle(x.engine)).filter((v, i, a) => a.indexOf(v) === i).join(" and ")} re-earning parity: ${progress}/24` : closed ? "market closed: no new 1H bar" : "no approved local 1H record for the last two bars"
    });
    if (ai.local_lane?.calibration?.due) items.push({ key: "calibration", label: "Calibration", tone: "amber", detail: "an approved engine has not been compared for its interval" });
  }
  if (lane) {
    const r = lane.last_refresh ?? {};
    const okStatus = ["ok", "up_to_date"].includes(r.status);
    items.push({
      key: "pull", label: "Pull adapter", worker: WORKERS.pull.name, tone: okStatus ? "green" : r.status === "partial" ? "amber" : closed && r.status === "daily_budget_exhausted" ? "slate" : r.status ? "red" : "amber",
      detail: `${r.status ?? "no refresh yet"} · ${mins(age(r.checked_at))}`
    });
    const used = Number(lane.budget?.used) || 0, daily = Number(lane.budget?.daily) || 800;
    items.push({ key: "budget", label: "TradingView MCP budget", worker: WORKERS.news.name, tone: used >= daily ? "red" : used >= 0.9 * daily ? "amber" : "green", detail: `${used} of ${daily} calls today (UTC)` });
    const m1 = (lane.series ?? []).find((s: any) => s.series === "OANDA:XAUUSD|1m");
    const a = age(m1?.latest_close_time);
    items.push({ key: "bars", label: "OANDA:XAUUSD bars", worker: WORKERS.pull.name, tone: closed ? "slate" : a != null && a <= 15 * 60_000 ? "green" : a != null && a <= 60 * 60_000 ? "amber" : "red", detail: closed ? "market closed" : `last 1m close ${mins(a)}` });
  }
  return items;
}

/** The live health, shared by the System status page and the War Room's issue panel. */
export function useSystemHealth() {
  const status = usePoll(() => get("/api/status"), 30_000);
  const lane = usePoll(() => get("/api/local-lane"), 60_000);
  return { status: status.data as any, lane: lane.data as any, items: healthItems(status.data, lane.data), loading: status.loading && !status.data, error: status.error };
}
