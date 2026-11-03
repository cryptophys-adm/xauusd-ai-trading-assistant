// Worker entry module. Kept separate from index.mjs so unit tests can import
// index.mjs under Node without the `cloudflare:workers` runtime module.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { runTvOhlcv } from "./index.mjs";

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

export default worker;
