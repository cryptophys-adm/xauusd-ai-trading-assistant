# RFC: a custom model from the platform's own knowledge (EA and XAUUSD Trading Assistant)

Status: accepted by the owner on 2026-11-13 ("setuju"); steps 1 and 2 are built (step 2 and the wide labels after "strengthen autonomous learning & knowledge looping"). Canonical state: `docs/SSOT.md`
("Custom model dataset"); open steps: `docs/BACKLOG.md` item 21.

## 0. Goal

Owner 2026-11-13: "Kekuatan utama system platform ini adalah auto learningnya dan knowledge mastering, end
goalnya mampu membuat custom model sendiri dari knowledge ini khusus untuk EA dan XAUUSD Trading
Assistant." The platform already measures itself: every room statement is scored, every decision is
followed to its outcome in R (Signal Ledger, on 1m bars), and Aether turns the record into knowledge and
tunes the weights. The missing piece is the bridge from that record to a model's weights.

## 1. Two models, in order

1. **A decision model for the EA**: a small numeric model, not a language model. Input: the numbers known at a 15m close (witness leans and weights, quorum, guardrail checks, the plan's reward and risk in ATR, structure, regime, session, calendar and news leans, cross assets, recent moves in ATR). Output: the probability that a long or a short from that close reaches its target before its stop. Exported as ONNX, which MQL5 runs natively, so the EA can use it on the terminal.
2. **A language model for the rooms and the Trading Assistant**: a LoRA fine-tune on the agents' scored statements (the right ones as examples, the wrong ones as negatives), served by Workers AI (bring-your-own LoRA on a supported base, rank up to 32, 300 MB). Later: it needs months of scored rooms.

## 2. Where it is trained (owner decision 2026-11-13)

| Step | Where | Why |
|---|---|---|
| Dataset (features, labels) | Cloudflare, the AI Worker (D1 `model_dataset`) | Point in time by construction, no data leaves the platform |
| Baseline model (logistic regression) | Cloudflare, in the Worker | Small enough for a Worker; the bar every other model must beat |
| Decision model (gradient-boosted trees, ONNX) | GitHub Actions in this repository (free) | Python ML libraries and ONNX export; Workers have no GPU and little memory |
| Language model (QLoRA) | Kaggle Notebooks (free GPU, about 30 hours a week) | Cloudflare offers no training; only the adapter is served by Workers AI |

The repository stays where it is: the owner makes it private again after the reset ("terkait repo tetap di
repo xauusd meski public ini sementara setelah reset akan dibuat private kembali"). **Until it is private,
no dataset row, feature table or model weight goes into a commit, a workflow log or a workflow artifact**:
a training workflow reads the rows from D1 through the Cloudflare API and writes the model back to
Cloudflare storage, and prints only aggregate metrics.

## 3. The dataset (step 1, built)

`src/model-dataset.mjs`, run by the Signal Ledger's 5-minute step:

- **One row per Decision Engine decision** (D1 `engine_decisions`, one per 15m close), the stored history included (backfilled 200 rows per run).
- **Features**: numbers only, from the stored decision record and the 15m bars up to its close, so nothing a decision could not have known. No price: distances are in the 15m ATR(14) at the close. Around a hundred features (`datasetFeatures`, `barFeatures`).
- **Labels**: for a long and a short from the decision bar's close, the first barrier touched on the bars after it (1m where the 1m series reaches): the target 1.5 ATR away (+1.5 R), the stop 1 ATR away (−1 R), or neither within 4 hours (expired, the move at the horizon in R); a bar touching both counts as the stop. The labels do not depend on the decision's stance, so a model can also learn when to wait. No spread: they measure the market, not an execution; the plan's own result (`r_tp1`, `r_omega` from the Signal Ledger) travels with the row where the decision traded.
- **Read**: `GET /api/model/dataset/summary` and `GET /api/model/dataset?since=&limit=` (labeled rows, paged; behind Cloudflare Access like every `/api` route).
- Switch `MODEL_DATASET_MODE` (`on` by default, `off` records nothing). It never feeds a room, a decision or Omega.

## 4. Promotion: the same referee as every other change

A model only advises until it has earned more:

1. **Shadow**: the model's probability is recorded next to each decision, never acted on.
2. **Verdict**: walk-forward only (trained on older rows, judged on newer ones), against the active Decision Engine and the baseline, on the same decisions: expectancy in R and hit rate, Holm-adjusted, with a held-out newest part (the shadow arena's rules, `src/shadow-versions.mjs`), at least 300 decisions.
3. **Connection, autonomous** (owner 2026-11-13: "buat agar autonomous"): the baseline connects itself to the council as advice (`context.model`) once its prospective record passes the gate (both sides, 300 decisions, paired Brier gain p < 0.05, AUC ≥ 0.55), and disconnects itself when it no longer does; the owner hears of each change. A weight in the quorum or a guardrail remains a later, owner-approved step.
4. **Retraining** on a schedule, each version judged again; a model that stops being better is retired automatically.

## 5. Risks and their guards

- **Leakage** (the most common failure): features only from the decision record and bars up to its close; labels only from bars after it; validation always forward in time.
- **Regime change**: retraining and the shadow verdict on the newest data; the baseline keeps the bar honest.
- **Small samples**: about 96 decisions a day; the first decision model needs some weeks (1000 to 2000 labeled rows), and Omega's real trades are far fewer, so the labels come from every decision, not only the trades.
- **A public repository**: §2.
- **Rooms state no price** and kernel reports carry none; the language model's data keeps that rule.

## 6. Steps

1. Dataset builder — built (this RFC's PR).
2. Baseline logistic regression in the Worker, retrained every hour, judged walk-forward and prospectively, recorded in shadow, reported to Aether — built.
3. Training workflow (GitHub Actions, LightGBM), stored in Cloudflare KV as compact trees the Worker evaluates, judged in shadow — built 2026-11-13 (`train-model.yml`). The ONNX export moves to step 4 with the EA (the ONNX converter's dependencies did not resolve cleanly on the pinned Python).
4. ONNX export of the decision model and the EA reads it (advice only until promoted).
5. LoRA for the language model on Kaggle, once the scored rooms suffice.
