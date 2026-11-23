# RFC: the Positioning & Liquidity analyst, two lenses, live from the start under Aether's bounded weight

Status: built 2026-11-20 in one PR (breakglass, below), live on merge in every role; for the orchestrator's review, then
the owner's. The knob names and bounds of §8 are proposed to the platform session for `DOCTRINE_BOUNDS`; amending a
bound is the owner's. As built: §15. Deviations: §16.

**Decisions (owner, 2026-11-20, confirmed directly in the session).**
1. "Sekarang breakglass urgent jadi langsung live": breakglass. The owner's word is the `promotion_by_owner` act. Both
   lenses ship in ONE PR, live on merge in every role at once (no shadow stage, no staged delivery of §13), with Aether
   moving the weights inside hard bounds. Breakglass waives none of: CI; the orchestrator's review; the hard guards
   (`tick_value_mismatch`, `volume_below_min`, profile caps, daily budget, A7/A8 limits, kill); the automatic drop to
   the floor on a poor score, with an event and a private Telegram line; "liquidity never opens a position alone"; the
   "baseline: insufficient" labelling. Rollback: the owner settings `positioning_enabled` and `liquidity_enabled`
   (default on, because the owner ordered it live); off, the lens contributes nothing.
2. "Setuju": the 10-minute stop and target deferral during a spread spike (§6) is approved. Hard guards are never
   deferred: the fill guard, kill, the daily limit, any forced close.
3. "rekomendasi": liquidity pools join `brokerKeyLevels` with source `"liquidity"`. They are key levels, so A8's
   measured reason "a key level just outside the stop" (`key_level_outside`) covers them. No A8 text change and no
   separate `liquidity_pool_outside` reason (§6 and §12 point 9 are superseded).

Provenance: owner decision 2026-11-20, confirmed directly in the session.
- Scope: "cocok digabung aja kalau sebelumnya untuk decision, liquidity candle ini bisa untuk key level, strategy dan
  position manager … sempurnakan jika ada sanggahan". One agent, two lenses. The refinements and objections the owner
  asked for are marked **Refinement** in the text and listed together in §12.
- Going live: "semua langsung live dipromosikan saja tidak perlu shadow atau trial, aether yang akan mengontrolnya".
  There is no shadow stage. Both lenses are live in every role from their first PR. Aether moves each lens's weight
  within a doctrine bound, and a poor score drops the weight to its floor by itself.

## 1. Why

Two kinds of evidence that the system has but does not use:
- **Positioning.** No witness reads how the large speculators are positioned in gold futures. Today every witness reads
  the chart, the news, the calendar or the dollar. The CFTC Commitments of Traders report gives this once a week for free,
  and it needs no model call.
- **Liquidity on the broker's own feed.** The Omega executor already sends the broker's closed M1 bars with
  `tick_volume` and `spread` (`OmegaExecutor.mq5` `WriteCorpusJson`: `[t_ms, open, high, low, close, tick_volume,
  spread]`). The Worker stores both in D1 `corpus_bars` (`tick_volume`, `spread_points`, `src/corpus-oracle.mjs`
  `ingestCorpus`). Nothing reads them: `readCorpusBars` returns `v` (tick volume) to the MT5 fallback only, and
  `spread_points` is read by nothing. The corpus file itself holds only `CorpusBars` = 120 bars, and D1 keeps
  `CORPUS_KEEP_MS` = 14 days.

## 2. One agent, two lenses

The **Positioning & Liquidity analyst** is one agent with two lenses. Each lens has its own data, its own facts, its own
outcome score and its own weight (§7). They share one name on the page, one report to Aether and one rollback rule.

| | Lens A: positioning | Lens B: liquidity candles |
|---|---|---|
| Data | CFTC COT, weekly, gold (COMEX, market code `088691`) | the broker's M1 bars of the active account: tick volume and spread |
| Scale | contracts and percentiles, no price | broker price scale (key levels only); everything emitted is percentiles and ratios |
| Used by | Decision Engine witness `POSITIONING`; War Room 4H and 1D; a fact for the mode choice and the profile agent | key levels (`brokerKeyLevels`); strategy filter and confirmation; Position Manager reasons; War Room 15m and 1H |
| Weight | `positioning.de_weight_<mode>` (share of the witness quorum) | `liquidity.council_weight_<mode>` (0–1, the councils and the filters) |
| Model call | none | none |

**Never on its own.** Neither lens opens a position, sets a size or sets a price for an entry. Lens A leans one witness
among fifteen. Lens B blocks, confirms, prefers maker over taker, or gives a council a measured reason. Every hard guard
of today stays as it is (§9).

**In the rooms the agent is context, outside the room's quorum (Refinement).** If the agent's bias counted in the 4H
and 1D rooms' quorum, positioning would count twice in the Decision Engine: once inside the H4 and D1 witnesses' lean,
and once as `POSITIONING`. So the agent posts its line and its bias on the bus, but `quorumAllows` and the crowd
(`src/reputation.mjs`) leave it out, as the Decision Engine leaves out `SESSION`. The same holds for lens B in the 15m and
1H rooms: its use is the filter and the reasons, not the room's vote. Its openings are built deterministically from the
facts (a template, no model call), and it does not take part in the Consensus Discussion.

## 3. Lens A: positioning (CFTC COT)

### 3.1 The fetch

- **Host:** `publicreporting.cftc.gov` (Socrata, public, no key). Workers' egress needs no configuration. Cloud
  development sessions that run the live fetch need the host on their environment's allowlist (§11). Tests use
  fixtures and never reach the network.
- **Series:**
  - primary: the disaggregated futures-only report, dataset `72hh-3qpy`;
  - fallback: the legacy futures-only report, dataset `6dca-aqww`.
  - Both are filtered by `cftc_contract_market_code = '088691'` and ordered by `report_date_as_yyyy_mm_dd`. Both were
    checked on 2026-11-20: one request returns 158 weekly rows for three years.
- **Fields read:**
  - disaggregated: `m_money_positions_long_all`, `m_money_positions_short_all`, `change_in_m_money_long_all`,
    `change_in_m_money_short_all`, `open_interest_all`, `change_in_open_interest_all`;
  - legacy: `noncomm_positions_long_all`, `noncomm_positions_short_all` and the same open interest fields.
- **Fallback, per series and never mixed.** When the disaggregated request fails, or its newest row is older than the
  legacy one, the facts come from the legacy series with `series: "legacy"` and a note that non-commercial is a proxy
  for managed money. A percentile is always computed inside one series, never across the two.
- **Backfill at once.** The first run fetches both series in one request each (`$limit=260`): the three years the owner
  asked for, plus one more year. **Refinement:** the extra year gives every historical reading of the last year a full
  three-year window behind it, so the day-one score (§7.2) is not measured on short windows. The backfill is done once
  (KV marker `cot:backfill:v1`) and retried the next hour on a failure.
- **Live schedule and budget**, modelled on the calendar's (`refreshCalendar`: once an hour at most, 10 s timeout,
  `user-agent: cryptophys-nexus/1.0`):
  - from the scheduled release (Friday 15:30 New York time) until the new week's row is stored, at most one request
    per series an hour (KV `cot:fetch:last`), at most 30 requests a week;
  - the step also runs in the closed-market idle sweep (`marketIdleAt`; the steps kept for the heartbeat), so a
    report published after the idle starts, or on a holiday Monday, is still read;
  - no request otherwise. There is no model call and no TradingView call.
- **Storage:** D1 `cot_reports`, kept 5 years:
  - key `(series, report_date)`;
  - `market_code`, `oi`, `oi_change`, `net_long`, `net_short`, `net`, `net_change`;
  - `released_ms`, `released_estimated` (0 or 1), `first_seen_ms`, `revised_ms`.
  - A revised row keeps its `released_ms` and `first_seen_ms`; its values are replaced and `revised_ms` is set.

### 3.2 Point in time: no report before its release

The report reads positions as of Tuesday and is published on Friday at 15:30 New York time, later in a holiday week.
Every reader asks for the report **known at time t**:

- `cotAt(t)` returns the newest row with `released_ms <= t`, never the newest `report_date <= t`.
- For a row first seen live, `released_ms = max(scheduled release, first_seen_ms)`: the moment this system could
  have known it.
- For a backfilled row, `released_ms` is the scheduled Friday 15:30 New York time after its Tuesday, moved to the
  following Monday 15:30 when a US federal holiday falls in that Monday-to-Friday week, with `released_estimated = 1`.
  Weeks of a known publication outage (CFTC's own release schedule) are listed in code (`COT_DELAYED_RELEASES`) with
  their real release day. An outage whose per-week days are not listed yet is a window in `COT_PUBLICATION_OUTAGES`:
  every report dated inside it counts as released no earlier than the end of the catch-up (conservative: read late,
  never early). 2025: the reports of 30 Sep to 23 Dec count as released 29 Dec 2025 15:30 New York (CFTC resumed on
  19 Nov and cleared the backlog in chronological order by 29 Dec).
- The percentile at t uses only the rows released before t, within the 156 weekly rows before it.
- Tests: a replay at a Thursday reads the report of the Tuesday nine days earlier, never two days earlier; a holiday week
  shifts to Monday; a delayed week reads its listed day; no report inside an outage window is read before its end.

### 3.3 Facts (lens A)

All fact names below pass the platform's prohibited filter `/trad(e|ing)\b|order|wallet|withdraw|transfer|swap/`.

| Fact | Meaning |
|---|---|
| `positioning.net` | managed-money net (long − short), contracts |
| `positioning.net_change_1w` | its change on the week, contracts |
| `positioning.net_pctl_3y` | its percentile (0–1) among the 156 weekly nets before it: the crowding |
| `positioning.net_change_z` | the week's change in standard deviations of the 156 weekly changes |
| `positioning.oi_change_1w` | open interest change on the week, contracts and percent |
| `positioning.crowding` | `crowded_long` when `net_pctl_3y >= crowd_pctl`, `crowded_short` when `<= 1 − crowd_pctl`, else `neutral` |
| `positioning.divergence` | `none`, `price_up_net_down`, `price_down_net_up` (the feed's D1 close Tuesday to Tuesday against the net change; the price is read inside and never emitted), `oi_up_net_down` (fresh shorting) or `oi_down_net_up` (short covering) |
| `positioning.as_of`, `positioning.released_at`, `positioning.series`, `positioning.age_days` | provenance |

### 3.4 The Decision Engine witness `POSITIONING`

- **Lean**, deterministic, within [−0.6, 0.6] (the cap of `KEY_LEVELS`):
  - crowding, contrarian: above `crowd_pctl`, `c = −(pctl − crowd_pctl) / (1 − crowd_pctl)`; below `1 − crowd_pctl`,
    `c = ((1 − crowd_pctl) − pctl) / (1 − crowd_pctl)`; else 0;
  - flow, with the trend: `f = clamp(net_change_z / (2 × flow_z), −1, 1)` when `|net_change_z| >= flow_z`, else 0;
  - `lean = clamp(0.5 × f + 0.5 × c, −0.6, 0.6)`.
  - Divergence does not lean. It is in the card's summary for the council to weigh.
- **No hourly decay (Refinement).** `quorumOf` decays a card by 0.9 an hour from its `at`. A weekly report would weigh
  under a tenth after a day. The card carries `at: null`, and it is `stale` instead when the newest report known at t
  has an `as_of` more than 14 days old (a missed release).
- **Weight per mode, outside the witness tuner (Refinement).** The witness weights are one tuned set for every mode
  (`src/witness-tuning.mjs`, `activeWitnessTuning`), while the owner wants this weight per mode and controlled by
  Aether. So:
  - `POSITIONING` is not added to `WITNESS_KEYS` or `TUNED_WITNESSES`;
  - after the engine loads the set in force, it inserts `POSITIONING` at `positioning.de_weight_<mode>` and scales the
    other weights by `1 − w`, the rule of `addWitness`;
  - the witness tuner's replay keeps `POSITIONING` at its recorded weight in every arm, as it keeps `SESSION` fixed.
- **The council reads it** in `evidence.witnesses` like any witness, with one prompt sentence: what the report is, its
  release lag, that crowding leans contrarian and flow with the trend, and that it never outweighs the guardrails.

### 3.5 The other uses of lens A

- **War Room 4H and 1D:** one line of context on the bus (§2), the way the rooms read News Daily
  (`newsDeskEvidence`). Example: "Positioning (CFTC as of Tuesday, released Friday): managed money net long at the
  <p>th percentile of 3 years, not crowded; up <n> contracts on the week (+<z> SD); open interest up <x>%; no
  divergence." No price.
- **The mode choice** (`src/mode-selector.mjs`): `positioning.crowding` and `positioning.divergence` join the pack the
  mode council reads (`reviewModeSwitch`). They are a fact for the seats, never a trigger and never a fail-safe move.
- **The profile agent** (`src/profile-agent.mjs`, `src/profile-council.mjs`): the same two facts are recorded in the
  evidence of an upgrade review. They never trigger a downgrade or an upgrade alone.

## 4. Lens B: liquidity candles from the broker's M1 corpus

### 4.1 The archive

- **New table** D1 `broker_bars_1m`, written in the same bridge sync step as `corpus_bars` (`ingestCorpus`, the same
  validation: Omega's active broker, pair and user):
  - key `(account_ref, source, minute_ms)`;
  - `o`, `h`, `l`, `c`, `tick_volume`, `spread_points`, `digits`, `connection_version`, `received_ms`.
  - `account_ref` is the opaque `acct_<16 hex>` of `accountRef(executor)` (`src/account-spec.mjs`), which the sync
    already sets on `executor.account_ref` before the corpus step. **Never the account number.** A legacy reference
    (an EA without `login_hash`) is stored as it is and flagged `legacy_ref`.
  - `source` is `corpusSource(server, symbol)`, `mt5:<server>:<SYMBOL>`.
  - Rows are batched (20 a statement, as `archiveMinuteBars`) and pruned at 120 days once an hour, as `ledger_bars_1m`.
- `corpus_bars` is unchanged: its 14 days still feed the MT5 fallback and the corpus status.
- **Backfill.** The first run copies every `corpus_bars` row of the traded pair (`mt5:%`, never `mt5macro:%`) into the
  archive, under the account_ref of the connection that stored it. With `CORPUS_ORACLE_MODE = "shadow"` in production
  that is up to 14 days.
  - B2 (2026-11-22): the backfill reads the active connection version and every version already archived for the
    account_ref and source, and copies each group under its own version, 7 rows a statement (13 columns x 7 = 91 of
    D1's 100 bound parameters; 8 rows bound 104 and every batch rolled back). It runs once per identity (account_ref,
    source, versions: KV `liquidity:backfill:v2:<identity>`), so a new connection version backfills again. Rows it adds
    rebuild the baseline once and replay the sweeps of the minutes it added once (`liquidity:replay:v2:<identity>`,
    readings through `db.batch`), driven by the stored marker, so a step that fails after it still does both; the
    identity carries a short hash of the versions (the list is in the marker's value); a failure writes no finished
    marker, is retried at the next step and logs one `liquidity_backfill_failed` per identity. The backfill replay is
    expected to floor lens B on day one (production's backfilled history scores about 30 %): §7.2-§7.3 working as
    designed, the floor only lowers lens B's weight.
- **A deeper backfill needs the EA and the bridge (optional stage 2b).** The bridge sends only bars after the server's
  cursor (`readCorpus(..., { afterMs: corpusCursorMs })`), so older bars cannot ride in `corpus.json`. A later EA (1.23+) would
  write `omega/corpus_history.json` (pages of 1,440 bars before a `corpus_history_before_ms` the sync response names,
  from the terminal's own M1 history), and the bridge would send it as `corpus_history`. Without it the baseline reaches
  "sufficient" four weeks after the archive's first bar (§4.2).
- With the corpus off, or no connected account, lens B has no bars: its facts are `unavailable` and nothing uses it.

### 4.2 Normalised per broker and account, never absolute

Tick volume is the broker's own count of quotes, and spread is the broker's own. A number from one broker means nothing
on another. So every lens B number is a percentile or a ratio against the same account's own history:

- **The baseline** is per `(account_ref, source)` and per **hour of the week in New York time**. **Refinement:** the
  market's clock is New York (`src/market-hours.mjs`: the daily break and the weekly close move with US daylight time),
  so a UTC hour would mix two different hours of the market twice a year.
- **Window:** the last 8 weeks (`LIQUIDITY_BASELINE_WEEKS`). For each hour of the week the baseline holds the quantiles
  (0, 0.01, …, 1) of the M1 tick volume, of the 15-minute tick-volume sums, and the median M1 spread. It is
  recomputed for the hour that just ended, once an hour, and kept in KV `liquidity:baseline:<account_ref>`. The bar
  facts are then lookups, with no D1 scan per sync.
- **Excluded from the baseline:** minutes in `isRolloverQuarantine` and minutes where `goldPausedAt` holds.
- **Reset on a change:** a new `account_ref`, a new server or symbol (a new `source`), or new `digits` start a new
  baseline. The reset is an event (`liquidity_baseline_reset`).
- **Insufficient baseline.** The baseline is `sufficient` once each hour of the week holds at least 4 weeks with 45 or
  more bars. Until then:
  - the facts use a rolling baseline over the bars available: the same New York hour of day across the available days,
    else every bar of the last 24 hours;
  - every fact, line and report says `baseline: "insufficient"` with `baseline_weeks`, and the War Room line names it;
  - **Refinement:** while the baseline is insufficient, the weight in force may not rise above its anchor (§7), so a
    raise by Aether waits for a sufficient baseline. A drop to the floor still applies.
- **The spread of a bar.** On many servers an M1 bar's `spread` is the lowest spread seen in the minute, so bar spreads
  understate a spike. The entry filter and the modify deferral (§5, §6) therefore compare the executor's live
  `spread_points` (state.json, `sym.spread_points`) with the hour's median bar spread. The bar spreads still build the
  norm and the per-bar fact.

### 4.3 Facts (lens B)

Computed for the active account in the 5-minute ledger step (`LEDGER_CRON`) for the 15m and 1H uses and stored as one
row per run in D1 `liquidity_readings`. The levels stay in D1; the facts carry no price. The live spread fact is computed
in the bridge sync from the KV baseline.

| Fact | Meaning |
|---|---|
| `liquidity.vol_pctl` | the last closed M1 bar's tick-volume percentile in its hour of the week; `vol_pctl_15m` for the last 15m sum |
| `liquidity.vol_spike` | `vol_pctl >= spike_pctl` |
| `liquidity.thin` | `vol_pctl_15m <= thin_pctl` |
| `liquidity.spread_ratio` | the live spread / the hour's median spread; `spread_spike` when `>= spread_widen` |
| `liquidity.sweep` | `{ side: "buy_side" \| "sell_side", age_min, vol_pctl, reclaimed: true }`: a wick beyond the prior swing high (buy side) or low (sell side) within `sweep_lookback_min`, on a bar with `vol_pctl >= spike_pctl`, that closed back inside. Swings are M5 fractals (two bars each side) aggregated from the M1 bars |
| `liquidity.pools` | equal highs and equal lows not yet taken: two or more swing highs (lows) within `pool_tol_atr` × ATR(14, 15m); counts above and below price |
| `liquidity.hvn` | high-volume nodes of the tick-volume profile over `profile_window_min`: bins of 0.1 × ATR(14, 15m), a node where a bin's tick volume is at or above `hvn_pctl` of the bins; whether price is inside one, and how many are above and below |
| `liquidity.baseline`, `baseline_weeks`, `baseline_reset_at` | the baseline's state (§4.2) |

**Excluded from the events** (sweep, spike, pools; the facts say `excluded: <why>`):
- minutes in `isRolloverQuarantine` (`src/omega-engine.mjs`, 21:55–22:15 UTC);
- minutes where `goldPausedAt` holds;
- the first 5 minutes (`SESSION_OPEN_EXCLUDE_MIN`) after the weekly reopen, the daily reopen, and the Tokyo, London and
  New York opens (`SESSIONS`, New York hours 19, 3 and 8).
- Note: the rollover quarantine is fixed in UTC while the daily break moves with US daylight time. Both are excluded.

### 4.4 Key levels

- Sweep extremes, pool edges and high-volume nodes join `brokerKeyLevels` (`src/omega-engine.mjs`). They are already on
  the broker's scale, so no basis is added to them. Each zone carries `source: "key_level"` or `source: "liquidity"`
  and, for liquidity, `kind: "sweep" | "pool" | "hvn"`.
- The signal carries them in a new flat field, `liquidity_levels` (`low:high:kind` joined by `,`, broker scale). The EA
  ignores unknown fields, as it does `key_levels`.
- Every reader of `brokerKeyLevels` sees both: the Position Manager's TP2 and A8 reasons, the limit council's moves, and
  `manageIntents`.
- **On the feed's scale** (the ledger's replays; anything that reads OANDA prices): `feed = broker − feed_basis`
  (`feedBasis`, `src/feed-basis.mjs` since B8, re-exported by `src/ea-signal.mjs`). Without a known basis (`feed_basis_known` false) liquidity levels are left out on
  the feed's scale.
- **No price leaves the Worker.** The rooms get counts and words, never these levels. Aether and the kernel get
  nothing of them.
- At the floor weight (§7) liquidity levels are left out of `brokerKeyLevels`.

## 5. Lens B in the strategy: a filter and a confirmation, never an entry

1. **No entry during a spread spike.** A new gate in `planIntents`, `liquidity_spread_spike`, right after `spread`:
   no new entry while `spread_ratio >= spread_widen` (the live spread against the hour's norm). The absolute gate
   `spread` (`max_spread_points`) stays as it is. Open positions keep their management, as for every entry gate. The
   gate also holds the placement of a limit (stage 3 of the limit entries).
2. **A sweep reversal confirms a pullback.** The Decision Engine council's evidence gets, per strategy on each side,
   `liquidity: "sweep_with" | "sweep_against" | null` with the lens weight. `sweep_with` is a reclaimed sell-side sweep
   for a long, or a buy-side one for a short, within the last 15m bar. It never creates a plan: the strategy agent's
   own setup must already be on the chart.
   - **Refinement:** the confirmation does not go into the strategy agents' confidence (`agentConfidence`). That
     confidence is a measured input of the Position Manager (`confidence_drop`) and of the limit council, so a
     liquidity term there would turn into exit reasons that nobody chose.
   - **The LIQUIDITY card (Track B, B15, 2026-11-23; as built in §15).** Beside the per-side evidence, the council reads
     one council-only card, `LIQUIDITY` (`counts: false`). It is outside the quorum: `quorumOf` counts every card it
     gets and `decision.witnesses` is the cards, so the card joins neither, and it has no witness-weighting or
     witness-tuning key (no canon change). Its weight is min(0.06, 0.1 × `liquidity.council_weight_<mode>`); its lean
     is ±0.6 only from a reclaimed sweep at most 15 minutes old when another counting witness leans the same way, else
     0. None while lens B is off, floored or stale. `decision.liquidity.quorum_with_liquidity` records what the quorum
     would read with it, for the page only.
3. **The entry council's maker or taker choice** (`src/limit-council.mjs`, `ENTRY_REASONS`), three new measured reasons,
   checked by the code against the facts like the others:
   - `liquidity_thin` → `place_limit` (thin liquidity: rest as a maker);
   - `liquidity_sweep_with` → `enter_market` (the reversal is happening now);
   - `liquidity_sweep_against` → `skip`.
4. All three count only while `liquidity.council_weight_<mode>` is above its floor. At the floor the gate is off and the
   reasons do not hold.

## 6. Lens B in the Position Manager: measured reasons, by council only

The Position Manager's use stays council-only with measured reasons (`src/position-manager.mjs`). Nothing loosens, cuts
or moves mechanically because of liquidity.

- **`liquidity_sweep_against`** (a reclaimed sweep on a volume spike in the last 15 minutes, on the side that argues
  against the position: a buy-side sweep for a long, a sell-side one for a short):
  - joins the cut reasons of the loss band (`ruleAction`, beside `the decision is …`, `confidence dropped` and the
    quorum's share). The cut still needs the council's thesis `weakening` or `broken`;
  - joins `TP_NEARER_REASONS` (ADR-0020 Amendment 8, `docs/RFC_PM_A8.md` §4).
- **`liquidity_pool_outside`** joins `LOOSEN_REASONS` (A8 bounded loosening): an untaken pool or a sweep extreme on the
  position's stop side lies between the current stop and its A8 bound. The stop clears it by two spreads, within
  `back_share` and every check of `a8Intent`. **Refinement:** it is its own reason, not `key_level_outside` over a level
  tagged `liquidity`, so lens B's skill can be scored and muted apart from the Key Level Agent's.
  - **To confirm with the platform session:** if Amendment 8's text names its reasons, a new reason is an amendment.
- **No modify during a spread spike.** While `spread_spike` holds, Omega defers a `modify_sl`, `modify_tp` or
  `modify_sltp` of the ladder, the Position Manager or A8 for up to 10 minutes (`LIQUIDITY_MODIFY_DEFER_MAX_MS`), then
  sends it. A stop placed near price during a spike is the one most likely to be refused or hit by the spread.
  - Not deferred: closes, kill, pause, the fill guard (`fill_guard_<name>`), a loss past the daily budget, a Decision
    Engine veto, and any stop a hard guard requires.
  - **To confirm with the platform session:** a deferral delays a lock (a risk-reducing move) by at most 10 minutes. It
    never widens a stop.
- Telegram lines of these actions carry the reason name; they go to the owner's private chat only
  (`sendOmegaTelegram`), as every Position Manager line.

## 7. Weight, score and rollback, per lens

### 7.1 The weight in force

- Each lens has a per-mode weight (§8, `positioning.de_weight_<mode>`, `liquidity.council_weight_<mode>`) that is a
  `DOCTRINE_BOUNDS` fact on the platform.
- **Aether moves it within the bound.** The value comes back hourly from Aether's pack, the way `pullOmegaPolicy`
  brings the `omega.*` values (`src/omega-policy.mjs`), into KV `lens:policy:v1`. xauusd clamps every value to its bound.
  - Proposed: a new `KnowledgeIngress.lensPolicy()` method, so `applyOmegaPolicy`'s contract does not change. The
    platform and Aether sessions decide the method.
- **It starts at Aether's anchor, not at the top of the bound.** Until Aether's pack carries the fact, xauusd uses the
  proposed anchor (the start column of §8) as the start value.
- **What the weight does:**
  - lens A: the share of the witness quorum (§3.4);
  - lens B: shown to the councils beside the facts ("weigh this evidence at <w>"); above the floor, the gate of §5,
    the deferral of §6, the measured reasons of §5 and §6 and the liquidity key levels are on; at the floor (0) they
    are off and only the War Room line stays.

### 7.2 Separate outcome scores, per lens

Each lens is judged on its own readings, so its weight follows its own skill. A reading is scored `hit`, `miss` or
`neutral` (the latter do not count). The score is `hits / (hits + misses)` over the last `score_window` readings.

- **Lens A** reads at each 4H close where `POSITIONING` counted with `|lean| >= 0.15` (`LEAN`). The lean's side is scored
  with `scoreStance` (`src/outcome-scoring.mjs`) on the feed's 4H bars with a horizon of 6 bars (one day) and the
  standard 0.5 × ATR threshold.
  - Day one: the 4H readings of the last year are replayed from the backfill, point in time (§3.2), so the score is
    real from the start.
- **Lens B** has three kinds of reading:
  - **sweeps:** every detected sweep, not excluded. Hit: price moves at least 0.5 × ATR(14, 15m) in the reversal's
    direction before it trades beyond the sweep's extreme, within eight 15m bars. Miss: beyond the extreme first;
  - **spread-spike blocks:** the blocked signal's result in the v4 replay (`replayOmega4`), which runs without the lens.
    A loss avoided is a hit, a winner missed is a miss. The v4 parity check treats a `liquidity_spread_spike` note as an
    expected difference, as it treats limit fills;
  - **maker preferences:** each `liquidity_thin` answer, from the limit ledger's maker and taker pair
    (`src/ledger-omega-limit.mjs`). Maker better is a hit.
  - The Position Manager's liquidity reasons are scored through their sweep, the event they cite.
  - Day one: the sweep readings of the archive's bars are replayed at once. The other two kinds start with live use.
- Stored in D1 `lens_readings` (`lens`, `kind`, `at_ms`, `mode`, `outcome`; no price).

### 7.3 Automatic rollback

- After each scoring run (the ledger step), when a lens's score over its last `score_window` readings is below
  `score_floor`, the lens's weight drops to the floor of its bound in every mode, at once:
  - an event row (`lens_weight_floor`: the lens, the score, n, the floor, the modes, the weights before; no price);
  - one Telegram line to the owner's private chat (`TELEGRAM_CHAT_ID`, through `sendOmegaTelegram`). Example:
    "Positioning lens: weight to its floor in every mode. Hit share <s>% over the last <n> readings, floor <f>%.
    Aether can raise it again."
- **Aether can raise it again.** The floor holds until Aether's pack brings a value for that lens under a newer doctrine
  version (`doctrine_sha`) than the one in force at the rollback. An old value read again does not lift it. That keeps
  the floor from flapping, and the raise goes through the doctrine protocol (§12, point 1).
- A rollback never changes a hard guard and never closes a position.

## 8. Knobs: names, units, starts and bounds (proposed to the platform)

Every threshold is a knob with a `DOCTRINE_BOUNDS` fact per mode. Aether moves it within its bound; xauusd clamps
and, without a value, uses the start. The start of a weight is the anchor proposed to Aether. No name matches
`/trad(e|ing)\b|order|wallet|withdraw|transfer|swap/` (a test pins it, as A8-3 does).

| Fact | Unit, exactly | scalp | intraday | swing | range | Bound (min–max) |
|---|---|---|---|---|---|---|
| `positioning.de_weight_<mode>` | share (0–1) of the Decision Engine's witness weight; the others scale by 1 − w | 0.02 | 0.03 | 0.05 | 0.03 | scalp 0.02–0.04, intraday 0.02–0.06, swing 0.02–0.10, range 0.02–0.05 |
| `positioning.crowd_pctl_<mode>` | percentile (0–1) of the managed-money net among the 156 weekly nets before it; the low side is 1 − value | 0.90 | 0.90 | 0.90 | 0.90 | 0.80–0.95 |
| `positioning.flow_z_<mode>` | standard deviations of the week's net change against the 156 weekly changes | 1.0 | 1.0 | 1.0 | 1.0 | 0.5–2.0 |
| `liquidity.council_weight_<mode>` | weight (0–1) of lens B in the councils, the filter and the reasons; 0 is muted | 0.4 | 0.3 | 0.2 | 0.3 | scalp 0–0.8, intraday 0–0.6, swing 0–0.4, range 0–0.6 |
| `liquidity.spike_pctl_<mode>` | percentile (0–1) of the M1 tick volume in its New York hour of the week, 8 weeks | 0.95 | 0.95 | 0.97 | 0.95 | 0.90–0.99 |
| `liquidity.thin_pctl_<mode>` | percentile (0–1) of the 15m tick-volume sum in its hour of the week, at or below which liquidity is thin | 0.20 | 0.20 | 0.20 | 0.20 | 0.05–0.30 |
| `liquidity.spread_widen_<mode>` | ratio, the live spread / the hour of the week's median M1 spread | 1.8 | 2.0 | 2.5 | 2.0 | 1.5–4.0 |
| `liquidity.sweep_lookback_min_<mode>` | minutes of broker M1 bars searched for the prior swing high or low | 60 | 180 | 720 | 180 | scalp 30–120, intraday 60–360, swing 240–1440, range 60–360 |
| `liquidity.pool_tol_atr_<mode>` | multiple of ATR(14) of the closed 15m bars, broker scale, between swing extremes that count as equal | 0.05 | 0.05 | 0.08 | 0.05 | 0.02–0.15 |
| `liquidity.hvn_pctl_<mode>` | percentile (0–1) of the profile's bins (0.1 × ATR(14, 15m) wide) at or above which a bin is a node | 0.85 | 0.85 | 0.85 | 0.85 | 0.80–0.95 |
| `liquidity.profile_window_min_<mode>` | minutes of broker M1 bars in the tick-volume profile | 240 | 1440 | 7200 | 1440 | scalp 120–480, intraday 480–2880, swing 2880–14400, range 480–2880 |
| `positioning.score_floor` | hit share (0–1) over the last `score_window` readings; below it the weight drops to the floor (all modes) | 0.45 | 0.45 | 0.45 | 0.45 | 0.40–0.50 |
| `positioning.score_window` | number of scored readings (4H) | 60 | 60 | 60 | 60 | 40–200 |
| `liquidity.score_floor` | as above, lens B | 0.45 | 0.45 | 0.45 | 0.45 | 0.40–0.50 |
| `liquidity.score_window` | number of scored readings (sweeps, blocks, maker choices) | 100 | 100 | 100 | 100 | 50–300 |

Why these starts:
- **Positioning** is weekly. It means little for a scalp and most for a swing, so it starts at the floor in scalp and
  highest in swing. Every bound sits well under the doctrine's 0.30 for one witness and under a timeframe room's 0.126.
- **Liquidity** matters most for a short stop, so scalp starts highest and swing lowest. Swing widens `spread_widen`
  and `pool_tol_atr` because its stops are far from the noise.
- `score_floor` and `score_window` are per lens, not per mode: modes switch, and one mode alone would rarely have enough
  readings. A rollback lowers the lens in every mode.

**Constants, not knobs** (statistics windows and safety bounds): `LIQUIDITY_BASELINE_WEEKS` 8 (sufficient at 4);
`SESSION_OPEN_EXCLUDE_MIN` 5; the archive 120 days; COT stale after 14 days; the lean cap 0.6; M5 fractals of two bars;
the sweep's scoring horizon of eight 15m bars at 0.5 ATR; `LIQUIDITY_MODIFY_DEFER_MAX_MS` 10 minutes.

**How thresholds learn.** The lens report (§10) carries, for each threshold, the score at its neighbour values from the
replay over the archive and the COT backfill. Aether's Knowledge Council amends the value within its bound through the
doctrine protocol; xauusd reads it back (§7.1). There is no automatic threshold change inside xauusd.

## 9. What does not change

- **The hard guards:** `tick_value_mismatch`, `volume_below_min`, the profile caps, the daily loss budget
  (`daily_loss_limit`, `daily_risk_budget`), `max_positions`, `spread`, `blackout`, `rollover_quarantine`, `paused`,
  `live_not_armed`, and the ADR-0020 A7 and A8 limits. A lens can add a block; it can never lift one.
- The Position Manager acts by council only, with measured reasons. A silent council still means no liquidity action.
- Liquidity never opens a position; positioning never opens one either.
- With both weights at their floors and lens B at 0, `planIntents`, `positionAction` and the councils' outputs are
  byte for byte today's (a hash test over the S12 and A8-2 fixtures, as the limit and A8 PRs did).
- No new model call. The councils' prompts grow by a few lines.
- No price, no level, no size reaches Aether, the kernel or a public or CTA channel.

## 10. Reports, health and the page

- **Report to Aether:** `cryptophys.lens-report.v1`, daily with the witness report (`pushWitnessTuningReport`'s path).
  - Per lens: the weight in force per mode and its source (`anchor`, `aether`, `floor_rollback`), the score (hits,
    misses, share, n) overall and per reading kind, the rollback events, lens B's baseline state, lens A's series and
    report age, and the threshold sensitivities (§8).
  - **No price keys.** A test walks the report and refuses any key matching
    `price|entry|stop|sl|tp|target|level|zone|bid|ask`. Contracts and percentiles are not prices.
- **Doctrine facts:** the `positioning.*` and `liquidity.*` knobs in force join the Nexus seat (`nexusFacts`),
  `src/doctrine-facts.mjs`. The Omega seat holds `omega.*` facts only (Aether's validator).
- **Health alerts** (`src/health-alerts.mjs`):
  - `cot_stale`: the newest report known is more than 14 days old, or the fetch failed three runs in a row;
  - `liquidity_archive_stale`: no broker bar for 30 minutes while the market is open and Omega is connected;
  - `lens_at_floor`: a lens is at its floor (info, one report).
- **Nexus:** the agent's card ("Positioning & Liquidity") with both lenses' weight per mode and its source, the score,
  and the baseline state. The Omega page shows `liquidity_spread_spike` in "why" (`OmegaWhy.tsx`), like the other gates.

## 11. Network

- `publicreporting.cftc.gov`, HTTPS GET only, from the AI Worker's sweep. Workers' egress needs no change.
- Cloud development sessions that run the live fetch need `publicreporting.cftc.gov` on their environment's allowed
  hosts. The test suite uses fixtures and needs no host.
- No new host for lens B: its data arrives through the bridge's existing sync.

## 12. Objections and refinements (the owner asked for them)

Decisions of 2026-11-20 (top of this RFC): point 1 is settled by the owner's breakglass act; point 9 is superseded
(pools are key levels; A8's `key_level_outside` covers them); point 11 holds in the one PR (each lens ships with its
floor).

1. **Doctrine `promotion_by_owner`.** The canon says no parameter is promoted automatically: candidates run in shadow,
   and the owner approves a promotion PR. Going live with no shadow is the owner's own decision, and each stage PR the
   owner merges is the promotion. For Aether's later moves to fit the canon, the lens weights and thresholds must be
   **operational doctrine facts inside hard bounds**, moved only by amendments Cerebrum executed (`doctrine_protocol`).
   That is the one path the canon already allows without an operator. A drop to the floor is risk-reducing, like the
   strategy agents' breaker.
2. **Double counting in the rooms** (§2): the agent is context in the rooms, outside their quorum.
3. **No hourly decay for a weekly witness** (§3.4).
4. **A per-mode weight outside the witness tuner** (§3.4).
5. **The release lag is handled by `released_ms`, not by the report's date** (§3.2), with holiday and outage weeks.
6. **One more year of COT backfill** (§3.1), so the day-one score has full windows.
7. **New York hours for the baseline** (§4.2); **the live spread, not the bar's**, for the filter (§4.2).
8. **No liquidity term in the agents' confidence** (§5): it would leak into the exit reasons.
9. **A separate A8 reason** for liquidity (§6), so its skill and its mute are its own.
10. **No raise above the anchor while the baseline is insufficient** (§4.2).
11. **The rollback ships with each lens, not in the last PR** (§13): no live use without its own automatic floor.
12. **A deeper archive needs a later EA (1.23+) and the bridge** (§4.1). Without them the baseline is insufficient for its first
    weeks and says so.

## 13. Delivery: live from each PR, in stages (each reviewed by the orchestrator, then the owner)

1. **Lens A, live.**
   - The CFTC fetch (both series, fallback), the backfill (3 + 1 years), D1 `cot_reports`, point in time (§3.2).
   - The facts; the `POSITIONING` witness at the start weight per mode, outside the tuner (§3.4).
   - The War Room 4H and 1D line (out of the quorum); the facts for the mode council and the profile review.
   - Lens A's score (with the day-one replay) and its **automatic rollback** with the event and the Telegram line, at
     the start values of §8 (no Aether reader yet).
   - `cot_stale`; the doctrine facts `positioning.*`; tests: point in time, fact names, no price keys, the witness set
     still sums to 1.
2. **Lens B facts and key levels, live.**
   - D1 `broker_bars_1m` with `account_ref`, the 120-day prune, the backfill from `corpus_bars`.
   - The baseline per account and New York hour of the week, the reset, `insufficient` (§4.2).
   - The facts and `liquidity_readings`; the exclusions; liquidity levels in `brokerKeyLevels` and the signal's
     `liquidity_levels`, with `feedBasis` for the feed's scale.
   - The War Room 15m and 1H line (out of the quorum).
   - Lens B's sweep score (with the day-one replay) and its **automatic rollback**; `liquidity_archive_stale`.
   - 2b, optional and independent: a later EA (1.23+) and the bridge's `corpus_history` for a deeper archive. The owner installs
     the EA.
3. **Lens B in the strategy and the Position Manager, live.**
   - The `liquidity_spread_spike` gate; the council's per-strategy `liquidity` evidence; the entry council's three
     reasons (§5).
   - `liquidity_sweep_against` and `liquidity_pool_outside` (§6), after the platform session confirms A8 and the
     deferral; the modify deferral.
   - The block and maker readings in the score; the v4 parity exception; the hash test at the floor (§9).
4. **The Aether loop.**
   - `lensPolicy` (or the pack the platform chooses) into `lens:policy:v1`, clamped; the anchors with Aether; the raise
     after a rollback only under a newer doctrine version (§7.3).
   - `cryptophys.lens-report.v1` with the threshold sensitivities; `lens_at_floor`; the Nexus card.
   - The `DOCTRINE_BOUNDS` request for §8 goes to the platform session at the start of stage 1, so the bounds are in the
     kernel by stage 4.

## 14. Open points

Decisions of 2026-11-20: the deferral (§6) is approved; the A8 reason question is closed (pools are key levels); the
staged delivery of §13 is replaced by one PR, live on merge. Still open:
- **The 2025 shutdown weeks' exact days.** `COT_PUBLICATION_OUTAGES` holds the reports of 30 Sep to 23 Dec 2025 to 29
  Dec 2025 (orchestrator review of #505, the conservative choice); the per-week catch-up days from CFTC's schedule
  (cftc.gov was out of this build's reach) go into `COT_DELAYED_RELEASES`, which wins over the window.
- **A refused lens report raises no alert yet** (orchestrator note on #505). `LENS_REPORT_FORBIDDEN` matches substrings,
  so a new key such as `slippage` is refused (safe) and the report would go dark. It joins the health alert of the
  Aether push with Aether's `ingestLensReport()`, before the report is first sent.
- **Aether's methods.** `KnowledgeIngress.lensPolicy()` and `ingestLensReport()` are read when Aether offers them; until
  then the lens facts are read from the `omegaPolicy()` pack and the report is not sent.

- **COT outages.** A government shutdown has stopped the report before. `cot_stale` turns the witness stale and it drops
  out of the quorum. The outage weeks join `COT_DELAYED_RELEASES` so the backfill stays point in time.
- **Legacy as a proxy.** Non-commercial is wider than managed money. The fallback keeps its own percentile and says so;
  it should run rarely.
- **Tick volume can change at a broker** without a symbol change (a new price feed). A shift of the median tick volume
  per hour of more than 3× over a week could reset the baseline; this RFC does not propose it yet.
- **D1 size:** about 1,400 rows a day per account and source, about 170,000 at 120 days.
- **The idle sweep and the Friday release:** the release falls before the weekly close, so the regular sweep normally
  reads it. The idle heartbeat covers a late release (§3.1).

## 15. As built (2026-11-20)

**Modules.** `src/positioning-lens.mjs` (lens A), `src/liquidity-lens.mjs` (lens B), `src/lens-policy.mjs` (knobs,
switches, score, floor, report), `src/lens-steps.mjs` (the scheduled work, the sync's spike clock, health, the page).
Wired into `src/decision-engine.mjs`, `src/witness-tuning.mjs`, `src/omega-engine.mjs`, `src/omega-broker.mjs`,
`src/ea-signal.mjs`, `src/position-manager.mjs`, `src/limit-council.mjs`, `src/corpus-oracle.mjs`,
`src/omega-policy.mjs`, `src/doctrine-facts.mjs`, `src/health-alerts.mjs`, `src/war-room.mjs`,
`src/timeframe-threads.mjs`, `src/mode-selector.mjs`, `src/profile-council.mjs`, `src/ledger-omega4.mjs`, `src/index.ts`.

**Switches.** Omega settings `positioning_enabled` and `liquidity_enabled`, default `true` (`OMEGA_DEFAULTS`), owner only
on the Omega page (Setup → Engine); Aether's policy never writes them. Off: lens A adds no witness, no room line, no
pack fact; lens B adds no gate, deferral, level, council reason or room line. Data collection (the CFTC rows, the
archive, the baseline) keeps running so a switch back on has its history.

**Knobs as built** (`LENS_KNOBS`, `LENS_SCORE_KNOBS`; start = anchor, clamped to the bound; equal to §8):

| Fact | scalp | intraday | swing | range | Bound |
|---|---|---|---|---|---|
| `positioning.de_weight_<mode>` | 0.02 | 0.03 | 0.05 | 0.03 | 0.02–0.04 / 0.02–0.06 / 0.02–0.10 / 0.02–0.05 |
| `positioning.crowd_pctl_<mode>` | 0.90 | 0.90 | 0.90 | 0.90 | 0.80–0.95 |
| `positioning.flow_z_<mode>` | 1.0 | 1.0 | 1.0 | 1.0 | 0.5–2.0 |
| `liquidity.council_weight_<mode>` | 0.4 | 0.3 | 0.2 | 0.3 | 0–0.8 / 0–0.6 / 0–0.4 / 0–0.6 |
| `liquidity.spike_pctl_<mode>` | 0.95 | 0.95 | 0.97 | 0.95 | 0.90–0.99 |
| `liquidity.thin_pctl_<mode>` | 0.20 | 0.20 | 0.20 | 0.20 | 0.05–0.30 |
| `liquidity.spread_widen_<mode>` | 1.8 | 2.0 | 2.5 | 2.0 | 1.5–4.0 |
| `liquidity.sweep_lookback_min_<mode>` | 60 | 180 | 720 | 180 | 30–120 / 60–360 / 240–1440 / 60–360 |
| `liquidity.pool_tol_atr_<mode>` | 0.05 | 0.05 | 0.08 | 0.05 | 0.02–0.15 |
| `liquidity.hvn_pctl_<mode>` | 0.85 | 0.85 | 0.85 | 0.85 | 0.80–0.95 |
| `liquidity.profile_window_min_<mode>` | 240 | 1440 | 7200 | 1440 | 120–480 / 480–2880 / 2880–14400 / 480–2880 |
| `positioning.score_floor`, `liquidity.score_floor` | 0.45 | | | | 0.40–0.50 |
| `positioning.score_window` / `liquidity.score_window` | 60 / 100 | | | | 40–200 / 50–300 |

**Aether's values.** The hourly Aether pull (`pullOmegaPolicy`, the existing pack path) also reads the lens facts:
`AETHER.lensPolicy()` when Aether offers it, else the `positioning.*` / `liquidity.*` keys of the `omegaPolicy()` pack's
`values`. Each is clamped to its bound into KV `lens:policy:v1` with the pack's `doctrine_sha` (`storeLensPolicy`).
Readers call `lensKnobs(lens, mode, { policy, floor, enabled, baseline })`: Aether's value, else the anchor; lens B
held at its anchor while its baseline is insufficient; the floor after a rollback; 0 with the switch off.

**Lens A.** `runCotStep` in the sweep beside `refreshCalendar` and in the closed-market heartbeat: the backfill once
(`$limit=260`, both series, KV `cot:backfill:v1`), then only while a report is due (the scheduled release of the week
after the newest row passed), at most once an hour (KV `cot:fetch:last`), 30 requests a week, 10 s timeout,
`user-agent: cryptophys-nexus/1.0`. D1 `cot_reports` (lazy), 5 years. `cotAt(rows, t)` and `positioningFactsAt` read
only rows with `released_ms <= t`; the percentile and z stay inside one series. The Decision Engine inserts
`POSITIONING` after the set in force (`withPositioning`: weight w, the others × (1 − w)); `at: null` (no decay); stale
after 14 days. The witness tuner's replay keeps it at its recorded weight in every arm (`replayDecision`). The council
gets one prompt sentence. The 4H and 1D rooms' brief carries the line (`context`, not on the roster: outside the
quorum and the crowd). The mode council's pack and a profile upgrade's evidence carry `positioning` (crowding,
divergence). Readings at each 4H close the feed's series holds (the first run replays them all point in time), scored
with `scoreStance` on 6 bars.

**Lens B.** D1 `broker_bars_1m` written in `ingestCorpus` under `executor.account_ref` (`acct_<16 hex>` only),
pruned at 120 days, backfilled from `corpus_bars` once per identity: the active connection version and every version already archived for the account_ref and source, each under its own version (B2, see §4.1). The 5-minute ledger step
(`runLiquidityStep`, before the Position Manager): the baseline per NY hour of the week over 8 weeks (KV
`liquidity:baseline:<account_ref>`, rebuilt on a new identity `account|source|digits` with a `liquidity_baseline_reset`
event, else the hours that ended recomputed), the facts of the last closed bar for the mode in force, one
`liquidity_readings` row (30 days), the shared state (KV `liquidity:state:v1`: facts, levels, the medians per hour of
the week). `eaSignal` carries `liquidity_on`, `liquidity_weight`, `liquidity_levels` (`low:high:kind`, broker scale),
`liquidity_spread_median` (this hour of the week), `liquidity_spread_widen`, `liquidity_sweep`,
`liquidity_sweep_age_min`, `liquidity_thin`; `liquidity_on` is false with the switch off, at the floor or on a state
older than 15 minutes. `brokerKeyLevels` appends the levels with `source: "liquidity"` and `kind`. `planIntents`: the gate
`liquidity_spread_spike` right after `spread` (Omega's live `spread_points` / the hour's median ≥ `spread_widen`);
`deferModifications` holds `modify_sl` / `modify_tp` / `modify_sltp` up to 10 minutes from the spike's start (KV
`liquidity:spike:v1`, note `liquidity_modify_deferred`); closes, `close_all`, deletes, partial closes and an intent marked
`hard` are never held. The entry request carries `liquidity` (weight, thin, sweep with/against); `ENTRY_REASONS` gains
`liquidity_thin` → place_limit, `liquidity_sweep_with` → enter_market, `liquidity_sweep_against` → skip, each held only
when the request carries it. The Position Manager reads the signal: `liquidity_sweep_against` joins the loss band's cut
reasons (the council's thesis still decides) and `TP_NEARER_REASONS`. The 15m and 1H rooms' brief carries the line; since B16 its risk desk and moderator also read lens B's conditions (below).

**Scores and floor.** D1 `lens_readings` (`lens`, `kind`, `at_ms`, `mode`, `side`, `outcome`, no price). Kinds: `h4`
(lens A), `sweep`, `block` (scored from `ledger_omega4.r_omega4`: a v4 loss is a hit), `maker` (a `liquidity_thin`
answer, scored from `r_limit` against `r_omega4`). After each ledger step `lensFloorStep`: below `score_floor` over the
last `score_window` decisive readings (at least 20) the lens is floored in every mode (KV `lens:floor:v1`), with
`omega_events` `lens_weight_floor` and one line through `sendOmegaTelegram`. It lifts only when Aether's policy brings a
weight for the lens under another `doctrine_sha`, pulled after the floor.

**Report, health, page.** `cryptophys.lens-report.v1` daily through `AETHER.ingestLensReport` when offered
(`pushLensReport`); `forbiddenReportKeys` refuses any key matching `price|entry|stop|sl|tp|target|level|zone|bid|ask`.
Doctrine facts: `positioning.*` and `liquidity.*` in the Nexus seat, each with `<lens>.enabled` (Aether keeps the Omega seat to `omega.*`: #505 first put `liquidity.*` there and every facts report was refused until the fix). Health:
`cot_stale`, `liquidity_archive_stale`, `lens_at_floor` (`report_once`). `GET /api/lens`; Nexus: the "Positioning &
Liquidity" panel on the Strategy page (weight per mode and source, score, floor, baseline, COT freshness, switches), the
two switches on the Omega page, and `liquidity_spread_spike` / `liquidity_modify_deferred` in "why".
**The Nexus liquidity view** (Track B, B8, 2026-11-23): `GET /api/liquidity` (`src/liquidity-view.mjs`,
`cryptophys.liquidity-view.v1`; contract `test/fixtures/nexus-intel/liquidity.json`) for the Nexus Liquidity page
under Intelligence. Nexus only (Cloudflare Access), so it may carry lens B's levels, each on both scales (`low`/`high`
broker, `low_feed`/`high_feed` feed, null without a known basis), with the state, the backfill's status, the basis, the
feed's 15m ATR, the facts and line, 24 hours of readings, the newest 50 sweeps with their outcome and whether they count
in the score, the score, the effects (blocks, maker choices, the entry council's skips, deferrals, the Position
Manager's actions), the 168-hour baseline and today's management level set. SELECTs and KV reads only, never
`lensStatus`; nothing in it reaches a room, a decision card, the Position Council, Aether or a public page, and lens B
still never opens, sizes or prices an entry. Switch `INTEL_VIEWS` (`off`: 404 `intel_views_off`). See docs/SSOT.md.

**The LIQUIDITY card** (Track B, B15, 2026-11-23; §5.2): `liquidityCard` in `src/decision-engine.mjs`, built in
`assess` from lens B's state and knobs as the council's sweep evidence reads them (`liquidityEvidence`: on, above the
floor, a fresh and available state) and the counting cards. `LIQUIDITY_WITNESS` {share 0.1, cap 0.06, lean 0.6}: weight
min(0.06, 0.1 × lens B's council weight in force, the `lensKnobs` weight of the decision's mode); lean ±0.6 (a sell-side
sweep bullish, a buy-side one bearish) only from a reclaimed sweep whose age at the decision (the facts' `age_min` plus
the state's age) is at most 15 minutes, and only when another counting card leans the same way by at least 0.15; else
0 with its `lean_reason`. `withLiquidity` hands the council the cards unchanged plus the card (`counts: false`, one
prompt sentence); the quorum, the guardrails, the power, `pickStrategy`, `decision.witnesses` and the witness weights
never see it, and `src/witness-weighting.mjs` / `src/witness-tuning.mjs` hold no key for it (only the council's local
`weighed` list names it). The record keeps `decision.liquidity` {`card`, `quorum_with_liquidity`} (`liquidityQuorum`:
`quorumOf` with the card at its weight, and each side's quorum check at the mode's thresholds, informational), and
`GET /api/liquidity` shows both. No price in the card: weight, lean, the sweep's side, minutes and words. Switch
`LIQUIDITY_WITNESS` (`off`: no card, no `decision.liquidity`, the council's messages byte for byte as before). The
Decision Engine is outside `ENGINE_CODE`, so `ENGINE_CODE_HASH` and `ENGINE_BEHAVIOUR_HASH` do not move.

**Lens B's conditions in the rooms** (Track B, B16, 2026-11-23; §4.3): `liquidityConditions` in
`src/liquidity-lens.mjs` turns the facts into one plain-words line for the 15m and 1H rooms: the spread against its
norm for the New York hour of the week (with the mode's `spread_widen`), the depth (the last 15 minutes' tick-volume
percentile, with the mode's `thin_pctl`), the minute's tick volume, the session's liquidity at the facts' minute and where
price sits against lens B's levels (inside a high-volume node or not; nodes and untaken pools above, below and at
price, as counts). No sweep clause (the LIQUIDITY card's) and no price-shaped number (`PRICE_SHAPED`; a line that would
carry one is refused). `roomContextLine` adds it to lens B's brief line as `conditions` while lens B is on, above its
floor and fresh (`liquidityConditionsOn`: `liquidityEvidence`'s gates); the 15m War Room and the 1H room read it from
the stored brief into the Risk Manager's opening data (`liquidity_conditions`) and the moderator's prompt, with no model
call added; the 4H and D1 rooms never do. `GET /api/liquidity` fills `conditions` with the same output and `in_rooms`.
Switch `LENS_ROOM_LINE` (`conditions`; `brief`: the brief's line only, the prompts byte for byte as before). Outside
`ENGINE_CODE`: the hashes hold.

**Parity era.** `ERA_SWITCHES` gains `positioning_enabled` and `liquidity_enabled`. The signature compares each switch
with its default (`eraSwitches`), so at their defaults (on) they add nothing, and a lens switched off writes
`<name>=false` and starts a new era at the settings' `updated_ms`. The behaviour fingerprint gains a `liquidity` group
(the hand inputs with the lens on and the live spread at 3x and 1x the norm), so `ENGINE_BEHAVIOUR_HASH` moves and a new
era starts at the deploy. An old-shape era is now adopted as the first fingerprint's behaviour
(`ERA_ADOPTABLE_BEHAVIOUR_HASH`), never as a later one. v4: the stored decisions already hold `POSITIONING` as it was
computed live, point in time (`cotAt` at the close), so v4 replays the same witness; v4 has no live spread, so it
replays without lens B's gate and deferral, and `omegaParity` treats a v4-only trade whose signal the gate held live
(a `block` reading) as an expected difference, not counted.

## 16. Deviations from this RFC

1. **One PR, live on merge** (owner decision 1), instead of the four stages of §13.
2. **No `liquidity_pool_outside`** (owner decision 3): pools are key levels; A8's `key_level_outside` covers them.
3. **Floor minimum.** A lens is floored only with at least 20 decisive readings in its window (`LENS_SCORE_MIN_N`), so a
   handful of early readings cannot floor it. §7.3 sets no minimum.
4. **Floor lift.** "A newer doctrine version" is read as a weight for the lens under a `doctrine_sha` other than the one
   in force at the rollback, pulled after it (shas have no order).
5. **Batch size.** `broker_bars_1m` rows are written 7 a statement (13 columns, 91 parameters; D1 binds at most 100), not 20. The first version wrote 8 (104 parameters), so every backfill batch rolled back (B2, 2026-11-22).
6. **The 45-bar rule.** An hour whose exclusions (rollover quarantine, the daily reopen, a session open) leave fewer
   than 60 eligible minutes needs 75 % of its eligible minutes, not 45 bars, else it could never be sufficient.
7. **Lens A's day-one replay** covers the feed's 4H series (500 bars, about 83 days), not the last year: the AI Worker
   holds no longer 4H history. The CFTC backfill is the full 3 + 1 years.
8. **Rolling fallback.** While insufficient, a percentile is the mixture of the same NY hour of day's per-hour quantile
   functions weighted by their bars (else every hour with data), not a fresh scan of raw bars each run.
9. **Liquidity facts** are computed each 5-minute ledger step for the mode in force; the live spread ratio is computed
   by `planIntents` in the sync from the signal's hourly median and Omega's live `spread_points`.
10. **Report path.** `ingestLensReport` (new, optional), not `ingestWeightingReport`, whose schema it would fail.
11. **Threshold sensitivities** (§8 "How thresholds learn", §10) are not in the report yet: the report carries weights,
    sources, scores, floors, the baseline and the COT freshness.
12. **The Nexus agent card** is a panel on the Strategy page; the lens is not a room seat, so the agent inventory does
    not list it.
13. **Source tag.** Only liquidity zones carry `source: "liquidity"`; the Key Level Agent's zones keep their shape (no
    `source` key), so every reader and the fixtures stay byte for byte when lens B is off.

