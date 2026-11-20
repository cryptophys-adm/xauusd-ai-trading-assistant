# RFC: Omega limit entries, held by the council, with learned knobs

Status: draft for review (orchestrator first, then the owner). Owner decision 2026-11-20, relayed by the orchestrator and
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

- New Omega setting `entry_order`: `"market"` (default) or `"limit"`.
  - It is added to `OMEGA_DEFAULTS` and checked in `settingsFrom` as an enum, like `sor_mode`.
  - It is the owner's switch on the Omega page and needs no deploy.
  - Aether's policy (`applyOmegaPolicy`) never writes it.
- `"limit"` is refused (`ea_1_21_required`) while the connected EA is older than 1.21.
- Back to `"market"`: any pending Omega limit is deleted at the next sync, and entries return to today's path unchanged.

## 3. Placement: only on the council's consensus

When `entry_order` is `"limit"` and the decision is `ENTER_LIMIT`, every entry gate of today runs first, unchanged and in the
same order (`planIntents` :791-902).

Then Omega asks the **entry council**:
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
- A limit that would fill at once (price already through it) is not placed. The next cycle sees the market path's reasons
  instead.

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
- the quorum share fell by more than `cancel_share_drop` (a learned knob);
- price moved more than `move_max_atr` × ATR(15m) from the order (for a move: the new level must lie within that distance and
  keep the stop and target sides valid).

A WAIT stance alone is never a reason. Without a measured reason the order is kept (`keep_no_reason`).

**The council has no fixed 15-minute expiry.** It keeps the order while the signal stands, up to `max_pending_life` (a learned
knob; starting value 1 hour), after which Omega deletes the order (`pending_expired`).

**Mechanical fallback (#489's idea):** when the council does not answer (model failure, timeout or daily cap), the pending order
is **cancelled at that 15m close** (`council_unavailable`). No pending order is left unattended.

## 5. After the fill

The EA reports the fill as a new position whose ticket equals the order's ticket (MT5 hedging accounts). Omega then:
- records the open, with the intent id, signal, stop source and mode;
- hands the position to the Position Manager as today: stop locks, TP2 with break-even (ADR-0020 Amendment 6), and exits by
  the council;
- sends one Telegram line per event: placed, moved, cancelled (with its reason) and filled.

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

**Only one pending Omega order at a time.** A second signal while one is pending is `pending_order_exists`; the council may
still move the existing one.

**Deleted at once, with no council involved:**
- pause, kill (`close_all` already deletes every order) and Omega switched off;
- `entry_order` set back to `"market"`;
- a profile downgrade;
- the daily budget exhausted;
- a news blackout starting;
- the symbol or money checks failing.

## 7. Dynamic knobs, learned per mode, within doctrine bounds

None of these values are hard-coded beyond their starting values:

| Knob | Meaning | Start | Bound (per mode, proposed) |
|---|---|---|---|
| `max_pending_life` | how long a limit may wait | 60 min | scalp 15–120, intraday 30–240, swing 60–720 min |
| `move_max_atr` | how far the council may move it | 0.5 × ATR(15m) | 0–1.0 |
| `cancel_share_drop` | quorum share drop that counts as a reason | 0.05 | 0.03–0.10 |
| `placement_band` | furthest limit from price, in plan stops | 0.35 | 0.1–1.0 |

**Tuning:**
- They are tuned like the council knobs (`council-knob-tuning.mjs`) and the room guardrail (#482):
  - a shadow replay of the ledger's limit policy (§8) per mode;
  - a paired sign test with Holm correction, 200 discovery and 100 holdout signals;
  - live once the test passes, with an automatic rollback.
- Live values are kept per mode in KV `omega-limit-knobs:v1`. Every change is an event and reaches Aether.

**Doctrine bounds:**
- The bounds live in the platform kernel's `DOCTRINE_BOUNDS` per mode. They are proposed to the platform session, not set by
  xauusd.
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

## 9. EA 1.21 (the owner installs it on the VPS; the bridge is unchanged)

`intents.txt` keeps its format, `id;kind;side;volume;sl;tp;ticket`, so the bridge needs no change.

- **`place_limit`**
  - `volume` carries `<lot>@<limit price>`.
  - `sl` and `tp` are as usual.
  - `ticket` carries the expiry as UTC epoch seconds.
  - The EA converts the expiry to server time (`TimeTradeServer() + (expiry − TimeGMT())`).
  - When the symbol does not allow `ORDER_TIME_SPECIFIED`, the EA places the order GTC; Omega's own lifetime then deletes it.
  - Refusals: a price already through, `SYMBOL_TRADE_STOPS_LEVEL`, and the freeze level.
  - The order comment carries the intent id.
- **`delete_order`**
  - `ticket` is the order.
  - The EA acts only on its own magic, or on `manual:`/`d:` ids, as today.
- **`modify_order`** is unchanged (the price rides in `volume`). The council's moves use it.
- **Results:** one result per intent, with the retcode.
- The orders report (`BuildOrdersJson`) already carries the ticket, type, price, SL, TP, source and `placed_ms`.

## 10. Delivery, in stages (each PR reviewed by the orchestrator, then the owner, before merge)

1. **EA 1.21 and the switch, no behaviour change.**
   - `place_limit`, `delete_order` and the `entry_order` setting, which refuses `"limit"` until EA 1.21 is connected.
   - Pending Omega orders counted in `max_positions` and risk.
   - The deletion guards of §6.
   - Default `"market"`, so nothing changes live.
2. **The ledger policy and the report (§8).** Measurement only. It starts collecting on today's signals at once.
3. **Live limit placement and the pending council (§3–§5),** behind `entry_order: "limit"`, with the knobs at their starting
   values.
4. **The learned knobs (§7):** the tuning loop, the bounds request to the platform session and the anchors with Aether.

The owner installs EA 1.21 after stage 1 and switches `entry_order` to `"limit"` after stage 3.

## 11. Open points

- **The model cost** of the entry council and of the per-15m pending check sits inside the position council's USD 5 daily cap.
  When the cap is reached, the fallback cancels the order (§4) and no new limit is placed.
- **Netting accounts:** if a broker reports a netting account, `place_limit` is refused (`netting_account`). This keeps the
  ticket-equals-position rule of §5 true.
- **The live fill gap:** the orchestrator measured about 2 points worse on average since 19 Nov 12:00 (limit vs fill), before
  the feed basis. Stage 3 records the planned and the filled price per order, in R, so the gap stays measured.
