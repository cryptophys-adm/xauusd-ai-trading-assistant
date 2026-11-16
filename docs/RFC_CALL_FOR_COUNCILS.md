# RFC: Call for Councils (Nexus side, xauusd)

Status: draft for owner review (2026-11-16). No code until approved.

**Owner's request (2026-11-16, translated):** the owner can call all the relevant agents into a scrum/retrospective session. The topic is either something the agents found themselves or a topic the owner sets (example: "the Key Level entry strategy often gets hit by SL or SL+"). Each agent gives its opinion and talks with the owner about what to improve. Together they decide which strategy to try and implement. The same feature will exist in Cerebrum for platform topics.

**Canonical references:** `docs/SSOT.md` (state), `docs/RFC_ROOM_CELLS.md` (run documents, ADR-0015 phase 2), `docs/RFC_STRATEGY_AGENTS.md`, `docs/RFC_PLAN_LEARNING.md`, `docs/RFC_AETHER_KNOWLEDGE_GUARDIAN.md`. Everything marked **new** does not exist in this repository today. Placeholders for the shared Cerebrum contract are marked `[CONTRACT-n]` (section 9).

## 0. Scope, names and boundary

**In scope:** a session engine in the AI Worker (`xauusd-ai-trading-assistant`), its evidence pack, its storage, a Nexus page, the owner's actions through Omega's routes, and the handoff of a chosen option to the existing shadow paths.

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
- From a new Nexus page (`#/councils`, new) with a free topic, or from a proposed topic card (1.2).
- Nexus `/api/*` is GET/HEAD only (`workers/xauusd-nexus-dashboard/src/index.ts`). Every owner action therefore goes, like the trading mode and the shadow switch, to a new route `POST /omega/api/council` (new) in `workers/xauusd-omega/src/omega.mjs`, which checks the Access identity and the same origin, then calls new `OmegaGateway` methods (`councilOpen`, `councilMessage`, `councilPick`, `councilClose`; new) in `src/index.ts`.
- The owner chooses the seats (prefilled per topic kind, section 2) and may attach an evidence scope (date range, strategy agent, pattern, trading mode).

### 1.2 Topics proposed by the system
A proposed topic is a card on the Nexus page and one Telegram line. It costs no model call; nothing runs until the owner opens it. Checked hourly in the sweep, deterministic (new: `src/cfc-triggers.mjs`):

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

- **Agents' own topics.** Room seats cannot raise a topic by free text in this design (a seat that names its own topic would also choose its own evidence). Agent-raised topics are the deterministic flags above plus, later, open `stuck_states` and repeated `compliance_checks` findings. Open question 3.
- **Rate limits:** one open proposal per topic key; a 7-day cooldown after a session on that key closes; at most 3 new proposals a day.

## 2. Participants

**Seat roster.** The real roster is generated by `src/agent-inventory.mjs` (`ROOMS`, `GET /api/agents/inventory`, 28 seats): `DESK_AGENTS` (`src/war-room.mjs`: `m15`, `news`, `technical`, `risk`, `projection`), `TF_DESKS` (`src/timeframe-threads.mjs`: `h1`, `h4`, `d1`, `news`, `technical`, `risk`, `projection`), `MACRO_AGENTS` (`src/macro-room.mjs`: `calendar`, `news`, `dollar`, `rates`, `silver`, `oil`, `correlation`), the HUD seats (`hudAgentsIn(room)` over the manifests in `src/indicator-manifests.mjs`; the dismantled R37 Funnel, GABFX Price Action, Playbook Execution and Grid Bot Protocol sit in no room and are not offered) and the moderator (`stepRole` in `src/agent-threads.mjs`).

**Seats per topic kind (prefill; the owner may add or remove; at most 8 seats besides the moderator):**

| Topic kind | Seats |
|---|---|
| `strategy:*` (e.g. the Key Level entry) | Risk Manager (`risk`), Technical Analyst (`technical`), Projection Agent (`projection`, owns the pattern knowledge), 15m Desk (`m15`, the Prophet trigger timing), Trade Management (`trade_management`, exits), The Interstellar Eyes (`interstellar_eyes`, Camarilla levels) and Chronos Matrix (`chronos_matrix`, sessions and pivots) when the strategy plans at key levels; News Analyst (`news`) and Calendar Agent (`calendar`) only when the pack shows losing trades inside a release horizon |
| `kpi:engine:15` | 15m Desk, 1H Desk (`h1`), Risk Manager, Technical Analyst, News Analyst, Projection Agent |
| macro / news topics | the `MACRO_AGENTS` seats |
| `seat:*`, `knowledge:*` | the seat concerned, Risk Manager |

- **The strategy agents are deterministic code** (`STRATEGY_AGENTS`), not model seats; their plans and records are evidence (section 3), never a voice. A "Strategy Analyst" seat that reads `GET /api/strategy-agents` would be a new seat (a new AI task in `organism.json`, kept equal to the code by `test/organism-dna.test.mjs`). Open question 4.
- Seats keep their names and role text and speak **only from the pack**, not from their live data. A seat's reputation (`src/reputation.mjs`) is shown beside it as context; there is no quorum and no weighting: the owner decides.
- **The owner joins live** over the push hub (ADR-0015 phase 1): the Durable Object `PushHub` of the Nexus Worker (`workers/xauusd-nexus-dashboard/src/push-hub.mjs`, `GET /api/stream`), which the AI Worker publishes into (`src/push-hub.mjs` `publishSnapshot`, binding `PUSH_HUB`). New: a topic `council` in `PUSH_TOPICS` and `NEXUS_STREAM_TOPICS`, carrying the open session's snapshot after each step. The hub is listen-only (`webSocketMessage` does nothing), so the owner's messages go through `POST /omega/api/council` (1.1). Without the socket the page polls `GET /api/council/:id` (new, read-only) through `usePoll`.

## 3. Evidence pack

Built deterministically by the AI Worker when the session opens, before any model call; frozen for the session; hashed (sha256); stored in R2 beside the transcript (section 6). A seat's claim may cite only this pack.

**Sections for a strategy topic (e.g. the Key Level entry, see open question 1 for which agent that is):**

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

**Evidence refs** (`[CONTRACT-4]`; proposed until then): `ev:<pack_sha8>:<section>:<row_key>[:<field>]`, e.g. `ev:3fa1c2d0:trades:decision:OANDA:XAUUSD:15:<open ms>:mae_r`. Aggregates get their own row keys (`exits:by_regime:<regime>`).

**Claim rules (new validator, the existing one-correction-call pattern of the rooms):**
- every claim cites at least one ref that exists in the pack;
- every number in a claim appears in a cited row (the same test as the bundled learned pack's "its numbers in its evidence", `scripts/build-learned-knowledge.mjs`);
- a claim that still fails after one correction call is dropped and counted on the session document.

**Leakage.** The pack holds prices. It stays in the AI Worker, the private R2 bucket and Nexus behind Access. It never goes to the kernel (`src/platform-reports.mjs`), to Aether (decision cards' leak check, `src/decision-cards.mjs`) or to `PublicProjection` (`ANALYSIS_FORBIDDEN_KEYS`).

## 4. Session flow

States (`[CONTRACT-1]`; proposed): `proposed → open → openings → rebuttals → qa → synthesis → awaiting_owner → decided | closed_no_change | expired | failed`.

1. **Open.** The owner opens; the pack is built; the brief is written (topic, scope, seats, pack hash, criteria template).
2. **Openings.** Each seat, in parallel, one call through `callBusModel` (`src/model-call.mjs`; the room agent model with its fallback): its reading of the topic from its role, at most 3 claims with refs, a lean (`improve`, `keep`, `unclear`) and one question for the owner.
3. **Rebuttals.** At most 8 speakers, chosen like the Consensus Discussion: seats whose lean differs from the majority, the strongest holder of the majority, and the Risk Manager. Each answers named seats with refs, or concedes (`conceded: true`).
4. **Q&A with the owner.** The owner writes to one seat, several, or all. Each addressed seat answers with refs (at most 2 seats per owner message, at most 12 owner messages). The owner may mark a message as a **correction** of a claim (its ref), which the seat must take into account (section 7).
5. **Synthesis.** The moderator (the moderator model, with its fallback) writes a ranked list of 2 to 5 options. Each option:
   - `title`, `hypothesis` (what causes the problem, in the pack's terms);
   - `change`: a typed kind from section 5 with its target and parameters;
   - `expected_effect`: the metric, its direction and an estimate taken from the pack (e.g. the grid arm `e0.1@s0.8` replayed on these setups);
   - `risk`, `confidence` (0 to 1), `evidence` (refs), `dissent` (which seats disagree);
   - `success_criteria`: proposed, from the kind's template.
   One option is always **"no change"** (the control). The moderator's answer is validated (kinds, refs, numbers) with one correction call, as room conclusions are.
6. **Owner.** Picks one option, asks for one revision of the synthesis, or closes without a change. A session idle for 24 hours expires.

The moderator never decides; the owner's pick is the only decision a session makes.

## 5. Decision path

The owner's pick becomes a **typed proposal** stored in the session document: `{ kind, target, change, criteria, window, criteria_sha }`. The criteria are fixed when the owner picks (`criteria_sha`), before any measurement, and deterministic code computes the verdict; no council judges its own proposal.

| Kind | Existing path it maps onto | What is new |
|---|---|---|
| `plan_arm` (entry shift, stop scale per context) | the plan learner's grid and referee (`walkForward`); RFC_PLAN_LEARNING step 3 applies a pick after `better_than_plan`, with the owner's approval | the council names one arm and context in advance |
| `strategy_variant` (a changed rule of an agent) | a new registry entry in `STRATEGY_AGENTS`, shadow by default in code, recorded in `strategy_plans` and measured by the plan learner (`plan_setups.agent`) | a code PR for the variant; a paired comparison of variant against incumbent on the same decisions (new; the referee's statistics reused) |
| `threshold_arm` (a strategy-engine threshold) | the strategy replay arms (`src/strategy-replay.mjs`, D1 `strategy_replays`); promotion by owner PR to `src/strategy-engine.mjs` | the arm added to the replay set |
| `management_arm` (SL+ or trailing rule) | the Signal Ledger's Omega simulation (`simulateOmega` in `src/signal-ledger.mjs`) replayed on the same trades | a replay of a second management rule beside the live one (new) |
| `agent_hold` (an agent back to shadow or off) | `STRATEGY_AGENTS_OFF` in `wrangler.jsonc`, owner PR | nothing; this only reduces exposure |
| `knowledge_note` (a caution or role reminder) | Aether's learned pack (text item) → the shadow knowledge arm (`src/shadow-knowledge.mjs`, D1 `shadow_agent_outputs`) → promotion | an Aether ingress for council notes (a change in `cryptophys-aether`; `KnowledgeIngress` has no such method today) |
| `measurement` | none | a metric added to the evidence for the next session |

**Success criteria templates (proposed):**
- `plan_arm`, `strategy_variant`: at least 60 independent setups and 20 decisive ones; a one-sided sign test p < 0.05 on the older part; the newest quarter (at least 15) held out and required to agree; mean R per setup above the incumbent's; the stop-plus-SL+ share not above the incumbent's. Window at most 30 days, then `not_better`.
- `threshold_arm`, `knowledge_note`: the existing rules of their path (sign test, Holm, 200-bar discovery, 100-bar holdout).

**Going live needs the owner's click.** Today the click is the merge of the promotion PR (an owner PR for `STRATEGY_AGENTS_LIVE`, `src/strategy-engine.mjs`, or the bundled learned pack, K9). A council-origin note must not go live through `LEARNED_AUTO_PROMOTION` (`src/learned-live.mjs`): new rule, the autonomous promotion skips items whose provenance is a council. An "approve" button on the Omega page would be new (open question 6).

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
| `session_id` | PRIMARY KEY, `cfc-<opened ms>-<topic hash 6>` |
| `topic_key`, `topic_kind`, `origin` | e.g. `strategy:zone_pullback:exits`, `strategy`, `owner` or `trigger:<source>` |
| `status` | the state of section 4 |
| `opened_by` | the Access identity Omega verified |
| `seats`, `model_calls`, `fallbacks`, `tokens`, `neurons` | counts and usage |
| `pack_sha`, `pack_key`, `transcript_key` | R2 keys |
| `proposal_kind`, `proposal_status` | `none`, `shadow_running`, `better`, `not_better`, `live`, `withdrawn` |
| `opened_at`, `concluded_at`, `decided_at` | timestamps |
| `doc_version` | `cryptophys.council-session.v1` (`[CONTRACT-2]`) |
| `body_json` | brief, options, the owner's pick, the proposal with `criteria_sha`, corrections, dropped-claim counts |

Indexes `(topic_key, opened_at)` and `(status, opened_at)`. Writes: about 4 per session (open, synthesis, decision, close), each `ON CONFLICT(session_id) DO UPDATE ... WHERE status NOT IN ('decided', 'closed_no_change', 'expired', 'failed')`, so a re-delivery cannot rewrite a closed session.

**No per-step D1 working set.** The open session lives in a new Durable Object `CouncilCell` (SQLite-backed) in the AI Worker, one instance per session, after the `RoomCell` design of RFC_ROOM_CELLS §3: steps keyed `(session_id, step)` (an `ok` step is final, a failed one is replaced by its retry), a budget counter, alarms for the step deadlines and the 24-hour expiry. It needs a `durable_objects` binding and a `new_sqlite_classes` migration in `wrangler.jsonc` (the AI Worker binds only `PUSH_HUB` today); no new Worker. P2c's `RoomCell` is parked because it sits on the live decision path; a council does not.

**R2 `xauusd-room-transcripts`** (binding `ROOM_TRANSCRIPTS`, already bound for `src/bus-archive.mjs`):
- `councils/<yyyy>/<mm>/<dd>/<session_id>.ndjson`: every step in the room runs' step shape (`STEP_COLUMNS` of `src/room-runs.mjs`), failures included, plus owner messages, written at each milestone and at close;
- `councils/<yyyy>/<mm>/<dd>/<session_id>.pack.json`: the frozen pack.
The room runs do not write their transcripts yet (`transcript_key` is null); the council would be the first writer of this layout.

**Reads:** `GET /api/council/sessions` (D1, by index) and `GET /api/council/:id` (the cell while open, then D1 plus R2). Retention: none at first; revisit with ADR-0015 phase 5.

## 7. Audit

- **Every turn** is in the transcript: seat, step, model role, fallback used, tokens, latency, refs, validation outcome and correction calls; failed attempts kept.
- **Every owner action** (open, message, correction, revision, pick, close) is a step with the verified Access identity and time, in the transcript and in `body_json`; the pick and the resulting proposal also go to the owner's Telegram (the existing bot, as `src/ledger-alerts.mjs` sends).
- **Compliance:** `src/compliance.mjs` reads council steps like room steps (new reader), for the existing rules (no calibration talk, no order wording).
- **The proposal's life** (shadow start, verdict, owner click, withdrawal) updates `proposal_status` and adds a step to the transcript.
- **Owner corrections become labelled knowledge (ADR-0017 H3).** ADR-0017 and its item H3 could not be found in this repository or in the local platform checkout on 2026-11-16; the text below is this side's reading of the request and must be checked against H3 once cited (`[CONTRACT-6]`).
  - A correction is stored as `{ label: "owner_correction", session_id, claim_ref, seat, text, evidence_refs }`.
  - It reaches prompts only as an Aether text item on the existing learned path: labelled "learned", never canon (RFC_AETHER_KNOWLEDGE_GUARDIAN §0.4 and §3, constraint 5), shadow-tested by the knowledge arm, promoted by the owner.
  - Per seat, corrections are counted on the Nexus page beside its reputation; they change no weight.
- Audit events for the platform: `[CONTRACT-6]`.

## 8. Cost

**Model calls per session (caps):** openings ≤ 8; rebuttals ≤ 8; owner Q&A ≤ 24 (12 owner messages × 2 seats); synthesis 1, plus one correction and one revision; with fallbacks and correction calls inside the same cap: **at most 48 calls** (`CFC_MAX_CALLS_PER_SESSION`, new).

**Estimate (not measured):** with the rates in `NEURON_RATES` (`src/ai-usage.mjs`), a seat call of about 6,000 input and 600 output tokens is about 70 neurons, a moderator call of about 15,000 and 2,000 about 600; a full session is about 40 × 70 + 3 × 600 ≈ 4,600 neurons, about USD 0.05 above the 10,000 free neurons a day. To be confirmed on the first sessions from `ai_usage_daily`.

**Budget and kill switch, reusing the shadow mechanisms (`src/shadow-switch.mjs`):**
- every call metered as `cfc:<schema>` in `ai_usage_daily` (`callBusModel` `meterSource`), declared in `organism.json` and shown by `GET /api/ai/logic` and the Neuron allocation page;
- a daily cap `CFC_NEURONS_PER_DAY_MAX` (proposed 15,000) and `CFC_MAX_SESSIONS_PER_DAY` (proposed 3); a breaker like `checkShadowBudget` stops new steps when the cap is reached, the session goes to `awaiting_owner` with what it has, and the owner hears it on Telegram;
- `CFC_MODE = "off"` (a Worker variable) holds every session off; an owner switch on the Omega page, audited like `shadow_switch_events`, is optional (open question 7);
- council calls are not shadow calls and do not count against `SHADOW_NEURONS_PER_DAY_MAX`; the shadow arms a proposal starts (the knowledge arm) stay under the shadow budget and kill switch; strategy variants and replay arms are deterministic and cost no model call.
- **Rate limits:** the rooms share the account's Workers AI limits (SSOT: the 3021 errors, the health alert on 10+ calls lost an hour). A council step does not start within the first 3 minutes after a 15m close, and yields while a room run is open.

## 9. Shared contract with Cerebrum (placeholders)

The platform session drafts a shared contract. Until it lands, every item below is this side's proposal and is replaced by the contract.

| Placeholder | What it defines | This side proposes / needs |
|---|---|---|
| `[CONTRACT-1]` session lifecycle | states and transitions | the states of section 4; an `expired` state; a session that never trades |
| `[CONTRACT-2]` message schema | envelope of a turn | `{ session_id, step, seat, role, kind, text, claims[{text, refs[]}], lean, conceded, model_role, fallback_used, tokens, at }`; schema version string |
| `[CONTRACT-3]` roles | owner, moderator, seat, observer | seats are this repository's room seats; xauusd agents stay tier 1 with no Cerebrum council seat and no `consensus.propose` (SSOT §2) |
| `[CONTRACT-4]` evidence-ref format | ref grammar and resolution | refs that resolve only inside the AI Worker; the platform sees ref ids and section names, never a price or a pack row |
| `[CONTRACT-5]` decision-to-proposal handoff | how a pick becomes work | xauusd proposals stay local (section 5); a platform-level proposal from an xauusd session goes only through Aether's existing path to the consensus |
| `[CONTRACT-6]` audit events | event names, where they land | event names for open, pick, proposal, verdict, live; if they travel as kernel reports they carry no price and fit the kernel's 4 reports an hour per agent |

**What this side needs from the contract:** the six items above; whether Cerebrum shows xauusd sessions (today the platform reads this Worker only through `GET /api/decisions`; a new platform read is an SSOT §2 change); whether the owner's Telegram notices for councils come from this Worker's bot or from Cerebrum (`OwnerNotifier` today is inbound only); and the text of ADR-0017 H3.

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

- **P0: design approval** (this document). Owner answers the open questions.
- **P1: evidence only, no model call.** `src/cfc-triggers.mjs` and the pack builder; `GET /api/council/evidence?topic=` (new, read-only); proposed-topic cards on the Nexus page. Exit: packs for three real topics checked by the owner.
- **P2: sessions in shadow.** `CouncilCell`, `council_sessions`, R2 transcripts, the push topic, the Omega route, the validators, the budget. A pick is stored as a would-be proposal; nothing is started. Exit: 5 sessions with no budget breach, all claims resolvable, the owner judges the syntheses useful.
- **P3: handoff to shadow arms.** `plan_arm`, `threshold_arm`, `agent_hold` first (existing paths); then `strategy_variant` (PR per variant) and `management_arm`; `knowledge_note` once Aether has its ingress. Live only by the owner's click.
- **P4: shared contract.** Replace the placeholders with `[CONTRACT-1..6]`; align names, schemas and audit events.

## 13. What this does not change

- The five Workers, the Service Bindings, `AGENTS` and `AETHER`, `host_worker`.
- The Decision Engine, its witnesses and weights, guardrails, trading modes, the 15m cadence, `GET /api/ea/signal`, the EA and Omega.
- The rooms, their rosters, prompts, budgets, `room_runs` and the scoring.
- The strategy agents' status, breakers and records; the plan learner; the shadow arms' rules and their kill switch.
- Aether's learned pack, its promotion rules for non-council items, and the doctrine path to Cerebrum.

## 14. Open questions for the owner

1. "Key Level entry": the default agent `zone_pullback` (the plan at the Key Level Agent's zones), the limit entry at the key level (`ENTER_LIMIT`), or both?
2. Does "SL+" in the example mean the ledger's breakeven stop, Omega's stop locked behind passed key levels, or any exit at a moved stop?
3. Should seats be able to raise topics in free text, or only through the deterministic flags of 1.2?
4. Add a new "Strategy Analyst" seat that reads the strategy agents' registry and records, or leave strategy to the Risk Manager and Projection Agent?
5. The proposed thresholds and caps (N = 20 trades and a 0.65 stop share; 48 calls a session; 15,000 neurons and 3 sessions a day).
6. Is the merge of the promotion PR the "click", or do you want an approve button on the Omega page (new, audited)?
7. An owner on/off switch for councils on the Omega page, or the Worker variable only?
8. Should a proposed topic ever run its openings before you join, so the session is ready when you open it (costs calls without you)?
