# RM1a: is the room (squeeze) guardrail too strict?

Read-only study, 2026-11-25. Data: production D1 (SELECT only), decisions 2026-11-17 00:00 to 2026-11-25 05:30 UTC (595), 1m bars to 05:39 UTC. Repo code at main 738960c. Units: R, ATR(1H) multiples, counts and shares only.

## Short reading

1. **The first pass holds up.** Since 11-23 there are 93 WAITs where room was the only failing check on the quorum's side. Over the next 4h price moved +0.66 ATR their way on average (first pass: +0.69), and at least 1 ATR in 25 of 78 (first pass: 26 of 78). The council's own WAITs with every check passing: 48, at −0.07 ATR. The small gaps come from one extra decision and from how sides are picked when both pass the quorum check (I take the larger share).
2. **The move after a room block is the trend, not something room-specific.** Since 11-17, room-only WAITs were followed by +0.67 ATR over 4h. The decisions that traded were followed by +0.65 ATR. The period is one long SELL leg: 215 of the 238 room-only blocks are on the SELL side and with the TREND_TF trend.
3. **The guard does not sort good trades from bad ones.** Replayed with the quorum side's real plan (v4 market entry, the plan's stop and tp1, PM off, 72h), the room-only blocks earn mean +0.22R with a 74% win rate (172 replayed). The traded baseline earns +0.29R with 69% (164 replayed). The corridor width shows no clear pattern: <0.5 ATR +0.33R, 0.5–0.75 +0.18R, 0.75–1.0 +0.21R. The blocked plans have nearer targets (mean tp1 0.96R against 1.03R; the scalp target is the nearest level). That is why they win more often but earn less per win (+0.65R against +0.88R).
4. **Most of these WAITs would not have added a position.** 185 of the 238 room-only WAITs fall while the replay of an actual trade on the same side is still open (live, max_positions or same_side_unprotected would hold them). What is left is 53 decisions in 18 episodes (16 replayed): +0.65R mean, +10.4R total. That is the whole upside of switching the guard off over 8 days.
5. **The edge is from the first week.** 11-17 to 11-22: room-only blocks earn +0.27R (132 replayed). Since 11-23: +0.06R (40 replayed, 50% win), level with what traded since 11-23 (+0.07R).
6. **Breakout split.** By construction a decision's own corridor is measured around its own close, so the close is never beyond its own corridor's edge (0 of 238). Breakout is therefore measured against the corridors recorded at earlier decisions. Against the previous bar's corridor (b1) there are 21 breakouts: +0.22R, 69% win, against +0.22R for the 217 inside. Against any corridor of the last hour (b4) there are 92: +0.22R, 73%, against +0.23R for the 146 inside. A breakout close does not mark better trades. It does pick out with-trend moves (2 of 92 counter-trend), and among the releases that would add a new position it does best: 14 episodes, 12 replayed, +0.60R, 92% win.

## Recommendation

**Keep the guard as it is for now: no change to corridor_atr, and do not switch it off.** The data say the guard costs little in this period, not that it is wrong. Its blocks earn about what the trades earn, most of them overlap a position that is already open, and the extra over 8 days comes to about 18 episodes concentrated in a one-sided SELL week, shrinking to about 0 since 11-23. Lowering corridor_atr (c) is the weakest option. At 0.75 it releases 59 at +0.15R, the lowest mean of the variants. At 0.5 it releases 163 at +0.17R, and since 11-23 those earn +0.01R (19 replayed). The room-tuning protocol (bounds 0.5–1.5, step 0.25, 200 paired decisions) is the right place for that number, not a hand change.

**If one variant is to be tried, try (b) in its with-trend form (d6): waive room when the 15m close is beyond the edge, in the quorum's direction, of a corridor recorded in the last hour, and TREND_TF is with the trade.** It matches the owner's complaint exactly ("price has already moved that way"). It releases 90 (+0.23R, 74% win, 0 counter-trend) and, among new positions, 14 episodes at +0.60R. Run it record-only or in shadow first, through a non-SELL week, and promote it only if the shadow beats the traded baseline per episode. Variant (a), room counted only ahead of the trade, is not useful as worded. The room ahead is at most the corridor, so at the current 1.0 ATR it releases 0. At 0.5 it releases 30, at 0.25 it releases 142, and neither beats the baseline.

## Caveats

- The sample is small and clustered. The 238 blocks are about 18 independent episodes once open positions are taken out. One day (11-19) gives +22R of the room-only +38R.
- Regime concentration: 215 of 238 are SELL-side and with-trend. All 23 BUY-side blocks are counter-trend (+0.03R, 8 replayed). Nothing here says how the guard behaves in a range or an up-trend.
- The active room was 1.0 in every decision (room_atr is not recorded before about 11-19, where it defaults to 1). The "active room" split is trivial: every mode ran at 1.0.
- The council never asked for a trade while room failed, so "released" assumes the council would have followed the quorum side. Under the current decide() (two_sided veto rule, room passed), 181 of 238 would trade: 173 on the same plan as the rebuild, 8 on another. 57 stay held by the strategy_agents or strategy_arm veto. Results for that subset are in the tables and are close to the full set.
- Not replayed (room only, 66 of 238): 29 have no plan on the quorum side; 15 are cell_gate_unreconstructable (range agents' cell gate, not stored); 12 waiting_for_pullback and 1 price_past_entry (v4's market-entry gates); 4 range_mode_agent; 5 no_bars (22:00 UTC daily break, and a broker-bar gap on 11-17 at 14:15). Room plus: 8 of 9 not replayed, mostly fresh or market_open failing around the daily break.
- Bars: the feed's 1m bars from 11-17 23:04. Before that, the broker's demo bars are shifted by the median feed-minus-broker basis over 792 shared minutes (SV1a's method). Positions still open at the last bar (9 room-only, 7 traded) are marked at the data end, short of 72h.
- Each decision is replayed on its own fresh account, so live interactions are absent: one position, daily loss limit, cooldowns. The "not inside a traded position" and "first per episode" columns approximate them.

## Method

- **Class of each WAIT.** The quorum side is the side whose `quorum` check passed. When both passed, it is the larger share. A side's failing checks are read from `guardrails.<side>.checks`. room_only means room is the only failing check. room_plus means room and others fail. Then come other_guard, council_wait_all_pass and overruled_by.
- **Move.** The 1m close at bar_close+1h and +4h, minus the close at the bar, signed by the quorum's direction, over `strategy.atr_h1`. Windows not yet complete or ending in a gap are left out.
- **Trade rebuild (SV1a's method, both sides).** The strongest speaker on the quorum side (STRATEGY_AGENTS voices; the default agent wins a tie) with a plan in `strategy_plans`, else the default agent's plan. `tradeFor` gives tp1 under the mode's rule (scalp: nearest level; others: the mode's min_rrr). A cross-check runs `decide()` on guards rebuilt from the record with the room check passed (the council assumed to want the quorum side, confidence at least the minimum).
- **Replay.** `replayOmega4` (src/ledger-omega4.mjs, v4 market entry) on that single decision, keeping only planIntents' open intents. PM, PM-1M, re-entry and all management are off, so the exit is the broker's stop or tp1, or the mark at 72h or at the data end. R is realised over the risk at the open. The traded comparison replays the recorded `trade` the same way.
- **Corridor and room ahead.** `squeeze.corridor_atr` as recorded. Room ahead = distance from price to the facing edge of the recorded zone in the trade's direction, over ATR(1H). The same check with a value v passes when corridor_atr ≥ v (room-tuning's rule).
- **Breakout.** The decision's 15m close beyond the facing edge, in the quorum's direction, of the corridor recorded at the decision 1 bar before (b1), or at any of the 4 before (b4).
- **Counter-trend.** The TREND_TF witness's lean against the trade by at least LEAN (0.15).
- **Not inside a traded position.** The release's bar is outside every [fill, exit] span of the replayed traded decisions on the same side.
- **Episode.** A new episode starts when a release comes more than 60 minutes after the previous one.

## Scripts and data

- `scripts/rm1a-extract.mjs`: saved D1 results to `data/decisions.json` and `data/bars.json`. The D1 queries were SELECTs over engine_decisions (decision_json slimmed in the query to the fields the replay reads), ledger_bars_1m, and corpus_bars for the broker's demo GOLD series before the feed.
- `scripts/common.mjs`: bars, quorum side.
- `scripts/rm1a-replay.mjs`: classification, rebuild, decide() cross-check, v4 replay. Writes `out/rows.json`.
- `scripts/rm1a-tables.mjs`: every table below. Writes `out/tables.md`.
- Run: `RM1A_DATA=<data dir> node scripts/studies/rm1a/rm1a-replay.mjs && RM1A_DATA=<data dir> node scripts/studies/rm1a/rm1a-tables.mjs` (RM1A_REPO defaults to this checkout). The data JSON is not kept in the repository.

## Tables

### First pass reproduced (since 2026-11-23)

decisions 215: WAIT 156, BUY 22, SELL 37

| class (WAIT, quorum's side) | n | mean 1h move ATR | n with 4h | mean 4h move ATR | 4h ≥ +1 ATR | 4h ≤ −1 ATR |
|---|---|---|---|---|---|---|
| room the only failing check | 93 | 0.15 | 78 | 0.66 | 25 | 9 |
| council WAIT, all checks pass | 48 | -0.02 | 48 | -0.07 | 7 | 9 |
| overruled: strategy_agents | 12 | 0.03 | 10 | 0.74 | 4 | 0 |
| overruled: strategy_arm | 3 | 0.65 | 3 | 1.32 | 1 | 0 |
| traded (BUY/SELL), own side | 59 | 0.09 | 52 | 0.23 | 8 | 5 |

### Extended window (since 2026-11-17)

decisions 595: WAIT 389, SELL 184, BUY 22

| class (WAIT, quorum's side) | n | mean 1h move ATR | n with 4h | mean 4h move ATR | 4h ≥ +1 ATR | 4h ≤ −1 ATR |
|---|---|---|---|---|---|---|
| room the only failing check | 238 | 0.18 | 217 | 0.67 | 74 | 16 |
| room plus another check | 9 | -0.3 | 2 | 0.38 | 1 | 0 |
| another check, room passing | 16 | -0.2 | 12 | 0.59 | 4 | 2 |
| council WAIT, all checks pass | 67 | 0.11 | 67 | 0.26 | 18 | 11 |
| overruled: strategy_agents | 43 | 0.05 | 37 | 0.68 | 14 | 1 |
| overruled: strategy_arm | 16 | 0 | 16 | 0.56 | 3 | 0 |
| traded (BUY/SELL), own side | 206 | 0.23 | 196 | 0.65 | 65 | 21 |

### Replay of room-blocked WAITs (since 2026-11-17; v4 market entry, plan stop and tp1, PM off, 72h)

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| room only (main set) | 238 | 172 | 38.42 | 0.22 | 74% | 119 / 44 / 9 | 0.96 | 0.84 | 23 | 0.67 |
| room plus other checks | 9 | 1 | -1 | -1 | 0% | 0 / 1 / 0 | 0.51 | 0.72 | 0 | 0.38 |
| room only + room plus | 247 | 173 | 37.42 | 0.22 | 74% | 119 / 45 / 9 | 0.95 | 0.84 | 23 | 0.67 |
| comparison: traded BUY/SELL | 206 | 164 | 47.98 | 0.29 | 69% | 106 / 51 / 7 | 1.03 | 0.85 | 22 | 0.65 |
| comparison: traded SELL | 184 | 149 | 54.79 | 0.37 | 73% | 102 / 40 / 7 | 1.01 | 0.85 | 0 | 0.75 |
| comparison: traded BUY | 22 | 15 | -6.81 | -0.45 | 27% | 4 / 11 / 0 | 1.23 | 0.82 | 22 | -0.12 |
| room only, since 11-23 | 93 | 40 | 2.59 | 0.06 | 50% | 11 / 20 / 9 | 2.27 | 0.8 | 23 | 0.66 |
| traded, since 11-23 | 59 | 38 | 2.69 | 0.07 | 45% | 10 / 21 / 7 | 1.62 | 0.83 | 22 | 0.23 |
| room only, current decide() would trade (room lifted) | 181 | 150 | 31.78 | 0.21 | 74% | 102 / 39 / 9 | 1.01 | 0.84 | 17 | 0.61 |
| room only, decide() still holds (agents/arm veto) | 57 | 24 | 4.47 | 0.19 | 75% | 18 / 6 / 0 | 0.66 | 0.86 | 6 | 0.89 |

**Room only by corridor_atr bucket**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| <0.5 | 75 | 59 | 19.18 | 0.33 | 76% | 38 / 14 / 7 | 1.36 | 0.86 | 3 | 0.76 |
| 0.5–0.75 | 104 | 75 | 13.56 | 0.18 | 75% | 54 / 19 / 2 | 0.76 | 0.84 | 11 | 0.53 |
| 0.75–1.0 | 55 | 35 | 7.26 | 0.21 | 74% | 26 / 9 / 0 | 0.72 | 0.84 | 8 | 0.88 |
| 1.0–1.25 | 4 | 3 | -1.58 | -0.53 | 33% | 1 / 2 / 0 | 0.75 | 0.83 | 1 | 0.05 |
| all | 238 | 172 | 38.42 | 0.22 | 74% | 119 / 44 / 9 | 0.96 | 0.84 | 23 | 0.67 |

**Room only by trading mode × active room (room_atr)**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| intraday @ 1 | 12 | 9 | 0.68 | 0.08 | 56% | 0 / 4 / 5 | 3.18 | 0.81 | 0 | 0.85 |
| range @ 1 | 6 | 0 | 0 | – | – | 0 / 0 / 0 | – | – | 0 | -0.73 |
| scalp @ 1 | 106 | 60 | 10.2 | 0.17 | 65% | 35 / 21 / 4 | 1.32 | 0.83 | 23 | 0.88 |
| scalp @ 1 (not recorded: default) | 114 | 103 | 27.55 | 0.27 | 82% | 84 / 19 / 0 | 0.55 | 0.86 | 0 | 0.57 |
| all | 238 | 172 | 38.42 | 0.22 | 74% | 119 / 44 / 9 | 0.96 | 0.84 | 23 | 0.67 |

**Room only by 1H regime**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| high-ranging | 67 | 50 | 21.87 | 0.44 | 86% | 43 / 7 / 0 | 0.69 | 0.83 | 10 | 0.57 |
| high-trending | 33 | 29 | 5.43 | 0.19 | 76% | 22 / 7 / 0 | 0.61 | 0.85 | 0 | 0.63 |
| low-ranging | 34 | 18 | -3.32 | -0.18 | 56% | 10 / 8 / 0 | 1.19 | 0.84 | 0 | 0.77 |
| low-trending | 6 | 5 | -5 | -1 | 0% | 0 / 5 / 0 | 3.36 | 0.78 | 0 | 0.28 |
| normal-ranging | 77 | 51 | 8.58 | 0.17 | 71% | 36 / 15 / 0 | 0.81 | 0.87 | 11 | 0.82 |
| normal-trending | 21 | 19 | 10.87 | 0.57 | 89% | 8 / 2 / 9 | 1.72 | 0.83 | 2 | 0.31 |
| all | 238 | 172 | 38.42 | 0.22 | 74% | 119 / 44 / 9 | 0.96 | 0.84 | 23 | 0.67 |

**Room only by quorum side**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| BUY side | 23 | 8 | 0.24 | 0.03 | 50% | 4 / 4 / 0 | 1.13 | 0.79 | 23 | 0.86 |
| SELL side | 215 | 164 | 38.18 | 0.23 | 76% | 115 / 40 / 9 | 0.95 | 0.85 | 0 | 0.65 |
| all | 238 | 172 | 38.42 | 0.22 | 74% | 119 / 44 / 9 | 0.96 | 0.84 | 23 | 0.67 |

**Room only by breakout (close beyond the previous bar's corridor edge, quorum's direction)**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| breakout (b1) | 21 | 16 | 3.46 | 0.22 | 69% | 10 / 5 / 1 | 0.9 | 0.82 | 1 | 0.63 |
| inside | 217 | 156 | 34.96 | 0.22 | 75% | 109 / 39 / 8 | 0.96 | 0.85 | 22 | 0.68 |
| all | 238 | 172 | 38.42 | 0.22 | 74% | 119 / 44 / 9 | 0.96 | 0.84 | 23 | 0.67 |

**Room only by breakout within the last hour (close beyond any of the last 4 bars' corridor edge)**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| breakout (b4) | 92 | 77 | 16.82 | 0.22 | 73% | 52 / 21 / 4 | 1.01 | 0.84 | 2 | 0.67 |
| inside | 146 | 95 | 21.6 | 0.23 | 76% | 67 / 23 / 5 | 0.91 | 0.85 | 21 | 0.68 |
| all | 238 | 172 | 38.42 | 0.22 | 74% | 119 / 44 / 9 | 0.96 | 0.84 | 23 | 0.67 |

**Room only by room ahead (trade direction) in ATR(1H)**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| <0.25 | 96 | 79 | 19.93 | 0.25 | 68% | 48 / 25 / 6 | 1.27 | 0.85 | 10 | 0.62 |
| 0.25–0.5 | 112 | 71 | 13.92 | 0.2 | 80% | 54 / 14 / 3 | 0.71 | 0.83 | 10 | 0.67 |
| 0.5–0.75 | 29 | 21 | 5.57 | 0.27 | 81% | 17 / 4 / 0 | 0.6 | 0.89 | 3 | 0.9 |
| ≥0.75 | 1 | 1 | -1 | -1 | 0% | 0 / 1 / 0 | 1.03 | 0.86 | 0 | -0.93 |
| all | 238 | 172 | 38.42 | 0.22 | 74% | 119 / 44 / 9 | 0.96 | 0.84 | 23 | 0.67 |

**Room only by trend witness (TREND_TF) vs the trade**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| against | 23 | 8 | 0.24 | 0.03 | 50% | 4 / 4 / 0 | 1.13 | 0.79 | 23 | 0.86 |
| with | 215 | 164 | 38.18 | 0.23 | 76% | 115 / 40 / 9 | 0.95 | 0.85 | 0 | 0.65 |
| all | 238 | 172 | 38.42 | 0.22 | 74% | 119 / 44 / 9 | 0.96 | 0.84 | 23 | 0.67 |

**Room only by day**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-17 | 51 | 45 | 4.29 | 0.1 | 73% | 33 / 12 / 0 | 0.49 | 0.87 | 0 | 0.38 |
| 2026-11-18 | 23 | 21 | 7.43 | 0.35 | 81% | 17 / 4 / 0 | 0.69 | 0.84 | 0 | 0.84 |
| 2026-11-19 | 51 | 48 | 21.99 | 0.46 | 94% | 45 / 3 / 0 | 0.55 | 0.86 | 0 | 0.95 |
| 2026-11-20 | 20 | 18 | 2.12 | 0.12 | 72% | 13 / 5 / 0 | 0.59 | 0.86 | 0 | 0.52 |
| 2026-11-23 | 34 | 9 | 1.03 | 0.11 | 56% | 5 / 4 / 0 | 1.08 | 0.8 | 20 | 0.39 |
| 2026-11-24 | 46 | 20 | -4.07 | -0.2 | 30% | 5 / 14 / 1 | 2.54 | 0.8 | 3 | 0.87 |
| 2026-11-25 | 13 | 11 | 5.63 | 0.51 | 82% | 1 / 2 / 8 | 2.76 | 0.8 | 0 | 0.12 |
| all | 238 | 172 | 38.42 | 0.22 | 74% | 119 / 44 / 9 | 0.96 | 0.84 | 23 | 0.67 |

**Comparison (traded) by corridor_atr bucket**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.0–1.25 | 58 | 47 | 0.44 | 0.01 | 64% | 30 / 17 / 0 | 0.75 | 0.82 | 9 | 0.55 |
| >1.25 | 145 | 114 | 41.54 | 0.36 | 70% | 73 / 34 / 7 | 1.12 | 0.86 | 13 | 0.68 |
| n/a | 3 | 3 | 6 | 2 | 100% | 3 / 0 / 0 | 2 | 0.89 | 0 | 1.19 |
| all | 206 | 164 | 47.98 | 0.29 | 69% | 106 / 51 / 7 | 1.03 | 0.85 | 22 | 0.65 |

**Comparison (traded) by day**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-17 | 30 | 25 | 4.48 | 0.18 | 76% | 19 / 6 / 0 | 0.82 | 0.82 | 0 | 0.63 |
| 2026-11-18 | 55 | 49 | 25.8 | 0.53 | 76% | 37 / 12 / 0 | 1.04 | 0.85 | 0 | 0.69 |
| 2026-11-19 | 25 | 23 | 12.36 | 0.54 | 91% | 21 / 2 / 0 | 0.66 | 0.89 | 0 | 1.95 |
| 2026-11-20 | 36 | 29 | 2.65 | 0.09 | 66% | 19 / 10 / 0 | 0.71 | 0.86 | 0 | 0.39 |
| 2026-11-22 | 1 | 0 | 0 | – | – | 0 / 0 / 0 | – | – | 0 | -1.03 |
| 2026-11-23 | 25 | 18 | -4.65 | -0.26 | 33% | 6 / 12 / 0 | 1.29 | 0.81 | 22 | -0.05 |
| 2026-11-24 | 27 | 14 | 11.35 | 0.81 | 71% | 4 / 4 / 6 | 1.91 | 0.85 | 0 | 0.62 |
| 2026-11-25 | 7 | 6 | -4.01 | -0.67 | 17% | 0 / 5 / 1 | 1.97 | 0.87 | 0 | -0.24 |
| all | 206 | 164 | 47.98 | 0.29 | 69% | 106 / 51 / 7 | 1.03 | 0.85 | 22 | 0.65 |

### Softer variants: the room-only WAITs each would release (same replay)

| variant | released | replayed | mean R | total R | win | counter-trend | not inside a traded position | first per episode (of those): n / replayed / mean R / total R / win |
|---|---|---|---|---|---|---|---|---|
| (a) room ahead only, ≥ 0.25 ATR | 142 | 93 | 0.2 | 18.49 | 80% | 13 | 35 | 14 / 11 / 0.3 / 3.33 / 91% |
| (a) room ahead only, ≥ 0.5 ATR | 30 | 22 | 0.21 | 4.57 | 77% | 3 | 9 | 6 / 4 / 0.53 / 2.14 / 100% |
| (a) room ahead only, ≥ 1.0 ATR (the current number) | 0 | 0 | – | 0 | – | 0 | 0 | 0 / 0 / – / 0 / – |
| (b) waived on a breakout close (b1: previous bar's corridor) | 21 | 16 | 0.22 | 3.46 | 69% | 1 | 6 | 6 / 5 / 0.57 / 2.83 / 80% |
| (b) waived on a breakout close (b4: any of the last hour's corridors) | 92 | 77 | 0.22 | 16.82 | 73% | 2 | 24 | 14 / 12 / 0.6 / 7.23 / 92% |
| (c) corridor_atr 0.75 | 59 | 38 | 0.15 | 5.69 | 71% | 9 | 18 | 9 / 6 / 0.54 / 3.23 / 83% |
| (c) corridor_atr 0.5 | 163 | 113 | 0.17 | 19.24 | 73% | 20 | 40 | 15 / 13 / 0.46 / 6 / 85% |
| (d1) with-trend only (TREND_TF with the trade), no room | 215 | 164 | 0.23 | 38.18 | 76% | 0 | 51 | 18 / 15 / 0.56 / 8.35 / 87% |
| (d2) corridor_atr 0.75 and with-trend | 50 | 36 | 0.13 | 4.58 | 72% | 0 | 16 | 9 / 5 / 0.22 / 1.12 / 80% |
| (d3) corridor_atr 0.5 and with-trend | 143 | 105 | 0.18 | 19 | 75% | 0 | 38 | 15 / 12 / 0.32 / 3.9 / 83% |
| (d5) the plan's tp1 lies inside the room ahead (target before the opposing zone) | 101 | 84 | 0.2 | 16.48 | 81% | 6 | 33 | 14 / 12 / 0.31 / 3.68 / 92% |
| (d6) (b4) breakout and with-trend | 90 | 76 | 0.23 | 17.82 | 74% | 0 | 23 | 14 / 12 / 0.6 / 7.23 / 92% |
| (d4) room guard off (every room-only WAIT) | 238 | 172 | 0.22 | 38.42 | 74% | 23 | 53 | 18 / 16 / 0.65 / 10.45 / 88% |
| **baseline: traded BUY/SELL** | 206 | 164 | 0.29 | 47.98 | 69% | 22 | – | 35 / 27 / 0.21 / 5.78 / 67% |

**The same, only the releases the current decide() would also trade (room lifted; the agents' and arm vetoes as now; R of that trade)**

| variant | released | replayed | mean R | total R | win | counter-trend | not inside a traded position | first per episode (of those): n / replayed / mean R / total R / win |
|---|---|---|---|---|---|---|---|---|
| (a) room ahead only, ≥ 0.25 ATR | 101 | 81 | 0.21 | 17.17 | 80% | 8 | 27 | 11 / 10 / 0.44 / 4.42 / 100% |
| (a) room ahead only, ≥ 0.5 ATR | 23 | 18 | 0.13 | 2.43 | 72% | 2 | 6 | 4 / 3 / 0.54 / 1.63 / 100% |
| (a) room ahead only, ≥ 1.0 ATR (the current number) | 0 | 0 | – | 0 | – | 0 | 0 | 0 / 0 / – / 0 / – |
| (b) waived on a breakout close (b1: previous bar's corridor) | 18 | 15 | 0.19 | 2.82 | 67% | 1 | 5 | 5 / 4 / 0.55 / 2.19 / 75% |
| (b) waived on a breakout close (b4: any of the last hour's corridors) | 75 | 70 | 0.23 | 16.11 | 73% | 2 | 21 | 11 / 10 / 0.77 / 7.7 / 100% |
| (c) corridor_atr 0.75 | 35 | 29 | 0.06 | 1.82 | 66% | 6 | 13 | 6 / 6 / 0.82 / 4.92 / 100% |
| (c) corridor_atr 0.5 | 116 | 95 | 0.16 | 15.52 | 73% | 14 | 29 | 12 / 12 / 0.58 / 6.99 / 92% |
| (d1) with-trend only (TREND_TF with the trade), no room | 164 | 142 | 0.22 | 31.54 | 75% | 0 | 38 | 15 / 14 / 0.65 / 9.16 / 93% |
| (d2) corridor_atr 0.75 and with-trend | 29 | 27 | 0.03 | 0.71 | 67% | 0 | 11 | 6 / 5 / 0.56 / 2.81 / 100% |
| (d3) corridor_atr 0.5 and with-trend | 102 | 87 | 0.18 | 15.28 | 75% | 0 | 27 | 12 / 11 / 0.44 / 4.89 / 91% |
| (d5) the plan's tp1 lies inside the room ahead (target before the opposing zone) | 87 | 73 | 0.19 | 14.15 | 81% | 6 | 26 | 11 / 10 / 0.44 / 4.42 / 100% |
| (d6) (b4) breakout and with-trend | 73 | 69 | 0.25 | 17.11 | 74% | 0 | 20 | 11 / 10 / 0.77 / 7.7 / 100% |
| (d4) room guard off (every room-only WAIT) | 181 | 150 | 0.21 | 31.78 | 74% | 17 | 40 | 15 / 15 / 0.75 / 11.27 / 93% |

**Variants in full (rebuilt plan)**

| split | n | replayed | total R | mean R | win | tp1 / stop / open | mean tp1 R | mean stop ATR | counter-trend | mean 4h move ATR |
|---|---|---|---|---|---|---|---|---|---|---|
| (a) room ahead only, ≥ 0.25 ATR | 142 | 93 | 18.49 | 0.2 | 80% | 71 / 19 / 3 | 0.69 | 0.84 | 13 | 0.71 |
| (a) room ahead only, ≥ 0.5 ATR | 30 | 22 | 4.57 | 0.21 | 77% | 17 / 5 / 0 | 0.62 | 0.89 | 3 | 0.84 |
| (a) room ahead only, ≥ 1.0 ATR (the current number) | 0 | 0 | 0 | – | – | 0 / 0 / 0 | – | – | 0 | – |
| (b) waived on a breakout close (b1: previous bar's corridor) | 21 | 16 | 3.46 | 0.22 | 69% | 10 / 5 / 1 | 0.9 | 0.82 | 1 | 0.63 |
| (b) waived on a breakout close (b4: any of the last hour's corridors) | 92 | 77 | 16.82 | 0.22 | 73% | 52 / 21 / 4 | 1.01 | 0.84 | 2 | 0.67 |
| (c) corridor_atr 0.75 | 59 | 38 | 5.69 | 0.15 | 71% | 27 / 11 / 0 | 0.72 | 0.84 | 9 | 0.82 |
| (c) corridor_atr 0.5 | 163 | 113 | 19.24 | 0.17 | 73% | 81 / 30 / 2 | 0.75 | 0.84 | 20 | 0.64 |
| (d1) with-trend only (TREND_TF with the trade), no room | 215 | 164 | 38.18 | 0.23 | 76% | 115 / 40 / 9 | 0.95 | 0.85 | 0 | 0.65 |
| (d2) corridor_atr 0.75 and with-trend | 50 | 36 | 4.58 | 0.13 | 72% | 26 / 10 / 0 | 0.67 | 0.84 | 0 | 0.74 |
| (d3) corridor_atr 0.5 and with-trend | 143 | 105 | 19 | 0.18 | 75% | 77 / 26 / 2 | 0.72 | 0.84 | 0 | 0.61 |
| (d5) the plan's tp1 lies inside the room ahead (target before the opposing zone) | 101 | 84 | 16.48 | 0.2 | 81% | 68 / 16 / 0 | 0.5 | 0.84 | 6 | 0.63 |
| (d6) (b4) breakout and with-trend | 90 | 76 | 17.82 | 0.23 | 74% | 52 / 20 / 4 | 1.01 | 0.84 | 0 | 0.69 |
| (d4) room guard off (every room-only WAIT) | 238 | 172 | 38.42 | 0.22 | 74% | 119 / 44 / 9 | 0.96 | 0.84 | 23 | 0.67 |

**Overlaps between variants (room-only releases in both)**

| | (a) ≥ 0.25 ATR | (a) ≥ 0.5 ATR | (a) ≥ 1.0 ATR | (b) waived on a breakout close | (b) waived on a breakout close | (c) corridor_atr 0.75 | (c) corridor_atr 0.5 | (d5) the plan's tp1 lies inside the room ahead |
|---|---|---|---|---|---|---|---|---|
| (a) ≥ 0.25 ATR | 142 | 30 | 0 | 13 | 60 | 48 | 124 | 101 |
| (a) ≥ 0.5 ATR | 30 | 30 | 0 | 4 | 14 | 17 | 30 | 27 |
| (a) ≥ 1.0 ATR | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| (b) waived on a breakout close | 13 | 4 | 0 | 21 | 21 | 5 | 13 | 8 |
| (b) waived on a breakout close | 60 | 14 | 0 | 21 | 92 | 26 | 62 | 44 |
| (c) corridor_atr 0.75 | 48 | 17 | 0 | 5 | 26 | 59 | 59 | 32 |
| (c) corridor_atr 0.5 | 124 | 30 | 0 | 13 | 62 | 59 | 163 | 90 |
| (d5) the plan's tp1 lies inside the room ahead | 101 | 27 | 0 | 8 | 44 | 32 | 90 | 101 |

### Not replayed

room only: {"not_rebuilt:no plan on the quorum side":29,"skipped:cell_gate_unreconstructable":15,"skipped:no_bars":5,"skipped:price_past_entry":1,"skipped:range_mode_agent":4,"skipped:waiting_for_pullback":12}

room plus: {"skipped:cell_gate_unreconstructable":1,"skipped:no_bars":5,"skipped:price_past_entry":1,"skipped:waiting_for_pullback":1}

traded: {"skipped:cell_gate_unreconstructable":19,"skipped:no_bars":3,"skipped:price_past_entry":1,"skipped:range_breakout":2,"skipped:range_mode_agent":1,"skipped:waiting_for_pullback":16}

current decide() with the room lifted (room only): {"held: strategy_agents:strategy_agents":28,"held: strategy_arm:strategy_arm":29,"trades, another plan":8,"trades, same plan as the rebuild":173}

exits: room only {"open_at_data_end":9,"stop":44,"target":119}; traded {"open_at_data_end":7,"stop":51,"target":106}

meta: {"bars":8723,"feed":7279,"broker_shifted":1444,"first_feed":"2026-11-17T23:04","last_bar":"2026-11-25T05:39","horizon_h":72,"since":"2026-11-17T00:00:00.000Z"}
