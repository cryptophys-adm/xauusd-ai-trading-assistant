# RFC: Room cells and run documents (ADR-0015 phase 2, xauusd)

**Status: P2a live in shadow (2026-11-15). P2b reader 1 (outcome scoring) live 2026-11-16, owner: "tidak perlu menunggu, langsung pindah ke room_runs" (the first non-empty comparison, 01:06 UTC, was 4/4 and 1/1 equal). Readers 2-6 and P2c not started.**
- The owner approves it before any implementation (relayed by the orchestrator, 2026-11-15).
- ADR-0015 phase 2 was deferred on 2026-11-14 ("setuju tunda"). This document is the plan to un-defer it.

**Measurements:**
- From production D1 `xauusd-signals`, read-only, 2026-11-15 between 13:30 and 14:10 UTC.
- Every number below is either a query result or an estimate built from query results. Estimates say so.

## 0. Scope and boundary

**In scope:**
- the AI Worker's room tables `agent_threads` and `agent_thread_messages`;
- their writers and readers;
- a run-document store that replaces them for the rooms.

**Not in scope:**
- the old H1 bus (`bus_messages`), which is being retired separately;
- the push hub (phase 1, built);
- telemetry and retention (phases 3 and 5, deferred).

**The decision boundary does not move.** Today it is:
- Room conclusions are witnesses in the Decision Engine's quorum and in the strategy engine:
  - `decision-engine.mjs` reads `readMacroRoom`;
  - `strategy-engine.mjs` reads `readWarRoom`, `readTimeframeThread` and `readNewsDaily`;
  - the H1 consensus reads the 1H room.
- They are never orders. The guardrails, quorum rules and entry rules stay where they are.
- Shadow outputs (metric arm, arena, shadow knowledge, neuron-allocation shadow seats) are measured only and never enter a decision.

**The cell changes where room state lives, not what any decision reads.** Every reader gets the same values it gets today.

## 1. Writers and readers today

### 1.1 Writers

There is one write path, `threadInternals` in `src/agent-threads.mjs`:
- `upsertThread` makes 2 statements per run (INSERT OR IGNORE plus UPDATE `updated_at`).
- `writeMessage` makes 1 upsert on `(thread_id, run_id, step)`. A stored `ok` row is final; a stored failure is replaced by the retry. After the upsert, `writeMessage` does **1 read-back SELECT**.

Callers, all in the AI Worker `xauusd-ai-trading-assistant`:

| Room | Thread id | Module | Trigger |
|---|---|---|---|
| 15m War Room | `warroom:<date>` (one thread per UTC day) | `war-room.mjs` | each 15m close (queue task, plus the 15-minute sweep `runMissedWarRoom`) |
| 1H / 4H / D1 rooms | `tf:H1`, `tf:H4`, `tf:D1` | `timeframe-threads.mjs` | the sweep after each bar close; at most 20 min wait for the HUD snapshot, then `#hud` re-convene |
| Macro room | `macro:XAUUSD` | `macro-room.mjs` | 20 min after each 1H close, and after high-impact USD events (2 h follow-up) |
| News thread | `news:<analysis>` | `agent-threads.mjs` `runNewsThread` | queue task `news_thread` after each hourly news analysis |
| News Daily | `newsdaily:<date>` | `news-daily.mjs` | after the hourly news batch, one digest per day |
| Live 5m/15m, HUD 1H | `live5m:*`, `live15m:*`, `hud1h:*` | `agent-threads.mjs` | **dormant:** last rows 2026-11-04/05 |

### 1.2 Readers

| Reader | Reads | Used for |
|---|---|---|
| `war-room.mjs` `readWarRoom`, `readTldr` | latest run (`ORDER BY thread_id DESC, run_id DESC LIMIT 1`, then the run); the news moderator join | `GET /api/war-room/latest`, push hub, `/api/tldr`, strategy engine, decision cards, kernel reports |
| `timeframe-threads.mjs` `readTimeframeThread` | latest or candle-keyed run (`json_extract(body_json,'$.candle_key')`) | `/api/threads/timeframe`, strategy engine, decision cards, H1 consensus |
| `macro-room.mjs` `readMacroRoom` | latest concluded run | Decision Engine (macro witness), global conclusion, `/api/macro-room` |
| `news-daily.mjs` `readNewsDaily` | latest brief run | rooms' News Analyst evidence, macro room, strategy engine, `/api/news-daily` |
| `agent-threads.mjs` | `listThreads`, `readThread`, `readLive`, the news moderator; `callsInLastHour` (the hourly model-call budget, once per room run) | `/api/threads*`, budgets |
| `outcome-scoring.mjs` | `roomStatements`: warroom rows by `bar_time`, plus live15m (dead); tf rows self-joined to their brief; `hud1h` rows | scorecards, then reputation, neuron allocation, Nexus Scorecards, `outcome_summary` |
| `weighting-replay.mjs` `loadRooms` | 15m: warroom rows by `ts`; 1H/4H/D1: tf rows self-joined to the brief | hourly auto-tuning (`applyWeighting`), `/api/weighting/replay`, Aether weighting reports |
| `platform-reports.mjs` | latest War Room run's openings | kernel reports (HUD agents, `xauusd-moderator`) |
| `decision-cards.mjs` | recent warroom conclusions and tf briefs (via `readWarRoom` / `readTimeframeThread`) | Aether decision cards (`aether-push.mjs`) |
| `compliance.mjs` | cursor over `ok` warroom and tf rows (`id > cursor`) | compliance checks, then Aether |
| `health-alerts.mjs` | room concluded, rate-limit failures, newsdaily and warroom freshness | Telegram health alerts |
| `neuron-allocation.mjs` | model calls and tokens per day/room/agent/model | `/api/neuron-allocation` |
| Nexus UI (`workers/xauusd-nexus-dashboard`) | only through the AI Worker's endpoints and the push hub; no direct D1 | War Room, Threads, Scorecards, Neuron pages |
| Telegram | no direct read; goes through the health alerts and the decision/H1 publishers | |

## 2. Per thread kind: transient vs permanent

The production totals, all time until 2026-11-15:

| Kind | Rows | Body bytes | Runs | Steps |
|---|---|---|---|---|
| warroom | 14,056 | 7.9 MB | 534 | `brief`, `open:<agent>`, `debate:<agent>`, `conclusion` (~26 rows per run) |
| tf | 4,635 | 2.6 MB | 138 | same shape |
| newsdaily | 452 | 2.7 MB | 156 | `tag:1`, `tag:2`, `brief`, `tldr` |
| news | 805 | 0.5 MB | 161 | `r1:*`, `r2:*`, `moderator` |
| macro | 739 | 0.25 MB | 61 | `brief`, `open:*`, `debate:*`, `conclusion` |
| live15m, live5m, hud1h | 255 | 0.12 MB | | dormant |

**Permanent evidence (kept queryable):**
- **Per room run:** the brief's identity (`candle_key`, bar close, evidence hash, HUD snapshot present or late) and the conclusion (stance, bias, confidence, summary, reasons, dissent, metrics).
- **Per agent, its final position in the run:**
  - stance, bias and confidence;
  - its metrics;
  - whether it was a live seat or a shadow seat;
  - the model and whether a fallback was used;
  - tokens;
  - its last debate stance if it debated, otherwise its opening.

  This is exactly what outcome scoring, weighting replay, compliance, kernel reports and decision cards read today.
- **News thread:** the moderator's consensus.
- **News Daily:** the `brief` and the `tldr`.

**Transient (needed while the run is open, then only as transcript):**
- the openings' and rebuttals' full text (`claim`, `argument`, `rebuts`);
- failed attempts (`agent_failed`, `invalid_output`, `budget_exhausted`, `skipped`), kept as counts on the run document;
- memo-reused markers (`reused`) and corrections counters, kept as counts;
- the news thread's `r1`/`r2` rows;
- News Daily's `tag:1`/`tag:2` inputs.

The full transcript keeps all of it, in R2 (§4).

**Dormant kinds** (`live5m`, `live15m`, `hud1h`, 255 rows): no writer since 2026-11-05.
- They are read only by outcome scoring's `live15m` and `hud1h` branches.
- Plan: export to R2 with the phase-5 archive, then remove those branches. That is a separate owner decision.

## 3. The cell: one Durable Object per room

**Class and location:**
- `RoomCell`, SQLite-backed (`new_sqlite_classes` migration).
- It lives in the AI Worker, which owns the rooms, the AI binding and D1.

**One instance per room:**
- `warroom:XAUUSD`, `tf:H1`, `tf:H4`, `tf:D1`, `macro:XAUUSD`, `news:XAUUSD`, `newsdaily:XAUUSD`;
- 7 instances, all single-writer.

**State:**
- **In memory:** the open run: brief, roster split, step results, deadlines.
- **DO SQLite:**
  - `runs(run_id PK, status, opened_at, deadline_at, concluded_at, doc_json)`;
  - `steps(run_id, step, status, attempt, body_json, PRIMARY KEY(run_id, step))` for the open runs and the last 48 runs (enough for re-convene and re-delivery);
  - `budget(hour, calls)`.

  The hourly budget becomes a counter in the cell. It replaces today's scan, which reads ~311 rows per room run.
- **Retention in the DO:** steps older than 48 runs are deleted once their run document is in D1 and their transcript in R2.

**Alarm:**
- `alarm()` fires at the bar close, plus the room's wait:
  - War Room: the 15m close;
  - tf rooms: the close plus up to `TF_HUD_WAIT_MS` (20 min) for the HUD snapshot;
  - macro: the close plus 20 min, or the event plus 30 min.
- In the alarm, the cell runs the phases (opening, debate, conclusion) within the existing quorum waits, and re-arms itself for retries until the room's quorum deadline.
- The existing triggers stay as a safety net: the queue task and the 15-minute sweep call `cell.ensureRun(runId)`.
- **To verify before building:**
  - the alarm handler's wall-time limit against the Cloudflare Durable Objects documentation;
  - how a run of ~22 Workers AI calls (about 3–5 minutes today) is split across alarms if needed.

**RPC surface (Workers RPC on the DO stub):**
- `ensureRun({ runId, candleKey, barClose, brief })`: idempotent; it opens the run only if it does not exist.
- `latest()`: returns the latest run in today's `readWarRoom` / `readTimeframeThread` / `readMacroRoom` / `readNewsDaily` shape.
- `run(runId)`.
- `transcript(runId)`: from the DO while it is retained, else R2.
- `budget()`.
- `status()`: open run, last conclusion, failures, for health alerts.

**Idempotency:**
- `run_id` stays as today:
  - the bar close ISO time;
  - plus `#hud` for a re-convene;
  - plus the existing session ids for macro, news and News Daily.
- A step is keyed `(run_id, step)`. An `ok` step is final, a failed step is replaced by its retry. These are today's `writeMessage` semantics.
- The run document is written to D1 with `ON CONFLICT(run_id, room) DO UPDATE ... WHERE status <> 'concluded'`, so a re-delivery cannot overwrite a concluded run.
- R2 writes use the run id as key, so a repeated write is a no-op overwrite of identical bytes.

**Push:** the cell publishes each step's snapshot to the Nexus `PushHub`, as the War Room does today (phase 1).

## 4. The run document

**D1 table `room_runs`, one row per concluded or failed room run:**

| Column | Content |
|---|---|
| `room` | `warroom`, `tf:H1`, `tf:H4`, `tf:D1`, `macro`, `news`, `newsdaily` |
| `run_id` | the run id (`PRIMARY KEY (room, run_id)`) |
| `timeframe` | `15`, `60`, `240`, `1D`, or null |
| `candle_key` | the candle the run is about, or null |
| `bar_close` | ISO |
| `status` | `concluded`, `partial`, `empty`, `failed` |
| `stance`, `bias`, `confidence` | the conclusion |
| `agents_heard`, `agents_failed`, `shadow_seats` | counts |
| `model_calls`, `fallbacks`, `tokens` | usage, which replaces neuron-allocation's scan |
| `evidence_hash` | the brief's hash (room memo) |
| `opened_at`, `concluded_at` | timestamps |
| `transcript_key` | R2 key |
| `doc_version` | `cryptophys.room-run.v1` |
| `body_json` | JSON, see below |

`body_json` holds:
- `{ conclusion: { summary, reasons, dissent, metrics } }`;
- `agents: [{ agent, seat: live|shadow, stance, bias, confidence, metrics, model, fallback_used, step: open|debate }]`;
- `brief: { hud_present, hud_late, news_ref, macro_ref }`.

**Indexes:**
- `(room, bar_close)`;
- `(candle_key)`;
- `(room, concluded_at)`.

**Sizes and writes:** about 140 rows a day on a market day, 1–3 KB each (an estimate from the current per-run row counts).

**R2 transcript:**
- Key: `rooms/<room>/<yyyy>/<mm>/<dd>/<run_id>.ndjson`.
- Content: every message of the run in `rowToThreadMessage` shape, failures included, one object per line.
- The AI Worker has **no R2 bucket today**. One bucket, for example `xauusd-archive`, is needed. It is shared with the bus archive and phase 5. Its creation is an owner decision.

## 5. Shadow plan and retirement

**P2a: derived run documents. No DO, no change to the live path.**
- After each room concludes, the AI Worker builds the run document from the rows it just wrote, then writes `room_runs` and the R2 transcript.
- A one-off backfill workflow builds `room_runs` for history.
- Readers stay on `agent_thread_messages`. A shadow comparison runs hourly:
  - outcome-scoring statements from `room_runs` vs from messages (per subject: n, hit, miss for the 7d and 30d windows);
  - weighting replay results (per timeframe: the replay's chosen weights and scores);
  - compliance violations;
  - kernel-report openings;
  - decision cards.
- Results go to D1 `shadow_runs_compare` and are shown on Nexus Status.

**P2b: readers move to `room_runs`, one reader per PR:**
1. scoring;
2. replay;
3. compliance;
4. neuron allocation;
5. decision cards;
6. kernel reports.

Each move is behind a flag that falls back to the old query.

Reader 1 (scoring), as built:
- `agentStatements` reads `room_runs` when `ROOM_RUNS_SHADOW` and `ROOM_RUNS_READ` are both `on`.
- It first derives the runs concluded since the last hourly pass, so scoring never waits for that pass.
- Bars that closed before the 48 h derive window still come from the messages (the 4H and D1 lookbacks reach past it).
- `ROOM_RUNS_READ` `off` is the rollback.
- The hourly comparison keeps reading the messages (`source: "messages"`), so it goes on checking the documents.

Document v2 (2026-11-16, owner: "lanjutkan semua pembaca ke room_runs"), for readers 2-6:
- The other readers need more than the final positions:
  - message texts (`claim`, `argument`);
  - the opening and the debate answer separately;
  - message ids (the compliance cursor);
  - per-call tokens and models (neuron allocation);
  - the whole brief and conclusion;
  - up to a year of history (replay).
- So `cryptophys.room-run.v2` also stores every step of its run as stored: every column, in id order, in `body.steps`, plus `body.thread_id`.
- `docRows(doc)` rebuilds the exact message rows, so each reader keeps its own logic.
- The hourly pass upgrades v1 documents in place. It backfills the last 58 days once (at most 200 runs per pass); a marker in `room_runs_meta` then keeps later passes to the 48 h window.
- Readers 2-6 use `runRowsFromDocs(env, room, floor)`, which returns the rows only once the backfill marker of the current version is set; before that they read the messages. Each reader has its own flag, `ROOM_RUNS_READ_<READER>`, where `off` is the rollback.
- Reader 2 (replay, `ROOM_RUNS_READ_REPLAY`) applies the same filters and order as its SQL (status ok, `ts` since, open/debate/conclusion, by run then step kind then id). For H1/H4/D1 it takes the candle key from the run's brief.
- Reader 3 (compliance, `ROOM_RUNS_READ_COMPLIANCE`):
  - The sweep checks the documents derived since a watermark (`derived_at`, `room_runs_meta` key `compliance:derived_at`), at most 40 runs per pass.
  - A message-id cursor would skip a run that concludes after a later one, because a run is documented only when it concludes.
  - Every step is still keyed by its message id, so a recheck is a no-op.
  - On the switch, the documents of the last 2 h are rechecked.
  - The per-100 counts come from the documents' steps, counted in D1 (`json_each`). A run still in progress is counted once it concludes.

**P2c: the cell.**
- `RoomCell` runs the rooms. D1 receives the run document only. The transcript goes to R2.
- `agent_thread_messages` stays written in parallel (dual write) during the shadow window.
- The cell is compared with the old path on: the same conclusion, the same per-agent final stances, the same quorum outcome, the same model-call count.

**Retirement criteria (all must hold):**
- 10 consecutive market days with 100% equality on the scoring, replay and compliance comparisons;
- zero runs missing in `room_runs` against the old path;
- zero cell failures not recovered by `ensureRun`;
- every reader moved and its fallback flag unused for 5 market days.

**After retirement:**
- the rooms stop writing `agent_thread_messages`;
- the table stays read-only for 30 days;
- then the table is archived to R2 and dropped (phase 5).

**Backward compatibility for readers:**
- every endpoint keeps its response shape: `/api/war-room/latest`, `/api/threads*`, `/api/tldr`, `/api/news-daily`, `/api/macro-room`, `/api/weighting/replay`, `/api/neuron-allocation`;
- `latest()` and `transcript()` return today's message shape;
- thread ids (`warroom:<date>`, `tf:H1`, …) stay as names in responses.

**Rollback:** at every phase, one flag returns to the previous path. Until P2c's retirement nothing is deleted.

## 6. Expected reduction in D1 rows, measured from production

### Writes today

| Day (2026) | Message rows | Runs |
|---|---|---|
| 11-09 | 3,788 | 144 |
| 11-10 | 3,764 | 147 |
| 11-11 | 2,950 | 117 |
| 11-12 | 3,155 | 141 |
| 11-13 | 3,241 | 141 |

On top of each message row there are:
- the `writeMessage` read-back;
- 2 `upsertThread` statements per run;
- index maintenance on 4 indexes, including the unique key (estimated).

### Reads today

`rows_read` from production `meta`, times frequency (an estimate):

| Query | rows_read per call | Frequency | Rows per market day |
|---|---|---|---|
| outcome scoring `roomStatements`, 15m (`bar_time` filter, no usable index, so it reads every warroom row) | 13,842 | every 15-minute sweep with ready 15m statements, up to 96 a day | up to ~1.3 M |
| weighting replay 15m (`loadRooms`, 10-day window) | 14,056 | hourly, up to 2 calls (before and after apply) | up to ~0.67 M |
| weighting replay 1H (self-join to the brief) | 6,732 | hourly, up to 2 | up to ~0.32 M |
| per-run step reads (`SELECT * … thread_id, run_id`, ~28 rows, per step, plus read-backs) | ~28 | ~26 per run, ~140 runs a day | ~0.1 M |
| `callsInLastHour` budget scan | 311 | once per room run | ~45 k |

**Total:** roughly **2.4 M rows read per market day.** The two scans grow linearly with the table, because they filter on unindexed columns over the whole thread range. 4H/D1 replays, compliance and health checks are smaller and not counted.

### After P2a/P2b

Scoring, replay and compliance read `room_runs` by `(room, bar_close)`:
- the 15m replay over 10 days is about 960 rows;
- a scoring sweep reads the few new runs.

**Estimate:** under 50 k rows read per market day for these readers, **down about 98%**.

### After P2c

- D1 writes per run: about 1–2 rows (the run document) instead of about 26 message rows plus read-backs.
- So about 140–300 rows a day instead of about 3,000–3,800, **down about 90%**.
- The budget scan goes away (DO counter).
- R2: about 140 Class A writes a day.

**Cheaper interim option:**
- an index on `(thread_id, bar_time)`;
- `ts`-bounded scoring and replay queries.

These would remove most of the scoring and replay reads without the cell, as one migration plus query changes. It is listed for the owner's choice and is not part of this blueprint's phases.

**Verification:** the estimates above should be confirmed with the account's D1 analytics (`d1AnalyticsAdaptiveGroups`, rows read and written per day), before P2a and after each phase. I did not read the analytics for this document.

## 7. Owner decisions needed

1. Approve this blueprint (P2a → P2b → P2c), or only the interim index option.
2. The R2 bucket (name, and whether the bus archive and phase 5 share it).
3. The dormant kinds (`live5m`, `live15m`, `hud1h`): archive and remove their scoring branches.
