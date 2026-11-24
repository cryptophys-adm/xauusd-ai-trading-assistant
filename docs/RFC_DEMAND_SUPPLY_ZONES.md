# RFC: demand and supply zones (the Z series)

**Status:** Z0 live, recorded only (2026-11-24). Z1a, Z2, Z2b, Z5, Z1b, Z3a, Z3b and Z4 follow, each as its own PR.

**Owner:** 2026-11-23, "Langsung prioritaskan": demand and supply zones are a live priority in strategy and position management.

**Canonical:** docs/SSOT.md (Key Level Agent) is canonical. This RFC records the design and the evidence.

## 1. Why
Every later Z rule needs a zone type, and until Z0 there was none:
- A Key Level Agent zone's `role` is only its position against price: support, resistance or "at price" (`src/key-level-agent.mjs` clusterLevels).
- `decision.key_levels` kept `{ low, high }` only.
- The whale zones' origin, HP and age (`local-engines/producer/src/chart-plane.mjs` whaleZones) never reached a zone.

## 2. Z0: type, strength and freshness, recorded only
`src/zone-types.mjs` (pure, with `.d.mts`). Nothing in Z0 changes a zone, a candidate, a plan's price, a guardrail, the council, the EA signal, Omega, the Position Manager or the public output.

### 2.1 Evidence (`dsEvidence`)
Boxes from the 15m, 1H, 4H and D1 HUD snapshots. Each weight is the reader's own base weight times the chart's `TF_WEIGHT` (15m 1, 1H 1.5, 4H 2, daily 2.5).

| source | from | side | weight |
|---|---|---|---|
| `whale` | `chart_plane.liquidity.whale_zones` | support = demand, resistance = supply. A mitigated block's role is already flipped by the producer. | 0.9 active, 0.7 mitigation |
| `prophet_best` | the `order_blocks` HUD's best bullish and bearish block | bull = demand, bear = supply | 0.7 |
| `gabfx` | `chart_plane.liquidity.gabfx` points | RBS and QM buy = demand, SBR and QM sell = supply | RBS/SBR 1.0, QM 0.9 |
| `gmi_flag` | the 15m `aegis_footprint` flags (in a bullish or bearish order block or mitigation) | bull = demand, bear = supply | 0.7, only on the zone holding price (`role` "at price") |

### 2.2 Typing (`zoneTypes`)
**Which boxes count:**
- A box types a zone on a strict overlap (an edge that only touches does not count).
- A point must lie inside the zone.
- Per side, each (source, timeframe) adds only its heaviest box, so two overlapping 15m whales count once.

**Type:**
- demand when `demand_w > 0` and `demand_w >= 2 x supply_w`;
- supply in the mirror case;
- mixed when both are > 0;
- else none.

**Strength,** on the type's score (`score`): strong >= 2.0, medium >= 1.0, else weak. Consequences:
- a lone 1H-or-higher box is medium;
- a lone 15m RBS or SBR point (1.0 x 1) is medium too, so decisive;
- a lone 15m whale (0.9) stays weak: young whales held 36% (n 191) in the design study.

**Freshness** follows Prophet's touch rule (`local-engines/prophet-r38/src/core.mjs`):
- the touches on the 40 closed 15m bars before the decision bar;
- a bar counts when it comes within 0.15 x ATR(1H) of the zone;
- touches must be at least 3 bars apart, and the count stops at 3;
- 0 touches = fresh, 1-2 = tested, 3 = worn.

**The window is 10 hours for every zone timeframe.** A 4H or daily zone price last touched two days ago reads fresh. This is deliberate: freshness is about recent tests, not the zone's age.

**Output:**
- `z.ds = { type, strength, score, freshness, touches, sources }`.
- Source labels use timeframe words (`whale@4H`, `gmi_flag@15m`, `prophet_best@daily`), never period numbers: "240" would read like a price to `PRICE_LIKE`.
- `decisive(z)`: demand or supply, and medium or strong.

### 2.3 Where it is recorded
- **The overlay.** `buildKeyLevels` calls `zoneTypes` once, after `limitCandidates`. `rawLevels`, `clusterLevels`, score, candidate, qualified, label, members and role are unchanged.
- **The recorded set.** `aroundSet(zones, price, 12)` is `keyLevelsAround`'s exact rule: candidate or qualified, the 12 nearest to price. `decision.key_levels` keeps `{ low, high }` and adds `zone_type`, `zone_strength`, `zone_freshness` and `zone_rank` ("candidate" | "qualified").
- **The plans.**
  - Each plan carries `zone_types { entry, stop, tp1, tp2 }`: each is `{ type, strength, freshness }` or null. Producers: `tradeLevels`, `targetsAhead` and `finishPlan`; `zoneLevels` passes `ds` through.
  - For an agent's structural plan (`finishPlan`):
    - the entry's zone is the one holding the entry;
    - the stop's zone is the zone between the entry and the stop whose far edge lies nearest the stop;
    - a target's zone is `targetsAhead`'s own zone, else the zone holding the target.
- **The opposing zone ahead.** `opposing_ahead` comes from `zoneAhead`, which runs last on the plan's final entry and stop. Its callers are `planForDirection`, `buildStrategy`'s plan and `finishPlan`, through `withZoneAhead`.
- **Where both fields are copied.** `slimPlan` (`strategy_plans`), `tradeFor` (`trade`) and MS2's shadow trade copy both fields, only when present.
- **The H1 chain's own plan.** `ownTimeframePlan` carries `zone_types`, but has no `opposing_ahead`: it has no recorded set or trend.
- **`plan_setups`.** It gains `entry_zone_type`, `stop_zone_type`, `tp1_zone_type` and `opposing_room_atr` through run-time ALTERs, each in its own try/catch. `decisionPlans` and `setupsFrom` carry them, for live and shadow setups alike. An untyped setup writes the row it wrote before.

### 2.4 `zoneAhead` (recorded only; Z2 reads it)
It reads only the recorded set, so a replay of a stored decision reproduces it from `decision.key_levels`, the trade's entry and stop, `decision.strategy.atr_h1` and `opposing_ahead.trend_lean`.

**The opposing zone:**
- it is decisive supply for a long, decisive demand for a short;
- it is ahead when part of it lies beyond the entry;
- its room is the distance from the entry to its near edge, 0 when the entry is inside it;
- the nearest such zone is the one chosen.

**need = `ZONE_NEED` = max(1.0 x risk, 0.75 x ATR(1H)),** exported and shared with Z2b's typed-TP floor.

**Output:** `opposing_ahead = { o_type, o_strength, o_freshness, o_rank, room_atr, room_r, need_r, trend_lean, with_trend, would_block }`.
- `trend_lean` is the strategy's trend value (decision_json.strategy does not keep it).
- `with_trend` is `dir x trend >= 0.15` (`STRATEGY_PARAMS.lean`).
- `would_block` is room < need and not with the trend, Z2's 'trend' rule, recorded only here.
- Distances are in ATR and R, never a price.

### 2.5 The switch
`KEY_LEVEL_ZONE_TYPES` = "on" (default, wrangler.jsonc) | "off".
- **How it travels.** Through the strategy modes (`modes.zoneTypes`), like CHART_PATTERNS_MODE: `loadStrategyInputs`, the capture's slim inputs (kept only when off), `loadOwnTimeframePlanInputs`.
- **Who honours it.** It is honoured by `loadDecisionInputs`, `readGlobalConclusion`, `readStrategy`, `captureStrategyInputs` and `ownTimeframePlan`.
- **What "off" removes.** Every typed field. Every later Z rule then sees untyped zones and behaves as before.
- **Proof.** test/zone-types.test.mjs Z0-9 pins "off" to main 74be83c's output, byte for byte: the strategy, guardrails, decision record, council, EA signal, public output and plan_setups rows.

### 2.6 What Z0 does not touch
Untouched:
- `managementFields` (it reads only low and high);
- `councilEvidence` and `councilMessages`, `guardrailsFor`'s checks, `pickStrategy`;
- Omega, the Position Manager, `publicAnalysis` and `publicRecap`;
- the hashed local-engine files.

No ENGINE_CODE function changes: ENGINE_CODE_HASH, ENGINE_BEHAVIOUR_HASH and ERA_SWITCHES are unchanged, and no era moves.

## 3. Evidence (the Z0 replay, production D1, SELECT only, 2026-11-24)
**Method:**
- **Data:** the 245 hourly strategy captures (`strategy_inputs`), covering the H1 bars 2026-11-08 23:00 to 2026-11-23 23:00 UTC.
- **Rule:** they were rebuilt with the final rule, without the chart-pattern levels.
- **Units:** counts are zone-hours. Consecutive hours share zones, so the counts are not independent.

**Distribution.** 2,880 recorded zones:
- types: none 51.8%, supply 27.9%, demand 16.9%, mixed 3.4%; 34.3% decisive;
- strength of the typed zones: strong 24%, medium 54%, weak 22%;
- freshness: fresh 19.6%, tested 23.4%, worn 57.0%;
- the typing comes mostly from whale zones (prophet_best and gabfx add less; gmi_flag rarely).

**would_block.** 490 base plans on both sides:
- 66.5% had a decisive opposing zone ahead;
- 45.9% had one within need;
- 27.3% would block: 0 with the trend, 53.9% of the counter-trend plans.
- Of 421 live BUY or SELL decisions matched to their hour, 14 (3.3%) would have been blocked on their side. That is an upper bound: the room-lean trend and no pattern levels.

**Held / broken** (held = a 0.86 ATR reaction before a 15m close beyond the far edge, within 6 h):

| decisive zones | held / resolved |
|---|---:|
| fresh | 20/32 (63%) |
| tested | 42/82 (51%) |
| worn | 146/376 (39%) |

- By type, supply held 53% and demand 28%: a SELL-heavy fortnight.
- Weak typed zones held 34%; untyped zones held 53%.

**Reading.** Freshness separates as the design study did (64% / 51% / 45%). The type's edge is regime-bound, which is why Z0 records only and Z2 keeps the trend exemption.

## 4. Risks
- **Thin typing coverage.** Typing coverage is thin until Z1a (`prophet_best` only at intensity +3/-3).
- **Churn.** Whale churn can flip a type between bars; Z2 reads it at the decision bar only.
- **Size.** decision_json grows for two reasons. In the test fixture the total went from 10.8 KB to 13.2 KB, with 3 agent plans:
  - the zone words of `key_levels`: about 95 bytes a zone, so about 1.1 KB for 12 zones;
  - each plan's `zone_types` and `opposing_ahead`, in `strategy_plans` and `trade`: about 0.45 KB a plan.
