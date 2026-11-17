// Strategy arm (docs/RFC_STRATEGY_RECOMMENDATION.md, platform ADR-0020; owner 2026-11-17, confirmed in the session:
// "Ya, benar semua", live directly, the score confidence x confluence). At most 3 strategies are armed by the owner's
// one click in Nexus. While 1 to 3 are armed only they may open and close their own positions; while none is armed the
// mode is AUTO: every live strategy may, but each entry is the ONE best by measured confidence x confluence
// (src/decision-engine.mjs pickStrategy). Arming never moves the quorum. Auto-disarm on the kill switch and the daily
// loss limit. The Decision Engine's veto and the Position Manager stay whatever the arm state.
//
// Storage: D1 facts (strategy_arm_state singleton, strategy_arms one row per strategy, strategy_arm_events append-only
// audit) and KV strategy-arms:v1 for the hot reads (the signal at every bridge sync). STRATEGY_ARM_MODE "live" acts,
// "shadow" records and shows only, "off" (the code default) leaves today's behaviour.

export const ARM_MAX = 3;
export const STRATEGY_ARMS_KEY = "strategy-arms:v1";
export const ARM_REASONS = Object.freeze(["owner", "kill_switch", "daily_loss_limit", "breaker", "unavailable", "council"]);

export function strategyArmMode(env) {
  const v = String(env?.STRATEGY_ARM_MODE ?? "off").trim().toLowerCase();
  return v === "live" || v === "shadow" ? v : "off";
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS strategy_arm_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, armed_count INTEGER NOT NULL, updated_ms INTEGER NOT NULL)",
  "INSERT OR IGNORE INTO strategy_arm_state (id, version, armed_count, updated_ms) VALUES (1, 0, 0, 0)",
  `CREATE TABLE IF NOT EXISTS strategy_arms (strategy_id TEXT PRIMARY KEY, armed INTEGER NOT NULL, armed_at INTEGER, armed_by TEXT,
    disarmed_at INTEGER, disarmed_by TEXT, disarm_reason TEXT, version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS strategy_arm_events (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, strategy_id TEXT NOT NULL,
    action TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, request_id TEXT UNIQUE, armed_count_after INTEGER NOT NULL, at INTEGER NOT NULL)`
];
let schemaReady = null;
export async function ensureStrategyArmSchema(db) {
  if (schemaReady === db) return;
  for (const q of SCHEMA) await db.prepare(q).run();
  schemaReady = db;
}
export function resetStrategyArmSchemaCacheForTests() { schemaReady = null; }

/** The arm set from D1: { version, ids, armed_count }. */
export async function readArmsFromDb(db) {
  await ensureStrategyArmSchema(db);
  const st = await db.prepare("SELECT version, armed_count FROM strategy_arm_state WHERE id = 1").first();
  const rows = (await db.prepare("SELECT strategy_id, armed_at, armed_by FROM strategy_arms WHERE armed = 1 ORDER BY armed_at, strategy_id").all()).results ?? [];
  return { version: Number(st?.version ?? 0), armed_count: Number(st?.armed_count ?? 0), ids: rows.map((r) => r.strategy_id), armed: rows.map((r) => ({ id: r.strategy_id, armed_at: r.armed_at, armed_by: r.armed_by })) };
}

/**
 * The arm set for the hot paths: KV first, else D1 (and KV rewritten). { known, version, ids, mode }. `known` false
 * when neither could be read: the signal then stops entries (never AUTO by accident).
 */
export async function readArmState(env) {
  const mode = strategyArmMode(env);
  try {
    const v = JSON.parse((await env?.SIGNAL_CACHE?.get?.(STRATEGY_ARMS_KEY)) || "null");
    if (v && Array.isArray(v.ids) && Number.isFinite(v.version)) return { known: true, mode, version: v.version, ids: v.ids };
  } catch { /* D1 below */ }
  try {
    const s = await readArmsFromDb(env.DB);
    await writeArmCache(env, s);
    return { known: true, mode, version: s.version, ids: s.ids };
  } catch { return { known: false, mode, version: null, ids: [] }; }
}
async function writeArmCache(env, s, now = Date.now()) {
  try { await env?.SIGNAL_CACHE?.put?.(STRATEGY_ARMS_KEY, JSON.stringify({ version: s.version, ids: s.ids, at: now })); } catch { /* the next read rebuilds it from D1 */ }
}

/**
 * Arm or disarm one strategy (the owner's click). `allowed` is the list of live agent ids; an arm also needs no kill and
 * no daily loss floor (`blocked`, a reason or null). Atomic in one D1 batch: the state's version moves only when the
 * arm count allows it, and the row and the event apply only with that version. Idempotent by request_id. Returns
 * { ok, changed, state } or { ok: false, error, state }.
 */
export async function setStrategyArm(env, { strategy_id: id, action, request_id = null, expected_version = null, actor = "owner", actor_sub = undefined, reason = "owner", allowed = [], blocked = null, now = Date.now(), send = null } = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "unavailable" };
  if (strategyArmMode(env) === "off") return { ok: false, error: "arm_mode_off" };
  // A person's click carries actor_sub (the Omega route); the system's auto-disarm (disarmAll) does not use this path.
  if (actor_sub !== undefined && ownerCheck(env, actor_sub) === "not_owner") return { ok: false, error: "owner_only" };
  if (action !== "arm" && action !== "disarm") return { ok: false, error: "action must be arm or disarm" };
  if (typeof id !== "string" || !/^[a-z0-9_]{2,40}$/.test(id)) return { ok: false, error: "unknown strategy" };
  await ensureStrategyArmSchema(db);
  const rid = typeof request_id === "string" && request_id ? request_id.slice(0, 64) : null;
  if (rid && (await db.prepare("SELECT id FROM strategy_arm_events WHERE request_id = ?").bind(rid).first())) return { ok: true, changed: false, repeated: true, state: await readArmsFromDb(db) };
  const s0 = await readArmsFromDb(db);
  const isArmed = s0.ids.includes(id);
  if ((action === "arm") === isArmed) return { ok: true, changed: false, state: s0 };
  if (expected_version != null && Number(expected_version) !== s0.version) return { ok: false, error: "conflict", state: s0 };
  if (action === "arm") {
    if (!allowed.includes(id)) return { ok: false, error: "only a live strategy can be armed", state: s0 };
    if (blocked) return { ok: false, error: `cannot arm while ${blocked}`, state: s0 };
    if (s0.armed_count >= ARM_MAX) return { ok: false, error: `at most ${ARM_MAX} strategies are armed; disarm one first`, state: s0 };
  }
  const v0 = s0.version, v1 = v0 + 1, delta = action === "arm" ? 1 : -1, after = s0.armed_count + delta;
  const guard = "(SELECT version FROM strategy_arm_state WHERE id = 1) = ?";
  const stmts = [
    action === "arm"
      ? db.prepare(`UPDATE strategy_arm_state SET version = ?, armed_count = armed_count + 1, updated_ms = ? WHERE id = 1 AND version = ? AND armed_count < ${ARM_MAX} AND NOT EXISTS (SELECT 1 FROM strategy_arms WHERE strategy_id = ? AND armed = 1)`).bind(v1, now, v0, id)
      : db.prepare("UPDATE strategy_arm_state SET version = ?, armed_count = armed_count - 1, updated_ms = ? WHERE id = 1 AND version = ? AND EXISTS (SELECT 1 FROM strategy_arms WHERE strategy_id = ? AND armed = 1)").bind(v1, now, v0, id),
    action === "arm"
      ? db.prepare(`INSERT INTO strategy_arms (strategy_id, armed, armed_at, armed_by, version) SELECT ?, 1, ?, ?, ? WHERE ${guard} ON CONFLICT(strategy_id) DO UPDATE SET armed = 1, armed_at = excluded.armed_at, armed_by = excluded.armed_by, version = excluded.version`).bind(id, now, String(actor).slice(0, 120), v1, v1)
      : db.prepare(`UPDATE strategy_arms SET armed = 0, disarmed_at = ?, disarmed_by = ?, disarm_reason = ?, version = ? WHERE strategy_id = ? AND ${guard}`).bind(now, String(actor).slice(0, 120), reason, v1, id, v1),
    db.prepare(`INSERT INTO strategy_arm_events (version, strategy_id, action, reason, actor, request_id, armed_count_after, at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`).bind(v1, id, action, reason, String(actor).slice(0, 120), rid, after, now, v1)
  ];
  if (typeof db.batch === "function") await db.batch(stmts); else for (const st of stmts) await st.run();
  const s1 = await readArmsFromDb(db);
  if (s1.version !== v1) return { ok: false, error: "conflict", state: s1 };
  await writeArmCache(env, s1, now);
  if (send) { try { await send(`XAUUSD SYSTEM · Strategy ${id} ${action === "arm" ? "armed" : `disarmed (${reason})`} · ${s1.armed_count}/${ARM_MAX} armed${s1.armed_count === 0 ? " · mode AUTO: the best strategy by confidence × confluence" : ""}`); } catch { /* the audit row stands */ } }
  return { ok: true, changed: true, state: s1 };
}

/** Disarms every armed strategy (system: the kill switch, the daily loss limit). Retries the compare-and-set 3 times. */
export async function disarmAll(env, { reason, now = Date.now(), send = null } = {}) {
  const db = env?.DB;
  if (!db || strategyArmMode(env) === "off") return { status: "off" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const s0 = await readArmsFromDb(db);
    if (!s0.ids.length) return { status: "none_armed" };
    const v0 = s0.version, v1 = v0 + 1, guard = "(SELECT version FROM strategy_arm_state WHERE id = 1) = ?";
    const stmts = [
      db.prepare("UPDATE strategy_arm_state SET version = ?, armed_count = 0, updated_ms = ? WHERE id = 1 AND version = ?").bind(v1, now, v0),
      db.prepare(`UPDATE strategy_arms SET armed = 0, disarmed_at = ?, disarmed_by = 'system', disarm_reason = ?, version = ? WHERE armed = 1 AND ${guard}`).bind(now, reason, v1, v1),
      ...s0.ids.map((id, i) => db.prepare(`INSERT INTO strategy_arm_events (version, strategy_id, action, reason, actor, request_id, armed_count_after, at) SELECT ?, ?, 'disarm', ?, 'system', NULL, ?, ? WHERE ${guard}`).bind(v1, id, reason, s0.ids.length - i - 1, now, v1))
    ];
    if (typeof db.batch === "function") await db.batch(stmts); else for (const st of stmts) await st.run();
    const s1 = await readArmsFromDb(db);
    if (s1.version === v1) {
      await writeArmCache(env, s1, now);
      if (send) { try { await send(`XAUUSD SYSTEM · Strategies disarmed (${reason}): ${s0.ids.join(", ")} · 0/${ARM_MAX} armed · mode AUTO once trading resumes`); } catch { /* audited */ } }
      return { status: "disarmed", ids: s0.ids, version: v1 };
    }
  }
  return { status: "conflict" };
}

// The owner check (RFC §11.3, owner 2026-11-17 "Ya, semua, live"): only the owner's Cloudflare Access user id (the
// JWT `sub`, opaque, no email in config) may arm or disarm. OWNER_ACCESS_SUB holds it; the Omega Worker checks it on
// the route and this Worker checks it again on the RPC. Until the var is set (bootstrap: the id is not known before
// the owner's first visit) the check is "unset": the route stays as it was (Cloudflare Access admits only the owner)
// and each signed-in visitor's sub is recorded once in omega_events (action "owner_sub_seen") so it can be set.
export const OWNER_SUB_SEEN_KEY = "strategy-arm:owner-sub-seen:";
const SUB_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Pure: "owner" | "not_owner" | "unset" for this Access sub. */
export function ownerCheck(env, sub) {
  const want = String(env?.OWNER_ACCESS_SUB ?? "").trim();
  if (!want) return "unset";
  return typeof sub === "string" && sub && sub === want ? "owner" : "not_owner";
}

/** Records a visitor's Access sub once (bootstrap only, while OWNER_ACCESS_SUB is unset). Never throws. */
export async function noteOwnerSub(env, { sub, actor, now = Date.now() } = {}) {
  if (ownerCheck(env, sub) !== "unset" || typeof sub !== "string" || !SUB_RE.test(sub)) return false;
  try {
    const key = OWNER_SUB_SEEN_KEY + sub;
    if (await env.SIGNAL_CACHE?.get?.(key)) return false;
    await env.DB.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, 'owner_sub_seen', ?)").bind(now, String(actor || "unknown").slice(0, 200), JSON.stringify({ sub })).run();
    await env.SIGNAL_CACHE?.put?.(key, "1", { expirationTtl: 7 * 86_400 });
    return true;
  } catch { return false; }
}

/** The state for the page: mode, armed set, count, the last 20 events. */
export async function readStrategyArm(env) {
  try {
    const s = await readArmsFromDb(env.DB);
    const events = (await env.DB.prepare("SELECT id, version, strategy_id, action, reason, actor, armed_count_after, at FROM strategy_arm_events ORDER BY id DESC LIMIT 20").all()).results ?? [];
    return { version: "cryptophys.strategy-arm.v1", mode: strategyArmMode(env), selection: s.ids.length ? "armed" : "auto", max: ARM_MAX, state: s, events };
  } catch (error) {
    return { version: "cryptophys.strategy-arm.v1", mode: strategyArmMode(env), error: String(error?.message ?? error).slice(0, 160) };
  }
}

/** Pure: Omega's daily loss floor is hit (equity at or below the day's start balance less the loss limit). */
export function dailyLossHit(executor, maxDailyLossPct) {
  const eq = Number(executor?.account?.equity), start = Number(executor?.account?.day_start_balance), pct = Number(maxDailyLossPct);
  if (!(eq > 0) || !(start > 0) || !(pct > 0)) return false;
  return eq <= start * (1 - pct / 100);
}
