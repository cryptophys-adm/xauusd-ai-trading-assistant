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
| **B‑08** | UI: Add mode selector dropdown, live metric panel, guardrail explainability in `GlobalDecision.tsx` | AGY | DONE | 5h |
| **B‑09** | Write mode‑specific unit tests and back‑testing scripts | AGY | DONE | 4h |
| **B‑10** | Update CI workflow to run the new tests | AGY | DONE | 1h |
| **B‑11** | Proposal: Global Decision as continuously tuned linear weighted model (issue #226) | AGY | TODO | 8h |
| **B‑12** | Proposal: Aether-governed Omega policy (issue #227) | AGY | DONE (2026-11-11: pack from Aether's doctrine, behind OMEGA_POLICY_AUTO, audit, Telegram, rollback after 50 trades) | 6h |
| **B‑13** | Progressive Stop Loss SL+ (issue #229) | AGY | DONE | 10h |
| **B‑14** | Make `dependency-audit` a required check on `main`: add it to `ops/branch-ruleset.json` and `test/branch-protection.test.mjs` in one PR, then the owner adds it to the "main protection" ruleset (Settings → Rules → Rulesets → Require status checks). The job already fails on a high or critical advisory and on an audit with no report; the 2026-11-16 report found 0 advisories. Owner 2026-11-16: "simpan dulu sebagai backlog". | Claude | TODO | 0.5h + owner click |
| **B‑15** | The standalone EA `ea/mt5/CryptophysXAUUSD.mq5` (v1.11) is not deployed: the VPS runs only the MT5 terminal with OmegaExecutor, and Omega runs every rule. If the standalone EA is ever used again, port the strategy exits first: `exit_side` (lean flip, close all its positions on that side) and `drop_ids` (close a winner whose decision's agent confidence dropped) in the signal, read by an EA v1.12. Owner 2026-11-16: "kita tidak pakai EA standalone". | Claude | PARKED | 3h |
| **B‑16** | ADR-0015 P2c (the room cell, `docs/RFC_ROOM_CELLS.md`): parked. After P2b, D1 reads are down about 98% (about 50 k rows per market day); P2c would only cut about 3,000-3,800 message writes a day, far inside D1's included rows, while it moves every room into a Durable Object on the live decision path. The hourly budget check (`callsInLastHour`) was measured on 2026-11-16: 266 rows read per call, about 40 k a day; an index for it would add a write to every message, which costs more than the reads it saves, so it is left as it is. Owner 2026-11-16: "opsi A" (take the cheap win and park P2c); the measurement showed there is no cheap win to take. | Claude | PARKED | P2c 3-4 PRs |

---

## Sprint Plan (Day‑1)
1. Implement **B‑01** and **B‑02** (environment var, adaptive thresholds).
2. Add **B‑03** (decay weighting).
3. Commit & push.

Further items will follow in subsequent sprints.