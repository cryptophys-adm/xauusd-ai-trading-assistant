# RFC: council proposals, from the owner's pick to a change, without Claude

- **Status:** phase 1 built, phase 2 next.
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
| `decision.min_confidence` | 0.4 | 0.3 to 0.6 | 0.05 |
| `decision.min_rrr.intraday` | 1.5 R | 1 to 2.5 | 0.1 |
| `decision.min_rrr.swing` | 2 R | 1.5 to 3 | 0.1 |
| `decision.quorum_min.scalp` | 0.45 | 0.4 to 0.65 | 0.05 |
| `decision.quorum_min.intraday` | 0.5 | 0.4 to 0.7 | 0.05 |
| `decision.quorum_min.swing` | 0.6 | 0.45 to 0.75 | 0.05 |
| `strategy.near_atr` | 0.35 ATR | 0.2 to 0.6 | 0.05 |
| `agents.max_risk_atr` | 2.5 ATR | 1.5 to 3.5 | 0.25 |

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

## Phase 2 (next): the shadow test, live and rollback

The plan reuses the machinery that already runs: the paired comparison and gates of grid auto-adapt, and the Holm-adjusted tests, holdout and reverse-shadow rollback of witness tuning.

- **Runtime override.** A `queued_shadow` proposal's value is read at decision time from one KV document. The registry's bounds are clamped again there.
- **Shadow test.** The test replays the recorded decisions and their outcomes in R. For each decision it checks whether it would have passed or failed under the candidate value, against the control (today's value).
- **Gates before going live:**
  - a minimum sample;
  - a positive mean difference;
  - the newest quarter of the data no worse;
  - a bootstrap lower bound above 0.
- **Live and rollback.** If the gates pass, the value goes live. It rolls back by itself if the live result is worse than the control over a set window. A rolled-back value is not tried again.
- **Reporting.** Each step is a Telegram line and a `typed_proposal.v1` state update to the platform.

## Also in phase 1

- **The seats can cite evidence now.**
  - Before, they received only the pack's text and never its `ev:xauusd/...` ids, so every cited ref was dropped.
  - Now they receive up to 30 citable refs, taken in turn from each source.
  - A ref without its `@as_of` part still counts.
- **Every pack section is seen.**
  - A free pack is about 90 KB. It used to be cut to its first 7,000 characters, so every seat read only the engine section.
  - Each top-level section now gets a fair share of the budget.
