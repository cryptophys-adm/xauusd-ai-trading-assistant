# Architecture Baseline — Evidence Fusion and AI Decision Support

- Status: **Approved direction / implementation not yet complete**
- Baseline date: 2026-11-01
- Scope: `cryptophys-adm/xauusd-ai-trading-assistant`
- This document supersedes earlier proposals for a per-timeframe CTA Worker fleet.

## 1. Architectural decision

The canonical convergence point is **Evidence Fusion & Orchestration**, a logical layer inside the existing `xauusd-ai-trading-assistant` Worker unless measurement later proves a separate Worker is necessary. It sits after source ingestion and deterministic local calculations, and before the Analyst/Counselor/Reasoner stages.

It must combine and validate:
1. TradingView webhook evidence (currently Prophet R38, Prophet R37 SSOT, and GMI v12.70).
2. Fundamental news evidence from `xauusd-fundamental-news-ingestion`, including the timestamped output of news analysis when available.
3. Deterministic local calculation outputs (Mizan, Prophet, GMI) for the same symbol/timeframe/candle context.

The existing code's `runAnalysis()` is the nearest implementation seam. Its current webhook gate requires the three configured webhook sources for one `candle_key`; it fetches news evidence and then calls Analyst → Counselor → Reasoner. That is a foundation, **not proof that local calculation outputs or the completed standalone news-analysis output are already integrated**.

## 2. Target logical topology

The target has eight logical responsibilities. This is not a mandate to deploy eight separate physical Workers; consolidate where supported by CPU, quotas, isolation, and operational evidence. No container is part of the baseline.

1. **TradingView Pull Adapter** — TypeScript Worker/client; use only verified MCP/data-tool capabilities and documented response contracts.
2. **Pull Orchestrator** — TypeScript; schedule or request pulls, enforce bounded retries and budget/cooldown rules.
3. **Market Data Normalizer** — normalize symbols, timeframe identifiers, timestamps, candle boundaries, numeric fields, and source metadata.
4. **Mizan Calculation Engine** — deterministic calculations; Rust/WASM is a candidate only after parity and runtime-budget tests.
5. **Prophet Calculation Engine** — deterministic calculations and signal features; preserve Pine source behavior where reproducible.
6. **GMI Calculation Engine** — deterministic calculations and signal features; preserve Pine source behavior where reproducible.
7. **Evidence Fusion & Data-Request Controller** — canonical convergence point; validate provenance, freshness, completeness, same-candle identity, conflicts, and data-request policy.
8. **AI Engine** — the existing `xauusd-ai-trading-assistant` Worker and its Analyst → Counselor → Reasoner chain, with existing resource bindings preserved.

The existing `xauusd-fundamental-news-ingestion` Worker remains an upstream producer/service and is not a reason to recreate the deprecated timeframe-worker fleet.

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
