# Source-Derived Local Engine Caller Contracts

Status: **input/history contract clarified; calculations remain blocked from trusted evidence**.
Source snapshot: repository base commit 6103324bf41f8bf7c57ccf83bc52f6be69828a12; market-data input contract is maintained on PR #21.

## 1. Authority and identity

| Artifact | Repository path | Source-declared identity | Mizan import | Trust status |
|---|---|---|---|---|
| Shared library SSOT | pinescript/ssot/CryptophysMizanLib-uploaded.txt | CryptophysMizanLib, header comment says v1.6 | N/A | Owner-designated uploaded source, but installed/published library revision is not proven to match |
| Prophet caller | pinescript/ssot/The-Prophet-v7.02-R38.txt | The Prophet v7.02 R38 | cryptophys/CryptophysMizanLib/4 | Source identified; no feature-level parity fixtures |
| GMI caller | pinescript/ssot/Global-Multiverse-Interceptor-v12.70.txt | Global Multiverse Interceptor v12.70 SSOT | cryptophys/CryptophysMizanLib/4 | Source identified; source header notes static transformation, TradingView compilation/replay/regression not verified |

Do not infer the published /4 library body from the filename of the uploaded SSOT. The source file is a library artifact; the /4 dependency must be matched to the actually installed/published TradingView library before its outputs can be trusted.

## 2. Caller-derived history floor

The numbers below are minimum warm-up requirements for the named call sites, not a promise that a short OHLCV bundle reproduces every library feature.

### Prophet R38

- Chart timeframe: lib.hurst_rs(close, 100) checks bar_index < len, so a full 100-return window needs at least 101 close observations.
- Chart timeframe: lib.kww_zscore(close, 50); the oscillator uses cycle lengths 13/34/55 and volume-ratio/anomaly lookbacks of 20.
- Default HTF alignment: request.security(..., lib.kww_zscore(close, 50)[1], lookahead_on) means the latest value is based on a prior completed HTF bar; the conservative minimum is 51 closed bars on each configured HTF.
- The configured default alignment set in the ingestion contract is M15/H1/H4/D1/W1. If runtime input settings differ, the engine must emit the effective timeframe configuration and recalculate readiness from that configuration.

### GMI v12.70

- M5 profile: source uses a 300-bar profile/lookback input; 300 M5 bars is only the minimum window, not enough to reproduce all extended-session profile state.
- MTF: f_mtf_data() calls KWW z-score and entropy/Hurst calculations with length 50 on configurable TFs. The contract uses 51 bars as a conservative closed-bar floor.
- Daily CPR: lib.daily_cpr_stats(high, low, close) is requested from daily data and the source compares CPR width with a 20-day mean; at least 21 completed daily observations are required for the current value plus 20-day reference window.
- Weekly calculations use the previous completed weekly candle. A live weekly candle must not be substituted for a closed weekly input.

### MizanLib as a shared dependency

MizanLib does not have one standalone signal-history requirement. The market-data envelope therefore uses the union of the known Prophet R38/GMI caller floors: M5=300, M15/H1/H4/D1/W1=51. This is explicitly a **minimum caller warm-up floor**, not universal sufficiency for all exports, all input settings, profile state, or every indicator that imports the library. Any additional caller or longer lookback must extend this contract before readiness can pass.

## 3. GMI inputs unavailable in the current candle bundle

| Input / source call | Current status | Feature consequence |
|---|---|---|
| Lower-timeframe time/open/high/low/close/volume arrays from request.security_lower_tf | Not in bundle; M5 OHLCV does not reconstruct M1 intrabars | Footprint inference and intrabar-updated external profile features cannot be reproduced |
| TVC:DXY H4 series | Not in bundle | Macro kinematics/penalty is unavailable; do not substitute XAU or a constant |
| CRYPTOCAP:USDT H4 series | Not in bundle | USDT macro context is unavailable; do not substitute XAU or a constant |
| TVC:USOIL chart-timeframe series | Not in bundle | Oil RSI context is unavailable; do not default a missing value to a bullish/bearish signal |
| TradingView-compatible footprint/order-flow semantics | Not established by ordinary OHLCV | Buy/sell volume and footprint-dependent outputs must be marked unsupported |
| Exact installed MizanLib /4 source body | Not proven equal to checked-in uploaded library SSOT | Shared-core outputs cannot be called version-identical |

The Worker must return structured unavailable-input records for these dependencies. It must not fabricate candles, volume, macro series, or intrabars. A feature that requires one of these inputs must be reported as unavailable or unsupported, not silently computed with fallback values.

## 4. Local engine implementation status

- **Mizan:** source-derived shared-library caller history floor is defined. No general Mizan signal engine or approved installed-source identity is claimed.
- **Prophet:** the checked-in R38 source is 1,150 lines. The prior R37 shared-core kernel is not the full R38 calculation engine; R38 is not marked implemented.
- **GMI:** full engine remains blocked on external series, intrabars, footprint/order-flow semantics, and source fixtures. OHLC-only partial features may be implemented separately only when clearly scoped and independently fixture-tested.
- All three engines remain parity_status=not_proven and calculation_allowed_for_trusted_evidence=false.

## 5. Required closed-candle TradingView fixtures

Fixture files must be captured from the exact installed indicator/library revision, with no invented values. Each fixture record should include:

- indicator/source name, source revision, published MizanLib import version, and SHA-256 of the checked-in source artifact;
- symbol and timeframe, bar open/close UTC timestamps, whether the candle is confirmed, and effective indicator inputs;
- OHLCV plus all required external-series/intrabar inputs and explicit missing-data markers;
- expected values from TradingView Data Window / alert output for each claimed feature;
- expected warm-up behavior, na/missing-input behavior, and timeframe-boundary behavior.

Parity acceptance must compare every claimed output across multiple closed bars and boundary/missing-input cases. It must report absolute/relative tolerances where floating-point equality is not exact. A successful compile, a synthetic unit fixture, or matching one signal is not parity evidence. Until genuine fixtures exist and pass, all local outputs remain excluded from trusted evidence.