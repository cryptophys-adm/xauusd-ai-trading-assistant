// Worker entry module. Kept separate from index.mjs so unit tests can import
// index.mjs under Node without the `cloudflare:workers` runtime module.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { runTvOhlcv, runTvEconomicCalendar, runNewsPull, gatewayStatus } from "./index.mjs";

/**
 * RPC-only OHLCV gateway for internal Workers (Service Binding with
 * entrypoint "TvGateway"). Not reachable over public HTTP, so it needs no
 * shared secret. Uses this Worker's single TradingView MCP OAuth grant and
 * account-wide quota cooldown.
 */
export class TvGateway extends WorkerEntrypoint {
  async ohlcv(requests) {
    return runTvOhlcv(this.env, requests, "pull_adapter");
  }
  /** The economic calendar of one window, with the released values (owner 2026-11-10). */
  async economicCalendar(request) {
    return runTvEconomicCalendar(this.env, request);
  }
}

/**
 * RPC-only news pull for the AI Worker (Service Binding with entrypoint
 * "NewsIngestionService", binding NEWS_INGESTION). Same result as POST /pull,
 * without exposing or sharing INGEST_SECRET.
 */
export class NewsIngestionService extends WorkerEntrypoint {
  async pull(options = {}) {
    return runNewsPull(this.env, this.ctx, { forceRefresh: options?.forceRefresh === true });
  }
  /**
   * The AI Worker's Calendar Agent (owner 2026-11-10): the released values of the economic calendar,
   * and gold's 1-hour history to learn each event kind's reaction horizon. Same quota cooldown.
   */
  async economicCalendar(request) {
    return runTvEconomicCalendar(this.env, request);
  }
  /** The gateway's quota cooldown, OAuth state and last news pull (read-only), for the AI Worker's health check. */
  async gatewayStatus() {
    return gatewayStatus(this.env);
  }
  async goldHistory(count = 6000) {
    return runTvOhlcv(this.env, [{ symbol: "OANDA:XAUUSD", interval: "1h", count: Math.max(100, Math.min(8000, Number(count) || 6000)) }], "gold_history");
  }
}

export default worker;
