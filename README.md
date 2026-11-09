# XAUUSD AI Trading Assistant

Advisory-only XAUUSD decision support on Cloudflare Workers. There is no broker integration and no automatic execution.

> **Canonical documentation:**
> - [docs/SSOT.md](docs/SSOT.md) is the topology, ownership and deployment rules.
> - [AGENTS.md](AGENTS.md) is the hard rules for every coding agent.
>
> Any other document that disagrees with these two is historical. Several older docs carry a "HISTORICAL / SUPERSEDED" banner.

## At a glance
- **Workers:** exactly five, all deployed only by merging into `main`.
  - `xauusd-ai-trading-assistant`
  - `xauusd-fundamental-news-ingestion`
  - `xauusd-tradingview-pull-adapter`
  - `xauusd-nexus-dashboard`
  - `xauusd-omega` (Omega Execution Engine at `omega.cryptophys.work` and `nexus.cryptophys.work/omega`: monitors the MT5 EA and pauses or kills it; the broker engine trades through the owner's MT5 host bridge when the owner enables it)
- **AI input lanes:** three, each on every closed 1H OANDA:XAUUSD bar.
  - TradingView webhooks (`prophet_r38`, `prophet_r37_ssot`, `gmi_v12_70`), which act as the comparator.
  - Local computation (MizanLib, Prophet, GMI), the primary lane. It is trusted only through the autonomous parity registry.
  - Fundamental news from TradingView MCP.
- **Agents:** Analyst → Counselor → Reasoner (models in `wrangler.jsonc`). They read knowledge base v4, which is generated from the Pine sources in `pinescript/ssot/`.
- **Dashboard:** `https://nexus.cryptophys.work`
- **Webhook URL:** `https://ai.cryptophys.work/webhook`
- **TradingView OAuth (owner only):** `https://news.cryptophys.work/oauth/start`

## Documentation map
| Topic | Document |
|---|---|
| Topology, ownership, deployment rules | [docs/SSOT.md](docs/SSOT.md) |
| Local computation owner and Pine coverage | [docs/LOCAL_COMPUTATION_OWNERSHIP.md](docs/LOCAL_COMPUTATION_OWNERSHIP.md) |
| Trust of local engines (parity registry) | [docs/AUTONOMOUS_PROVENANCE.md](docs/AUTONOMOUS_PROVENANCE.md) |
| Market data and the H1 producer | [docs/MARKET_DATA_INGESTION.md](docs/MARKET_DATA_INGESTION.md) |
| Local GMI engine scope | [docs/LOCAL_GMI_ENGINE.md](docs/LOCAL_GMI_ENGINE.md) |
| Agent knowledge base | [docs/KNOWLEDGE_BASE_V4.md](docs/KNOWLEDGE_BASE_V4.md) |
| Pine source verification | [docs/PINE_SOURCE_VERIFICATION.md](docs/PINE_SOURCE_VERIFICATION.md) |
| Evidence/input-lane contract | [docs/EVIDENCE_CONTRACTS.md](docs/EVIDENCE_CONTRACTS.md) |

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
