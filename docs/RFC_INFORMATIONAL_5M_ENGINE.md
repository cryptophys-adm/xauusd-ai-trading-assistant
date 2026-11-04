# RFC — Informational (non-trusted) 5m engine in evidence bundle

Status: **Proposal / not implemented**. Requires owner approval before code changes.
Canonical references: `docs/SSOT.md`, `AGENTS.md`, `docs/MULTI_AGENT_BUS.md`.

## 1. Motivation
Surface 5m technical context inside the AI evidence bundle without polluting the trusted
`local_computation` lane, which requires a 24-match parity streak against a webhook
comparator that does not exist for 5m.

## 2. Proposed design
- Add a new **informational** evidence key `informational_5m_context` to the fusion bundle.
- Populated from the existing 5m OHLCV bundle (already fetched) via
  `local-engines/producer/src/m5-producer.mjs` (`buildM5ProphetContext`).
- Marked `trust_status: "informational_unverified"`; excluded from `fusion.complete` gate
  (i.e. missing 5m context never degrades the decision).
- Analyst/Counselor/Reasoner prompts mention it as context only, never as trusted evidence.
- No change to `LOCAL_ENGINES`, `localcalc-*` KV layout, parity registry, or webhook lanes.
- No new Worker or binding.

## 3. Constraints
- Advisory only; no broker/execution.
- Do not edit `pinescript/ssot/*`.
- Do not recreate removed Workers; keep 4-Worker topology.
- 5m context must never influence entry/SL/TP or confidence directly.
- Trust remains H1-only via autonomous parity registry.

## 4. Open questions
- Should 5m context be fetched in `runAnalysis` (AI Worker) or passed from the pull adapter?
- Cache TTL for 5m context in the bundle.
- Whether to include GMI 5m (currently only Prophet R38).

## 5. Non-goals
- No trusted 5m evidence, no parity for 5m, no change to decision cadence (H1).

## 6. Next steps if approved
1. Add `informational_5m_context` to `buildEvidenceFusion` + tests.
2. Update Analyst/Counselor/Reasoner prompts.
3. Update `docs/SSOT.md` (lane description) + `docs/CHANGELOG.md`.
