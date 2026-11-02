# Market Data Ingestion Worker

Status: implementation added on feature branch; **not deployed and not approved as Pine-parity evidence**.

## Worker and endpoints

- Worker: `xauusd-tradingview-pull-adapter`
- Provider adapter: Twelve Data `/time_series` endpoint. First bootstrap requests up to 5,000 M5 candles; later pulls request 3 M5 rows and merge by candle open time. Daily and weekly warm-up context is fetched separately at up to 60 closed candles each. All requests use `timezone=UTC`.
- `GET /health`: configuration status only; does not make an upstream request.
- `POST /pull`: authenticated on-demand pull using `Authorization: Bearer <MARKET_DATA_INGEST_SECRET>`.
- `GET /latest`: latest cached normalized bundle, authenticated with the same bearer secret; returns 503 if no successful recent pull exists.
- `GET /engine-inputs?engine=mizan|prophet|gmi`: authenticated, versioned per-engine candle input envelope with history gaps, source caller contract, and structured unavailable-input records. This is the handoff contract for local engine consumers; it does not itself run or certify those calculations.
- `GET /engine-shadow?engine=prophet`: authenticated shadow-only execution of the partial local Prophet R38 kernel against the cached M5/M15/H1/H4/D1/W1 bundle. Returns the last 20 outputs and explicit partial/unverified status. Calculation is bounded to the most recent 500 closed M5 bars for Worker CPU safety while the full bundle remains cached; it is not a full R38 engine and never emits trusted evidence. `engine=mizan|gmi` returns HTTP 501 with an explicit blocked-calculator status rather than inventing results.
- Scheduled pull: every five minutes (`*/5 * * * *`). A KV bootstrap-state key prevents repeatedly requesting the full 5,000-row bootstrap; failed/short bootstrap retries are limited to once per 24 hours.

This worker uses Twelve Data as the configured market-data provider. It does **not** call TradingView directly: TradingView states it does not currently offer a public API for retrieving market data or indicator values. The existing ChatGPT TradingView MCP connection is not an endpoint that a Cloudflare Worker can automatically call. See the official [TradingView API statement](https://www.tradingview.com/support/solutions/43000474413-i-need-access-to-your-api-in-order-to-get-data-or-indicator-values/) and [Twelve Data time-series documentation](https://twelvedata.com/docs).

## Output contract

Schema: `cryptophys.market-data.v1`.

- Canonical strategy symbol: `OANDA:XAUUSD`.
- Provider symbol: `XAU/USD`. These symbols are mapped for strategy correlation, **not asserted to have identical candles or prices**.
- M5: up to 5,000 closed OHLCV candles; the currently forming M5 candle is excluded. This provides about 17 days of M5 history, around 104 H4 candles, 416 H1 candles, and 1,666 M15 candles when data is complete.
- M15/H1/H4/D1: aggregated from complete, contiguous M5 groups aligned to UTC boundaries. The aggregated D1 series has only about 17 days with a 5,000-bar M5 bootstrap, so it is not sufficient for the source's 20-day daily CPR width average or Prophet's default 50-bar D1/W1 warm-up.
- Additional native D1 and W1 context series request up to 60 closed bars each. These are separate provider-native context inputs, not substituted into the M5-derived aggregation; the input envelope records their separate provenance. Because Twelve Data documents that `timezone` is ignored for 1day/1week intervals, these series are accepted only when the response explicitly identifies `exchange_timezone` as UTC/GMT.
- Each candle includes UTC `open_time`, `close_time`, OHLC, and volume where supplied.
- No synthetic volume: if provider volume is absent, it remains `null` and `volume_available=false`.
- The cache uses a dedicated `market-data:v1:OANDA:XAUUSD` key prefix in the existing `SIGNAL_CACHE` KV namespace; the existing AI Worker binding is not modified.

## Source-derived history and caller contracts

The detailed source-derived contract is maintained in [LOCAL_ENGINE_CALLER_CONTRACTS.md](LOCAL_ENGINE_CALLER_CONTRACTS.md). The runtime input contract uses these conservative minimum warm-up floors for the known checked-in callers:

- Prophet R38: M5=101 bars for `hurst_rs(close, 100)`; M15/H1/H4/D1/W1=51 closed bars for the default 50-bar HTF KWW z-score with a prior-bar offset.
- GMI: M5=300 bars for the configured profile lookback; M15/H1/H4/D1/W1=51 bars for the conservative 50-bar MTF warm-up; D1=21 closed bars for the current CPR width plus 20-day mean.
- MizanLib as a shared library: minimum union for the known Prophet R38/GMI call sites is M5=300 and M15/H1/H4/D1/W1=51. This is **not a universal history requirement for every library export** and does not establish published-library identity or output parity.

The source files for Prophet R38 and GMI import `cryptophys/CryptophysMizanLib/4`; the owner-designated checked-in uploaded library source has a v1.6 header. The exact installed/published `/4` source body must be matched before claiming source identity.

## Explicitly unavailable GMI inputs

The current market-data bundle does not provide:
- M1 intrabar OHLCV arrays used by `request.security_lower_tf` on the configured M5 workflow;
- `TVC:DXY` H4 history;
- `CRYPTOCAP:USDT` H4 history;
- `TVC:USOIL` chart-timeframe history;
- TradingView-compatible footprint/order-flow semantics.

The engine input response now enumerates these as structured `unavailable_inputs`. Features depending on them are not reproducible from the present bundle and must remain unavailable/unsupported; no constants, synthetic intrabars, or proxy symbols may be substituted.

## Required secrets and release gates

Configure Worker secrets out-of-band:
- `TWELVE_DATA_API_KEY`: Twelve Data API key, sent in the provider's `Authorization: apikey …` header rather than a query string.
- `MARKET_DATA_INGEST_SECRET`: high-entropy secret for authenticated manual pulls and downstream access.

No API key or ingest secret is committed to the repository. The branch config binds the existing KV namespace ID used by the AI Worker's `SIGNAL_CACHE` as `MARKET_DATA_CACHE`; verify this binding against the active Cloudflare account before deployment. It does not create or replace any Cloudflare resource.

## Calculation compatibility and limitations

The bundle is a market-data input substrate. The new `/engine-shadow?engine=prophet` route runs only the partial R38 oscillator/structure/confirmation/HTF kernel; it is not the full Prophet R38 calculation result. Mizan and GMI have no local calculators exposed by this Worker. The full Prophet R38 engine is not implemented by the R37 shared-core kernel. GMI is blocked from full reproduction by missing external series, intrabars, and footprint/order-flow semantics. MizanLib is a shared dependency rather than a standalone signal engine, and the exact installed/published library identity is unresolved.

All three engines remain `parity_status=not_proven` and `calculation_allowed_for_trusted_evidence=false`. A history-ready result only means the configured input floor is present; it is not a calculation pass. No engine provenance allowlist is enabled by this worker.

Before production: validate the API plan and XAU/USD access, test provider quotas/cooldown, confirm actual returned volume semantics, run preview runtime tests, and verify the cache namespace binding. Capture closed-candle fixtures from the exact installed TradingView sources and require feature-level parity before enabling trusted evidence. No production deployment is performed by this change.
