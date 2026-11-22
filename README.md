# XAUUSD AI Trading Assistant

XAUUSD decision support and execution on Cloudflare Workers. A Decision Engine decides at every 15m close; the owner's MetaTrader 5 terminal executes it only through the owner's own switches (the Omega broker engine and its bridge, or the owner's EA), and a real account only after the owner arms it live.

> **Canonical documentation:**
> - [docs/SSOT.md](docs/SSOT.md) is the topology, ownership and deployment rules.
> - [AGENTS.md](AGENTS.md) is the hard rules for every agent, on every machine: cloud sessions, local checkouts and the owner's trading VPS.
>
> Any other document that disagrees with these two is historical. The [document index](#documents) below gives each document's status.

## At a glance
- **Workers:** exactly five, all deployed only by merging into `main` (never `wrangler deploy` by hand or from a VPS; a drift guard restores `main` if anything else is live).
  - `xauusd-ai-trading-assistant`: webhooks, the three input lanes, the rooms, the Decision Engine, the read API and Telegram.
  - `xauusd-fundamental-news-ingestion`: the TradingView MCP grant, news and OHLCV.
  - `xauusd-tradingview-pull-adapter`: local computation of MizanLib, Prophet and GMI.
  - `xauusd-nexus-dashboard`: `https://nexus.cryptophys.work`, the War Room UI.
  - `xauusd-omega`: the Omega Execution Engine at `omega.cryptophys.work` and `nexus.cryptophys.work/omega`.
- **AI input lanes:** three. Local computation (MizanLib, Prophet, GMI) is the primary lane, trusted only through the autonomous parity registry; TradingView webhooks (`prophet_r38`, `prophet_r37_ssot`, `gmi_v12_70`) are the comparator; fundamental news comes from TradingView MCP.
- **Decision:** the Decision Engine (`src/decision-engine.mjs`) at every 15m close. Its witnesses are the 15m War Room and the 1H, 4H and 1D rooms, the strategy agents' consensus, News Daily, the Macro War Room, the strategy engine and the extended witnesses, with weights the auto-tuning sets. An AI council chooses within deterministic guardrails, and prices come only from the Key Level Agent's plan.
- **Execution:** the Omega broker engine plans and sizes within the account's profile (Safe, Conservative, Aggressive, Custom) and the owner's switches; the Omega bridge on the owner's MT5 host executes (`docs/OMEGA_BRIDGE.md`).
- **Knowledge:** Aether (`cryptophys-aether`) holds the canon doctrine and its bounds; the Knowledge Council amends it through the Cryptophys platform's Cerebrum consensus from the facts this Worker reports hourly.
- **Webhook URL:** `https://ai.cryptophys.work/webhook`
- **TradingView OAuth (owner only):** `https://news.cryptophys.work/oauth/start`

## Documents
**Canonical:** [docs/SSOT.md](docs/SSOT.md) (current state), [AGENTS.md](AGENTS.md) (rules), [docs/CHANGELOG.md](docs/CHANGELOG.md) (what changed), [docs/BACKLOG.md](docs/BACKLOG.md) (open work).

**In force** (they describe what runs; the SSOT wins where they differ):
| Document | Status |
|---|---|
| [docs/AUTONOMOUS_PROVENANCE.md](docs/AUTONOMOUS_PROVENANCE.md) | Implemented: the parity registry |
| [docs/LOCAL_COMPUTATION_OWNERSHIP.md](docs/LOCAL_COMPUTATION_OWNERSHIP.md) | Current: who computes the Pine parameters |
| [docs/LOCAL_GMI_ENGINE.md](docs/LOCAL_GMI_ENGINE.md) | Implemented |
| [docs/MARKET_DATA_INGESTION.md](docs/MARKET_DATA_INGESTION.md) | Implemented; its own status line predates deployment |
| [docs/KNOWLEDGE_BASE_V4.md](docs/KNOWLEDGE_BASE_V4.md) | Current knowledge base; its agent names predate the rooms |
| [docs/PINE_SOURCE_VERIFICATION.md](docs/PINE_SOURCE_VERIFICATION.md) | Record of 2026-11-03 |
| [docs/EVIDENCE_CONTRACTS.md](docs/EVIDENCE_CONTRACTS.md) | Partly superseded (see its banner) |
| [docs/EA_MT5.md](docs/EA_MT5.md) | Current: the owner's EA |
| [docs/OMEGA_BRIDGE.md](docs/OMEGA_BRIDGE.md), [docs/OMEGA_BRIDGE_PROTOCOL.md](docs/OMEGA_BRIDGE_PROTOCOL.md) | Current: installing the bridge, and its protocol |

**RFCs and proposals** (each carries its own status line):
| Document | Status |
|---|---|
| [docs/RFC_ACCOUNT_PROFILES.md](docs/RFC_ACCOUNT_PROFILES.md) | Built (four phases; ADR-0020 Amendment 10 on 2026-11-21) |
| [docs/RFC_OMEGA_5M_EXECUTION.md](docs/RFC_OMEGA_5M_EXECUTION.md) | Built |
| [docs/RFC_OMEGA_LIMIT_ENTRY.md](docs/RFC_OMEGA_LIMIT_ENTRY.md) | Stages 1 to 3 built |
| [docs/RFC_PM_A8.md](docs/RFC_PM_A8.md) | Built, off by default (`pm_loosen_enabled`) |
| [docs/RFC_POSITIONING_LIQUIDITY.md](docs/RFC_POSITIONING_LIQUIDITY.md) | Built and live |
| [docs/RFC_STRATEGY_AGENTS.md](docs/RFC_STRATEGY_AGENTS.md) | Built and live |
| [docs/RFC_STRATEGY_EXECUTION.md](docs/RFC_STRATEGY_EXECUTION.md) | Accepted and built |
| [docs/RFC_STRATEGY_RECOMMENDATION.md](docs/RFC_STRATEGY_RECOMMENDATION.md) | P2 built and live |
| [docs/RFC_COUNCIL_PROPOSALS.md](docs/RFC_COUNCIL_PROPOSALS.md) | Phases 1 and 2 built |
| [docs/RFC_CALL_FOR_COUNCILS.md](docs/RFC_CALL_FOR_COUNCILS.md) | Final design; P1 built |
| [docs/RFC_CUSTOM_MODEL.md](docs/RFC_CUSTOM_MODEL.md) | Accepted; steps 1 and 2 built |
| [docs/RFC_PLAN_LEARNING.md](docs/RFC_PLAN_LEARNING.md) | Step 1 built, shadow only |
| [docs/RFC_ROOM_CELLS.md](docs/RFC_ROOM_CELLS.md) | P2a and P2b done; P2c parked |
| [docs/RFC_CORPUS_ORACLE.md](docs/RFC_CORPUS_ORACLE.md) | Phases 1 and 2 built (SSOT "Corpus Oracle") |
| [docs/RFC_MT5_FALLBACK.md](docs/RFC_MT5_FALLBACK.md) | The MT5 fallback feed; the SSOT says what of it runs (lane 3, Corpus Oracle) |
| [docs/RFC_INDICATOR_ADOPTION.md](docs/RFC_INDICATOR_ADOPTION.md) | Accepted; staged |
| [docs/RFC_INDICATOR_AGENT_PLATFORM.md](docs/RFC_INDICATOR_AGENT_PLATFORM.md) | Draft; P1, P2, P3, P6 and P7 built |
| [docs/RFC_INFORMATIONAL_5M_ENGINE.md](docs/RFC_INFORMATIONAL_5M_ENGINE.md) | Approved 2026-11-04; phased |
| [docs/RFC_NEXUS_AGENT_SOCIAL.md](docs/RFC_NEXUS_AGENT_SOCIAL.md) | Phases 3a and 3b live |
| [docs/RFC_CONTENT_AGENT.md](docs/RFC_CONTENT_AGENT.md) | P0 and P1 built; the content engine moved to `cryptophys-cta` |
| [docs/RFC_AETHER_KNOWLEDGE_GUARDIAN.md](docs/RFC_AETHER_KNOWLEDGE_GUARDIAN.md) | Draft revision 2; Aether is built in `cryptophys-aether` |
| [docs/RFC_HUD_AGENTS.md](docs/RFC_HUD_AGENTS.md), [docs/HUD_AGENTS_ASSESSMENT.md](docs/HUD_AGENTS_ASSESSMENT.md), [docs/BRIEF_HUD_AGENTS.md](docs/BRIEF_HUD_AGENTS.md), [docs/HUD_CANDIDATE_INSTALL.md](docs/HUD_CANDIDATE_INSTALL.md) | HUD agents: design record; the per-H1 runner retired 2026-11-15 |
| [docs/PROPOSAL_AETHER_OMEGA_POLICY.md](docs/PROPOSAL_AETHER_OMEGA_POLICY.md) | Implemented; off until the owner turns it on |
| [docs/PROPOSAL_GLOBAL_DECISION_WEIGHTED.md](docs/PROPOSAL_GLOBAL_DECISION_WEIGHTED.md) | Its status line says draft; `GLOBAL_DECISION_WEIGHTED` is on since 2026-11-10 (SSOT) |
| [docs/PROPOSAL_PROGRESSIVE_STOP.md](docs/PROPOSAL_PROGRESSIVE_STOP.md) | Draft (its status line) |
| [docs/MULTI_AGENT_BUS.md](docs/MULTI_AGENT_BUS.md) | Retired |
| [docs/ui-ux-e2e-platform-audit.md](docs/ui-ux-e2e-platform-audit.md) | Landed 2026-11-14 |

**Historical** (banner "HISTORICAL / SUPERSEDED"): [ARCHITECTURE_BASELINE](docs/ARCHITECTURE_BASELINE.md), [DEPLOYMENT_BLUEPRINT](docs/DEPLOYMENT_BLUEPRINT.md), [LOCAL_CALCULATION_SOURCE_BASELINE](docs/LOCAL_CALCULATION_SOURCE_BASELINE.md), [LOCAL_ENGINE_CALLER_CONTRACTS](docs/LOCAL_ENGINE_CALLER_CONTRACTS.md), [OPENCODE_CONTINUATION_INSTRUCTIONS](docs/OPENCODE_CONTINUATION_INSTRUCTIONS.md), [PRODUCTION_DEFINITION_OF_DONE](docs/PRODUCTION_DEFINITION_OF_DONE.md), [PROPHET_R37_DETERMINISTIC_KERNEL_CONTRACT](docs/PROPHET_R37_DETERMINISTIC_KERNEL_CONTRACT.md).

## Secrets (Cloudflare only, never committed)
- **AI Worker:** `WEBHOOK_SECRET`; `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` if notifications are enabled.
- **News Worker:** `INGEST_SECRET`, plus the TradingView MCP OAuth state kept in `OAUTH_STORE`.
- **Inter-Worker calls:** RPC Service Bindings, with no shared secrets.

## Development
```bash
npm test
npx tsc --noEmit -p .
```
Open a PR against `main`. CI (`test`, `preview-e2e`, Workers Builds) must be green before merging. Merging deploys the affected Workers.
