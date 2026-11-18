// Account Profiles, phase 1 (docs/RFC_ACCOUNT_PROFILES.md §1, §2, §4, §9; owner 2026-11-18: "tidak ada shadow,
// langsung live", the live account as Custom with its current settings).
//
// What this module does:
//   - The broker spec. Each bridge sync's executor state gives the account and symbol spec (OmegaExecutor 1.14
//     reports the symbol contract; 1.15 adds leverage, margin mode, free margin, freeze level, the symbol's trade
//     mode and the margin per lot). The stable part of it is hashed. An account's first spec validates at once when
//     it is usable. A changed hash BLOCKS NEW ENTRIES (planIntents gate `spec_unvalidated`) until the spec validates
//     (`specProblem` is null) and has held for SPEC_SETTLE_MS; an unusable spec blocks them until it is usable. Open positions are still managed and can be closed. Each change is an Omega event and one
//     Telegram line.
//   - The minimum EA version for entries (`ea_outdated`), behind OMEGA_EA_VERSION_GATE "on" (off until the owner
//     has compiled OmegaExecutor 1.15 on the VPS).
//   - The account's profile row: the first account ever seen (the live account) starts as Custom with the settings
//     it trades today, ceiling Custom, agent mode autonomous. Phase 1 stores it; it changes no lot size.
//
// The account is never named by its login. With 1.15 the EA sends `account.login_hash` (SHA-256 of
// "omega|<server>|<login>"); the reference is a hash of that ("acct_" + 16 hex). Before 1.15 the reference is a
// hash of the server name (legacy), adopted by the first 1.15 sync on the same server. The reference is opaque in
// logs, events, Telegram and digests; it is not a secret (a login is a small number, so its hash can be guessed by
// whoever knows the server), so nothing here treats it as one.
//
// D1 table (created lazily): omega_accounts, one row per account reference.

export const SPEC_SETTLE_MS = 60_000;
// 1.16 since 2026-11-18: OmegaExecutor 1.15 refused every open under unlimited leverage (margin rounded to 0.00 read as
// "margin_unknown"), so new entries wait for 1.16 instead of sending orders the EA can only refuse.
export const EXECUTOR_ENTRY_MIN_VERSION = "1.16";

/** The profiles (RFC §4). Custom takes the account's own settings. Phase 1 stores; phase 2 sizes within them. */
export const PROFILES = Object.freeze({
  safe: Object.freeze({ label: "Safe", target_risk_pct: 1, hard_cap_pct: 2, open_risk_pct: 2, daily_loss_pct: 3, max_positions: 1, modes: ["swing", "intraday"] }),
  conservative: Object.freeze({ label: "Conservative", target_risk_pct: 2, hard_cap_pct: 5, open_risk_pct: 5, daily_loss_pct: 6, max_positions: 2, modes: ["intraday", "swing"] }),
  aggressive: Object.freeze({ label: "Aggressive", target_risk_pct: 5, hard_cap_pct: 10, open_risk_pct: 10, daily_loss_pct: 10, max_positions: 3, modes: ["scalp", "intraday", "swing"] }),
  custom: Object.freeze({ label: "Custom", target_risk_pct: null, hard_cap_pct: null, open_risk_pct: null, daily_loss_pct: null, max_positions: null, modes: null })
});
export const PROFILE_IDS = Object.freeze(Object.keys(PROFILES));
export const AGENT_MODES = Object.freeze(["approval", "autonomous"]);

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS omega_accounts (account_ref TEXT PRIMARY KEY, server TEXT, legacy INTEGER NOT NULL DEFAULT 0,
    spec_hash TEXT, spec TEXT, spec_status TEXT NOT NULL DEFAULT 'pending', spec_problem TEXT, spec_since_ms INTEGER, spec_validated_ms INTEGER,
    profile TEXT NOT NULL, ceiling TEXT NOT NULL, agent_mode TEXT NOT NULL, custom TEXT, profile_by TEXT, profile_ms INTEGER, created_ms INTEGER NOT NULL)`
];
// Once per isolate, like omega-broker's schema (resetOmegaBrokerSchemaForTests resets this one too).
// Phase 3 (src/profile-agent.mjs): the profile agent's state on the same row. Added to an existing table one column
// at a time; "duplicate column" on a second run is expected and ignored.
export const AGENT_COLUMNS = [
  ["balance_peak", "REAL"],            // the highest balance since the row exists (the "prior peak" of an upgrade)
  ["dd_ref", "REAL"],                  // the drawdown trigger's reference, reset to equity by each drawdown step
  ["last_upgrade_ms", "INTEGER"],      // the last upgrade (at most one per 7 days)
  ["upgrade_block_until_ms", "INTEGER"], // no autonomous upgrade before (the next UTC day after a kill or the daily loss)
  ["vol_latched", "INTEGER"],          // an extreme-volatility step taken; re-armed once volatility is normal again
  ["pending_upgrade", "TEXT"],         // approval mode: the upgrade the agent proposes, for the owner's click
  // The profile council (src/profile-council.mjs), downgrade review on (OMEGA_PROFILE_COUNCIL_DOWNGRADE "on") only:
  ["pending_downgrade", "TEXT"],       // a soft downgrade waiting for its review (new entries wait with it)
  ["council_veto", "TEXT"]             // the council's veto of a soft downgrade: { reason, until_ms, review_id }
];
let schemaReady = false;
export function resetAccountSpecSchemaForTests() { schemaReady = false; }
export async function ensureAccountSchema(db) {
  if (schemaReady) return;
  for (const sql of SCHEMA_SQL) await db.prepare(sql).run();
  for (const [name, type] of AGENT_COLUMNS) {
    try { await db.prepare(`ALTER TABLE omega_accounts ADD COLUMN ${name} ${type}`).run(); }
    catch (e) { if (!/duplicate column/i.test(String(e?.message ?? e))) throw e; }
  }
  schemaReady = true;
}
const ensureSchema = ensureAccountSchema;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const parse = (text, fallback = null) => { try { return text == null ? fallback : JSON.parse(text); } catch { return fallback; } };

export function versionAtLeast(v, min) {
  if (typeof v !== "string" || !/^\d+(\.\d+){0,3}$/.test(v)) return false;
  const a = v.split(".").map(Number), b = String(min).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x > y; }
  return true;
}

/** Whether the executor reports the 1.15 spec (leverage, margin mode, margin per lot...). */
export const FULL_SPEC_VERSION = "1.15";
export const reportsFullSpec = (executor) => versionAtLeast(executor?.executor?.version ?? null, FULL_SPEC_VERSION);

/** Whether new entries need EXECUTOR_ENTRY_MIN_VERSION (owner: on once OmegaExecutor 1.15 runs on the VPS). */
export const eaVersionGateOn = (env) => String(env?.OMEGA_EA_VERSION_GATE ?? "").trim() === "on";

/**
 * Pure: the stable part of the spec, the one that is hashed. Prices, equity, free margin, the margin per lot, the
 * tick value (it moves with the exchange rate on a non-USD account), the spread and the stops and freeze levels
 * (some brokers widen them around news) are not in it: they are checked at each entry, by the server and the EA.
 */
export function specFrom(executor) {
  const a = executor?.account ?? {}, s = executor?.symbol ?? {};
  const v = (x) => (x === undefined ? null : x);
  return {
    server: v(executor?.server),
    account_currency: v(a.currency),
    leverage: v(a.leverage),
    margin_mode: v(a.margin_mode),
    symbol: v(s.name),
    currency_profit: v(s.currency_profit),
    currency_base: v(s.currency_base),
    contract_size: v(s.contract_size),
    digits: v(s.digits),
    point: v(s.point),
    tick_size: v(s.tick_size),
    volume_min: v(s.volume_min),
    volume_max: v(s.volume_max),
    volume_step: v(s.volume_step),
    trade_mode: v(s.trade_mode)
  };
}

/** SHA-256 hex of a text. */
async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The spec's hash: SHA-256 of its fields in a fixed order, 16 hex. */
export async function specHash(spec) {
  return (await sha256(JSON.stringify(Object.keys(spec).sort().map((k) => [k, spec[k]])))).slice(0, 16);
}

/**
 * Pure: why the reported spec is not one Omega can size and send on, or null. With an EA before 1.15 only the
 * fields it reports are required; with 1.15 the account and margin fields are too.
 */
export function specProblem(executor) {
  if (!executor || typeof executor !== "object") return "no_state";
  const a = executor.account ?? {}, s = executor.symbol ?? {};
  if (typeof executor.server !== "string" || !executor.server) return "no_server";
  if (typeof a.currency !== "string" || !a.currency) return "no_account_currency";
  if (typeof s.name !== "string" || !s.name) return "no_symbol";
  if (!Number.isInteger(s.digits) || s.digits < 0 || s.digits > 8) return "digits";
  for (const k of ["point", "tick_size", "tick_value", "volume_min", "volume_step", "contract_size"]) {
    if (!finite(s[k]) || s[k] <= 0) return k;
  }
  if (!finite(s.volume_max) || s.volume_max < s.volume_min) return "volume_max";
  if (finite(s.stops_level_points) && s.stops_level_points < 0) return "stops_level_points";
  if (!reportsFullSpec(executor)) return null;
  if (!finite(a.leverage) || a.leverage <= 0) return "leverage";
  if (!["hedging", "netting", "exchange"].includes(a.margin_mode)) return "margin_mode";
  if (s.trade_mode !== "full" && s.trade_mode !== "long_only" && s.trade_mode !== "short_only") return `trade_mode_${s.trade_mode ?? "unknown"}`;
  // 0 is valid: under unlimited leverage the terminal may round a lot's margin to 0.00 (1.16 fix, 2026-11-18).
  if (!finite(s.margin_per_lot) || s.margin_per_lot < 0) return "margin_per_lot";
  if (finite(s.freeze_level_points) && s.freeze_level_points < 0) return "freeze_level_points";
  return null;
}

/**
 * Pure (phase 2, RFC §3-4): the limits new entries are sized within. The profile's caps are the outer bound and the
 * engine settings (the owner's, or the Aether policy inside OMEGA_POLICY_BOUNDS) may only tighten inside them, so each
 * limit is the smaller of the two. Custom is the account's own settings, unchanged (the live account sizes as today).
 * Returns { profile, risk_pct, max_positions, max_daily_loss_pct, hard_cap_pct, open_risk_pct }; a cap the profile does
 * not set is null.
 */
export function effectiveLimits(profile, settings = {}) {
  const P = PROFILES[profile] ?? PROFILES.safe;
  const id = PROFILES[profile] ? profile : "safe";
  const min = (a, b) => (finite(a) && finite(b) ? Math.min(a, b) : finite(a) ? a : finite(b) ? b : null);
  if (id === "custom") {
    return { profile: id, risk_pct: settings.risk_pct ?? null, max_positions: settings.max_positions ?? null, max_daily_loss_pct: settings.max_daily_loss_pct ?? null, hard_cap_pct: null, open_risk_pct: null };
  }
  return {
    profile: id,
    risk_pct: min(settings.risk_pct, P.target_risk_pct),
    max_positions: min(settings.max_positions, P.max_positions),
    max_daily_loss_pct: min(settings.max_daily_loss_pct, P.daily_loss_pct),
    hard_cap_pct: P.hard_cap_pct,
    open_risk_pct: P.open_risk_pct
  };
}

/** The opaque account reference: { ref, legacy, legacy_ref }. Never the login. */
export async function accountRef(executor) {
  const server = typeof executor?.server === "string" ? executor.server : "";
  const legacyRef = "acct_" + (await sha256(`server|${server}`)).slice(0, 16);
  const lh = executor?.account?.login_hash;
  if (typeof lh === "string" && /^[0-9a-f]{64}$/.test(lh)) return { ref: "acct_" + (await sha256(`login|${lh}`)).slice(0, 16), legacy: false, legacy_ref: legacyRef };
  return { ref: legacyRef, legacy: true, legacy_ref: legacyRef };
}

/** Pure: the fields that differ between two stored specs (names only). */
export function specDiff(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null)).sort();
}

const rowOut = (r) => r ? ({
  account_ref: r.account_ref, server: r.server ?? null, legacy: Number(r.legacy) === 1,
  spec_hash: r.spec_hash ?? null, spec: parse(r.spec), spec_status: r.spec_status, spec_problem: r.spec_problem ?? null,
  spec_since_ms: r.spec_since_ms ?? null, spec_validated_ms: r.spec_validated_ms ?? null,
  profile: r.profile, ceiling: r.ceiling, agent_mode: r.agent_mode, custom: parse(r.custom),
  profile_by: r.profile_by ?? null, profile_ms: r.profile_ms ?? null, created_ms: r.created_ms,
  balance_peak: r.balance_peak ?? null, last_upgrade_ms: r.last_upgrade_ms ?? null, upgrade_block_until_ms: r.upgrade_block_until_ms ?? null,
  pending_upgrade: parse(r.pending_upgrade),
  pending_downgrade: parse(r.pending_downgrade), council_veto: parse(r.council_veto)
}) : null;

/** The Custom snapshot of the account's settings (risk per trade, positions, daily loss) as they trade today. */
export const customFrom = (settings) => ({
  risk_pct: finite(settings?.risk_pct) ? settings.risk_pct : null,
  max_positions: Number.isInteger(settings?.max_positions) ? settings.max_positions : null,
  max_daily_loss_pct: finite(settings?.max_daily_loss_pct) ? settings.max_daily_loss_pct : null
});

/**
 * One bridge sync's account step: find or create the account row, follow its spec, and return what the planner
 * needs: { account_ref, spec_status: "validated" | "pending" | "invalid", spec_problem, profile, ceiling, agent_mode }.
 * D1 writes only when something changes (a new account, a new spec hash, a status change). `log(action, detail)`
 * records an Omega event, `notify(text)` sends one Telegram line; both are awaited and their failures ignored.
 */
export async function syncAccount(db, executor, { settings = null, now = Date.now(), log = null, notify = null } = {}) {
  await ensureSchema(db);
  const { ref, legacy, legacy_ref } = await accountRef(executor);
  const say = async (action, detail, text) => {
    try { if (log) await log(action, detail); } catch { /* audit is best effort, the gate is not */ }
    try { if (notify && text) await notify(text); } catch { /* the Telegram line is best effort */ }
  };

  let row = await db.prepare("SELECT * FROM omega_accounts WHERE account_ref = ?").bind(ref).first();
  // The first OmegaExecutor 1.15 sync on a server adopts the row its older EA had (the same account, now with a login hash).
  if (!row && !legacy) {
    const old = await db.prepare("SELECT * FROM omega_accounts WHERE account_ref = ? AND legacy = 1").bind(legacy_ref).first();
    if (old) {
      await db.prepare("UPDATE omega_accounts SET account_ref = ?, legacy = 0 WHERE account_ref = ?").bind(ref, legacy_ref).run();
      row = { ...old, account_ref: ref, legacy: 0 };
      await say("account_ref_upgraded", { from: legacy_ref, to: ref }, null);
    }
  }

  const spec = specFrom(executor);
  const hash = await specHash(spec);
  const problem = specProblem(executor);

  if (!row) {
    // The first account Omega ever sees is the live one (owner 2026-11-18): Custom, its current settings, ceiling
    // Custom, autonomous. Any later account starts at Safe, ceiling Safe, approval mode.
    const first = !(await db.prepare("SELECT 1 AS x FROM omega_accounts LIMIT 1").first());
    const profile = first ? "custom" : "safe";
    const agentMode = first ? "autonomous" : "approval";
    const custom = first ? JSON.stringify(customFrom(settings)) : null;
    // A first spec is no change: it validates at once when it is usable (the live account keeps trading as it does
    // today). Only a later change waits SPEC_SETTLE_MS.
    const status = problem ? "invalid" : "validated";
    await db.prepare(`INSERT INTO omega_accounts (account_ref, server, legacy, spec_hash, spec, spec_status, spec_problem, spec_since_ms, spec_validated_ms, profile, ceiling, agent_mode, custom, profile_by, profile_ms, created_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, ?)`)
      .bind(ref, spec.server, legacy ? 1 : 0, hash, JSON.stringify(spec), status, problem, now, problem ? null : now, profile, profile, agentMode, custom, now, now).run();
    await say("account_seen", { account_ref: ref, profile, ceiling: profile, agent_mode: agentMode, spec_hash: hash, spec_problem: problem },
      `Omega: account ${ref} seen, profile ${PROFILES[profile].label}${problem ? `; its broker spec is not usable (${problem}), no new entries` : "; broker spec validated"}.`);
    return { account_ref: ref, spec_status: status, spec_problem: problem, profile, ceiling: profile, agent_mode: agentMode, row: await db.prepare("SELECT * FROM omega_accounts WHERE account_ref = ?").bind(ref).first() };
  }

  let status = row.spec_status, since = Number(row.spec_since_ms) || now;
  if (row.spec_hash !== hash) {
    const changed = specDiff(parse(row.spec, {}), spec);
    status = problem ? "invalid" : "pending";
    since = now;
    await db.prepare("UPDATE omega_accounts SET server = ?, spec_hash = ?, spec = ?, spec_status = ?, spec_problem = ?, spec_since_ms = ?, spec_validated_ms = NULL WHERE account_ref = ?")
      .bind(spec.server, hash, JSON.stringify(spec), status, problem, now, ref).run();
    await say("spec_changed", { account_ref: ref, from: row.spec_hash ?? null, to: hash, changed, problem },
      `Omega: the broker spec of ${ref} changed (${changed.join(", ") || "first report"}). New entries wait until it validates; open positions are still managed.`);
  } else if (problem && status !== "invalid") {
    status = "invalid";
    // The same spec with a field the terminal briefly cannot give (a tick value of 0 while it reconnects): an event,
    // no Telegram line, and it validates again after SPEC_SETTLE_MS without one either.
    await db.prepare("UPDATE omega_accounts SET spec_status = 'invalid', spec_problem = ? WHERE account_ref = ?").bind(problem, ref).run();
    await say("spec_invalid", { account_ref: ref, spec_hash: hash, problem }, null);
  } else if (!problem && status === "invalid") {
    status = "pending"; since = now;
    await db.prepare("UPDATE omega_accounts SET spec_status = 'pending', spec_problem = NULL, spec_since_ms = ? WHERE account_ref = ?").bind(now, ref).run();
  } else if (!problem && status === "pending" && now - since >= SPEC_SETTLE_MS) {
    status = "validated";
    await db.prepare("UPDATE omega_accounts SET spec_status = 'validated', spec_problem = NULL, spec_validated_ms = COALESCE(spec_validated_ms, ?) WHERE account_ref = ?").bind(now, ref).run();
    const firstTime = row.spec_validated_ms == null;
    await say("spec_validated", { account_ref: ref, spec_hash: hash }, firstTime ? `Omega: the broker spec of ${ref} is validated. New entries may open again.` : null);
  }
  return { account_ref: ref, spec_status: status, spec_problem: status === "validated" ? null : problem, profile: row.profile, ceiling: row.ceiling, agent_mode: row.agent_mode, row };
}

/**
 * Pure: the broker label for notifications and pages (orchestrator relay, owner 2026-11-18: "label notif alert ... harus
 * dinamis sesuai dengan brokernya"), e.g. "FxPro (DEMO) · GOLD". The broker is the first word of the server the
 * terminal reports; a spec that is not validated (or no server) reads "broker unknown". The account mode is DEMO, LIVE
 * or CONTEST; the symbol is the broker's own.
 */
export function brokerLabel(executor, { validated = false } = {}) {
  const server = typeof executor?.server === "string" ? executor.server.trim() : "";
  const word = server.split(/[-_. ]/)[0];
  const broker = validated && word ? word : "broker unknown";
  const mode = { demo: "DEMO", real: "LIVE", contest: "CONTEST" }[executor?.account?.trade_mode] ?? "?";
  const symbol = typeof executor?.symbol?.name === "string" && executor.symbol.name ? ` · ${executor.symbol.name}` : "";
  return `${broker} (${mode})${symbol}`;
}

/** The broker label for this executor, its spec status read from D1 (notifications only: one read each). */
export async function brokerLabelFor(db, executor) {
  try {
    await ensureSchema(db);
    const { ref } = await accountRef(executor);
    const row = await db.prepare("SELECT spec_status FROM omega_accounts WHERE account_ref = ?").bind(ref).first();
    return brokerLabel(executor, { validated: row?.spec_status === "validated" });
  } catch {
    return brokerLabel(executor, { validated: false });
  }
}

/** The account rows for the Omega page (newest first, at most 20). */
export async function readAccounts(db) {
  await ensureSchema(db);
  const rows = await db.prepare("SELECT * FROM omega_accounts ORDER BY created_ms DESC LIMIT 20").all();
  return (rows.results ?? []).map(rowOut);
}

/** Pure: a readable line for the Omega page. */
export function specStatusText(a) {
  if (!a) return "No account seen yet.";
  if (a.spec_status === "validated") return `Broker spec validated (${a.spec_hash}).`;
  if (a.spec_status === "invalid") return `Broker spec not usable: ${String(a.spec_problem ?? "unknown").replace(/_/g, " ")}. No new entries.`;
  return `Broker spec new or changed (${a.spec_hash}): no new entries until it validates (it must hold ${SPEC_SETTLE_MS / 1000} s).`;
}
