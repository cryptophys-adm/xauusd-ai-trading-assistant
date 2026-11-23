# RFC: the council's bounded loosening and two-way target (platform ADR-0020 Amendment 8)

Status: built behind a switch that is off by default (`pm_loosen_enabled`). Turning it on is the owner's, on the Omega page.

Provenance: owner 2026-11-20 ("setuju", relayed by the orchestrator; confirmed to the platform session: "setuju", then "keduanya" for Amendments 7 and 8). The amendment is merged on the platform. It narrows Amendment 1's "never widens a stop loss" and the "stop loss only tightens" of Amendments 4 and 6 for open positions only. Resting entries (Amendment 7) are unchanged.

## 1. The switch

- `pm_loosen_enabled` (Omega setting, boolean, default `false`). The settings write is owner only (`POST /omega/api/settings`, `OWNER_ACCESS_SUB`). Aether's `applyOmegaPolicy` never writes it (and its rollback carries it as stored).
- Off: the Position Manager and Omega's handling of its actions are byte for byte what they were at ad21475 (test A8-2: hashes of `positionFacts`, `positionAction`, the council's messages and schema, `cleanCouncil`, `positionManagerIntents` and `planIntents` over 807 fact cases, 4,842 actions, 17 intent sets and 16 plans). The S12 market-path hashes of stage 3 hold too.
- A position loosened while the switch was on stays loosened after it goes off: it still counts as unprotected, and its mechanical locks still wait (§5).

## 2. Who decides, and when

- The Position Council (`position_council`, the same model call, meter and USD 5/day cap shared with `entry_council`). With the switch on its schema adds `stop` (`keep` | `loosen`) with `stop_reason`, and `target` (`keep` | `nearer` | `further`) with `target_reason` (`POSITION_COUNCIL_SCHEMA_A8`). It still never sets a price: the fixed rules check each reason against the measured inputs and set the level.
- Consensus: the council's answer names the change and its reason. A loosening or a target further also needs its own reading to be the thesis `intact` and the momentum not `weakening`. A target nearer needs only its reason.
- A silent council (a failure, the cap, no answer) changes nothing. Nothing loosens or moves mechanically.
- Order: a close, a lock (break-even, TP1), TP2, a cut and the loss band come first. An A8 change replaces only the holds `inside_band`, `protected`, `tp2_waits_council` and `tp2_waits_ladder`. The profit-lock gate's holds (`lock_waits_gate`, `tp2_waits_gate`; SLG1, 2026-11-23, docs/SSOT.md) are locks waiting, not holds an A8 change replaces. One change per position and 5-minute bar: the stop first. A target further never comes with a looser stop, and a council target move never carries a stop.

## 3. The stop

- **The original stop** is the position's open intent's `sl` (`kind = 'open'`), or, for a limit fill, its `place_limit` intent's `sl` as the fill recorded it. The sync reads it with `pmLoosenInputs`, the runner from the open intents it already reads.
- **Only a tightened stop**: the current stop (the tightest of the snapshot and the stops commanded in the last 5 minutes) must sit beyond the original stop by more than half a point.
- **How far**: at most `back_share` × (current stop − original stop) back, never past the original stop. From break-even or better the entry is the floor: never back into loss. With a key level as the reason, the stop clears the level by two spreads, never past that bound.
- **Measured reasons** (`LOOSEN_REASONS`):
  - `atr_expansion`: ATR(14, 15m), the terminal's `atr_value`, is at least `atr_expand` × the reference. The reference is the ATR recorded at the last Omega tighten (every tightening intent carries `atr` while the switch is on), else the ATR at entry (`atr_entry` on the open intent while the switch is on), else none, and the reason does not hold.
  - `key_level_outside`: a key level whose near edge lies between the stop and its bound.
  - `high_impact_release`: a High-impact USD event of the economic calendar in its gate's window (`EVENT_GATE`: 2 hours before to 30 minutes after).
- **Once per position**: a loosening intent (`modify_sl`, `loosen: true`, `from_sl`, `orig_sl`) is the durable record. One in `omega_intents` that is pending, sent, done or expired counts. A broker refusal (`failed`) changed nothing and does not count. So does a pending `loosen_*` action of the Position Manager (`loosenRecords`, `loosenInputs`).
- **Omega checks again** (`a8Intent`): looser than the current stop, not past the original, within the share, break-even floor, once, room at the live price, not on a delegated position, not against a Decision Engine veto of the side, not while paused, on a real account not armed live, or with the tick value or the money unverified. The daily loss budget must hold with the position's risk at the new stop: equity − the open risk at the stops (this one at the new stop) − the pending risk − the floor > 0. Under a profile, the risk from the entry to the new stop stays within the hard cap per trade, and the total open risk within the profile's cap.
- **After a loosening**:
  - the position counts as unprotected (`isProtected` is false for `loosened`), so `same_side_unprotected` holds a second entry on its side;
  - its risk at the new stop counts in the daily loss budget (the broker's stop is the new one);
  - in that sync no mechanical stop or target move is planned for it;
  - later, every mechanical lock (key-level SL+, break-even, the 5m trail, the ladder) and the Position Manager's own locks wait until they would be tighter than the stop before the loosening (`from_sl`). Otherwise the ladder would undo the council's decision at the next sync. A stale snapshot is already covered by #173's commanded stops (the tightest is read).

## 4. The target

- **Nearer** (`momentum_fading`: the quorum's share on the side fell by more than 0.05 since the bar before; `confidence_drop`: the agent's confidence dropped; `key_level_before`: a key level ahead of price before the target). The new target is the nearest such key level, else TP1 when the target is beyond it.
- **Further** (`key_level_beyond`: a key level beyond the target; `atr_expansion_trend`: the ATR expansion above with the agent's confidence rising). The new target is the next key level beyond. Under the TP ladder it waits for the TP1 lock (Amendment 4), and the plan's ladder filter still drops it. A nearer target is not an outward move and passes. A target further is refused against a veto of the side.
- Never on the wrong side of price: a nearer target stays beyond the price by the spread and a buffer, and Omega checks it against the broker's stop distance.

## 5. Knobs (doctrine facts proposed to the platform)

Per trading mode, clamped to their bounds (`src/pm-loosen-knobs.mjs`, `pmLoosenKnobs`). No platform reader of `omega.pm_loosen_*` exists yet, so the start values hold (`source: "start_values"`). Amending a bound is the owner's. Neither name matches `/trad(e|ing)\b|order|wallet|withdraw|transfer|swap/` (test A8-3).

| Fact | Unit | scalp | intraday | swing | range | Bound (min–max) |
|---|---|---|---|---|---|---|
| `omega.pm_loosen_atr_expand_<mode>` | ratio, ATR(14, 15m) now / ATR reference (last tighten, else entry) | 1.6 | 1.5 | 1.5 | 1.8 | 1.2–2.5 |
| `omega.pm_loosen_back_share_<mode>` | fraction (0–1) of the way from the tightened stop back to the original stop | 0.4 | 0.5 | 0.6 | 0.4 | 0.25–1.0 |

Why: scalp stops are small and its ATR noisy, so it needs more expansion and gives back less. Range reads an expansion as a breakout risk, so it asks the most and gives back little. Swing holds longest and gives back the most.

## 6. Telegram, events and the page

- "Stop loosened to X" and "TP moved nearer/further to X" lines go through the Position Manager's line (`actionMessage`) to the owner's private chat (`sendOmegaTelegram`) when the broker answers, or as not applied with the reason. Each carries the reason, the mode and R (the risk at the stop before and after, in R of the 1R at entry; the target in R).
- Every loosening and council target move, as the broker answered, is an `omega_events` row (`pm_stop_loosened`, `pm_tp_moved`): the rule, the mode, R and `applied`; no price, no account. The Aether execution report is unchanged and carries no price key.
- Nexus Omega page: the owner's toggle "Council may loosen a stop (A8)" under the Engine form, off by default; a "LOOSENED ONCE" badge on a position after it happens (overview `pm_loosen`).

## 7. Deviations

- **A refused loosening frees the one chance; an unanswered one does not.** A broker refusal (`failed`) changed nothing at the broker. An expired intent may have applied, so it counts.
- **Delegated positions are never loosened or retargeted by the council.** Their "original stop" is the owner's stop at delegation, not an entry Omega sized.
- **The ATR reference needs the switch.** The ATR at entry and at each tighten is recorded only while the switch is on (recording it always would change today's intents). A position opened or last tightened while it was off has no reference, and `atr_expansion` cannot hold for it. The other reasons still can.
- **Mechanical locks wait after a loosening** until they pass the stop before it (§3). Without this the ladder would re-tighten the stop at the next sync.
- **Extra refusals beyond the amendment's list:** a pause, a real account not armed live, a Decision Engine veto of the side, the tick value or money unverified, and the profile's caps at the new stop.
- **v4 parity.** The replay has no council asks (its recorded verdicts carry momentum and thesis only), so it never loosens or moves a target. With the switch on, a live position the council loosened differs from its replay.
- **`ENGINE_CODE_HASH` changes** (new functions and the changed `positionAction`, `positionManagerIntents`, `manageIntents`, `planIntents`, `isProtected`, `settingsFrom`, `OMEGA_DEFAULTS`). The era now follows `ENGINE_BEHAVIOUR_HASH` and the switch signature (docs/SSOT.md, v4 parity era). With the switch off the behaviour hash is unchanged (A8-2), so the stage 3 era carries over at the deploy; `pm_loosen_enabled` turned on starts a new era at the settings' `updated_ms` ("switch on: pm_loosen_enabled"), and turned off again another.

Tests: test/position-manager-a8.test.mjs A8-1 to A8-15; the fixture test/fixtures/pm-a8-off.mjs.
