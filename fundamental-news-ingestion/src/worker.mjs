// Worker entry module. Kept separate from index.mjs so unit tests can import
// index.mjs under Node without the `cloudflare:workers` runtime module.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { runTvOhlcv, runNewsPull } from "./index.mjs";

/**
 * RPC-only OHLCV gateway for internal Workers (Service Binding with
 * entrypoint "TvGateway"). Not reachable over public HTTP, so it needs no
 * shared secret. Uses this Worker's single TradingView MCP OAuth grant and
 * account-wide quota cooldown.
 */
export class TvGateway extends WorkerEntrypoint {
  async ohlcv(requests) {
    return runTvOhlcv(this.env, requests);
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
}

export default worker;
