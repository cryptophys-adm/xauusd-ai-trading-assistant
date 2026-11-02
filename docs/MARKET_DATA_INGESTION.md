# Market Data Ingestion Worker

Status: implementation added on feature branch; **not deployed and not approved as Pine-parity evidence**.

## Worker and endpoints

- Worker: `xauusd-tradingview-pull-adapter`
- Provider adapter: Twelve Data `/time_series` endpoint. First bootstrap requests up to 5,000 M5 candles; later pulls request 3 M5 rows and merge by candle open time. Daily and weekly warm-up context is fetched separately at up to 60 closed candles each. All requests use `timezone=UTC`.
- `GET /health`: configuration status only; does not make an upstream request.
- `POST /pull`: authenticated on-demand pull using `Authorization: Bearer <MARKET_DATA_INGEST_SECRET>`.
- `GET /latest`: latest cached normalized bundle, authenticated with the same bearer secret; returns 503 if no successful recent pull exists.
- `GET /engine-inputs?engine=mizan|prophet|gmi`: authenticated, versioned per-engine candle input envelope with history gaps and calculation gates. This is the handoff contract for the planned local engine Workers; it does not itself run or certify those calculations.
- Scheduled pull: every five minutes (`*/5 * * * *`). A KV bootstrap-state key prevents repeatedly requesting the full 5,000-row bootstrap; failed/short bootstrap retries are limited to once per 24 hours.

This worker uses Twelve Data as the configured market-data provider. It does **not** call TradingView directly: TradingView states it does not currently offer a public API for retrieving market data or indicator values. The existing ChatGPT TradingView MCP connection is not an endpoint that a Cloudflare Worker can automatically call. See the official [TradingView API statement](https://www.tradingview.com/support/solutions/43000474413-i-need-access-to-your-api-in-order-to-get-data-or-indicator-values/) and [Twelve Data time-series documentation](https://twelvedata.com/docs).

## Output contract

Schema: `cryptophys.market-data.v1`.

- Canonical strategy symbol: `OANDA:XAUUSD`.
- Provider symbol: `XAU/USD`. These symbols are mapped for strategy correlation, **not asserted to have identical candles or prices**.
- M5: up to 5,000 closed OHLCV candles; the currently forming M5 candle is excluded. This provides about 17 days of M5 history, around 104 H4 candles, 416 H1 candles, and 1,666 M15 candles when data is complete.
- M15/H1/H4/D1: aggregated from complete, contiguous M5 groups aligned to UTC boundaries. The aggregated D1 series has only about 17 days with a 5,000-bar M5 bootstrap, so it is not sufficient for the source's 20-day daily CPR width average or Prophet's default 50-bar D1/W1 warm-up.
- Additional native D1 and W1 context series request up to 60 closed bars each. These are separate provider-native context inputs, not substituted into the M5-derived aggregation; the input envelope records their separate provenance.
- Each candle includes UTC `open_time`, `close_time`, OHLC, and volume where supplied.
- No synthetic volume: if provider volume is absent, it remains `null` and `volume_available=false`.
- The cache uses a dedicated `market-data:v1:OANDA:XAUUSD` key prefix in the existing `SIGNAL_CACHE` KV namespace; the existing AI Worker binding is not modified.

## Required secrets and release gates

Configure Worker secrets out-of-band:
- `TWELVE_DATA_API_KEY`: Twelve Data API key.
- `MARKET_DATA_INGEST_SECRET`: high-entropy secret for authenticated manual pulls and downstream access.

No API key or ingest secret is committed to the repository. The branch config binds the existing KV namespace ID used by the AI Worker's `SIGNAL_CACHE` as `MARKET_DATA_CACHE`; verify this binding against the active Cloudflare account before deployment. It does not create or replace any Cloudflare resource.

## Engine input gates

The R38 Prophet source uses a 100-bar Hurst calculation and 50-bar KWW z-scores for default 15m, 1H, 4H, 1D and 1W alignment inputs (closed HTF bars are offset by one). The input contract therefore requires 101 M5 bars and 51 bars for each default higher timeframe. GMI uses a 300-bar profile lookback and a 20-day average of daily CPR width; its default MTF alignment also uses W1. The worker reports these counts rather than padding missing history.

`GET /engine-inputs?engine=prophet` returns the market-data input envelope with all required candle series when the history gate passes. It still marks calculation status `blocked_source_parity`: the exact published MizanLib /4 dependency and feature-level TradingView fixtures remain unresolved. Mizan is blocked on its exact caller/source contract. GMI is additionally blocked on M1 intrabar arrays, DXY/USDT/USOIL history, and TradingView-compatible footprint/order-flow data. No endpoint may turn these blocked envelopes into trusted local-calculation evidence.

## Calculation compatibility and limitations

The bundle is a market-data input substrate, not the MizanLib, Prophet, or GMI calculation result. Three hundred M5 candles provide only a bounded bootstrap window. Higher timeframes are derived from M5 data and can differ from TradingView because of provider feed, session boundary, missing-bar, or volume semantics.

OHLCV alone does not reproduce every source dependency. The GMI source includes footprint/order-flow and volume-profile functions, multi-timeframe and external-symbol inputs; MizanLib/Prophet calculations also require exact source/version and warm-up semantics. Those outputs must remain explicitly unavailable until their inputs and parity fixtures are proven. No engine provenance allowlist is enabled by this worker.

Before production: validate the API plan and XAU/USD access, test provider quotas/cooldown, confirm actual returned volume semantics, run preview runtime tests, and verify the cache namespace binding. No production deployment is performed by this change.
