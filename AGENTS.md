# Rules for every coding agent (Claude, Codex, OpenCode, Copilot, …)

Read `docs/SSOT.md` first. It is the only canonical description of this system. Any other document that disagrees with it is historical.

## Hard rules
1. **Deploy only by merging a PR into `main`.** The GitHub Actions workflows deploy the five Workers.
2. **Never run `wrangler deploy`, `wrangler delete` or `wrangler secret put` against production by hand or from a VPS.**
3. **Never create, deploy or redeploy a Worker that is not one of these five:**
   - `xauusd-ai-trading-assistant`
   - `xauusd-fundamental-news-ingestion`
   - `xauusd-tradingview-pull-adapter`
   - `xauusd-nexus-dashboard`
   - `xauusd-omega` (Omega Execution Engine, owner decisions 2026-11-09)
4. **Never recreate the removed Workers:** `xauusd-mizan-engine`, `xauusd-prophet-engine`, `xauusd-gmi-engine`, `xauusd-market-data-normalizer`, `xauusd-pull-orchestrator` and `xauusd-confluence-controller`. The "8 + 1 Workers" plan in older documents is cancelled.
5. **Start from the latest `main`.** Do not revive, merge or deploy branches cut from an old base.
6. **Do not edit `pinescript/ssot/*`.** Local engine trust comes only from the autonomous parity registry. Never mark an engine verified or `production_ready` by hand.
7. **Inter-Worker calls use RPC Service Bindings.** Do not add shared secrets between Workers. Nexus reaches the AI Worker's read API only through its `AI_WORKER` binding, never the public URL (docs/SSOT.md §2).
   - Two bindings reach outside this repository, both on the production AI Worker only (docs/SSOT.md §2):
     - `AGENTS` to the Cryptophys Platform `cryptophys-ai-kernel` (`AgentRpc`, `props.host_worker = "xauusd-ai-trading-assistant"`);
     - `AETHER` to `cryptophys-aether` (`KnowledgeIngress`), which receives decision cards only.
   - Never copy either one to another Worker or to the preview config, and never change `host_worker`.
   - Kernel denials are final: no retry loops, and no switching agent ids.
8. **The server never trades.** No broker integration and no broker credential in this repository's Workers, and no position size from the server. Since the owner's decisions of 2026-11-09 ("Langsung siap live", execution by an EA on the owner's terminal), the owner's own MetaTrader 5 Expert Advisor (`ea/mt5/CryptophysXAUUSD.mq5`) may execute the decision it reads from `GET /api/ea/signal` (behind Cloudflare Access): since 2026-11-09 the Decision Engine's 15m decision, the single SSOT (`src/decision-engine.mjs`; the AI council decides within deterministic guardrails, prices only from the key-level plan; `DECISION_ENGINE = "off"` restores the H1 decision); it sizes each trade from the owner's risk input on the owner's terminal, and a live account trades only with `AllowLiveAccount`. The kill switch is `EA_SIGNALS_ENABLED = "false"`. Omega (`omega.cryptophys.work`, `workers/xauusd-omega`) shows the EA and lets a signed-in person pause it or kill it (audited); it never places an order either. Kernel reports and decision cards still never carry a price.

## Before opening a PR
- `npm test` (it includes `test/ssot-topology.test.mjs`) and `npx tsc --noEmit -p .`.
- A dry-run of the affected Worker: `npx wrangler@4.45.0 deploy --dry-run --config <wrangler.jsonc>`.
- If you change the topology, update `docs/SSOT.md`, this file and the topology test together, and get the owner's approval.
