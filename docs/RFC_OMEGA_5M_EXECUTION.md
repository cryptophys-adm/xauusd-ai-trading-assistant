# RFC: 5m execution for Omega: the entry's timing and the position's management

Owner, 2026-11-11: "ya rancang A+C, timing dari broker langsung". 15m decides, 5m times the entry (A) and
manages the position (C), and the 5m bars come from the broker's MT5 terminal.

## Today

- The Decision Engine decides at each 15m close: the side, entry, stop, target and RRR.
- A market entry waits for a Prophet confirmation on its side (#255, `entryTriggerFor`): a verified 5m one
  or a 15m one.
- The 5m bars come from TradingView's 1m series, pulled at most every 5 minutes (quota). A 5m confirmation
  is therefore known up to about 5 minutes after its bar closed, nearly a whole bar late.
- Omega manages a position with break-even (`trailing_stop_r`), the extended target and the TP1
  scale-out. It does not trail, and nothing on 5m closes a position.

## Design

### 1. The broker's 5m trigger (pull adapter, every minute)

- **Bars.** The broker's M5 bars are aggregated from the Corpus Oracle's M1 (`corpusBars`). They are cached
  in KV and extended with the new minutes only, as the 15m shadow lane does (#263).
- **Engine.** The same 5m producer (`buildM5LocalCalculations`, Prophet R38) runs with the broker's M5 in
  place of TradingView's; the other series are unchanged. It needs 400 broker M5 bars, about 33 trading
  hours of corpus.
- **Output.** For the last closed broker 5m bar: `buy_confirmed`, `sell_confirmed`, the swing high and low
  of the last 3 bars, and the 5m ATR(14).
- **Hand-off.** The output goes to the AI Worker (`LocalComputationIngress.submitBrokerTrigger`), which
  stores it in KV `trigger:broker:m5:latest` for 15 minutes.
- **Latency.** The bridge carries each closed broker minute within seconds, and the cron runs every minute.
  A 5m confirmation is therefore known within about 70 seconds of its close, not up to 5 minutes.

### 2. The entry's timing (A)

- **Source.** `entryTriggerFor` reads the broker 5m trigger first (`trigger_source: "broker_5m"`). While
  it has fewer than 400 bars, or is older than 6 minutes, the TradingView 5m trigger stands in as today.
- **Window.** The confirmation must be on one of the 3 broker 5m bars after the decision's close. After
  that the signal expires (`awaiting_expires_ms`), as it does today at the next 15m close.
- **Scope.** A limit at the key level (`ENTER_LIMIT`) needs no trigger, as today.

### 3. The stop, tightened at the entry (A)

The 5m stop (`stop_5m`) is a separate signal field; the plan's `stop` is unchanged. For a BUY (mirrored for
a SELL):
- `stop_5m` = the swing low of the last 3 broker 5m bars, minus a buffer. The buffer is the larger of
  twice the spread and 0.1 × the 5m ATR.
- `stop_5m` is never wider than the plan's stop.
- The stop distance is never below the larger of 0.5 × the 5m ATR and the broker's stop level plus three
  spreads. Below that, the plan's stop is used.
- **Size.** Omega sizes `risk_pct` at its stop, so a tighter stop means a larger lot. The lot is capped at
  1.5 × the lot at the plan's stop (new setting `tight_stop_max_lot_factor`, 1 to 2, default 1.5). The
  money at risk stays within `risk_pct`.
- **Target and RRR.** The target stays the plan's TP1, so the RRR rises.
- **Who uses it.** Omega only. The EA keeps reading `stop`; it and Omega never run on the same account.

### 4. Managing the position on 5m (C)

These run in `manageIntents` on each bridge sync, for Omega's own positions only (`isOmegaOwned`).
- **Trailing from 1R.** Once a position is 1R in profit (on its initial risk), its stop follows the 5m
  structure: for a BUY, the swing low of the last 3 broker 5m bars minus the buffer. It only ratchets in
  the position's favour, at most once per 5m bar (`ms:<ticket>:t5:<bar>`). Break-even and the TP1
  scale-out stay as they are.
- **Exit on an opposite confirmation.** A verified broker 5m Prophet confirmation against the position
  closes it (reason `opposite_5m`), but only when the position is at least 0.5R in profit. Below that the
  stop decides, which avoids exits on noise.
- **Data.** The plan reads the broker 5m trigger and structure from the KV record above. No price leaves
  for the kernel or Aether.

### 5. Doctrine and measurement

- **Doctrine.** The fact `decision.execution_trigger` changes from `prophet_candle_for_market_orders`
  (TradingView 5m or 15m) to `prophet_candle_for_market_orders_broker_5m`. The Aether canon is amended
  by PR, as with #255 and aether#17.
- **Measurement.** The broker 5m trigger is not parity-verified: its bars differ from OANDA's by the
  basis. The broker shadow lane (#263) is extended to 5m, so the agreement of the broker's 5m
  confirmations with TradingView's is measured on `GET /api/corpus/status`.
- **Records.** Every Omega intent records which trigger and which stop it used: `broker_5m` or `tv_5m`,
  and `stop_5m` or `plan`. Outcomes can then be compared by source.

### 6. Switch

`OMEGA_EXEC_5M` controls the three parts (timing, tighter stop, management):
- `off`: today's behaviour.
- `shadow`: compute and log what each part would do, and change no intent.
- `on`: active.

## Trade-offs

| | Gain | Cost or risk |
|---|---|---|
| Broker timing | A trigger within about 70 s instead of up to 5 min; on the execution price's scale; no TradingView quota | Not parity-verified (measured by the shadow lane); needs the VPS, the terminal and the bridge up, else falls back to TradingView's 5m |
| 3-bar window | Enters on confirmed momentum | Fewer trades: setups without a 5m confirmation expire |
| Tighter stop | Higher RRR; the stop sits at real 5m structure | More stop-outs from noise; a larger lot (capped at 1.5×) |
| Trailing from 1R | Locks in profit on runners | Can exit before TP1 on a deep 5m pullback |
| Exit on an opposite 5m confirmation | Leaves a reversal early | Gives up some winners that would have recovered (only from 0.5R) |

## Rollout

1. **Before the code:** the broker corpus holds 400 M5 bars (about 1.5 days after 2026-11-11 14:16 UTC).
2. **Timing on, tighter stop and management in shadow** for at least 30 Omega trades. The records then
   compare the shadow stop and trailing against what happened.
3. **All on** with the owner's go. Omega's policy rollback (B-12) still watches the profit factor.

## Decisions for the owner

1. The window: 3 broker 5m bars (the default above), or fewer.
2. Whether `tight_stop_max_lot_factor` 1.5 is acceptable, or 1.0 (same lot, a tighter stop only lowers
   the risk).
3. The rollout: as above (the stop and management in shadow first), or everything on at once.
