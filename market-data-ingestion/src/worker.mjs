// Worker entry module. Kept separate from index.mjs so unit tests can import
// index.mjs under Node without the `cloudflare:workers` runtime module.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker from "./index.mjs";
import { readChartCandles } from "./chart-reader.mjs";
import { readDiagnostics } from "./diagnostics.mjs";

/**
 * Read-only RPC entrypoint for the Nexus dashboard (Service Binding with
 * entrypoint "MarketDataReader"). Not reachable over public HTTP, so it needs
 * no shared secret, and it never triggers a TradingView MCP call.
 */
export class MarketDataReader extends WorkerEntrypoint {
  async candles(options) {
    return readChartCandles(this.env, options || {});
  }

  /** Read-only lane diagnostics (KV state); never triggers a TradingView MCP call. */
  async diagnostics() {
    return readDiagnostics(this.env);
  }
}

export default worker;
