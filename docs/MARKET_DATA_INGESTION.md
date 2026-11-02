# Market Data Ingestion Worker

Status: implementation added on feature branch; **not deployed and not approved as Pine-parity evidence**.

## Worker and endpoints

- Worker: `xauusd-tradingview-pull-adapter`
- Provider adapter: Twelve Data `/time_series` endpoint, configured for `XAU/USD`, `5min`, `outputsize=300`, `timezone=UTC`.
- `GET /health`: configuration status only; does not make an upstream request.
- `POST /pull`: authenticated on-demand pull using `Authorization: Bearer <MARKET_DATA_INGEST_SECRET>`.
- `GET /latest`: latest cached normalized bundle; returns 503 if no successful recent pull exists.
- Scheduled pull: every five minutes (`*/5 * * * *`).

This worker uses Twelve Data as the configured market-data provider. It does **not** call TradingView directly: TradingView states it does not currently offer a public API for retrieving market data or indicator values. The existing ChatGPT TradingView MCP connection is not an endpoint that a Cloudflare Worker can automatically call. See the official [TradingView API statement](https://www.tradingview.com/support/solutions/43000474413-i-need-access-to-your-api-in-order-to-get-data-or-indicator-values/) and [Twelve Data time-series documentation](https://twelvedata.com/docs).

## Output contract

Schema: `cryptophys.market-data.v1`.

- Canonical strategy symbol: `OANDA:XAUUSD`.
- Provider symbol: `XAU/USD`. These symbols are mapped for strategy correlation, **not asserted to have identical candles or prices**.
- M5: up to 300 closed OHLCV candles; the currently forming M5 candle is excluded.
- M15/H1/H4/D1: aggregated from complete, contiguous M5 groups aligned to UTC boundaries.
- Each candle includes UTC `open_time`, `close_time`, OHLC, and volume where supplied.
- No synthetic volume: if provider volume is absent, it remains `null` and `volume_available=false`.
- The cache uses a dedicated `market-data:v1:OANDA:XAUUSD` key prefix in the existing `SIGNAL_CACHE` KV namespace; the existing AI Worker binding is not modified.

## Required secrets and release gates

Configure Worker secrets out-of-band:
- `TWELVE_DATA_API_KEY`: Twelve Data API key.
- `MARKET_DATA_INGEST_SECRET`: high-entropy secret for authenticated manual pulls and downstream access.

No API key or ingest secret is committed to the repository. The branch config binds the existing KV namespace ID used by the AI Worker's `SIGNAL_CACHE` as `MARKET_DATA_CACHE`; verify this binding against the active Cloudflare account before deployment. It does not create or replace any Cloudflare resource.

## Calculation compatibility and limitations

The bundle is a market-data input substrate, not the MizanLib, Prophet, or GMI calculation result. Three hundred M5 candles provide only a bounded bootstrap window. Higher timeframes are derived from M5 data and can differ from TradingView because of provider feed, session boundary, missing-bar, or volume semantics.

OHLCV alone does not reproduce every source dependency. The GMI source includes footprint/order-flow and volume-profile functions, multi-timeframe and external-symbol inputs; MizanLib/Prophet calculations also require exact source/version and warm-up semantics. Those outputs must remain explicitly unavailable until their inputs and parity fixtures are proven. No engine provenance allowlist is enabled by this worker.

Before production: validate the API plan and XAU/USD access, test provider quotas/cooldown, confirm actual returned volume semantics, run preview runtime tests, and verify the cache namespace binding. No production deployment is performed by this change.
