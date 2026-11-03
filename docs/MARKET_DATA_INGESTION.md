# Market Data Ingestion Worker (TradingView-native inputs for local engines)

Status: implementation on `main`; **not deployed and not approved as Pine-parity evidence**.

## Direction (owner decision, 2026-11-03)

- **Twelve Data is deprecated and removed.** No third-party market-data provider is used.
- **TradingView webhooks are not part of the target design.** Local engines compute Mizan/Prophet/GMI themselves from TradingView data.
- Local engines must receive **exactly the inputs the Pine scripts see**. The worker therefore pulls OHLCV from TradingView the same way the news-ingestion Worker pulls news: via the TradingView MCP server with the account's OAuth grant.

## Data path

```
TradingView MCP  ──(OAuth, mcp-tv-get-ohlcv)──>  xauusd-fundamental-news-ingestion
                                                  POST /internal/tv-ohlcv  (gateway)
                                                        │  Service Binding TV_GATEWAY
                                                        ▼
                                          xauusd-tradingview-pull-adapter
                                          (per-series KV cache, closed bars only)
                                                        │
                                          /engine-inputs, /engine-shadow  → local engines
```

**Why the news Worker is the gateway:**
- It already owns the single TradingView MCP OAuth grant. The `client_id` is registered with its redirect URI, and refresh tokens rotate, so two independent owners could invalidate each other's grant.
- The MCP tool-call quota is account-wide. The gateway shares the news Worker's `tv_mcp:quota_cooldown_until` circuit breaker, so one quota suspension stops news and OHLCV calls together and no further calls are wasted.

## Gateway contract (`cryptophys.tv-ohlcv-gateway.v1`)

`POST /internal/tv-ohlcv` on `xauusd-fundamental-news-ingestion`:

- **Auth:** `Authorization: Bearer <TV_GATEWAY_SECRET>`. This is a dedicated secret, separate from `INGEST_SECRET`. The endpoint returns 503 if the secret is unset.
- **Body:** `{ "requests": [{ "symbol", "interval", "count", "date_to"? }] }`, 1–12 requests.
- **Symbol allowlist:** `TV_GATEWAY_SYMBOLS`, default `OANDA:XAUUSD, TVC:DXY, CRYPTOCAP:USDT, TVC:USOIL`.
- **Intervals:** `1m 5m 15m 30m 1h 4h 1D 1W`.
- **`count`:** 1–8000 (the MCP limit for `format=columns`).
- **Upstream call:** one `tools/call` → `mcp-tv-get-ohlcv` per request with `format: "columns"`.
- **Response:** per-request `{ ok, bars: {t,o,h,l,c,v}, has_more, next_date_to }`.
- **Validation:** non-finite OHLC and column-length mismatches are rejected. Missing volume stays `null`.
- **Quota exhaustion:** the batch stops at the first rejected call, the shared cooldown is recorded, and the gateway returns HTTP 429. While the cooldown is active, calls return 503 without contacting TradingView.

## Series pulled (all TradingView-native, no resampling)

| Series | Pine consumer | Retained bars |
|---|---|---:|
| `OANDA:XAUUSD` 5m | chart series (`open/high/low/close/volume`) | 5000 |
| `OANDA:XAUUSD` 1m | `request.security_lower_tf` intrabars (GMI footprint / profile) | 3000 |
| `OANDA:XAUUSD` 15m, 1h, 4h | `request.security` MTF | 2000 / 1000 / 500 |
| `OANDA:XAUUSD` 1D, 1W | daily CPR, D1/W1 alignment | 500 / 260 |
| `TVC:USOIL` 5m | GMI oil context (chart timeframe) | 1000 |
| `TVC:DXY` 4h, `CRYPTOCAP:USDT` 4h | GMI macro kinematics / penalty | 500 each |

**Bar semantics (verified against live MCP output on 2026-11-03):**
- `t` is the bar open time in Unix seconds.
- Daily and weekly bars open at the OANDA session boundary (17:00 New York), not at UTC midnight.
- The last bar returned is still forming. A bar is used only when `t + interval <= now`.
- `OANDA:XAUUSD` volume is OANDA tick volume, the same value as Pine's `volume` on that chart.
- `TVC:DXY` returns `v = null`, which is kept as `null`.

## Quota-aware refresh

- A cron runs every 5 minutes. A series is requested only when a new bar of its interval can have closed since the cached one. The first request bootstraps to the retention depth; later requests ask only for the gap plus overlap, merged by bar open time.
- **Per-run cap:** `TV_MAX_CALLS_PER_RUN`, default 8, maximum 12. The chart series (M5) is requested first; deferred series follow on the next run.
- **Daily cap:** `TV_DAILY_CALL_BUDGET`, default 1200 MCP calls per UTC day, counted in KV.
- **Steady-state usage:** about 3 calls per 5 minutes (M5, M1, USOIL) plus higher timeframes as their bars close, roughly 900–1000 calls per day. This is shared with news ingestion's hourly calls. If TradingView suspends the account, the shared cooldown stops both Workers.

## Worker endpoints (`xauusd-tradingview-pull-adapter`)

- **`GET /health`:** configuration status, the series list and the last refresh summary. No secrets.
- **`POST /pull`:** authenticated with `MARKET_DATA_INGEST_SECRET`. Runs one refresh cycle. Returns 429 for quota exhaustion and 503 for an active cooldown or exhausted daily budget.
- **`GET /latest`:** authenticated. Returns the assembled bundle `cryptophys.market-data.v2`, containing `timeframes` (M1/M5/M15/H1/H4/D1/W1), `context_timeframes` (D1/W1, for the v1 engine-input contract) and `external_series`. It returns 503 when no data exists or the latest closed M5 bar is older than 15 minutes, which includes market close.
- **`GET /engine-inputs?engine=mizan|prophet|gmi`:** authenticated per-engine input envelope.
  - GMI inputs (M1, DXY, USDT, USOIL) are reported as unavailable only when they are actually missing or under-warmed.
- **`GET /engine-shadow?engine=prophet`:** authenticated shadow run of the partial Prophet R38 kernel on the native series.
  - Uses the latest 500 M5 bars plus native M15/H1/H4/D1/W1.
  - Returns `parity_status=not_proven` and is never trusted evidence.
  - Mizan and GMI return 501 because no local calculator exists for them yet.

## Secrets and deployment

| Secret | Where | Purpose |
|---|---|---|
| `TV_GATEWAY_SECRET` (≥32 chars) | news Worker **and** this Worker | gateway authentication |
| `MARKET_DATA_INGEST_SECRET` (≥32 chars) | this Worker | `/pull`, `/latest`, `/engine-*` |

The TradingView OAuth grant is the existing one held by the news Worker (`/oauth/start` on `news.cryptophys.work`); no new authorization is needed.

Deploy with **Actions → Deploy Market Data Ingestion Worker (shadow)** after adding `TV_GATEWAY_SECRET` and `MARKET_DATA_INGEST_SECRET` as GitHub secrets. The workflow:
1. Sets the gateway secret on both Workers.
2. Deploys the adapter with the `TV_GATEWAY` Service Binding.
3. Smoke-tests `/health`, one `/pull`, and the shadow engine.

The news Worker must already be running the gateway code. Any merge to `main` that touches `fundamental-news-ingestion/` deploys it.

## Limits and what this does not prove

- Bars are served under the TradingView account's plan and exchange entitlements, either realtime or delayed. The MCP notice says "regular session only". For 24h OANDA FX/metals this matches the chart, but the session setting must match the indicator's chart for parity.
- Intraday depth is limited by the TradingView feed to a few thousand bars per interval.
- Having the right inputs is necessary but not sufficient for parity. Mizan/Prophet/GMI outputs remain `parity_status=not_proven` until closed-candle TradingView fixtures from the installed indicators are matched.
- The AI Worker still lists the webhook sources `prophet_r38`, `prophet_r37_ssot` and `gmi_v12_70` in `REQUIRED_SOURCES`. Replacing that webhook dependency with local-engine outputs is the next integration step and is not done here.
