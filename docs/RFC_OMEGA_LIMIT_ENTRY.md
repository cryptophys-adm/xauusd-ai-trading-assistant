# RFC: Omega limit entries, held by the council, with learned knobs

Status: reviewed by the orchestrator (2026-11-20, six points folded in) and by the platform session (2026-11-20, §7 and the
stage 3 precondition in §10 folded in), for the owner's review. Updated 2026-11-20 with the owner's confirmation: the
`"council"` entry order (§2), and ADR-0020 Amendments 7 and 8, merged on the platform (cryptophys-cloud-platform ed43279),
folded into §4, §6 and §10. Stage 1 is merged (#497); stage 2 (§8, measurement only) is the PR that adds this line. Owner decision 2026-11-20, relayed by the orchestrator and
confirmed by the owner in the session ("Yes, that scope"): "setuju dan tetap dinamis learning dan knowledge karena prinsip
system ini adalah feedloop auto learning dan dinamis."

## 1. Why

Today Omega enters an `ENTER_LIMIT` plan **at market**:
- it waits while price is more than 0.35 × the stop away toward the target (`waiting_for_pullback`, `omega-engine.mjs:893`);
- it refuses past 0.35 × the stop toward the stop (`price_past_entry`, :899);
- it then buys or sells at the broker's ask or bid (:904).

The EA cannot place a pending order (`ExecuteOpenIntent` is market only, `OmegaExecutor.mq5:1314`). The plan's own level is
never worked at the broker.

The orchestrator's historical check (signal_ledger since 9 Nov, 102 decision signals) on the same 53 signals:

| Policy | Profit factor | Total R |
|---|---|---|
| Plan limit + TP1 | 1.72 | +8.6 R |
| Omega (today) | 2.12 | +12.3 R |
| Plan limit + TP2 | 2.69 | +15.2 R |

Most of the limit-only fills that Omega skipped were refused by Omega's own gates, not by the entry style:
- `same_side_unprotected` 13;
- `daily_loss_limit` 9;
- `max_positions` 4;
- `waiting_for_pullback` 1.

So the comparison is not settled. The owner chose to run limit entries live, and the ledger comparison (§8) is how we will
know which entry works, per mode and regime.

## 2. The switch

- New Omega setting `entry_order`: `"market" | "limit" | "council"`. The default stays `"market"`.
  - It is added to `OMEGA_DEFAULTS` and checked in `settingsFrom` as an enum, like `sor_mode`. Stage 1 accepts
    `"market"` and `"limit"` and refuses `"limit"` until stage 3; stage 3 adds `"council"` behind the same switch.
  - It is the owner's switch on the Omega page and needs no deploy.
  - Aether's policy (`applyOmegaPolicy`) never writes it.
- `"limit"` and `"council"` are refused (`ea_1_21_required`) while the connected EA is older than 1.21.
- Back to `"market"`: any pending Omega limit is deleted at the next sync, and entries return to today's path unchanged.

**`"limit"`** places every entry as a limit (§3–§5): a missed limit is a missed trade.

**`"council"` (owner, confirmed 2026-11-20).** The entry council (§3) chooses per signal between three answers, each with
a measured reason (the rule of `cut_loss`, #488):
- `enter_market`: the taker entry, today's market path;
- `place_limit`: the maker entry, a resting limit (§3–§5);
- `skip`: no entry.

The rules under `"council"`:
- **A silent council is today's market path.** No answer (model failure, timeout, the daily cap) means `enter_market`
  through today's gates, never a skip and never a limit.
- **One limit→market conversion per signal.** While its limit rests, the council may convert it once to a market entry:
  - the cancel goes first (`delete_order`), and the market leg is planned only after the cancel's result;
  - a fill in the meantime ends the conversion: the filled position is managed as any limit fill (§5), and no market leg
    follows;
  - the market leg is sized afresh at its own price, with today's formula and every gate of today (§6). It never inherits
    the limit's lot.
- **Risk is money at the stop.** risk_pct, the profile caps and the daily budget count the money each entry would lose at
  its stop, at the price it enters at. The adaptive stop (0.75 × ATR) stays for both entries.
- The ledger measures exactly this choice (§8): every signal is followed as taker (v4) and as maker (the limit policy).

## 3. Placement: only on the council's consensus

When `entry_order` is `"limit"` and the decision is `ENTER_LIMIT`, every entry gate of today runs first, unchanged and in the
same order (`planIntents` :791-902).

Then Omega asks the **entry council** (under `"council"`, the same call answers `enter_market`, `place_limit` or `skip`,
§2):
- **Seats:** Omega's entry seat and the Position Manager's seat, in one model call (`callBusModel`, its own schema and meter
  source `entry_council`, the same daily USD cap as the position council).
- **What it reads:** the 15m decision with its reasons, and the 1H, 4H and 1D rooms' latest readings and biases.
- **What it answers:** `place` or `skip`, with its reasons.
- `skip` or no answer means **no order**. There is no market fallback: in limit mode a missed limit is a missed trade, and the
  ledger counts it (§8).

**The limit price**
- It is the decision's level (`signal.entry`, OANDA scale) plus the feed→broker basis measured at placement:
  `limit = entry + feed_basis`.
  - The basis is `feedBasis` (`ea-signal.mjs:146`): the median of matched broker − feed closes. It is the same basis that
    `brokerKeyLevels` already applies to key levels.
- If the basis is unknown (`feed_basis_known` false), Omega does not place the order (`basis_unknown`).
- The stop and the target keep their distances from the limit price, as for market entries today.

**Placement band (a learned knob, §7)**
- The limit must be on the correct side of the current broker price: a buy limit below the ask, a sell limit above the bid.
- It must be no further than `placement_band` × the plan's stop from the current price. Otherwise: `limit_out_of_band`.
- A limit that would fill at once (price already through it) is not placed. In limit mode there is no market fallback, so
  this is a **missed entry** (`limit_through_price`), and the ledger counts it as one (§8).

**Sizing at placement, as if filled**
- The lot uses today's formula: risk_pct, the profile caps, `volume_below_min`, `tick_value_mismatch`, the open-risk cap and
  the daily budget (:904-945).
- The only difference is that it uses the limit price in place of ask/bid.

## 4. While pending: the council keeps, moves or cancels

At each **15m close** while a limit is pending, the Position Manager's run asks the council about the pending order. It answers
`keep`, `move` (to one of the broker key levels it names) or `cancel`.

**Every move or cancel needs a measured reason**, the same rule as `cut_loss` (#488, `position-manager.mjs:167-181`). The
reasons are:
- the decision now stands against the order's side;
- the strategy agent's confidence trend is a `drop`;
- price moved more than `move_max_atr` × ATR(14) of the 15m bars from the order.

A WAIT stance alone is never a reason. Without a measured reason the order is kept (`keep_no_reason`).

**A move, under ADR-0020 Amendment 7 (merged, ed43279):**
- only toward price, and by at most `move_max_atr` × ATR(14) of the 15m bars from the order's level;
- the stop and the target shift by the same amount as the level, so the order's distances never change: a move never
  widens the stop or the plan, and it keeps the stop and target sides valid;
- the lot is not raised by a move (the risk at the stop stays what it was at placement or less).

**Deterministic cancels, with no council involved (A7):** the order is deleted at once when
- its side's quorum share (`quorum.long_share` for a buy, `quorum.short_share` for a sell) fell by more than
  `cancel_share_drop` from the placing decision to the current 15m decision (`quorum_share_drop`; this was a council reason
  before A7);
- the Decision Engine vetoes its side (`de_veto`);
- the profile is downgraded to Safe (`profile_downgrade`);
- the account is disarmed (`disarmed`) or killed (`kill`);
- and the hard reasons of §6.

**The council has no fixed 15-minute expiry.** It keeps the order while the signal stands, up to `max_pending_life` (a learned
knob per mode, §7; intraday starts at 60 minutes), after which Omega deletes the order (`pending_expired`).

**Mechanical fallback (#489's idea):** when the council does not answer (model failure, timeout or daily cap), the pending order
is **cancelled at that 15m close** (`council_unavailable`). No pending order is left unattended.

## 5. After the fill

The EA reports the fill as a new position whose ticket equals the order's ticket (MT5 hedging accounts).

**Re-check at fill (the deterministic backstop).** Before anything else, the hard guards run once more on the new position:
- `tick_value_mismatch`;
- the volume against the symbol's `volume_min` and `volume_max`;
- the profile hard caps;
- the daily loss budget, including this position's risk at its stop.

On any breach the Position Manager closes the position at once, with that guard as its measured reason (`fill_guard_<name>`).
This covers anything that changed between placement and fill.

Otherwise Omega:
- records the open, with the intent id, signal, stop source and mode;
- hands the position to the Position Manager as today: stop locks, TP2 with break-even (ADR-0020 Amendment 6), and exits by
  the council;
- sends one Telegram line per event: placed, moved, cancelled (with its reason) and filled. **These lines go to the owner's
  private channel only**, never to a public or CTA channel, because they carry levels.

## 6. Hard guards (deterministic; no consensus overrides them)

**Checked at placement, as today:**
- `tick_value_mismatch`, `volume_below_min`;
- the profile hard caps;
- the daily loss budget (`daily_loss_limit`, `daily_risk_budget`);
- `max_positions`, `spread`, `blackout`, `paused`.

**A pending order counts as a position and as used risk:**
- `max_positions` counts Omega's pending order;
- `openRiskAtStops` adds its risk at the stop;
- `same_side_unprotected` treats it as unprotected until filled and locked.

**The platform cap (ADR-0020 A7):** pending orders count toward the platform's cap of 3 open positions per account, together
with the open positions. The profile's own `max_positions` (Safe 1, Conservative 2, Aggressive 3) stays the tighter one.

**Only one pending Omega order at a time.** A second signal while one is pending is `pending_order_exists`; the council may
still move the existing one.

**Deleted at once, with no council involved:**
- pause, kill (`close_all` already deletes every order) and Omega switched off;
- disarm on a real account (`disarmed`: the owner's disarm or auto-disarm under ADR-0020; Amendment 7: a resting entry is
  cancelled on disarm or kill);
- a Decision Engine veto of its side (`de_veto`, A7);
- its side's quorum share falling by more than `cancel_share_drop` (`quorum_share_drop`, A7, §4);
- an Omega pending order without a stop (`pending_without_stop`): Omega never places one, and its risk is unbounded;
- `entry_order` set back to `"market"`;
- a profile downgrade (to Safe in A7's words; any downgrade here);
- the daily budget exhausted;
- a news blackout starting;
- the symbol or money checks failing.

## 7. Dynamic knobs, learned per mode, within doctrine bounds

None of these values are hard-coded beyond their starting values. Every knob has a value per mode for all four modes
(scalp, intraday, swing and range). Range mode uses limit entries too: its range strategies enter at the range's edges,
which is where a limit rests.

**The knobs, their units and their platform fact names** (fact names carry no "order", "trade" or "trading", because the
Policy Engine's prohibited filter refuses them; platform test K2):

| Knob | Platform fact | Unit, exactly |
|---|---|---|
| `max_pending_life` | `omega.limit_life_min_<mode>` | minutes, from the order's placement (the EA's `placed_ms`) to its deletion; the EA's expiry is set from it |
| `move_max_atr` | `omega.limit_move_max_atr_<mode>` | multiple of ATR(14) of the closed **15m** bars (the decision timeframe, `strategy-engine.mjs` `atr`), in broker price, read at the 15m close of the check |
| `cancel_share_drop` | `omega.limit_cancel_share_drop_<mode>` | absolute drop (0–1) of the order side's share of the Decision Engine's weighted witness quorum (`quorum.long_share` for a buy, `quorum.short_share` for a sell), from the placing decision to the current 15m decision |
| `placement_band` | `omega.limit_band_<mode>` | fraction of the plan's stop distance (\|entry − stop\| of the placing decision), measured from the current broker ask (buy) or bid (sell) to the limit |

**Starting values and bounds** (proposed to the platform session; narrowed in its review of 2026-11-20):

| Knob | scalp | intraday | swing | range |
|---|---|---|---|---|
| `max_pending_life` (min) | 15–60, start 30 | 30–240, start 60 | 60–720, start 240 | 30–240, start 60 |
| `move_max_atr` (× ATR(14) 15m) | 0–0.5, start 0.25 | 0–0.5, start 0.5 | 0–0.5, start 0.5 | 0–0.5, start 0.25 |
| `cancel_share_drop` (share) | 0.03–0.10, start 0.05 | 0.03–0.10, start 0.05 | 0.03–0.10, start 0.05 | 0.03–0.10, start 0.05 |
| `placement_band` (× stop distance) | 0.1–0.6, start 0.35 | 0.1–0.6, start 0.35 | 0.1–0.6, start 0.35 | 0.1–0.6, start 0.35 |

- `placement_band` stays well under 1.0: at 1.0 the limit would sit on the stop and the sizing breaks. The platform allows a
  ceiling of 0.6–0.7; this RFC proposes the lower end, 0.6.
- Range and scalp start `move_max_atr` at 0.25: a range edge is a fixed level, and a scalp's stop is short.
- Range mode's own exit still holds: on a range breakout the decision loses its side (`range_breakout`), which is a measured
  cancel reason (§4).

**Tuning:**
- They are tuned like the council knobs (`council-knob-tuning.mjs`) and the room guardrail (#482):
  - a shadow replay of the ledger's limit policy (§8) per mode;
  - a paired sign test with Holm correction, 200 discovery and 100 holdout signals;
  - live once the test passes, with an automatic rollback.
- Live values are kept per mode in KV `omega-limit-knobs:v1`. Every change is an event and reaches Aether.

**Doctrine bounds:**
- The bounds live in the platform kernel's `DOCTRINE_BOUNDS` per mode (cryptophys-cloud-platform 6bf061a, live in the kernel
  since 30416b2). They are proposed to the platform session, not set by xauusd. The orchestrator sent the bounds above as a
  heads-up for stage 4.
- Aether holds an anchor per knob and mode in the canon, so knowledge can pull a knob toward what worked.
- xauusd clamps every value to the bound it reads, and falls back to the starting value without one.

## 8. The feedback loop: the ledger learns which entry works

- A new ledger policy, **"Omega with limit entry"**, runs beside today's Omega (market) policy on the same signals.
  - Version `cryptophys.ledger-omega-limit.v1`.
  - It has the same gates and the same management. The entry is a limit at the decision's level, filled when a bar reaches it
    within `max_pending_life` and while no cancel reason holds.
  - A pending order counts toward `max_positions` and risk, exactly as live.
- **The execution report to Aether** (`executionReport`, R multiples and times only, no price keys) carries both policies per
  mode and regime:
  - fill rate;
  - missed signals (unfilled, cancelled, expired);
  - R per trade, profit factor and total R;
  - the paired comparison against market entry.
- The same records feed the knob tuning in §7.

**Built in stage 2 (`src/ledger-omega-limit.mjs`, measurement only):**
- **The replay.** `replayOmegaLimit` is v4's own replay (`replayOmega4`) with an entry policy: one simulated account, the
  same 1m bars, decisions, gates and management. The policy places a resting limit at the decision's level (`signal.entry`,
  feed scale, basis 0) at the first minute planIntents' own gates pass for the signal; planIntents sizes it as if filled at
  the limit (a probe call with the symbol priced at the level). It fills when a 1m bar's range reaches it (a buy when the
  ask's low does, a sell when the bid's high does). After the fill the position is a v4 trade: planIntents, the TP ladder
  and the Position Manager. v4's results and its `ENGINE_CODE_HASH` are unchanged.
- **Missed:** `limit_through_price`, `limit_out_of_band` (at placement); `pending_expired` (at `max_pending_life`);
  `decision_against`, `quorum_share_drop`, `blackout`, `daily_loss_limit`, `profile_downgrade`, `kill`, `paused` (checked
  at every minute's open while it rests). One resting order at a time (`pending_order_exists`).
- **Knobs:** the start values of §7, clamped to A7's bounds; no reader of the `omega.limit_*` facts exists yet.
  `move_max_atr` is recorded but moves nothing (no council in a replay).
- **Not modelled:** the council's place, keep and move; `de_veto` and disarm (the replay keeps the arm on, as v4); the
  fill-time re-check of §5.
- **Storage:** the `limit_*` columns and `regime` on v4's own `ledger_omega4` row of each decision, so maker and taker pair
  on one row.
- **Run:** after v4 in the same 5-minute ledger step, never past the minute v4 has replayed, within what v4 left of the
  run's 720-minute bound.
- **Report:** `cryptophys.execution-report.v1` gains a top-level `limit` block (the schema stays v1; Aether's validator allows extra top-level fields) per mode and regime (fill rate, missed by reason,
  maker and taker R per trade, profit factor and total R, the pairs: n, maker better, taker better, mean ΔR). Nexus
  shows it as "Maker vs taker" on the Performance page.

## 9. EA 1.21 (the owner installs it on the VPS; the bridge is unchanged)

`intents.txt` keeps its format, `id;kind;side;volume;sl;tp;ticket`, so the bridge needs no change.

- **`place_limit`**
  - `volume` carries `<lot>@<limit price>`.
  - `sl` and `tp` are as usual.
  - `ticket` carries the expiry as UTC epoch seconds.
  - The EA converts the expiry to server time (`TimeTradeServer() + (expiry − TimeGMT())`).
  - **No GTC, ever.** When the symbol does not allow `ORDER_TIME_SPECIFIED`, the EA still places the order, but enforces the
    expiry itself: it keeps the expiry per ticket and deletes its own pending order at that time from its own timer. This works
    with no server, bridge or VPS link.
  - Refusals: a price already through, `SYMBOL_TRADE_STOPS_LEVEL`, and the freeze level.
  - The order comment carries the intent id.
- **`delete_order`**
  - `ticket` is the order.
  - The EA acts only on its own magic, or on `manual:`/`d:` ids, as today.
- **`modify_order`** is unchanged (the price rides in `volume`). The council's moves use it.
- **Dead-man switch.** If the EA has seen no fresh intents file (a new `#v1;<written_ms>` header) for
  `PendingDeadManSeconds` (an EA input, default 120 s), it deletes its own pending Omega orders.
  - Kill, pause and every deletion in §6 need the bridge to reach the EA. This switch covers the case where they cannot.
  - Open positions are not touched: they keep their broker stop and target.
- **Results:** one result per intent, with the retcode.
- The orders report (`BuildOrdersJson`) already carries the ticket, type, price, SL, TP, source and `placed_ms`.

## 10. Delivery, in stages (each PR reviewed by the orchestrator, then the owner, before merge)

1. **EA 1.21 and the switch, no behaviour change.**
   - `place_limit`, `delete_order` and the `entry_order` setting, which refuses `"limit"` until EA 1.21 is connected.
   - Pending Omega orders counted in `max_positions` and risk.
   - The deletion guards of §6.
   - Default `"market"`, so nothing changes live.
2. **The ledger policy and the report (§8).** Measurement only. It starts collecting on today's signals at once.
   **This is the stage 2 PR** (2026-11-20): `src/ledger-omega-limit.mjs`, the `limit_*` columns of `ledger_omega4`,
   the execution report's `limit` block and the Nexus "Maker vs taker" panel. No live behaviour changes:
   `LIMIT_ENTRY_AVAILABLE` stays false and nothing places an order.
3. **Live limit placement and the pending council (§3–§5),** behind `entry_order: "limit"` and `"council"` (§2), with the
   knobs at their starting values. **Stage 3 is the PR that flips `LIMIT_ENTRY_AVAILABLE` to true**; stage 2 must not.
   - **Precondition met: ADR-0020 Amendment 7** (resting entries under the arm) is merged on the platform (with Amendment 8,
     cryptophys-cloud-platform ed43279). Its stricter points are folded in above: a move only toward price within
     `move_max_atr`, the stop and target shifted by the same amount, never widened (§4); deterministic cancels on the
     quorum share drop, a Decision Engine veto (`de_veto`), a downgrade to Safe, disarm and kill (§4, §6); pending orders
     counted toward the platform cap of 3 (§6). Stage 3 implements them as written here.
4. **The learned knobs (§7):** the tuning loop, the bounds request to the platform session and the anchors with Aether.

The owner installs EA 1.21 after stage 1 and switches `entry_order` to `"limit"` after stage 3.

## 11. Open points

- **The model cost** of the entry council and of the per-15m pending check sits inside the position council's USD 5 daily cap.
  When the cap is reached, the fallback cancels the order (§4) and no new limit is placed.
- **Netting accounts:** if a broker reports a netting account, `place_limit` is refused (`netting_account`). This keeps the
  ticket-equals-position rule of §5 true.
- **The live fill gap:** the orchestrator measured about 2 points worse on average since 19 Nov 12:00 (limit vs fill), before
  the feed basis. Stage 3 records the planned and the filled price per order, in R, so the gap stays measured.
