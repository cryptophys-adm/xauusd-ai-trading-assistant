# Architecture Baseline — Evidence Fusion and AI Decision Support

- Status: **Approved direction / implementation not yet complete**
- Baseline date: 2026-11-01
- Scope: `cryptophys-adm/xauusd-ai-trading-assistant`
- This document supersedes earlier proposals for a per-timeframe CTA Worker fleet.

## 1. Architectural decision

The canonical convergence point is **Confluence & Data-Request Controller**, deployed as core Worker #7, `xauusd-confluence-controller`. It validates and fuses evidence after source ingestion/normalization and deterministic local calculations, then passes a versioned evidence bundle to core Worker #8, the existing `xauusd-ai-trading-assistant`, for Analyst → Counselor → Reasoner. The AI Worker keeps its existing bindings and model contract; it does not replace the Confluence Controller.

It must combine and validate:
1. TradingView webhook evidence (currently Prophet R38, Prophet R37 SSOT, and GMI v12.70).
2. Fundamental news evidence from `xauusd-fundamental-news-ingestion`, including the timestamped output of news analysis when available.
3. Deterministic local calculation outputs (Mizan, Prophet, GMI) for the same symbol/timeframe/candle context.

**Implementation gap:** the current feature branch still implements the initial evidence-fusion receiver within `xauusd-ai-trading-assistant`. The target topology places canonical fusion in the separate `xauusd-confluence-controller` Worker and sends its validated bundle to the AI Worker. This physical boundary and authenticated handoff remain to be implemented; do not treat the target topology as deployed.

The existing code's `runAnalysis()` is the nearest implementation seam. Its current webhook gate requires the three configured webhook sources for one `candle_key`; it fetches news evidence and then calls Analyst → Counselor → Reasoner. That is a foundation, **not proof that local calculation outputs or the completed standalone news-analysis output are already integrated**.

## 2. Target logical topology

The target has **eight core physical Workers plus one separate news-ingestion Worker: nine physical Workers total**. The eight numbered core responsibilities below map one-to-one to eight core Worker deployments; `xauusd-fundamental-news-ingestion` is retained separately as an upstream producer. No container is part of the baseline.

1. **TradingView Pull Adapter** — TypeScript Worker/client; use only verified MCP/data-tool capabilities and documented response contracts.
2. **Pull Orchestrator** — TypeScript; schedule or request pulls, enforce bounded retries and budget/cooldown rules.
3. **Market Data Normalizer** — normalize symbols, timeframe identifiers, timestamps, candle boundaries, numeric fields, and source metadata.
4. **Mizan Calculation Engine** — deterministic calculations; Rust/WASM is a candidate only after parity and runtime-budget tests.
5. **Prophet Calculation Engine** — deterministic calculations and signal features; preserve Pine source behavior where reproducible.
6. **GMI Calculation Engine** — deterministic calculations and signal features; preserve Pine source behavior where reproducible.
7. **Evidence Fusion & Data-Request Controller** — canonical convergence point; validate provenance, freshness, completeness, same-candle identity, conflicts, and data-request policy.
8. **AI Engine** — the existing `xauusd-ai-trading-assistant` Worker and its Analyst → Counselor → Reasoner chain, with existing resource bindings preserved.

The existing `xauusd-fundamental-news-ingestion` Worker remains a separate ninth physical Worker and upstream producer/service; it is not counted among the eight core Workers. Do not recreate the deprecated timeframe-worker fleet.

## 3. Explicit physical Worker count and deployment topology

**Target: 9 physical Cloudflare Workers total = 8 core Workers + 1 separate news-ingestion Worker.** Existing deployments retained: `xauusd-fundamental-news-ingestion` and `xauusd-ai-trading-assistant`. The other seven core Workers are planned and must not be described as deployed until their own release gates pass.

| Core # | Physical Worker | Status | Responsibilities |
|---|---|---|---|
| 1 | `xauusd-tradingview-pull-adapter` | Planned | TradingView/data-source adapter; only documented and verified data capabilities may be used. |
| 2 | `xauusd-pull-orchestrator` | Planned | Closed-candle scheduling, pull coordination, bounded retries, cooldowns and quota budgets. |
| 3 | `xauusd-market-data-normalizer` | Planned | Canonical symbols/timeframes/timestamps, candle boundaries, numeric validation and provenance. |
| 4 | `xauusd-mizan-engine` | Planned | Deterministic MizanLib calculations; source/version and parity evidence required. |
| 5 | `xauusd-prophet-engine` | Planned | Deterministic Prophet calculations; exact source/version and parity evidence required. |
| 6 | `xauusd-gmi-engine` | Planned | Deterministic GMI calculations; exact source/version and parity evidence required. |
| 7 | `xauusd-confluence-controller` | Planned | Canonical evidence fusion, freshness/completeness/provenance/conflict checks, and bounded additional-data requests. |
| 8 | `xauusd-ai-trading-assistant` | Existing production | AI Engine: preserves `AI`, `DB`, `SIGNAL_CACHE`, `WEBHOOK_BUFFER`, `KNOWLEDGE_BASE`, model variables, `REQUIRED_SOURCES`, and Analyst → Counselor → Reasoner. |
| Separate | `xauusd-fundamental-news-ingestion` (role: **TradingView MCP gateway**) | Existing production | Single owner of the TradingView MCP OAuth grant and account-wide quota cooldown. Serves fundamental news (HTTP `/pull` + hourly cron) and OHLCV for local engines (RPC entrypoint `TvGateway`). The name is historical and kept for OAuth redirect, secret and binding continuity. It remains outside the eight core Workers. |

Thus the target is **8 core Workers + 1 news Worker = 9 physical Workers**. The AI Engine and news-ingestion Worker must remain deployed; their names and existing production bindings/resources are not to be replaced. Evidence fusion is a separate core Worker (#7), while the existing AI Worker consumes its validated evidence bundle. No containers and no deprecated per-timeframe Worker fleet.

The market-data adapter must not be enabled until source/API/MCP capabilities, authentication, fields, quotas and failure behavior are verified. The three calculation Workers must not claim Pine parity until exact source baselines and feature-level fixtures pass. Every planned Worker requires preview acceptance, resource/secret/quota inventory, health/readiness checks, rollback target and recorded acceptance evidence before production deployment. Do not silently reduce the physical count or combine the eight core deployments without a reviewed architecture decision.

## 3. Required processing order

```text
TradingView webhooks ─┐
News ingestion +      ├─> Normalize and validate source records
news analysis ────────┤                 |
Local Mizan/Prophet/  ┘                 v
GMI calculations                Evidence Fusion
                                        |
                         completeness/freshness/provenance gate
                               |                    |
                           valid set            missing/stale/conflict
                               |                    |
                               v                    v
                            Analyst       hold / request permitted data /
                               |           record explicit evidence gap
                               v
                            Counselor
                               |
                               v
                         Reasoner / Decision
                               |
                     D1 + KV + advisory notification
```

Counselor must receive the validated fused evidence bundle and Analyst output. Reasoner receives the same evidence bundle plus Analyst and Counselor outputs. A missing or invalid required input must never be silently represented as a neutral fact or invented by a model.

## 4. Evidence contract

Every source record should carry, where applicable:
- `schema_version`
- `source` and `source_version`
- canonical `symbol` / `ticker`
- canonical `timeframe`
- `candle_open_time`, `candle_close_time`, and `received_at` in UTC
- `candle_key` / deterministic correlation key
- `status` (valid, stale, incomplete, rejected, or unavailable)
- typed data/metrics, units, and calculation parameters
- provenance/reference to original payload or content hash
- calculation engine version and parity-test version for local outputs

Use a stable correlation key derived from symbol, timeframe, and candle-close time. Do not merge different candles merely because their source names match. Idempotency must be enforced at persistence and orchestration boundaries.

## 5. Fusion gate rules

Before AI analysis:
1. Validate payload schema and allowed source.
2. Normalize symbol/timeframe/time; reject ambiguous or malformed identifiers.
3. Match all candle-based evidence to the same canonical candle context.
4. Apply explicit, configurable freshness policies separately for market data and news.
5. Verify required sources and calculation results are present; preserve partial evidence with explicit status when policy permits it.
6. Detect contradictory values and source-version mismatches.
7. Record data provenance, validation results, missing inputs, and correlation ID.
8. If a mandatory source is missing, stale, invalid, or mismatched, do not produce a normal actionable-looking decision. Return a bounded wait/degraded state and explain the evidence gap.
9. Any additional data pull must be authorized by policy, bounded by retry/quotas, and auditable.

## 6. AI stage responsibilities

- **Analyst:** classify supplied evidence only; never manufacture missing market/news values.
- **Counselor:** reason over the full fused evidence and Analyst output; produce bullish, bearish, and neutral scenarios, confirmations, invalidations, risks, and missing data.
- **Reasoner:** produce the final advisory decision from the fused evidence and both prior outputs. Exact entry/SL/TP values must be null when verified price evidence is absent.
- Output is decision support only. No broker integration or automatic trade execution.

## 7. Binding and resource compatibility

Preserve the existing production bindings unless a separately reviewed migration authorizes a change:
- Workers AI: `AI`
- D1: `DB` → `xauusd-signals`
- KV: `SIGNAL_CACHE`, `WEBHOOK_BUFFER`, `KNOWLEDGE_BASE`
- model vars: `AI_MODEL_ANALYST`, `AI_MODEL_COUNSELOR`, `AI_MODEL_REASONER`
- `REQUIRED_SOURCES`, `INGEST_URL`
- secrets remain in Cloudflare secret storage and must never be committed or logged.

Do not recreate existing Cloudflare resources. Keep preview resources isolated from production. Do not silently add paid services or assume Free-tier eligibility; verify current quotas, model availability, and actual usage before rollout.

## 8. Language policy

- TypeScript: Workers, HTTP/API contracts, normalization, orchestration, fusion, persistence.
- Rust/WASM: candidate for deterministic calculation kernels only if Pine parity, Worker compatibility, artifact size, CPU, and memory tests pass.
- Python: research, fixtures, numerical reference implementation, backtesting, and CI parity tooling; not automatically a production runtime.
- Go: optional only when a measured requirement justifies it.
- Polyglot is permitted; architectural complexity must be justified by measured correctness/performance, not language preference.

## 9. Known constraints and unresolved verification

- A successful news MCP call does not prove market OHLCV, quote, intrabar, footprint, volume-profile, or macro-symbol access is supported.
- Pine features that require lower-timeframe arrays, footprint/order-flow internals, or unavailable external symbols may not be reproducible from OHLCV alone. Mark unsupported features explicitly; do not claim parity.
- Confirm the exact Pine source versions and import versions before coding.
- The deployed Worker and its bindings are confirmed by Cloudflare inventory, but this does not prove end-to-end health, valid secrets, real webhook delivery, model success, or final production readiness.

## 10. Change control

This is the baseline for future deployment plans and implementation. Do not restore the deprecated per-timeframe CTA Worker fleet. Do not alter the eight logical responsibilities, AI stage order, resource-binding contract, no-container constraint, or advisory-only behavior without a documented decision and explicit approval. Implementation changes must be delivered through reviewable branches/PRs and validated in preview before production rollout.
