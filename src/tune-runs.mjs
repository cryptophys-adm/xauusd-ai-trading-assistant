// The record of every auto-tuning step of the sweep (owner 2026-11-11: "ya buat catatan hasil auto-tune di
// D1"). A scheduled run leaves no log the owner or an agent can read afterwards: on 2026-11-11 the first
// witness-weighting run at 11:10 UTC sent nothing to Aether, and only the deployed bundle showed why (a
// deploy outside GitHub Actions had put back the build before the change). Each step (the room weighting
// of each timeframe, the Decision Engine's witness weights) now writes one row: when, how long, the
// deployed version, what the replay saw, what was applied, what Aether answered, and the error if any.
// D1 auto_tune_runs, kept 30 days; read with GET /api/tuning/runs. Counts and statuses only: no price.

export const TUNE_RUNS_VERSION = "cryptophys.auto-tune-runs.v1";
export const TUNE_RUNS_KEEP_DAYS = 30;
const DAY_MS = 86_400_000;
const STEP = /^(weighting:(15|60|240|1D)|witness)$/;

export const TUNE_RUNS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS auto_tune_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    step TEXT NOT NULL,
    ran_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
    apply_status TEXT,
    push_status TEXT,
    duration_ms INTEGER,
    version_id TEXT,
    detail_json TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_auto_tune_runs_step ON auto_tune_runs(step, ran_at)"
];
let schemaReady = false;
export function resetTuneRunsSchemaCacheForTests() { schemaReady = false; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of TUNE_RUNS_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Pure: what a replay (room weighting or witness weights) saw, in counts. */
export function replaySummary(replay) {
  if (!replay || typeof replay !== "object") return null;
  const verdicts = {};
  for (const c of replay.candidates || []) { const v = String(c.verdict ?? "unknown").split(":")[0]; verdicts[v] = (verdicts[v] || 0) + 1; }
  const best = [...(replay.candidates || [])].sort((a, b) => ((b.discovery?.bars ?? 0) + (b.holdout?.bars ?? 0)) - ((a.discovery?.bars ?? 0) + (a.holdout?.bars ?? 0)))[0];
  return {
    active: replay.active?.id ?? replay.control?.id ?? null,
    source: replay.active?.source ?? null,
    rooms: num(replay.rooms),
    scored: num(replay.control?.scored_rooms),
    accuracy: num(replay.control?.accuracy),
    candidates: (replay.candidates || []).length,
    verdicts,
    most_paired: best ? { id: best.id ?? null, discovery: num(best.discovery?.bars), holdout: num(best.holdout?.bars) } : null,
    reverse: replay.reverse ? { decisions: num(replay.reverse.rooms), p_value: num(replay.reverse.p_value) } : null,
    ...(replay.replay_fidelity ? { fidelity: num(replay.replay_fidelity.share), fidelity_checks: num(replay.replay_fidelity.checks) } : {})
  };
}

/** Pure: the row of one step from its outcome. */
export function tuneRunRow({ step, startedMs, finishedMs, versionId = null, replay = null, applied = null, pushed = null, error = null }) {
  return {
    step,
    ran_at: new Date(startedMs).toISOString(),
    status: error ? "failed" : "ok",
    apply_status: clip(applied?.status, 40),
    push_status: clip(pushed?.status, 40),
    duration_ms: Math.max(0, Math.round(finishedMs - startedMs)),
    version_id: clip(versionId, 64),
    detail: {
      replay: replaySummary(replay),
      applied: applied ? { status: applied.status ?? null, reason: clip(applied.reason ?? applied.error, 300), id: applied.id ?? null, from: applied.from ?? null } : null,
      pushed: pushed ? { status: pushed.status ?? null, reason: clip(pushed.reason ?? pushed.error, 300), candidates: num(pushed.candidates) } : null,
      error: clip(error, 300)
    }
  };
}

/** Writes one step's row and drops rows older than TUNE_RUNS_KEEP_DAYS. Never throws. */
export async function recordTuneRun(env, run, { now = Date.now() } = {}) {
  if (!env?.DB || !STEP.test(String(run?.step ?? ""))) return { status: "skipped" };
  try {
    await ensureSchema(env.DB);
    const r = tuneRunRow(run);
    await env.DB.prepare("INSERT INTO auto_tune_runs (step, ran_at, status, apply_status, push_status, duration_ms, version_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(r.step, r.ran_at, r.status, r.apply_status, r.push_status, r.duration_ms, r.version_id, JSON.stringify(r.detail)).run();
    await env.DB.prepare("DELETE FROM auto_tune_runs WHERE ran_at < ?").bind(new Date(now - TUNE_RUNS_KEEP_DAYS * DAY_MS).toISOString()).run();
    return { status: "recorded" };
  } catch (e) {
    return { status: "failed", error: clip(e?.message ?? e, 200) };
  }
}

/**
 * Runs one sweep step and records it. `fn` returns { replay, applied, pushed }; an exception is recorded
 * as a failed run and not thrown (the sweep goes on to the next step).
 */
export async function runTuneStep(env, step, fn, { clock = () => Date.now() } = {}) {
  const startedMs = clock();
  const versionId = typeof env?.CF_VERSION_METADATA?.id === "string" ? env.CF_VERSION_METADATA.id : null;
  let out = {}, error = null;
  try { out = (await fn()) || {}; } catch (e) { error = e instanceof Error ? e.message : String(e); }
  await recordTuneRun(env, { step, startedMs, finishedMs: clock(), versionId, ...out, error }, { now: startedMs });
  return { ...out, error };
}

/** The latest row of every step and the last `limit` rows (of one step when given), newest first. */
export async function readTuneRuns(env, { step = null, limit = 48 } = {}) {
  const parse = (row) => { let detail = null; try { detail = JSON.parse(row.detail_json); } catch { detail = null; } const { detail_json: _d, ...rest } = row; return { ...rest, ...(detail || {}) }; };
  if (!env?.DB) return { version: TUNE_RUNS_VERSION, latest: [], runs: [] };
  await ensureSchema(env.DB);
  const n = Math.max(1, Math.min(200, Number(limit) || 48));
  const filter = step && STEP.test(step) ? step : null;
  const runs = ((filter
    ? await env.DB.prepare("SELECT * FROM auto_tune_runs WHERE step = ? ORDER BY ran_at DESC, id DESC LIMIT ?").bind(filter, n).all()
    : await env.DB.prepare("SELECT * FROM auto_tune_runs ORDER BY ran_at DESC, id DESC LIMIT ?").bind(n).all()).results || []).map(parse);
  const latest = ((await env.DB.prepare("SELECT r.* FROM auto_tune_runs r JOIN (SELECT step, MAX(id) AS id FROM auto_tune_runs GROUP BY step) m ON m.id = r.id ORDER BY r.step").all()).results || []).map(parse);
  return { version: TUNE_RUNS_VERSION, keep_days: TUNE_RUNS_KEEP_DAYS, latest, runs };
}
