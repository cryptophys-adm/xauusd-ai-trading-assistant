# SSOT — XAUUSD AI Trading Assistant (canonical, current state)

This is the single source of truth for the system's topology, ownership and deployment. If any other document disagrees with this one, this one wins and the other document is historical. Last reconciled: 2026-11-07. Change log: docs/CHANGELOG.md.

## 1. Production topology: exactly five Workers
| Worker | Source | Deployed by (only on push to `main`) | Role |
|---|---|---|---|
| `xauusd-ai-trading-assistant` | `src/`, `wrangler.jsonc` | `deploy-worker.yml` | Webhooks, evidence fusion, autonomous parity registry, the H1 decision (the Reasoner, after the 1H War Room's Consensus Discussion), the dashboard read API (`/api/*`) and Telegram |
| `xauusd-fundamental-news-ingestion` | `fundamental-news-ingestion/` | `deploy-fundamental-news-ingestion.yml` (Workers Builds also builds it) | Owns the single TradingView MCP OAuth grant at `news.cryptophys.work/oauth/start`. Serves news (`/pull`, cron `:05`, RPC `NewsIngestionService`) and OHLCV (RPC `TvGateway`) |
| `xauusd-tradingview-pull-adapter` | `market-data-ingestion/`, `local-engines/` | `deploy-market-data-ingestion.yml` | The only owner of local computation for MizanLib, Prophet and GMI (see §3). Serves chart data (RPC `MarketDataReader`) |
| `xauusd-nexus-dashboard` | `workers/xauusd-nexus-dashboard/` | `deploy-nexus-dashboard.yml` | `nexus.cryptophys.work` serves the UI. `/api/ohlcv` comes from `MarketDataReader` and `/api/aether/overview` from Aether's `AetherReader` (the Aether page at `/aether`); `/omega/*` is forwarded to `xauusd-omega` (`OMEGA_PAGE`); every other `/api/*` request is proxied to the AI Worker |
| `xauusd-omega` | `workers/xauusd-omega/` | `deploy-omega.yml` | `omega.cryptophys.work` and `nexus.cryptophys.work/omega`, the Omega Execution Engine (owner decisions 2026-11-09): shows the MT5 EA and sets its control (active, paused, killed); runs the broker engine's settings and connection and the bridge sync (see "Omega broker engine"), all through the AI Worker's `OmegaGateway` RPC entrypoint; verifies the Access JWT itself |

Removed on 2026-11-04 and **never to be redeployed**:
- `xauusd-mizan-engine`, `xauusd-prophet-engine` and `xauusd-gmi-engine`: stubs that reported `production_ready: true` without computing anything.
- `xauusd-market-data-normalizer` and `xauusd-pull-orchestrator`.
- `xauusd-confluence-controller`: its `/v1/fuse` endpoint was unauthenticated and signed whatever "verified" evidence the caller sent.

The earlier "8 + 1 Workers" plan in older documents is **cancelled**.

`test/ssot-topology.test.mjs` fails if a Wrangler config in this repository declares any other Worker name.

**Public surface (owner, 2026-11-07).** The AI Worker and Nexus have no `workers.dev` address and no preview URL (`workers_dev: false`, `preview_urls: false`):
- **AI Worker:** reached only at `ai.cryptophys.work`. `POST /webhook` is public and protected by `WEBHOOK_SECRET`; `/api/*` sits behind Cloudflare Access. That is the path destination `ai.cryptophys.work/api/*` of the platform's one Access application, managed by platform `provision-access.yml` (owner option (a), 2026-11-08); never edit it in the dashboard. `/health` and `/ready` stay public. Other Workers reach it through Service Bindings.
- **Nexus:** reached only at `nexus.cryptophys.work`, behind Cloudflare Access.
- **Checks:** the deploy smoke tests check the Access lock with the CI service token (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`). The topology test guards both settings.

## 2. Inter-Worker calls (RPC Service Bindings, no shared secrets)
- The AI Worker calls `NEWS_INGESTION` → news Worker `NewsIngestionService.pull()`.
- The pull adapter calls:
  - `TV_GATEWAY` → news Worker `TvGateway.ohlcv()`;
  - `AI_WORKER` → AI Worker `LocalComputationIngress.submit()`.
- The dashboard calls:
  - `MARKET_DATA` → pull adapter `MarketDataReader.candles()`;
  - `AI_WORKER` → the AI Worker's default `fetch` for its read-only `GET /api/*` (owner go 2026-11-07). It replaced a public fetch of `https://ai.cryptophys.work`, so the AI Worker's `/api` can sit behind Cloudflare Access while Nexus keeps working. Only GET and HEAD are forwarded.
  - `OMEGA_PAGE` → the `xauusd-omega` Worker's default `fetch` (owner decision 2026-11-09: "halaman omega masih di nexus.cryptophys.work/omega"). `/omega` and `/omega/*` are forwarded unchanged (method, headers with the Access JWT, body); Omega verifies the JWT itself.
- Omega calls `OMEGA` → the AI Worker's `OmegaGateway` (its only data path).
- The AI Worker calls `AGENTS` → Cryptophys Platform `cryptophys-ai-kernel` `AgentRpc` (owner approval 2026-11-05, RFC_INDICATOR_AGENT_PLATFORM P4). This is the only binding to a Worker outside this repository, and it adds no Worker to the topology above.
  - **Identity:** the binding pins `props.host_worker = "xauusd-ai-trading-assistant"`, and there is no secret or token. The kernel lets this Worker act only as the 21 XAUUSD agents registered with that `host_worker` (platform migration 0016), each with `tier_max = 1`. No other Worker, and not the preview config, may carry this binding. `host_worker` never takes another value. `test/ssot-topology.test.mjs` guards both rules.
  - **What is sent** (`src/platform-reports.mjs`, in the parity sweep cron): one advisory report per meaningful event, never per tick.
    - `xauusd-reasoner` (`xauusd_digest`): every new H1 chain decision. A BUY↔SELL flip is `warning`.
    - `xauusd-moderator` (`xauusd_digest`): the War Room 15m conclusion when its stance changes, otherwise at most once an hour.
    - `hud-*` (`hud_digest`): a HUD agent's War Room stance when it moves into or out of BUY or SELL.
    - `xauusd-risk-manager` (`xauusd_digest`, `src/health-alerts.mjs`, owner decision 2026-11-06): system health alerts.
      - **Detected problems:** a revoked parity identity, an input bar that differs from TradingView, a missing local H1 record, a timeframe room without a conclusion 45 minutes after the close, 10+ calls lost to the Workers AI rate limit in an hour, a stale News Daily, a stale War Room 15m, and TradingView alerts rejected by POST /webhook in the last hour (`webhook_rejected`: the reason from D1 `webhook_rejections`, `src/webhook-rejections.mjs`; lengths only, never the secret).
      - **Subjects:** an engine is named canonically with its timeframe and registry id (`src/engine-names.mjs`, e.g. "GMI v12.70 15m (gmi_m15)"); a room by its name ("the 1H War Room").
      - **Reports:** a `warning` when an alert opens, and an `info` when a lasting alert resolves. At most 3 reports an hour.
      - **Where they live:** D1 `health_alerts` (migration 0009). Nexus shows them as its Priority Queue (`GET /api/health/alerts`).
      - An alert never changes a decision, a room or a parity status.
  - **Rules:**
    - Observations only: decision and confidence, never size, lots, levels or order wording.
    - `critical` is never sent, because the platform opens a GitHub issue for it.
    - A denial (rate limit, kill switch, suspension) or a kernel rejection is recorded and not retried. Only a transport failure is retried, once, by the next sweep.
    - Every failure is non-fatal: the chain runs whether the kernel is up or not.
  - **Cursors and status:** cursors live in D1 `platform_publications` (migration `0007`). `GET /api/platform/status` shows `whoami("xauusd-moderator")`, cached for 5 minutes, and the publications.
  - The platform reads this Worker only through `GET /api/decisions`, and it never writes here.
- The AI Worker calls `AETHER` → `cryptophys-aether` `KnowledgeIngress` (Aether, the Knowledge Guardian; RFC_AETHER_KNOWLEDGE_GUARDIAN phase A5, owner go 2026-11-07). It is the second binding to a Worker outside this repository, and it adds no Worker to the topology above.
  - **Identity:** no props, no secret or token. Aether accepts calls only through a Service Binding in this account. No other Worker, and not the preview config, may carry this binding. `test/ssot-topology.test.mjs` guards it.
  - **What is sent** (`src/aether-push.mjs`, once an hour in the first parity sweep after the H1 close): the decision cards of `src/decision-cards.mjs`.
    - Up to 12 cards of the 15m and 1H rooms, and up to 8 of the 4H and D1 rooms. These are the latest cards of each chart, which covers the 4-candle outcome horizon.
    - A card is sent again only when its content changes, for example when its outcomes are scored. D1 `aether_card_pushes` (migration `0012`) keeps the hash last sent.
    - A card that fails the local leak check (any level, price, plan or size) is never sent. Aether checks every card again and may refuse one; a refusal is recorded and that content is not sent again.
  - **Rules:**
    - Advisory only. A push never changes a room, a decision or a card, and the sweep never waits on Aether.
    - A transport failure is non-fatal and leaves the ledger untouched, so the next hour retries it.
    - Aether never writes here.
  - **The pull (phase A7):** once an hour the same binding also reads `learnedPack()`, the items a person approved for shadow testing. Approved parameter candidates run as shadow versions (see "Shadow indicator versions"); nothing from the pack reaches a room, a prompt or a decision.
  - **The Knowledge Council's facts** (owner 2026-11-11: "autonomous doctrine protocol harus dilakukan oleh knowledge council, dilakukan harian dan di propose ke cerebrum untuk eksekusinya"; `src/doctrine-facts.mjs`). In the same hourly sweep the binding sends `ingestDoctrineFacts` (`cryptophys.doctrine-facts.v1`): the Nexus seat (the Decision Engine's switch, cadence, witness weights, guardrails, trading mode and thresholds; the rooms' default quorum share and the 15m confidence cap; the weighting mode and its cadence; the EA blackout; parity and the lane) and the Omega seat (the Omega settings in force and its fixed gates), each tagged with the deployed version (`version_metadata` binding `CF_VERSION_METADATA`). Values only, read from the code, variables and stored settings; no price, level, size or account. Aether's council compares them with its canon doctrine (v2) once a day and proposes each difference measured twice from the same version to the Cerebrum consensus, which executes it (an operational fact inside its hard bound after the vote, anything else after one owner click). Nothing here changes a decision.
  - **Status:** `GET /api/aether/status` shows the push ledger per chart, the last 24 hours and the latest refusals, without card content, and the learned pack (`learned_pack`).

## 3. Three AI input lanes (local-primary)
Owner decision, 2026-11-05: the architecture does not depend on webhooks. Approved local records drive the chain, and TradingView webhooks only calibrate the local engines. `INDICATOR_SOURCE` controls this: `"local"` is the default; `"webhook"` restores the legacy webhook-driven chain as a rollback.

1. **Local computation** (decision lane). MizanLib (record id `mizan`), Prophet and GMI are computed by the pull adapter from closed TradingView bars.
   - Since 2026-11-05 (owner decision, TradingView MCP budget 800 calls a day), the pull adapter pulls XAUUSD M1, H1, H4, D1 and W1, USOIL 5m, and DXY and USDT 4h.
   - **Cadence (2026-11-08, quota, owner decision):** USOIL 5m (macro) is pulled once per 15 minutes, at the 15m close, with every bar (`cadence: 900`). The gold 1m chart stays every 5 minutes (`cadence: 300` since the cron runs every minute, 2026-11-09). The other series are pulled once per new closed bar. A weekday costs about 440 calls, plus 24 for the hourly news, against the 800 budget.
   - **Weekend (2026-11-08):** no pull for non-crypto series from Friday 17:30 to Sunday 18:00 New York time (`marketClosed`; Friday 22:30 to Sunday 23:00 UTC in winter, an hour earlier in summer), so a closed market spends no TradingView call. An empty series still bootstraps once, and USDT (crypto) is pulled every day. After the reopen, a series whose last pull after the gap brought no new bar waits a quarter of its bar (5 minutes to 1 hour) before the next pull (`gapBackoffSeconds`, 2026-11-09).
   - **Context series (2026-11-08, backlog 11.3).** The pull adapter also pulls `TVC:US10Y` and `OANDA:XAGUSD` 4h (role `context`) for the Nexus correlations panel.
     - **Cost.** About 12 calls a day. They are last in priority.
     - **Isolation.** They never enter the engine input bundle (`buildBundle` skips them), so local computation and parity are unchanged.
   - It aggregates XAUUSD M5 and M15 from M1, and USOIL M15 and H1 from USOIL 5m. A daily check compares them with native bars.
   - See docs/MARKET_DATA_INGESTION.md.
   - Trust is earned only through the autonomous parity registry: 24 consecutive candles that match TradingView. There is no manual allowlist and no operator approval.
   - The chain starts as soon as the parity-approved (`localcalc:`) records of a closed H1 candle exist. It does not wait for any webhook.
   - The indicator values the agents read (`source_payloads`, `origin: "local_computation"`) are the approved records' comparable fields. These are the same field names and codes the TradingView alerts carry.
   - A candle whose approved local records do not arrive within 30 minutes of the close is recorded as a fail-closed WAIT. A revoked or never-approved identity therefore never trades.
2. **TradingView webhook** (calibration only). The sources are `prophet_r38`, `prophet_r37_ssot` and `gmi_v12_70`, on H1 and 5m.
   - **Prophet is read as one indicator** (owner decision 2026-11-06).
     - Prophet R38 (the standalone indicator) and Prophet R37 (the core inside GMI, which sends `prophet_r37_ssot`) share one MizanLib structure core: their `d_enc` and subtype are identical in production.
     - Every reading therefore decodes them as a single "Prophet": R38's signal and trade management, R37's consensus direction and confirmation candle, and the shared structure once. This covers the TradingView reading of the H1 chain, the H1 bus, the timeframe desks and the Prophet HUD agent.
     - The Prophet HUD agent reads, in order:
       1. its signal (R38 confirmations);
       2. its direction, from the R37 consensus (GMI's `prophet_dir`, equal to the R37 alert's direction);
       3. its structure;
       4. its trade management;
       5. its setup (setup gate and cycles);
       6. its regime.
     - The signal, direction, structure and management lines are each verified by parity.
     - The direction is Prophet's bias.
     - The two alerts stay separate in TradingView for calibration, because the R37 alert proves that GMI's structure equals Prophet's.
   - Webhooks are stored and compared field by field with the local records. They never start the chain and are never decision evidence (`input_lanes.tradingview_webhook.role: "calibration_only"`).
   - Approval persists while no webhook arrives. A mismatch during a calibration run revokes the identity, and the chain then fails closed until it re-earns 24/24.
   - **Input mismatch** (owner decision 2026-11-06). When only the input bar differs (open, high, low, close or volume) and every indicator field agrees, the comparison is `input_mismatch`.
     - It neither counts nor revokes.
     - That candle's records stay out of the trusted lane, so the H1 chain reads the TradingView evidence for it.
     - The pull adapter rebuilds an H1 candle whose bar TradingView revised after publication. It cuts the bundle at that close and publishes once more (`republishRevisedH1`). The new comparison replaces the open one and counts.
     - `INPUT_MISMATCH_REVOKE_AFTER` (3) input mismatches in a row on different candles mean the data pipeline is wrong, so they revoke like a mismatch.
     - One-time reconciliation (owner approval 2026-11-06): `reclassifyOnce` reclassifies the earlier input-only mismatches and restores the identities they revoked (the H1 `prophet` and `gmi` revocations of 2026-11-06). It runs once per database, guarded by a KV marker.
   - **Calibration runbook (for example monthly).**
     1. Install the existing alerts on the H1 chart, and on the 5m chart for the 5m lane.
     2. Leave them on for at least a few candles.
     3. Check `GET /api/status` → `ai_worker.local_lane.calibration`. It shows the last calibration per identity and `calibration_due` after `CALIBRATION_INTERVAL_DAYS`, which defaults to 30.
     4. Remove the alerts again.
   - Any change to a hashed engine file creates a new identity. That identity needs a calibration run of 24/24 before it is trusted.
   - The per-event reconcile and the cron (`10-59/15 * * * *`) are idempotent, so a candle is counted at most once.
3. **Fundamental news**: TradingView MCP news. The AI Worker analyses it at cron `:06`.

Coverage per Pine parameter is in `docs/LOCAL_COMPUTATION_OWNERSHIP.md`.

The parity sweep cron also backfills `runAnalysis` for any closed H1 candle within the last 2 hours that has no `analysis_runs` row. It does so when the candle's local records exist (parity-approved or not, `decisionLocalRecords`; owner decision 2026-11-09), or as a fail-closed WAIT 30 minutes after the close. Analysis stays idempotent via `claimAnalysisRun`. A failed run is retried up to 4 attempts; a degraded run (required evidence missing, typically the hourly news landing a minute after the local publish) is retried within 45 minutes of the close, and the claim succeeds only when the evidence fingerprint changed.

### Economic releases, surprise and learned horizon (owner 2026-11-10, `src/econ-releases.mjs`, `src/calendar-agent.mjs`)
- **Source:** ForexFactory's weekly export gives the schedule, forecast and previous (`src/econ-calendar.mjs`); TradingView's economic calendar gives the actual, through the news-ingestion Worker (`NewsIngestionService.economicCalendar`, `TvGateway.economicCalendar`; the one TradingView OAuth grant and quota cooldown). Gold's 1H history for the reactions: `NewsIngestionService.goldHistory`, once a day, merged with the pull adapter's 1H series.
- **Stored:** D1 `econ_releases` (high-importance USD): actual, forecast, previous, surprise, surprise in standard deviations, the rule's effect on gold, and the reaction 1/2/4/8/24 hours after in 1H ATR. Live: the day of a High-impact USD event 2 minutes to 3 hours after it while its actual is missing; back-fill about 400 days, one 14-day window an hour.
- **Learned horizon per event kind:** the longest horizon with a hit rate of at least 55 % and a positive mean signed move (5 releases at least; the fixed 2 hours before to 4 hours after until then).
- **Readers:** the Calendar Agent's projection and bias (after a release with its value the bias follows the surprise by rule), the Macro War Room (release values, USDT dominance, a follow-up session 2 hours after the release), the Decision Engine (`context.market.calendar`, a caution when a surprise points against the trade inside its horizon) and Nexus (Calendar page, Decision Engine card). Context only: no price level, no order.

### Decision Engine: the single decision (owner decisions 2026-11-09, `src/decision-engine.mjs`)
- **Why:** two decisions were shown (the H1 decision of the 1H room and the deterministic Global decision of the strategy engine), and the Global decision had no model, so it was rigid. Owner: "seharusnya tidak ada dualisme decision regime … hanya ada 1 decision engine sebagai ssot", with every agent taking part, the timeframe rooms and the background and right-panel agents. Owner choices: **AI within guardrails**, **switch now**, **every 15m close**.
- **Tier 1, witnesses** (each from its own data, unchanged), weights `WITNESS_WEIGHTS`: D1 room 0.20, 4H room 0.20, 1H room 0.20 (its quorum is the H1 decision), 15m War Room 0.15, News Daily 0.10, Macro War Room 0.05, strategy engine 0.10 (multi-timeframe confluence, the Key Level Agent's zones, the 5m trigger, vetoes and cautions). A missing or stale witness drops out and the rest renormalise. Context, not weighted: the event gate (economic calendar), the 1H market regime, the cross-asset correlations, the 1H decision and the previous decision.
- **Extended witnesses (B-11, `GLOBAL_DECISION_WEIGHTED`, on since 2026-11-10), each independent of the strategy engine and the rooms (`independentWitnesses`):** key levels 0.05 (price against the Key Level Agent's zones), regime 0.05 (20-bar 1H direction x efficiency, scaled by Hurst; 0 in chaos), cross-timeframe trend 0.05 (price against its 20-bar mean in 2 ATR on D1/4H/1H), macro drivers 0.03 (DXY 24-hour change and US 10-year daily change), session 0.02 (`EXTENDED_WITNESS_WEIGHTS`; reconciled with the code 2026-11-11). While on, every witness takes its B-11 weight (D1/4H/1H 0.16, 15m 0.12, News 0.08, Macro 0.04, strategy 0.08; sum 1).
- **Tier 2, the AI Decision Council:** one call of the moderator model (`MODERATOR_MODEL`, fallback `MODERATOR_FALLBACK_MODEL`; 90 s deadline; one plain-language correction). It is the only reader across the timeframes. It chooses the stance (BUY, SELL, WAIT), the bias, the confidence, a market entry or a limit at the planned pullback, the target (TP1 or TP2), the summary, reasons and risks.
- **Guardrails** (deterministic; the council cannot break them). A BUY or SELL needs for its side: **market open** (Sunday 22:00 to Friday 22:00 UTC), **fresh** (the 15m and 1H rooms are current), **quorum** (more than the mode's share of the witnesses' weight leans that way, or a lean of at least the mode's `lean` with more weight than the other side), **confirmation** (the 15m or the 1H room decided that side under its confirmation rule, or a verified 5m or 15m Prophet confirmation; a 5m confirmation is verified while the 5m Prophet implementation `prophet_m5` is parity-approved, `verifiedM5Confirmation`), **no veto** (the strategy engine's vetoes for that side), **levels** (a plan from the Key Level Agent's zones, `planForDirection`: never a model price), **reward** (at least the mode's R to the chosen target) and **confidence** (at least 0.40). **Trading modes** (`TRADING_MODE`, else the Nexus selector in KV `trading:mode`, default intraday; `MODE_THRESHOLDS`): scalp quorum 45 %, lean 0.10, 1.2R; intraday 50 %, 0.15, 1.5R; swing 60 %, 0.20, 2.0R (swing also vetoes a composite sentiment of -0.6 or worse against the trade). The chosen target honours the mode's R (`tradeFor` `minRrr`, audit fix 2026-11-11: scalp's 1.2R trade had been turned into WAIT by a fixed 1.5R). A market entry only when price is at the level. A council BUY or SELL that breaks one becomes WAIT and the record keeps `overruled`. A high-impact USD event stays a caution (owner decision 2026-11-08); the EA does not enter in its blackout.
- **Market context** (owner 2026-11-09, `marketContextOf`): the right panel's cards go to the council in `context.market` and stay in the record: the market sentiment (weighted lean, news and macro composite, headlines), the regime of the 15m and 1H charts (radar sensors, chaos, stretch, bar regime label), the macro drivers (24-hour gold, dollar, oil, USDT dominance; gold-dollar link; correlations) and the session (day, date, market open or closed, active sessions and liquidity, next close or open). They give cautions (thin liquidity, the weekend close within 2 hours, a 2.5 sigma 1H stretch with the trade, a chaotic 15m regime, a 0.3 % dollar move against the trade), never a block; only a closed market blocks.
- **Fallback:** when the model fails or its answer is invalid, the strategy engine's decision stands if its side passes every guardrail, otherwise WAIT (`source: "fallback"`).
- **Missed rooms:** when a 15m room never started (no 5m context reached the queue), the sweep runs it at least 4 minutes after the close from the cached closed 5m series (`runMissedWarRoom`, `m5ContextFromSeries`; no Prophet 5m confirmation from bare bars), then the Decision Engine decides.
- **When:** right after the 15m War Room of the bar concludes (queue `live_room`, statuses complete or already_complete), so about 1 to 2 minutes after the close; the sweep (:10, :25, :40, :55) decides a bar the room did not trigger (`runPendingDecision`, from 4 minutes after the close; not while the market is closed). Once per bar (D1 `engine_decisions`, key `OANDA:XAUUSD:15:<open ms>`; KV `decision-engine:latest`, 2 days).
- **It feeds everything:** the MT5 EA (`GET /api/ea/signal`: `signal_id` is the 15m key, `tp1` the chosen target, `issued_ms` the 15m close, `expires_ms` the next 15m close, `source: "decision_engine"`), Telegram (a new stance only; `DECISION_TELEGRAM_MODE = "all"` sends every BUY or SELL bar), the Signal Ledger (source `decision`, one open per side; its entry and exit alerts) and Nexus (the "Decision Engine" card, from `GET /api/conclusion/global` → `engine`; also `GET /api/engine/decision` and `/api/engine/decisions`).
- **While it is on:** no H1 decision message on Telegram, no new `h1_decision` or `strategy` ledger rows and no strategy evaluation at each 5m close (the H1 decision and the strategy are witnesses). The rooms, the H1 decision record and the strategy engine are unchanged.
- **Kill switch:** `DECISION_ENGINE = "off"` restores the H1 decision for the EA, Telegram and the ledger (an owner PR changing the variable).
- No position size; prices only from the key-level plan; the server places no order.

### H1 decision by Consensus Discussion (owner decision 2026-11-07, `src/h1-consensus.mjs`)
- **Why:** the old chain decided at the close, before any discussion: Analyst → Counselor → Reasoner on the evidence alone. The Analyst and the Counselor ran only in the background (no screen showed their output), and in production the Counselor spent its whole token budget on reasoning in 32 of the last 32 runs. Deciding first made the decision ambiguous and almost always WAIT.
- **Now every input comes from the 1H communication bus, and the Reasoner decides last:**
  1. At the close, `runAnalysis` fuses the evidence as before. Degraded evidence (in quorum mode: only a missing or stale closed candle) is still a fail-closed WAIT at once. Complete evidence is parked in KV (`h1:pending:<candle_key>`, 6 hours) and no model runs. The run stays `analyzing`, at the stage `awaiting_consensus` in `analysis_runs.error_code` (the status column has a CHECK constraint).
  2. The 1H War Room of the bar meets: communication bus, Consensus Discussion, the moderator's conclusion with its decision and bias.
  3. The Reasoner (`AI_MODEL_REASONER`) writes the H1 decision when the room concludes (the sweep's `onRoom` hook), or 45 minutes after the close at the latest with whoever spoke (owner choice; `H1_CONSENSUS_FALLBACK_MS`, from the sweep). It reads the room (`CONSENSUS`: bus, Consensus Discussion, conclusion) beside the parked evidence.
- **The H1 decision is the room's quorum (owner decision 2026-11-09: "H1 Decision harus independen … murni dari konsensus agent"; "H1 Decision adalah kuorum"):**
  - Independent of the TradingView webhooks, of parity approval and of any single indicator signal. The webhooks will be removed; parity sampling only labels the evidence.
  - **Quorum** (`quorumOf` in `src/h1-consensus.mjs`, `quorumAllows` in `src/reputation.mjs`, `QUORUM_SHARE` 0.5): BUY or SELL only when the moderator concluded BUY or SELL AND more than half of the weight of the agents who spoke holds the matching bias (BULLISH for a BUY, BEARISH for a SELL). Each agent's weight is its 30-day track record in the room (the P7 crowd line, `crowd.weighted_biases`; an agent without a record weighs 1). Aether tunes the weighting later from what it learns. Anything else is WAIT.
  - **Prices** (`planForDirection` in `src/strategy-engine.mjs`): the entry, stop and targets come from the Key Level Agent's zones through the strategy engine's `tradeLevels`. A quorum without a valid entry, stop and target (stop and target on the right sides of the entry) stays WAIT: the only hard rule besides the quorum. No position size is ever given.
  - **Deterministic** (`applyQuorum`): the direction comes from the quorum and the prices from the plan, whatever the model returns. The Reasoner only writes the reasoning, the confirmation and invalidation text; its own decision is read for the confidence when it agrees. The synthesis records `consensus.quorum` (stance, room stance, share, needed, met, reason), `plan_available` and `guard_overridden` (the model's decision differed).
  - **Indicators are arguments, not gates or vetoes.** The Prophet R38 confirmation and setup state (READY), its trade management `t_enc`, and the GMI verdict, gate and conflict are read by the agents in the discussion (KB `decision_policy.long_arguments` / `short_arguments`). The former rules of the Reasoner (the matching Prophet trigger, the `t_enc` 4 and GMI ±3 vetoes, `consensusGuard`) are retired.
  - **Evidence in quorum mode** (`buildEvidenceFusion` with `decisionMode: "quorum"`): only a missing or stale closed candle blocks the decision. A missing news lane or engine record is noted in the evidence and the room still meets. Local records that parity has not approved are used with `trust_status: "not_parity_approved"`.
  - **No parity cap in the 1H, 4H and D1 rooms:** every agent speaks at the confidence its reading supports; the calibration stays a label next to the agent. The 15m Live War Room keeps its rules for now.
  - Every field describes the closed candle being decided (the bar that just closed), never the running one.
- **The 1H room right after the close (owner request 2026-11-07):**
  - When `runAnalysis` parks the evidence, it enqueues an `h1_room` queue task, so the 1H War Room no longer waits for the next sweep (:10, :25, :40, :55) and its 20-minute HUD wait.
  - The task waits for the bar's HUD snapshot until 2 minutes after the close (`H1_ROOM_HUD_WAIT_MS`, redelivered every 15 seconds), then runs the room. The Reasoner decides as soon as the room concludes.
  - A snapshot that arrives later re-convenes the room (`#hud`); the decision already written stays.
  - A bar not yet in the cached series, or a room still waiting for its quorum, is redelivered.
  - While the task holds the room (`h1room:lock:<candle_key>`, 7 minutes), the sweep skips that bar. The sweep remains the fallback.
  - The synthesis records `consensus.decided_after_close_s`. **Target (owner 2026-11-09): within 1 to 2 minutes of the close.** The chain: the market-data cron runs every minute and pulls the 1H bar 60 seconds after its close (`SETTLE_SECONDS`, 90 until 2026-11-09; a later revision is republished for parity); the same run publishes the HUD snapshot first and then the H1 record, which parks the evidence and enqueues the room (queue batch timeout 1 second); the room takes about 10 to 20 seconds and the Reasoner about 15. Before: about 6 to 7 minutes (cron every 5 minutes, settle 90 seconds, the HUD snapshot published after the record, a 60-second retry).
- **Fail-closed:** a room where no agent spoke by the fallback time gives WAIT without a model call. A Reasoner that keeps failing is retried by every sweep, and after 2 hours gives WAIT.
- **Idempotent:** only the caller that moves the stage from `awaiting_consensus` to `finalizing` decides (a stale `finalizing` is reclaimed after 10 minutes). New evidence of the bar may reclaim a stale `analyzing` run; it then parks the fresher evidence.
- **Stored:** the synthesis carries `analysis_chain: "consensus_reasoner"`, `consensus` (status concluded, partial or empty; who spoke; the room's bias; the conclusion; whether the guard overrode the Reasoner) and the raw Reasoner output. Persistence is unchanged: `ai_syntheses`, `trade_decisions`, `latest:`, Telegram and `analysis:`.
- **Read:** `GET /api/threads/timeframe?chart=H1` adds `reasoner_decision` (decided, awaiting the room, or deciding). The Nexus 1H tab ends with it.
- **Retired:** the Analyst and the Counselor of the H1 chain (they still serve the news analysis), and the old H1 multi-agent bus (the 1H War Room is the bus). The legacy `/analyze` bundle path is unchanged.

### 5m execution context
- The evidence key `informational_5m_context` may be surfaced in the fusion bundle. Since B2 it is the
  5m parity record of the bar, reshaped (`local-engines/producer/src/m5-context.mjs`): the pull adapter
  sends it once per closed 5m bar, right after publishing that bar's 5m records. `buildM5ProphetContext`
  (a second, separate 5m computation) is retired.
- The context always declares `informational_unverified`. The AI Worker labels it **VERIFIED 5m**
  (`verification.verified`, `approved_by_parity`) only while `prophet_m5` and `gmi_m5` are approved and that
  bar's observed 5m records come from them (`verifiedM5Reading`); otherwise **UNVERIFIED 5m**.
- Either way it is execution timing only: it is **never** part of `fusion.complete`, and never changes the
  decision, entry/SL/TP, risk/reward, position size or confidence.
- **5m parity records (C0 step 3).** The pull adapter also publishes full mizan, prophet and gmi records for every closed 5m bar (`local-engines/producer/src/m5-local-producer.mjs`, behind `M5_PARITY_PUBLISH`). They have timeframe `"5"` and candle key `OANDA:XAUUSD:5:<open ms>`.
  - The records earn their own approval under the timeframe-scoped ids `prophet_m5`, `gmi_m5` and `mizan_m5`, separate from the approved H1 ids. The parity sweep revisits the last six closed 5m candles.
  - GMI on every chart (5m, 15m, 1H, 4H, D1) runs one engine, `local-engines/gmi/src/gmi-core.mjs` (`computeGmiOnChart`; `computeGmi` is the 1H chart). B4 (owner go for the full re-approval, 2026-11-09) merged the three copies it had grown into: the H1 core, `gmi-core-tf.mjs` (5m, 15m) and `gmi-core-htf.mjs` (4H, D1). The merge was proven output-identical to all three on 80 synthetic bundles across the five charts, and `test/gmi-core-htf.test.mjs` pins golden output fingerprints of the former modules. `gmi-core-tf.mjs` and `gmi-core-htf.mjs` remain as one-line re-exports, so the producers that import them, and the Prophet and MizanLib identities that hash those producers, did not change; every GMI identity (`gmi`, `gmi_m5`, `gmi_m15`, `gmi_h4`, `gmi_d1`, `gmi_hud`) re-earns its 24 parity matches.
  - The provenance has its own `prophet_m5` and `gmi_m5` entries, so 5m code changes never change the H1 hashes.
- **Verified 15m lane** (owner decision 2026-11-05, same design as 5m).
  - The pull adapter publishes mizan, prophet and gmi records for every closed 15m bar. The producer is `local-engines/producer/src/m15-local-producer.mjs`, behind `M15_PARITY_PUBLISH`, with timeframe `"15"` and candle key `OANDA:XAUUSD:15:<open ms>`, the same key as the 15m HUD snapshot.
  - The records earn their own approval as `prophet_m15` and `gmi_m15`, with their own provenance entries. The H1 and 5m hashes are unchanged. The parity sweep revisits the last two closed 15m candles.
  - Calibration needs the existing Prophet R38 and GMI alerts installed on the 15m chart until both identities are approved (24 matches). After that, the alerts may be removed, as with 5m ("pilihan 1").
  - Once approved, the 15m HUD fields that are alert fields read as verified by parity in the War Room. Engine internals stay uncalibrated until a Pine candidate comparator exists (C1).
- **H4 and D1 lane** (owner decision 2026-11-05: Threads per timeframe D1, H4, H1 and 15m).
  - **Records:** the pull adapter publishes mizan, prophet and gmi records for every closed H4 and D1 bar. The producer is `local-engines/producer/src/htf-local-producer.mjs`, behind `HTF_PARITY_PUBLISH`.
  - **Timeframes and keys:** the timeframes are `"240"` and `"1D"`, as Pine v6 `timeframe.period` reports them. The candle keys are `OANDA:XAUUSD:240:<open ms>` and `OANDA:XAUUSD:1D:<open ms>`.
  - **GMI engine:** the one GMI engine (`gmi-core.mjs`, re-exported as `gmi-core-htf.mjs` for the H4/D1 producer) with Pine's `dyn_ltf` intrabars: M1 below 240, M5 on H4, M15 on D1.
  - **Identities:** the records earn their own approvals as `prophet_h4`, `gmi_h4`, `prophet_d1` and `gmi_d1`, each with its own provenance entry. No other hash changed.
  - **Sweep:** OANDA H4 and D1 bars open at 17:00 New York, not on epoch multiples. The parity sweep therefore takes the last two closed H4 and D1 keys from the cached native bars (`closedHtfCandleKeys`), never from the clock.
  - **Calibration:** the owner installs the Prophet R38 and GMI alerts on the 4-hour and daily charts, set to "Any alert() function call" with the same webhook.
    - 24 matches take about 4 trading days on H4 and about 5 weeks on D1.
    - Until then, H4 and D1 readings are unverified.
  - **Independent rooms (owner decisions 2026-11-09: "masing-masing timeframe independent, masing-masing agent harus independent dilarang untuk refer ke agent atau timeframe lain"; "output masing-masing agen dilarang menyebutkan nama agent tetapi metrics apa yang dia gunakan"; "consensus discussion tetap ada per masing-masing timeframe"):** this supersedes every cross-timeframe and cross-agent rule below.
    - **One timeframe per room.** The 15m, 1H, 4H and D1 rooms each read only their own chart: its closed bars, its HUD snapshot, its local records and the news. The Higher-Timeframe Desk is retired (`htf` stays only as a name for stored rooms). The 15m room no longer reads the H1 decision, the 1H room or the 5m lane, and its moderator no longer names an H1 decision. The News Analyst no longer reads the Macro War Room. The Risk Manager reads its chart's volatility, its own Prophet R38 reading and the economic calendar, no longer another room's news bias or higher timeframe.
    - **The Consensus Discussion stays, inside each timeframe**, over an anonymous bus: every statement appears as `#n` (roster order) with its stance, bias, confidence, evidence label, metrics and claim, never with an agent's name. Rebuttals and the moderator's dissent use `#n` references, mapped back to agent ids for storage and Nexus.
    - **Metrics, not names.** Every opening, rebuttal and conclusion carries `metrics` (one to four plain-language metrics it decided from). A text that names another agent (`names_an_agent`; its own HUD name is its data source and allowed) or lacks metrics (`metrics_missing`) gets one correction call. Since the fix of 2026-11-09 (production lost most room answers from 10:00 to 12:00 UTC and the 1H and 4H rooms stopped concluding): a role name (Analyst, Manager, Desk, Moderator) never appears, but an indicator's name (Supertrend, Prophet, Order Blocks) is a metric and counts as naming the agent only when used as an actor ("Supertrend says", "the Prophet's view", "according to Order Blocks"); a metrics list a model wrote inside its text is recovered and the text cut there, stray model tokens are stripped; and an answer whose only remaining problem after the correction is a missing metrics list is kept with the metrics of its own data source, marked `metrics_inferred` (every other error still rejects it). The moderator and the Reasoner never write a desk or role name. The shared base rules for rooms (`ROOM_RULES_INDEPENDENT`) drop "the H1 decision chain is authoritative" and the 5m lane.
    - **The 15m room is judged by its own quorum** (`entry_without_quorum` on its crowd line), like the 1H, 4H and D1 rooms; its confirmations are the 15m chart's own Prophet R38 reading. The legacy `entryAllowed` stays only for the retired live room.
    - **The H1 decision** reads the anonymous consensus, never the 5m context (`ownTimeframeEvidence`), and takes its prices from the 1-hour chart's own key levels (`ownTimeframePlan`: the Key Level Agent over the 1H HUD snapshot and the 1H bars, the 1H ATR and the last 1H close). The strategy engine and the Global Conclusion stay multi-timeframe readers; they are not room agents.
  - **Timeframe War Rooms (owner decision 2026-11-06; supersedes the five-desk H4/D1 threads of step 4):** every Thread, D1, 4H, 1H and 15m, is the consensus of all agents, as in the Live War Room. 15m is the Live War Room; `src/timeframe-threads.mjs` runs the 1H, 4H and D1 rooms.
    - **Phases:** each closed bar of that chart runs the same three phases: every agent opens on the bus, the minority (by bias and confidence) and the Risk Manager answer named agents in the Consensus Discussion (the term replaces "debate", owner decision 2026-11-07) for at most 3 minutes, and the moderator writes the TLDR.
    - **Agents:** the desks plus one agent per HUD computed on that chart.
      - Desks:
        - The room's own timeframe desk analyses only its chart (owner decision 2026-11-06; `src/timeframe-desk.mjs`):
          - The 1H, 4H and D1 Desks read the local Prophet R38, R37 and GMI records of the bar, decoded into plain sentences.
          - A desk whose records parity has not approved is labelled so; it speaks at its own confidence (owner decision 2026-11-09).
          - A room without local records for its bar has no own desk.
        - The other desks: the News Analyst (News Daily), the Technical Analyst and the Risk Manager. The Higher-Timeframe Desk is retired (independent rooms, 2026-11-09).
      - HUD agents come from that bar's HUD snapshot. The pull adapter now also publishes H4 and D1 HUD snapshots (`hud-snapshot.mjs`, timeframes `"240"` and `"1D"`, GMI from the one engine in `gmi-core.mjs`).
        - Fresh windows after the close: H1 25 minutes, M15 9, H4 30, D1 60.
        - **Catch-up (owner decision 2026-11-06):** an H4 or D1 bar whose snapshot was never sent in that window is sent once while it is still the chart's latest close (H4 up to 4 hours, D1 up to 72 hours, which covers the weekend). It is built on the bundle cut at the bar's close, so it is the snapshot that bar would have had. The marker `market-data:v2:hud-published:<candle_key>` (4 days) keeps every bar to one send. H1 and M15 have no catch-up: their rooms move on with every bar.
        - The pull adapter's `GET /health` shows `last_hud_publish`: each chart's status and candle key, and `catch_up` when a bar was sent late.
    - **No webhook dependency:** the rooms run on local computation only: closed bars, the HUD snapshot and the local Prophet R38 record of the bar.
    - **Calibration:** a HUD statement is verified only where it equals a parity-approved record, and computed from verified bars only where the bar's parity comparison matched (see "Calibration status once"). This is a label, not a cap: since 2026-11-09 the agents of these rooms speak at their own confidence and their weight comes from their track record.
    - **Quorum, not confirmation** (owner decision 2026-11-09): a BUY or SELL conclusion needs more than half of the agents' track-record weight holding the matching bias (`entry_without_quorum`, one correction call, then rejected). The chart's Prophet R38 confirmation or setup still READY (`values.setup.buy_ready` / `sell_ready` of the local record; the desk's reading `chartDeskReading` returns `buy_setup_ready` / `sell_setup_ready`) is an argument the agents weigh, listed for the moderator as "indicator readings (arguments, not gates)". The 1H conclusion names the H1 decision when it differs.
    - **Schedule:** the rooms run from the parity sweep cron in their own `waitUntil`, one after another (D1, 4H, 1H), so the model sees one room's burst at a time; no room reads another (2026-11-09). They run behind `TF_THREADS_ENABLED`, within `TF_THREADS_MAX_CALLS_PER_HOUR` (production 120, preview 150; about 26 calls per room).
      - A bar waits up to 20 minutes for its HUD snapshot, then runs with the desks only.
      - **Re-convene:** a room that concluded without its HUD snapshot meets once more, for the same bar, when the snapshot arrives late (the catch-up above). The second session is stored as run `<bar open>#hud`, which sorts after the first, so the tab, the Global Conclusion and the room below read it. The API reports the bar open without the suffix and `reconvened: true`.
      - Rooms of one sweep are 65 seconds apart: one room spends about 22 calls within a minute, and the Workers AI per-minute limit is shared.
      - A room concludes only when at least half of its agents spoke. Otherwise the next sweep retries the failed openings. Two hours after the close, it concludes with whoever spoke.
      - Each room runs once per bar, plus at most that one re-convene.
    - **Storage and API:** messages are stored in `agent_thread_messages` (thread `tf:H1` / `tf:H4` / `tf:D1`, run = bar open; steps `brief`, `open:*`, `debate:*` and `conclusion`). Read API: `GET /api/threads/timeframe?chart=H1|H4|D1` (also `1H`, `4H`).
- **News Daily** (owner decision 2026-11-06): `src/news-daily.mjs`, run by the hourly news cron after the hourly analysis, behind `NEWS_DAILY_ENABLED`, within `NEWS_DAILY_MAX_CALLS_PER_HOUR` (production 6, preview 12).
  - **Input:** the unique articles of the last 24 hours, taken from the stored hourly analyses (no extra TradingView pull), plus the 24-hour moves of gold, the dollar index, WTI oil and the USDT dominance from the cached closed bars.
  - **Per headline:** each headline gets a gold bias (BULLISH, BEARISH or NEUTRAL) and one plain sentence why. A tag is cached for 3 days, so each run tags only new headlines.
  - **TLDR:** the News Analyst writes the TLDR: one bias for the day, a summary and one to three reasons. A run is skipped while the 24-hour headline set is unchanged.
  - **Consumers:** every News Analyst desk reads it, in the Live War Room and the timeframe rooms. Read API: `GET /api/news/daily`.

- Transport: the pull adapter calls `AI_WORKER.submitContext(record)` on the
  AI Worker's `LocalComputationIngress` RPC entrypoint (no shared secret).
- Storage: KV key `context:m5:latest` (TTL 900 s) on the AI Worker.
- Read API: `GET /api/m5-context` returns the latest stored 5m context.
- **Analysis timeframes.** `POST /webhook` starts the AI chain only for `ANALYSIS_TIMEFRAMES`: `"60"` (H1) in production, and `"60,5"` in preview for the M5 fixture. Webhooks on other timeframes, such as 5m or 15m parity comparators, are stored only and answer `analysis_status: "stored_only"`.
- **Verified 5m lane (C0).** Per-timeframe parity identities and the full 5m producer are in place. Comparison starts once the owner installs the existing alerts on the 5m chart. The label switch is step 4. While `prophet_m5` and `gmi_m5` are both approved, and the observed 5m records for the bar come from those approved implementations, the live room's 5m read is labelled **VERIFIED 5m** (`trust_status: approved_by_parity`). It is then read in plain language with the same reading as the H1 webhooks (`src/m5-verification.mjs`).
  - Otherwise the read stays UNVERIFIED 5m, and the label switches by itself.
  - `GET /api/live` returns `m5_verified`, and the Nexus live badge follows it.
  - **5m alerts after approval (owner decision "pilihan 1", 2026-11-05).** Once `prophet_m5` and `gmi_m5` are both approved, the owner may delete the two 5m TradingView alerts. The approval persists while the 5m source and implementation hashes are unchanged; a 5m engine change needs the 5m alerts again for a calibration run, like the monthly H1 calibration.
  - The H1 chain and the bus read the same verification (B2), so every consumer of the 5m data follows one label.
- Freshness rule for use in `runAnalysis`: accepted only when both
  `now - Date.parse(candle_time) <= 15 min` and
  `now - Date.parse(received_at) <= 10 min`.
- Diagnostics: `GET /api/local-lane` (proxied by the Nexus dashboard to the pull adapter's
  `MarketDataReader.diagnostics()`) exposes the pull adapter's last refresh, latest closed bar
  per series, last publish and quota budget.

### Multi-agent bus (Phase 2, shadow only, `MULTI_AGENT_BUS_ENABLED`)
- Code: `src/multi-agent-bus.mjs`. **Enabled in production since Phase 4 (owner approval 2026-11-04)**: `MULTI_AGENT_BUS_ENABLED` and `LIVE_ROOM_ENABLED` are `"true"` in both `wrangler.jsonc` and `wrangler.preview.jsonc`. Turning a flag back to `"false"` stops new runs at once; stored messages stay readable.
- **Retired for H1 (owner decision 2026-11-07):** the AI Worker no longer enqueues it; the 1H War Room is the H1 communication bus. The module, its queue handler and the stored messages stay readable, and the news thread still uses its model settings.
- Until 2026-11-07, after the H1 synthesis was persisted (degraded or complete), the AI Worker enqueued a `multi_agent_bus` task on the existing queue. The task reads that synthesis, runs agents `technical` and `news` for 2 rounds, then a `moderator` consensus. That is at most 5 model calls, with a 300 s wall budget and the `MULTI_AGENT_MAX_CALLS_PER_HOUR` cap; the cap fails closed.
- **Models per role (owner decision 2026-11-07, model migration).**
  - **Why:** the Workers AI changelog of 2026-11-05 retires `@cf/zai-org/glm-5.3-flash` and `@cf/nvidia/nemotron-3-120b-a12b` on 2026-11-20 (HTTP 410, error 5028; first announced for 2026-11-15). glm-5.3-flash was also a paid model limited to 20 requests a minute per account, the main source of the rooms' 3021 errors.
  - **Room agents** (openings, Consensus Discussion, headline tags, plain-language rewrites): `ROOM_AGENT_MODEL` = `@cf/google/gemma-4-26b-a4b-it`, thinking off. Fallback: `ROOM_AGENT_FALLBACK_MODEL` = `@cf/openai/gpt-oss-20b`, low reasoning effort.
  - **Moderators** (every room conclusion and the News Daily TLDR; `stepRole` in `src/agent-threads.mjs`): `MODERATOR_MODEL` = `@cf/openai/gpt-oss-120b`. Fallback: `MODERATOR_FALLBACK_MODEL` = `@cf/google/gemma-4-26b-a4b-it`.
  - **News chain** (Analyst, Counselor, Reasoner) and the **H1 Reasoner**: `AI_MODEL_ANALYST`, `AI_MODEL_COUNSELOR` and `AI_MODEL_REASONER` = `@cf/openai/gpt-oss-120b`. The analyst and counselor stages reason at low effort; the Reasoners at medium, with 8192 tokens.
  - **Request forms:** `modelRequests` in `src/model-text.mjs` builds them per model family.
    - gpt-oss: Chat Completions with `reasoning_effort` and a strict JSON schema; then without the schema; then the Responses form (`input`, `reasoning.effort`).
    - gemma-4: `chat_template_kwargs.enable_thinking` false, with the schema, then without.
    - A form the model rejects (an input-validation error) falls back to the next one and is logged as `model_request_form_rejected`.
    - `extractModelText` reads the legacy, Chat Completions and Responses API shapes.
  - **Precedence:** a role's own variable wins. `MULTI_AGENT_MODEL` / `MULTI_AGENT_FALLBACK_MODEL` override every role when set (tests, rollback). An empty fallback turns the fallback off.
  - **Failures:** on an error (or a 60 s timeout) the call is retried once with the role's fallback. `fallback_used` is recorded, and the primary error is stored as `primary_error` on the message. A pinned primary failure belongs to the failed model only: a room's moderator keeps its own primary when the agents' primary failed.
  - **Moderator robustness:** bus agent ids in a moderator's text and in rebuttals are written as the agents' names before validation (`agentIdsToNames`), and a fourth reason is dropped. A moderator answer still rejected after its correction is asked once from the moderator's fallback model. A failed conclusion shows its errors, model and raw text in the room API.
  - **Proof:** preview-e2e asserts the role models on the news thread and the War Room. A preview-only `/preview/reasoner-probe` makes one call in the H1 Reasoner's request form.
  - **Fallback reliability** (owner decision 2026-11-06, after three preview-e2e failures that day):
    - A primary **timeout** is transient: the step falls back, and the next step tries the primary again. The second timeout in a run (`PRIMARY_TIMEOUTS_TO_PIN`) sends the rest of the run to the fallback, because each timeout costs up to 60 s of the wall budget. Any other primary error does so at once, as before.
    - A fallback answer cut off by its token limit (`finish_reason` length: the reasoning model spent the budget on hidden reasoning) is asked once more, with twice the budget and a note to answer with the JSON only. This happens only when at least 30 s remain before the deadline. The hourly budgets do not count this one retry.
    - The same `callBusModel` serves the H1 bus, the news threads, the War Rooms, the timeframe rooms and News Daily. Beam (`reflection-ai/beam-1.0-501b-a23b`) was evaluated and rejected: it needs AI Gateway Unified Billing credits.
- The bus **never** writes into the chain's evidence, prompts or decision. Its output lives only in D1 `bus_messages` (migration `0003_bus_messages.sql`; the schema is also ensured at runtime for the preview D1), and it is read through `GET /api/bus?candle_key=` (messages, consensus, `agreement_with_chain`).

### Agent threads and live 15m room (Phase 3, `docs/RFC_NEXUS_AGENT_SOCIAL.md`)
- Code: `src/agent-threads.mjs`. Tables `agent_threads` and `agent_thread_messages` (migration `0004_agent_threads.sql`; new tables only, `0003` is never altered; the schema is also ensured at runtime for the preview D1).
- **News threads** (behind `MULTI_AGENT_BUS_ENABLED`):
  - After each news analysis, a `news_thread` queue task makes the analysis a post.
  - `news` and `technical` reply, each then replies to the other's reply (`parent_id`), and a `moderator` posts the consensus.
  - At most 5 calls, using the bus model with the bus fallback.
- **Live 15m room** (behind `LIVE_ROOM_ENABLED`, owner decision 2026-11-04):
  - Every 5m context submission (RPC `submitContext`, or the authenticated `POST /evidence/m5-context`) refreshes the 5m execution context in KV.
  - Only a submission whose closed 5m bar also closes a 15m candle (:00, :15, :30, :45 UTC) enqueues a `live_room` task. The task carries the context itself.
  - At every 15m close, `technical` and `risk` (a reply to technical) post, then a `moderator`, using stances BUY/SELL/HOLD/WAIT/CLOSE. There is no "nothing changed" skip.
  - Evidence:
    - `m15`: the closed 15m candles built from the last 12 closed 5m bars; a candle counts only when all three of its bars are present. This is the setup.
    - `m5`: the local-lane 5m read and bars, labelled VERIFIED 5m when parity-approved on 5m (C0), otherwise UNVERIFIED 5m. This is the execution timing.
    - `h1`: the H1 decision and the H1 TradingView reading.
    - `news`: the latest news-thread consensus.
  - The moderator must state the H1 decision whenever its stance differs from it.
  - Each role with its own free-plan fallback since 2026-11-07 (before: primary only, never the paid glm-4.7 fallback). The `LIVE_ROOM_MAX_CALLS_PER_HOUR` cap fails closed: 4 rooms an hour × 3 calls, well under 36.
  - Thread ids are `live15m:<day>`. `GET /api/live` also returns the older `live5m:` history.
  - The 5m context carries the last 12 closed bars (`recent_bars`). The H1 chain strips them.
- Read APIs: `GET /api/threads?kind=news|h1`, `GET /api/threads/:id` (nested replies; `h1:<candle_key>` serves the stored H1 bus discussions as a thread, history only since 2026-11-07) and `GET /api/live?since=`.
- **Nexus layout (owner decisions 2026-11-05 and 2026-11-06).**
  - **Center, under the chart:** the living War Rooms of every timeframe in one card. Its top is the tab bar `News | 15m | 1H | 4H | D1`, and every page load opens on News (no 5m tab for now).
  - **Each tab** starts with its conclusion directly under the tab bar: the stance in large type, confidence, summary, reasons, dissent, and what binds it.
    - On 15m: the H1 constraint and the entry confirmations.
    - On 1H, 4H and D1: that chart's Prophet R38 confirmation.
    - Under the conclusion come the communication bus and the Consensus Discussion. The 1H tab ends with the Reasoner's H1 decision.
  - **Sources:** 15m reads `GET /api/war-room/latest`; 1H, 4H and D1 read `GET /api/threads/timeframe`. The News tab shows the News Daily TLDR and each headline with its bias (`GET /api/news/daily`).
  - **No separate 15m cards:** they repeated the 15m tab.
  - **The active tab drives the page.**
    - The left panel lists the desks and HUD agents of that tab's room, with their stance and calibration. On the News tab it shows the News Analyst.
    - The Camarilla set and pivot ranges of the Key levels panel, and the regime radar, on the right show that tab's chart. News uses the 1-hour chart.
- **Strategy engine** (owner decision 2026-11-06: "the decision is the consensus of all agents, not three"; `src/strategy-engine.mjs`, `GET /api/strategy`; deterministic, no model call, computed on read).
  - **Why:** the H1 chain's three models (Analyst, Counselor, Reasoner) apply the policy rules, which need a Prophet R38 trigger on the H1 candle itself, so the decision was almost always WAIT. Meanwhile the rooms' agents leaned clearly one way.
  - **Top-down layers** (every room's lean is the confidence-weighted bias of all its agents):
    - **D1 macro trend and 4H intraday trend:** their mean is the trend. A room older than two of its bars is stale and drops out.
    - **1H setup:** the side is the trend's when the 1H room does not lean against it. With a neutral trend, a 1H lean of 0.3 or more counts when the 15m room agrees.
    - **15m location:** the 15m room must not lean against the side. Price must sit at a key level with the trade (within 0.35 × the 1H ATR(14)) or inside a demand or supply zone (order block, mitigation, QM or flip zone of the 15m HUDs). Otherwise the planned entry is a pullback to the nearest level.
      - **Setup type (owner decision 2026-11-08, `setupType` in `src/level-readers.mjs`):** from the 15m chart plane (and the 1H Fibonacci leg when the 15m has none), deterministic:
        - *continuation_pullback:* price in the OTE band (0.618 to 0.786) of a leg with the trade, or back at the KWW mean to −1.618σ against it, with liquidity with the trade within 0.35 × the 1H ATR (an open FVG target, the RBS or SBR level, a whale zone or mitigation block on the trade's side);
        - *reversal_sweep:* price stretched 1.618σ or more against the trade at the QM level or a whale zone with the trade;
        - otherwise *none*.
        A setup type counts as a location with the trade, like a demand or supply zone, and the entry note names its evidence. The strategy reports it as `setup`; the captured strategy inputs keep the chart plane, so the replay reads the same setup.
    - **5m trigger:** a VERIFIED 5m Prophet confirmation in the trade's direction, or the 15m Prophet confirmation. An unverified 5m confirmation never counts.
      - **At every closed 5m bar (owner decision 2026-11-08, "the confirmation is critical"):** the AI Worker re-evaluates the engine when the pull adapter sends a 5m context (`ingestM5Context` → `evaluateStrategyAtM5Close`), with that bar's confirmation (VERIFIED only while `prophet_m5` and `gmi_m5` are approved) and its close as the price. It no longer waits for the 15m room.
      - A TRIGGERED setup goes to the Signal Ledger at once (one per hour, none while one of the same side is open) and its Telegram alert follows.
      - The live 5m inputs count while the bar closed at most 10 minutes ago (`liveM5Inputs`); `/api/strategy` and the Global decision read them too.
      - Deterministic: no model call.
  - **Key levels: the Key Level Agent** (owner decision 2026-11-06: "not only Camarilla"; `src/key-level-agent.mjs`, `GET /api/key-levels`, deterministic):
    - **Sources:** every key level of every chart, weighted by kind and by timeframe (15m 1, 1H 1.5, 4H 2, daily 2.5, weekly 3):
      - Camarilla H3/L3 0.6, H4/L4 1.0, H5/L5 0.8, of the 15m, 1H, 4H, daily and weekly sets (from the 15m, 1H, 4H and D1 HUD snapshots). Each Camarilla level, pivot and CPR edge has one value, taken from the freshest snapshot: production on 2026-11-06 showed a stale D1 snapshot's daily set counted beside the current one as a second source;
      - the daily and weekly pivot 1.0, and the CPR top and bottom 0.7;
      - the point of control 0.9 and the value area high and low 0.8, of each chart;
      - the last four swing highs and lows (2-bar fractals of the last 60 closed bars) of the 15m, 1H, 4H and D1 charts, 0.9;
      - the previous day high and low 1.0 and close 0.6, and the previous week high and low 1.0;
      - round numbers within four 1H ATRs of price: every 50 dollars 0.8, every 25 dollars 0.4.
      - **the four level readers of the chart plane (owner decision 2026-11-08, PR 2 of 3; `src/level-readers.mjs`):**
        - **Band Agent:** KWW ±1.618σ 0.7, KWW mean 0.5, EMA 114 0.6, VWAP 0.6 (15m and 1H only), TVA channel edges 0.5.
        - **Liquidity Agent:** RBS/SBR 1.0, QM 0.9, active whale zone edges 0.9, mitigation block edges 0.7, the three nearest open FVG targets per side 0.7 × their mass (clamped 0.3 to 1.5), HVN 0.8, LVN 0.5.
        - **Projection Agent:** Fibonacci 0.618 and 0.786 (OTE) 0.8, 0.5 0.6, the 1.272 and 1.618 extensions 0.7, the probability cone p90/p10 0.4, the tactical trendlines 0.5, PA support and resistance 0.6.
        - **Session Agent:** true month and year open 1.0, week and day open 0.8, Asia, London, NY AM and NY PM opens 0.5, the trading day open 0.6 and week open 0.8, the session POC 0.9 and VAH/VAL 0.8. Session levels are one value for every chart: they carry the daily timeframe and the freshest snapshot's value counts once.
        - The TDM POC/VAH/VAL and the previous day and week high/low are read elsewhere already, so the readers skip them. `GET /api/key-levels` reports how many levels each reader added (`readers`), and each zone member names its reader.
    - **Chart plane (owner decision 2026-11-08, PR 1 of 3; `local-engines/producer/src/chart-plane.mjs`):** every HUD snapshot (15m, 1H, 4H, D1) carries `chart_plane`, every price object GMI v12.70 draws on the chart, as numbers at the closed bar. It is not a HUD section, so it adds no room agent; the Key Level Agent reads it from PR 2, the Nexus chart from PR 3.
      - **bands:** Z-KWW MA, ±1σ and ±1.618σ with the z-score; Dynamic EMA 114; VWAP (hlc3, reset at the trading day); the adaptive TVA regression channel (2 deviations).
      - **liquidity:** Aether FVG open targets with their mass; the Spacetime Whale Map (active zones and mitigation blocks, with HP); GABFX QM BUY/SELL and RBS/SBR; the TDM profile POC, VAH, VAL, LVN and HVN.
      - **projection:** the SMC Fibonacci grid (15 ratios, warped); the probability cone (p90/p10, 50 bars); the tactical trendlines; PA support and resistance.
      - **session:** True Openings (year, month, week, day, Asia, London, NY AM, NY PM); day and week open, previous day and week high and low; the Daily session volume profile (30 rows, 70 % value area, from 1m bars on 15m and 1H, 5m on 4H, 15m on D1), current and previous session.
      - **Limits:** path-dependent state is replayed over the engines' 1000-bar window; True Openings come from the 15m bars, so they are the true open at the stated New York time on every chart. Nothing in it is a TradingView alert field: it is unverified context, never a decision. The pull adapter's `/health` names its version per chart (`last_hud_publish.charts.<chart>.chart_plane`).
    - **Zones:** the levels, sorted by price, are grouped while a group's span stays within 0.3 × the 1H ATR (at least 1 dollar).
      - **Independence (owner decision 2026-11-08, after the chart plane gave 11 candidates):** a zone's sources are its distinct level FAMILIES (Camarilla, pivot/CPR, value area, swing, previous day/week, round number, order block, Supertrend, and the readers' Band, Liquidity, Projection and Session), not (kind, timeframe) pairs, so one chart's KWW mean, Fibonacci and PA line no longer count as three confirmations. A zone's score adds, per family and timeframe, only the heaviest level.
      - Strength: strong (score ≥ 6), medium (≥ 3) or weak.
      - **Candidate key level:** a zone with three or more families and at least medium strength, at most two per side (the strongest, then the nearest; a zone at price always stays; the others read `qualified`). `cryptophys.key-level-agent.v2`. The owner tightened this on 2026-11-06: at two sources, production marked 14 of 18 zones; at three sources and medium, it marked 9 of 18.
      - Role: support, resistance, or "at price".
    - **The strategy plans on the zones:**
      - entry: at a zone with the trade (inside it, or within 0.35 ATR of it), or a pullback to its near edge;
      - stop: beyond the far edge of the first zone against the trade at least 0.5 ATR from the entry;
      - targets: the near edges of the next two candidate zones.
      - Non-candidate zones anchor entries and stops but are never targets.
  - **Plan and reward-to-risk:**
    - entry: price at the level, or the planned pullback level;
    - stop: beyond the next level against the trade at least 0.5 ATR away, padded by 0.2 ATR. Without one, or beyond 2.5 ATR, the stop is 1.5 ATR;
    - TP1 and TP2: the next two major levels with the trade, each at least 0.5 ATR beyond the previous one, or 2R and 3R projections;
    - RRR to each target.
  - **Vetoes and cautions:**
    - Vetoes (state `BLOCKED`): a Prophet cut loss (t_enc 4), or a strong GMI verdict against the side (∓3), on the 1H chart.
    - Cautions (−0.1 confidence each):
      - a GMI and Prophet conflict, or a closed GMI gate (−1), on the 1H chart. These were vetoes until the owner loosened them on 2026-11-06: at 14:15 that day they blocked a clear bearish consensus;
      - both the 1H and the 15m regime chaotic;
      - News Daily leaning against the side at 0.6 or more;
      - **event risk** (backlog 11.1, owner decision 2026-11-08): a High-impact USD event of the economic calendar, from 2 hours before to 30 minutes after it. Never a forced WAIT.
        - **Source:** `src/econ-calendar.mjs`, the ForexFactory weekly export, fetched by the sweep at most once an hour and cached in `SIGNAL_CACHE` (`calendar:ff:thisweek:v1`). A failed fetch keeps the cache.
        - **Rooms:** the Risk Desk of the 1H, 4H and D1 rooms sees the events due now and in the next 24 hours.
        - **Calendar Agent (owner decision 2026-11-08, `src/calendar-agent.mjs`):** the projected effect of each USD event on gold, by fixed rules per event kind (stronger US data or a hawkish Fed: gold down; unemployment and claims the other way; a speech by its tone). It gives the effect of an actual above or below the forecast, the consensus lean (forecast against previous, largely priced in), the status and the horizon (2 hours before to 4 hours after). The export has no actual figure; after the release the outcome is read from the headlines. `GET /api/calendar` carries `projection` and `outlook`; the News Daily TLDR and the Risk Desk read it and may not reverse a direction. Context only.
        - **Replay:** the strategy inputs record carries the gated events, so the replay reproduces the caution.
        - **Read model:** `GET /api/calendar` and the Nexus page `#/calendar`.
  - **States:** `NO_SETUP`, `BLOCKED`, `NO_LEVELS`, `SETUP_FORMING` (wait for the pullback), `SETUP_READY` (at the level, waiting for the trigger), `LOW_REWARD`, `LOW_CONFIDENCE` and `TRIGGERED`.
    - The decision is BUY or SELL only when `TRIGGERED`: the trigger fired, no veto, at least 1.5R (`MIN_RRR`) to TP2, and a confidence of at least 0.4. Every other state is WAIT, and it still shows the side, the levels and the RRR.
    - Confidence: 0.6 × the weighted alignment (D1 30, 4H 30, 1H 25, 15m 15), +0.15 at a level, +0.2 when triggered, minus cautions, and −0.1 when any room is stale.
  - **Authority:** the Global Conclusion's action is the strategy decision. The H1 chain keeps running and is shown beside it as a reference. Kernel reports are unchanged, and never carry levels.
  - **Advisory only:** no orders, no broker and no position size. The rooms still never give levels; the engine's levels come from closed bars only.
- **Trading assistant panel (right, owner decision 2026-11-06; charts only).** It is display-only: every number comes from the rooms, News Daily, the 5m context and the strategy engine. Nothing is computed outside the parity lane.
  - *Global decision* (first; owner decision 2026-11-06: the Global Conclusion and the strategy engine were redundant, so they are one card). It reads `GET /api/conclusion/global`, which carries the full strategy, and shows:
    - the decision, direction, global bias with its score, confidence, price and the 1H ATR;
    - the strategy headline;
    - one row per timeframe (D1, 4H, 1H, 15m, 5m) plus News: its lean as a diverging bar with a −100 to +100 value, whether it passes the strategy, and its note on hover;
    - the plan ladder (TP2, TP1, entry, stop with prices, the level behind each, and the RRR against the 1.5R minimum);
    - vetoes and cautions;
    - the H1 chain decision and the R38 confirmations as a reference.
    - **Lean vs bias:** a bias is the BULLISH, BEARISH or NEUTRAL label each agent gives. A room's lean is the confidence-weighted mean of its agents' biases, from −1 to +1; inside ±0.15 the strategy reads it as neutral.
  - **Chart zones** (owner request 2026-11-06): the price chart draws the candidate zones as bands behind the candles, using a lightweight-charts series primitive (`ui/src/lib/zones-primitive.ts`).
    - Bands are coloured by role (support green, resistance red, at price cyan) and shaded by strength. Labels show only where there is room.
    - The strategy plan's entry, stop, TP1 and TP2 are drawn as price lines, with the RRR on the axis label.
    - The "Zones" button toggles both, and is remembered per viewer.
  - *Key levels* (second; one panel since backlog item 18, owner approval 2026-11-09, `ui/src/components/KeyLevels.tsx`, which replaced the separate Levels card and Key Level Agent panel): one price axis for both. Left lane: the Camarilla set of the active tab's chart (H6 to L6, the H3–L3 range shaded; a set picker when the snapshot carries several) with the daily and weekly pivot ranges. Right lane: the Key Level Agent's zones of every chart, candidates coloured by role and shaded by strength. The price is one dashed line across both. The axis is fitted to price, the candidate zones and H3/L3/H4/L4, plus anything within half again of that reach; a level beyond it is listed at its edge with its price. Below: the close's place in the Camarilla, the six nearest candidate zones with their range, strength and leading levels (hover lists every level), and the agent's summary. Without the Global Conclusion the panel shows the Camarilla side alone.
  - *Global Conclusion* (data only, no card of its own; `GET /api/conclusion/global`, `src/global-conclusion.mjs`, deterministic, no model call). One multi-timeframe summary of the D1, 4H, 1H and 15m War Rooms and News Daily:
    - the global bias from the weighted room leans (below);
    - a heat strip of the five leans, with stale rooms faded;
    - how many timeframes agree;
    - a summary;
    - the action.
    - The action is the strategy engine's decision. Without a strategy it falls back to the H1 decision, which becomes WAIT when the global bias leans against it. The H1 chain decision shows as a reference.
  - *Market sentiment:* a semicircle gauge from −100 (bearish) to +100 (bullish): the Global Conclusion's score.
    - It shows the weighted mean of each room's lean: D1 30, 4H 25, 1H 20, 15m 15, News 10. A missing input drops out and the rest renormalise.
    - A room's lean is the confidence-weighted mean direction of its agents (BUY +1, SELL −1, WAIT, HOLD and CLOSE 0). News lean is (bullish − bearish) over all tagged headlines.
    - Under the gauge, a donut shows the headline biases of the last 24 hours.
  - *Trend by timeframe:* one diverging bar per timeframe: D1 macro trend, 4H intraday trend, 1H swing trend, 15m structure, 5m confirmation.
    - Each bar carries the room's lean, the moderator's action and one line of interpretation.
    - The 5m row uses the 5m context bias, at full weight when a confirmation printed.
  - *Levels* (`GET /api/hud/levels?tf=15|60|240|1D`, `src/hud-levels.mjs`): a vertical Camarilla ladder from H6 to L6 for the active tab's chart.
    - Shaded zones: the H3–L3 range, the H4–H5 breakout zone and the L4–L5 breakdown zone.
    - Chips switch between the 15-minute, 1-hour, 4-hour, daily and weekly sets.
    - The daily and weekly pivot ranges show as bands, or as edge markers with their price when far away. The close is a marker.
    - It reads "from verified bars" when the candle's bar is verified (see the three calibration tiers).
  - *Regime:* a radar of six engine sensors of that chart, each scaled 0–100: trend (Hurst), efficiency, stretch (|z| of 3), volume (of 2× average), cycle agreement and order (1 − entropy). A chaos flag is shown. It is not yet calibrated.
  - *Agent consensus:* one stacked bar per room of its agents' stances.
  - *Macro drivers 24h:* diverging bars for gold, DXY, WTI oil and USDT dominance, with whether the gold–dollar inverse link holds.
  - *Session clock:* a 24-hour ring of the Tokyo, London and New York sessions in New York time, as the Chronos Matrix defines them, with a needle at now.
- **Agent compliance and decision cards (Aether phase A1, owner go 2026-11-07; `docs/RFC_AETHER_KNOWLEDGE_GUARDIAN.md`).** Both are read-only over the rooms: they never change a message, a stance, a conclusion or a decision.
  - **Compliance** (`src/compliance.mjs`, D1 `compliance_checks`, migration 0011): the sweep checks every stored room message once (openings, Consensus Discussion answers, conclusions of the 15m, 1H, 4H and D1 rooms). The checks:
    - `order_wording`: order, size or lot wording.
    - `stance_bias_conflict`: BUY with a bearish bias, or SELL with a bullish bias.
    - `calibration_talk`: parity, calibration or verification named in the text, against the rule "Agents never mention calibration in their text".
    - `natural_language`: field names, evidence paths or key=value in the text.
    - `data_scope`: a HUD or indicator agent names another agent's indicator.
    - `GET /api/compliance?days=7` returns rule breaks per 100 messages per agent and room. Nexus shows them on the Scorecards page.
  - **Decision cards** (`src/decision-cards.mjs`, `GET /api/decision-cards?chart=60&limit=6`): one card per room conclusion, for Aether. Each card holds:
    - the conclusion, the crowd line and each agent's final stance, bias, confidence and claim;
    - the H1 decision and the confirmation booleans;
    - the open stuck states, the compliance findings, the scored outcomes, and the provenance (scoring version, KB hash, parity).
    - **No levels:** never an entry, stop, target, plan, zone, key level, close or ATR. Price-like numbers in agent text become "[level]", and a test walks every key and string.
- **Macro War Room (owner decisions 2026-11-08, `src/macro-room.mjs`, thread `macro:XAUUSD`).** The correlations become a room that discusses the news and the scheduled events that move gold.
  - **Agents:**
    - the Calendar Agent (fixed-rule projections; before a release its bias must follow the consensus lean, after it the headlines decide);
    - the News Analyst;
    - the Dollar Analyst (DXY), the Rates Analyst (US 10-year) and the Metals Analyst (silver): changes and correlation with gold, never a gold price level;
    - the Oil Analyst (owner request 2026-11-08, "geopolitics causes inflation"): WTI crude oil (`TVC:USOIL`, its 1h series derived from the 5m pull GMI already makes, sampled at gold's 4h closes, so no new TradingView call), its changes and correlation with gold, and the News Daily headlines on oil or geopolitics (supply, OPEC, sanctions, conflict, shipping routes). The rule it reads: a supply shock or conflict that lifts oil raises inflation expectations and safe-haven demand, which usually supports gold, unless the same rise pushes yields and Fed expectations higher;
    - the Correlation Analyst (gold against the dollar, yields, silver and oil).
  - **Phases:**
    - bus;
    - Consensus Discussion: the agents whose bias differs from the room's, at most 4;
    - the moderator's macro bias for gold over the next 4 to 24 hours, with reasons and drivers. A BULLISH or BEARISH conclusion needs an agent holding it.
  - **Schedule:**
    - 20 minutes after each 4-hour gold close and 30 minutes after a High-impact USD event (same-minute events share a session);
    - each session once, within 3 hours, at most one per sweep;
    - behind `MACRO_ROOM_ENABLED`, within `MACRO_ROOM_MAX_CALLS_PER_HOUR` (30); about 12 calls a session with the Oil Analyst.
  - **Context only:**
    - every room's News Analyst reads the latest conclusion (8 hours fresh);
    - the Global decision shows it as a MACRO row outside the weighted score;
    - it never changes the strategy engine's decision.
  - **Read:** `GET /api/macro`; Nexus `#/correlations` ("Macro War Room").
- **Signal Ledger (owner request 2026-11-07, `src/signal-ledger.mjs`, D1 `signal_ledger`, migration 0010).** Every directional signal, followed to its outcome in R. Advisory only: R multiples of the advice, never money, lots or positions. It never feeds a room, a prompt or a decision.
  - **Sources:**
    - `h1_decision`: the Reasoner's BUY/SELL from `trade_decisions` (entry, stop, one take profit).
    - `strategy`: the strategy engine's TRIGGERED setup (entry, stop, TP1, TP2), recorded by the sweep. It is recorded at most once per hour, and only when no signal of the same side is pending or open.
  - **Rules:** the simulation runs on closed 15m bars, falling back to 1H bars before the 15m series starts.
    - The entry is a limit order. It fills when price reaches it within 8 hours.
    - Before the fill, a stop touch cancels the signal as `invalidated`, a TP1 touch cancels it as `target_before_entry`, and no touch at all cancels it as `unfilled`.
    - Once filled, two policies run side by side: exit at TP1, and exit at TP2. Each ends at its target, at the stop (−1R), or after 72 hours at the close.
    - A bar that reaches both the stop and the target counts as the stop and is flagged as ambiguous.
    - MFE and MAE are kept in R.
  - **Run:** in the parity sweep, every 15 minutes.
  - **Read:** `GET /api/ledger?days=30` returns per source and in total: win rate, expectancy, total R, profit factor, maximum drawdown, fill rate, the equity curve and the signals. Nexus shows it on the Performance page.
  - **Alerts (backlog 11.2, owner decision 2026-11-08: Telegram; `src/ledger-alerts.mjs`, D1 `ledger_alerts`, migration 0017).** After each ledger run the sweep sends each new ledger event once over the existing Telegram bot (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`):
    - `setup`: a strategy-engine setup triggered (the H1 decision already has its own Telegram message);
    - `entry`: the entry was reached;
    - `exit`: TP1, the stop or the time limit was reached (with the R result);
    - `closed`: the TP2 part of a two-target setup ended;
    - `cancelled`: a setup that will no longer fill (invalidated, target before entry, or unfilled).
    - Each message ends with "Advisory only: no order is placed and no position size is given." It never gives a lot size or a position.
    - The first run records the events that already exist without sending them, so a deploy never floods the chat. At most 5 messages a run; a failed send is retried by the next run. Only signals opened in the last 7 days are looked at.
    - Off with `LEDGER_ALERTS_ENABLED = "false"`; nothing is sent without the bot secrets.
  - **The H1 decision message (owner decision 2026-11-08, `src/h1-telegram.mjs`):** sent only for a BUY or SELL, or when the decision changes from the previous bar's; a WAIT after a WAIT is not sent. The previous decision is kept in `SIGNAL_CACHE` (`telegram:h1:last-decision:v1`), so the same bar is never sent twice. `H1_TELEGRAM_MODE = "all"` restores one message per bar.
    - **Read:** `GET /api/alerts?days=7` (read-only; never sends and never creates the table): `enabled`, `switch_on`, `bot_configured` (a boolean, never a secret value), `started`, `pending` (the events the next sweep would send, with their text) and `recorded`. Nexus shows it on the Alerts page.
- **Nexus UI (owner decision 2026-11-06).** Nexus uses the obsidian design of the Cerebrum Console (`cryptophys-cloud-platform` `workers/console/ui`), because it will merge into the Console control panel. The `nexus` subdomain will later replace `home`.
  - **Stack:** the same as the Console: React 18, Vite, Tailwind with the obsidian palette, lucide-react, framer-motion, and three.js for the neural-mesh background. The chart uses lightweight-charts.
  - **Aether page** (owner 2026-11-09: `nexus.cryptophys.work/aether`, behind the same Cloudflare Access sign-in): the canon and its doctrine, the decision cards and their ingest, the AI budget and vector indexes, the room quorum weighting of each timeframe (active point, regimes, agent weights, candidates, reverse shadow, history), the guardian's compliance findings of the last 24 hours and the knowledge proposals. Read-only, from `GET /api/aether/overview` (Service Binding `AETHER` to `cryptophys-aether`, entrypoint `AetherReader`). The app reads its page from the path when there is no hash, so `/aether` and `/#/aether` both open it.
  - **End-to-end sync** (hardening 2026-11-09, `src/aether-sync.mjs`): the AI Worker reads Aether's `AetherReader.sync()` every 15 minutes through a second, read-only binding `AETHER_READER` and adds this side's checks: Aether reachable, the KB v4 hash of Aether's canon equal to this repository's (`kb_match`; a KB change here needs a re-import there) and its own card push within 2 hours. Aether's checks are card ingest, the canon index, the embedding backlog, each timeframe's weighting report and the AI budget; each is ok, warn, or idle while the market was closed. Every warning is a health alert (`aether_sync:<check>`, the Priority Queue and a kernel report); `GET /api/aether/status` carries the combined status, and the Aether page shows both. The Nexus deploy smoke test reads `/api/aether/overview` (canon, sync checks, no price field).
  - **Build and serving:** the source is in `workers/xauusd-nexus-dashboard/ui`. It is built into `ui/dist` and served as Workers Static Assets (`run_worker_first`). The deploy workflow builds it; `validate-nexus-dashboard.yml` builds it on pull requests.
  - **Layout:**
    - Same header, glass panels and status footer as the Console.
    - **Left sidebar (owner request 2026-11-07):** navigation grouped by analytic layer. Live: War Room, System status (`#/status`: the Workers and lanes (with the TradingView alerts lane: last accepted alert and the last hour's 401s, `ai_worker.webhook` of `/api/status`), the Priority Queue, the pull adapter series and budget, and the parity registry and recent comparisons from `GET /api/parity`; the War Room shows a System issues panel only when a lane is amber or red). Analytics: Performance (`#/performance`), Scorecards, Shadow versions. Market: Economic calendar, Correlations. Intelligence: Decision audit (`#/audit`), Alerts (`#/alerts`). The Decision audit shows the decision card of each room conclusion (15m, 1H, 4H, D1: final stances, opening claims, crowd line, rule breaks, outcomes; no levels), the rule breaks of the last 7 days (`/api/compliance`) and the push status to Aether (`/api/aether/status`). The Alerts page shows the Telegram alert state (`/api/alerts`): whether the bot is configured, the events the next sweep would send, and the recorded ones. The Economic calendar (`#/calendar`) shows the week's events: by default only the High-impact USD ones, with a switch for all. Events inside the gate window are highlighted.
    - **Correlations (`#/correlations`, 2026-11-08).** `GET /api/correlations` (`src/correlations.mjs`) shows gold beside DXY, the US 10-year yield and silver on closed 4h bars:
      - the last close and the change over 4h, 1 day and 5 days (basis points for the yield);
      - the Pearson correlation of 4h returns with gold over 30 bars (about a week) and 120 bars (about a month);
      - each series is as-of aligned to gold's 4h closes.

      It is context only and reaches no room or decision. On phones the sidebar opens from the menu button.
    - Left: Priority Queue, War Room agents and Worker status.
    - Center: the chart, then the War Rooms card with its tab bar `News | 15m | 1H | 4H | D1`.
      - **Chart layers (owner decision 2026-11-08, PR 3 of the key-level plan):** a row of toggles above the chart, kept per viewer.
        - **On by default:**
          - *Zones* (the Key Level Agent's candidate zones and the strategy plan);
          - *Bands* (Z-KWW mean, ±1σ and ±1.618σ, and EMA 114, computed in the browser from the chart's closed bars with the Mizan formulas);
          - *Volume* (the session POC, VAH and VAL of the chart plane).
        - *Fib*: Auto by default. The OTE band (0.618 to 0.786), 0.5 and the 1.272 and 1.618 extensions of the chart plane's leg show by themselves while a setup forms (SETUP_FORMING to TRIGGERED). The toggle cycles Auto, On and Off.
        - **Toggles:**
          - *VWAP* (5m to 1H only);
          - *Liquidity* (whale zones and mitigation blocks, the nearest FVG targets, QM and RBS/SBR);
          - *Session* (the true day, week and month opens).
        - The levels come from `GET /api/hud/levels`, which now serves the snapshot's `chart_plane`. The 5m chart reads the 15m plane.
      - **Key levels panel (right):** the level count of each reader (Band, Liquidity, Projection, Session), the setup type at the 15m location with its evidence, the Camarilla set and the zones on one price axis, and the nearest candidates; hovering a zone lists its levels and their reader.
    - Right: the trading assistant panel (charts).
    - On narrower screens, the side panels move under the center instead of hiding.
    - Shadow versions are at `#/shadow`; `/shadow` redirects there.
  - **Read-only:** the Worker forwards only GET/HEAD `/api/*` calls to the AI Worker.
- The AI Worker's old `/dashboard` page (Analyst/Counselor/Reasoner chat timeline and raw output) is retired. `GET /dashboard` redirects (302) to the Nexus dashboard (`NEXUS_DASHBOARD_URL`, default `https://nexus.cryptophys.work/`).
- The dashboard shows agents by name only: Technical Analyst, News Analyst, Risk Manager and Moderator. It never shows model names.
- Agent text must be natural language: validators reject snake_case field names, dotted evidence paths and key=value pairs in insights, summaries and dissent (`src/natural-language.mjs`). Evidence paths stay in `refs`.
- The fail-closed WAIT reasoning is plain language too (`describeDegradedEvidence`).
- **H1 `trade_plan`** (`src/trade-plan.mjs`, RFC_HUD_AGENTS §7):
  - The Reasoner prompt (`TRADE_PLAN_RULE`) asks for `trade_plan` on BUY or SELL. It covers action, entry, invalidation, take profit, exit reason, progressive stop and zone.
  - `parseDecision` validates the plan with `validateTradePlan`:
    - the prices must be positive, correctly ordered for the side, and equal to the decision's validated `entry_price`, `stop_loss` and `take_profit`;
    - the progressive stop must lie between invalidation and take profit;
    - the zone needs `low <= high` and a side of DEMAND or SUPPLY;
    - unknown keys, such as grid levels, are dropped.
  - An invalid plan becomes null, with `trade_plan_errors` recorded. The decision itself is never changed. WAIT and NO_TRADE never carry a plan.
- **H1 decision text is plain language too** (`src/plain-decision.mjs`):
  - The Reasoner prompt carries `DECISION_TEXT_RULE`.
  - When the reasoning, confirmation or invalidation text still reads like code (field names, key paths, `key = value`, `==`), one call to the bus model rewrites only those fields.
  - The decision, confidence, prices and conditions never change.
  - A rewrite that still reads like code, or that adds a new standalone number, is rejected, and the original text stays.
  - `decision.text_rewritten` lists the rewritten fields. The raw reasoner output stays in the synthesis.
- In news threads and the live room, an answer that fails only the natural-language check gets one correction call (`corrections` in the message body). That call is counted by the hourly budget and never runs past the budget or the wall deadline. A second failure stays `invalid_output`.
- TradingView webhook reading (`src/webhook-interpretation.mjs`):
  - It decodes the three alerts of each H1 candle into plain sentences: Prophet R38, Prophet R37 and GMI v12.70.
    - It covers signal, trade-management state, divergence or structure break, confirmation candle, GMI verdict and confluence gate.
    - It also gives an overall lean.
  - The codes follow the Pine sources exactly.
  - It is deterministic, never a model output, and never changes the H1 decision.
  - It is served by `GET /api/decision/:key` (`tradingview_reading`) and in the Threads 1H post (`post.tradingview`). Nexus shows it as "TradingView signals (H1)".
  - It is fed to the bus technical agent (evidence key `tradingview`, no underscore so the model does not echo a field name), which must interpret each indicator by name, even on WAIT.
  - It is also fed to the bus moderator, to news threads (technical side) and to the live room (as the H1 backdrop).
- Neither feature writes into the H1 chain's evidence, prompts or decision. Stances are discussion only: no orders.
- `POST /preview/news-analysis-fixture` exists only when `PREVIEW_FIXTURES_ENABLED` is `"true"` (set only in `wrangler.preview.jsonc`), so preview-e2e can prove a news thread.

### HUD agents (Phase C, `HUD_AGENTS_ENABLED`, on in production since 2026-11-05)
- Owner request, 2026-11-04: every HUD in the installed Pine indicators becomes its own agent.
  - Each agent is named after its HUD.
  - Each agent analyses only the data its HUD produces.
- The brief for the VPS agent is `docs/BRIEF_HUD_AGENTS.md`. It covers the HUD inventory, the rules, and an assessment → RFC → flagged implementation sequence.
- Owner decisions, 2026-11-05:
  - the untitled Prophet R38 top-right HUD is named "Prophet";
  - Matrix & Omega Sensors gets one agent per titled section.
  - That makes 14 agents in total.
- Phase A assessment: `docs/HUD_AGENTS_ASSESSMENT.md` (PR #66). The owner's answers (2026-11-05) are in `docs/BRIEF_HUD_AGENTS.md`:
  - HUD agents also speak in the live 15m room, on 15m HUD data that must be parity-verified like H1.
  - Verification uses a Pine candidate alert that carries the HUD fields, installed by the owner for H1 and 15m.
  - Rows that cannot be recomputed locally become output of the H1 decision reasoning.
  - The R37 Funnel is read per current candle.
  - `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30`.
- RFC: `docs/RFC_HUD_AGENTS.md` (PR #69).
- Owner decisions, 2026-11-05:
  - Aegis joins the live 15m room;
  - HUD data must be verified through a Pine candidate comparator;
  - the candidate ships first (C1).
- The Phase C order (C1–C7) is in `docs/BRIEF_HUD_AGENTS.md`.
- **Live War Room 15m** (`src/war-room.mjs`, behind `WAR_ROOM_ENABLED`, on in production; owner decision 2026-11-05). At every 15m close, every agent discusses in one room, in three phases:
  1. **Communication bus.** Each agent posts one opening claim from its own data only. The agents (owner decision 2026-11-06: the 15m room has no H1 Desk):
     - **15m Desk:** the parity-approved 15m Prophet R38, R37 and GMI records of the candle, in plain sentences. It speaks at 0.4 or lower when they are not approved.
     - **Higher-Timeframe Desk:** retired 2026-11-09 (independent rooms); the 15m room no longer reads the H1 chain.
     - **News Analyst.**
     - **Technical Analyst:** the 15m candles (the 5m execution read is retired, 2026-11-09).
     - **Risk Manager.**
     - **One agent per computed 15m HUD** (13).
  2. **Consensus Discussion** (until 2026-11-07 called the debate; stored steps keep the `debate:` prefix). At most 8 speakers answer named agents. It is open for at most 3 minutes, then closed.
     - **Who speaks** (owner decision 2026-11-06: decision and bias are different things):
       - agents whose action differs from the bus majority;
       - agents whose bias leans against the room's bias (the confidence-weighted bias of the bus, NEUTRAL inside ±0.1; against a NEUTRAL room every leaning agent counts), by confidence;
       - when anyone dissents against a BULLISH or BEARISH room, its strongest holder, to defend it;
       - the Risk Manager.
     - **Why:** production 13:30, 2026-11-06: all 18 agents said WAIT, 11 leaned bearish and 3 bullish, and only the Risk Manager debated, because speakers were chosen by action alone.
     - When the action is unanimous but the bias is split, the debaters argue the bias.
     - Every rebuttal gives its bias too. A dissenter the bus persuaded may concede instead: its stance or bias changes, it may name nobody, and it is kept as `conceded: true` (2026-11-06).
  3. **Conclusion.** The moderator concludes for the Nexus main panel: the **decision** (`stance`: what to do now, under the confirmation rule), the room's **bias** (`bias`: where the weight of the evidence leans, BULLISH, BEARISH or NEUTRAL, even when the decision is WAIT), a summary that states both first ("Decision WAIT, bias bearish: …"), up to 3 reasons, and the agents that still disagree.
     - A BULLISH or BEARISH bias needs at least one agent holding it (`bias_without_support`, one correction call). A missing bias is the room's computed bias, stored as `majority_bias`.
     - Nexus shows the decision and the bias side by side. The 1H, 4H and D1 rooms follow the same rules.
  - **Bias beside the action** (owner decision 2026-11-06, Prophet audit).
    - Every opening states its action (BUY, SELL, HOLD, WAIT or CLOSE) and its `bias` (BULLISH, BEARISH or NEUTRAL): the direction its own data leans, even when the action is WAIT for lack of a confirmation.
    - Room leans (Trend by timeframe, Global Conclusion) read the bias. Openings stored before the bias existed use the action.
    - Nexus shows the action with "bias …" next to it.
  - **A BUY or SELL conclusion needs support** (owner decision 2026-11-06).
    - At least one agent on the bus or in the debate must hold that stance; a confirmation alone never overrules the whole room.
    - A conclusion that breaks this rule, or "no confirmation, no entry", gets one correction call telling the moderator which rule it broke, then is rejected. The 1H, 4H and D1 rooms apply the support rule and the quorum instead of the confirmation (2026-11-09).
  - Until 2026-11-09 the H1 decision was the constraint ("H1 decision: X"); the independent 15m room no longer reads it. Price levels never come from a room.
  - **Calibration status once** (owner decision 2026-11-05, option A).
    - The brief stores each agent's evidence status: for a HUD agent, its verified lines, its lines computed from verified bars and its total lines; otherwise the source label. Nexus shows it once, as a badge next to the agent.
    - **Three tiers per HUD statement** (`src/hud-reading.mjs`, owner decision 2026-11-06, option 1):
      - *Verified by parity:* every field it uses is a TradingView alert field equal to the parity-approved record of the candle.
      - *Computed from verified bars:* a pure formula of closed bars, with no engine internal behind it: the Camarilla levels and bands (The Interstellar Eyes), the daily and weekly central pivot ranges and the trading sessions (Chronos Matrix). It applies only when the candle is in the trusted lane (an approved record exists) and its parity comparison matched, which includes the input bar (open, high, low, close, volume), with no `input_mismatch` (`barsVerified` in `src/hud-store.mjs`). The higher-timeframe bars behind Camarilla and the pivots come from the same TradingView feed and are not compared separately.
      - *Not yet calibrated:* an engine internal no TradingView comparator has checked.
    - Agents never mention calibration in their text.
      - **Enforcement (2026-11-07, after Aether's first compliance finding):**
        - A valid room answer (War Room, timeframe room or HUD thread) whose text talks about parity, calibration, comparators, "unverified", "verified by" or "parity-verified" gets one soft correction (`CALIBRATION_CORRECTION`).
        - The answer is never rejected for this. When the correction fails, keeps talking about calibration or changes the stance, the first answer is kept, and compliance records it.
        - The rule term "a verified 5m confirmation" is not calibration talk.
        - The natural-language examples no longer say "verified by parity".
    - A HUD agent with no statement in the first two tiers speaks at confidence ≤ 0.4.
    - The bus shows each agent's evidence, and the moderator weighs verified and bar-computed evidence above uncalibrated readings.
  - **No confirmation, no entry** (owner rule 2026-11-05).
    - BUY needs a confirmed buy signal: the H1 Prophet R38 confirmation from the approved record behind the latest H1 decision (the one-bar event, or the setup still READY, `setup_state.buy_ready`, owner report 2026-11-09), or a VERIFIED 5m Prophet R38 confirmation candle. SELL needs a confirmed sell signal.
    - Without the matching confirmation the stance is WAIT, or HOLD / CLOSE for an open position.
    - The Risk Manager sees the confirmations, applies the rule in its opening, and rebuts every entry proposed without one.
    - A BUY or SELL conclusion without the matching confirmation is rejected (`entry_without_confirmation`).
    - Nexus shows the confirmation state under the conclusion.
  - **Quorum (2026-11-06):** within 5 minutes of the close (`WAR_ROOM_QUORUM_WAIT_MS`), a room with fewer than half of its agents heard does not conclude. The queue task is redelivered after 60 seconds (`WarRoomQuorumPending`), and only the failed openings are asked again. Past the wait, the room concludes with whoever spoke. Production 13:15 that day: Workers AI 3021 and 3040 failed 14 of 18 openings, and the room concluded on four agents.
  - The agents on the room agent model, the moderator on the moderator model, each with its own fallback (since 2026-11-07), within `WAR_ROOM_MAX_CALLS_PER_HOUR = 170` (about 30 calls per close since the three agents of 2026-11-07; 112, then 136 before; 170 since 2026-11-10 because the rolling hour can hold five rooms when one starts late). The timeframe rooms' cap is `TF_THREADS_MAX_CALLS_PER_HOUR = 140` (120 before). Messages are stored in `agent_thread_messages` (thread `warroom:<day>`, steps `brief`, `open:*`, `debate:*` and `conclusion`).
  - Read API: `GET /api/war-room/latest[?bar=<iso>]`.
  - When on, it replaces the legacy live room and the per-H1 HUD agents (their budget moves here). Turning it `"false"` restores both.
- Live: C0, C2, C3, C5, C6 and C7 are built. `HUD_AGENTS_ENABLED` is `"true"` in `wrangler.jsonc` (owner approval 2026-11-05, after the #94 preview-e2e proof). After each H1 synthesis, one agent per computed HUD (13) and a moderator post in Threads 1H, within `HUD_AGENTS_MAX_CALLS_PER_HOUR = 30`. At each 15m close, Trade Management, Kinetic Engine, Fabio AMT and Aegis Footprint speak in the live room, within `LIVE_ROOM_MAX_CALLS_PER_HOUR = 48`. Turning the flag to `"false"` stops new HUD posts at once.
- Backlog (owner, 2026-11-05): B4 (merge the GMI core copy) was done on 2026-11-09 with the owner's go for the full re-approval (one GMI engine, above). The Grid Bot Protocol HUD was ported on 2026-11-07 (below). All open work that waits on the market, a date or the owner is listed in `docs/BACKLOG.md`.
- **Grid Bot Protocol ported (2026-11-07, `local-engines/producer/src/grid-bot.mjs`):**
  - **What it computes:** Mizan `cshi_engine` on the chart's closed bars. It takes the spread toxicity and the price velocity, each smoothed with `ta.ema` over 5 bars, and the 14-bar efficiency ratio, and turns them into a viability score. The score is ranked over the last 100 bars with `ta.percentrank`.
  - **Deploy status:** GMI's status follows from the rank and the bar's GMI entropy: muddy waters (on), toxic chop (off), optimal (on), or trending / dead (off).
  - **Not HUD fields:** the grid range, trigger, count and TP/SL stay Reasoner output (RFC_HUD_AGENTS §7).
  - **Comparator (2026-11-07):** the GMI HUD candidate alert (`pinescript/candidates/Global-Multiverse-Interceptor-v12.70.hud.v1.txt`, source `gmi_v12_70_hud`) now also carries `cshi_viability`, `deploy_status` (1 muddy waters, 2 toxic chop, 3 optimal, 4 trending or dead), `muddy_waters` and `grid_viable`.
    - **Local side:** after each H1 publish, the pull adapter posts a separate `gmi_hud` record (`local-engines/producer/src/gmi-hud-producer.mjs`): the five GMI fields of the H1 `gmi` record plus the Grid Bot fields on the same closed bars. Its result never decides the H1 publish marker.
    - **Parity:** `gmi_hud` is its own identity (`ENGINE_PROVENANCE.gmi_hud`, `PARITY_FIELDS.gmi_hud`). The parity sweep compares it like an engine; 24 consecutive matching H1 candles approve it.
    - **Decision lane untouched:** `gmi_hud` is accepted at ingest (`INGEST_ENGINES`) but is not a `LOCAL_ENGINES` member. Fusion and the H1 chain never read it, and its mismatches never revoke `gmi` or block the trusted lane.
    - **Effect:** its trusted copy only marks the Grid Bot line as verified in the HUD readings (`src/hud-store.mjs`).
    - **Owner step:** install the GMI HUD candidate on the H1 chart (`docs/HUD_CANDIDATE_INSTALL.md`). Until its alert arrives, the comparison is `not_comparable` and the line stays unverified.
  - **Without GMI:** it is absent when GMI is.
- **Macro & Aether Sensors complete** (owner decision 2026-11-05: every TradingView metric becomes agent data). `local-engines/producer/src/macro-aether.mjs` computes every row of the Pine HUD for the H1 and M15 snapshots:
  - **Rows:** CONSOL. GRAVITY (TDM profile gravity), Z3 KINETIC SPREAD, MACRO CYCLE (DXY and USDT ROC), EST. MACRO SHIFT (macro kinematics on DXY and USDT 4h), ASSET GRAVITY (WTI RSI14 at the chart timeframe, from the USOIL M15 and H1 series), Q-GRAVITY PULL and MACRO SMR (the FVG reservoir).
  - **MTF HURST and MTF Z-SCORE** were already in the snapshot.
  - **Lookahead off:** the other series are read as last closed at the chart bar's close. TradingView's realtime bar can show a developing 4h DXY or USDT bar, so the macro rows may lag by one 4h bar.
  - **Unverified:** no row is a webhook field, so every row reads as unverified. A missing series leaves its rows absent.

### Outcome scoring and stuck states (RFC_INDICATOR_AGENT_PLATFORM P1)
- Code: `src/outcome-scoring.mjs`. Tables `outcome_scores`, `outcome_runs` and `stuck_states` (migrations `0005_outcome_scores.sql` and `0006_outcome_runs_version.sql`; also ensured at runtime). Rows carry `scoring_version`: candles scored by an older version are scored again within the lookback, and scorecards read only the current version. Owner approval 2026-11-05 for the definition.
- It is deterministic and reads prices only: the pull adapter's closed TradingView bars, from the same KV namespace (`SIGNAL_CACHE` = `MARKET_DATA_CACHE`). It never changes a decision, prompt or evidence.
- **What is scored, per closed candle, once its horizon has closed:**
  - **H1:** the chain decision (`chain:h1`), the bus round-2 agents and the moderator (`bus:*`), the HUD agents (`hud:*`), and the parity-approved indicator directions (`indicator:prophet_r38`, `indicator:prophet_r37`, `indicator:gmi_v12_70`).
  - **15m:** the live-room posts (`room:*`).
- **How:**
  - The entry is the statement candle's close, and the threshold is `0.5 × ATR(14)`, a simple average of the true range. The horizon is the next 4 closed candles.
  - BUY or SELL is a hit when the favourable excursion reaches the threshold first, a miss when the adverse excursion does (both in the same bar counts as a miss), and neutral otherwise.
  - WAIT (and NO_TRADE) is a `missed_opportunity` only when a 2:1 trade would have won: price reaches `1 × ATR` (`waitTargetAtr`) on one side before touching `0.5 × ATR` on the other, bar by bar. A bar touching both counts as the stop. The record keeps the winning direction. Otherwise WAIT is a hit, including in a whipsaw or a 1:1 move. This is scoring v3, owner approval 2026-11-05.
    - v1 counted any touch, and nearly every WAIT read as missed.
    - v2 counted any 1:1 win, and still marked H1 WAIT right on only 1 of 35 candles, because over 4 H1 candles some side almost always reaches `0.5 × ATR` first.
  - HOLD and CLOSE are not scored.
  - A Brier score is computed when the statement has a confidence.
- **Stuck states:** once an hour, over the approved H1 records of the last 24 candles. A Prophet or GMI state field (subtype, `b_enc`, `d_enc`, `t_enc`, gate, verdict, conflict) is stuck when it is unchanged for ≥ 8 candles while the high-low range of those candles exceeds `3 × ATR(14)`. Episodes open, extend and clear in `stuck_states`.
- **When:** in the parity sweep cron (`10-59/15`), after the backfill. Stuck-state detection runs in the first sweep of each hour.
- **Read APIs:** `GET /api/scorecards?days=30` (per subject: directional hit rate, WAIT accuracy, missed opportunities, Brier and sessions, plus the open stuck states) and `GET /api/stuck-states`.

### Indicator manifests and registry (RFC_INDICATOR_AGENT_PLATFORM P2, owner go 2026-11-07)
- **Manifests** (`src/indicator-manifests.mjs`): one per agent. They cover the engines Prophet R38, Prophet R37 and GMI v12.70, the Mizan library, the 14 HUD agents, the P6 indicator agents, the desks and the moderator. Each manifest gives:
  - kind and name;
  - family;
  - the Pine source and section it reads;
  - the reference: `pine_ssot`, `pine_candidate`, `builtin` or `none`;
  - its parity identity and HUD identity;
  - the rooms it speaks in;
  - its scored subjects, its stuck-state field prefix and its shadow family.
- **Hashed files:** the manifests wrap the existing code without changing any hashed file.
- **Generated from them:** the HUD roster (`HUD_NAMES`, `HUD_IDS`) and the agent families of the crowd line.
- **Registry** (`src/indicator-registry.mjs`, `GET /api/indicator-agents`): every manifest with its live state:
  - **Lifecycle:** `active`, `candidate` (an engine whose H1 identity is not approved) or `not_computed`.
  - **Parity:** every registry identity, per chart.
  - **Scorecards:** 30-day scorecards as an indicator and as a room agent per room.
  - **Stuck states and shadow versions:** the open stuck states and the shadow versions of the agent.
- Read-only. The P4 auditor in the platform can read it.

### New indicator agents: Supertrend and Order Blocks (RFC_INDICATOR_AGENT_PLATFORM P6, 2026-11-07)
- They are the first agents added through the manifest path (owner decision 4: Supertrend first, then Order Block). Both are computed in the HUD snapshot (`kind: "indicator"`), so they speak in every room, D1 to 15m, like a HUD agent.
- **Supertrend** (`local-engines/producer/src/supertrend.mjs`):
  - The TradingView built-in `ta.supertrend(3, 10)`, reproduced on the chart's closed bars: hl2, a Wilder ATR, ratcheting bands, and the direction from the previous line.
  - **Fields:** direction (1 bullish, -1 bearish), line, whether it flipped on this bar, bars since the flip, and the distance in ATR.
  - **Reading:** a pure formula of closed bars, so it reads as "computed from verified bars".
  - **Scoring:** its H1 direction is scored as `indicator:supertrend`. Its line is a key level (0.6 × the chart weight).
- **Order Blocks:**
  - No new definition: it reads the zones the parity-approved Prophet R38 order-block filter already tracks, plus GMI's Aegis validated blocks and mitigation zones.
  - **Fields:** active bullish and bearish blocks; the best block on each side (top and bottom); the next opposite block as a target; the filter status; whether price sits inside a validated block or a mitigation zone.
  - The best blocks' edges are key levels (0.7 × the chart weight).
- **Calibration:** neither has a comparator alert yet (reference `builtin` and `none`), so their readings carry no verified statement. The Supertrend reading counts as computed from verified bars.

### MT5 Expert Advisor (owner decisions 2026-11-09: "Langsung siap live", execution by an EA on the owner's terminal)
- `GET /api/ea/signal` (`src/ea-signal.mjs`, behind Cloudflare Access): one flat object for the EA: `kill` (`EA_SIGNALS_ENABLED = "false"`), `blackout` (the event gate: 2 hours before to 30 minutes after a High-impact USD event), the latest **Decision Engine** decision (since 2026-11-09, section "Decision Engine"; the H1 decision with `DECISION_ENGINE = "off"`) as `side` BUY, SELL or NONE with `action`, `entry`, `stop`, `tp1` (the key-level plan and the chosen target; a plan with a stop or target on the wrong side is never sent), `issued_ms` (the decided bar's close), `expires_ms` (the next close of that timeframe), `source`, and the feed's last 5-minute close (`market_price`) so the EA can turn the levels into distances from its broker's price.
- The EA (`ea/mt5/CryptophysXAUUSD.mq5`, guide `docs/EA_MT5.md`) runs on the owner's MetaTrader 5 terminal: it sizes from `RiskPercent` of equity and the stop distance, keeps the plan's stop and target distances, and never enters on an old or expired signal, in a blackout, above the spread limit, after the daily loss limit, beyond its position limit, or on a real account without `AllowLiveAccount`. `kill` closes its positions.
- `POST /api/ea/heartbeat` keeps the EA's last state in KV (`ea:heartbeat:last`, 2 days; no account number); `GET /api/ea/status` shows it beside the signal.
- The EA authenticates with a Cloudflare Access service token named `cryptophys-agent-*`, admitted by the platform's **Provision Cloudflare Access** workflow. The server holds no broker credential and gives no position size.

### Omega Execution Engine (owner decisions 2026-11-09: a page separate from Nexus and Aether; monitor + control; its own subdomain; per-position data from the EA)
- **Worker** `xauusd-omega` (`workers/xauusd-omega`), custom domain `omega.cryptophys.work`, no workers.dev or preview URL. A static page (no build) and `/api/overview`, `/api/deals`, `/api/whoami`, `POST /api/control`. Its only data path is the Service Binding `OMEGA` to the AI Worker's RPC entrypoint `OmegaGateway` (`overview`, `deals`, `setControl`).
- **Access:** the hostname is in the platform's Access application (`PUBLIC_HOSTNAMES` of `provision-access.yml`, ADR-0010 amendment of 2026-11-09). The Worker verifies the `Cf-Access-Jwt-Assertion` JWT itself on every request but `/health` (RS256 against `cryptophys.cloudflareaccess.com`, issuer, expiry, and the audience when the deploy could resolve `ACCESS_AUD`), so it fails closed. A control change needs a person (never a service token), a same-origin JSON request, a reason to pause or kill and the typed `KILL`; the page has a strict CSP (same-origin script and style, no inline code).
- **Control** (`src/ea-execution.mjs`, KV `ea:control`): `active`, `paused` (the signal carries `paused`: the EA makes no new entry and deletes its pending orders) or `killed` (the signal's `kill`, `kill_source` `omega`: the EA closes its positions and stops). Each change is audited in D1 `ea_control_events` (time, previous and new mode, reason, the Access email). `EA_SIGNALS_ENABLED = "false"` stays above it (`kill_source` `env`).
- **EA data:** the heartbeat (`POST /api/ea/heartbeat`, 16 KiB) keeps up to 20 open positions (`positions_detail`: ticket, side, volume, entry, stop, target, profit, swap, open time, signal) and the floating and today's P&L; each closed position is `POST /api/ea/deal` into D1 `ea_deals` (once per deal ticket and close time; side, volume, entry and exit, stop and target, profit, commission, swap, reason, signal, open and close times, account mode and currency). No account number anywhere.
- **Statistics** (`dealStats`, net = profit + commission + swap): trades, wins, win rate, net, profit factor, average win and loss, maximum drawdown; today (UTC), 7 and 30 days.
- v1 (above) never places an order. The broker engine below does, through the owner's own MT5 terminal. Omega is unrelated to the legacy `omega` execution swarm of `cryptophys-cloud-platform`, which stays prohibited and was never migrated.

### Omega broker engine (owner decisions 2026-11-09: "Omega memegang akses broker"; "halaman omega masih di nexus.cryptophys.work/omega; di halaman ini bisa input server, user, dan password untuk terhubung broker yang dipilih"; "Bridge di host ini"; "Mati sampai Anda aktifkan")
- **Who does what:** Omega decides and sizes (`src/omega-engine.mjs`, pure); the AI Worker keeps the state and runs the plan on each bridge sync (`src/omega-broker.mjs`, D1 `omega_settings`, `omega_connection`, `omega_bridge`, `omega_intents`, `omega_events`); the **Omega bridge** on the owner's MT5 host (`bridge/omega-bridge`, a Node daemon, plus `ea/mt5/OmegaExecutor.mq5` in the terminal) logs the terminal in and executes. Contract: `docs/OMEGA_BRIDGE_PROTOCOL.md`; install: `docs/OMEGA_BRIDGE.md`.
- **Credentials:** the page takes the broker server, login and password and encrypts them in the browser (`workers/xauusd-omega/public/omega-crypto.js`: AES-256-GCM, the key wrapped with RSA-OAEP SHA-256 to the bridge's RSA-3072 public key). D1 keeps only the envelope, the server name and a version; no Worker can read the login or the password, and none is ever returned to a browser. A new bridge key voids the stored envelope (`needs_reentry`). Disconnect bumps the version and the bridge clears the terminal login.
- **The bridge** reaches `POST https://nexus.cryptophys.work/omega/api/bridge/sync` with one Cloudflare Access service token whose client id is the Omega Worker var `OMEGA_BRIDGE_CLIENT_ID` (empty: every bridge is refused). It only makes outbound requests. Its executor state never carries a login.
- **Switches:** the engine plans nothing unless `OMEGA_ENGINE_ENABLED = "true"` (AI Worker var, `"false"` in this repository) **and** the page's Engine toggle is on. A real (or contest) account needs the typed `LIVE` arm; turning the engine off disarms it. A kill (`EA_SIGNALS_ENABLED = "false"` or the Omega control `killed`) plans one `close_all`, also with the engine off; `paused` stops new entries.
- **The plan** on each sync, from the EA signal (`eaSignal`: the Decision Engine's 15m decision, or the H1 decision with `DECISION_ENGINE = "off"`), the control, the settings and the executor state: nothing when the executor is missing, disconnected or older than 60 s; close a position against the signal; open at most once per signal (`open:<issued_ms>:<B|S>`) only before `expires_ms`, within `max_signal_age_ms` (10 min, like the EA), outside the event blackout, at or below `max_spread_points` (60), below `max_positions` (1) and above the daily loss limit (`max_daily_loss_pct` 2 % of the day's starting balance). SL and TP keep the plan's distances from the broker's own price (BUY from the ask, SELL from the bid). Volume = `risk_pct` (0.5 %, at most 2 %) of equity / the loss per lot at the stop, floored to the volume step; below the minimum there is no trade. Every skip is a note code; a change of the notes is one `plan` event. Further gates and management (reconciled with the code 2026-11-11, `src/omega-engine.mjs`): no new entry in the daily rollover quarantine (21:55 to 22:15 UTC, `ROLLOVER_QUARANTINE_UTC`); with `adaptive_volatility` (on by default) a stop closer than 0.75 x the symbol's ATR is widened to it (the volume is sized on the widened stop; the target distance is kept); a limit entry waits while price is more than 0.35 stops away; positions are closed on an `EXIT`/`REVERSAL`/mean-reversal signal; with `trailing_stop_r` a profitable position's stop moves to break-even; a farther TP2 or extended target moves the take-profit; a position of 0.02 lots or more banks half at 1.5R or its target (`tp1_scale_out`).
- **Intents:** ids of at most 31 characters (the MT5 order comment); `pending` → `sent` (first returned) → `done` or `failed` by the bridge's result, or `expired` after 2 minutes (a late result still lands). An open is never retried. A close or kill still needed after its attempt ended gets the next attempt id (`<id>:<n>`, at most 10). The bridge never executes an id twice.
- **Page** (`nexus.cryptophys.work/omega/` and `omega.cryptophys.work/`): Broker connection, Engine (settings, Arm live), Bridge & terminal, Intents, Engine events. Every URL in the page is relative.

### Corpus Oracle (owner 2026-11-11: "persiapkan engine baru bernama corpus oracle yang akan melakukan feeding data ke local lane dari live mt5 terminal sesuai dengan broker, pair dan user active dari omega"; `src/corpus-oracle.mjs`, docs/RFC_CORPUS_ORACLE.md)
- **Phase 1, the corpus** (`CORPUS_ORACLE_MODE = "off"` by default, `"shadow"` to collect). The Omega executor writes the broker's closed M1 bars of the symbol it trades (`omega/corpus.json`, UTC, no login), the bridge sends those after the server's cursor with each sync (`corpus`), and the AI Worker keeps a bar only from Omega's active broker (the terminal's server equals the stored connection's), pair (the executor's symbol) and user (the stored connection, its version recorded): D1 `corpus_bars` (14 days), `corpus_sources`; the sync answers `corpus_cursor_ms`.
- **Measured** at `GET /api/corpus/status`: freshness, missing minutes, complete 15m bars and the basis against the TradingView 15m series (mean offset broker minus TradingView, its spread, largest offset, return correlation).
- **Feeds nothing yet:** no room, decision, plan or signal reads it, and no broker price leaves this Worker. Phase 2 (a reviewed PR) computes the local engines on the broker bars as shadow identities; they reach the decision lane only by earning parity (doctrine `parity_trust_only`).

### Room quorum weighting, tuned automatically per timeframe (owner decisions 2026-11-09, `src/weighting.mjs`, `src/weighting-replay.mjs`, `src/market-regime.mjs`)
- **Owner decisions of 2026-11-09:** "nanti aether yang akan membuat tuning persamaan pembobotan berdasarkan hasil learning, masing-masing agent akan diberi score pembobotan sendiri"; then auto-tuning without an operator ("Otomatis + pengaman"), adapting to volatility and market dynamics ("Per regime + shrinkage … berlaku masing-masing timeframe independent"). This replaces the first release's activation by approval in the Console.
- **Every timeframe has its own weighting**: the 15m, 1H, 4H and D1 rooms each build their crowd line (weights and quorum share) from their own active point, their own agents' records on that timeframe and the regime of their own bar. The crowd records `weighting`, `quorum_share` and `regime`; the moderator's validation (`entry_without_quorum`) and the H1 decision (`quorumOf`) read the same quorum.
- **Every room is scored** (`outcome_scores`, `agent:<id>`): the 15m and 1H rooms as before, and since 2026-11-09 the 4H (`240`, thread `tf:H4`) and daily (`1D`, thread `tf:D1`) rooms on their own bars, four candles ahead. On the daily chart a weekend is not a gap (`DAILY_MAX_GAP_MS`, 3.5 days).
- **The regime** of a closed bar, from that timeframe's own bars (`src/market-regime.mjs`): the 14-bar ATR as a share of the close, ranked against the previous 100 bars (low, normal, high tercile), and the 20-bar efficiency ratio (trending at 0.35 or more, else ranging): six regimes such as `high-trending`.
- **The equation** (`cryptophys.weighting.v3`), per agent and timeframe, from its scored calls within `days`:
  - decay d = 0.5 ^ (age in days / `half_life_days`), 1 without a half-life;
  - global accuracy acc_g = (Σ d·hit + prior/2) / (Σ d·decisive + prior);
  - regime accuracy acc = (Σ d·hit in the bar's regime + k·acc_g) / (Σ d·decisive in that regime + k), k = `regime_prior` (shrinkage toward the agent's own record); acc = acc_g without a `regime_prior`;
  - calibration = Σ d·(0.25 − Brier) / (0.25 · (Σ d + prior));
  - weight = clamp(2 · acc · (1 + `calibration_beta` · calibration), `weight_range`);
  - the quorum: more than `quorum_share` of the weight on the matching bias, plus `high_vol_quorum_bonus` in a high-volatility regime.
  - The default point (prior 10, weights 0.25 to 2, 30 days, no half-life, `calibration_beta` 0, quorum 0.5, no regime, no bonus) is exactly the P7 reputation weight.
- **The reviewed grid** (`WEIGHTING_GRID`): prior 5, 10, 20; weights 0.25–2, 0.5–1.5, 0.1–3; days 14, 30, 60; half-life none, 7, 14; `calibration_beta` 0, 0.5, 1; `quorum_share` 0.5, 0.55, 0.6; `regime_prior` none, 10, 30; `high_vol_quorum_bonus` 0, 0.05, 0.1. A change of the grid is a reviewed PR.
- **The replay** (read-only, no model call; the 15m and 1H rooms every hour, the 4H room every four hours, the daily room once a day): every concluded room of the timeframe in its window (15m 10 days, 1H 30, 4H 90, D1 365), each agent's final bias and its weight at the room's time (point in time: only calls whose horizon had closed, in the bar's regime). The replayed decision takes the room's direction from the moderator's bias and is BUY or SELL when more than the point's quorum share (in that regime) holds it, else WAIT; it is scored like every stance. Arms: the active point and every grid point one parameter away (16 candidates). Statistics as every shadow arm: paired one-sided sign test, Holm across the month's tests, 200 rooms for discovery, the newest 100 as a holdout.
- **Automatic activation** (`applyWeighting`, `autoDecision`): the candidate rated `better_than_active` on discovery AND holdout with the lowest Holm-adjusted p (then the larger gain) becomes active by itself, at most once every 7 days per timeframe, never a point that was rolled back before. The state lives in D1 `weighting_states` (one row per timeframe; the first release's 1H row in `weighting_state` is read until it is rewritten).
- **Rollback:** the reverse shadow compares the previous point with the active one on the rooms since the activation. After 100 rooms a previous point right significantly more often (sign test, p < 0.05) is restored automatically.
- **Telegram:** every activation and rollback is one message to the owner (`weightingMessage`: the timeframe, the change in words, the replay's accuracy against the active point and the holdout; no price).
- **Aether audits:** the report of each timeframe (`mode: "auto"`, its `timeframe` and regimes) goes to `KnowledgeIngress.ingestWeightingReport` when it changed. Aether no longer proposes weighting points; approval is no longer needed.
- **Kill switch:** `WEIGHTING_MODE = "default"` makes every room use the default point and stops every activation and rollback.
- **Read:** `GET /api/weighting?timeframe=15|60|240|1D` (the active point, each agent's weight, the regimes of the window, the replay, the reverse shadow, the history).

### Crowd line, reputation and scorecards (RFC_INDICATOR_AGENT_PLATFORM P7, owner go 2026-11-07)
- **Owner decisions of 2026-11-07:** the RFC's proposed values are accepted. That covers the scoring definition (horizon 4 candles, 0.5 × ATR, the v3 WAIT rule), the stuck-state thresholds (8 candles, more than 3 × ATR), and Supertrend first then Order Block (P6).
- **Room agents scored:**
  - Outcome scoring now covers the agents of the rooms that meet today: the Live War Room 15m (timeframe `15`) and the 1H War Room (timeframe `60`).
  - The subject is `agent:<id>`. The stance scored is the agent's final one: its Consensus Discussion answer, else its opening. The moderator's conclusion is scored as `agent:moderator`. A re-convened session (`#hud`) wins.
  - Each bar is scored once, with its own run marker (`outcome_runs` timeframe `<tf>:agents`), so bars already scored for the chain still get their agents.
  - Scoring starts with the bars after this deploy. The retired per-H1 HUD agents and the legacy 15m room keep their old subjects.
- **Reputation** (`src/reputation.mjs`):
  - It is computed per agent and chart over 30 days.
  - Decisive calls are BUY/SELL hits and misses, plus WAIT hits and missed moves.
  - The accuracy is shrunk toward 50 % with 10 pseudo-observations, so a new agent weighs 1 and earns its weight with its sample.
  - Weight = 2 × the shrunk accuracy, kept between 0.25 and 2.
  - In the 1H room, open H1 stuck states put a caution flag on the agents that read the stuck field (the 1H Desk, Prophet, R37 Funnel, Decision Matrix).
- **Crowd line** (deterministic, one per room and bar):
  - the stances and biases of every agent that spoke;
  - the same biases weighted by reputation;
  - a disagreement index (the normalised entropy of the weighted biases: 0 unanimous, 1 an even three-way split);
  - the agent families whose weighted lean goes against the crowd.
  - The families are a table in `src/reputation.mjs` until P2 manifests carry them.
- **Who uses it:**
  - The moderator of every room (15m, 1H, 4H, D1) receives it. If its bias differs from the weighted crowd, it says so in the summary; this is never a validation error.
  - The H1 Reasoner receives it in `CONSENSUS.crowd`. A weighted crowd against the room, or a disagreement above 0.7, lowers the Reasoner's confidence; it never reverses the room's bias on its own.
- **API:**
  - Every room read (`GET /api/war-room/latest`, `GET /api/threads/timeframe`) carries `crowd` and `reputation`, keyed by agent.
  - `GET /api/scorecards` adds `reputation.rooms` (`15m`, `1H`): name, family, decisive calls, accuracy, hit rate, WAIT accuracy, Brier and crowd weight.
- **Nexus:**
  - Each post shows its agent's record: accuracy, sample, crowd weight, and a CAUTION chip with the stuck state.
  - Each room shows a crowd line card under its conclusion: head-count and weighted bias bars, the disagreement, the families against the crowd, and whether it differs from the conclusion.
  - A new **Scorecards** page (`#/scorecards`) lists the room agents of each chart, the H1 decision, the indicators and the open stuck states.
- No limit on who speaks (owner decision 6, 2026-11-05): every active agent still speaks. The crowd line informs; it does not silence anyone.

### Shadow indicator versions (RFC_INDICATOR_AGENT_PLATFORM P3)
- Code: `src/shadow-versions.mjs`. Table `shadow_outputs` (migration `0008_shadow_outputs.sql`; also ensured at runtime).
- **What runs.** Once an hour, in the first parity sweep after the H1 close, every version is replayed over the pull adapter's cached H1 bars (`SIGNAL_CACHE`).
  - **Control** for each engine family (`prophet_r37@active`, `prophet_r38@active`): the active, parity-approved code with its default parameters.
  - **Candidates**: the same pure engine functions with different parameters. The engine files and their provenance hashes do not change.
- **Storage.** An output is stored only with at least 300 bars of history behind it. The first computation is final.
- **Scoring.** Every output is scored by the outcome scoring as `shadow:<version>` (`source = "shadow"`) once its horizon has closed.
- **Isolation.** Nothing here reaches a room, a prompt, the evidence or a decision.
- **Comparison is like for like.** A candidate is compared with its control only on bars scored for both.
  - **Accuracy:** right calls over decided calls. A directional hit and a WAIT hit are right; a miss and a missed opportunity are wrong; a directional neutral is undecided.
  - **Criteria:** a higher score that is significant, meaning a one-sided exact sign test with p < 0.05 on the bars where the two versions disagree and exactly one is right; no more stuck time (candles inside stuck episodes, § above: ≥ 8 candles with range > 3 × ATR); and a minimum sample of 200 bars. Brier does not apply, because indicator directions carry no confidence. Reference parity applies only to a Pine candidate (RFC decision 1).
  - **Discovery, Holm and holdout (Aether A8, RFC_AETHER §9.3, O12):**
    - **Holdout:** the newest 100 shared bars. The discovery test (the 200-bar minimum, the sign test) uses only the bars before them.
    - **Holm:** the discovery p-value is Holm–Bonferroni adjusted across the family's tests of the same calendar month. That set is the live candidates with a full discovery sample, plus the candidates stopped that month with their recorded p.
    - **Verdicts:**

      | Verdict | Meaning |
      |---|---|
      | `collecting` | The discovery sample is not full yet. |
      | `not_better` | The discovery test did not show a significant improvement. |
      | `holdout_failed` | Better in discovery, but worse than the control on the holdout. |
      | `better_than_active: ready for owner review` | Better in discovery and no worse on the holdout. |
  - **Control check:** the control is also checked against the approved local records of the last 24 candles (`matches_approved_local_records`).
- **Read model.** `GET /api/shadow-versions?days=30` (cached for 5 minutes) and the Nexus page `/shadow`.
- **Tuning view (Aether A8, `src/tuning.mjs`).** `GET /api/tuning` lists every `TUNING_GRID` point:
  - **running:** with its verdict, discovery test (Holm-adjusted) and holdout;
  - **stopped:** with the reason;
  - **untested.**

  It is read-only and starts nothing. A point starts only when a person approves it in Aether (the calibrator proposes the next untested point) or through a reviewed PR here. The Nexus `/shadow` page shows it as the "Tuning grid" panel.
- **Crowd replay (Aether A8 part 2, `src/tuning-replay.mjs`).** `/api/tuning` also carries `replays.crowd`, a deterministic replay of the reputation parameters behind the 1H room's weighted crowd line. It is cached for 5 minutes, stores nothing and reaches no room.
  - **Control:** the active parameters (prior 10, weights 0.25–2, 30 days, neutral band 0.1).
  - **Candidates (reviewed grid, at most 3):** `crowd@prior20`, `crowd@weight0.5-1.5`, `crowd@band0.2`.
  - **How a room is replayed:**
    - each agent's reputation is computed point in time, counting only scores whose 4-bar horizon had closed before the room met;
    - its bias is its final scored stance, the same rule for every arm;
    - the crowd stance is scored with the outcome of that stance on that candle.
  - **Statistics:** the same as the shadow versions (sign test, Holm, discovery minimum, holdout). It also reports the weighted crowd against the moderator on the same rooms.
  - **Promotion:** a better set is a proposal for an owner PR to `src/reputation.mjs`.
- **Strategy inputs (Aether A8 part 3, owner go 2026-11-08, `src/strategy-inputs.mjs`).** These records feed the replay of the strategy-engine thresholds.
  - **What is stored.** Once per closed H1 bar, at the first sweep 40 or more minutes after the close, the sweep stores what `buildStrategy` reads in D1 `strategy_inputs` (migration `0014`):
    - each room's agents (status, stance, bias, confidence) and conclusion;
    - the News Daily TLDR stance, the HUD snapshot fields and the confirmations;
    - the H1 chain decision and the closed bars.
  - **Format.** The inputs are slimmed to the fields the engine uses and gzip-compressed. A test proves the slim record gives exactly the strategy of the full inputs. The live decision and state are stored beside them.
  - **Outcomes.** Once the 4-hour horizon closes, each stance (BUY, SELL, WAIT) is scored once on the 15m bars and stored. The yardstick is 16 bars with doubled thresholds, about 0.5 and 1 H1 ATR. A replay therefore needs no old bars.
  - **Retention.** Kept 60 days.
  - **Isolation.** The table is never sent to the platform or to Aether, and it changes nothing in a room or a decision. `/api/tuning` shows the counts under `strategy_inputs`.
- **Strategy replay (Aether A8 part 4, `src/strategy-replay.mjs`).** `buildStrategy` takes its thresholds as `params` (default `STRATEGY_PARAMS`, the live values).
  - **What runs.** Each sweep computes, a few hours at a time, each arm's decision on every stored hour. The results are kept in D1 `strategy_replays` (migration `0015`), and replays of pruned hours are dropped.
  - **Arms:**

    | Arm | What it changes |
    |---|---|
    | `strategy@active` (control) | nothing: the live thresholds |
    | `strategy@rrr1.2` | the minimum reward to the final target |
    | `strategy@conf0.3` | the minimum confidence |
    | `strategy@near0.5` | the ATR distance that counts as "at a key zone" |

  - **Scoring.** Each decision is scored with the hour's stored outcome, using the shared statistics (sign test, Holm, discovery minimum, holdout).
  - **Drift check.** The control is checked against the live decision stored at capture. A mismatch is reported as `drift`.
  - **Where to see it.** `/api/tuning` shows `replays.strategy`. A better threshold is a proposal for an owner PR to `src/strategy-engine.mjs`.
- **Shadow knowledge arm (Aether A7, `src/shadow-knowledge.mjs`).** It is off unless `SHADOW_KNOWLEDGE_ENABLED = "true"`.
  - **Which items.** At most 2 approved text items of the learned pack (caution or role reminder) are tested at once.
  - **Which agents.** An agent qualifies when it is in the item's audience, sat in the 1H room and answered there.
  - **The call.** That agent makes one extra opening call on the same bar, with the same data and prompt plus the note line.
  - **A/A noise check (O13).** While the first item runs, the same prompt is also asked once more without the note.
  - **Timing and budget.** The calls run after the room and its H1 decision, never before them. They are capped at `SHADOW_KNOWLEDGE_MAX_CALLS_PER_HOUR` (default 8, at most 24).
  - **Storage.** Answers go in D1 `shadow_agent_outputs` (migration `0016`), with the agent's real opening stance as the control. Both are scored there on the H1 bars, never in `outcome_scores`, so no scorecard or reputation sees them. Rows are kept 60 days.
  - **Isolation.** The answers are never shown in a room, on the bus, in the crowd line, to the moderator or the Reasoner, or in a decision.
  - **Where to see it.** `/api/tuning` shows `replays.knowledge`, with the verdicts and the noise rate.
  - **Promotion.** A better note reaches agents only through the bundled pack, in an owner PR (A9).
- **Bundled learned pack (Aether A9, `src/learned-knowledge.mjs`).** The source is `knowledge/learned/pack.json`, bundled as `src/learned-knowledge.generated.mjs` by `scripts/build-learned-knowledge.mjs --write`, like KB v4. It is empty today.
  - **How an item gets in.** The script's `--add <export> --tuning <tuning> --items id@v` copies an item only when its shadow verdict is `better_than_active`. That change, in an owner PR, is the promotion (K9).
  - **Test gates.** Tests fail when the generated module is stale or an item breaks the rules:
    - plain words, no 3+ digit number and no order wording;
    - its numbers in its evidence;
    - provenance with at least 10 cards and the canon hash;
    - a shadow verdict.
  - **Selection is deterministic.** An item applies when the agent is in its audience, the chart matches and the situation matches the bar (the session, for a caution; a role reminder always applies).
  - **Budgets.**

    | Consumer | Notes | Characters |
    |---|---|---|
    | Agents | at most 2 | at most 400 |
    | Moderator | at most 3 | at most 600 |

  - **Where it goes.** The block is placed after the agent's own data in the 1H, 4H and D1 room openings and conclusions. The room brief records `learned_pack` (version, sha and the notes each agent saw).
  - **Switch.** It is off unless `LEARNED_KNOWLEDGE_ENABLED = "true"`; turning it off restores today's prompts. KB v4 always takes precedence. The 15m War Room and the H1 Reasoner do not read the notes yet.
- **P5 review (owner decision 2026-11-07):**
  - `prophet_r37@latch12` and `prophet_r38@latch8` are stopped; they are listed under `retired` in the view.
  - `prophet_r37@latch8` runs until 30 decisive pairs or 2026-12-07.
  - The GMI candidates run until their 200-bar sample (review around 2026-11-14).
  - Each running candidate carries a `review` with its date, rule, decisive pairs and `due`.
- **Candidates (P5, 2026-11-05):** `prophet_r37@latch8`, `prophet_r37@latch12` and `prophet_r38@latch8`. The ±3 structure latch expires after 8 or 12 closed H1 bars instead of 50. They are local-only: owner decision 1 (2026-11-05) is that a local-only version is enough, so an improvement is proven by outcome first.
- **GMI "Prophet risk hold" candidates** (`gmi_v12_70@latch8`, `gmi_v12_70@latch12`). These test the latch where it acts on the chain.
  - **How they work.** GMI needs M1, M15 and higher-timeframe bars, so it is not replayed. Each bar starts from the approved local GMI record of that candle (`localcalc:<key>:gmi`, kept 14 days, last 72 bars tried). `src/gmi-regate.mjs` recomputes only the two points the Prophet structure feeds: `mtf_state` in the initial verdict cascade, and the R10 gate with its risk hold (subtype 1).
  - **Exactness.** With the active structure, the re-gate reproduces GMI's comparable fields exactly (`test/gmi-regate.test.mjs`). In production the control is checked against the approved records.
  - **Sample.** Bars accumulate from the local records forward, so the 200-bar sample takes about a week.
- **Candidates approved in Aether (phase A7, owner go 2026-11-07):** `src/aether-pack.mjs`.
  - **The pull.** Once an hour, just before the shadow versions run, the AI Worker pulls Aether's learned pack (`AETHER` → `KnowledgeIngress.learnedPack()`). D1 `aether_learned_pack` (migration `0013`) keeps the last good pack.
  - **What becomes a candidate.** An approved `param_candidate` item becomes a candidate version (`<family>@latch<value>`, with `origin.source = "aether"`) only when all of these hold:
    - its family, parameter and value are in the reviewed `TUNING_GRID` (`stateMaxAge` 8, 12, 16 or 24 for `prophet_r37` and `gmi_v12_70`);
    - it is not already running and was not stopped;
    - its family runs fewer than 3 candidates.
  - **Review.** It is reviewed after its 200-bar sample or 30 decisive pairs, at the latest 30 days after it was first pulled.
  - **Text items** (caution, role reminder) are stored and listed only. They reach no prompt.
  - **Where to see it.** `GET /api/aether/status` shows the pack under `learned_pack`, with its hash, items, the shadow candidates it started and the items it ignored, and why. Nexus `/shadow` marks those candidates "From Aether".
- **Promotion** is never automatic. The verdict `better_than_active: ready for owner review` is a proposal; the owner approves a separate promotion PR.

## 4. Sources and knowledge
- **Pine sources:** `pinescript/ssot/`. Verified against the installed TradingView indicators; see `docs/PINE_SOURCE_VERIFICATION.md`. Never edit these files.
- **Agent knowledge base:** v4, generated from Pine with line citations and bundled into the AI Worker. See `docs/KNOWLEDGE_BASE_V4.md`.
- **Models:** the values in `wrangler.jsonc` are authoritative. Reasoning-model token budgets are `MAX_TOKENS` in `src/model-text.mjs`.

## 5. Deployment rules (mandatory for every human and agent)
1. Production changes reach production **only** by merging a PR into `main`. The workflows in §1 then deploy it.
2. **Never** run `wrangler deploy`, `wrangler delete` or `wrangler secret put` against production by hand or from a VPS. **Never** create a new Worker outside this repository. A manual deploy on 2026-11-03 replaced the pull adapter with a stub and stopped the local lane for about 6 hours.
3. Work from the latest `main`. Branches cut from an old base must not be merged or deployed.
4. A PR is mergeable only when CI is green (`test`, `preview-e2e`, Workers Builds) and the change is described against this SSOT.
5. A topology change requires editing this file, `AGENTS.md` and `test/ssot-topology.test.mjs` in the same PR, and the owner's explicit approval.
6. **Ops dispatch (owner request 2026-11-09, backlog item 17).** The automation operator's GitHub access cannot call `workflow_dispatch` or re-run a job. `.github/workflows/ops-dispatch.yml` runs on a push to the operator branch `claude/vibrant-mccarthy-dq5xs7` whose head commit adds exactly one `ops/requests/<UTC timestamp>-<name>.json` (`{"workflow": "deploy-worker.yml"}`), and dispatches that workflow on `main`, with no inputs, then follows it to completion. Allow-list: `deploy-worker.yml`, `deploy-nexus-dashboard.yml`, `deploy-market-data-ingestion.yml`, `deploy-fundamental-news-ingestion.yml` and the read-only `inspect-ai-worker.yml`; never `set-webhook-secret.yml`. Rule 1 holds: a deploy is still the deploy workflow on `main`, the same run the owner starts with "Run workflow". A branch reset onto `main` never replays a request (`test/ops-dispatch.test.mjs`).

## 6. Owner-only actions
- TradingView OAuth re-authorization at `https://news.cryptophys.work/oauth/start`.
- Rotation of `WEBHOOK_SECRET` (in the AI Worker and the Pine "CTA Webhook Secret" input).
- TradingView alerts: the Prophet R38 and GMI v12.70 alerts on OANDA:XAUUSD 1H, set to "Any alert() function call", with the webhook pointing to `https://ai.cryptophys.work/webhook`.
