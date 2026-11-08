# RFC: Aether, the Knowledge Guardian cluster (decision audit, master and learned knowledge, self-calibration)

- **Status:** Draft for owner review, revision 2 (owner direction 2026-11-07: Aether as a separate cluster with its own Worker connected to the kernel, its own master knowledge, and a decision on where its Vectorize lives). Section 0 states the revision; where it differs from later sections, section 0 wins. Design only: no code, no migration, no binding and no deploy follows from this document.
- **Date:** 2026-11-07
- **Author:** Claude (orchestrator)
- **Repositories:** `xauusd-ai-trading-assistant` (this repo, "Nexus") and `cryptophys-adm/cryptophys-cloud-platform` (the platform, read-only for this RFC).
- **Owner request (translated):** "The next worker to consider relates to Vectorize and an agent whose job is to audit decisions and update them as knowledge, so Nexus gains self-calibration with continuously growing knowledge, and does self auto-tuning of parameters to improve agent accuracy and ensure agents comply with their role and the master knowledge. This needs integration with the cryptophys-cloud-platform repo."
- **Builds on:** `docs/SSOT.md` (§2, §3 "Outcome scoring", "Crowd line, reputation", "Shadow indicator versions", §4), `docs/RFC_INDICATOR_AGENT_PLATFORM.md` (§4.3, §6, §9 P3–P5, §10), `docs/KNOWLEDGE_BASE_V4.md`; platform ADR-0007, ADR-0009, TP-007, TP-008, TP-017, `docs/XAUUSD-INTEGRATION.md`.

---


## 0. Revision 2 (owner direction 2026-11-07): Aether, a separate cluster

**Owner direction:** "The Knowledge Guardian must be a cluster separate from `xauusd-ai-trading-assistant`, with its own engine Worker connected to the kernel, named **Aether** (cosmic wisdom). It has its own master knowledge. Check whether its Vectorize joins the cryptophys cloud platform or is separate, to tell the state machine apart from the state market."

### 0.1 What changes against revision 1

| Topic | Revision 1 | Revision 2 (this) |
|---|---|---|
| Where the auditor runs | A kernel-hosted Durable Object inside `cryptophys-ai-kernel` | Its own Worker, **`cryptophys-aether`**, a separate cluster in the AI Mesh (agents grouped by `host_worker`, like `xauusd · 21`) |
| Repository | The platform repository | A **new repository, `cryptophys-adm/cryptophys-aether`** (recommended). This keeps the xauusd four-Worker rule (AGENTS.md rule 3) and the platform's control-plane scope unchanged. Owner decision A1; the owner creates the repository |
| Connection to the kernel | Kernel-internal | The same pattern as xauusd: one RPC Service Binding to the kernel's `AgentRpc` entrypoint, `props = { host_worker = "cryptophys-aether" }`, tier ≤ 1, no secret (`workers/ai-kernel/src/agent-rpc.ts`) |
| Review of knowledge items | A Console review queue to be built | The kernel's existing **tier 1 "propose"**: an Aether agent drafts, and only a person approves it in the Console (ADR-0007, separation of duties) |
| Master knowledge | KB v4 stays the only master | **Aether Canon**, Aether's own master knowledge (§0.4). KB v4 is imported into it, pinned by hash, never edited |
| Vectorize | A new index on the kernel | **Separate indexes owned by the Aether Worker**, not joined with the kernel's `cryptophys-agent-memory` (§0.3) |
| AI budget | The kernel's 40 requests a day | Aether's own `AI` binding and its own daily budget, counted apart from the kernel and the xauusd rooms |

Everything else carries over unchanged: the hard constraints (§3), the decision cards without levels (§6.1), shadow testing and promotion by owner PR in the xauusd repository (§9), deterministic retrieval into rooms (§10), safety (§11) and metrics (§13).

### 0.2 State machine vs state market

| | State machine | State market |
|---|---|---|
| What it is | The state of the system itself: Workers, deployments, drift, agent status and suspensions, approvals, budgets, the audit chain | The market and the system's judgements about it: bars, room conclusions, H1 decisions, outcomes, regimes, stuck states, shadow verdicts, knowledge |
| Owner | The platform: `cryptophys-ai-kernel` and the control-plane Workers, D1 `cryptophys-control-plane` | Live data: `xauusd-ai-trading-assistant`. Memory and knowledge: **Aether** |
| Memory | Kernel Vectorize `cryptophys-agent-memory`: per-agent episodic memory, metadata `agent_id`, 90-day pruning | Aether Vectorize (§0.3): shared market knowledge, metadata chart, regime, session, outcome, canon version |
| Who may change it | Kernel syscalls, tiers, Policy Engine, people | Aether proposes; a person approves; the xauusd repository adopts by PR |
| Crossing between them | Aether **reports** to the kernel (findings, digests, `info`/`warning`, never `critical`) and **asks** for approvals (tier 1). Aether never writes control-plane state. The kernel never writes market knowledge. | |

### 0.3 Vectorize: separate, not joined with the platform (recommended)

**Recommendation:** Aether owns its own Vectorize indexes, bound only to `cryptophys-aether`, in the same Cloudflare account. Not the kernel's index, and not a shared one.

| Reason | Detail |
|---|---|
| Different state | The kernel index holds the **state machine** (what each agent did and saw while operating the platform). Aether's holds the **state market**. Mixed, a similarity search for "a bull trap held for 8 hours" could return a deployment incident, and the reverse. |
| Different schema | Vectorize filters only on metadata indexes created before the first insert, at most 10 per index. The kernel index has one (`agent_id`); Aether needs chart, regime, session, outcome, kind, status, day and canon. |
| Different lifecycle | Kernel memories are pruned at 90 days. Canon chunks live until the canon changes; learned items are kept with their history; decisions are kept 120 days. |
| Ownership and recovery | The platform register requires one owner, purpose, classification and recovery plan per resource (`architecture/RESOURCE-OWNERSHIP.md`); D1 is service-scoped (ADR-0003). One owner per index keeps that simple, and an index can be rebuilt from its own D1 ledger. |
| Blast radius and budget | A bad ingestion or a re-embed in Aether cannot touch platform memory, and Aether's embeddings do not consume the kernel's 40-a-day budget. |
| What stays shared | The kernel (identity, tiers, Policy Engine, approvals, audit chain, kill switch) and the Cloudflare account. These are the state machine, which Aether uses rather than duplicates. |

**Indexes (both 384 dimensions, cosine, `@cf/baai/bge-small-en-v1.5`, as on the platform):**
- **`aether-canon`**: the master knowledge chunks only (§0.4), one set per canon version; read-only between canon releases. It is kept apart so a canon lookup can never return a learned or episodic text.
- **`aether-market`**: namespaces `decision`, `episode`, `finding`, `learned` (§5.3). Its metadata indexes are created before the first insert.
- **D1 `aether-knowledge`**: the source of truth. It holds cards, findings, the knowledge ledger, canon versions and costs. Each index can be rebuilt from it.

### 0.4 Aether Canon: Aether's own master knowledge

| Layer | Content | Changed by |
|---|---|---|
| **Canon** (master) | 1. **Indicator canon:** KB v4 imported verbatim with its Pine line citations, pinned to its `content_sha256`. A new KB version is imported, never edited in Aether. 2. **Doctrine:** the owner rules in force (advisory only, no confirmation no entry, support rules, crowd rules, fail-closed WAIT), with their source document and date. 3. **Roles:** each agent's role from the manifests (`src/indicator-manifests.mjs`) and room prompts, as the compliance reference. 4. **Definitions:** the scoring definition v3, the stuck-state thresholds and the shadow criteria, as fixed yardsticks. | A reviewed PR in `cryptophys-aether` only. Every canon release has a version and hash; agents and cards record which canon they saw. |
| **Learned** | Measured patterns with provenance (§8) | Propose, then a person approves (tier 1), then shadow-tested, then promoted by an owner PR in xauusd. Labelled "learned", never presented as canon. |

The Guardian's compliance checks compare each agent's output with **its role and the doctrine** (canon), not with learned items.

### 0.5 Aether's agents (one cluster, `host_worker = "cryptophys-aether"`, tier ≤ 1)

| Agent | Role | Tier |
|---|---|---|
| `aether-auditor` | Reads the decision cards, embeds them, finds repeated failures and situations where agents are wrong | 0 (observe, report) |
| `aether-guardian` | Compliance: the agent's role and the doctrine against what the agent said; deterministic checks first, a model judge on a sample | 0 |
| `aether-curator` | The knowledge ledger: drafts candidate items, deduplicates them, expires them, exports the approved pack | 1 (propose; a person approves) |
| `aether-calibrator` | Parameter candidates within the reviewed grid; follows their shadow verdicts | 1 (propose) |

They are registered on the platform like the xauusd agents (a migration in the platform repository: the platform task that adds the `cryptophys-aether` host).

### 0.6 Bindings and data flow (RPC Service Bindings only, no secret)

```
xauusd AI Worker --(service binding AETHER, entrypoint KnowledgeIngress)--> cryptophys-aether
   push: decision cards (no levels), compliance rows, shadow verdicts      |  D1 aether-knowledge
   pull: the approved learned pack (for the owner's PR), canon version      |  Vectorize aether-canon, aether-market
                                                                          |  Workers AI (own budget)
cryptophys-aether --(service binding AGENTS -> ai-kernel AgentRpc, host_worker=cryptophys-aether)--> kernel
   reports.publish (info/warning), tier 1 drafts for approval, whoami
```

- **Direction:** xauusd depends on Aether, but Aether never binds into xauusd and never writes to it. That keeps the xauusd "no reverse access" rule and avoids the inbound read RPC of revision 1 (O3 is replaced by A3).
- **In xauusd:** the change is one new outbound binding (`AETHER`), which is a topology change: SSOT §2, AGENTS.md and the topology test, with owner approval. The sweep pushes the cards; it never waits on Aether, and a failure is non-fatal.

### 0.7 Phases (revision 2)

| Phase | Repository | Content |
|---|---|---|
| A0 | xauusd (docs) | This RFC; owner decisions A1 to A6 and O5 to O13 |
| A1 | xauusd | Compliance checks (K1) and the decision-card builder (K2, without `AuditReadRpc`). **Shipped 2026-11-07** (`src/compliance.mjs`, `src/decision-cards.mjs`). |
| A2 | **cryptophys-aether** (new) | Worker skeleton, D1 `aether-knowledge`, `KnowledgeIngress` entrypoint, Canon v1 (KB v4 import, doctrine, roles, definitions), CI, tests, dry-run deploy |
| A3 | platform | Register the `cryptophys-aether` host and its four agents (migration), the report kind `knowledge_audit`, the resource-register rows |
| A4 | cryptophys-aether | Indexes `aether-canon` and `aether-market` (ensure script, metadata indexes first), batched embedding, auditor and guardian loops, kernel reports |
| A5 | xauusd | The `AETHER` binding (topology change) and the push from the sweep. **Shipped 2026-11-07** (`src/aether-push.mjs`). |
| A6 | cryptophys-aether + platform | Curator and calibrator, tier 1 proposals, the approved pack export. **Shipped 2026-11-07** (platform TP-028, `cryptophys-aether` `src/knowledge.mjs`). |
| A7–A9 | xauusd | Shadow knowledge arm, tuning grid, bundled learned pack, first promotion PR (K6 to K9). **A7 first part shipped 2026-11-07:** the pack pull and approved parameter candidates as shadow versions (`src/aether-pack.mjs`). The shadow arm for text items (model calls, A/A run) follows once an item is approved. **A8 first part shipped 2026-11-08:** Holm–Bonferroni per family per month, the 100-bar holdout and `GET /api/tuning` (`src/tuning.mjs`, K7). Grid points start only through approval in Aether or a reviewed PR, which is stricter than O6's automatic scheduler. **A8 part 2:** `src/tuning-replay.mjs` replays the reputation parameters of the crowd line (`replays.crowd` in `/api/tuning`). The strategy-threshold replay needs the strategy inputs of each hour (room openings, HUD snapshots, bars), which are not stored today. Storing them in D1 is an owner decision before that arm. |

### 0.8 Owner decisions for revision 2

1. **A1 Repository:** a new repository `cryptophys-adm/cryptophys-aether` (recommended), or a Worker inside the platform repository (`workers/aether`). Only the owner can create a repository.
2. **A2 Vectorize:** separate Aether indexes (recommended), or one shared index on the platform.
3. **A3 xauusd topology:** add one outbound binding `AETHER` to the AI Worker (push cards, pull the pack).
4. **A4 Canon scope:** the four parts of §0.4 (indicator canon, doctrine, roles, definitions).
5. **A5 Agents:** the four Aether agents of §0.5 and their tiers.
6. **A6 Budget:** Aether's own daily AI budget (proposed: 60 requests a day, embeddings batched).

---

## 1. Summary

One new agent, the **Decision Auditor**, runs inside the existing platform AI Kernel (`cryptophys-ai-kernel`, a Durable Object like `auditor`). It reads deterministic decision records from this repository, stores them in a new Vectorize index, finds repeated failures and role or rule violations, and **proposes** two kinds of improvement: learned knowledge items and parameter candidates. Every proposal is then reviewed by a person, tested in shadow here (outcome scoring with a significance test), and promoted only by an owner-approved PR in this repository.

"Self-calibration" therefore means: the system measures itself, proposes, and tests automatically; the owner promotes. No new Worker is created in either repository.

## 2. Goals and non-goals

### Goals
1. **Audit every decision** of the rooms (15m, 1H, 4H, D1), the H1 Reasoner and the indicator agents against its outcome, its agent's role and the master knowledge.
2. **Grow knowledge with provenance.** Repeated, measured patterns become *learned knowledge items*: versioned, citing the decisions and outcome scores behind them, reviewable and reversible.
3. **Tune by proposal.** Generate parameter candidates within declared bounds and test them in shadow, using the existing P3 comparison (`src/shadow-versions.mjs`).
4. **Compliance.** Measure, per agent, how often it breaks its role (manifest), the owner rules and the master knowledge, and turn repeated violations into findings.
5. **Retrieval into rooms**, after promotion only: small, labelled, situation-matched notes, with a hard token budget.

### Non-goals
- No automatic promotion of anything: not a parameter, not a knowledge item, not a prompt change.
- No change to the parity registry, the hashed engines, `pinescript/ssot/*` or KB v4 content.
- No new Worker, no change to the four-Worker topology (`docs/SSOT.md` §1, AGENTS.md rule 3).
- No order, broker, size or level anywhere in this loop.
- The auditor never edits this repository, never writes to its D1/KV and never deploys it.

## 3. Hard constraints and how the design complies

| # | Constraint | How this design complies |
|---|---|---|
| 1 | **Advisory only.** No broker, orders, position size; no levels in kernel reports. | Decision cards sent to the platform strip `entry_price`, `stop_loss`, `take_profit`, `trade_plan`, strategy plan, key levels and every absolute price; excursions are sent in ATR units only (§6.1). The platform's `PROHIBITED_CAPABILITY` and advisory-language guard apply to every draft. Knowledge items are validated to contain no price, size or order wording (§8.3). |
| 2 | **Never edit `pinescript/ssot/*` or hashed engines;** trust only from 24/24 parity; never mark verified by hand. | Engine candidates pass different parameters to the existing pure functions, exactly as P3 does (`src/shadow-versions.mjs` header); no hashed file changes. Parity rules are in the "never tuned" list (§9.1). No item or report can set a parity status; the auditor only reads `engine_parity_registry`. |
| 3 | **Promotion is never automatic;** shadow + outcome scoring + significance test + separate owner PR. | Every candidate (parameter or knowledge) goes through shadow and the sign test (`signTestP`, p < 0.05, ≥ 200 bars, ≥ 30 decisive pairs), plus a multiple-testing correction and a fresh holdout (§9.3). Promotion is a PR the owner approves in this repository. The platform's consensus autonomy (ADR-0009) cannot reach it: ADR-0009 already says XAUUSD agents never vote and XAUUSD Workers are never deployed by consensus, and the new capabilities are not consensus actions. |
| 4 | **RPC Service Bindings only;** no shared secrets; `AGENTS` never sends `critical`; denials final. | Platform → here: a new read-only `AuditReadRpc` WorkerEntrypoint (§7.1). Here → platform: the existing `AGENTS` binding, unchanged (`props.host_worker`), one new tier-0 call. No secret anywhere. Nothing here sends `critical`; the kernel-hosted auditor uses `info`/`warning` only for market findings. A denial is recorded and not retried; the agent id is fixed (§7.3). |
| 5 | **Auditable, reversible knowledge;** provenance, version, rollback; no unreviewed self-generated claims fed as facts; master vs learned. | Items live in an append-only ledger with provenance (decision ids, outcome score ids, finding id, KB hash, scoring version), a version and a content hash (§8). A person approves before an item is even shadow-tested; agents in production read only items bundled by a merged PR, labelled "learned" (§10). KB v4 stays the only master knowledge, changed only by regeneration from Pine (`docs/KNOWLEDGE_BASE_V4.md`). Learned items may only state measured outcomes; they may never redefine a field. |

## 4. Current state

### 4.1 This repository (what the loop builds on)

| Piece | Where | State |
|---|---|---|
| Outcome scoring v3 (horizon 4, 0.5 × ATR, WAIT 2:1 rule), Brier, sessions | `src/outcome-scoring.mjs`, D1 `outcome_scores`, `outcome_runs` | Live. Subjects `chain:h1`, `agent:<id>` (15m, 1H rooms), `hud:*`, `indicator:*`, `shadow:*`. |
| Stuck-state detector (8 candles, > 3 × ATR) | same, D1 `stuck_states` | Live; feeds caution flags (`stuckCautions` in `src/reputation.mjs`). |
| Reputation and crowd line | `src/reputation.mjs` | Live: shrinkage prior 10, weight 0.25–2, 30 days, neutral band 0.1. Fed to moderators and the H1 Reasoner. |
| Shadow versions and comparison | `src/shadow-versions.mjs`, D1 `shadow_outputs` | Live: controls, candidates, like-for-like bars, exact sign test, `SHADOW_MIN_SAMPLE` 200, `REVIEW_MIN_DECISIVE_PAIRS` 30, verdict "ready for owner review". |
| Manifests and registry | `src/indicator-manifests.mjs`, `src/indicator-registry.mjs`, `GET /api/indicator-agents` | Live: role, family, Pine section, reference, rooms, scored subjects per agent. This is the "role" the compliance check uses. |
| Parity registry | `src/parity-registry.mjs` | Live: 24 consecutive matches approve, any mismatch revokes. Read-only for this RFC. |
| Master knowledge KB v4 | `knowledge/kb-v4.mjs` → `src/knowledge-base.generated.mjs`, `knowledge-base-v4.json` | Bundled, 53 Pine line references, `content_sha256` in the analysis fingerprint. Given to the H1 Reasoner (`policy`, `src/index.ts`) and the news chain; room agents read decoded plain sentences instead. |
| Deterministic rule validators | `src/agent-threads.mjs` (`entry_without_confirmation`, `bias_without_support`), `src/natural-language.mjs`, `consensusGuard` in `src/h1-consensus.mjs` | Live at write time, with one correction call. Their failure rates are not yet aggregated per agent. |
| Platform reports | `src/platform-reports.mjs` via `AGENTS.syscall(..., "reports.publish")` | Live: Reasoner, Moderator, HUD agents, Risk Manager (health). Never `critical`; denials final. |
| Room messages | D1 `agent_thread_messages` | Stored with stance, bias, confidence, claim; `refs` are empty in rooms (`src/war-room.mjs` `toBody`). |

### 4.2 The platform

| Piece | Where | State |
|---|---|---|
| AI Kernel, syscalls, tiers 0–1 for agents, kill switch, Policy Engine, audit chain | ADR-0007, `workers/ai-kernel/src/syscall.ts`, `control-plane-shared/src/capabilities.ts` | Live. Tier 1 = draft a human approves; tier 3 human only; trading prohibited. |
| `AgentRpc` (host-pinned, tier ≤ 1) | `workers/ai-kernel/src/agent-rpc.ts` | Live; used by this repo's `AGENTS` binding. Kernel-hosted agents are not reachable through it. |
| 21 XAUUSD agents | migration `0016_platform_and_xauusd_agents.sql` | `xauusd-analyst/counselor/reasoner/technical-analyst/news-analyst/risk-manager/moderator` and 14 `hud-*`, each `reports.publish` (4/h), `memory.recall`, `memory.remember` (12/h), `signals.observe`. The desks `m15/h1/h4/d1/htf`, `supertrend` and `order_blocks` are **not** registered. |
| Vectorize memory (TP-008) | `workers/ai-kernel/src/memory.ts`, migration `0014_agent_memories.sql`, index `cryptophys-agent-memory` (384 dims, cosine, metadata index `agent_id`), binding `MEMORY` | Live. Strictly per-agent (`filter: { agent_id }`), 90-day pruning, advisory context only. |
| Embeddings | `control-plane-shared/src/ai-engine.ts` `embed()`, `@cf/baai/bge-small-en-v1.5`, 384 dims | Live, one text per call, counted in `ai_usage` (task `embed`). Kernel budget `AI_DAILY_REQUEST_LIMIT = 40`, account `400` (`workers/ai-kernel/wrangler.toml`). |
| Auditor (TP-007) | `workers/ai-kernel/src/auditor.ts` | Live: audit-chain digest, hourly at :37. Not an XAUUSD decision auditor. |
| Signal Analyst (TP-017) | `workers/ai-kernel/src/signal-analyst.ts`, binding `XAUUSD_AI` (fetch) → `GET /api/decisions` | Live, deterministic relay. |
| P4 Indicator Auditor (`indicators.observe`, `indicator_audit`, `indicators.propose`) | RFC_INDICATOR_AGENT_PLATFORM §6, §9 P4 | **Not built.** None of these exist in `CAPABILITIES` or `REPORT_KINDS` (`workers/ai-kernel/src/reports.ts`). |
| Consensus autonomy | ADR-0009, migration `0023` | Shadow mode. XAUUSD agents never vote; XAUUSD Workers are never deployed by consensus. |

## 5. Architecture

### 5.1 Where it lives (recommendation: the platform AI Kernel, no new Worker)

| Option | For | Against | Verdict |
|---|---|---|---|
| A. New Worker in this repo | Data locality | Breaks AGENTS.md rule 3 and SSOT §1 (exactly four Workers); needs a topology change | Rejected |
| B. Modules inside the AI Worker with its own Vectorize | No cross-repo work | The audited system grades and teaches itself; no approval queue, audit chain or kill switch here; contradicts RFC decision 5 ("the auditor lives in the platform") | Rejected for the auditor; used for the deterministic parts |
| **C. Split: deterministic data here, auditor agent + Vectorize + knowledge ledger in the kernel** | Matches RFC decision 5 and TP-008; reuses the kernel's tiers, Policy Engine, hash-chained audit, human approval, kill switch and embedding budget; separation of duties | Needs one inbound read RPC and one new tier-0 pull; cross-repo phasing | **Recommended** |

**Split of responsibilities:**
- **This repo (deterministic, owns the data and the engines):** decision cards, deterministic compliance checks, outcome scoring, shadow execution of every candidate (engine, strategy, reputation, knowledge), the bundled learned pack and its retrieval into rooms.
- **Platform kernel (`decision-auditor`, kernel-hosted, `tier_max = 1`):** ingestion into Vectorize, similarity search over past decisions, findings, draft wording, model-judged compliance on a small sample, the knowledge ledger and the review queue, reports.
- **The Decision Auditor subsumes the planned P4 Indicator Auditor** (owner decision O2): same inputs (registry, scorecards, stuck states, shadow verdicts), one agent, one budget.

### 5.2 Data flow

```
xauusd AI Worker                                   cryptophys-ai-kernel
-----------------                                  --------------------
rooms, Reasoner, scoring, stuck, shadow
  -> decision cards + compliance (D1)  <--read--  decision-auditor (DO)
                                      AuditReadRpc   | embed (bge-small, batched)
                                                     v
                                                  Vectorize cryptophys-xauusd-knowledge
                                                     | neighbours, clusters, dedup
                                                     v
                                                  findings -> knowledge.propose (candidate)
                                                     | human approves in Console
                                                     v
shadow arm (knowledge / params)  --pull-------->  knowledge.pack (tier 0, approved items)
  scored by outcome, sign test
  -> verdict "ready for owner review" --read-->   auditor reports; owner exports the pack
owner PR bundles knowledge/learned/*.json
  -> rooms read labelled learned notes
```

The platform never writes here (XAUUSD-INTEGRATION §3.6 "No reverse access"). Every arrow into this repo is a pull by this Worker over `AGENTS`.

### 5.3 Vectorize index design

**A new index, not the TP-008 one.** `cryptophys-agent-memory` has only an `agent_id` metadata index, and Vectorize filters only on metadata indexes created before the vectors are inserted; its 90-day pruning also deletes everything. So:

- **Index:** `cryptophys-xauusd-knowledge`, 384 dimensions, cosine, binding `KNOWLEDGE` on `cryptophys-ai-kernel`. Created by an idempotent ensure script (as `ensure-vectorize-index.sh`), with all metadata indexes created **before** the first insert.
- **Embedding model:** `@cf/baai/bge-small-en-v1.5` (384 dims), the model the platform already uses (`DEFAULT_EMBEDDING_MODEL`). All agent text is English. A multilingual model is an owner option (O9), not needed.

| Namespace | What is embedded (text ≤ 1500 chars) | Vector id (≤ 64 bytes) | Count / day | Retention |
|---|---|---|---|---|
| `decision` | One card per room conclusion (1H, 4H, D1 every bar; 15m only on a BUY/SELL, a stance flip or a miss) and per H1 Reasoner decision, rendered in plain English with its outcome | `d:<tf>:<open_ms>:<run>` | about 70 | 120 days |
| `episode` | One per agent statement that was a scored miss or missed opportunity at confidence ≥ 0.6, or broke a rule | `e:<agent>:<tf>:<open_ms>` | ≤ 60 | 120 days |
| `finding` | Each auditor finding (pattern + evidence summary) | `f:<finding_id>` | ≤ 5 | kept |
| `learned` | Each knowledge item version | `k:<item_id>:v<n>` | ≤ 2 | kept |
| `master` | KB v4 chunks: one per field-dictionary entry and per decision-policy rule, with its Pine `{file, line}` | `m:<kb_sha8>:<chunk>` | about 60 per KB version | until KB regenerates |

**Metadata (all vectors):** `chart` (`15`, `60`, `240`, `1D`), `agent` (manifest id or `room`), `regime` (`trend`/`range`), `session`, `outcome` (`hit`, `miss`, `missed_opportunity`, `neutral`, `wait_hit`), `kind`, `status` (for items), `day` (number, yyyymmdd), `kb` (KB `content_sha256`, first 8 hex). Nine metadata indexes, within the limit of 10. The full card stays in platform D1 (`xauusd_audit_cards`), keyed by the vector id; the vector metadata never carries agent text beyond 1 KiB.

**What vectors are used for (auditor only):** nearest past situations of a failure (same chart), clustering of repeated failures, deduplicating a new finding against existing findings and items (cosine ≥ 0.9 updates the existing finding's evidence instead of creating a new one), and retrieving the master chunks relevant to a claim for the compliance judge. **Rooms never query Vectorize at bar time** (§10): selection there is deterministic.

### 5.4 The Decision Auditor loop

| Cadence | Work | AI |
|---|---|---|
| Hourly, kernel cron minute :52 (the supervisor shares it; auditor TP-007 keeps :37) | Read `complianceSummary`, `shadowView`, open stuck states and registry deltas. Deterministic triggers: a compliance-rate spike (§5.5), a stuck state ≥ 16 candles, a shadow verdict that changed (new "ready for owner review" or a promoted item's reverse-shadow control winning), a parity revocation, a learned-pack hash that differs from the last promoted one. Publish `decision_audit` `warning` on a trigger. | None |
| Daily, 01:52 UTC | Fetch cards whose horizons closed since the cursor (≤ 300, idempotent cursor in DO storage). Render, batch-embed (≤ 100 texts per request), upsert. For each new episode, query 10 neighbours (same chart, `episode` namespace). Run deterministic finding rules (§9.2). For each finding: model drafts the wording and a candidate item; validators (§8.3); dedup; `knowledge.propose`. Publish one `decision_audit` `info` digest (counts, top findings, compliance table, shadow verdicts, costs). | Draft wording (≤ 6 calls) |
| Weekly, Monday 02:52 UTC | Model-judged compliance on a sample (§5.5). | ≤ 10 calls |
| On KB change | When `masterKnowledge().content_sha256` changes, embed the new chunks under the new `kb`, mark old ones superseded (kept for audit). | 1 embed batch |

AI never decides whether to act (platform `ANTIGRAVITY.md` rule 2): triggers, findings and statistics are deterministic; the model only writes the wording, which is schema-validated with a template fallback.

### 5.5 Compliance checks

**Deterministic (computed here at write time or by a sweep over stored messages; `src/compliance.mjs`, D1 `compliance_checks`):**

| Check | Rule source | Applies to |
|---|---|---|
| No order wording, size, lots or price levels in agent text | Advisory rule; SSOT "rooms never give levels" | All agents |
| No confirmation, no entry (`entry_without_confirmation`), counted per agent including the corrected first attempt | Owner rule 2026-11-05 | Openings, rebuttals, conclusions |
| BUY/SELL conclusion needs support; bias needs support (`bias_without_support`) | Owner rules 2026-11-06 | Moderators |
| Stance–bias consistency (BUY with BEARISH bias, SELL with BULLISH) | Bias rule 2026-11-06 | All |
| Confidence cap: an agent with no verified or bar-computed statement speaks at ≤ 0.4 | SSOT "Calibration status once" | HUD and indicator agents, unapproved desks |
| No calibration talk in text ("verified", "parity", "calibrated") | SSOT "Agents never mention calibration" | All |
| Data scope: a HUD or indicator agent names another agent's indicator (lexicon built from `MANIFESTS` names and sections) | Manifest role; "each agent analyses only the data its HUD produces" | HUD and indicator agents |
| Own-data contradiction: the agent's bias is opposite to the deterministic lean of its own reading where one exists (R38 direction, R37 consensus direction, GMI verdict, Supertrend direction) | KB v4 field dictionary via the deterministic readings | Desks, Prophet, Decision Matrix, Supertrend |
| Moderator states "H1 decision: X" when it differs; mentions the crowd when its bias differs | SSOT War Room rules | Moderators |
| Reasoner departs from the room only for a listed veto (`consensusGuard` override rate) | SSOT H1 Consensus | H1 Reasoner |
| Natural language (`naturalLanguageErrors`), invalid output and fallback rates | SSOT | All |

Output: per agent, per chart, per 7 and 30 days, the violation rate per 100 messages, served by `AuditReadRpc.complianceSummary` and `GET /api/compliance` (Nexus chips next to the existing CAUTION chip). A check never changes a message, stance or decision.

**Model-judged (platform, weekly sample, never a verdict on its own):** for ≤ 10 messages a week, sampled from agents with the worst deterministic or outcome record, the judge receives the message, the agent's manifest role and the top 3 `master` chunks retrieved for its claim, and answers a strict schema: `{ follows_from_data: yes|no|unclear, contradicts_master: none|<chunk id>, outside_role: yes|no, reason ≤ 200 }`. A judged violation becomes a finding only when a deterministic check or the outcome record points the same way; otherwise it is listed for the human reviewer as "model opinion". Agent text and news headlines are untrusted input to the judge (prompt-injection rule: data, never instructions).

## 6. Data contracts

### 6.1 Decision card (`cryptophys.decision-card.v1`, built here, read by the platform)

```json
{
  "card_id": "d:60:1762693200000:0",
  "version": "cryptophys.decision-card.v1",
  "kind": "room_conclusion",               // or "h1_decision", "agent_episode"
  "chart": "60", "bar_open": "2026-11-09T13:00:00Z", "bar_close": "2026-11-09T14:00:00Z",
  "session": "london", "regime": "trend",
  "conclusion": { "stance": "WAIT", "bias": "BEARISH", "confidence": 0.55, "reconvened": false },
  "crowd": { "weighted_bias": "BEARISH", "disagreement": 0.41, "disagreeing_families": ["trend"] },
  "agents": [ { "id": "prophet", "stance": "WAIT", "bias": "BULLISH", "confidence": 0.62,
                "calibration": "verified", "claim": "≤ 300 chars", "learned_items": [] } ],
  "h1": { "decision": "WAIT", "guard_overridden": false },
  "confirmations": { "h1_r38_buy": false, "h1_r38_sell": false },
  "stuck_open": [ { "field": "prophet_r37.structure_subtype", "candles": 9 } ],
  "compliance": [ { "agent": "supertrend", "check": "data_scope", "detail": "named the GMI verdict" } ],
  "outcomes": { "agent:moderator": { "result": "missed_opportunity", "direction": -1 },
                "agent:prophet": { "result": "miss" } },
  "excursion_atr": { "max_up": 0.4, "max_down": 1.3 },
  "provenance": { "scoring_version": "cryptophys.outcome-scoring.v3", "kb_sha": "…", "learned_pack_sha": null,
                  "parity": { "prophet": "approved", "gmi": "approved" } }
}
```

Never present: `entry_price`, `stop_loss`, `take_profit`, `trade_plan`, strategy plan, key levels or zones, `close`, ATR in dollars, size. A test asserts the builder drops them.

### 6.2 Knowledge item (`cryptophys.knowledge-item.v1`, platform ledger)

```json
{
  "item_id": "k-0007", "version": 2, "kind": "caution",      // caution | role_reminder | param_candidate | precedent (later)
  "audience": { "agents": ["prophet", "r37_funnel", "h1", "moderator"], "charts": ["60"] },
  "situation": { "stuck_field": "prophet_r37.structure_subtype", "regime": "trend" },
  "text": "When the Prophet R37 structure has stayed a bull trap for eight or more hourly candles while price rose, its bearish lean was wrong in 11 of 14 such bars over the last 30 days.",
  "claim_type": "measured_outcome",                          // never "field_meaning"
  "evidence": { "bars": 14, "wrong": 11, "baseline_wrong_rate": 0.48, "p_value": 0.03, "window": ["2026-11-10", "2026-12-09"] },
  "provenance": { "finding_id": "f-0031", "card_ids": ["d:60:…", "…"], "outcome_score_ids": [ … ],
                  "kb_sha": "…", "scoring_version": "…", "manifest_version": "cryptophys.indicator-manifest.v1" },
  "status": "candidate",            // candidate | rejected | approved_for_shadow | shadow | ready_for_review | promoted | retired | rolled_back
  "supersedes": "k-0007@1", "expires_after_days": 60,
  "content_sha256": "…", "created_by": "agent:decision-auditor", "reviewed_by": null
}
```

Rows are immutable; every status change is an append-only `knowledge_item_events` row, also appended to the platform audit chain. A new version is a new row.

### 6.3 Parameter candidate (`param_candidate` item, `params` block)

```json
{ "target": "shadow_engine", "family": "gmi_v12_70", "params": { "stateMaxAge": 16 },
  "grid": "TUNING_GRID.gmi_v12_70.stateMaxAge", "hypothesis": "fewer Prophet risk holds during trends",
  "metric": "paired sign test on decisive pairs, one-sided, alpha 0.05 (Holm-adjusted)" }
```

The hypothesis and the metric are fixed when the candidate is created (pre-registration), so a candidate cannot be judged on a metric chosen afterwards.

## 7. RPC methods between the repositories

### 7.1 Platform → this repo: `AuditReadRpc` (new WorkerEntrypoint on `xauusd-ai-trading-assistant`, read-only)

| Method | Returns | Bound |
|---|---|---|
| `decisionCards({ since_close, limit, charts? })` | `{ version, cards, next_cursor }`; only cards whose horizons closed | `limit ≤ 200`, ≤ 1 MiB |
| `complianceSummary({ days })` | per agent and chart: messages, violations per check, rate per 100 | `days ≤ 30` |
| `scorecards({ days })` | as `GET /api/scorecards` | |
| `indicatorRegistry()` | as `GET /api/indicator-agents` | |
| `shadowView({ days })` | as `GET /api/shadow-versions`, plus shadow knowledge, strategy and reputation replays (§9) | |
| `masterKnowledge()` | KB v4 with refs, `content_sha256`, chunk list; and the bundled learned pack `{ version, sha, items }` | |
| `tuningGrid()` | the declared grids and which points are running, done or untested | |

- The kernel binds it as `XAUUSD_AUDIT` (`service = "xauusd-ai-trading-assistant"`, `entrypoint = "AuditReadRpc"`). No secret; read-only; no method writes.
- RPC rather than new public `GET /api/audit/*` routes: those would be public through `ai.cryptophys.work` and the Nexus proxy. A public `GET /api/compliance` summary is still added for Nexus.
- **Needs an owner-approved SSOT §2 amendment** ("the platform reads this Worker only through `GET /api/decisions`"), with `AGENTS.md` and `test/ssot-topology.test.mjs` if the owner counts it as topology (O3).

### 7.2 New platform capabilities (catalog `capabilities.ts`)

| Capability | Tier | Granted to | Limit | Does |
|---|---|---|---|---|
| `xauusd.audit.observe` | 0 | `decision-auditor` | — | Calls `AuditReadRpc` (replaces P4's `indicators.observe`). |
| `knowledge.recall` | 0 | `decision-auditor` | topK ≤ 20 | Semantic search in `KNOWLEDGE`. |
| `knowledge.ingest` | 1 | `decision-auditor` | 4 per hour, ≤ 100 vectors each | Idempotent upsert of cards, episodes and master chunks (D1 row and vector with the same id), like `memory.remember`. |
| `knowledge.propose` | 1 | `decision-auditor` | 6 per hour, 20 per day | Creates a `candidate` item; a person approves or rejects. Not a consensus action (ADR-0009 §1). |
| `knowledge.pack` | 0 | `xauusd-knowledge-reader` only | — | Returns items in `approved_for_shadow` or `shadow` for this host, ≤ 10 items, ≤ 8 KiB, with the ledger hash. |
| `reports.publish` (existing) | 1 | `decision-auditor` | 4 per hour | New report kind `decision_audit` (table rebuild for the CHECK, as migration 0017 did). |

New agent rows (platform migration): `decision-auditor` (host `cryptophys-ai-kernel`, `tier_max 1`) and `xauusd-knowledge-reader` (host `xauusd-ai-trading-assistant`, `tier_max 0`, only `knowledge.pack`). The reader is least-privilege and avoids borrowing `xauusd-moderator` (O4).

Operator tools (Console and MCP, Access identities): `knowledge_review(item_id, version, approve|reject, note)` for an identity in `APPROVER_IDENTITIES` who is not the proposer; `knowledge_export(status)` returns the items for a promotion PR.

### 7.3 This repo → platform: the pull

```js
// once an hour at most, in the parity sweep, behind SHADOW_KNOWLEDGE_ENABLED
const r = await env.AGENTS.syscall("xauusd-knowledge-reader", "knowledge.pack", { host: "xauusd-ai-trading-assistant" });
// { outcome: "succeeded", result: { ledger_sha, items: [ { item_id, version, audience, situation, text, content_sha256 } ] } }
```

- Cached in KV `knowledge:pack:shadow` for 1 hour. Used **only** by the shadow arm (§9.4), never by a live prompt.
- `denied` or `failed`: recorded in `platform_publications`-style status (shown in `GET /api/platform/status`), the shadow arm pauses, no retry; after `agent_suspended` or `agents_disabled` the next attempt waits 24 hours. The agent id never changes.
- Non-fatal: rooms and the chain run as today whatever the kernel answers.

## 8. The knowledge ledger

### 8.1 Master vs learned

| | Master knowledge | Learned knowledge |
|---|---|---|
| Source | KB v4, generated from `pinescript/ssot/*` with line citations | Auditor findings from outcomes and compliance |
| Changes | Only by regeneration (`scripts/build-knowledge-base.mjs --write`), with tests | New versions in the ledger; reaches agents only through a merged PR |
| May state | What a field means, the decision policy | Only measured outcomes and role reminders ("has been wrong 11 of 14 times…") |
| Label in prompts | Unchanged (`policy` for the Reasoner; decoded readings in rooms) | "LEARNED NOTE (reviewed; measured from past outcomes, not from the Pine source)" |
| Precedence | Wins | Never overrides master; a contradicting item is rejected |

### 8.2 Lifecycle

`candidate` (auditor) → `approved_for_shadow` (person) → `shadow` (this repo's arm running) → `ready_for_review` (deterministic: shadow verdict "better" + holdout passed) → `promoted` (observed when the owner's PR with that item's `content_sha256` is merged and `masterKnowledge().learned_pack` reports it) → `retired` (expired, or the situation no longer occurs) or `rolled_back` (PR reverted, or reverse-shadow lost). `rejected` is terminal for that version.

Items expire after 60 days unless re-validated on fresh bars (decay against regime change, O11).

### 8.3 Validators for a candidate item (deterministic, in the kernel)

- `claim_type` is `measured_outcome` or `role_reminder`; text has no field definition pattern ("X means", "code N is").
- Every number in the text appears in `evidence`; no prices, levels, sizes or order verbs (advisory guard).
- `provenance` lists ≥ 10 card ids that exist in `xauusd_audit_cards`, and the scoring version and KB hash are current.
- Text ≤ 300 characters; natural language (no field names or key=value).
- The `audience` ids exist in the manifests (`indicatorRegistry()`).

## 9. The calibration loop ("auto-tuning", by proposal)

### 9.1 Which knobs may ever be tuned

| Knob | Today | Tunable? | Tested by | Promotion |
|---|---|---|---|---|
| Learned knowledge items (prompt notes) | none | **Yes** | Shadow agent arm (§9.4) | Owner PR (bundled pack) |
| Role reminders for an agent that keeps breaking its role | none | **Yes** | Shadow agent arm, plus its compliance rate | Owner PR |
| Reputation parameters: prior 10, weight 0.25–2, 30 days, neutral band 0.1 (`src/reputation.mjs`) | fixed | **Yes** | Deterministic replay over stored rooms and scores: is the weighted crowd bias right more often | Owner PR |
| Strategy engine thresholds: `MIN_RRR` 1.5, confidence 0.4, lean band ±0.15, level 0.35 ATR, zone 0.3 ATR, candidate zone 3 sources (`src/strategy-engine.mjs`, `src/key-level-agent.mjs`) | fixed | **Yes** | Deterministic replay as `shadow-strategy:<id>`, scored on stance; levels stay here, never reported to the platform | Owner PR |
| Shadow engine parameters (e.g. `stateMaxAge`) through the pure engine functions | P3/P5 candidates | **Yes, within a reviewed grid** | P3 shadow versions | Owner PR |
| Owner rules: no confirmation no entry, support rules, 0.4 cap for uncalibrated agents, quorum, `consensusGuard` vetoes | owner decisions | **No** (may be questioned in a report, in words) | — | Owner decision |
| Outcome scoring definition and stuck-state thresholds | owner decisions 2026-11-07 | **No**: the yardstick is never tuned by what it measures | — | — |
| Parity rules (24 matches, tolerances, `PARITY_FIELDS`, input-mismatch rule), hashed engine files, `pinescript/ssot/*` | | **Never** | — | — |
| KB v4 content | | **Never** (regeneration from Pine only) | — | — |
| Advisory rule, kernel rules (`critical`, denials), tiers, kill switches, budgets, models | | **Never** by this loop | — | Owner/ops |

### 9.2 From finding to candidate (deterministic rules)

- **Agent pattern:** an agent's decisive accuracy in a situation (chart × regime × open stuck field × session) is below its own 30-day baseline with a one-sided binomial p < 0.05 on ≥ 12 decisive calls → `caution` candidate for that agent and the moderator.
- **Role drift:** a compliance check rate above 5 per 100 messages for 7 days → `role_reminder` candidate quoting the manifest role.
- **Engine pattern:** a stuck episode family recurring ≥ 3 times in 30 days, or a shadow family whose candidates are all `not_better` → `param_candidate` for the next untested grid point, or a report saying "the cause is elsewhere" (as BACKLOG item 8 anticipates).
- **Crowd pattern:** the weighted crowd beats the moderator's conclusion on bias (sign test) → reputation-parameter replay proposal.

Vectors serve these rules (finding similar situations, dedup); they never decide.

### 9.3 Statistics (shared by every arm)

- Paired, like-for-like bars only; one-sided exact sign test (`signTestP`) on bars where exactly one arm is right; `SHADOW_MIN_SAMPLE` 200 bars and `REVIEW_MIN_DECISIVE_PAIRS` 30.
- **Multiple testing:** Holm–Bonferroni across all candidates of one family reviewed in the same calendar month (O12).
- **Holdout:** after "better", the candidate must be no worse on the next 100 fresh bars before `ready_for_review`.
- **No new stuck time** (existing criterion) and no higher compliance rate.
- **Reverse shadow after promotion:** for 30 days the control (without the change) keeps running in shadow; if it becomes significantly better, the auditor publishes a `warning` and proposes the rollback PR.

### 9.4 Shadow arms in this repo

| Arm | How | Cost | Subject |
|---|---|---|---|
| Engine params | Existing `src/shadow-versions.mjs`; new `TUNING_GRID` declared in code (reviewed PR); a deterministic scheduler starts the next grid point when one stops, ≤ 3 concurrent per family (O6) | None (deterministic) | `shadow:<family>@<param><value>` |
| Strategy and reputation params | New `src/tuning-replay.mjs`: recompute the strategy decision or the weighted crowd from stored room messages and bars | None | `shadow-strategy:<id>`, `shadow-crowd:<id>` |
| Knowledge items | New `src/shadow-knowledge.mjs`: for each approved item, one extra call of one target agent per bar with the note added; stored in D1 `shadow_agent_outputs`, never shown, never in the crowd line, the moderator or the Reasoner. Control = that agent's real opening on the same bar | 1 model call per bar per item; cap `SHADOW_KNOWLEDGE_MAX_CALLS_PER_HOUR` 8, ≤ 2 items at once | `shadow-agent:<agent>@<item>v<n>` |

The first knowledge item runs once as an A/A test (the same prompt twice) to measure how often the model's stance changes by chance; that noise rate is reported next to every later verdict (O13).

## 10. Retrieval into rooms (after promotion only)

- **Source:** `knowledge/learned/pack.json`, generated by `scripts/build-learned-knowledge.mjs` from `knowledge_export(ready_for_review)` and bundled like KB v4. Tests fail when an item lacks provenance, exceeds its budget, contains a number not in its evidence, or contradicts the label rules. Its `content_sha256` enters the analysis fingerprint and every room brief (`learned_pack: { version, sha, items_by_agent }`), so every decision records which notes it saw.
- **Selection is deterministic:** an item is shown to an agent when the agent is in its `audience`, the room's chart matches, and its `situation` matches the bar (open stuck field, regime, session). No vector query at bar time, no model choosing notes.
- **Flag:** `LEARNED_KNOWLEDGE_ENABLED` (default `"false"`); turning it off restores today's prompts at once.

| Consumer | Items | Budget (characters, about 4 per token) |
|---|---|---|
| HUD and indicator agents | ≤ 2 matching items | ≤ 400 |
| Desks (timeframe desks, Technical, Risk) | ≤ 2 | ≤ 400 |
| Moderators | ≤ 3 (items whose audience includes `moderator`) | ≤ 600 |
| H1 Reasoner | ≤ 3 scoped to H1 | ≤ 600; KB v4 `policy` unchanged |
| News Analyst, News Daily | none at first | 0 |

Prompt block, placed after the agent's own data:

```
LEARNED NOTES (reviewed by the owner; measured from past outcomes, not from the Pine source;
your own data and the Pine-derived readings above take precedence; do not quote these notes as facts about the indicator):
- When the Prophet R37 structure has stayed a bull trap for eight or more hourly candles while price rose, its bearish lean was wrong in 11 of 14 such bars over the last 30 days.
```

A later phase may add **precedents**: a deterministic line for the moderator ("in the 10 most similar past 1H bars, the room's bias was right 6 times"), found in a second small index of deterministic situation features (no text embedding, no AI). It goes through the same shadow and PR path.

## 11. Safety and rollback

| Risk | Control |
|---|---|
| Self-reinforcing loop (notes shape the outputs that produce new notes) | Outcomes are prices only; holdout bars; 60-day expiry; reverse shadow after promotion; each card records which notes were shown, so findings exclude bars influenced by the same note |
| Overfitting and false positives | Minimum samples, Holm correction, pre-registered metric, holdout, owner review |
| Goodhart (tuning the yardstick) | Scoring definition and stuck thresholds are not tunable |
| Unreviewed self-generated claims reaching agents | Person approves before shadow; live prompts read only the PR-bundled pack; shadow outputs never reach a room |
| Prompt injection through agent text or news | Treated as data in every prompt; strict schemas; validators; the judge cannot create a finding alone |
| Levels or order wording leaking to the platform | Card builder strips them (tested); platform advisory guard; no `critical` from market findings |
| Kernel down, denial, kill switch | Every call non-fatal; denials final; shadow arm pauses; rooms unchanged |
| Bad promoted note | Revert the PR, or set `LEARNED_KNOWLEDGE_ENABLED` to `"false"` by PR; the ledger marks `rolled_back`; history is never deleted (deletion is tier 3) |
| Vectorize or embedding failure | The auditor records `knowledge: "unavailable"` in its cycle report and continues deterministically, as TP-008 does |

Kill switches: platform global `agents_enabled` and per-agent suspend (`decision-auditor`, `xauusd-knowledge-reader`); here `SHADOW_KNOWLEDGE_ENABLED`, `LEARNED_KNOWLEDGE_ENABLED`, `DECISION_AUDIT_EXPORT_ENABLED`.

## 12. Cost

| Item | Estimate | Limit it must fit |
|---|---|---|
| Vectors stored | about 130 a day × 120 days ≈ 16k + master and items < 1k → ≈ 6.5M dims (384 each) | Workers Paid includes 10M stored dims a month, shared with TP-008's ≈ 1.2M |
| Vectors queried | about 100 queries a day; queried dims count stored plus queried vectors per month ≈ (16k + 3k) × 384 ≈ 7.3M | 50M included a month |
| Embeddings (kernel) | 2–4 batched requests a day (bge-small accepts a text array; needs a new `AiEngine.embedBatch`) | Kernel `AI_DAILY_REQUEST_LIMIT` 40, account 400 |
| Auditor drafts and judge (kernel) | ≤ 6 a day + ≤ 10 a week | Same kernel budget; propose raising it to 80 (O8) |
| Shadow knowledge arm (this repo) | ≤ 8 calls an hour on the room model (gemma-4) | Room caps are 136 and 140 an hour; the arm has its own cap and fails closed |
| D1 | cards ≈ 3 KB × 130 a day; compliance rows per message | Small |
| Vectorize limits that matter | 10 metadata indexes, created before inserts; 64-byte ids; 10 KiB metadata; topK 50 with metadata; 1000 vectors per Worker upsert | Design uses 9 indexes, ids ≤ 50 bytes, ≤ 1 KiB metadata |

Source for limits and pricing: Cloudflare Vectorize docs (`/vectorize/platform/limits/`, `/vectorize/platform/pricing/`, checked 2026-11-07). The platform task that adds the index must re-check them, as TP-008 did.

## 13. Metrics of success (measured, 30-day windows against the 30 days before activation)

1. **Accuracy:** each promoted change shows a significant paired gain in shadow and holds it in reverse shadow; room and Reasoner shrunk accuracy (`reputationOf`) does not fall.
2. **Calibration:** Brier of agents with a confidence improves; fewer high-confidence misses.
3. **WAIT quality:** the missed-opportunity rate of the H1 decision and the 1H room falls without a rise in directional misses (BACKLOG item 5, "always WAIT").
4. **Compliance:** violations per 100 messages fall per agent; correction-call, `invalid_output` and `consensusGuard` override rates fall.
5. **Stuck time:** candles inside stuck episodes fall (engine candidates).
6. **Knowledge hygiene:** 100 % of items with full provenance; time from candidate to review; rollbacks; expired items.
7. **Cost:** added calls, embeddings and stored dimensions stay within §12.

## 14. Phases (one small PR each, CI green, owner review)

| Phase | Repo | Content | Behaviour change |
|---|---|---|---|
| **K0** | this repo (docs) | This RFC in `docs/`; owner decisions §15 | None |
| **K1** | this repo | `src/compliance.mjs` deterministic checks, D1 `compliance_checks` (migration `0011`; `0010` is the Signal Ledger), `GET /api/compliance`, Nexus chips | None to rooms or decisions |
| **K2** | this repo | Decision card builder (pure, tested to drop levels) and the read-only `AuditReadRpc` entrypoint; SSOT §2 amendment (and topology test, if O3 says so) | None |
| **K3** | platform | `decision-auditor` kernel agent (Durable Object), `xauusd.audit.observe`, binding `XAUUSD_AUDIT`, report kind `decision_audit`, hourly triggers and daily digest; deterministic only, no Vectorize. Delivers P4's audit scope | Reports only |
| **K4** | platform | Index `cryptophys-xauusd-knowledge` (ensure script, metadata indexes first), `embedBatch`, `knowledge.ingest`, `knowledge.recall`, daily ingestion, master chunks, 120-day retention for `decision`/`episode` | Reports only |
| **K5** | platform | Ledger tables, `knowledge.propose`, validators, Console review queue, `knowledge_export`, agent `xauusd-knowledge-reader` with `knowledge.pack` | Candidates only |
| **K6** | this repo | Shadow knowledge arm behind `SHADOW_KNOWLEDGE_ENABLED` (default off), pull via `AGENTS`, D1 `shadow_agent_outputs`, A/A run, Nexus `#/shadow` section | Extra shadow calls only |
| **K7** | this repo | `TUNING_GRID` and scheduler for engine params; `src/tuning-replay.mjs` for strategy and reputation params; Holm and holdout in the comparison; `/api/tuning` | Shadow only |
| **K8** | this repo | Bundled learned pack, build script and tests, retrieval with budgets behind `LEARNED_KNOWLEDGE_ENABLED` (default off), pack hash in brief and fingerprint, reverse shadow | None until a pack is promoted |
| **K9** | this repo | **First promotion PR** of one item or one parameter, owner-approved | The promoted change only |
| K10 (later) | both | Deterministic precedents index, shadow, then PR | Shadow first |

## 15. Owner decisions needed

1. **O1 Location:** the Decision Auditor as a kernel-hosted agent on the platform with deterministic parts here (recommended), or everything inside the AI Worker.
2. **O2 Merge with P4:** one Decision Auditor replacing the planned Indicator Auditor (recommended).
3. **O3 Inbound read RPC:** allow the platform to read this Worker through `AuditReadRpc`, amending SSOT §2; is that a topology change (AGENTS.md, topology test)?
4. **O4 Reader identity:** a new least-privilege `xauusd-knowledge-reader` agent (recommended), or reuse `xauusd-moderator` for the pull.
5. **O5 Review gate:** a person approves every item before shadow (recommended); owner only, or any `APPROVER_IDENTITIES` member?
6. **O6 Engine grid:** may the scheduler start grid points in shadow automatically, ≤ 3 per family (recommended, shadow never reaches a room), or does each point need your approval?
7. **O7 Promotion form:** learned notes reach agents only through a bundled PR (recommended, consistent with KB v4 "cannot drift"), not a runtime pack.
8. **O8 Budgets:** kernel AI limit 40 → 80 a day; shadow knowledge cap 8 calls an hour; the token budgets of §10.
9. **O9 Embedding model:** reuse `bge-small-en-v1.5` (recommended) or a larger or multilingual one.
10. **O10 Model judge:** on or off; weekly sample of 10; which model (the kernel's `llama-3.1-8b-instruct-fast` is weak; `gpt-oss-120b` conflicts with the platform's free-model rule in `architecture/AI-ENGINE-REQUIREMENT.md`).
11. **O11 Retention and decay:** 120 days for decision and episode vectors; items expire after 60 days unless re-validated.
12. **O12 Statistics:** Holm correction per family per month and a 100-bar holdout.
13. **O13 A/A noise check** for the first knowledge item.

## 16. Conflicts found between the request and the repository rules

1. **"Self auto-tuning" vs "promotion is never automatic"** (RFC §4.3, §10 decision 1, SSOT "Shadow indicator versions"). Resolved: automatic proposal and shadow testing; the owner promotes by PR.
2. **"Update decisions as knowledge, continuously growing" vs KB v4** being generated from Pine, bundled so it "cannot drift", and constraint 5. Resolved: learned knowledge is a separate, reviewed, labelled layer; KB v4 stays the only master.
3. **ADR-0009 consensus autonomy** ("the owner only clicks critical approvals") vs owner-approved promotion here. ADR-0009 already excludes XAUUSD from votes and deploys; the new capabilities must stay outside its action classes. The owner should confirm.
4. **"No reverse access"** (`docs/XAUUSD-INTEGRATION.md` §3.6) and SSOT §2 ("the platform reads this Worker only through `GET /api/decisions`") vs the data the auditor needs and the notes it returns. Resolved by a read RPC (needs O3) and a pull by this Worker.
5. **TP-008 memory is per-agent and pruned at 90 days,** so it cannot hold shared, permanent knowledge. A new index and new capabilities are needed.
6. **Kernel AI budget (40 a day)** is too small for per-text embeddings; batching and a budget increase are needed.
7. **Registered agents vs the live rosters:** the 21 platform agents miss the timeframe desks, `supertrend` and `order_blocks`, and two of them (Analyst, Counselor) are retired from the H1 chain (they still serve the news chain). The auditor keys everything by manifest id, not platform agent id.
8. **Levels already reach the platform:** the Signal Analyst relays `entry_price`, `stop_loss` and `take_profit` from `GET /api/decisions` into `xauusd_digest` (`workers/ai-kernel/src/signal-analyst.ts`, around line 180), while this repo's rule is that kernel reports never carry levels. Out of scope here; the decision cards exclude levels; the owner may want that relay reviewed.
9. **P4 is not built:** `indicators.observe`, `indicator_audit` and `indicators.propose` do not exist on the platform yet.
10. **Rooms store no evidence refs** (`refs: []` in `src/war-room.mjs`), so the data-scope check relies on a name lexicon from the manifests and is approximate.
