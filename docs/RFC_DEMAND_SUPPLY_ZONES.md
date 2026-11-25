# RFC: demand and supply zones (the Z series)

**Status:** Z0 live, recorded only (2026-11-24). Z1a (every active Prophet order block as a source, §4) live. Z2 (the zone_ahead check, §5) makes the priority live on the decision side. Z2b (execution plans aimed by zone type, §6) ships inert (`ZONE_AIM_OFF` "tp,stop,factor", orchestrator ruling 2026-11-25): each rule is the owner's to switch on. Z5 (readings, counterfactual tables and the decision-side breaker, §7) measures and brakes them. Z1b (GMI's Aegis validated order blocks as a source, §4b) is built, not live until its PR merges. Z3a (typed zones in Omega's SL+ and trailing TP, §8) ships behind the owner's Omega setting `zone_mgmt`, default "off" (the owner flips it at merge); Z3b and Z4 follow, each as its own PR.

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
- A box types a zone on a strict overlap (an edge that only touches does not count). ZF1 (2026-11-25, owner "ZF1 tepi kotak"): except a box edge, or a point, within 0.001 of one of the zone's member prices. The box made that cluster, whose edges are rounded to two decimals, so it types it.
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

## 4. Z1a: every active Prophet order block as a source
**Why.** The only order-block box in Z0 is Prophet's single best block per side, and the core picks one only at cycle intensity +3/-3 (`local-engines/prophet-r38/src/core.mjs`, orderBlockEngine). Production 2026-11-20 22:00: the 15m chart had 4 active bearish blocks and no best one. The core already returns every active block at the last bar (`active_order_block_zones`), and nothing read it.

### 4.1 The export (producer)
- **The adapter.** `local-engines/producer/src/adopt/prophet-ob.mjs` (new; the producer's `adopt/` folder, which B20 extends and B11 joins with `adopt/context.mjs`). `prophetZones(ob, chartBars, { perSide: 4, atr })` reads only the core's list:
  - dir 1 = demand, dir -1 = supply;
  - `top` and `bottom` as the core holds them at the last bar (after its own trims), 3 dp;
  - `age_bars` = the last bar's index - `born`, on the snapshot's 1000-bar window;
  - `high_volume` = the core's `highVolume`, mapped explicitly;
  - `touches` by the core's own rule: a bar within 0.15 x the chart's ATR(14) of the block, on the 40 bars before the last, at least 3 bars after the touch counted before it (not capped here);
  - the 4 nearest to the close per side, demand first: at most 8 boxes a chart.
- **Where it lands.** `hud-snapshot.mjs` sets `chart_plane.zones = { prophet: [...] }`, failure-isolated like `buildChartPlane`: a failure leaves the plane without `zones`. It is not a HUD section, so no room agent appears. The HUD sections, the plane's existing fields, `hud-reading`, the parity comparables and the identity hashes are byte-identical (test pins taken before Z1a).
- **The core is unedited.** `core.mjs`, `src/prophet-r37-kernel.mjs` and `src/prophet-r37-oscillator.mjs` keep their provenance hashes; `hud-snapshot.mjs` and `adopt/` are in no provenance record.
- **Size.** About 95 bytes a box, so at most about 0.8 KB a snapshot (the store's limit is 64 KiB; the fixture snapshots stay under 48 KiB).
- **Deploy.** It ships with market-data-ingestion (local-publisher.mjs imports hud-snapshot) and the AI Worker. The export is always on; its use is switchable.

### 4.2 The source (`zone-types.mjs`)
- **`prophet_zone`.** Labels `prophet_zone@15m`, `@1H`, `@4H`, `@daily`. Weight 0.7, or 0.9 when `high_volume`, times `TF_WEIGHT`. The typing rule is Z0's: strict overlap, the heaviest box per (source, timeframe), 2x dominance, the same strength floors.
- **`prophet_best` is dropped on a chart that has `prophet_zone` boxes.** The best block is one of the active ones, so counting both would count one block twice. A chart without boxes (an older snapshot, or no active block) keeps it.
- **Freshness.** A zone typed by a `prophet_zone` box reads MAX(its own Z0 count, those boxes' touches), capped at 3, so worn dominates. A box's touches are counted on its own chart's bars (40 of them: 10 hours on the 15m, 40 hours on the 1H, about a week on the 4H), so a higher-timeframe test the 15m window misses still ages the zone. Without 15m bars the boxes' count alone is used.
- **The reader.** `src/level-readers.mjs` `prophetZoneBoxes(plane)` reads `chart_plane.zones.prophet`. `readPlane` does not read it, so the Key Level Agent's levels, zones, candidates, scores and roles never change.

### 4.3 The switches
- **`ZONE_SOURCES_OFF`** (AI Worker; unset = every source on): tokens `prophet_zone`, `prophet_best`, `whale`, `gabfx`, `gmi_flag`, comma- or space-separated; unknown tokens are ignored.
  - It travels through the strategy modes as `modes.zoneSourcesOff`, beside `modes.zoneTypes`: `loadStrategyInputs`, `loadOwnTimeframePlanInputs`, and the capture's slim inputs. It is present only when a source is off, so the default modes and the stored captures are Z0's.
  - `ZONE_SOURCES_OFF=prophet_zone` restores Z0's typing byte for byte (test/zone-types.test.mjs Z1a-4, Z1a-5 and Z1a-7: the strategy, the decision record and everything downstream).
- **`KEY_LEVEL_ZONE_TYPES=off`** still removes every typed field: with Prophet zones in the planes, the output is Z0-9's pinned main output (Z1a-6).

### 4.4 What Z1a does not touch
The guardrails, the council's evidence and messages, the EA signal, `managementFields`, Omega, the Position Manager, `publicAnalysis` and `publicRecap` are byte-identical with it on (Z1a-7). No ENGINE_CODE function changes: ENGINE_CODE_HASH (c4aa5772…), ENGINE_BEHAVIOUR_HASH (ecfe3f90…) and ERA_SWITCHES are unchanged, and no era moves. No EA or cron change.

### 4.5 Evidence (production D1, SELECT only, 2026-11-24)
**Coverage,** from the 259 hourly strategy captures (2026-11-09 to 2026-11-24), which keep each chart's order-block HUD:
- every capture had more active blocks than best blocks: on average 9.5 boxes (the 4-per-side cap applied) against 0.9 best blocks;
- the 15m chart had an active bearish block but no best one in 168 of 259 captures (bullish 106); the 1H in 145 (67); the 4H in 153 of 190 (49);
- 165 chart snapshots held more than 4 blocks on a side, where the cap applied.

**The typing replay and ZONE_NEED.** Not re-run in this PR: the stored captures predate the export (no `zones.prophet`), and D1 holds only about four days of 1m bars, short of the 1000 bars per chart (with the feed's volume) the core needs to rebuild the blocks. The captures keep the chart plane, so from Z1a's deploy on they carry the boxes; the replay with the new source and the ZONE_NEED re-check run on them before Z2 turns the gate on.

## 4b. Z1b: GMI's Aegis validated order blocks as a source

**Status:** built, not live until merge. It lands after Z5 (the brake) and before management (Z3a onward), so the Omega era starts on the full source set.

**Why.** GMI v12.70 computes validated order blocks (`local-engines/gmi/src/gmi-core.mjs`, "Aegis validated order blocks") but they leave the core only as the last bar's `in_ob_bull` / `in_ob_bear` flags, which Z0 reads as `gmi_flag` on the 15m zone at price only. The core is hashed (provenance), so the only path is a duplicate outside it.

### 4b.1 The export (producer)
- **The duplicate.** `local-engines/producer/src/adopt/gmi-zone.mjs` (new; B20 extends it and never re-creates it). `aegisBoxes(bars, { mintick, perSide: 4 })` repeats the core's loop line for line:
  - `obProgressiveUpdate` from `mizan.mjs`, and `pivot`, `highest`, `lowest` (with `isNum`, `nz`, `gt`, `lt`) from `pine.mjs`, imported unedited; `pineAtr` from `src/prophet-r37-oscillator.mjs`, as the core;
  - the cfg is `GMI_DEFAULTS` itself (imported, not retyped) with the caller's overrides: ob_pivot_len 5, max_nodes_ob 60, ob_max_age 120, max_ob_per_direction 30, ob_close_only false, mitig_buffer 0.25, max_wick_atr 3.0;
  - it returns the active blocks at the last bar `{ side, top, bottom, age_bars, touches }` (3 dp, the 4 nearest to the close per side, demand first, nearest first, at most 8 a chart) and the per-bar `in_ob_bull` / `in_ob_bear` flags.
- **One core on every chart.** hud-snapshot runs `computeGmiOnChart` (gmi-core-tf.mjs: 15m, 1H) or `computeGmiOnHtfChart` (gmi-core-htf.mjs: 4H, 1D). Since B4 both are one-line re-exports of gmi-core.mjs's `computeGmiOnChart` (the same function object), so the loop, its inputs (ATR(14) and `max(ATR, mintick)`, the volume pivots, mintick) and the cfg are identical on every chart. One duplicate serves all four.
- **Fields.**
  - bull (the core's `bot`, direction 1) = demand; bear (`top`, direction -1) = supply;
  - `top` and `bottom` as the loop holds them at the last bar, after its progressive mitigation;
  - `age_bars` = the last bar's index - the block's activation bar (where its volume pivot confirmed, from which `ob_max_age` counts), on the snapshot's 1000-bar window;
  - `touches` = obProgressiveUpdate's own `touched` events that left the block valid: each bar after activation whose range met the block's edges as they stood then. Each such bar trims the block, so consecutive bars count one each. The source bar and the bars before activation never count. Not capped here (the typing caps at 3). Chosen over Z1a's rule because Z1a's 40-bar window would count a young block's own source bar.
- **Where it lands.** `hud-snapshot.mjs` sets `chart_plane.zones.aegis` beside `zones.prophet`, on the bars and mintick the GMI run used (the chart's last 1000 bars), on every chart where GMI ran (15m, 1H, 4H, 1D). A chart where GMI failed has no `aegis`; a failure of the duplicate leaves the plane without `aegis`, and `prophet` as it was. No HUD field and no hud-reading line: with `aegis` stripped, the snapshot is Z1a's byte for byte (pins taken on b779c07).
- **Size and cost.** About 75 bytes a box (at most about 0.6 KB a chart); the fixture snapshots are 7.1-7.6 KB. The duplicate costs 0.3-0.9 ms against a 0.4-4.3 s snapshot (under 0.1%).

### 4b.2 The source (`zone-types.mjs`)
- **`gmi_ob`.** Labels `gmi_ob@15m`, `@1H`, `@4H`, `@daily`. Weight 0.8 (`ZONE_GMI_OB_WEIGHT`) x `TF_WEIGHT`. Z0's typing rule: strict overlap, the heaviest box per (source, timeframe), 2x dominance, the same strength floors. The reader is `src/level-readers.mjs` `aegisZoneBoxes(plane)`; `readPlane` does not read it, so levels, zones and candidates never change.
- **It replaces `gmi_flag` on a chart that has `gmi_ob` boxes** (the flag says price is inside one of the blocks). Only the 15m ever used `gmi_flag`, and every chart GMI runs on now carries boxes, so in practice the 15m flag is dropped whenever the 15m plane holds a block; it stays on a 15m chart with no block (an empty list), on an older snapshot without `aegis`, and while `gmi_ob` is off. The flag also carried GMI's whale mitigation; those zones still type the zone through `whale` (chart_plane.liquidity.whale_zones).
- **Freshness.** A zone typed by a `gmi_ob` or `prophet_zone` box reads MAX(its own Z0 count, those boxes' touches), capped at 3.
- **Overlap with `prophet_zone`: one block counts once** (orchestrator ruling (a), 2026-11-25). Prophet R38's order-block engine is the same Aegis algorithm (the same pivot length, wick cap, mitigation and age), so the two cores return the same block: on the producer's snapshot fixtures every `gmi_ob` box had the same edges and age as a `prophet_zone` box (the touches differ by definition). Counted twice it would read 0.7 + 0.8 = 1.5 x TF_WEIGHT (a 1H block: medium to strong) with nothing new behind it. So a `gmi_ob` box on the same chart and side as a `prophet_zone` box with both edges within `ZONE_SAME_BLOCK_TOL` = 0.001 (absolute, price units; on XAUUSD about 0.0000025 of price; the edges are 3 dp) adds no box: it is provenance only, `also: ["gmi_ob"]` on that prophet_zone box and `ds.also` (`gmi_ob@<tf>`) on a zone it types, for Z5 to measure later. Edges a step further apart are two blocks and both count. With `ZONE_SOURCES_OFF=prophet_zone` every `gmi_ob` box counts in full. `gmi_flag` is still dropped on a 15m chart with boxes, duplicates or not: the flag is price inside the same block, which counts once (a 15m zone at price typed by prophet_zone@15m plus gmi_flag@15m, 1.4 medium in Z1a, reads 0.7 weak). The recorded set carries the sources from Z1b on: `ds_sources` on each typed level (`prophet_zone@1H`, `gmi_ob@1H(dup)` for a duplicate; the form in SSOT), so Z5's `zone_readings.ds_sources` measures by source, and tells a duplicate from an independent source, from the merge on. Rows before it stay NULL (no backfill), so the per-source held rates start at zero.

### 4b.3 The switch
- `ZONE_SOURCES_OFF` gains the token `gmi_ob` (last in ZONE_SOURCES, in src/zone-types.mjs and src/feature-switches.mjs; the FS1 description and fixtures updated). `ZONE_SOURCES_OFF=gmi_ob` restores Z1a's typing byte for byte on planes that carry the boxes (test/zone-types.test.mjs Z1b-5, Z1b-6: the strategy, the decision record and everything downstream). `KEY_LEVEL_ZONE_TYPES=off` still gives Z0-9's pinned main output.

### 4b.4 What reads it, and what Z1b does not touch
- **Decision paths that read the new source** (through the zone words only): Z2's `zone_ahead` guardrail and `zonePlanPasses` plan filter (ZONE_PRIORITY "on", ZONE_AHEAD_MODE "trend": live), `pickStrategy`'s zone_ahead eligibility, the council's zone words (`zone_types`, `opposing_zone_ahead_atr`), `decision.zone_blocked` and `decision.key_levels`; Z2b's aims (inert while `ZONE_AIM_OFF` is "tp,stop,factor"); Z5's readings and breaker, which attribute by type. Management (Z3a onward) does not read types yet.
- **Untouched.** The EA signal, `managementFields`, Omega, the Position Manager, public output and plan_setups' columns (Z1b-6 with ZONE_PRIORITY off). No ENGINE_CODE function changes: ENGINE_CODE_HASH (c4aa5772…), ENGINE_BEHAVIOUR_HASH (ecfe3f90…), V13, V14 and ERA_SWITCHES unchanged; no era moves. gmi-core*.mjs, mizan.mjs and pine.mjs keep their provenance hashes; `adopt/` and `hud-snapshot.mjs` are in no provenance record. No EA or cron change.

### 4b.5 Tests
- `local-engines/producer/test/gmi-zone.test.mjs` (new): the duplicate's `in_ob_bull` / `in_ob_bear` equal the core's on every bar of the GMI fixture (gmi.test.mjs's 1000 H1 bars). The core evaluates only its last bar, so each bar is one core run on the growing prefix (1000 runs, about 12 s); prefixes under 320 bars lower only `vp_lookback` (the TDM volume profile's depth, which the loop never reads), since the core refuses shorter history. Also the last 40 bars of a 15m and a 4H chart, the re-export identity, the loop's text against the core's, hand-counted touches, the 4-per-side cut, the snapshot pins, hud-reading, size, the CPU bound and provenance.
- `test/zone-types.test.mjs` Z1b-1 to Z1b-7 (test/support/zone-types-fixture.mjs gains an optional `aegis` layer).
- **Drift.** If gmi-core.mjs's loop changes, the equality and loop-text tests fail; the duplicate is then updated in the same PR.

## 5. Z2: the zone_ahead check (decision side only)
**Why.** Until Z2 nothing kept a long out of supply: the only zone gates were scalp's 'reward' (a real level as the target) and `zone_pullback`'s own location rule. The design replay (426 at-level plans): an opposing typed zone under 0.5 ATR ahead -0.268R against +0.512R with none ahead; the counter-trend plans it would block -0.379R (n 121), the with-trend plans +0.135R (n 54), hence the trend exemption. A contrary-entry veto would have removed +0.055R with-trend plans, so a contrary entry zone stays a record.

### 5.1 The check (`guardrailsFor`)
`zone_ahead` follows `reward` while ZONE_PRIORITY is on and ZONE_AHEAD_MODE is 'trend' or 'all'. It reads the side's plan's `opposing_ahead` (§2.4), so it acts on the source set Z1a typed and a stored decision replays it.

| plan | 'trend' | 'all' |
|---|---|---|
| no plan | pass, "no plan to check" | pass |
| no decisive opposing zone ahead | pass, "no demand or supply zone against the trade within reach" | pass |
| room >= need | pass | pass |
| room < need, dir x trend < 0.15 (`would_block`) | **fail** | **fail** |
| room < need, with the trend | pass, noted in the detail only | **fail** |

- **need** = `ZONE_NEED` = max(1.0 x risk, 0.75 x ATR(1H)), shared with Z2b's typed-TP floor. **Opposing** = decisive supply for a long, demand for a short, from the recorded set only (`aroundSet`: a zone outside the 12 nearest never blocks; a weak, mixed or untyped zone never blocks).
- **The trend** is `opposing_ahead.trend_lean`, the strategy's D1/4H trend; the exemption is `STRATEGY_PARAMS.lean` (0.15).
- **Nothing goes to `g.cautions`.** Cautions enter the council's evidence and lower its confidence; the replay says a with-trend plan into a zone is not a caution.
- **Details** are words, ATR and R ("the nearest medium fresh supply zone lies 0.35 ATR ahead of the long entry (0.5R), short of the 1.07R it needs, and the trend (lean 0) is not with the trade"), never a price.
- In 'all' a with-trend plan is judged on the recorded `room_r` against `need_r` (2 dp).

### 5.2 The filter, outside the quorum
`zonePlanPasses(plan, g)` (`src/zone-types.mjs`) applies the side's rule (`g.zone_ahead`, the mode `guardrailsFor` records) to the strategy agents' plans:
- `liveAgentPlans` leaves a failing plan out (the council's strategy list, the council's choice);
- the execution non-arm path skips a failing speaker; with none left the decision waits, `overruled` naming `zone_ahead`;
- `pickStrategy` marks a failing candidate ineligible with `zone_ahead: false`.

`agentSpeaks`, `agentsConsensus` and the consensus passes in `assess` are unchanged, so the STRATEGY_AGENTS witness, the agents' confidence and the quorum deep-equal the run without Z2.

### 5.3 The record, the council and the rest
- **`decision.zone_blocked`** = `{ side, agent, plan (slim), opposing_ahead }` when `zone_ahead` is a side's only failing check (the guardrails' plan, the default agent's; the side the decision wanted first).
- **`rule_version`** gains `+zone_ahead@1` (`+zone_ahead@1:all`) while the check is in the guardrails (`ruleVersionOf`: `plan_setups`, `mode_shadow_plans`). The check changes which decisions trade in every mode, so the mode selector's evidence restarts at Z2's deploy, as at TP1-KZ's.
- **MS2.** The shadow modes run the same guardrails and filter; a mode the check holds back records the reason `zone_ahead`; each shadow trade keeps `opposing_ahead`, so a replay reproduces the check from the record. `withRoom` (room tuning) recomputes only the room check.
- **The council** (only while ZONE_PRIORITY is on): each plan adds `zone_types`, `opposing_zone_ahead_atr` and `with_trend`; the system prompt adds one sentence (`ZONE_PRIORITY_PROMPT`) on the owner's priority since 2026-11-23. Nothing goes to the cautions.
- **Doctrine facts.** `guardrailIds` lists `zone_ahead` after `reward`, only while the check is on.
- **Public.** `publicRecap`'s `held_back` leaves `zone_ahead` out: the recap is unchanged.
- **Untouched.** The EA signal, `managementFields`, Omega, the Position Manager, `publicAnalysis`, the hashed local engines; ENGINE_CODE_HASH (c4aa5772…), ENGINE_BEHAVIOUR_HASH (ecfe3f90…) and ERA_SWITCHES; no era moves. v4 replays the stored decisions.

### 5.4 The switches
- `ZONE_PRIORITY` = "on" | "off". wrangler.jsonc sets "on" since 2026-11-25, after the typing replay and the `ZONE_NEED` re-check on 8 live captures carrying 1H/4H Prophet boxes (need kept at max(1R, 0.75 ATR): room/need has no plan between 0.72 and 1.15). Unset reads "off", so a config without it (and every test that does not set it) is byte-identical to before Z2.
- `ZONE_AHEAD_MODE` = "trend" (default) | "all" (owner-set only, read from the Worker's env; one `zone_ahead_mode_all` warning line per decision; Z5 alarms on its block share) | "record" (no check; the plan keeps `would_block`; the council's words stay) | "off". An unknown value reads "trend".
- `KEY_LEVEL_ZONE_TYPES` "off" (env or the strategy's modes) leaves the zones untyped, so the check is out too.
- Z5's breaker can drop the check to "record".

### 5.5 Evidence and expected impact
- **Live impact, spec measure** (production D1, SELECT only, the 14 days to 2026-11-23, D1/H4 leans as the trend proxy): 419 directional decisions, 402 of them SELLs; 379 with the trend, 40 neutral or counter. 'trend' would have blocked at most 1 of 419 (0.24%); 'all' up to 278 (66%): 277 of the 379 with-trend plans had a recorded zone within need.
- **Expected:** at most about 0.3% blocked in 'trend' in the current regime; up to about 66% in 'all'.
- **The frozen 2026-11-20 22:00 capture** (test Z2-16): in a SELL-trend hour (lean -0.78) the counter-trend long meets a strong worn supply zone 0.33 ATR (0.4R) ahead and fails; the with-trend short has no decisive demand zone within reach and passes.
- **Risk.** Nearly inert in 'trend' in a SELL-heavy regime: the priority shows mainly in the record and in the council's words until the regime turns. It is regime-sensitive (one bearish fortnight of evidence); Z5's cohort and breaker watch it. The council sentence may tilt the stance toward WAIT; Z5 compares the stance shares before and after.

## 6. Z2b: execution plans aimed by zone type (decision side only)
**Why.** The targets ignored the zone type (`tradeLevels`: the next major zones), the stop sat beyond the first zone of any kind, and `pickStrategy` had no zone term. Replay evidence (n 25): stops beyond an opposite-type zone gave -0.037R as they are and +0.337R when moved past it; an own-type entry zone gave +0.150R against -0.003R. TP1-KZ (approved) puts TP1 at the nearest key zone at or beyond 1R, so the default changes no TP1 price ('label'); 'qualified' stays off until the owner amends TP1-KZ.

### 6.1 Where it runs (`zoneAim`, `zoneAimHeld`)
- **On execution copies, after the consensus and the quorum.** After TP1-KZ, `agentPlanPasses` decides which agents speak; moving a stop or a target in `planForDirection` or the agents' `basePlan` would move the STRATEGY_AGENTS witness and the quorum. So `assess` makes the plans, `agentsConsensus`, the witness cards and the quorum read them as they are, and only then are the copies made: the guardrails' plan inside `guardrailsFor` (before its levels, reward and zone_ahead checks), and each `g.plans[id].plan` where `assess` attaches them. `agentConfidences` reads the base plans too. `planForDirection`, `basePlan`, `buildStrategy` and `ownTimeframePlan` are unchanged (test ZA-3 pins the order).
- **The reward gate.** A copy that fails the gate its base passed keeps the base with `zone_rules` `[{ rule, held: "rrr" }]`: for the agents the consensus' own `agentPlanPasses` (TP1-KZ's 1R included), for the guardrails' plan its reward check. A base the gate refuses is not aimed, so no rule rescues a plan.
- **Inputs.** The recorded set (`aroundSet`, as `decision.key_levels` keeps it) for the targets and `zoneAhead`; every Key Level Agent zone (`zoneLevels`) for the stop's search, as `tradeLevels`; the strategy's 1H ATR and trend.
- **zoneAhead last.** Every aimed copy gets a fresh `opposing_ahead` on its final entry and stop, so Z2's `zone_ahead` check and filter read room_r, need_r and would_block after the stop moved.

### 6.2 The rules
| rule | applies to | what moves |
|---|---|---|
| `tp_typed` 'label' (default) | plans whose targets come from the key levels (zone_pullback, sweep_reversal, breakout_retest: `KEY_TARGET_AGENTS`), TP1-KZ on | TP1's price never; a decisive opposing TP1 adds its words to `tp1_note` ("(supply, fresh)"). TP2 = the next decisive opposing key zone at least 0.5 ATR beyond TP1 and at least 1.5R, else today's TP2. |
| `tp_typed` 'qualified' (owner-set only, after TP1-KZ becomes tp1_kz@2) | the same | a decisive opposing qualified zone at or beyond `ZONE_NEED`, nearer than TP1, becomes TP1; TP2 as above |
| `stop_skip` | the zone_pullback geometry (the guardrails' plan and zone_pullback's) | the stop sits beyond the first zone at least 0.5 ATR beyond the entry that is not a decisive opposing-type zone (supply under a long, demand over a short), padded 0.2 ATR; over 2.5 ATR, 1.5 ATR. Only when today's stop is that zone's: a fallback or a structural stop is kept. The entry zone's stop side is re-clipped to half the new risk. |
| `factor` | `pickStrategy` | score = r2(confidence x confluence x zone_factor): 1.2 decisive own-type entry zone, fresh or tested; 0.85 decisive opposite-type; else 1 (`zoneFactorOf`), carried as `zone_factor` on a typed candidate; eligibility and the WAIT unchanged |

- **One zone is never both a TP1 and a block.** The typed-TP floor is `ZONE_NEED` = max(1R, 0.75 ATR(1H)), Z2's need: a risk of 0.5 ATR with an opposing zone at 1.2R (0.6 ATR) is not a typed TP1, and Z2's would_block is true (ZA-7).
- **The factor's size.** 1.2 / 0.85 is a 1.41 ratio, below the at-level confluence gap (about 0.90 against 0.55-0.61): an opposite-type at-level plan still outranks an own-type pullback at equal confidence (ZA-11). There is no B13 `PICK_LOCATION` switch in this tree to combine with.
- **Agents with their own targets** (range_fade, the pattern agents, pattern_inside) keep their targets; their structural stops, and the sweep's and the breakout's, are unchanged.

### 6.3 The record and the replay
- **`zone_rules`** = `[{ rule: "tp_typed" | "stop_skip", base_tp1_r, base_stop_atr }]` on the trade (`tradeFor`) and on `strategy_plans` when a rule moved a price; `[{ rule, held: "rrr" }]` on a kept base; absent otherwise (a label alone is no rule). Distances from the entry, never a price: Z5 and MS2's base arm rebuild the base's stop and TP1 from the entry (`zoneAimBase`). Record only: never in the council's evidence, a card, a room, the EA signal or public output. The relabelled `tp1_note` is the only word the council sees change.
- **`rule_version`** (`ruleVersionOf`) stays `tp1_kz:on+zone_ahead@1` while Z2b is inert (the shipped switches; ZA-19). With a rule on it becomes `tp1_kz:on+zone_ahead@1+zone_aim@1` (`:qualified` in that TP mode, `:no_<token>` per rule left off): the rules move stops and targets in every mode, so the mode selector's evidence restarts at Z2b's deploy, as at TP1-KZ's and Z2's.
- **MS2.** The shadow modes run the same `assess`, so their plans are aimed the same way; `mode_shadow_plans.plans_json` keeps `zone_rules` as recorded, so the plan learner's shadow setups are the aimed plans and the base arm comes from the record.
- **Untouched.** `managementFields`, the EA's keys, Omega, the Position Manager, `publicAnalysis`, `publicRecap`, the hashed local engines; ENGINE_CODE_HASH (c4aa5772…), ENGINE_BEHAVIOUR_HASH (ecfe3f90…) and ERA_SWITCHES; no era moves (v4 replays the stored plans as they are).

### 6.4 The switches
- `ZONE_PRIORITY` "off" (or unset) disables all of Z2b: byte for byte main 3958d7c's output (ZA-15: the scenario with and without Prophet zones, the zone-held SELL, MS2's shadow rows and the frozen capture's guardrails). Untyped zones (`KEY_LEVEL_ZONE_TYPES` "off") disable it too.
- `ZONE_AIM_OFF` = comma tokens `tp`, `stop`, `factor`, the rules left off ("" = every rule on). **Shipped "tp,stop,factor"** (orchestrator ruling 2026-11-25): all three off is Z2's output, and under the live wrangler.jsonc vars the council's messages, the plans, the trade, `strategy_plans`, the record, the EA signal, `managementFields` and MS2's rows are main 6135237's byte for byte (ZA-18). The owner turns each rule on separately; stop_skip and the factor wait for their evidence.
- `ZONE_AIM_TP` = "label" (default) | "qualified" (owner-set only).

### 6.5 Evidence on the fixtures
On the frozen 2026-11-20 22:00 capture (scalp, intraday and swing, both sides, the guardrails' plan and every agent plan: 17 plans), Z2b moves no price: no decisive opposing zone sits under a long's or over a short's stop, no decisive opposing key zone qualifies as a typed TP2, and every entry zone is mixed (factor 1, no reordering). `tp_typed` relabels 3 TP1 notes (the scalp long's guardrail plan and breakout_retest's long in intraday and swing). The zone_ahead verdicts are Z2's (ZA-16).

## 7. Z5: readings, counterfactual tables, the decision-side zone breaker and Omega attribution

The owner prioritised before measuring, so the measurement and the brake land right behind Z2/Z2b. The only live evidence so far points the other way: S/D-labelled entries made +0.03R per Omega trade (n 27) against +0.28R (n 50). `src/zone-readings.mjs`; switch `ZONE_READINGS` (FS1, group zones).

### 7.1 Readings (`zoneReadings`)
- **What is read.** Each `decision.key_levels` zone (the recorded set, so a replay reproduces it) that the decision bar's 15m range touched, on the next 8 closed 15m bars.
- **Outcome** (B19's definition). `held`: a close at least 0.5 ATR(1H) from the near edge in the zone's direction, before a close 0.1 ATR beyond the far edge. `broke`: that close beyond the far edge first. Otherwise `neither`. A decision whose 8 bars have not all closed without an outcome waits, and so does every decision after it.
- **Direction and approach.** The approach is where the bar before the decision bar closed: `from_above`, `from_below` or `inside`. A demand zone holds up and a supply zone holds down. An untyped zone (none, mixed or no words) reads the side it is met from: support from above, resistance from below. An untyped zone that price opened inside is not read.
- **Also recorded:** `mfe_atr` and `mae_atr` from the near edge, and `bars`, the bars to the outcome (8 for neither).
- **Dedupe.** One reading per (0.1 ATR bucket of the zone's middle, approach) per 2 hours. The memory lives in the cursor (KV `zone-readings:cursor:v1`), never in a reading.
- **Storage.** D1 `zone_readings`: words and ATR only, `rule_version` beside `version`. The rule version is the decision's own: each decision writes `ruleVersionOf` of the run's FS1-resolved env (before any hold) to `zone_decision_rules` (INSERT OR IGNORE, one row a decision while `ZONE_READINGS` is on), and the readings and both counterfactual tables take it from there by `decision_key`, so a deploy or an FS1 flip between the decision and the write never mislabels a row. A decision without a row (before Z5) gives NULL, which the breaker's evidence leaves out. The decision record is unchanged. Written in `runLedgerStep` after the plan learner, at most 200 decisions a run. INSERT OR IGNORE on `<decision_key>#<zone index>`, so a rerun writes nothing.

### 7.2 Counterfactuals, in their own tables
plan_setups is read by 14 queries in 8 modules. A cohort column there would leak counterfactuals into MS1/MS2, grid adapt, knob tuning and the packs, so neither table is plan_setups:
- **`zone_blocked_setups`** (plan_setups' columns, `source` 'zone_blocked'). The WAIT decisions with `$.zone_blocked`: their would-be plan (the guardrails' plan, slim) becomes setups by plan learning's own rule (`setupsFrom`). Each is scored with plan learning's exported outcome step, `setupOutcome`: the control arm of `replaySetup`, where a limit that never fills scores 0R.
- **`zone_rule_arms`** (`decision_key`, `agent`, `rule`, `acted_r`, `base_r`, plus the setup's fields). For the Z2b plans a rule moved, the acted plan (as recorded in `strategy_plans`) against the base rebuilt from the entry, `base_tp1_r` and `base_stop_atr` (`zoneAimBase`), both on the same step. A copy held back by the reward gate (`held: "rrr"`) traded its base, so it has no arm. With Z2b inert the table stays empty.

### 7.3 The breaker (`runZoneBreaker`, `applyZoneHolds`)
- **When.** Hourly, beside the strategy agents' breaker.
- **Evidence.** That of the rule version in force (`ruleVersionOf`), newest first:
  - **(a) typing:** over the last 300 readings with at least 60 per group, the own-type held rate (demand met from above or inside, supply from below or inside) minus the untyped held rate, below 0, holds zone_ahead, tp, stop and factor;
  - **(b) block:** at least 30 resolved zone_blocked setups with a mean above +0.10R hold zone_ahead (to 'record');
  - **(c) per rule:** at least 30 resolved arms of a rule whose mean acted R is below the mean base R hold that rule (tp_typed: tp; stop_skip: stop).
  Thresholds read the 3-dp figures the line and the view show.
- **Hold period.** A new hold is stored as `{ by, since, until, rule_version }`, `until` = since + `ZONE_BREAKER.hold_ms` (7 days, SV1b's revert period). Before `until` the hold stands whatever the evidence says, so it never flickers hour to hour. After `until` it is re-evaluated on its stored rule version: released (one line, "its record recovered") once that evidence no longer trips, kept while it still does.
- **The owner's change wins.** When the owner's rule version is no longer the hold's (the owner changed a zone switch), the hold is released at once (one line, "the rules changed"), and `applyZoneHolds` does not apply a hold of another rule version even before that tick. Fresh holds read the owner's current rule version.
- **The state** lives in KV `zone-priority:breaker:v1`. The FS1 panel's `ZONE_AHEAD_MODE` and `ZONE_AIM_OFF` rows show the holds as `zone_hold` (their values stay the owner's). There is one `XAUUSD ZONES` Telegram line per change, sent first and then stored, so a failed send is told again.
- **Decision side only.** `runDecisionEngine` reads the state into its own env copy for the run: zone_ahead sets `ZONE_AHEAD_MODE` "record" while the check is in the guardrails ('trend' or 'all'), and a held tp, stop or factor joins `ZONE_AIM_OFF` while Z2b has that rule on. The decision records `zone_rules_held` = `[{ rule, by }]`. It never acts on Omega or PM rules: those switches are the owner's (SSOT's lens precedent; the ERA_SWITCHES comment), and v4 cannot replay a KV state. It never writes an FS1 override or `omega_settings`, never turns a rule on, and never changes the EA signal or `managementFields`.
- **A hold never changes a stored rule version.** plan_setups (the plan learner's live stamp), mode_shadow_plans, the mode selector and the zone tables all carry the owner's, so a hold does not restart the mode-selector evidence. `zone_rules_held` on the decision tells a held decision apart.

### 7.4 Alarms and Omega attribution
- **Alarms.** One line a UTC day each, no action:
  - zone_ahead is the only failing check in more than 40% of the last 96 decisions where the council wanted that side (needs the full 96);
  - under `ZONE_AHEAD_MODE` 'all', that share every day.
- **Omega attribution.** Read-only and SELECT only: `omega_intents` by reason and `level_source` 'zone', and `position_actions` by the PM's zone rules (pm_zone_*), joined to their `ea_deals` in R (`liveTradesFrom`). At 15 or more closes with a mean below 0R, the line says the owner may set zone_mgmt lower. Z3a adds the flag for the decision-side typing toggles while zone_mgmt is not off (§8.6, `typingFlagLine`).

### 7.5 GET /api/zones
- **Access.** The Nexus read API, behind Access. Gated on `ZONE_READINGS` only (off: 404); B8 folds it under INTEL_VIEWS. POST 405.
- **Reads.** SELECT only: a table that does not exist yet reads as [], and nothing is created.
- **Fields:**
  - `readings` by type x approach x strength (n, held, broke, neither, the held rate and the held rate shrunk toward the overall rate with a prior of 20, mean MFE and MAE in ATR);
  - `zone_blocked` per side (n, mean R, fill rate);
  - `rule_arms` (n, the acted and base mean R);
  - `breaker` (held rules and checks). `held[]` lists only the holds of the current rule version or carrying none (`zoneHoldCurrent`, FS1's filter too); each entry is `{ rule, by, since, until, effective }` (ZN1, additive): `since` and `until` as FS1's `zone_hold` shows them (`zoneHoldTimes`, the one reader of both; null when the stored hold has none); `effective` true exactly when `applyZoneHolds` would apply the hold to a decision now, under the env with the FS1 overrides applied (`zoneHoldEffective`): ZONE_READINGS on, the hold on the owner's rule version (or carrying none), and the rule on (zone_ahead: ZONE_PRIORITY on, KEY_LEVEL_ZONE_TYPES not off, ZONE_AHEAD_MODE 'trend' or 'all'; tp, stop, factor: Z2b in force and the token not in ZONE_AIM_OFF);
  - `stances` (the 7 days' stance shares and zone_blocked counts);
  - `omega_attribution` and `omega_advisory`.
- **Never** an account or identity key, and never a price.

### 7.6 Cost
- **Steady state.** A ledger run reads one to three decisions behind the cursor. D1 does the `json_extract`, so the Worker never parses a decision_json. The 15m series is read only when a decision is due.
- **Catch-up.** At most 200 decisions a run: about 1 ms of readings CPU for 200 decisions of 12 zones each (test ZR-13).
- **Counterfactuals.** They read the stitched ledger bars only while a counterfactual setup is open to replay. Today none is: the check has fired on 0 decisions, and Z2b is inert.

## 8. Z3a: typed zones in Omega's SL+ and trailing TP (the owner's setting zone_mgmt)

Management was type-blind: the signal flattened the zones to "low:high", and SL+ and the trailing TP used any band. About 70% of the SL/TP modifications in the 30 days before were zone-driven. Z3a lets the zone words steer those two moves, behind an Omega setting only the owner sets.

### 8.1 Why the default is "off" (the owner flips it at merge)
- Live Omega is armed (D1 2026-11-23: `live_armed` true, `entry_order` limit, `pm_loosen_enabled` true).
- `eraSwitches` compares each switch with `OMEGA_DEFAULTS`, so a default-on switch would change behaviour inside a carried era. Off by default, the merge carries the era (a new code hash, the same behaviour hash); the owner's flip writes `zone_mgmt=omega` and starts a new era at the settings' `updated_ms`. `PARITY_MIN_TRADES` 20 takes 2-3 trading days.
- **Owner-only.** `zone_mgmt` is written only by the owner: the Omega settings page's path, or the FS1 panel's Omega row, which forwards to it. Aether's policy and its rollback carry the stored value and never write it (`applyOmegaPolicy` deletes it from both bodies, as `cd_gate` and `limit_supersede`); Z5's breaker reads it (SELECT only) and never writes it. Precedents: the lens rollback switches and the `ERA_SWITCHES` comment.
- **Rollback.** The documented rollback is the owner setting `zone_mgmt` "off". `KEY_LEVEL_ZONE_TYPES` "off" also takes the words out of live management with no era move (v4 stays faithful: it rebuilds the signal from the stored `key_levels`), so it is for emergencies only, and Z5 flags it (§8.6).

### 8.2 The signal (`managementFields`)
`key_level_types`, only when every kept level carries `zone_type` (`KEY_LEVEL_ZONE_TYPES` on): comma tokens aligned 1:1 with `key_levels` after its filter, each `type/strength/freshness`, with `-` for none (e.g. `supply/medium/tested,none/-/worn`). Words only. `key_levels` is unchanged, an untyped decision's signal is byte for byte as before, and the key is named neither tp2 nor extended_tp. The EA reads exact needles and only its own keys (`CryptophysXAUUSD.mq5`); OmegaExecutor does not read the signal.

### 8.3 Omega (`src/omega-engine.mjs`)
- **The levels.** `brokerKeyLevels(signal, { typed })`: with `typed` and a token count equal to the key levels' count, each key level carries `{ type, strength, freshness }` (`typedLevels`) and lens B's levels type none; otherwise, and always without `typed`, today's objects. It stands alone (no shared options object).
- **SL+** (`keyLevelPlan`'s `zone`, only while `zone_mgmt` is not off and the levels are typed). The own passed zones: the passed key levels of the position's own type (demand for a long, supply for a short) of medium or higher strength (`typedDecisive`). Strong power: behind the own zone before the last (two needed); normal: behind the last own one; weak: the tighter of that and the broker's 5m swing. Always at or past the lock (break-even plus the buffer, or SLG1's first lock). It is taken when it is at or tighter than today's SL+, or looser by at most `ZONE_GIVEBACK_R[mode]` × the position's R at entry (`positionMeta` mode and `r_dist`): scalp 0.15R, intraday and range 0.25R, swing 0.30R (an unknown mode: intraday). Unknown R: tighter only. Then today's room and forward-only checks.
- **Trailing TP.** Near the target with a strong power: the first decisive opposing zone among the first two key levels beyond the target, else today's next level. The target moves at most one zone further.
- **The record.** The intent carries `level_source: "zone"` only when the typing changed its price; its id and reason are today's (`ms:<ticket>:k:<cents>`, `sl_key_level_<band>`; `mt:<ticket>:<cents>`, `trail_tp_key_level`).
- **Unchanged.** The ladder, the outward-TP hold (Amendment 4), `power_reversal`, the entries, the limit council and the Position Manager. Every other reader of `brokerKeyLevels` (the ladder, the limit council, the liquidity view, v3's ledger) reads today's objects.

### 8.4 One modify per position per 3 minutes, with PM-1M
The 1m fast layer's rate limit binds its own actions only, and the 5-minute Position Manager holds it for the rest of a 5m bar; Omega's routine key-level management had no rate against it. Z3a adds one (`ZONE_MGMT_RATE_MS`, 3 minutes, the fast layer's own `rate_ms`), only while `zone_mgmt` is not off:
- **Zone after fast.** A fast action of the position (`pm1:<ticket>:<bar minute>` in the recent intents, decided at its bar's close) within 3 minutes leaves its management untyped: today's SL+ and trailing TP, no `level_source`.
- **Fast after zone.** A zone-driven move of the position (an `omega_intents` modify with `level_source` "zone", pending, sent or done, in the last 3 minutes; `runFastProtect`'s `zoneMgmt`) holds a fast action: recorded `noted`, "a zone-driven stop or target move went out at … UTC: at most one modify per 3 minutes across the fast layer and zone management". It counts for the rate only, never for the 10-minute hysteresis. v4 does the same with the zone moves it planned.
- **The same plan.** A fast intent of a position already skips Omega's routine management for that position in that plan (planIntents' `skipTickets`), as before.

### 8.5 Hashes and eras
`ENGINE_CODE` gains `typedLevels`, `typedDecisive`, `zoneGiveback`, `zoneMgmtOn`, `ZONE_MGMT_MODES`, `ZONE_GIVEBACK_R`, `ZONE_MGMT_RATE_MS` and pm-fast's `zoneBarMs`; `managementFields`, `brokerKeyLevels`, `keyLevelPlan`, `manageIntents`, `settingsFrom`, `fastProtect`, `runFastProtect` and the `OMEGA_DEFAULTS` JSON changed: `ENGINE_CODE_HASH` 6c0f8142… → 38daf894…. `ENGINE_BEHAVIOUR_HASH` ecfe3f90… unchanged (V14: the fixtures are untyped and at defaults, so zone_mgmt is off). `ERA_SWITCHES` += `zone_mgmt`.

### 8.6 Z5's flag line
`runZoneBreaker`'s hourly tick keeps the decision-side typing signature (`KEY_LEVEL_ZONE_TYPES`, `ZONE_SOURCES_OFF`, FS1-resolved) in its KV state and, when it changed while `zone_mgmt` is not off, sends one `XAUUSD ZONES` line naming the change ("… while zone_mgmt is omega: Omega's SL+ and trailing TP read these words through the signal, with no new parity era. The documented rollback is zone_mgmt off …"). Once per toggle; a failed send is told again at the next tick; a toggle while `zone_mgmt` is off is recorded and never told. No action.

### 8.7 Tests
test/omega-zone-mgmt.test.mjs Z3a-1 to Z3a-16: the signal (types only when all are typed, untyped byte for byte against main fd22f97, the EA's keys, no tp2/extended_tp, the bridge's intents file); `brokerKeyLevels` (count match, mismatch, without opts); the switch, its era signature and the FS1 row (read-through, owner-only POST, reset, the change-audit line); SL+ within and beyond the cap, unknown R, the lock, the three bands, a short; the trailing TP one zone further, never two; `level_source` only when the price changed; off against main byte for byte; the 3-minute interplay with PM-1M (pure, live sync and v4); a typed decision's v4 replay reproducing the live `planIntents`; the Aether policy and rollback carrying `zone_mgmt`; Z5's flag line; the hashes.

## 9. Risks
- **Overlapping readings (Z5).** Readings of consecutive decisions overlap; the dedupe limits it.
- **Recorded plans (Z5).** The counterfactual uses the recorded would-be plan; a limit that never fills scores 0R, as plan learning does.
- **Typing shifts while Z2 is live (Z1b).** gmi_ob adds 0.8 x TF only for blocks Prophet does not hold (a same block counts once), so some untyped zones become decisive, and a 15m zone at price loses gmi_flag where the 15m has boxes; Z5 attributes by source, and `ZONE_SOURCES_OFF=gmi_ob` reverts it. The duplicate can drift from gmi-core; the equality test fails on drift.
- **Coverage jumps at once (Z1a).** Typing coverage was thin until Z1a (`prophet_best` only at intensity +3/-3). Z1a lands before Z2, so the gate acts on the source set it was checked with. 1H blocks can be about 1 ATR wide; the medium floor and 2x dominance keep weak overlaps out.
- **The window (B11).** B11's window change can shift `born` and `age_bars` while Z2 is live; B11's typing-shift report measures it.
- **Churn.** Whale churn can flip a type between bars; Z2 reads it at the decision bar only.
- **Looser SL+ (Z3a).** A stop behind the own zone gives more back: capped at 0.15-0.30R of the position's R, never below the lock, forward only. Unknown R: tighter only.
- **Era churn (Z3a).** Each flip of `zone_mgmt` is a new era; the recommended flips are "omega" at merge, then straight to "full" after Z4.
- **Size.** decision_json grows for two reasons. In the test fixture the total went from 10.8 KB to 13.2 KB, with 3 agent plans:
  - the zone words of `key_levels`: about 95 bytes a zone, so about 1.1 KB for 12 zones;
  - each plan's `zone_types` and `opposing_ahead`, in `strategy_plans` and `trade`: about 0.45 KB a plan.
