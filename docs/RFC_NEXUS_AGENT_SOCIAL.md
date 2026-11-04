# RFC — Nexus agent social view: news threads + live 5m trading room (Phase 3)

Status: **Phase 3a + 3b implemented and enabled in production (Phase 4, owner approval 2026-11-04).** Implementation notes: the data model uses new tables `agent_threads` / `agent_thread_messages` (migration 0004) instead of ALTERing `bus_messages`, and the live room uses `@cf/zai-org/glm-5.3-flash` (owner decision) with no fallback.
Canonical references: `docs/SSOT.md`, `AGENTS.md`, `docs/MULTI_AGENT_BUS.md`, `docs/RFC_INFORMATIONAL_5M_ENGINE.md`.

## 1. What the owner asked for
The owner wants agent discussion to look like a forum thread in which agents reply to each other, plus a live room:

1. **News threads.** Each completed news analysis is a *post*. Agents reply in a nested thread, and an agent can reply to another agent's reply. Every message shows its author agent, its model, the time ("3m ago"), a trust badge, the stance and the confidence.
2. **Live trading room (5m).** A chat that updates on every closed 5m bar. The agents argue the technical picture (BUY / SELL / HOLD / WAIT / CLOSE) the way a live chat does, and a moderator posts the consensus.

## 2. Constraints (unchanged, must hold)
- **Advisory only.** No broker and no execution. "Open position / hold / close" are discussion stances, never orders.
- **The authoritative decision stays the H1 chain** (Analyst → Counselor → Reasoner, parity-gated). The room and the threads never change the H1 decision, entry/SL/TP, size or confidence. They never feed back into `evidence` or the model prompts of the chain.
- **5m has no parity comparator.** Everything in the live room is `informational_unverified` and is labelled **UNVERIFIED 5m** on every message.
- **The trust badge is honest.** A "Verified" badge may only reflect `approved_by_parity` for H1 local lanes. A badge never means "the agent is right" or "the message is authentic". Agent messages carry the model name and a `status` instead.
- **Topology is unchanged.** The 4 Workers stay. Everything runs in the AI Worker (bus + API) and the Nexus Worker (UI). No new Worker and no shared secrets.
- Deploy only by merging to `main`.

## 3. Data model (extends Phase 2 `bus_messages`; new migration `0004`, never edit `0003`)
```sql
CREATE TABLE IF NOT EXISTS bus_threads (
  id TEXT PRIMARY KEY,                 -- "news:<analysis_key>" | "live5m:<YYYY-MM-DD>" | "h1:<candle_key>"
  kind TEXT NOT NULL,                  -- news | live5m | h1
  ref_key TEXT NOT NULL,               -- analysis_key / date / candle_key
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE bus_messages ADD COLUMN thread_id TEXT;
ALTER TABLE bus_messages ADD COLUMN parent_id INTEGER;     -- reply-to (NULL = top level)
ALTER TABLE bus_messages ADD COLUMN bar_time TEXT;         -- 5m bar for live5m messages
CREATE INDEX IF NOT EXISTS idx_bus_thread ON bus_messages(thread_id, id);
```
- `stance` for the live room: `BUY | SELL | HOLD | WAIT | CLOSE`. For news and H1: `BUY | SELL | WAIT`.
- Every message keeps `model`, `status`, `fallback_used`, `usage_tokens` and `latency_ms` (Phase 2).

## 4. Agent flows
### 4.1 News thread (cadence: hourly, after the `:06` news analysis)
1. A post is created from the completed news analysis (headline, summary, articles).
2. Round 1: `news` and `technical` each reply to the post.
3. Round 2: each agent replies to the *other agent's* round-1 message (`parent_id`). It must agree or dispute, with a reason and `refs`.
4. The moderator replies to the post with a consensus (`stance`, `confidence`, `agreed`, `dissent`).

### 4.2 Live 5m room (cadence: each closed 5m bar)
1. Input: `informational_5m_context` + the last N M5 bars + the latest H1 chain decision (read-only) + the latest news consensus.
2. Messages: `technical` (5m read), `risk` (where the 5m read conflicts with H1 or news), then the moderator (one-line consensus, stance from the room set).
3. **Messages only reference the H1 decision.** When the H1 decision is WAIT, the room may discuss, but the moderator must say "H1 decision: WAIT" whenever its stance differs.
4. Skip rule: when nothing material changed since the previous bar (same 5m bias, no event, no new H1/news), post nothing. That saves calls and noise.

## 5. Budget (Beam is $0 per the catalog on 2026-11-04, but rate limits are unknown)
- Live room: ≤ 3 calls per 5m bar → ≤ 864 calls/day, minus skips. News threads: 5 calls/hour. H1 bus: 5 calls/hour.
- `MULTI_AGENT_MAX_CALLS_PER_HOUR` must cover this (≈ 50). The counter fails closed.
- **The fallback model (glm-4.7-flash, paid) is NOT used for the live room.** If Beam fails, the room posts nothing for that bar, so that 5m cadence cannot run up cost silently. The fallback stays allowed for news threads and the H1 bus.
- Each message stores `usage_tokens`. `/api/status` reports calls and tokens per day.

## 6. API (AI Worker, read-only, proxied by Nexus)
- `GET /api/threads?kind=news&limit=20`: posts with reply counts and the latest consensus.
- `GET /api/threads/:id`: the post plus nested replies (tree built from `parent_id`).
- `GET /api/live?since=<message id>`: new live-room messages (polled every 5–10 s). SSE is optional later.
- `GET /api/bus?candle_key=`: unchanged (Phase 2).

## 7. UI (Nexus Worker)
- **"Threads" tab:** a forum-style list (title, agents, reply count, consensus stance). Opening a post shows a nested reply tree with indentation and a left border per depth level. Each message shows the author agent, the model, the relative time, the stance chip, the confidence and the status (`ok` / `invalid_output` / `fallback`).
- **"Live room" panel:** a chat stream (newest at the bottom, auto-scroll unless the user has scrolled up), a bar-time divider for each 5m bar, an **UNVERIFIED 5m** banner, and a pinned header with the current **H1 decision** so that the authoritative decision is always visible.
- The existing user-selection rule (PR #56) applies: auto-refresh never overrides a thread the user has opened.
- Every inline script stays covered by `test/nexus-dashboard-html.test.mjs`.

## 8. Phasing
1. **Phase 2 must merge first** (PR #53: real agents, tests, fallback, strict schema, preview proof).
2. **Phase 3a:** migration 0004 + news threads (flows 4.1, API 6) + Threads tab.
3. **Phase 3b:** live 5m room behind flag `LIVE_ROOM_ENABLED=false` (production), `true` in preview.
4. **Phase 4 (owner gate):** enable in production after the preview proves the room output and the budget.

## 9. Acceptance (each phase)
- Tests with fake `env.AI` + fake D1: thread tree building, reply-to-other-agent, skip rule, budget fail-closed, no fallback for the live room, and no write into chain `evidence`.
- preview-e2e: one news thread with ≥ 5 messages from Beam in the correct tree; one live-room bar with ≥ 2 messages + consensus.
- CHANGELOG + SSOT updated. Production flags stay off until the owner approves.
