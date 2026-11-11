# RFC: Corpus Oracle, the broker feed for the local lane

Owner, 2026-11-11: "Persiapkan engine baru bernama corpus oracle yang akan melakukan feeding data ke
local lane dari live mt5 terminal sesuai dengan broker, pair dan user active dari omega."

## Why

The local lane computes MizanLib, Prophet and GMI from TradingView's `OANDA:XAUUSD` bars. Omega
executes on the owner's broker, which quotes its own price. Levels planned on one feed are traded on
another. Omega converts them to distances from the broker's price, and the offset between the two
feeds and its stability are not measured anywhere. The Corpus Oracle brings the broker's own bars in,
from exactly the terminal, broker, symbol and user that Omega trades with.

## Phase 1 (this PR): the corpus, `CORPUS_ORACLE_MODE = "off"` by default

1. **Terminal.** `ea/mt5/OmegaExecutor.mq5` (`CorpusOracleEnabled`, `CorpusBars` = 120) writes
   `omega/corpus.json` once per closed M1 bar.
   - The file holds the server name, the symbol the executor trades, and the last closed M1 bars,
     oldest first: `[t_ms UTC, open, high, low, close, tick_volume, spread]`.
   - Broker server time is converted to UTC by the server's offset (whole quarter hours).
   - The file never holds a login or an account number.
2. **Bridge.** `bridge/omega-bridge` reads the bars after the server's cursor (`readCorpus`). It sends
   them as `corpus` with each sync: outbound only, the same Access service token, the same 64 KiB
   bound. The corpus is cut first when the body is too large.
3. **Omega Worker.** It forwards `corpus` to `OmegaGateway.bridgeSync`.
4. **AI Worker.** `src/corpus-oracle.mjs`, `ingestCorpus`, keeps a bar only from Omega's active user:
   - **broker:** the terminal's server equals the server of Omega's stored connection, and the
     executor's own server;
   - **pair:** the symbol equals the symbol the executor reports;
   - **user:** Omega's connection is stored. Its version is recorded with every bar.

   It also refuses open, unaligned, out-of-order, future or malformed bars, and counts each one.
   Kept bars go to D1 `corpus_bars` (14 days of M1, once per minute and source
   `mt5:<server>:<SYMBOL>`) and `corpus_sources`. The answer carries `corpus_cursor_ms`, so the
   bridge sends only newer bars.
5. **Measure.** `GET /api/corpus/status` gives:
   - per source: the last bar's age, the bars and missing minutes of the last 24 hours, and the
     complete 15m bars;
   - **the basis** against the TradingView 15m series the local lane reads: the mean offset (broker
     minus TradingView), its spread, the largest offset, and the correlation of bar-to-bar returns.
6. **What it feeds.** Nothing. Phase 1 reads the corpus for no room, decision, plan or signal
   (`feeds_local_lane: false`). No broker price leaves this Worker for the kernel or Aether.

## Phase 2 (a reviewed PR, after phase 1 has run in shadow)

- **Engines on broker bars.** The pull adapter reads the broker corpus (a read RPC on the AI Worker,
  or the corpus moved to the pull adapter's own store). It computes the local engines on the
  broker's M1, aggregated to M5, M15 and H1, as separate shadow identities (`mt5:<server>`).
- **Parity.** The parity registry compares them with TradingView like every identity. Per the
  doctrine `parity_trust_only`, a broker identity enters the decision lane only by earning parity.
  Basis-adjusted comparisons are proposed in that PR.
- **Plans.** Omega's plan could then read levels on the broker's own scale instead of distances
  from the TradingView price.

## Phase 2 as built (2026-11-11, owner: "All", the deferred plans)

- **Shadow lane, no identity.** At each 15m close the TradingView lane publishes, the pull adapter runs
  the same 15m producer once more on the broker's M15 bars. Those bars are aggregated from the corpus' M1
  through `corpusBars`, cached in KV `market-data:v2:broker-shadow:m15`, and extended with the new minutes
  only. Every other series stays TradingView's (`market-data-ingestion/src/broker-shadow.mjs`).
- **Agreement, not parity.** The two records' comparable fields are compared field by field. Only the
  agreement goes to the AI Worker (`LocalComputationIngress.recordBrokerShadow`, D1 `broker_shadow`,
  30 days): fields, fields that match, the fields that differ, and whether the direction agrees.
  - A broker identity cannot earn TradingView's parity, because its input bars differ by the basis.
    The lane therefore registers no identity and feeds no parity, room, decision or signal.
- **Measured** on `GET /api/corpus/status` under `shadow`: per engine over 7 days, the bars, the field
  and direction agreement, and the fields that differ most. It needs 400 broker M15 bars, about 4 trading
  days of corpus.
- **Skipped while the MT5 fallback runs**, since both lanes would then read the broker's bars.
- **Switch:** `BROKER_SHADOW_MODE` on the pull adapter, `on` (default) or `off`.
- **What comes next is the owner's decision:** a basis-adjusted comparison, and whether a broker lane may
  ever feed Omega's plans.

## Switches

- `CORPUS_ORACLE_MODE` (AI Worker): `off`, the default, which ignores the corpus; or `shadow`, which
  keeps and measures it.
- `CorpusOracleEnabled` (OmegaExecutor input): stops the file.
