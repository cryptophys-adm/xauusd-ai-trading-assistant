# RFC: Adopting the unported GMI, Prophet and Mizan modules

Status: **accepted, and live without shadow** (owner 2026-11-19, relayed by the orchestrator: "adopsi semuanya"; then
directly, 19 Nov: the order of stages 1 to 6 as proposed, one Pine update of the GMI and Prophet alerts with the Mizan
Probe installed in the same sitting, and one new agent for stage 5; then 2026-11-22, the owner's words (a) to (c) below:
no shadow, built to this design). Each stage is still its own PR, reviewed by the orchestrator, and goes live on merge
behind its own switch and breakers. There is no shadow arm and no separate promotion PR. **As of 2026-11-25** only the
B7 field groups are merged (inert until B11); every stage below is planned. The four agents dismantled on 2026-11-11
(R37 Funnel, GABFX Price Action, Playbook Execution, Grid Bot Protocol) stay dismantled.

"Adopt" means: computed locally from closed bars and read by an agent, by the Key Level Agent as a candidate zone, or by
the Position Manager as evidence. It never means a second decision, a second trade plan or a new Decision Engine witness.

## What the canon requires of every stage

- **Parity (parity_trust_only).** A value is trusted only when TradingView confirms it.
  - A pure formula of closed bars, such as a pivot, a range or a session, is marked *derived* once the bar itself is
    verified against TradingView. This is how Camarilla, CPR and the sessions are read today.
  - An engine-state value (an oscillator, a latch, a score) is *verified* only after 24 consecutive candles match the
    same field in a TradingView alert (`DEFAULT_POLICY.promoteAfter`).
  - Until then the line is shown as unverified. Nothing is marked verified by hand.
- **Promotion (promotion_by_owner).** A new line in an agent's prompt is a new prompt input, and only the owner promotes
  one. The owner's words (a) to (c) of 2026-11-22 (below) are the `promotion_by_owner` act for every stage of this RFC,
  with no shadow arm. The precedent is the Positioning & Liquidity analyst's breakglass ("the owner's word is the
  `promotion_by_owner` act", docs/SSOT.md:1098). Every PR of this RFC quotes (a) to (c) in its body.
  - What stands in for the shadow test: parity (a line stays unverified until its 24 candles), a switch per line or
    agent, the Position Manager line breaker, and the Mizan Oracle's daily neuron cap (all under "This design").
- **One decision, one plan (fail_closed_wait).**
  - Mizan s17 (safe_mode, gravity_veto, sniper_override), s20 (the Bayesian verdict and action_label) and the SL, TP
    and position boxes of GMI and Prophet are evidence an agent argues from, never an authority.
  - Prices still come only from the Key Level Agent's plan.
  - Nothing bypasses `tick_value_mismatch`, `volume_below_min` or the profile caps.
- **Public filter.** No new field reaches a public page with a decision, confidence, price or order wording.

## Provenance: the owner's words of 2026-11-22 (verbatim)

(a) "tidak perlu shadow, langsung integrasikan kamu tentukan designnya yang cocok untuk memperkuat council dan kontribusi
lainnya decision, strategi, key level, position dan lainnya seperti agen lainnya"

(b) "integrasi juga tanpa shadow terkait chart pattern dan liquidity, ketiganya dibuat panel visualisasi sendiri
terpisah dalam Intelligence"

(c) "tidak perlu shadow, langsung dipasang sesuai desainmu juga" (this RFC's stages 1 to 6 and the Mizan Oracle)

In English: (a) no shadow; integrate directly, with the design Claude finds right, to strengthen the council and the
other contributions (decision, strategy, key levels, position) like the other agents; (b) chart patterns and liquidity
are integrated without shadow too, each with its own visual panel in Intelligence; (c) no shadow; install it directly to
this design.

## Binding rules (Track B rules 2 to 6, as amended by the orchestrator's errata E0)

2. **Lens B and the other binding limits.**
   - Lens B never opens, sizes or prices an entry. Its switch, floor and staleness gates and every breaker stay.
   - No new price in the rooms, the decision cards, the Position Council (its pinned fields stay), Aether reports or
     public pages. Of Track B's new routes only the Nexus views (`GET /api/liquidity`, `GET /api/chart-patterns`, the
     planned `GET /api/orb`; Cloudflare Access) carry prices.
   - `pinescript/ssot` is untouched. No EA change. The LIVE and strategy arms stay the owner's.
   - Mizan s17/s20 and the indicators' own plans are evidence only.
   - Engine-state fields need 24-candle TradingView parity, else they read "unverified"; bar formulas are "derived".
3. **Where lens B levels go** (E0: the limit council's path stays).
   - They reach `manageIntents`, the ladder's TP2 wait, the limit council's moves of a resting limit (as
     docs/RFC_POSITIONING_LIQUIDITY.md §4.4 already allows), and, once B17 and B18 are built, the Position Manager's
     management level set and the squeeze guard's own `room_liquidity` check, which can only add a block.
   - They are gated on `lensKnobs("liquidity").active` (on and above its floor), `LIQUIDITY_STATE_FRESH_MS` and
     `feed_basis_known`. The signal's `liquidity_on` already holds the first two (`liquidityFields`,
     `src/liquidity-lens.mjs:609-614`; `active`, `src/lens-policy.mjs:127`). Today `brokerKeyLevels` appends lens B
     without checking `feed_basis_known` (`src/omega-engine.mjs:373-386`); B17 adds that gate.
   - They never reach plan entries or targets, the reward guardrail, the `KEY_LEVELS` witness or `decision.key_levels`.
     No new entry path is added.
   - LIQUIDITY is a council-only card outside `quorumOf` and outside `WITNESS_PRIORS` (B15, merged); no canon change.
4. **V14 holds.** `ENGINE_CODE_HASH` is refreshed only by the PRs that touch hashed engine code (A5, A13, B5, B17, B18,
   B19, B25 and B28 as briefed), and is recomputed on rebase. `ENGINE_BEHAVIOUR_HASH` must not move.
5. **Switches reach `buildStrategy` and `buildKeyLevels` only through `modes`** (`loadStrategyInputs` and
   `ownTimeframePlan`'s loader). Each is tested.
6. **The Mizan Oracle is a HUD agent of the 15m room only.**
   - The Probe runs on 15m, so its 1H, 4H and 1D identities could never verify. Its lean reaches the decision only
     through the M15 room witness, like every other 15m seat.
   - It is **not** a Decision Engine witness. These stay unchanged: `WITNESS_KEYS` and `WITNESS_PRIORS` in
     `src/witness-weighting.mjs` (:21, :26), `WITNESS_KEYS` in `src/witness-tuning.mjs` (:38,
     `Object.keys(WITNESS_PRIORS)`), and Aether's canon rule `decision_engine_ssot` (cryptophys-aether
     `canon/doctrine.json`).
   - Only the council's own `weighed` list (`src/decision-engine.mjs:748`, filtered at :875) gained a key, LIQUIDITY
     (B15).
   - A separate Mizan witness needs a canon amendment and the owner's explicit OK. The owner approved one on
     2026-11-23 as its own item (MZ1, with the Aether amendment AE2, after B15, B26 and B27). B7 declares its parity
     group `probe_mizan_witness` (`net_witness`, `prior_edge`; inert). Nothing in this RFC builds that witness.

## Stages

The order is my recommendation: cheapest first, then what serves the mode in force (scalp, 92% of decisions on 10-19
Nov), with new agents last.

| Stage | What | Read by | New agent | Parity route |
|---|---|---|---|---|
| 1 | **Computed but unread** (list B). GMI: Aegis buy/sell volume, bar delta, CVD 14, volume surge, validated OB bounds and nearest OB stop, Spacetime Warp, TVA adaptive period, previous-session profile and whale zones, the reversal-bar and JMA projection values. Prophet: early confirmation, divergence events with origin, OB rank/retests/high-volume, risk-gate numbers, pro_core. Mizan: ob_high_volume, vol_anomaly. | Existing HUD agents: Aegis, Kinetic, Fabio, Order Blocks, Prophet, Trade Management | No | Pure bar formulas are derived. Engine fields go into the GMI and Prophet `*.hud.v2` candidates in `pinescript/candidates` (B10; `pinescript/ssot` untouched); the owner installs them, then the 24-candle parity applies per field group. |
| 2 | **Scalp signals.** Decision Matrix Scalp Burst Index (5 points). Prophet: momentum strengthening/weakening suffix, ±0.35 threshold crossings and bands, CSHI score and the MARKET row, counter-trend reversal watch, momentum projection. | Decision Matrix and Prophet (rooms); Position Manager as evidence | No | Engine fields in the `*.hud.v2` alerts (as stage 1). |
| 3 | **Level families.** Chronos: Asian range, daily R1-R3/S1-S3, CPR width class against the 20-day mean, wick reject, CPR × GMI confluence. Interstellar Eyes 5m Camarilla column, the 10 unused Fibonacci ratios, the TDM histogram blocks. Prophet R37 rolling 20/50/100-bar extremes. | Chronos and Interstellar (rooms); the Key Level Agent as candidate zones | No | Derived (pure bar formulas). |
| 4 | **Order flow and structure.** Aegis WAI, ACC/DIST diamonds and life CVD; Kinetic Anomaly Jerk and phase label; Tactical VPT; Fabio Active SMR and MML liquidity. Mizan s15 bos_detect and sweep_detect, s21 trap_detect, s16/s25 52-week extremes and macro trendline, s14 zone metrics. | Aegis, Kinetic, Tactical, Fabio, Order Blocks; Position Manager as evidence | No | GMI fields in the `*.hud.v2` alert. The Mizan structure functions are derived where they are pure bar formulas; the rest go through the stage 5 Probe. |
| 5 | **The Mizan statistical stack.** s1-2 weights; s3 phi_wave and regime_score; s4 oracle_signals; s5 mtf_hurst, mtf_zscore, phi_confluence; s8 risk_score; s11 psi_field, gamma_dilation, psi_adaptive, rho_phase; s12 asset_gravity; s13 entropy_tensor, vol_anomaly_tensor, noise_level; s14 confidence_matrix; s17 safe_mode, gravity_veto, sniper_override; s18 div_bonus; s19 state_energy; s20 bayesian_net_tick and action_label; s22 markov_win_rate. | **A new agent, "Mizan Oracle"**, a seat of the 15m room only; never a Decision Engine witness (rule 6) | **Yes** | No installed indicator calls these functions, so TradingView has no reference. A small **Cryptophys Mizan Probe** indicator, `pinescript/candidates/Cryptophys-Mizan-Probe.v1.txt` (B10), calls the library and sends the values in one alert JSON on 15m. The owner installs it on TradingView; the usual 24-candle parity then applies per group. |
| 6 | **Second trade plans, as evidence only.** GMI Fabio progressive SL, SMC zones, position box and % CAP sizing; Prophet latched entry reference, manual position management and its exit reasons, TARGET KEY latch and HIT; Mizan s19 project_tp/project_sl. | Position Manager, as "what the indicator's own plan says" beside Omega's plan, in R and ATR only, each a line behind the breaker | No | Engine fields in the `*.hud.v2` alerts. They are never used as a price for an order. |

## This design (owner 2026-11-22: "kamu tentukan designnya")

### Build items and status (2026-11-25)

| Item | What | Stage | Status |
|---|---|---|---|
| B7 | Parity field groups | all | **merged** (#572), inert until B11 |
| B10 | GMI and Prophet `*.hud.v2` and the Cryptophys Mizan Probe v1 (Pine candidates) | 1-6 | built (this PR): files in `pinescript/candidates`, sources registered, groups declared and inert until B11; the owner installs by 2026-12-08 |
| B11 | Adopt records: the producer publishes `gmi_adopt` and `prophet_adopt` | 1-6 | planned |
| B20, B21, B22, B24 | HUD lines: stage 1; stage 2 scalp; stage 3 levels; stage 4 order flow and structure | 1-4 | planned |
| B23 | Key Level Agent families (Asian range, daily R/S, 5m Camarilla, Fibonacci ratios, R37 extremes) | 3 | planned |
| B5 | Position Manager lines, each behind a breaker | 2, 4, 6 | built (this PR): the PM's broker-action rules are lines; the inputs of later stages join as lines when their PRs land |
| B25, B28 | Position Council lines; the indicators' plans and the Mizan projection as evidence | 2, 4, 6 | planned |
| B26 | The Probe's local port (15m) | 5 | planned |
| PF1, B27 | The platform registration of `hud-mizan-oracle`; the Mizan Oracle agent | 5 | planned (`hud-mizan-oracle` is declared idle in `organism.json` since DNA-1, #529) |
| B3, AE1, CTA1 | Mizan verdict words never public, never instructions; the Aether and CTA mirrors | 5 | planned |
| B6 | A per-agent off list and the daily neuron cap | 5 | planned |

### The field groups (B7, merged)

- Parity is trusted per group of fields instead of per whole engine, so one bad field revokes only its group
  (`PARITY_GROUPS`, `groupIdentityOf`, `compareWithWebhooks(record, webhooks, policy, { fieldMap, nullEqual,
  requireFinite })` in `src/parity-registry.mjs`; docs/SSOT.md §3 "Field groups"). Each group has its own 24-candle
  window, approval and revocation. No group id starts with `mizan`. Unknown HUD ids are dropped from a snapshot, not
  rejected.
- `PARITY_GROUPS` holds `probe_mizan_witness` (MZ1's, inert) and, since B10, these groups (ids prefixed with their engine,
  because B7 rejects a group id equal to an engine name such as `gmi_hud`; field lists in `src/parity-registry.mjs`):
  - engine `gmi_adopt` (source `gmi_v12_70_adopt_hud`): gmi_adopt_hud, gmi_adopt_flow, gmi_adopt_kin, gmi_adopt_zone,
    gmi_adopt_zone_levels, gmi_adopt_burst, gmi_adopt_order, gmi_adopt_levels, gmi_adopt_plan;
  - engine `prophet_adopt` (source `prophet_r38_adopt_hud`): prophet_adopt_hud, prophet_adopt_core, prophet_adopt_ob,
    prophet_adopt_scalp, prophet_adopt_plan;
  - engine `probe_mizan` (source `probe_mizan_hud`): probe_mizan_core, probe_mizan_mtf, probe_mizan_decision,
    probe_mizan_state.
  They stay inert until B11: the three engines are neither ingested nor base engines, so a local record is refused and
  the groups have no identity; an early alert is stored for parity only and trusts nothing.
- A line is verified only through its group's trusted copy. Every other line reads "unverified" (engine state) or
  "derived" (bar formulas).

### B10's wiring (planned)

- **Files.** New `pinescript/candidates/Global-Multiverse-Interceptor-v12.70.hud.v2.txt`,
  `The-Prophet-v7.02-R38.hud.v2.txt` and `Cryptophys-Mizan-Probe.v1.txt`. `pinescript/ssot` is untouched (AGENTS.md
  rule 6). Each v2 file is its v1 plus one block: only the titles change ("· R12 ADOPTION HUD", "· R38 ADOPTION HUD"),
  the inputs are unchanged with the secret last, and the five existing payloads stay byte for byte.
- **Alerts.** One `alert()` per confirmed bar on 15, 60, 240 and 1D. Every field is computed on every bar; only the
  payload assembly is gated by `barstate.isrealtime` and `barstate.isconfirmed`. Codes and numbers, never rendered
  strings, no `bar_index`.
- **The Probe** (Pine v6, `overlay=false`, `CryptophysMizanLib/4`) alerts only on 15m. It uses seven
  `request.security` calls (at most 8); the v2 files add none (the GMI v1 already has 25). Its outputs are `net_raw`,
  `net_core`, `net_final`, `action_code` −3..+3 (the label is never emitted), bos, sweep, trap and the 365-bar extremes
  as bar offsets.
- **Registration.** `SOURCE_ALIASES` and the accepted sources in `src/index.ts` (:140) gain `gmi_v12_70_adopt_hud`,
  `prophet_r38_adopt_hud` and `probe_mizan_hud`; `SOURCE_NAMES` in `src/health-alerts.mjs` (:77) names them;
  docs/HUD_CANDIDATE_INSTALL.md gets the install steps.
- **Tests.** v2 minus the block equals v1; the `request.security` counts; payloads within 5,000 characters (2,000 for
  the Probe); the Pine validator passes (validation only).
- **Install** (the owner, by 2026-12-08). On `OANDA:XAUUSD` 5m, 15m, 1H, 4H and 1D the v2 files replace v1, with one
  "Any alert() function call" alert each to the AI Worker's webhook; the Probe goes on 15m only, for 11 alerts in all.
  No session touches TradingView. Off: the owner pauses an alert.

### The Mizan Oracle (planned: B26, PF1, B27)

- A HUD agent of the 15m room only (rule 6): `indicator-manifests.mjs` `mizan_oracle` with `rooms ["M15"]` and HUD
  identity `probe_mizan_core`. No 1H, 4H or 1D seat. Confidence capped at 0.4 until its group is verified.
- It states the measured inputs and scores in plain words, never the action label, `sniper`, `override`, `veto`,
  `safe mode` or a price (B3's room check, below).
- It reports to the platform as `hud-mizan-oracle` only after `AGENTS.whoami` returns "enabled" (B27's first-publish
  gate; PF1 registers it).
- **No CTA figure.** The public War Room scene leaves it out (`publicRoomScene`, `src/public-warroom.mjs:125`, after
  B3), so the CTA War Room keeps its figures and gets no new one.
- Off: `HUD_AGENTS_OFF=mizan_oracle` (B6), or its neuron cap.

### The Position Manager line breaker (B5, built)

Track B is "live, no shadow" (owner 2026-11-22: "tidak perlu shadow, langsung integrasikan …", words (a) above). As
built under erratum E7, `src/pm-line-breaker.mjs`; docs/SSOT.md (Omega broker engine) has the full rules.

- The Position Manager closes live positions by itself, so each rule of it that sends a broker action (a close, a stop,
  a target) is a **line** with an id (its `position_actions.rule`) and an int version (`PM_LINES`):
  - the fixed rules `take_profit_weakening`, `lock_tp1`, `breakeven`, `tp2_target`, `tp2_breakeven`, `cut_loss`;
  - A8's `loosen_*` (three) and `tp_nearer_*` / `tp_further_*` (five) rules, which write `position_actions` too;
  - `liquidity@1`: lens B's management actions exist on main (cut_loss's `liquidity_sweep_against` reason and A8's
    `tp_nearer_liquidity_sweep_against`), so the line is registered now and is the cause whenever lens B's reading set
    the action; B17 adds lens B's levels to it;
  - PM-1M's `pm_fast_tp` and `pm_fast_cut`.
  - Not lines: RE1's `pm_reentry` (it opens a new position and manages none) and every hold, wait or diagnostic outcome.
  - Still to come, each registered by its own PR: `setup` (A13), `prophet_momentum` and `order_flow` (B25), `gmi_plan`,
    `prophet_plan` and `mizan_projection` (B28).
- `position_actions` gains `lines_json` ({ present, cause }, tags `id@version`). A close counts for one line: the line
  that sent it, else the line of the position's last applied stop or target change before it. R = the deals' net /
  `risk_usd` (the open's own, else the stop's money as the live parity counts it). `r_vs_hold` (R minus holding to the
  plan's SL/TP on `broker_bars_1m`) is recorded beside it.
- A line goes off by itself when its last 15 closes average below 0R (KV `pm:line-breaker:v1`, an `omega_events`
  `pm_line_off` row and one Telegram line, once per trip). An off line's rule is skipped as if it did not fire. It comes
  back only by a version bump or the owner (`POST /api/pm-lines` on the Omega Worker, with `/api/probation`'s owner,
  origin and body checks; turning a line on is the only action). `PM_LINES_OFF` switches a line off by hand.
- **Version.** Only a code change bumps a line's version: a change to the rule itself, its thresholds or the inputs it
  reads (for example B17 adding lens B's levels to `liquidity`). A bump turns the line back on and resets it: `closes`
  goes to 0 and the last-15 window counts only closes of actions taken at the new version. The owner's turn-on resets the
  window the same way at the same version.
- **What a close is.** For a stop line (`breakeven`, `lock_tp1`, `loosen_*`, `pm_fast_cut`'s tightening, `pm_fast_tp`'s
  lock) and a target line (`tp2_*`, `tp_nearer_*`, `tp_further_*`, `pm_fast_tp`'s nearer target): the final close of a
  position whose last applied SL/TP change was that line's, whoever closed it. For a close line (`cut_loss`,
  `take_profit_weakening`, `pm_fast_cut`'s early close): the close the line itself sent.
- **v4.** Each change of the set of off lines is an `omega_events` row with the whole set; v4 replays the set in force
  at each minute from them.
- This replaces the Position Manager shadow arm once planned here (stage 0b).

### The daily neuron cap (planned: B6)

- `AGENT_NEURON_CAPS` (new `src/agent-caps.mjs`): `mizan_oracle` capped at **20,000 neurons a UTC day**
  (`MIZAN_ORACLE_NEURONS_PER_DAY_MAX`, default 20000; "0" means no cap), checked hourly beside `checkShadowBudget`
  (`src/index.ts:3424`) from the meter the usage pages already read.
- When it is crossed: KV `agent-neuron-cap:v1`, one Telegram line ("XAUUSD SYSTEM · Mizan Oracle paused until 00:00 UTC:
  its room calls reached N neurons today (cap 20,000)"), and the rosters drop the agent until midnight UTC.

## Settled before building (orchestrator review of this RFC)

Settled 1 (a Position Manager shadow arm before any Position Manager line) and settled 2 (one shadow arm per agent and
stage) are **dropped**: the owner's words (a) and (c) of 2026-11-22 remove the shadow stage. The Position Manager's new
inputs go behind the line breaker instead, and the other agents' lines behind their switches and parity.

3. **One Pine update and one reinstall for every stage.**
   - Emitting a field costs nothing until an agent reads it, and the 24-candle parity count can start for every field at
     once. So one Pine update (B10) carries every field of every stage: the GMI and Prophet `*.hud.v2` candidates and
     the Cryptophys Mizan Probe v1, all in `pinescript/candidates`. `pinescript/ssot` is not edited. The owner installs
     them once, in one sitting.
   - **Size.** TradingView allows 40,960 characters in a message built by Pine's `alert()` or `alert_message` (4,000 in
     the alert dialog's Message field). The alerts are "Any alert() function call", so the larger limit applies; B10's
     tests hold each payload to 5,000 characters (2,000 for the Probe).
   - A payload close to its limit is split into a second `alert()` call on the same bar.
   - Inbound webhooks do not count against the 500-a-day budget, which is the pull adapter's outbound calls.
4. **Path-dependent values.** Life CVD, the SMR reservoir, whale-zone HP and age, the Markov win rate and other cumulative values depend on where the history starts. The chart's start depends on how much history TradingView loads, which the local replay cannot match.
   - These values are compared by their **per-bar change**, the increment of the closed bar, which does not depend on the start. Their level is shown only as unverified context.
   - A value that is not cumulative but has a long warm-up (for example a 52-week extreme) is compared only after the local series covers its whole window.
5. **What the Mizan agent may say.**
   - Mizan s17 (`safe_mode`, `gravity_veto`, `sniper_override`) and s20 (`action_label`, the Bayesian verdict) would be verdicts in everything but name. The agent states the measured inputs and the score, for example "the Bayesian posterior for a long is 0.62". It never states the label as an instruction.
   - The words `sniper`, `override`, `veto`, `safe mode` and the action labels are added to the public filter as decision words. They never reach a public page (B3, planned; CTA1 mirrors it).
   - The council does not read the agent as a witness. The agent is a seat of the 15m room, so its lean reaches the
     decision only through the M15 room witness, as evidence, never as an authority (rule 6).

## Cost

**Baseline** (D1 `ai_usage_daily`, 2026-11-20): **3,289 model calls, 4.79 million tokens and 101.4k neurons** in the
day. An earlier sample (weekdays 16-18 Nov) gave about 4,200 calls and 6.1 million prompt tokens a day; its largest
sources were:
- the decision council (105 calls, about 10,000 tokens each);
- the War Room openings (641 calls, about 830 tokens each) and rebuttals (618 calls, about 1,700 tokens each);
- the timeframe rooms;
- the shadow arms, which roughly doubled the openings.

**Caps in force today** (checked against the code on 2026-11-25):
- Among the room calls, only `shadow:*` rows have a daily breaker: `checkShadowBudget` (`src/shadow-switch.mjs:129`,
  run hourly from `src/index.ts:3424`) switches shadow mode off when today's shadow calls pass
  `SHADOW_NEURONS_PER_DAY_MAX` (default 25,000).
- SB1 (2026-11-25, owner: "news_compare saja"): with the FS1 switch `SHADOW_MODEL_ROUTER` on (off by default), the news
  shadow comparison's two readings go to Reflection's Beam (`src/model-router.mjs`), which has no neuron rate. Beam has
  its own caps: 100k input and 20k output tokens a day, 20 requests a day, 2 a minute, 2,000 output tokens a call;
  `shadowSpendToday` reads its `ai_usage_daily` rows as those counters (`beam`), so a Beam call never passes the shadow
  breaker at 0. Any cap, error or paid sign falls back to the Workers AI call, priced in neurons as before
  (docs/SSOT.md, "Shadow model router").
- These have their own daily caps:
  - the Position Council and the Entry Council share `POSITION_COUNCIL_DAILY_USD` (`src/position-manager.mjs:91`,
    default 5; `wrangler.jsonc` "5"; the limit council's spend is counted against it, `src/limit-council.mjs:17`);
  - the mode council: `MODE_COUNCIL_DAILY_USD` 0.25 (`src/mode-selector.mjs:36`);
  - Call for Councils sessions: `CFC_NEURONS_PER_DAY_MAX` 8,000 (`src/cfc-session.mjs:189`, default
    `SESSION_LIMITS.neurons_per_day` at :26).
- The room agents (the War Room and the timeframe rooms' live seats) have **no daily cap** until B6 adds one per agent,
  starting with the Mizan Oracle's 20,000 neurons.

**Per stage.** A new HUD line costs about 25-40 tokens. It is paid in the agent's own opening and again in the rebuttals
that quote openings. The estimates below were made with a shadow copy included; without a shadow arm that copy is never
paid, so they are upper bounds.

| Stage | Extra prompt tokens a day | Share of the 16-18 Nov sample | KV / D1 |
|---|---|---|---|
| 1 | +150k to +200k | about +3% | No new KV writes: the fields ride on the existing HUD snapshot write (a slightly larger value). |
| 2 | +100k to +150k | about +2% | None new |
| 3 | +50k (room lines); the Key Level Agent is deterministic | about +1% | None new |
| 4 | +100k to +150k | about +2% | None new |
| 5 | +300k to +450k: a new opening in the 15m room, plus its rebuttals | about +5 to +7% | About +10% room message rows in D1. One more TradingView alert: about 96 inbound webhooks a weekday. These are not counted in the 500-a-day budget (`tv-budget`), which counts only the pull adapter's outbound calls. |
| 6 | +50k (Position Manager prompt) | about +1% | None new |

All stages together come to at most about +15 to +20% prompt tokens. The guards are the room memo, the shadow breaker for
`shadow:*` rows, the caps above, and B6's per-agent cap.

## Knock-on effects

- **Stages 1-4 and 6** add lines to existing agents only. The roster does not change: the platform registry and DNA,
  the kernel's registered agents, and the CTA War Room's figures.
- **Stage 5** adds one agent:
  - a manifest;
  - a platform agent id, `hud-mizan-oracle`, with its registration (PF1) and DNA (declared idle since DNA-1);
  - the public filter for its lines (B3);
  - a reputation and scorecard entry.

  It adds no CTA War Room figure, and no Decision Engine weight: it is not a witness (rule 6).
- **Docs.** `docs/HUD_AGENTS_ASSESSMENT.md` is stale. It says Camarilla is not ported and that s_jerk is computed
  locally; both are wrong on main. Stage 1 corrects it.

## Questions for the owner (answered 2026-11-19)

1. **The order.** Is stage 1 → 2 → 3 → 4 → 5 → 6 the right sequence, or should something come first? **Yes, as proposed.**
2. **Parity for the engine fields.** Agree to extend the GMI and Prophet alert JSON and to reinstall the two alerts on
   TradingView when a stage is ready? **Yes, once, with every field of every stage.** As built (2026-11-22 design): the
   fields go into new `*.hud.v2` candidates in `pinescript/candidates`, never into `pinescript/ssot`, which stays
   untouched (AGENTS.md rule 6).
3. **Parity for Mizan.** Agree to install a **Cryptophys Mizan Probe** indicator with one 15m alert? Without a
   reference, the Mizan values can only be shown as unverified. **Yes, in the same sitting.**
4. **Stage 5 agent.** One new "Mizan Oracle" agent in the rooms, or spread the values over the existing agents, with no
   new agent? **One new agent.** It is a HUD agent of the 15m room only and is not a Decision Engine witness; a Mizan
   witness is a separate item (MZ1) with its own canon amendment.
