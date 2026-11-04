# RFC — Multi-Agent Communication Bus (XAUUSD)

Status: **Approved by owner 2026-11-04; implementation phased (see below)**.
Canonical references: `docs/SSOT.md`, `AGENTS.md`, `docs/CHANGELOG.md`.
Phase 3 UI (news threads + live 5m room): `docs/RFC_NEXUS_AGENT_SOCIAL.md`.

## 1. Motivation
Move from a sequential Analyst → Counselor → Reasoner chain to a **multi-agent debate** where specialized agents (technical, liquidity, macro/news, risk, parity) publish insights into a shared bus, converge to a consensus decision, and surface a live "crowded market" chatroom in the Nexus dashboard. OHLCV ingestion already includes 5m; news stays 1H.

## 2. Proposed design (high level)
- **Bus:** KV/D1-backed event stream (append-only messages) with SSE to the dashboard. No new Worker required initially; implemented inside `xauusd-ai-trading-assistant`.
- **Agents:** pluggable modules (functions) that consume the evidence bundle + bus history and emit `{agent, ts, insight, confidence, refs}`.
- **Consensus:** a final Reasoner (or moderator) reads the full bus and emits the decision; loop until agents agree or max rounds.
- **Cadence:** technical analysis can run on 5m closes; news remains 1H. Parity registry must be extended per timeframe before 5m outputs are trusted.
- **UI:** Moltbook-style live chatroom with TLDR cards + expandable raw, consensus tracker.

## 3. Constraints (must hold)
- Advisory only; no broker/execution.
- Do not edit `pinescript/ssot/*`.
- Do not recreate removed Workers; keep 4-Worker topology unless owner approves a topology change.
- Trust comes only from autonomous parity registry; 5m needs its own 24-match streak.
- No shared secrets between Workers; RPC Service Bindings only.

## 4. Open questions for owner
- Which agents to include first (technical, news, risk, liquidity)?
- Max rounds / timeout budget for consensus.
- Whether to keep the existing 3-stage chain as fallback.
- Budget for 5m AI calls (Workers AI quota).

## 5. Non-goals (this RFC)
- No code changes, no deployment, no schema migration.
- No change to current H1 decision path until approved.

## 6. Next steps if approved
1. Add 5m local computation + parity registry (separate PR, tested).
2. Implement bus + 2 agents behind a feature flag.
3. Update SSOT + topology test if a new Worker/binding is introduced.
