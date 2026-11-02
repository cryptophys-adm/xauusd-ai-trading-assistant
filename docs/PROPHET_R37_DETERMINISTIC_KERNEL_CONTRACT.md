# Prophet R37 deterministic parity kernel — contract v1

Status: **source-derived specification and kernel scaffold; NOT TradingView parity**.

## Source of truth and scope

- GMI caller: `pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt` (owner-designated installed source; Git blob `808b6ca42c1fdee41bd40454cd6bcca36839f3e5`).
- Called structure export in current repository: `pinescript/ssot/CryptophysMizanLib-uploaded.txt`, `prophet_structure_core`, lines 856–971.
- The GMI caller imports `cryptophys/CryptophysMizanLib/4`; the checked-in Mizan artifact declares library title v1.6. Its raw-library hash recovered from the Library is `6c44d6bf2dbf7df525e2060cd166daf4b896c7d257ceb66fd787f4017880ceb3`, but that is not proof that this checked-in uploaded source is the published TradingView /4 implementation. The implementation below is pinned to the checked-in function body and must retain that dependency caveat.
- This first slice covers only the shared Prophet structure state machine called by GMI. It does not implement the Prophet oscillator tensor, full Prophet entry/trade-management logic, volume profile, footprint/CVD, GMI decision overrides, or full GMI verdict. It must not be labelled full GMI parity.

## Exact call contract from GMI

```pine
lib.prophet_structure_core(
  pro_fast, high, low, open, close, pro_anom, has_volume, atr_val,
  false, 50, 5, 2, 0.10, 1.5
)
```

Parameters are oscillator; OHLC; volume ratio; volume-availability flag; ATR; legacy mode; state max age; pivot left/right; body floor ATR; wick/body ratio.

Returned tuple, in order:

1. `d_enc`
2. `b_enc`
3. structure state bar
4. bullish structure event bar
5. bearish structure event bar
6. subtype code
7. oscillator pivot high
8. oscillator pivot low
9. bearish divergence event flag
10. bullish divergence event flag
11. bearish divergence origin bar
12. bearish divergence origin oscillator value
13. bullish divergence origin bar
14. bullish divergence origin oscillator value
15. last pivot-high price
16. last pivot-low price

Subtype mapping: 0 unresolved; 1 bull trap; 2 true breakout; 3 bear trap; 4 true breakdown.

## Deterministic state-machine rules (legacy=false)

All operations below execute once per chart bar, in Pine source order.

1. Persistent state begins with d/b = 0, pivot caches = na, structure/event bars = na, subtype = 0.
2. Compute oscillator pivot high/low with left=5/right=2. A pivot becomes observable on the current bar but its price/oscillator sample is from two bars earlier. Compute zero-cross events against the prior oscillator value.
3. If oscillator crosses either direction through zero, reset d=0 and b=1; clear subtype, structure bar, and both event bars.
4. When a pivot high confirms: if current pivot price exceeds previous pivot-high price, oscillator pivot is lower than previous pivot-high oscillator, and oscillator pivot > 0, set d=-1,b=2, emit bearish-divergence event, retain previous pivot index/value as origin, set bearish event bar to current bar, clear bullish event bar. Then update pivot-high cache unconditionally.
5. When a pivot low confirms: if current pivot price is lower than previous pivot-low price, oscillator pivot is higher than previous pivot-low oscillator, and oscillator pivot < 0, set d=1,b=2, emit bullish-divergence event, retain previous pivot index/value as origin, set bullish event bar to current bar, clear bearish event bar. Then update pivot-low cache unconditionally.
6. Compute body=abs(close-open), lower wick=min(open,close)-low, upper wick=high-max(open,close), effective body=max(body,ATR*0.10). Rejection if wick > effective body*1.5. real_volume = has_volume && volume_ratio>1.
7. If d=-1 and close > cached pivot-high price: a top rejection or (volume exists and real_volume is false) sets d=3,b=-4, subtype=1, bearish event=current bar, clears bullish event; otherwise d=-3,b=3, subtype=2, bullish event=current bar, clears bearish event. Set structure bar=current bar. If no break but close < prior low and close < open, set b=-3, bearish event=current bar, clear bullish event.
8. If d=1 and close < cached pivot-low price: a bottom rejection or (volume exists and real_volume is false) sets d=-3,b=3, subtype=3, bullish event=current bar, clears bearish event; otherwise d=3,b=-4, subtype=4, bearish event=current bar, clears bullish event. Set structure bar=current bar. If no break but close > prior high and close > open, set b=3, bullish event=current bar, clear bearish event.
9. Expire confirmed structure only when d is 3 or -3, structure bar is valid, and current bar minus structure bar > 50. Expiration sets d=0,b=1, subtype=0 and clears structure/event bars.

Important Pine semantics:
- `na` is a first-class missing value. Comparisons involving `na` do not evaluate true; do not coerce missing pivots to zero.
- Pivot functions require exact left/right window semantics and enough history; pivot confirmation must not be shifted one bar.
- `bar_index` is chart-relative. A local replay must use an identical starting index or compare relative ages/origin offsets.
- The export is stateful. Replaying isolated bars without prior state/history is not equivalent.
- `has_volume=false` is not the same as volume ratio zero: in non-legacy mode, missing volume does not itself trigger the "not real volume" veto.
- Pine execution and series history must use confirmed closed candles for the webhook parity contract.

## Kernel API

Input: ordered candles with explicit monotonically increasing `bar_index`, oscillator (`pro_fast`), volume ratio (`pro_anom`), volume availability, ATR and OHLC. The kernel returns the 16-field tuple above for every bar plus a state snapshot suitable for deterministic continuation.

The kernel is intentionally isolated from GMI. Its output is an intermediate dependency, not a GMI verdict.

## Required fixture vectors before parity claim

Capture directly from the owner-designated installed TradingView GMI on closed bars, retaining the exact symbol, timeframe, exchange/feed, chart session, source revision/import versions, input settings, bar timestamps, and at least the full warm-up history:

- first valid pivot high/low and no-prior-pivot cases;
- bearish and bullish divergence detection and origin indices/values;
- zero-cross reset;
- breakout, breakdown, bull-trap and bear-trap paths;
- no-volume versus low-volume distinctions;
- rejection wick threshold just below/equal/above;
- state expiry at age 50 and 51;
- simultaneous pivot/zero-cross ordering;
- missing ATR / first bars and MTF boundaries;
- replay continuation across chunk boundaries.

Each fixture must contain the complete input history and all 16 TradingView output fields for each tested bar. Unit tests against the translated rules are conformance tests to this transcription only; they are not TV parity without those captured outputs.

## Current blockers (must remain explicit)

1. Confirm the checked-in Mizan function body matches the published library revision imported by GMI. Source text currently declares v1.6 despite the GMI import suffix /4.
2. Capture TradingView output fixtures. None are available in this PR at time of this contract.
3. Implement and independently validate `prophet_volume_ratio`, `vol_anomaly`, `f_vol_cycle`, `efficiency_ratio`, and `calculate_prophet_tensor` before claiming the oscillator input is reproduced. GMI currently computes `pro_anom` differently on confirmed versus realtime bars; closed-bar fixture scope uses the confirmed branch.
4. Trace exact VP/footprint/session/OB/FVG/Fabio/kinematic dependencies before attempting a GMI verdict kernel.
5. Do not populate `LOCAL_CALC_PROVENANCE_ALLOWLIST`, claim parity, or promote production based on this kernel alone.

## Secret transport finding

The Pine webhook constructs JSON by string concatenation and inserts `cta_webhook_secret` without JSON escaping. The receiver must validate a documented safe character set (or Pine producer must be changed with approval and retested). Never log the secret.
