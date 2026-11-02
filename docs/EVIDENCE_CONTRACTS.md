# Evidence Contracts — Version 1

Status: implementation contract; source parity and production acceptance remain incomplete.

## Correlation identity

Both inbound webhook and local-calculation request bodies are capped at 64 KiB and are read as bounded streams before JSON parsing. The limit is an explicit API contract; increase it only after measuring real payload sizes and memory impact.

All evidence for one analysis must refer to the same canonical candle identity:
- `symbol`: canonical market symbol; provider prefixes may differ, but the instrument suffix must match.
- `timeframe`: normalized uppercase timeframe identifier.
- `candle_time`: parseable timestamp identifying the same candle.
- `candle_key`: the exact correlation key used by the webhook pipeline.
- All timestamps are ISO-8601 UTC. A producer must not silently substitute receipt time for candle time.

The existing inbound webhook contract accepts `prophet_r38`, `prophet_r37_ssot`, and `gmi_v12_70`. The Worker stamps the normalized stored envelope with `cryptophys.webhook-evidence.v1`; this preserves compatibility with existing TradingView alerts while giving fusion a versioned internal contract. The configured three-source webhook gate remains in place.

## Local calculation contract

Endpoint: `POST /evidence/local-calculation` on the AI Worker. Authentication: `x-webhook-secret` header, using the existing Worker webhook secret. Request body maximum: 64 KiB.

Required JSON shape:

```json
{
  "schema_version": "cryptophys.local-calculation.v1",
  "engine": "mizan",
  "symbol": "OANDA:XAUUSD",
  "timeframe": "M5",
  "candle_time": "2026-11-01T14:55:00.000Z",
  "candle_key": "OANDA:XAUUSD:M5:2026-11-01T14:55:00.000Z",
  "computed_at": "2026-11-01T14:59:00.000Z",
  "calculation_version": "engine-version-and-parameter-set",
  "values": {},
  "provenance": {
    "source": "verified-local-calculation",
    "source_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "implementation_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
```

Allowed `engine` values are `mizan`, `prophet`, and `gmi`. This endpoint validates and stores results; it does **not** implement the calculation engines. Each result must be independently reproducible, versioned, and supported by source fixtures/parity tests before it can be considered production evidence. A calculation result older than 30 minutes, computed more than five minutes in the future, or computed more than five minutes before its candle timestamp is rejected. The timeframe-aware candle-age windows below are **provisional implementation defaults, not approved production policy**; they must be reviewed against the source candle timestamp semantics before production release.

## Completed fundamental news analysis

The AI Worker reads the most recent completed analysis from its own `news_analyses` D1 table and stamps it as `cryptophys.completed-news-analysis.v1`. A valid record must contain `status=ok`, `analysis_type=fundamental_news`, valid `fetched_at` and `analyzed_at` timestamps, symbol coverage, and non-empty underlying article evidence. Both the completed analysis timestamps and every underlying article publication timestamp must be within the preceding hour; missing/unparseable publication times, future articles, stale articles, or duplicate articles make the entire news evidence invalid. Filtering occurs before Workers AI, and fusion independently validates stored/historical analysis rows so a recent fetch timestamp cannot make old articles appear fresh. The current news ingestion provider's quota cooldown is a source failure, not evidence of no market impact.

## Fusion behavior

The versioned fused bundle uses `cryptophys.evidence-fusion.v1`. It records webhook source names, validated local calculation results, the completed news analysis, missing evidence, and validation errors. The provisional maximum candle ages are M1 5m, M5 15m, M15 45m, M30 90m, H1 3h, H2 6h, H4 12h, D1 72h, and W1 14d. Unknown timeframe labels fail closed until an explicit policy is defined. These values are candidate safeguards and require owner approval before production. Any missing required local engine or fresh completed news analysis results in `status=degraded`. The AI chain still produces a diagnostic advisory record, but the final decision is forced to `WAIT`; confidence, entry, stop, target, risk/reward, and position size are null. This is not a substitute for acceptance tests.

## Security and operational constraints

- Never put secrets in the body, calculation values, provenance, logs, or fixtures.
- Do not treat a webhook, local result, or news analysis as trusted merely because it is parseable.
- The existing secret header is the only authentication mechanism for the local-calculation endpoint; it must remain a Cloudflare secret.
- The API accepts local calculation output only; it does not perform trades, place orders, or connect to a broker.
- Current source files do not establish Pine parity for Mizan, Prophet, or GMI. Production readiness remains blocked until exact source versions and fixtures are reviewed.
