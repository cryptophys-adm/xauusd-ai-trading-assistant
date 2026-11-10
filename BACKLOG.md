# Backlog – XAUUSD Trading Assistant Improvements

## Epic: Adaptive Multi‑Horizon Trading
- **Goal:** Provide robust, mode‑aware behavior for scalp, intraday, and swing strategies.
- **Milestones:**
  1. Mode selector & environment configuration
  2. Adaptive guardrail thresholds per mode
  3. Decay‑weighted quorum for intraday
  4. Micro‑grid / order‑book feed for scalp
  5. Macro‑event scorer & composite sentiment for swing
  6. UI enhancements (mode switch, live metrics, guardrail explainability)
  7. Tests & back‑testing per horizon
  8. Documentation & release

---

## Backlog Items

| ID | Description | Owner | Status | Estimate |
|----|-------------|-------|--------|----------|
| **B‑01** | Add `env.TRADING_MODE` env var (scalp|intraday|swing) and expose via config | AGY | DONE | 2h |
| **B‑02** | Refactor `guardrailsFor` to use adaptive thresholds (`QUORUM_MIN`, `MIN_RRR`, `LEAN`) based on `TRADING_MODE` | AGY | DONE | 3h |
| **B‑03** | Implement decay weighting for quorum shares (time‑decay factor) | AGY | DONE | 2h |
| **B‑04** | Create micro‑grid / order‑book producer (`src/producer/m5-orderbook.mjs`) and feed `order_imbalance` into `liveM5Inputs` | AGY | DONE | 4h |
| **B‑05** | Add macro‑event scorer – event‑impact JSON + `compositeSentiment` helper | AGY | DONE | 3h |
| **B‑06** | Update `riskChecks` to use composite sentiment and macro score for swing mode | AGY | DONE | 2h |
| **B‑07** | Make blackout window configurable (`env.BLACKOUT_MINUTES`) and replace hard‑coded values | AGY | DONE | 1h |
| **B‑08** | UI: Add mode selector dropdown, live metric panel, guardrail explainability in `GlobalDecision.tsx` | AGY | TODO | 5h |
| **B‑09** | Write mode‑specific unit tests and back‑testing scripts | AGY | DONE | 4h |
| **B‑10** | Update CI workflow to run the new tests | AGY | DONE | 1h |

---

## Sprint Plan (Day‑1)
1. Implement **B‑01** and **B‑02** (environment var, adaptive thresholds).
2. Add **B‑03** (decay weighting).
3. Commit & push.

Further items will follow in subsequent sprints.