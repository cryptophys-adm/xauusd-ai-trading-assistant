# RFC: council proposals, from the owner's pick to a change, without Claude

- **Status:** phase 1 and phase 2 built; the return path on since 2026-11-17 (platform V3 live).
- **Date:** 2026-11-17.
- **Builds on:** docs/RFC_CALL_FOR_COUNCILS.md; the platform's docs/design/HAIC-H0-H1.md (decision → proposal hand-off) and ADR-0014 (evolution loop).

## Owner decisions (2026-11-17, confirmed in the session)

The owner asked how a council's option can become a proposal, be accepted and be processed without Claude.

1. **Where the owner picks:** "Nexus dulu, Cerebrum nanti". An Accept button per option in Nexus comes now. The pick through Cerebrum and the Supervisor follows once the platform builds its return path (`council.decisions.read`).
2. **A knob change that passes its shadow test:** "Live otomatis + rollback otomatis". It goes live by itself and rolls back by itself, like grid auto-adapt. No Claude and no PR.
3. **A change that needs new code:** "ini harus autonomous supaya dikerjakan oleh cryptophys bukan dari external". The platform's evolution loop builds it, not Claude and not anyone external.
   - ADR-0014 is accepted but deferred until the platform leaves GitHub.
   - Until the platform lifts or reshapes that deferral, such a proposal waits in Cerebrum's inbox.

## The flow

| Step | What happens | Who |
|---|---|---|
| 1. Typed options | The moderator writes each option as one of three kinds: `policy_parameter` (a listed knob, a value inside its bounds), `repository_task` (new code, with a spec), or `no_change`. | Moderator (`cfc_synthesis`) |
| 2. Validation | `cleanOptions` checks a knob change against `src/council-knobs.mjs`. An unknown knob, or a value out of bounds, becomes a `repository_task`. `no_change` is always offered. | Code |
| 3. Accept | The owner-only `POST /omega/api/council {action: "accept"}`: the session becomes `decided`, the proposal is stored (D1 `council_proposals`), and a `typed_proposal.v1` report goes to the platform as `xauusd-moderator`. A failed send is retried hourly. | The owner |
| 4a. Knob change | Shadow test against today's setting, then live, then automatic rollback (phase 2). | xauusd |
| 4b. New code | `executor: "cryptophys"`: handed to the platform for its evolution loop. xauusd never routes it to Claude. | Platform |
| 4c. No change | Recorded. Nothing changes. | — |

## Knob registry (src/council-knobs.mjs)

Each knob's current value is read from the code that uses it.

| Knob | Today | Bounds | Step |
|---|---|---|---|
| `decision.min_confidence` (the council's floor) | 0.4 | 0.3 to 0.6 | 0.05 |
| `decision.min_rrr.intraday` | 1.5 R | 1 to 2.5 | 0.1 |
| `decision.min_rrr.swing` | 2 R | 1.5 to 3 | 0.1 |
| `decision.quorum_min.scalp` | 0.45 | 0.45 to 0.65 | 0.05 |
| `decision.quorum_min.intraday` | 0.5 | 0.45 to 0.7 | 0.05 |
| `decision.quorum_min.swing` | 0.6 | 0.45 to 0.7 | 0.05 |

The quorum knobs stay inside the doctrine's hard bounds, 0.45 to 0.7 (owner 2026-11-19: "ya", on the decisions of 10-19 Nov: no scalp side sat between 0.40 and 0.45; the swing trades at 0.70-0.80 of the weight hit 5 of 6, which a 0.75 knob would have blocked).

The registry is the only way a council can change a number. Adding a knob is a reviewed change to this file.

## The hand-off to the platform (`typed_proposal.v1`)

Each hand-off is a `reports.publish` call: kind `xauusd_digest`, `body.schema: "typed_proposal.v1"`. The body carries:
- `proposal_id`, `kind`, `state` and `executor` (`cryptophys` or `xauusd`);
- `origin` {`council`, `option_id`, `side: "nexus"`, `repo`, `topic`, `question`};
- `chosen_by` and `chosen_at`;
- `title`, `hypothesis`, `change`, `risk` and `dissent`;
- for a `policy_parameter`: `knob`, `from` and `value`;
- for a `repository_task`: `spec`;
- `evidence_refs`, at most 12.

The body never carries a price. The send is bound by the kernel's limit of 4 reports per hour per agent.

## Phase 2 (built): the shadow test, live and rollback (src/council-knob-tuning.mjs)

- **The knobs.** The registry now lists only the 6 Decision Engine knobs the replay can test. `near_atr`, `max_risk_atr` and the other strategy engine and agent numbers need code before they can be tuned, so a council proposes them as a repository task.
- **Runtime override.**
  - The live values are stored in KV `council-knobs:v1`.
  - `runDecisionEngine` reads them at each decision through `readKnobOverrides`, clamped to the registry's bounds and cached for 60 s.
  - `modeThresholds(mode, knobs)` takes them for `quorum_min` and `min_rrr`; `minConfidenceOf(env)` gives the council's confidence floor.
  - The decision's `rules` record the values in force.
  - The moderator's knob menu and Accept compare against the value in force.
- **Replay.**
  - Every decision of the last 60 days is replayed with the candidate value.
  - Each changed decision is measured in plan-R, using the zone_pullback plan as is (`e0@s1`, 0 when not filled).
  - A stricter value is exact: a trade it would have refused drops out.
  - A looser `min_confidence` is exact as well: a council side that was overruled only by its confidence comes back.
  - A looser `quorum_min` or `min_rrr` is an estimate. It counts the bias's side only where that knob's check was the only one that failed.
- **Gate** (grid-adapt's):
  - at least 30 changed decisions;
  - a mean gain above 0.05R;
  - the newest quarter (at least 10) not losing;
  - a seeded bootstrap 2.5% bound above 0.
- **Decision after the test.**
  - A value that passes goes live.
  - A value that fails with enough data, or after 30 days, is rejected.
  - Otherwise it stays in shadow and is tested again the next day.
  - An older proposal on the same knob is superseded.
- **Rollback.**
  - Each day, the decisions made since a value went live are replayed with the old value.
  - On 20 or more changed decisions, if the old value would have gained, the live value is removed and recorded as retired.
  - A retired value is never tried again.
- **Reporting.** Every step sends a Telegram line and a `typed_proposal.v1` state update to the platform. It runs once a UTC day from the ledger cron, after grid-adapt.

## The return path (on since 2026-11-17)

The platform reports what it does with a handed-off proposal through `council.decisions.read` (platform V3, relayed 2026-11-17), a tier-0 observe capability of `xauusd-moderator`:

- **Call:** `AGENTS.observe("xauusd-moderator", "council.decisions.read", { cursor })`.
- **Answer:** `{ available, origin, updates: [{ schema: "typed_proposal.v1", proposal_id, state, reason, refs{intent_id, evolution_id, cr_id, merge_sha, deploy_ref, close_code}, at }], next_cursor }`. At most 20 a call, oldest first, this origin only, never a price.
- **States:** received, queued, waiting_external, queued_external, rejected, in_progress, proposed, merged, deployed, deployed_unmeasured, closed, refused, unfit, reverted, expired (`queued_external`, `expired` and the `close_code` ref since platform PR-A, 2026-11-28).

`src/council-decisions.mjs` reads it once an hour, from the stored cursor, and stores each update about one of this repo's proposals (`council_proposal_updates`). Nexus shows the latest state beside the proposal. It changes nothing xauusd does: a knob proposal still runs its own shadow test, live and rollback.

**Turning it on:** only after the platform says V3 is live on both the Forge and the AI Kernel. One PR then adds `council.decisions.read` to xauusd-moderator's capabilities in `organism.json` (the census raises `agent_capabilities_changed`; the routine consensus action grants it) and sets `COUNCIL_DECISIONS_POLL` to "on". Adding the capability earlier makes the running DNA schema refuse the whole organ.

## Also in phase 1

- **The seats can cite evidence now.**
  - Before, they received only the pack's text and never its `ev:xauusd/...` ids, so every cited ref was dropped.
  - Now they receive up to 30 citable refs, taken in turn from each source.
  - A ref without its `@as_of` part still counts.
- **Every pack section is seen.**
  - A free pack is about 90 KB. It used to be cut to its first 7,000 characters, so every seat read only the engine section.
  - Each top-level section now gets a fair share of the budget.
