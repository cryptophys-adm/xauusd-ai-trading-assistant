# RFC: Strategy Recommendation / Armed (XAUUSD)

Status: P2 built and live (2026-11-17, see below); design decided (owner's answers 2026-11-16, "1–10 setuju", section 18). Platform ADR-0020 is merged and in effect (the owner's `merge_owner_change` click `cns_7ed29426`, 2026-11-17 01:08 UTC; platform main `e051489`). No code until the owner starts a phase; P2 and P3 stay behind `STRATEGY_ARM_MODE` and the owner's start.

**Built and live (owner 2026-11-17, relayed and confirmed in the session: "Ya, benar semua"; P2 started, live directly,
`STRATEGY_ARM_MODE` "live").** Two corrections to this design, by the owner:
- **Nothing armed is AUTO, not "no position"** (verbatim: "jika tidak ada strategy yang di-Armed maka kembali ke asal
  pakai semua strategy dan wajib memilih strategy terbaik dengan tingkat confidence dan confluence tertinggi"). With 1
  to 3 armed, only they may open and close their own positions; with none armed every live strategy may, but each entry
  is ONE strategy, the best.
- **The best is chosen by a score**, the owner's choice in the session: `score = confidence × confluence`, measured
  inputs only (`pickStrategy`, `src/decision-engine.mjs`). `confidence` is the agent's own confidence on the side
  (`agentConfidence`, at least `MIN_CONFIDENCE`); `confluence` is the mean of three measured agreements with its plan:
  its entry at a key level now (1 or 0), the quorum's share on the side, and the strategy engine's multi-timeframe
  alignment on the side. A tie goes to the better R of the trade, then the default agent. The losing candidates and
  their scores are kept in the decision record (`selection`) and named on the Telegram decision line. The same rule
  picks among 2 or 3 armed strategies. The council's own strategy choice no longer decides the agent while the arm
  layer is live.
- Built now: `src/strategy-arm.mjs` (D1 `strategy_arm_state`, `strategy_arms`, append-only `strategy_arm_events`; KV
  `strategy-arms:v1`; at most 3, atomic, idempotent by `request_id`, `expected_version`), the arm step in `decide`
  (`armed_conflict`, `none` → AUTO, an unreadable arm state holds the entry), the signal-time gate (`applyArmGate`:
  `strategy_disarmed`, `strategy_arm_unknown`; `arm_mode`, `armed`), Omega's confidence-drop close only for an armed
  strategy while any is armed (the Decision Engine's overrides unchanged), the auto-disarm on the kill switch
  (`OmegaGateway.setControl`, `EA_SIGNALS_ENABLED` "false") and the daily loss floor (`dailyLossHit` in `bridgeSync`),
  `GET`/`POST /omega/api/strategy-arm` (a person, same origin; `Sec-Fetch-Site` checked when present) and the Telegram
  lines. The 5m Position Manager keeps managing open positions whatever the arm state.
- Owner-only check (§11.3, owner 2026-11-17 "Ya, semua, live"): built. `verifyAccessJwt` returns the Access `sub`;
  the Omega route refuses (`403 owner_only`) any sub other than `OWNER_ACCESS_SUB`, and `setStrategyArm` checks
  `actor_sub` again in the AI Worker; the page hides the button when `can_arm` is false. Bootstrap: the owner's sub is
  not known before the code exists, so while the var is unset the check reads `unset` (the route stays as it was:
  Access admits only the owner) and each visitor's sub is recorded once in `omega_events` (`owner_sub_seen`); a
  follow-up PR sets `OWNER_ACCESS_SUB` in both Workers' `wrangler.jsonc` from that record. The system's auto-disarm
  never needs a sub. Set on 2026-11-17 from the one `owner_sub_seen` row (10:33 UTC, the owner's Access identity, the
  only visitor), so the check now reads `owner` or `not_owner`.
- §5 gates: built. `planIntents` (`src/omega-engine.mjs`), while the signal carries `arm_mode` (the arm is live),
  refuses an entry with `strategy_has_position` (an Omega position whose strategy, from its open intent, is the
  signal's `trade_agent`; an unattributed one counts as `zone_pullback`) and `opposing_position` (an Omega position on
  the other side, open or being closed this sync; manual positions do not count). They come after `max_positions`
  and `same_side_unprotected`, which still hold.
- Attribution and migration: built. `ea_deals.strategy` (a run-time column, as `source`) is filled once, when a deal is
  first stored, from the Omega open intent whose `result.ticket` is the deal's `position_ticket`
  (`src/ea-execution.mjs` `dealStrategy`). `migrations/0025_strategy_arm.sql` records the three `strategy_arm_*`
  tables, statement for statement the run-time schema (a test holds them equal).
- Platform record (§10): built, `src/strategy-arm-relay.mjs` on the 5-minute ledger step. One `xauusd_digest` report
  from `xauusd-risk-manager`, `body.schema` `strategy_arm.v1`, at most one per 30 minutes (the agent's 4 an hour are
  shared with the health alerts and the EA relay, so a burst travels together, RFC "batched beyond the budget"). The
  body is `{ schema, mode, armed, armed_count, max, items }`, `items` oldest first: arm events `{ event: "armed" |
  "disarmed", strategy_id, reason, armed_count, at, audit_ref }` and, per platform ADR-0020 Amendment 1 (relayed
  2026-11-17), each pick `{ event: "picked", mode: "auto" | "armed", strategy_id, confidence, confluence, score,
  decision_key, at }`. Severity `warning` when an item is an auto-disarm. The cursor (KV `strategy-arm:relay`, not a D1
  table) moves only on success; a rate limit or a transport failure is retried after 15 minutes; another kernel
  denial is final and logged (`strategy_arm_relay_denied`). Doctrine facts: `omega.strategy_arm_required` and
  `omega.max_armed_strategies` (the Omega seat's prefix, not `execution.*`).
- Recommendation cards (§3): built, `src/strategy-recommendation.mjs`. On the 5-minute ledger step (after the plan
  learner and the breaker), at most every 15 minutes, into KV `strategy-recommendations:v1`; `GET /api/strategy-agents`
  adds each agent's `card`, `recommendation` and `arm` from KV (no D1 query on the page's poll). A card: `record` and
  the present context's record (the newest `plan_setups.context`), `r_dist` (control arm `e0@s1`, buckets ≤ −1, (−1, 0),
  [0, 1), [1, 2), ≥ 2), `exits` (the last 20 closed ledger trades per agent joined to `$.trade.agent`: Omega's stop
  and locked-stop shares, the ledger's breakeven share), `executed` (Omega open intents done; `ea_deals` with
  `source = 'omega'` by `strategy`, counted once per deal ticket, win share), `breaker`, `arm`, and `recommendationOf`
  with every rule, its value and its `ev:xauusd/...` ref. No price, money or volume field. Not built: `verdicts`
  (walk-forward and council proposals, "shown when present").
- `verdicts` and the council auto-arm (owner 2026-11-17, relayed: "council boleh langsung arm/disarm otomatis jika
  owner mengaktifkan mode auto"; confirmed in the session: "Setuju, kunci manual permanen"): built,
  `src/strategy-council.mjs`. Once a UTC day per strategy: a walk-forward on `plan_setups`' control arm (pass: >= 30
  setups, mean >= +0.10R, bootstrap 2.5% bound > 0, the latest 30% (>= 10) >= 0; fail: >= 15 setups with mean < 0, or
  the latest 30% < 0) and a council proposal (arm / keep / disarm; one model call only where the facts allow a change,
  the answer clamped to those options; meter `strategy_council`, `STRATEGY_COUNCIL_DAILY_USD` 1). Shown on the cards
  (`verdicts`). The council acts only while the code ceiling `STRATEGY_COUNCIL_ARM` is "allowed" (set after platform
  ADR-0020 Amendment 2 merged, 2026-11-17, platform main 6df9a34) AND the owner's Nexus toggle (D1 `strategy_council_state`, owner-only route
  `POST /omega/api/strategy-council`) is on. Guards: max 3 armed, one change per strategy per UTC day, no arm on a day
  the system auto-disarmed or while an arm is blocked, never a pinned strategy (the owner's manual arm or disarm pins
  it in `strategy_arm_pins` until the owner unpins it, `POST /omega/api/strategy-arm/unpin`), nothing on a council
  failure. Each council change: an arm event (actor and reason `council`), its evidence in `strategy_council_runs`, a
  Nexus Telegram line with the council's reason, and `strategy_arm.v1` (`council_auto`).
- Everything in this RFC's build list is now built.
- ADR-0020 says a trading action needs the owner's click per action or as a standing arm of one strategy. AUTO trades
  with nothing armed; this record reads Omega's typed `live_armed` (a real account) plus this owner decision as the
  standing authorization for AUTO. If the platform reads ADR-0020 otherwise, it needs an amendment there.

**Owner's request (2026-11-16):** on the Strategy Agents page, one recommendation per strategy with an **Armed**
button; an armed strategy is what the Signal Engine and Omega use for entry and close, still within the Decision
Engine (announced in `docs/RFC_CALL_FOR_COUNCILS.md` §5, "Downstream").

**Owner's decisions (2026-11-16, verbatim):** "1b, 2tidak, maks 3strategi, ya arm disarm cukup 1 click, jika tidak
dipilih maka no position, ya..". This design follows them:
1. **1b:** the Armed button acts directly in Nexus, on the Strategy Agents page, one per strategy, not through a
   Cerebrum confirmation. It has the protections of a Cerebrum approval: the owner's Cloudflare Access identity
   (the owner only, not approvers or operators), CSRF protection, server-side authorization, and an append-only
   audit event for every arm and disarm.
2. **2 tidak:** no shadow prerequisite. A strategy can be armed without the 14-day / 30-outcome window of the
   councils. Its available track record is shown next to the button as information, never as a gate.
3. **Max 3:** at most 3 strategies armed at once.
4. **One click:** arm and disarm are one click each, with no typed confirmation. Auto-disarm happens when the
   trading kill switch fires or the daily loss limit is hit. **No strategy armed means no new position**, and that
   is the default.
5. **The veto stays:** an armed strategy only proposes entry and close to the Signal Engine and Omega. Guardrails,
   quorum witnesses and risk limits still apply, and the Decision Engine may refuse.

**Constitution.** Today's constitution line "a trading action needs the owner's click" is amended by platform
**ADR-0020 "Standing trading authorization (arm)"**, the governing decision for this feature. It was drafted on the
platform's Forge branch `claude/strategy-arm-adr` (`bab0b26`) and **merged by the owner's click on 2026-11-17 at 01:08
UTC** (`merge_owner_change` `cns_7ed29426`, platform main `e051489`, relayed by the orchestrator). The constitution's
core line now reads: *"Never move funds; a trading action needs the owner's click, given per action or as a standing
arm of one strategy (at most 3 armed, auto-disarmed on the kill switch or the daily loss limit, Decision Engine veto
kept)."* The guards it writes in are:
- "never move funds", unchanged;
- the Decision Engine keeps its veto;
- at most 3 armed;
- auto-disarm on the trading kill switch or the daily loss limit;
- no strategy armed means no new positions.

The HAIC Q6 exception (arm and disarm in Nexus only, not in Cerebrum) is recorded in platform HAIC §7.2. Arming is
therefore the owner's standing click for that strategy's entries and closes. ADR-0020 is merged, so the P0 precondition
holds; each phase still starts only on the owner's word. The full text of ADR-0020 and HAIC §7.2 lives in the platform
repository; the core line above is as relayed. Every arm and disarm keeps ADR-0020's guards: the owner's identity only,
CSRF (same origin, JSON), an audit row, no fund movement, the Decision Engine veto, at most 3 armed, the auto-disarms,
a disarm that always works, and no widening of the external ceiling.

**Canonical references:** `docs/SSOT.md` ("Strategy agents", "Decision Engine", "MT5 Expert Advisor", "Omega broker
engine"), `docs/RFC_STRATEGY_AGENTS.md`, `docs/RFC_STRATEGY_EXECUTION.md`, `docs/RFC_PLAN_LEARNING.md`,
`docs/RFC_OMEGA_5M_EXECUTION.md`, `docs/RFC_ROOM_CELLS.md` (ADR-0015), `docs/RFC_CALL_FOR_COUNCILS.md`. Everything
marked **new** does not exist in this repository today.

**Names.** There is no module called "Signal Engine". In the owner's words it is the EA signal: `eaSignal` /
`eaSignalFromDecision` / `managementFields` in `src/ea-signal.mjs`, served at `GET /api/ea/signal`, and read by
Omega in `bridgeSync` (`src/omega-broker.mjs`). **"Strategy arm"** in this document is not Omega's existing
**live arm** (`live_armed`, the typed `LIVE` on the Omega page, needed for a real account). A real account needs
both. It is also not the council's `shadow_arm` (an experimental arm in a measurement).

## 1. What exists today

- **Strategy agents** (`src/strategy-agents.mjs`):
  - 13 agents in `STRATEGY_AGENTS`, each with a status `live`, `shadow` or `off` (`agentStatuses`).
  - The status comes from `STRATEGY_AGENTS_LIVE`, `STRATEGY_AGENTS_OFF` and `STRATEGY_AGENTS_MODE`. In production
    all 13 are live.
  - `zone_pullback` (`DEFAULT_AGENT`) is always live.
  - The breaker (`suspendedAgents`, `AGENT_BREAKER.min_setups` 30) turns a live agent with a negative record back
    to shadow. `syncAgentBreaker` (KV `strategy-agents:suspended:v1`) tells Telegram.
  - Patterns have their own breaker (`suspendedPatterns`, `PATTERN_BREAKER` 15).
- **What "live" means today, three things at once:**
  1. the agent's voice counts in the quorum witness `STRATEGY_AGENTS` (`agentsConsensus`, `agentSpeaks`);
  2. the council may choose its plan;
  3. with `STRATEGY_EXECUTION` on, `decide` (`src/decision-engine.mjs`) trades only the plan of a speaking agent:
     the council's choice, else the strongest voice. It holds WAIT with `overruled.by = "strategy_agents"` when
     no agent speaks or the agents' lean is against the stance (`LEAN` 0.15). The trade carries `trade.agent`.
- **Signal** (`src/ea-signal.mjs`):
  - `managementFields` adds `strategy_execution`, `trade_agent`, `agent_conf` and `agent_conf_prev`.
  - `entryTriggerFor` holds a market entry until its confirmation candle.
  - `kill` comes from `EA_SIGNALS_ENABLED = "false"` (`kill_source` `env`) or the Omega control `killed`
    (`setControl` in `src/ea-execution.mjs`, KV `ea:control`, D1 `ea_control_events`).
- **Omega** (`planIntents`, `strategyExits` and `manageIntents` in `src/omega-engine.mjs`; `bridgeSync` in
  `src/omega-broker.mjs`, every 5 s):
  - The open intent `open:<issued_ms>:<B|S>` is made once per signal and records `strategy` (`signal.trade_agent`).
  - `positionAgents` maps each open position's intent id to its agent, read from `omega_intents`.
  - The exits are `close_all` on kill, `opposite`, `lean_flip` (every system position against a fresh power beyond
    ±0.15), `confidence_drop` (the position's own agent), `opposite_5m`, `power_reversal` and the key-level SL+ and
    trailing TP.
  - The gates are:
    - `max_positions` (`OMEGA_DEFAULTS` 1; settings 1 to 5; `OMEGA_POLICY_BOUNDS` 1 to 3);
    - `same_side_unprotected`;
    - `max_daily_loss_pct` 2 (`daily_loss_limit`) and the daily risk budget (`openRiskAtStops`, `daily_risk_budget`);
    - `max_signal_age_ms` 10 min;
    - `EXECUTOR_MAX_AGE_MS` 60 s (`executor_stale`);
    - blackout, pause, `live_not_armed`, spread and rollover.
- **The Signal Ledger** (`src/signal-ledger.mjs`):
  - It records one row per decision trade (`ingestDecision`, `source = 'decision'`, one open per side).
  - It keeps the ledger's breakeven (`sl_plus_triggered`, at halfway to TP1) and Omega's simulation (`simulateOmega`
    v3: `omega_exit` `sl_plus` = the stop locked behind passed key levels, `r_omega`).
  - It has no agent column. The agent is read through `engine_decisions.decision_json` `$.trade.agent`.
- **Records:**
  - the plan learner's `agentRecords` (`src/plan-learning.mjs`, KV `plan-learning:state:v1`): setups, mean R,
    fill, target and stop rates, per context and per pattern;
  - `GET /api/strategy-agents` (`src/index.ts`);
  - the Nexus page `#/strategy` (`workers/xauusd-nexus-dashboard/ui/src/pages/Strategy.tsx`, component `Registry`).
- **Writes from Nexus.**
  - Nexus `/api/*` is GET/HEAD only (`workers/xauusd-nexus-dashboard/src/index.ts`).
  - Every change a person makes goes to `/omega/api/*` (the Omega Worker, `workers/xauusd-omega/src/omega.mjs`).
  - There, `verifyAccessJwt` checks the Access JWT, and `personJson` refuses a service token, a different `Origin`
    and a body that is not JSON.
  - The Omega Worker then calls `OmegaGateway` (`src/index.ts`) over the `OMEGA` binding. Examples:
    - `POST /api/trading-mode` → `setTradingMode` (Telegram on each change);
    - `POST /api/shadow-mode` → `setShadowMode` (D1 `shadow_switch_events`).
  - **No route checks that the person is the owner:** any Access user (`identity.type === "user"`) may control.

## 2. Armed: a new layer, not a replacement for "live"

**Proposal:** armed is a new execution layer on top of `live`. `STRATEGY_AGENTS_LIVE` keeps meaning *heard*: a
witness voice, a council option and a measured plan. **Armed** means *may open and own positions*.

| | live (unchanged) | armed (new) |
|---|---|---|
| Set by | owner PR (`STRATEGY_AGENTS_LIVE` / `_OFF`), the breaker | the owner's click in Nexus |
| Effect | voice in the `STRATEGY_AGENTS` witness, a council option | its plan may become an Omega entry it owns |
| Quorum | yes | **no**: arming never changes a status, a voice or a weight |

Why not replace "live":
- Arming must not move the quorum, which decides the side. If it did, the owner's click would weigh in the Decision
  Engine's choice of side, and the witness boundary would break (`docs/RFC_CALL_FOR_COUNCILS.md` §5 invariants).
- Unarmed live agents keep speaking and keep being measured, so their track record grows while they are not armed.

What changes:
- **`zone_pullback` no longer trades by default.** "Always live" stays true. It trades only when armed.
- **Only an agent that can speak can be armed.** A `shadow` or `off` agent cannot be armed: it cannot speak, so it
  could never trade.
- **`STRATEGY_EXECUTION = "off"`:** the trade's agent is `trade.strategy ?? zone_pullback`, and it executes only if
  that agent is armed.
- **`DECISION_ENGINE = "off"`:** the H1 decision has no agent, so nothing executes while the arm layer is live
  (open question Q5).
- **New flag `STRATEGY_ARM_MODE`** (AI Worker var, new): `off` (default in code: today's behaviour, the arm state is
  not read), `shadow` (recorded and shown, not acted on) or `live`.

## 3. Recommendation cards (read-only, metric form)

One card per agent in `agentCatalog` order, computed deterministically. **No price field** appears on a card:
only R, shares, counts, ATR multiples and times.

| Field | Source (exists) | Content |
|---|---|---|
| `record` | plan learner `agents[]` (`agentRecords`) | setups, mean R, fill, target and stop rates; the same for the present context `<mode>\|<regime>` (`contexts`) |
| `r_dist` | `plan_setups.results_json`, control arm `e0@s1`, per `agent` | counts in R buckets: ≤ −1, (−1, 0), [0, 1), [1, 2), ≥ 2 |
| `exits` | `signal_ledger` per agent (the new `agent` column, §6; until then joined to `$.trade.agent`) | **headline:** Omega's locked stop share (`omega_exit = 'sl_plus'`) and its stop share (`omega_exit = 'stop'`); **beside it:** the ledger's breakeven share (`sl_plus_triggered = 1`); n of each |
| `executed` | `omega_intents` (`kind = 'open'`, `payload.strategy`) and `ea_deals` (`source = 'omega'`) | real Omega entries and closes of the agent: counts and win share, never money or volume |
| `breaker` | `suspendedAgents`, `suspendedPatterns` | suspended or not; the patterns held back |
| `verdicts` | plan learner `walk_forward` (for `zone_pullback`'s grid only); council `proposal_status` (`council_sessions`, new in the councils RFC) | shown when present |
| `arm` | §4 | armed or not, by whom, since when, the agent's `version` when it was armed |

**Recommendation** (new, pure: `recommendationOf(card)`, never written by a model). The thresholds reuse existing
constants:
- `not_recommended` when any of these holds:
  - the breaker suspends it;
  - setups ≥ 15 (`CONSENSUS_RULES.record_min_setups`) and the mean R is below 0;
  - the present context has ≥ 15 setups and its mean R is below 0;
  - Omega's stop plus locked-stop share is ≥ 0.65 over ≥ 20 resolved ledger trades (the councils RFC's strategy
    flag, N = 20, share 0.65).
- `recommended` when all of these hold:
  - setups ≥ 30 (`AGENT_BREAKER.min_setups`);
  - the mean R is ≥ +0.10;
  - the present context's mean R is ≥ 0, or the context has fewer than 15 setups;
  - not suspended;
  - the stop plus locked-stop share is < 0.50 when ≥ 20 trades exist.
- `neutral` otherwise. Below 15 setups the reason reads "collecting".
- The card lists each rule that was checked, with its value and its evidence ref.

**Evidence refs** use the format of `council.v1`, `ev:xauusd/<source>/<id>[@as_of][#field]`, for example:
- `ev:xauusd/plan_learning/agent:sweep_reversal@2026-11-16T12:00Z#mean_r`;
- `ev:xauusd/plan_learning/agent:sweep_reversal:scalp|low-ranging#setups`;
- `ev:xauusd/signal_ledger/agent:range_fade:last20#omega_sl_plus_share`;
- `ev:xauusd/strategy_breaker/pattern_peaks#suspended`.

The resolver is the new one of the councils RFC, and it never resolves a price.

**Where it is computed.**
- In the Signal Ledger's 5-minute step (`runLedgerStep`, after `runPlanLearning` and `syncAgentBreaker`), into KV
  `strategy-recommendations:v1` (new).
- Read at `GET /api/strategy-agents`: each agent gains `recommendation` and `arm` (new fields), so the page's 120 s
  poll costs no D1 query.

## 4. Arm state and storage (ADR-0015)

As in `docs/RFC_ROOM_CELLS.md`, D1 holds facts and documents, and hot reads come from a cache. The pattern of
`src/room-runs.mjs` is followed: an idempotent upsert guarded by a condition, and the schema made at run time plus
a migration.

**Migration** (new): the next free number. `0024` is reserved by the councils RFC, so this is
`0025_strategy_arms.sql`. The tables are also created at run time (`ensureStrategyArmSchema`, new).

| Table (new) | Kind | Columns |
|---|---|---|
| `strategy_arm_state` | singleton fact (`id = 1`) | `version` (monotonic arm-set version), `armed_count`, `updated_ms` |
| `strategy_arms` | one fact row per strategy | `strategy_id` PK, `armed` 0/1, `armed_at`, `armed_by`, `agent_version` (the registry `version` when armed), `disarmed_at`, `disarmed_by`, `disarm_reason`, `version` (the arm-set version of the last change) |
| `strategy_arm_events` | **append-only** audit | `id` AUTOINCREMENT, `version`, `strategy_id`, `action` (`arm`, `disarm`), `reason` (`owner`, `kill_switch`, `daily_loss_limit`; proposals in §9), `actor` (the Access email, or `system`), `request_id` UNIQUE (nullable), `armed_count_after`, `at`, `card_json` (the record and refs shown at the click, no price) |
| `strategy_arm_report_cursor` | singleton | `last_event_id`, `last_sent_ms`, `last_report_id`, `last_outcome` (the platform outbox, §10) |

- **Append-only:**
  - no code path updates or deletes `strategy_arm_events`;
  - a `BEFORE UPDATE` and a `BEFORE DELETE` trigger raising an abort (proposal; D1's support for triggers is not
    verified here);
  - a test asserting that no statement touches the table except `INSERT`.
- **Max 3, atomically, server-side** (`setStrategyArm`, new, `src/strategy-arm.mjs`). One D1 `batch`, which is one
  transaction:
  1. `UPDATE strategy_arm_state SET version = :v1, armed_count = armed_count + 1, updated_ms = :now WHERE id = 1
     AND version = :v0 AND armed_count < 3 AND NOT EXISTS (SELECT 1 FROM strategy_arms WHERE strategy_id = :id AND
     armed = 1)`. Here `:v1` is `:v0 + 1`.
  2. The upsert of `strategy_arms` for `:id`, guarded by `WHERE (SELECT version FROM strategy_arm_state WHERE id = 1)
     = :v1`.
  3. `INSERT INTO strategy_arm_events ... SELECT ... WHERE (SELECT version FROM strategy_arm_state WHERE id = 1) =
     :v1`.
  - Statements 2 and 3 apply exactly when 1 did. The answer reads the state back.
  - A disarm is the same with `armed_count - 1` and `armed = 1` required.
  - A disarm-all (kill) bumps the version once, sets every row to 0 and writes one event per strategy.
- **Idempotency and concurrency:**
  - the page sends `request_id` (a UUID per click) and `expected_version`;
  - a repeated `request_id` returns the stored result;
  - a request for a state that already holds answers `{ ok: true, changed: false }` and writes no event;
  - a stale `expected_version` for a different change answers `conflict` with the current state, and the page
    reloads;
  - system disarms read the current version and retry the compare-and-set up to 3 times.
- **Cache:**
  - After the commit, KV `strategy-arms:v1` (new) gets `{ version, armed: [{ id, armed_at, agent_version }], at }`.
  - The 5-minute ledger step compares the KV `version` with D1 (one small read) and rewrites KV when they differ.
  - A missing or unreadable KV value counts as **no strategy armed** (fail closed).
- **Hot-path reads (no D1 working-set reads per step):**
  - The Decision Engine reads `strategy_arms` once per 15m decision (one row set of at most 13; 96 a day).
  - Omega's `bridgeSync` (every 5 s) and `GET /api/ea/signal` read only the KV value, as they read `ea:control`
    today.
  - Like `ea:control`, a KV change can take up to about a minute to reach other locations. A disarm is therefore
    effective within about a minute, and at the next 15m decision at the latest (§5).

## 5. How the Decision Engine, the signal and Omega consume it

**Decision Engine** (`runDecisionEngine` → `assess` → `decide`):
- `runDecisionEngine` passes the armed set to `decide`. Everything up to the trade is unchanged.
- `decide` (new step) adds `execution` to the record, beside `trade`, which stays as today and is still measured by
  the ledger.
- The candidates are the speakers on the stance's side (`guards.consensus.long/short`) that are armed: the
  council's choice first if it is armed, else the strongest voice, the default agent first on a tie. The plan goes
  through `tradeFor` with the same `minRrr`.
  - `execution = { agent, trade, arm_version }` on success;
  - `{ agent: null, reason }` otherwise, with the reason one of:
    - `none_armed`;
    - `no_armed_speaker` ("no armed strategy sees its setup on the buy side");
    - `armed_conflict` (an armed agent speaks on the opposite side at this close, §7);
    - `vetoed` (the stance is WAIT or overruled).
- The record also keeps `armed: { version, ids }`.
- The Telegram decision message (`decisionMessage`) gains one line: "Executed by: <agent>" or "Not executed: <reason>".

**Signal** (`eaSignalFromDecision`, `managementFields`, `entryTriggerFor`), with `STRATEGY_ARM_MODE = "live"`:
- `side`, `entry`, `stop`, `tp1`, `action` and the trigger come from `execution.trade`, not `trade`.
- `trade_agent` is `execution.agent`.
- New fields: `arm_version`, `armed` (flat ids joined by `,`) and `stance` (the Decision Engine's stance even when
  nothing executes, for the `opposite` close).
- **At signal time** the KV arm set is read again: if `execution.agent` is no longer armed, `side` is `NONE`
  (`awaiting_reason: "strategy_disarmed"`). A disarm stops entries before the next decision. An arm made mid-bar
  counts from the next decision, because the Decision Engine alone selects.

**Omega** (`planIntents`), with new gates after today's gates:
- `strategy_not_armed`: `signal.trade_agent` is not in `signal.armed`. This repeats the signal-side check.
- `strategy_has_position`: an open system position whose `positionAgents` agent is `trade_agent`. This enforces one
  position per strategy.
- `opposing_position`: a system position on the other side is open or being closed this sync (§7).

**Attribution:**
- The open intent already records `strategy`. It gains `arm_version` (new).
- `ea_deals` gains `strategy` (new column). `storeDeal` fills it from the `omega_intents` open intent whose
  `result.ticket` is the deal's `position_ticket`.
- `signal_ledger` gains `agent` (new column, set in `ingestDecision` from `trade.agent ?? trade.strategy ??
  zone_pullback`) and `executed` (new: 1 when the decision's `execution.agent` equals that agent).
- Close intents already carry `agent` (`strategyExits`).
- `ea_deals.signal_id` is the MT5 deal comment (`DEAL_COMMENT`, `ea/mt5/OmegaExecutor.mq5`). For an entry deal this
  is the open intent id. Whether the exit deal carries it is not verified, so attribution uses the position ticket.

**The standalone EA** (`ea/mt5/CryptophysXAUUSD.mq5`, not deployed) gets the arm filter through the signal's `side`.
It has no per-strategy position rule (extend BACKLOG B-15).

## 6. Decision Engine compliance points (where the veto applies)

An armed strategy can only lose trades to these checks; it never gains one the Decision Engine refused.

1. `guardrailsFor` (market open, fresh, quorum, veto, levels, reward, room via `squeezeOf`), then in `decide`
   `MIN_CONFIDENCE`: WAIT with `overruled.by = "guardrail"`.
2. `decide` with `STRATEGY_EXECUTION` on: the agents' lean against the stance (`LEAN`), or no speaker
   (`agentSpeaks`, `agentPlanPasses`): WAIT with `overruled.by = "strategy_agents"`.
3. `decide`, the new arm step: only armed speakers on the stance's side, with no armed speaker opposite. Else
   `execution.agent = null`, while the stance and `trade` stay recorded.
4. `entryTriggerFor`: a market entry waits for its confirmation candle (broker 5m or TradingView), and the blackout,
   `kill` and `paused` apply in `eaSignal`.
5. `planIntents`: kill, engine, `executor_stale`, `expired`, `signal_too_old`, `blackout`, `paused`,
   `live_not_armed`, `already_opened`, `max_positions`, spread, `rollover_quarantine`, `same_side_unprotected`,
   `daily_loss_limit`, `daily_risk_budget`, `plan_wrong_side`, `stops_level`, `stop_breached`, plus the new gates of
   §5. The 5m stop and the adaptive stop are unchanged.
6. Exits that override the owning strategy:
   - `close_all` on kill;
   - `lean_flip` on every system position, whatever its agent;
   - `opposite` against the Decision Engine's `stance`;
   - `power_reversal`;
   - `opposite_5m`.
   The owning strategy's own exit is `confidence_drop`, keyed by its agent. The key-level SL+ only reduces risk.

## 7. Several armed strategies (proposed defaults)

- **Opposing signals mean no new entry.**
  - At one close, an armed agent speaking against the stance gives `armed_conflict`.
  - Across bars, `opposing_position` refuses an entry while a system position of the other side is open or being
    closed. The Decision Engine's `opposite` close still runs. Once the book is flat, the same signal may open while
    it is fresh (≤ `max_signal_age_ms`). Q4 asks whether it should wait for the next decision instead.
- **One open position per strategy** (`strategy_has_position`).
- **The total exposure cap reuses Omega's settings**, with no new setting:
  - `max_positions` (default 1, page 1 to 5, Aether policy 1 to 3). The owner raises it to 2 or 3 to let armed
    strategies hold positions at once;
  - the daily risk budget (`openRiskAtStops` against `max_daily_loss_pct`);
  - `same_side_unprotected` (no stacking);
  - `risk_pct` per entry, unchanged.
- **Closes:** the owning strategy's exits (`confidence_drop` and its management) plus the Decision Engine's
  overrides of §6.6. The lean flip is close-all across every armed strategy's positions on the flipped side.

## 8. Disarm and open positions

**Proposal:** a disarm stops new entries only. Positions the strategy already opened stay managed to their close by
that strategy's rules and the overrides of §6.6. `positionAgents` still finds the agent through the open intent. The
owner can close one at once with the existing `POST /omega/api/position/close`. Exceptions:
- a kill closes every system position (`close_all`), as today;
- at the daily loss limit, positions keep their stops (Omega does not close on that limit today).

An open intent already `sent` to the bridge cannot be withdrawn (`INTENT_TTL_MS` 2 min). A disarm therefore marks the
strategy's `pending` open intents `expired` (new) and accepts that a `sent` one may still fill. Q2 asks the owner to
confirm the default.

## 9. Auto-disarm

Real triggers (the owner's decision 4), checked server-side. Each disarms every armed strategy in one batch, with
the event reason given and actor `system`:
- **`kill_switch`:**
  - The Omega control `killed`: `OmegaGateway.setControl` disarms in the same call.
  - `EA_SIGNALS_ENABLED = "false"`: `bridgeSync` sees `signal.kill_source === "env"`. The 5-minute ledger step
    checks the same, in case the bridge is offline.
- **`daily_loss_limit`:**
  - Omega's floor, `account.equity <= day_start_balance × (1 − max_daily_loss_pct / 100)`.
  - It is checked on every sync by a new pure `dailyLossHit(executor, settings)`. Today `planIntents` evaluates the
    floor only after a side and the gates, so it is not seen without a signal.
  - The cost on the hot path is a D1 write only while something is armed and the floor is hit.

**Also decided (owner, 2026-11-16, Q3 and Q8; the `strategy_arm.v1` reasons gain `breaker`, `unavailable` and `executor_lost`):**
- `breaker`: the breaker suspends the agent (`suspendedAgents`). It is inert anyway as shadow; disarming stops it
  returning by itself when its record recovers.
- `unavailable`: the agent turns `off` (`STRATEGY_AGENTS_OFF`, `STRATEGY_AGENTS_MODE = "off"`).
- `executor_lost`: **not a disarm** (Q3). The executor stale for more than 30 minutes while gold is open
  (`goldClosedAt`) blocks new entries (as `executor_stale` already does after 60 s) and is reported with reason
  `executor_lost` once; the arms stay.
- **Not a disarm:**
  - `paused` (it already stops entries);
  - the engine toggle off or `live_armed` off, which `writeSettings` already disarms for a real account (Q3).

While a kill is active, or today's floor is hit, the Arm button is disabled. Re-arming is the owner's click.

## 10. Audit and telemetry

- **Audit:** `strategy_arm_events`, one row per arm or disarm (owner or system). `omega_events` gains no row: it stays
  Omega's own audit.
- **Platform record** (platform refinement 2026-11-16; governed by ADR-0020):
  - **One report per event.** Each arm or disarm event gets one report over the existing `AGENTS` binding with
    `publishToPlatform` (`src/platform-reports.mjs`): `reports.publish`, kind `xauusd_digest`, `body.schema`
    `strategy_arm.v1`.
  - **The body** is `{ event: "armed" | "disarmed", strategy_id, reason: "owner" | "kill_switch" |
    "daily_loss_limit" | "breaker" | "unavailable" | "executor_lost", armed_count, at, audit_ref }`. `audit_ref` is the `strategy_arm_events.id` of the row.
  - **Severity:** `info` for an owner click, `warning` for an auto-disarm.
  - **Best effort.** The publish runs after the D1 commit, in `ctx.waitUntil`. A denied or failed publish never
    blocks or delays an arm or a disarm. The xauusd audit table is the authority.
  - **Within the kernel's 4 reports an hour per agent:**
    - each event is sent as its own report while the budget allows;
    - only beyond the budget are reports batched: a burst (for example a kill disarming 3 strategies) is held and
      sent one report per event as the budget frees;
    - the cursor `strategy_arm_report_cursor.last_event_id` advances only on `success`;
    - a denial or failure is retried at the next hourly sweep;
    - a kernel denial is final (rule `kernel_rules`), so a denied event is marked and not retried in a loop.
  - **The reporting agent id** is `xauusd-risk-manager` (Q7). It shares the kernel's 4 reports an hour with the
    health alerts and the EA heartbeat relay, hence the budget rules above.
  - No new capability, and arming never widens xauusd's external ceiling.
  - **Visibility:** until the platform's HAIC H0 ships, these reports show only in the platform audit chain and
    `agent_reports`, not on the Owner page.
  - The relay's rule that the kernel drops a report older than 2 hours (`src/ea-heartbeat-relay.mjs`) would apply to
    an event held back by the budget for that long. How the platform treats such an event is not verified.
- **Telegram:** trading notices go to the Nexus chat today (`sendTelegram` in `src/index.ts`; the trading-mode change,
  decisions, Omega fills via `sendOmegaTelegram`). EA health goes to Cerebrum through the kernel. An arm or disarm
  sends one `XAUUSD SYSTEM · Strategy <label> armed / disarmed (<reason>), <n>/3 armed` line through `sendTelegram`,
  like the trading mode. This is a trading notice, not a council notice, which still come only from Cerebrum. Q9 asks
  whether the Telegram line is wanted beside the kernel report.
- **Doctrine facts** (`src/doctrine-facts.mjs`, beside `omega.live_arm_required`):
  `execution.strategy_arm_required` true and `execution.max_armed_strategies` 3 (new). The Aether canon follows by
  PR, as with the 5m trigger.

## 11. Write path (Nexus → Omega Worker → OmegaGateway)

- **The page** sends `POST /omega/api/strategy-arm` (new route in `workers/xauusd-omega/src/omega.mjs`) with
  `{ strategy_id, action: "arm" | "disarm", request_id, expected_version }`, `credentials: "same-origin"`, as
  `GlobalDecision.tsx` posts the trading mode. `GET /omega/api/strategy-arm` (new) returns the state, the last 20
  events and `can_arm`.
- **The Omega Worker:**
  1. `verifyAccessJwt`;
  2. `personJson`: a person, `Origin` equal to the page's, `application/json`, at most 1 KiB. This is the
     repository's CSRF protection today. New: also require `Sec-Fetch-Site: same-origin` when the header is present;
  3. **owner only** (new): the JWT's `sub` must equal the var `OWNER_ACCESS_SUB`. `sub` is the opaque Access user id,
     so no email goes into `wrangler.jsonc`. `verifyAccessJwt` returns `sub` (new). An empty var refuses everyone;
  4. `OmegaGateway.setStrategyArm({ strategy_id, action, request_id, expected_version, actor, actor_sub })` (new).
- **The AI Worker** (server-side authorization):
  - `setStrategyArm` checks `actor_sub` against its own `OWNER_ACCESS_SUB`, the agent id against `AGENT_IDS`, a
    status of `live`, `STRATEGY_ARM_MODE` not `off`, no kill and no daily loss floor hit for an arm;
  - it then runs the batch of §4, writes KV, sends Telegram and flushes the outbox.
  - The RPC has no shared secret (AGENTS.md rule 7). The binding is the trust boundary, as for `setControl`.
- **Other routes:** the route joins the 405 list of `omega.mjs`, and Nexus `/api/*` stays GET-only.

## 12. Nexus UI (Strategy Agents page)

`ui/src/pages/Strategy.tsx`, the `Registry` cards:
- **Header:** "Armed 2 / 3", the arm mode (`off`, `shadow`, `live`), and "No strategy armed: no new positions" when
  the count is 0.
- **Each card gains:**
  - the recommendation badge (recommended, neutral, not recommended) with its rules;
  - the track record (setups, mean R, present context, R buckets, Omega's locked-stop share with the ledger's
    breakeven beside it, n);
  - the breaker state;
  - "rules changed since armed (vN → vM)" when the registry `version` differs from `agent_version`;
  - an **Arm** or **Disarm** button.
- **Disabled reasons**, shown on the button:
  - not the owner (viewers see the state only);
  - 3 already armed;
  - shadow, off or suspended;
  - kill active;
  - daily loss limit reached today;
  - arm mode off;
  - a request in flight.
- **The track record is never a gate:** an agent with no record shows "No resolved setup yet" and can still be
  armed.
- **Live updates:** by the 120 s poll, or the push hub after a click (new topic `strategy-arms` in `PUSH_TOPICS`,
  optional).

## 13. Councils and Arm

A council's `shadow_arm` or `strategy_variant` (`docs/RFC_CALL_FOR_COUNCILS.md` §5) ends, after the owner's promote
click in Cerebrum, in a PR or flag:
- a new registry entry;
- a new `version`;
- or `STRATEGY_AGENTS_LIVE`.

That **changes the strategy**. It never arms it. A new agent id starts disarmed. An armed agent whose rules change
stays armed and shows "rules changed since armed" (Q6). The council verdict may appear on the card as information.
Arming stays the owner's click in Nexus.

## 14. Invariants

- No strategy armed means no new position (fail closed on any read error).
- At most 3 armed, enforced in one D1 transaction.
- Every arm and disarm has one append-only event with the actor.
- Arming never changes a status, a voice, a witness weight, a guardrail or an Omega setting.
- An executed trade is always a subset of the Decision Engine's allowed trade.
- Kill and the daily loss floor disarm.
- No price in cards, events or reports.
- No position size from the server beyond Omega's existing sizing.
- Never move funds.

## 15. Non-goals

- Arming from Cerebrum or Telegram.
- Per-strategy risk or size settings.
- A position limit per strategy above 1.
- Arming shadow agents.
- A model-written score.
- Changing the EA beyond the signal.
- Hedging opposite positions.

## 16. Risks

- **KV lag:** a disarm can take about a minute to reach the bridge's location. The decision-time check and the
  pending-intent expiry narrow the gap.
- **Owner id misconfigured:** nobody can arm (fail closed). Disarm by the system still works.
- **Flipping to `live` with nothing armed stops trading.** This is intended and said on the page and in the SSOT.
- **More exposure with 3 armed:** bounded by `max_positions` and the daily risk budget.
- **The two names** "live arm" and "strategy arm" can be confused. The page labels both.
- **A promoted rule change under a standing arm** (Q6).

## 17. Rollout

- **P0:** ADR-0020 merged on the platform; this RFC approved; SSOT, AGENTS.md rule 8 and the topology test updated
  in the build PRs.
- **P1:** read-only cards: `recommendationOf`, the KV `strategy-recommendations:v1`, the ledger columns `agent` and
  `executed`, `ea_deals.strategy`, the UI without buttons.
- **P2:** arm state in shadow (`STRATEGY_ARM_MODE = "shadow"`): the tables, the route, the buttons, the audit, the
  reports, Telegram, the auto-disarm triggers. Decisions record `armed` and `execution`; the signal and Omega ignore
  them. Exit criteria: 7 days, with
  - every click audited;
  - KV and D1 versions equal;
  - the would-be executions reviewed by the owner.
- **P3:** live behind `STRATEGY_ARM_MODE = "live"` (owner PR to `wrangler.jsonc`). The rollback is `"off"` (today's
  behaviour).

## 18. Owner decisions (2026-11-16, "1–10 setuju")

| # | Question | Decision |
|---|---|---|
| 1 | The owner check | `OWNER_ACCESS_SUB` (the Access user id in a var) now; a platform-managed Access group once roles exist |
| 2 | Open positions on disarm | stay managed to their close by the owning strategy's exit rules; the owner can close one by hand |
| 3 | More auto-disarm triggers | yes on the breaker and when the engine toggle goes off; a lost executor (30 min) blocks new entries but does not disarm |
| 4 | After an `opposite` close | another armed strategy may enter only at the next decision, not on the same signal |
| 5 | `DECISION_ENGINE = "off"` | nothing trades: the veto needs the engine |
| 6 | A promoted rule change | the strategy stays armed; the card shows the new version and the change is audited |
| 7 | The reporting agent | `xauusd-risk-manager` |
| 8 | `strategy_arm.v1` reasons | `owner`, `kill_switch`, `daily_loss_limit`, plus `breaker`, `unavailable` and `executor_lost` (the last only reported, never a disarm, per 3) |
| 9 | Telegram | yes: one line in the Nexus chat, as for a trading-mode change |
| 10 | Recommendation thresholds | the defaults (15 and 30 setups, +0.10R, a 0.65 / 0.50 stop share); re-checked after one month |

**Gate:** ADR-0020 ("Standing trading authorization (arm)") is **merged** (owner's `merge_owner_change` `cns_7ed29426`,
2026-11-17 01:08 UTC, platform main `e051489`). P2 (arm state in shadow, `STRATEGY_ARM_MODE = "shadow"`) and P3 (live)
still start only when the owner says so, one phase at a time; the platform record stays `strategy_arm.v1` (kind
`xauusd_digest`).
