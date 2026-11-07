# Rules for every coding agent (Claude, Codex, OpenCode, Copilot, …)

Read `docs/SSOT.md` first. It is the only canonical description of this system. Any other document that disagrees with it is historical.

## Hard rules
1. **Deploy only by merging a PR into `main`.** The GitHub Actions workflows deploy the four Workers.
2. **Never run `wrangler deploy`, `wrangler delete` or `wrangler secret put` against production by hand or from a VPS.**
3. **Never create, deploy or redeploy a Worker that is not one of these four:**
   - `xauusd-ai-trading-assistant`
   - `xauusd-fundamental-news-ingestion`
   - `xauusd-tradingview-pull-adapter`
   - `xauusd-nexus-dashboard`
4. **Never recreate the removed Workers:** `xauusd-mizan-engine`, `xauusd-prophet-engine`, `xauusd-gmi-engine`, `xauusd-market-data-normalizer`, `xauusd-pull-orchestrator` and `xauusd-confluence-controller`. The "8 + 1 Workers" plan in older documents is cancelled.
5. **Start from the latest `main`.** Do not revive, merge or deploy branches cut from an old base.
6. **Do not edit `pinescript/ssot/*`.** Local engine trust comes only from the autonomous parity registry. Never mark an engine verified or `production_ready` by hand.
7. **Inter-Worker calls use RPC Service Bindings.** Do not add shared secrets between Workers.
   - Two bindings reach outside this repository, both on the production AI Worker only (docs/SSOT.md §2):
     - `AGENTS` to the Cryptophys Platform `cryptophys-ai-kernel` (`AgentRpc`, `props.host_worker = "xauusd-ai-trading-assistant"`);
     - `AETHER` to `cryptophys-aether` (`KnowledgeIngress`), which receives decision cards only.
   - Never copy either one to another Worker or to the preview config, and never change `host_worker`.
   - Kernel denials are final: no retry loops, and no switching agent ids.
8. **Advisory only.** No broker integration and no automatic execution.

## Before opening a PR
- `npm test` (it includes `test/ssot-topology.test.mjs`) and `npx tsc --noEmit -p .`.
- A dry-run of the affected Worker: `npx wrangler@4.45.0 deploy --dry-run --config <wrangler.jsonc>`.
- If you change the topology, update `docs/SSOT.md`, this file and the topology test together, and get the owner's approval.
