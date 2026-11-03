# Autonomous Local-Engine Provenance (parity registry)

Status: implemented in the AI Worker (`src/parity-registry.mjs`). It replaces the operator-approved `LOCAL_CALC_PROVENANCE_ALLOWLIST`.

## Owner decision (2026-11-03)

- **`local_computation` is the primary technical lane** and stays a required lane of the evidence fusion (option 1).
- **The TradingView webhook lane** sends once per closed 1H candle and is the **comparator**: it carries TradingView's own indicator outputs and the candle's OHLCV.
- **No operator approval.** The AI Worker is the only holder of the privilege to promote or revoke a local-engine implementation, and it does so autonomously.

## Rule (deterministic; no model judgement)

An identity is `engine + provenance.source_hash + provenance.implementation_hash` (SHA-256). Every local output posted to `POST /evidence/local-calculation` is stored as **observed**. When the TradingView webhooks for the same `candle_key` are present (in either arrival order), the AI Worker compares the two.

1. **Input parity:** `values.candle.{o,h,l,c,volume}` must equal the webhook's `o,h,l,c,volume`. This proves the local engine ran on the same TradingView bar.
2. **Output parity:** `values.comparable.<webhook_source>.<field>` must equal the webhook field:

| Local engine | Webhook source | Fields |
|---|---|---|
| `prophet` | `prophet_r38` | direction, buy_confirmed, sell_confirmed, buy_high_quality, sell_high_quality, t_enc, d_enc, structure_subtype |
| `prophet` | `prophet_r37_ssot` | direction, d_enc, b_enc, structure_subtype, bull_event, bear_event |
| `gmi` | `gmi_v12_70` | verdict, gate, gmi_dir, prophet_dir, conflict |

Notes on the comparison:
- `structure_state` / `shared_core_status` are chart-relative `bar_index` values and are not compared.
- Numbers match within `PARITY_ABS_TOLERANCE` (default 1e-6) plus `PARITY_REL_TOLERANCE` (default 1e-9) × magnitude. Booleans and strings must match exactly.

Each comparison has one of four results:

| Result | Meaning | Effect |
|---|---|---|
| `match` | all inputs and fields equal | streak +1 |
| `mismatch` | any input or field differs | streak reset; an **approved** identity is **revoked** immediately (fail closed) |
| `incomplete` | the local side omitted a required field | neither advances nor resets the streak |
| `not_comparable` | webhooks for the candle are not all present yet | not recorded |

- **Promotion:** after `PARITY_PROMOTE_AFTER` consecutive matching candles (default **24**, i.e. about one trading day of 1H webhooks), the identity becomes `approved`.
- **Re-approval:** a revoked identity must earn the full streak again.
- **Counted once:** each identity is counted at most once per candle.
- **Mizan:** it has no webhook. A Mizan identity is trusted only while an approved Prophet **and** an approved GMI both declare it in `provenance.dependencies.mizan`.

Only observed records whose identity is currently trusted are copied into the `local_computation` lane (`localcalc:<candle>:<engine>`) that evidence fusion reads. Revocation removes them for that candle.

## Local producer contract additions

```json
{
  "values": {
    "candle": { "o": 0, "h": 0, "l": 0, "c": 0, "volume": 0 },
    "comparable": {
      "prophet_r38": { "direction": 0, "d_enc": 0 },
      "prophet_r37_ssot": { "d_enc": 0, "b_enc": 0 }
    }
  },
  "provenance": {
    "source_hash": "<sha256 of Pine source>",
    "implementation_hash": "<sha256 of engine implementation>",
    "dependencies": { "mizan": { "source_hash": "…", "implementation_hash": "…" } }
  }
}
```

- `candle_key` must be identical to the webhook's key, which is `tickerid:timeframe.period:time` (for example `OANDA:XAUUSD:60:<time ms>`). Comparison is only possible on candles the webhook lane covers, which means 1H.
- The response carries `trust_status`: `approved_by_parity` or `candidate_pending_parity`.

## Storage and endpoints

- **D1 tables:**
  - `engine_parity_registry`: status, streak, totals, last result/detail, approved_at/revoked_at.
  - `engine_parity_comparisons`: one row per identity per candle.
  - Both are created idempotently at runtime. `migrations/0002_engine_parity_registry.sql` records the schema.
- **`GET /ready`:** reports `provenance_mode: autonomous_parity_registry`, the policy, and status counts. It no longer requires an operator allowlist.
- **`GET /provenance/registry`:** requires `x-webhook-secret`. Lists identities with their streaks and last mismatch detail.
- **Production deploy** (`deploy-worker.yml`) no longer waits for an operator-approved allowlist secret.

## What this does and does not guarantee

- Trust is earned only by measured equality with TradingView's own outputs on the same bars. It is never granted by a person or by a model's opinion.
- Coverage is limited to the compared fields on 1H candles. A local engine can be trusted for those fields while other internal values remain unverified. Fields outside the comparison set must not be presented as verified.
- Until the local engines exist and produce matching outputs, the `local_computation` lane stays missing and, under option 1, fusion stays degraded. No decision is issued without all three lanes.

## Local producer (H1) — implemented

- **Where it runs:** `xauusd-tradingview-pull-adapter`, on its 5-minute cron, after each refresh. It calls `local-engines/producer/src/h1-producer.mjs`. For every newly closed `OANDA:XAUUSD` 1H bar (within 25 minutes of the close, published once per candle), it submits to the AI Worker through the RPC Service Binding `AI_WORKER` (entrypoint `LocalComputationIngress.submit()`). It needs no shared secret, because RPC entrypoints are not reachable over public HTTP.
- **`candle_key`:** `OANDA:XAUUSD:60:<bar open time ms>`, identical to what the AI Worker derives from the TradingView webhook (`syminfo.tickerid:timeframe.period:time`).
- **`mizan` record:**
  - Values: Mizan shared-core outputs (`prophet_structure_core`, `calculate_prophet_tensor`) on H1.
  - Has no comparator of its own; trust is derived as above.
- **`prophet` record:** compared against `prophet_r38` and `prophet_r37_ssot`.
  - `prophet_r38` comes from the R38 kernel on the H1 chart, with native M15/H1/H4/D1/W1 bars for HTF alignment.
  - `direction = buy_confirmed ? 1 : sell_confirmed ? -1 : 0`.
  - `t_enc` follows the R38 non-legacy precedence.
  - `prophet_r37_ssot` comes from the shared-core kernel. Its `direction` is GMI's `r10_prophet_consensus_dir`, and `bull_event`/`bear_event` are `event_bar != 0`.
- **`gmi`:** not produced. No local GMI calculator exists, and nothing is fabricated. Under option 1 the fusion therefore stays degraded until GMI exists, but the Prophet registry streak accumulates now.
- **Provenance hashes:** real SHA-256 values, generated by `scripts/engine-provenance.mjs` into `local-engines/producer/src/provenance.generated.mjs`.
  - `source_hash` covers the Pine source files; `implementation_hash` covers the engine files.
  - `test/engine-provenance.test.mjs` fails if they are stale.
  - Any change to an engine file is a new identity, which must earn approval again.
- **Endpoints:**
  - `POST /publish-local` (bearer `MARKET_DATA_INGEST_SECRET`, optional `?force=true`) triggers a publish manually.
  - `GET /local-computation/latest` shows the last publish result, including each engine's `trust_status` as returned by the AI Worker.

**Fusion fix shipped with this.** TradingView sends `candle_time` as `str.tostring(time)`, an epoch-ms string. `timestampMs` now accepts epoch ms/s strings and numbers. Before this fix, real webhooks failed candle-time validation, so the pipeline could never complete.
