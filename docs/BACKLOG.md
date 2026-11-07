# Backlog

Open work that waits on something: the market, a date, or the owner. `docs/SSOT.md` stays the
canonical description of the system; `docs/CHANGELOG.md` records what changed. An item leaves this
file when it is done (and enters the CHANGELOG) or when the owner drops it.

## Waits for the market to reopen (first check: Monday 2026-11-09, 01:20 UTC, scheduled)

The gold market closes from Friday evening to Sunday evening (UTC), so the changes of 2026-11-07
have run in preview only. A scheduled check reads production (read-only) after the reopen and
reports to the owner.

1. **H1 decision by Consensus Discussion (#131).**
   - `GET /api/threads/timeframe?chart=H1`: `reasoner_decision.chain` is `consensus_reasoner`, and `consensus.status` is `concluded` (or `partial` / `empty` at the 45-minute fallback) for the bars after the reopen.
   - No bar stays parked (`analysis_runs` status `analyzing`, `error_code` `awaiting_consensus` or `finalizing`) beyond 45 minutes after its close.
   - The guard (`consensus.guard_overridden`) is rare. If it fires often, the Reasoner prompt needs work.
2. **Model migration (#132).**
   - The War Room and the 1H, 4H and D1 rooms: openings on `@cf/google/gemma-4-26b-a4b-it` (fallback `@cf/openai/gpt-oss-20b`), conclusions on `@cf/openai/gpt-oss-120b`.
   - Count `ok` against `agent_failed` and `invalid_output`, and how often `fallback_used` is set. Compare with the rates before the migration: about 96-98 % of openings ok, frequent 3021 rate limits on glm-5.3-flash.
   - A failed conclusion now carries `errors`, `model` and `raw` in the room API. Read them and fix what they show, before glm-5.3-flash and nemotron stop answering on 2026-11-20.
   - `/api/status`: `ai_worker.models` reads gpt-oss-120b for the news chain and the H1 Reasoner.
3. **The 1H room right after the close (this backlog's PR).**
   - `consensus.decided_after_close_s` in the H1 synthesis.
   - Target: about 10 minutes after the close (before: 15-45 minutes).
   - The logs show `h1_room` and `h1_consensus_decision ... "via":"h1_room"` for most bars, and the sweep finishing only the rest.

## After one week of the new chain (from about 2026-11-16)

4. **Scorecard: is the decision still "always WAIT"?** The owner's starting problem (2026-11-06).
   - The split of BUY, SELL and WAIT from the H1 Reasoner and from the strategy engine.
   - How often the consensus guard overrode the Reasoner.
   - The outcome scoring of those decisions.
   - Then decide with the owner whether the rules need loosening or tightening.

## After 2026-11-20 (Workers AI retires glm-5.3-flash and nemotron-3-120b-a12b)

5. **Clean-up (low priority).**
   - Remove the glm-5 and nemotron branches of `modelRequests`.
   - Remove the retired H1 multi-agent bus path: the module stays for its stored history.
   - Remove the legacy `/analyze` bundle chain, which still calls the Analyst and the Counselor.

## Owner actions

6. **Calibrate the 4H and D1 desks.**
   - Install the Prophet R38 and GMI v12.70 alerts on the OANDA:XAUUSD 4-hour and daily charts: "Any alert() function call", same webhook.
   - Until 24 matches (about 4 trading days on H4, about 5 weeks on D1), the 4H and D1 Desks read as not calibrated and speak at confidence 0.4 or lower.
7. **HUD backlog (owner, 2026-11-05).** B4 (merge the GMI core copy; needs a new H1 GMI approval in a calibration window) and the Grid Bot Protocol HUD. See `docs/BRIEF_HUD_AGENTS.md`.
