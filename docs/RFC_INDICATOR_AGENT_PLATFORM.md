# RFC: Indicator agent platform

- **Status:** Draft. Owner decisions 2 and 3 (§10) approved on 2026-11-05: the scoring definition and the stuck-state thresholds. P1 is implemented (`src/outcome-scoring.mjs`, see `docs/SSOT.md`). Decisions 1 and 4–6 are still open.
- **Date:** 2026-11-05
- **Author:** Claude (orchestrator)
- **Owner direction (2026-11-05):**
  - The move from webhooks to the local lane is the basis. Every indicator is reviewed and refined locally.
  - A control plane acts as the AI Worker operating system behind the scenes. It audits and continuously improves every indicator, and each indicator becomes an agent that keeps calibrating.
  - More agents will represent other indicators, such as order block and supertrend.
  - The end goal is an assistant like Moltbook: a community of indicator agents that work together and discuss, up to a crowded-market analyst.
- **Builds on:**
  - `docs/SSOT.md` §3: the local-primary lane, parity and calibration;
  - `docs/RFC_HUD_AGENTS.md`: one agent per HUD;
  - `docs/RFC_NEXUS_AGENT_SOCIAL.md`: threads and the live room;
  - cryptophys-cloud-platform ADR-0007: the AI Worker OS, its autonomy tiers and the AI Kernel.

## 1. Goals and non-goals

### Goals

1. **Indicator agents.** Every indicator is one indicator agent. It has:
   - a local engine;
   - a plain-language reading;
   - a persona in the discussion rooms;
   - a measured track record.
2. **Easy to add.** A new indicator (supertrend, order block, …) is added by registering one contract, not by editing ten files.
3. **Two independent kinds of correctness:**
   - **Fidelity:** the local port equals its reference. This is parity, as today.
   - **Quality:** the indicator's statements turn out right. This is outcome scoring, and it is new.
4. **Continuous improvement.** An improved indicator version runs in shadow beside the active one. It is compared on both kinds of correctness, and it is promoted only with the owner's approval.
5. **Control plane audit.** The AI Kernel (cryptophys-cloud-platform) reads the registry and the scores, publishes audits, and proposes improvements and calibration windows. A human approves.
6. **A crowded-market view that scales.** Many agents, a discussion weighted by track record, and a budget that stays bounded.

### Non-goals and hard rules (unchanged)

- Advisory only. There is no order, broker, wallet or execution at any tier (ADR-0007 `PROHIBITED_CAPABILITY`).
- The H1 decision chain stays authoritative. Agents discuss; they never change the decision, prices or size.
- `pinescript/ssot/*` is never edited. Improvements are new versions with their own provenance (§4.3).
- No shared secrets between Workers: RPC Service Bindings only. Deploys happen only by merge.

## 2. Where we are today

| Piece | State |
| --- | --- |
| Local engines | Prophet R38 and R37, GMI v12.70, Mizan. The ports are parity-approved on H1 (prophet 35/35, gmi 36/36 on 2026-11-05). The 5m identities are near approval. |
| HUD agents | 13 HUDs computed (`hud-snapshot.mjs`) and read in plain language (`hud-reading.mjs`), with one agent each in Threads 1H and four in the live 15m room. Grid Bot Protocol is not computed. |
| Discussion | Threads 1H, news threads and the live 15m room, with replies, moderators and consensus. |
| Calibration | Webhooks are calibration only (`CALIBRATION_INTERVAL_DAYS = 30`). |
| Control plane | The AI Kernel runs agents as Durable Objects with tiers 0–2, a Policy Engine, an audit ledger and MCP. The Signal Analyst (TP-017) already reads XAUUSD decisions. |
| Missing | Outcome scoring, a uniform indicator contract, a lifecycle for improved versions, and an indicator audit in the control plane. |

**The case that motivates this RFC.** From 00:00 to 12:00 UTC on 2026-11-05, Prophet R37 held structure subtype 1 (bull trap) with `b_enc = -4` on every H1 candle, while the close moved from about 4065 to 4140 and back to 4120.

- GMI then forced `verdict = 0` and `gate = -1` ("Prophet risk hold"), so the chain said WAIT for twelve hours.
- TradingView's own alerts carried the same values, so the port is faithful. The behaviour comes from the indicator design: the latch has no expiry.
- Parity cannot see this kind of problem. Outcome scoring and a stuck-state detector can.

## 3. Indicator agent contract

Each indicator registers one manifest:

```
indicator-agents/<id>.mjs  (exports MANIFEST)
  id, name, family            e.g. "supertrend", "Supertrend", "trend"
  version                     semantic; part of the provenance identity
  timeframes                  ["60", "15", "5"]
  engine(bundle, {chart})     pure: closed OHLCV -> outputs   (local-engines/...)
  outputs                     JSON schema of the outputs
  comparable                  output fields that have a reference to compare with (parity)
  reference                   { kind: "pine_ssot" | "pine_candidate" | "builtin" | "none",
                                source, alert_source? }
  reading(outputs, verified)  deterministic plain-language lines, each with `verified`
  persona                     room(s), stances, what the agent may and may not claim
  budget                      max calls per hour, per room
```

**Provenance and parity.**
- The provenance generator (`scripts/engine-provenance.mjs`) adds every manifest's engine files to its identity.
- The parity registry is unchanged: an identity is engine, timeframe, source hash and implementation hash.
- An indicator with `reference.kind = "none"` can never be labelled "verified by parity". It is judged only by outcome.

**Existing engines.**
- Prophet, GMI, Mizan and the 13 HUDs get manifests that wrap the current modules.
- The hashed files do not change, so no approval is reset. The manifest only points at them.

**Generated surfaces.** The producer, the HUD snapshot, the readings, the agent rosters and Nexus labels iterate over the manifests instead of hand-written lists.

## 4. Lifecycle of an indicator version

```
draft -> candidate -> calibrating -> active -> under_review -> retired
                         (shadow)               (auditor flag)
```

- **Candidate.**
  - It is computed and stored on every closed bar and scored (§5).
  - It is not shown in the rooms. It is visible only in a "shadow" view on Nexus.
- **Calibrating.**
  - A version with a reference earns parity (24/24 per timeframe, as today) in a calibration window. The owner installs the reference alert, and webhooks run in calibration mode.
  - A version without a reference needs a minimum outcome sample instead, proposed as 200 scored statements per timeframe.
- **Active.** It speaks in its rooms, with "verified by parity" or "not yet calibrated" per statement, as the HUD agents do now.
- **Under review.** The auditor (§6) flags one of these:
  - a parity mismatch;
  - a score below threshold;
  - a stuck state (§5.3).
  The agent keeps speaking but carries a visible caution label.
- **Retired.** It is no longer computed, and its history stays readable.

### 4.3 Improved versions

An improvement, such as giving the bull-trap latch an expiry, is a **new version of the same indicator**:
- it has its own engine file and provenance identity;
- it starts as a candidate in shadow beside the active version.

Because it deliberately differs from the Pine SSOT, it cannot have parity with it. It needs one of two references:

- **(a) Pine candidate.** The owner installs it on TradingView as `pinescript/candidates/...`. It becomes the reference for the new version, and parity is earned as usual. This option is strongest for TradingView users, because the chart and the agent then show the same thing.
- **(b) Local-only version.** It has no TradingView counterpart and is judged only by outcome against the active version, on the same bars.

Promotion compares the candidate with the active version over the same bars:
- higher outcome score;
- no worse calibration (Brier);
- no new stuck states;
- parity, when it has a reference.

The owner then approves the promotion PR.

## 5. Outcome scoring (new, the base of everything else)

Fidelity tells us the port is right. Only outcomes tell us the indicator is useful.

### 5.1 What is scored

- **Every agent statement:** stance, confidence, timeframe and candle key. This covers HUD agents, room agents, moderators, the H1 chain decision, and every indicator version's own derived direction, active or shadow.
- **Every indicator output that implies a direction,** for example R38 confirmations, GMI verdicts and supertrend flips. This is scored without any model, so shadow versions cost nothing.

### 5.2 How

All scoring is deterministic and uses the pulled OHLCV the pull adapter already has. There is no AI in scoring.

- **Horizon.** H1: the next 4 closed candles. 15m and 5m: the next 4 closed candles of that timeframe. The horizon is configurable.
- **Move threshold.** `k × ATR(14)` of the timeframe, with `k = 0.5` proposed.
- **BUY or SELL.**
  - A **hit** when the favourable excursion reaches the threshold before the adverse excursion does.
  - A **miss** when the adverse excursion reaches it first.
  - **Neutral** when neither does.
- **WAIT or HOLD.**
  - A **hit** when neither excursion reaches the threshold.
  - A **missed opportunity** when one does. The direction is recorded, so a WAIT can be shown to have blocked a good move.
- **Confidence.** A Brier score on hit probability, and calibration buckets.
- **Breakdowns.** Per regime (Mizan trend or range), per session (Asia, London, NY) and per timeframe.

**Storage.**
- New D1 tables `outcome_scores` (one row per statement) and `agent_scorecards` (rolling 7-day and 30-day aggregates).
- A new migration; existing tables are not altered.

**When.** A cron in the AI Worker scores each statement once its horizon has closed. It is idempotent per statement, like the parity sweep.

### 5.3 Stuck-state detector

A state field is flagged as stuck when both are true:
- it is unchanged for `N` consecutive candles (proposed: 8 on H1);
- the price range over those candles exceeds `m × ATR` (proposed: 3).

The fields watched are subtype, `b_enc`, `d_enc`, the GMI gate and the verdict. The flag:
- is deterministic;
- is stored with the indicator version;
- feeds the auditor;
- shows on Nexus as a caution on that agent.

The 2026-11-05 bull-trap latch would have been flagged around 08:00 UTC.

## 6. Control plane integration (cryptophys-cloud-platform)

**This repository** (xauusd-ai-trading-assistant) exposes read-only data to the control plane:
- `GET /api/indicator-agents`: the manifests, lifecycle states, parity, scorecards and stuck flags.
- An `IndicatorRpc` entrypoint for in-account Service Binding reads, like the existing `/api/*` reads that the Signal Analyst uses.

**In the cloud platform** (separate taskplane tasks; this session reads that repository only):

| Capability | Tier | What it does |
| --- | --- | --- |
| `indicators.observe` | 0 | Read the indicator registry, scorecards and stuck flags. |
| `reports.publish` (existing) | 1 | An `indicator_audit` report: per agent fidelity, quality, stuck states and cost, published daily and on every flag. |
| `indicators.propose` | 1 | A draft improvement proposal: which indicator, what evidence (scores, stuck episodes, mismatches), and a proposed change in words. A human approves. The code change is still a PR. |
| `indicators.calibration_window` | 2 (later) | Ask the owner to open a calibration window (install or enable the reference alerts). It stays reversible and bounded, and it only schedules the window and notifies. |
| deploy, promotion merge | 3 | Human only, as in ADR-0007. |

The **Indicator Auditor** agent (`indicator-auditor`, `tier_max` 1) runs hourly after the parity sweep and the scoring cron. Its triggers are deterministic: a stuck flag, a score below threshold, a parity mismatch, a calibration that is due, or a shadow version that beats its active version. AI only drafts the wording, as with the other kernel agents.

## 7. The crowded-market view at scale

With dozens of agents, a room cannot post every agent on every bar.

- **Who speaks.** Active agents only. In each family (structure, trend, volume, order flow, levels, …), the agents with the best 30-day scorecard speak, up to a per-room limit. The others contribute a stance without text, at no model cost, because their outputs are deterministic.
- **The crowd line.** A deterministic summary for each bar:
  - the distribution of stances across all active agents;
  - the same distribution weighted by scorecard;
  - a disagreement index, and the families that disagree.
- **The moderator.** It receives the crowd line and the scorecards. It must say when the weighted crowd differs from the H1 decision, which stays authoritative.
- **Reputation is visible.** Nexus shows each agent's track record next to its post, as on a social feed: hit rate, calibration, sample size and caution flags.
- **Cost.** Each room keeps its hourly cap. The control plane can tighten per-agent budgets, which is a tier 2 reversible action, later.

## 8. New indicators

| Indicator | Reference | Notes |
| --- | --- | --- |
| Supertrend | `builtin` (TradingView `ta.supertrend`) | Proposed first. Small, well defined, and trivial to alert from a Pine candidate. It proves the manifest path end to end. |
| Order Block | `pine_candidate` | Needs our definition: displacement, mitigation and invalidation. Aegis Footprint and Trade Management already read OB filter states, so the agent can reuse them. |
| Others (VWAP bands, Ichimoku, RSI divergence, volume profile, …) | per indicator | Added by manifest once Supertrend has proven the path. |

## 9. Phases (one small PR each, CI green, owner review)

1. **P1 (this repo): outcome scoring and the stuck-state detector.** Score the H1 decisions, the HUD agents, the room agents and the indicator outputs, and serve `GET /api/scorecards`. There is no behaviour change in the rooms. Scoring starts immediately, so history accumulates while the rest is built.
2. **P2 (this repo): the manifest and registry.** Manifests wrap the existing engines and HUDs without changing the hashed files. The rosters and readings are generated from the manifests, and `GET /api/indicator-agents` is added. *(Shipped 2026-11-07: `src/indicator-manifests.mjs`, `src/indicator-registry.mjs`; see docs/SSOT.md.)*
3. **P3 (this repo): shadow versions.** Candidates are computed and scored on every closed bar, and Nexus gets a shadow view.
4. **P4 (cloud platform, taskplane): the Indicator Auditor.** `indicators.observe`, the `indicator_audit` report and `indicators.propose`, with a Service Binding to the read API.
5. **P5: the first improvement.** *(Shipped 2026-11-05 as shadow candidates `prophet_r37@latch8`, `prophet_r37@latch12` and `prophet_r38@latch8`. The first real-data replay shows no significant gain; see the CHANGELOG.)* A bull-trap latch expiry is added as a candidate version of Prophet R37/R38, as a local-only version or as a Pine candidate (owner decision 1). It runs in shadow, the scores are compared, and the owner approves or rejects the promotion.
6. **P6: Supertrend** as the first new indicator agent through the manifest path, then Order Block.
7. **P7: crowd line, reputation weighting and Nexus scorecards.** *(Shipped 2026-11-07; see docs/SSOT.md "Crowd line, reputation and scorecards". The open phases P2 and P6 are tracked in docs/BACKLOG.md.)*

## 10. Decisions for the owner

1. **Improved versions.** Should an improvement (for example the latch expiry) be allowed as a local-only version judged by outcome, (b) in §4.3? Or must every promotion come with a Pine candidate you install on TradingView, (a)? **Decided 2026-11-05: (b).** A local-only version is enough, so an improvement is proven by outcome first.
2. **Scoring definition.** Horizon 4 candles, threshold `0.5 × ATR(14)`, WAIT counted as a hit when there is no move: accept these, or change them? **Decided 2026-11-07: accepted** as proposed (with the v3 WAIT rule: a WAIT misses only a 2:1 move of 1 × ATR).
3. **Stuck-state thresholds.** `N = 8` candles and range `> 3 × ATR` on H1: accept or change? **Decided 2026-11-07: accepted.**
4. **First new indicator.** Supertrend first, then Order Block? **Decided 2026-11-07: yes.** Supertrend first, then Order Block (P6, after P2).
5. **Where the auditor lives.** In the cloud platform's AI Kernel, as proposed, with this repository serving read-only data? Or as an agent inside this repository? **Decided 2026-11-05: in the platform.** The 21 XAUUSD agents are registered there (platform migration 0016). This repository publishes advisory reports over the `AGENTS` RPC binding (P4, docs/SSOT.md §2).
6. **Room limits.** How many agents may post text per room and per bar before the crowd line takes over (proposed: 6)? **Decided 2026-11-05: no limit.** Every active agent speaks in its room. The hourly call budget still applies.

## 11. Risks

- **Overfitting.** Promoting a version because it scored better over a short window. Mitigation: a minimum sample, both 7-day and 30-day windows, per-regime breakdowns, and owner approval.
- **Divergence from what traders see.** Local-only versions differ from the TradingView chart. Mitigation: label them clearly ("local version, not on your chart"), and prefer Pine candidates for active versions.
- **Cost growth.** Mitigation: only the top agents speak, the crowd line is deterministic, the hourly caps fail closed, and the control plane manages budgets.
- **Score gaming by the language model.** Scores are computed from prices only, never from model text. Model agents are scored on their stance, not on their wording.

## 12. Addendum: Live War Room 15m (owner decision 2026-11-05)

The owner decided that all agents discuss in one Live War Room at every 15m close. The design is:
- **Communication bus.** Each agent posts one opening from its own data. There is one role per agent, and no information is repeated.
- **Debate.** The debate is open for at most 3 minutes. The minority agents (at most 7) and the Risk Manager rebut named agents.
- **Conclusion.** The conclusion goes to the Nexus main panel.
- **H1 decision.** The H1 decision stays the constraint, and price levels come only from the H1 chain.
- **Per-H1 HUD agents.** They are retired while the War Room runs.
- **Nexus.** The War Room shows the latest discussion only. The right panel is replaced by the Threads 1H and News Thread TLDR.

This is the first step of §7, the crowded-market view. Once P1 scorecards have enough history, the bus majority and the moderator can weight agents by track record (P7). The implementation is in `src/war-room.mjs`, and `docs/SSOT.md` describes it.
