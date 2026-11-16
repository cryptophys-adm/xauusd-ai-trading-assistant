# RFC: Call for Councils (Nexus side, xauusd)

Status: final design (owner's answers 2026-11-16: "1–4 setuju, 5 pakai 16 panggilan, 6 klik di Cerebrum, 7–9 setuju"; and "jangan ditampilkan di omega, buat menu navigator sendiri Call for Councils"). No code until the owner starts phase P1; two platform items to confirm (section 9: the return path of the pick and the Telegram source). Aligned with the shared contract `council.v1` (platform `docs/design/HAIC-H0-H1.md` §4, relayed 2026-11-16) and the owner's HAIC decisions of 2026-11-16 ("ya semua, sesuai rekomendasimu"): picks in Cerebrum only (Q6), a shadow window of at least 14 days and 30 outcomes (Q8), councils started by the owner only (Q9), transcripts 90 days hot then R2 only (Q4), live updates aligned with the platform's ConsoleHub where it makes sense (Q7).

**Owner's request (2026-11-16, translated):** the owner can call all the relevant agents into a scrum/retrospective session. The topic is either something the agents found themselves or a topic the owner sets (example: "the Key Level entry strategy often gets hit by SL or SL+"). Each agent gives its opinion and talks with the owner about what to improve. Together they decide which strategy to try and implement. The same feature will exist in Cerebrum for platform topics.

**Canonical references:** `docs/SSOT.md` (state), `docs/RFC_ROOM_CELLS.md` (run documents, ADR-0015 phase 2), `docs/RFC_STRATEGY_AGENTS.md`, `docs/RFC_PLAN_LEARNING.md`, `docs/RFC_AETHER_KNOWLEDGE_GUARDIAN.md`. Everything marked **new** does not exist in this repository today. Placeholders for the shared Cerebrum contract are marked `[CONTRACT-n]` (section 9).

## 0. Scope, names and boundary

**In scope:** a session engine in the AI Worker (`xauusd-ai-trading-assistant`), its evidence pack, its storage, a Nexus page of its own, **Call for Councils**, with its own entry in the Nexus navigator (owner 2026-11-16: "jangan ditampilkan di omega, buat menu navigator sendiri Call for Councils"; nothing of it on the Omega page), the owner's actions through a write route on the Omega Worker (transport only, no Omega UI), and the handoff of a chosen option to the existing shadow paths.

**Names.** "Council" already means three things here, so code ids must not reuse it bare:
- the Decision Engine's **AI Decision Council** (`COUNCIL_AGENT = "council"` in `src/decision-engine.mjs`; the learned-pack consumer id `council`; schema `decision_council`);
- Aether's **Knowledge Council** (doctrine facts, SSOT §2);
- the Cerebrum **council** (the voting seats of the platform consensus; xauusd agents hold no seat, SSOT §2 "The organs' DNA").

Proposed internal prefix: `cfc` (Call for Councils): thread/room id `cfc:<session_id>`, schemas `cfc_opening`, `cfc_rebuttal`, `cfc_answer`, `cfc_synthesis`, meter label `cfc:<schema>`. Final names follow `[CONTRACT-2]`.

**The decision boundary does not move.**
- A council is not a room of the decision path: its output is not a witness (`WITNESS_WEIGHTS`, `EXTENDED_WITNESS_WEIGHTS` unchanged), not evidence for any room, prompt, guardrail, the Decision Engine, `GET /api/ea/signal` or Omega.
- A council can only produce a **proposal**. A proposal can only start a measurement in shadow. Only the owner turns a measured result live (section 5).

## 1. Triggers

### 1.1 The owner opens a council
- From the new **Call for Councils** page (`#/councils`, new; its own item in the Nexus left navigator, not under Omega) with a free topic, or from a suggested topic in the inbox (1.2). **Only the owner starts a council** (owner decision Q9).
- Nexus `/api/*` is GET/HEAD only (`workers/xauusd-nexus-dashboard/src/index.ts`). Every owner action on the Call for Councils page therefore goes, like the trading mode and the shadow switch, to a new route `POST /omega/api/council` (new; a transport route only, the Omega page shows nothing of councils) in `workers/xauusd-omega/src/omega.mjs`, which checks the Access identity and the same origin, then calls new `OmegaGateway` methods (`councilOpen`, `councilMessage`, `councilDismiss`; new) in `src/index.ts`. **There is no pick in Nexus** (owner decision Q6): the session's options link to Cerebrum, where the owner picks under the Access identity (section 5).
- The owner chooses the seats (prefilled per topic kind, section 2) and may attach an evidence scope (date range, strategy agent, pattern, trading mode).

### 1.2 Topics suggested by the system
Agents and outcome scoring may only **suggest** a council (owner decision Q9): a suggestion is an inbox item (a `council.proposed` event, `trigger.kind` `finding`, `kpi_regression` or `agent`, `[CONTRACT-2]`), a card on the Call for Councils page and one Telegram line. It costs no model call; nothing runs until the owner starts it, or dismisses it (`proposed → dismissed`). Checked hourly in the sweep, deterministic (new: `src/cfc-triggers.mjs`):

| Source (exists today) | Signal | Topic key |
|---|---|---|
| Strategy agent breaker, `suspendedAgents` / `syncAgentBreaker` in `src/strategy-agents.mjs` (KV `strategy-agents:suspended:v1`) | a live agent suspended (negative record over 30 resolved setups) | `strategy:<agent>` |
| Pattern breaker, `suspendedPatterns` (`PATTERN_BREAKER`) | a pattern held back for an agent (negative over 15 setups) | `strategy:<agent>:<pattern>` |
| Signal Ledger, D1 `signal_ledger` (`source = 'decision'`) joined to `engine_decisions.decision_json` `$.trade.agent` | over the last N resolved trades of one agent, the share ending at the stop (`exit_reason = 'stop'`, `sl_plus_triggered = 0`) or at the protected stop (`sl_plus_triggered = 1`; Omega simulation `omega_exit = 'sl_plus'`) passes a threshold (proposed: N = 20, share ≥ 0.65; owner's choice) | `strategy:<agent>:exits` |
| Plan learner, `src/plan-learning.mjs` (KV `plan-learning:state:v1`) | an agent's mean R per setup below 0 in one context (`<mode>\|<regime>`) over 20 setups, before the breaker's 30 | `strategy:<agent>@<context>` |
| Outcome scoring, `src/outcome-scoring.mjs` (`scorecard_snapshots`; `outcome_summary` of `engine:15`) | the Decision Engine's 7-day directional hit rate below its 30-day rate by a margin (proposed 10 points, 30 decisive calls) | `kpi:engine:15` |
| Reputation, `src/reputation.mjs` | a room seat's crowd weight falls to the floor (0.25) on a chart | `seat:<id>@<chart>` |
| Learned notes, `src/learned-live.mjs` | a live note retired as worse than its control | `knowledge:<item>` |
| Model baseline gate, `promotionGate` in `src/model-baseline.mjs` | a disconnection | `kpi:model` |

- **Agents' own topics.** Room seats cannot raise a topic by free text in this design (a seat that names its own topic would also choose its own evidence). Agent-raised topics are the deterministic flags above plus, later, open `stuck_states` and repeated `compliance_checks` findings; they are suggestions only (owner decision Q9).
- **Rate limits:** one open suggestion per topic key; a fingerprint dedup with a 7-day cooldown (the contract's rule); at most 3 new suggestions a day.

## 2. Participants

**Seat roster.** The real roster is generated by `src/agent-inventory.mjs` (`ROOMS`, `GET /api/agents/inventory`, 28 seats): `DESK_AGENTS` (`src/war-room.mjs`: `m15`, `news`, `technical`, `risk`, `projection`), `TF_DESKS` (`src/timeframe-threads.mjs`: `h1`, `h4`, `d1`, `news`, `technical`, `risk`, `projection`), `MACRO_AGENTS` (`src/macro-room.mjs`: `calendar`, `news`, `dollar`, `rates`, `silver`, `oil`, `correlation`), the HUD seats (`hudAgentsIn(room)` over the manifests in `src/indicator-manifests.mjs`; the dismantled R37 Funnel, GABFX Price Action, Playbook Execution and Grid Bot Protocol sit in no room and are not offered) and the moderator (`stepRole` in `src/agent-threads.mjs`).

**Seats per topic kind (prefill; the owner may add or remove; at most 6 participants besides the moderator, so a session fits the contract's 16 calls, section 8):**

| Topic kind | Seats |
|---|---|
| `strategy:*` (e.g. the Key Level entry) | Risk Manager (`risk`), Technical Analyst (`technical`), Projection Agent (`projection`, owns the pattern knowledge), 15m Desk (`m15`, the Prophet trigger timing), Trade Management (`trade_management`, exits), The Interstellar Eyes (`interstellar_eyes`, Camarilla levels) and Chronos Matrix (`chronos_matrix`, sessions and pivots) when the strategy plans at key levels; News Analyst (`news`) and Calendar Agent (`calendar`) only when the pack shows losing trades inside a release horizon |
| `kpi:engine:15` | 15m Desk, 1H Desk (`h1`), Risk Manager, Technical Analyst, News Analyst, Projection Agent |
| macro / news topics | the `MACRO_AGENTS` seats |
| `seat:*`, `knowledge:*` | the seat concerned, Risk Manager |

- **The strategy agents are deterministic code** (`STRATEGY_AGENTS`), not model seats; their plans and records are evidence (section 3), never a voice. A "Strategy Analyst" seat that reads `GET /api/strategy-agents` would be a new seat (a new AI task in `organism.json`, kept equal to the code by `test/organism-dna.test.mjs`). Decision 4: no new seat for now.
- Seats keep their names and role text and speak **only from the pack**, not from their live data. A seat's reputation (`src/reputation.mjs`) is shown beside it as context; there is no quorum and no weighting: the owner decides.
- **The owner joins live** over the push hub (ADR-0015 phase 1): the Durable Object `PushHub` of the Nexus Worker (`workers/xauusd-nexus-dashboard/src/push-hub.mjs`, `GET /api/stream`), which the AI Worker publishes into (`src/push-hub.mjs` `publishSnapshot`, binding `PUSH_HUB`). New: a topic `council` in `PUSH_TOPICS` and `NEXUS_STREAM_TOPICS`, carrying the open session's snapshot after each step. The hub is listen-only (`webSocketMessage` does nothing), so the owner's messages go through `POST /omega/api/council` (1.1). Without the socket the page polls `GET /api/council/:id` (new, read-only) through `usePoll`.

## 3. Evidence pack

Built deterministically by the AI Worker when the session opens, before any model call; frozen for the session; hashed (sha256); stored in R2 beside the transcript (section 6). A seat's claim may cite only this pack.

**Sections for a strategy topic (e.g. the Key Level entry: both `zone_pullback` and `ENTER_LIMIT`, reported separately, decision 1):**

| Section | Source (tables and fields) | Content |
|---|---|---|
| `trades` | D1 `signal_ledger` (`id = decision:<decision_key>`, `side`, `entry`, `stop`, `tp1`, `tp2`, `status`, `exit_reason`, `sl_plus_triggered`, `sl_plus_at`, `r_tp1`, `r_tp2`, `mfe_r`, `mae_r`, `bars_held`, `ambiguous`, `trading_mode`, `entry_action`, `omega_exit`, `r_omega`) joined to `engine_decisions` (`decision_json` `$.trade.agent`, `$.trade.strategy`, `$.trade.setup`, `$.trade.action`, `$.trading_mode`, `$.context.regime_1h`, `$.context.session`, `$.strategy.atr_h1`, `$.quorum`, `$.agent_confidence`) | every resolved trade of the agent in scope |
| `exits` | computed from `trades` | count and share of target, trailed target, stop, SL+ (two definitions kept apart: the ledger's `simulateSignal`, breakeven at halfway to TP1; Omega's `simulateOmega`, the stop locked behind passed key levels, `src/omega-engine.mjs`), time, opposite, cancelled; per side, mode, 1H regime, session |
| `excursions` | `mfe_r`, `mae_r` | distributions in R, split by exit; note: 1m bars only where the 1m series reaches, else 15m (both in one bar counts as the stop) |
| `invalidation` | `plan_setups.entry`, `stop`, `atr_h1` | stop distance in 1H ATR, for stopped against target trades |
| `setups` | D1 `plan_setups` (`agent`, `pattern`, `context`, `regime`, `mode`, `at_level`, `results_json`) | the agent's setups and the plan learner's 20 grid arms on them (entry shift, stop scale) |
| `record` | plan learner state (`agents`, `walk_forward`), `suspendedAgents`, `suspendedPatterns` | the agent's record overall and per context; breaker state |
| `held` | D1 `signal_ledger_held` | decisions the no-stacking rule held back |
| `scores` | D1 `outcome_scores` (`subject = 'engine:15'`, `result`, `session`, `brier`) on the trades' bars | the 4-bar directional outcome of the same decisions |
| `executions` | D1 `ea_deals` (`signal_id`, `reason`, `source`, `opened_ms`, `closed_ms`) | real fills by signal; never money, volume or account figures (the pack is in R) |
| `calendar` | D1 `econ_releases` | releases within each losing trade's window |
| `prior` | earlier council documents on the same topic key | what was tried, and its verdict |

Other topic kinds take `outcome_scores` and `scorecard_snapshots` (KPI), `room_runs` v2 documents (seat statements), `compliance_checks`, `stuck_states`, `learned_live` and `shadow_agent_outputs` (knowledge).

**Evidence refs** (`[CONTRACT-4]`): `ev:xauusd/<source>/<id>[@<as_of>][#<field>]`, e.g. `ev:xauusd/outcome_summary/engine:15/30d@2026-11-16T12:00Z#hit_rate` or `ev:xauusd/council_pack/<pack_sha8>:exits:by_regime:trend#stop_share`. The AI Worker serves the resolver for `xauusd` refs (new, internal: `{ value, as_of }`); **it never resolves a price field** (`entry`, `stop`, `tp1`, `tp2`, levels): claims speak in R, shares, counts, ATR multiples and times. A ref that does not resolve, or whose value differs, marks the claim `verified: false` and writes `council.claim_unverified`; such a claim adds no confidence.

**Claim rules (new validator, the existing one-correction-call pattern of the rooms):**
- claims follow `council.message.v1` `claims[{ metric, value, unit, window, n, refs[], verified }]`; every claim cites at least one ref that resolves;
- every number in a claim appears in a cited row (the same test as the bundled learned pack's "its numbers in its evidence", `scripts/build-learned-knowledge.mjs`);
- invalid output is retried once, then counted as `abstain` (the contract's rule); unverified claims stay visible, marked, and count for nothing.

**Leakage.** The pack holds prices. It stays in the AI Worker, the private R2 bucket and Nexus behind Access. It never goes to the kernel (`src/platform-reports.mjs`), to Aether (decision cards' leak check, `src/decision-cards.mjs`) or to `PublicProjection` (`ANALYSIS_FORBIDDEN_KEYS`).

## 4. Session flow

States (`[CONTRACT-1]`): `proposed → convening → positions → rebuttals → synthesis → awaiting_owner → decided → handed_off`; `proposed → dismissed`; any state `→ aborted` (an error, the kill switch, the budget, or `kernel_controls.agents_enabled = 0`); `awaiting_owner → expired` after 72 hours. `owner_present` is a flag, not a state. `expired` and `aborted` never default to an option.

1. **Convening** (the convener, deterministic). The owner starts; the pack is built and hashed; the participants are selected (section 2, at most 6) and the brief written (topic, `question`, scope, pack hash, criteria template). `council.started`, `council.convened`.
2. **Positions** (10 minutes). Each participant, in parallel, one call through `callBusModel` (`src/model-call.mjs`; the room agent model with its fallback): its reading from its role, at most 3 claims with refs, a `stance` (`support`, `oppose`, `amend`, `abstain`) on the topic's question, and one question for the owner. Fewer than 3 valid positions: `aborted`.
3. **Rebuttals** (10 minutes, one round). At most 4 speakers, chosen like the Consensus Discussion: participants whose stance differs from the majority, the strongest holder of the majority, and the Risk Manager. Each answers named participants (`reply_to`) with refs, or changes stance.
4. **The owner in the discussion** (any time while the owner is present; owner decision Q6 lets the owner and users take part in Nexus). The owner writes to one participant or several; each addressed participant answers with refs, within the call budget (section 8). The owner may mark a message as a **correction** or **rating** (section 7). Owner messages are `phase: owner`, `role: owner`.
5. **Synthesis** (5 minutes). The moderator (`xauusd-moderator`, `[CONTRACT-3]`; the moderator model with its fallback) writes 2 to 5 ranked options in the contract's option shape (`option_id`, `rank`, `title`, `hypothesis`, `change`, `expected_effect`, `risk`, `confidence`, `evidence_refs`, `dissent`). One option is always `no_change` (the control). The moderator never votes; one retry on invalid output. A session over its budget goes to synthesis early. `council.synthesis_published`.
6. **Awaiting the owner.** The options are published to the platform as an inbox item (section 5) and shown in Nexus with a link to Cerebrum. The owner picks, dismisses, or lets it expire after 72 hours.

The moderator never decides; the owner's pick, made in Cerebrum, is the only decision a session makes. A Durable Object restart resumes the session from its last stored step.

## 5. Decision path

**The pick happens in Cerebrum only** (owner decision Q6, `[CONTRACT-5]`). At `awaiting_owner` the AI Worker publishes the session's options to the platform: `reports.publish`, kind `xauusd_digest`, severity `info`, `body.schema` `council_decision.v1` (the kernel's 4 reports an hour per agent apply; agent `xauusd-moderator`), over the existing `AGENTS` binding (`src/platform-reports.mjs`); the kernel shows it as an inbox item. The owner picks there: `council.decision.v1 { session_id, option_id, chosen_by: "owner:<actor>", chosen_at, owner_note, proposal_draft }`, with `proposal_draft` a `typed_proposal.v1 { kind, origin { council, option }, target, params, measurement { metric, baseline, window, success_threshold }, requires: [owner_confirm, shadow_window, owner_click_to_promote] }`. The return path of the decision to this Worker is not in the contract yet (section 9). The measurement criteria are fixed at the pick, before any measurement, and deterministic code computes the verdict; no council judges its own proposal.

**This side's change kinds** map onto the contract's `change.type`:

| This side's kind (`change.type`) | Existing path it maps onto | What is new |
|---|---|---|
| `plan_arm` (entry shift, stop scale per context) → `shadow_arm` | the plan learner's grid and referee (`walkForward`); RFC_PLAN_LEARNING step 3 applies a pick after `better_than_plan`, with the owner's approval | the council names one arm and context in advance |
| `strategy_variant` (a changed rule of an agent) → `repository_task` then `shadow_arm` | a new registry entry in `STRATEGY_AGENTS`, shadow by default in code, recorded in `strategy_plans` and measured by the plan learner (`plan_setups.agent`) | a code PR for the variant; a paired comparison of variant against incumbent on the same decisions (new; the referee's statistics reused) |
| `threshold_arm` (a strategy-engine threshold) → `shadow_arm` | the strategy replay arms (`src/strategy-replay.mjs`, D1 `strategy_replays`); promotion by owner PR to `src/strategy-engine.mjs` | the arm added to the replay set |
| `management_arm` (SL+ or trailing rule) → `shadow_arm` | the Signal Ledger's Omega simulation (`simulateOmega` in `src/signal-ledger.mjs`) replayed on the same trades | a replay of a second management rule beside the live one (new) |
| `agent_hold` (an agent back to shadow or off) → `policy_parameter` | `STRATEGY_AGENTS_OFF` in `wrangler.jsonc`, owner PR | nothing; this only reduces exposure |
| `knowledge_note` (a caution or role reminder) → `shadow_arm` | Aether's learned pack (text item) → the shadow knowledge arm (`src/shadow-knowledge.mjs`, D1 `shadow_agent_outputs`) → promotion | an Aether ingress for council notes (a change in `cryptophys-aether`; `KnowledgeIngress` has no such method today) |
| `measurement` → `vision_kpi` | none | a metric added to the evidence for the next session |

**Success criteria templates (proposed):**
- **Shadow window (owner decision Q8):** a picked change runs in shadow for **at least 14 days and at least 30 outcomes** before it can be promoted; the criteria are fixed at the pick.
- `plan_arm`, `strategy_variant`: beyond the window, at least 60 independent setups and 20 decisive ones; a one-sided sign test p < 0.05 on the older part; the newest quarter (at least 15) held out and required to agree; mean R per setup above the incumbent's; the stop-plus-SL+ share not above the incumbent's. Not met within 45 days: `not_better`.
- `threshold_arm`, `knowledge_note`: the existing rules of their path (sign test, Holm, 200-bar discovery, 100-bar holdout).

**Going live needs the owner's click** (`owner_click_to_promote`, in Cerebrum like the pick). The change itself lands as today: a flag or a promotion PR (`STRATEGY_AGENTS_LIVE`, `src/strategy-engine.mjs`, or the bundled learned pack, K9). A council-origin note must not go live through `LEARNED_AUTO_PROMOTION` (`src/learned-live.mjs`): new rule, the autonomous promotion skips items whose provenance is a council. No approve or pick button in Nexus.

**Invariants:**
- **A council never widens trading autonomy.** The validator refuses any option that touches the guardrails (`MODE_THRESHOLDS`, `QUORUM_SHARE`, the squeeze rule, the confidence floor), the witness weights, the trading mode, `TRADING_MODE`, the kill switches (`EA_SIGNALS_ENABLED`, `DECISION_ENGINE`, `OMEGA_ENGINE_ENABLED`, `SHADOW_MODE`), the Omega gates and policy (`omega_settings`, `OMEGA_POLICY_BOUNDS` in `src/omega-broker.mjs`, risk, max positions), the typed `LIVE` arm, position size, or that sets an agent live. Such a change stays an owner PR with an SSOT change, outside this feature.
- **Council output is not trusted trading evidence on its own.** Transcripts, syntheses and proposals never enter a room, a brief, the council prompt, a witness, a decision card, `model_dataset` or the learned pack directly. Only a measured verdict on market outcomes can support going live.
- **The quorum-witness boundary stays as it is.** No new witness, no weight, no change to `independentWitnesses` or the auto-tuning (`src/witness-tuning.mjs`, `src/weighting.mjs`).
- Aether's own path to Cerebrum (doctrine differences proposed to the consensus) is unchanged.

## 6. Storage (ADR-0015)

Mirrors the room run documents (`src/room-runs.mjs`, migration `0022_room_runs.sql`, `docs/RFC_ROOM_CELLS.md` §4).

**D1 `council_sessions` (new, migration `0024`), one row per session, the run document:**

| Column | Content |
|---|---|
| `session_id` | PRIMARY KEY, `cs_<uuid>` (`council.session.v1`) |
| `topic_key`, `topic_kind`, `origin` | e.g. `strategy:zone_pullback:exits`, `strategy`, `owner` or `trigger:<source>` |
| `status` | the state of section 4 |
| `opened_by` | the Access identity Omega verified |
| `seats`, `model_calls`, `fallbacks`, `tokens`, `neurons` | counts and usage |
| `pack_sha`, `pack_key`, `transcript_key` | R2 keys |
| `proposal_kind`, `proposal_status` | `none`, `shadow_running`, `better`, `not_better`, `live`, `withdrawn` |
| `opened_at`, `concluded_at`, `decided_at` | timestamps |
| `doc_version` | `council.session.v1` (`[CONTRACT-2]`) with `side: nexus`, `trigger`, `budget`, `spent`, `transcript_sha256` |
| `body_json` | brief, options, the owner's pick, the proposal with `criteria_sha`, corrections, dropped-claim counts |

Indexes `(topic_key, opened_at)` and `(status, opened_at)`. Writes: about 4 per session (open, synthesis, decision, close), each `ON CONFLICT(session_id) DO UPDATE ... WHERE status NOT IN ('decided', 'closed_no_change', 'expired', 'failed')`, so a re-delivery cannot rewrite a closed session.

**No per-step D1 working set.** The open session lives in a new Durable Object `CouncilCell` (SQLite-backed) in the AI Worker, one instance per session, after the `RoomCell` design of RFC_ROOM_CELLS §3: steps keyed `(session_id, step)` (an `ok` step is final, a failed one is replaced by its retry), a budget counter, alarms for the phase timeouts (10, 10, 5 minutes) and the 72-hour expiry. It needs a `durable_objects` binding and a `new_sqlite_classes` migration in `wrangler.jsonc` (the AI Worker binds only `PUSH_HUB` today); no new Worker. P2c's `RoomCell` is parked because it sits on the live decision path; a council does not.

**R2 `xauusd-room-transcripts`** (binding `ROOM_TRANSCRIPTS`, already bound for `src/bus-archive.mjs`):
- `councils/<yyyy>/<mm>/<dd>/<session_id>.ndjson`: every step in the room runs' step shape (`STEP_COLUMNS` of `src/room-runs.mjs`), failures included, plus owner messages, written at each milestone and at close;
- `councils/<yyyy>/<mm>/<dd>/<session_id>.pack.json`: the frozen pack.
The room runs do not write their transcripts yet (`transcript_key` is null); the council would be the first writer of this layout.

**Reads:** `GET /api/council/sessions` (D1, by index) and `GET /api/council/:id` (the cell while open, then D1 plus R2). Retention (owner decision Q4): **90 days hot** (the D1 row's full `body_json` and the cell), then **R2 only**: `body_json` is reduced to ids, hashes and the decision, and the transcript and pack stay in R2.

## 7. Audit

- **Every turn** is in the transcript: seat, step, model role, fallback used, tokens, latency, refs, validation outcome and correction calls; failed attempts kept.
- **Every owner action** (open, message, correction, revision, pick, close) is a step with the verified Access identity and time, in the transcript and in `body_json`; the pick and the resulting proposal also go to the owner's Telegram (the existing bot, as `src/ledger-alerts.mjs` sends).
- **Compliance:** `src/compliance.mjs` reads council steps like room steps (new reader), for the existing rules (no calibration talk, no order wording).
- **The proposal's life** (shadow start, verdict, owner click, withdrawal) updates `proposal_status` and adds a step to the transcript.
- **Owner corrections become labelled knowledge (ADR-0017 H3).** Platform `architecture/adr/0017-human-ai-collaboration.md`, decision 4 ("Teaching: owner corrections become knowledge (Nexus)"): every agent post, metric reading, decision and card can be corrected or rated ("reading wrong", "invalidation too tight", "good call"); corrections become labelled knowledge for Aether with high weight (decision 3, owner 2026-11-14) and feed the agents' reputation; they are deduplicated by content hash and never refused. Phase H3: corrections and ratings in Nexus become knowledge. In a council:
  - A correction or rating may target any council turn, claim or option. It is stored as `{ label: "owner_correction" | "owner_rating", session_id, step, claim_ref, seat, text, rating, evidence_refs, content_hash }`; the same content hash is stored once; nothing is refused (the guardian checks only that it carries no secret).
  - It goes to Aether as labelled knowledge with high weight (decision 3). Aether keeps it "learned", never canon (RFC_AETHER_KNOWLEDGE_GUARDIAN §0.4, §3 constraint 5); its high weight puts it first in the knowledge arm's queue (`src/shadow-knowledge.mjs`), which still measures it in shadow before it reaches a live prompt. Decision 9: it does not skip the shadow test; the owner can promote it by hand.
  - It feeds the seat's reputation (decision 4): new, a bounded owner-rating term in `src/reputation.mjs` (proposed: at most ±0.05 of the crowd weight per week, so one rating never floors or maxes a seat). The council itself still applies no weight (section 2).
- **Audit events** (`[CONTRACT-6]`, both sides): `council.proposed`, `started`, `convened`, `position_posted`, `rebuttal_posted`, `claim_unverified`, `owner_joined`, `owner_message`, `synthesis_published`, `option_chosen`, `proposal_drafted`, `dismissed`, `expired`, `aborted`. Payloads hold ids, hashes, refs and token counts only; the text is in the R2 transcript. They are kept in the session's steps; only `council_decision.v1` (section 5) travels to the kernel, within its 4 reports an hour.

## 8. Cost

**Limits (`[CONTRACT]`: "Nexus sets its own limits, no higher" than Cerebrum's):** at most 2 sessions open and 4 started per UTC day; per session at most **16 model calls**, 60 messages, 20 owner messages and USD 0.10. Over budget, the session goes to synthesis early (one call is always reserved for it).

**A session in 16 calls** (decision 5): at most 6 positions, at most 4 rebuttals, at most 4 answers to the owner, 1 synthesis, 1 retry. Owner messages beyond the answers left are recorded and shown, and the moderator reads them at synthesis; no seat answers them.

**Estimate (not measured):** with the rates in `NEURON_RATES` (`src/ai-usage.mjs`), a participant call of about 6,000 input and 600 output tokens is about 70 neurons, a moderator call of about 15,000 and 2,000 about 600; a full session is about 15 × 70 + 600 ≈ 1,650 neurons, about USD 0.02, well under the USD 0.10 cap. To be confirmed on the first sessions from `ai_usage_daily`.

**Budget and kill switch, reusing the shadow mechanisms (`src/shadow-switch.mjs`):**
- every call metered as `cfc:<schema>` in `ai_usage_daily` (`callBusModel` `meterSource`), declared in `organism.json` and shown by `GET /api/ai/logic` and the Neuron allocation page;
- a daily cap `CFC_NEURONS_PER_DAY_MAX` (proposed 8,000) and the contract's 4 sessions started a day; a breaker like `checkShadowBudget` stops new steps when the cap is reached, the session goes to `awaiting_owner` with what it has, and the owner hears it on Telegram;
- `CFC_MODE = "off"` (a Worker variable) holds every session off, and `kernel_controls.agents_enabled = 0` aborts any session; an owner switch on the Call for Councils page, audited like `shadow_switch_events`, is on the Call for Councils page (decision 7);
- council calls are not shadow calls and do not count against `SHADOW_NEURONS_PER_DAY_MAX`; the shadow arms a proposal starts (the knowledge arm) stay under the shadow budget and kill switch; strategy variants and replay arms are deterministic and cost no model call.
- **Rate limits:** the rooms share the account's Workers AI limits (SSOT: the 3021 errors, the health alert on 10+ calls lost an hour). A council step does not start within the first 3 minutes after a 15m close, and yields while a room run is open.

## 9. Shared contract with Cerebrum (`council.v1`)

The platform session's contract (`docs/design/HAIC-H0-H1.md` §4, branch `claude/haic-design`, 64062eb, relayed 2026-11-16). This side follows it as written:

| Item | Contract | This side |
|---|---|---|
| `[CONTRACT-1]` lifecycle | `proposed → convening → positions → rebuttals → synthesis → awaiting_owner → decided → handed_off`; `dismissed`; `aborted`; `expired` after 72 h; phase timeouts 10/10/5 min | section 4; the `CouncilCell`'s alarms |
| `[CONTRACT-2]` schemas | `council.message.v1`, `council.session.v1`, the option shape | messages are the cell's steps; the session is the D1 row's document (`side: nexus`) |
| `[CONTRACT-3]` roles | convener, participant, moderator (`xauusd-moderator` here), owner, viewer, recorder | the AI Worker is convener and recorder; room seats are participants; xauusd agents keep no Cerebrum council seat and no `consensus.propose` (SSOT §2) |
| `[CONTRACT-4]` evidence refs | `ev:<side>/<source>/<id>[@<as_of>][#<field>]`; a resolver per side; unverified claims add no confidence; no price levels | section 3; the resolver drops price fields |
| `[CONTRACT-5]` handoff | `council.decision.v1`, `typed_proposal.v1`; Nexus → platform by `reports.publish` (`council_decision.v1`); the pick in Cerebrum only | section 5 |
| `[CONTRACT-6]` audit events | the fourteen `council.*` events; ids, hashes, refs, token counts only | section 7 |

**Still needed from the platform:**
- **The return path of the pick** (proposed by the orchestrator, awaiting the platform's answer): this Worker pulls the decisions over the existing `AGENTS` binding (`AgentRpc`, xauusd → kernel) with a new read-only capability (e.g. `council.decisions.read`, scoped to `side: nexus`, cursored), on the hourly sweep; no new binding, the call direction stays external → platform. It acknowledges a decision by publishing `council.proposal_drafted`.
- **Live view (owner decision Q7):** the platform's ConsoleHub (server → client) for Cerebrum; Nexus keeps its own push hub. Whether Cerebrum shows a Nexus session live is the platform's choice; this side publishes nothing but the decision report.
- **Telegram** (proposed, awaiting the platform): council notices come from Cerebrum's `owner_attention` only; this Worker's bot sends none, so nothing arrives twice.

## 10. Non-goals

- No autonomous change to any live setting, plan, agent status, guardrail or Omega policy.
- No new witness, quorum input or room seat in the live rooms.
- No agent-written prices or levels: every level in an option comes from the pack or from deterministic code.
- No platform-topic councils here (Cerebrum's side); no cross-repository sessions.
- No new Worker, no new Service Binding, no change to `AGENTS` or `AETHER`.

## 11. Risks

| Risk | Guard |
|---|---|
| Narrative over evidence: fluent claims the pack does not support | refs and numbers checked against the pack; dropped claims counted; the verdict is measured, not argued |
| Overfitting to a short bad run (e.g. 20 trades) | the proposal only starts a shadow arm; criteria fixed before measurement; independent setups, holdout, sign test |
| The owner's view steering the seats (agreement bias) | openings are written before the owner speaks; dissent kept on each option; the control option always listed |
| Two SL+ definitions mixed (ledger breakeven against Omega's locked stop) | separate columns and sections in the pack |
| Name confusion with the Decision Engine council | the `cfc` prefix; the learned-pack consumer `council` untouched |
| Cost growth | per-session and per-day caps, breaker, `CFC_MODE` |
| Workers AI rate limits hurting live rooms | steps yield to room runs and avoid the 15m close |
| Price leakage | the pack never leaves the AI Worker, R2 and Nexus behind Access |

## 12. Phased rollout

- **P0: design approval** (this document): done, the owner's decisions in section 14.
- **P1: evidence only, no model call.** `src/cfc-triggers.mjs` and the pack builder; `GET /api/council/evidence?topic=` (new, read-only); suggested-topic cards on the Call for Councils page. Exit: packs for three real topics checked by the owner.
- **P2: sessions in shadow.** `CouncilCell`, `council_sessions`, R2 transcripts, the push topic, the Omega route, the validators, the budget. Options are published to the kernel; a pick in Cerebrum is stored as a would-be proposal; nothing is started. Exit: 5 sessions with no budget breach, all claims resolvable, the owner judges the syntheses useful.
- **P3: handoff to shadow arms.** `plan_arm`, `threshold_arm`, `agent_hold` first (existing paths); then `strategy_variant` (PR per variant) and `management_arm`; `knowledge_note` once Aether has its ingress. Live only by the owner's click.
- **P4: shared contract.** Replace the placeholders with `[CONTRACT-1..6]`; align names, schemas and audit events.

## 13. What this does not change

- The five Workers, the Service Bindings, `AGENTS` and `AETHER`, `host_worker`.
- The Decision Engine, its witnesses and weights, guardrails, trading modes, the 15m cadence, `GET /api/ea/signal`, the EA and Omega.
- The rooms, their rosters, prompts, budgets, `room_runs` and the scoring.
- The strategy agents' status, breakers and records; the plan learner; the shadow arms' rules and their kill switch.
- Aether's learned pack, its promotion rules for non-council items, and the doctrine path to Cerebrum.

## 14. Owner decisions

HAIC (2026-11-16, platform session): picks and the promote click in Cerebrum only; the shadow window of at least 14 days and 30 outcomes; councils started by the owner only (agents suggest); transcripts 90 days hot, then R2; ConsoleHub for Cerebrum, Nexus keeps its push hub.

This RFC (2026-11-16, relayed by the orchestrator: "1–4 setuju, 5 pakai 16 panggilan, 6 klik di Cerebrum, 7–9 setuju"; and directly in this session: "jangan ditampilkan di omega, buat menu navigator sendiri Call for Councils"):

| # | Question | Decision |
|---|---|---|
| 1 | "Key Level entry" | both `zone_pullback` and the limit entry at the key level (`ENTER_LIMIT`), reported separately in the pack |
| 2 | "SL+" | both definitions side by side; Omega's stop locked behind passed key levels is the headline, the ledger's breakeven stop beside it |
| 3 | Topics | deterministic suggestions only in P1–P2; free text later |
| 4 | A "Strategy Analyst" seat | not now; the Risk Manager and the Projection Agent read the pack |
| 5 | Calls per session | **16** (`council.v1`, Cerebrum's cap, at most USD 0.10): at most 6 participants plus the moderator, one rebuttal round (section 8); the suggestion trigger N = 20 trades and a 0.65 stop share; caps re-checked after the first five sessions; a higher cap needs their data and the owner's OK |
| 6 | The pick and the promote click | in Cerebrum; Nexus shows the status and links to the Cerebrum item; a PR merge is not the click |
| 7 | The owner's on/off switch | yes, audited like the shadow switch, on the **Call for Councils** page (the owner's later instruction moved everything of councils off the Omega page) |
| 8 | Openings before the owner joins | no |
| 9 | Owner corrections | first in the knowledge arm's queue, shadow-tested; the owner can promote one by hand |
| — | Where councils live in Nexus | their own navigator item, **Call for Councils**; nothing on the Omega page |
