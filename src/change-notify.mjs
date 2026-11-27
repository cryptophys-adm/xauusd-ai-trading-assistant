// The change audit on Telegram (owner 2026-11-20: "harus ada notif Telegram karena buat mengetahui dan audit"). Every
// change that affects trading leaves a row in D1 omega_events (the audit). This module reads those rows after a cursor
// and sends one private line per change to the owner's chat (sendOmegaTelegram → TELEGRAM_CHAT_ID), next to the row:
// who (the owner, an agent, Aether), old → new, when. A switch saved many times in a row (the owner saved 8 times in
// about 70 s on 2026-11-20) is one line per switch per minute, with the value it ended on; a held change goes out with
// the next sweep after its minute (every 5 minutes on the ledger cron, hourly while the market is closed, and right
// after every settings save). No price, account number, login or email in a line.

export const AUDIT_NOTIFY_KEY = "audit:notify:v1";
export const AUDIT_DEBOUNCE_MS = 60_000;
const BATCH = 200;

/**
 * Every omega_events action is in exactly one of three lists (test/change-audit.test.mjs fails on a new action that is in
 * none): told by this sweep, told where it happens (its own Telegram line next to its audit row), or not a change.
 */
export const AUDIT_ACTIONS = Object.freeze({
  settings: "Omega settings changed",
  profile_agent_mode_set: "Profile agent mode set",
  upgrade_block_cleared: "Profile upgrade block cleared",
  upgrade_block_lifted: "Profile upgrade block lifted",
  position_delegated: "Position delegated to Omega",
  delegate_mode_on: "Delegation turned on",
  delegate_mode_off: "Delegation turned off",
  owner_modify_position: "Position modified by hand",
  owner_modify_order: "Pending order modified by hand",
  profile_proposal_declined: "Profile proposal declined",
  position_manual_close_requested: "Manual close requested",
  connection_set: "Broker connection set",
  connection_cleared: "Broker connection cleared",
  // F1: a data-only feed bridge's login (src/feed-bridge.mjs).
  feed_connection_set: "Feed bridge connection set",
  feed_connection_cleared: "Feed bridge connection cleared",
  connection_needs_reentry: "Broker connection needs re-entry",
  bridge_symbol: "Bridge symbol set",
  bridge_key_changed: "Bridge key changed",
  symbol_changed: "Trade symbol changed",
  balance_operation: "Balance operation (deposit or withdrawal) seen",
  liquidity_baseline_reset: "Liquidity baseline reset"
});
/** Told where they happen (src/profile-agent.mjs, mode-selector, account-spec, position-exit, the limit lines, ...). */
export const TOLD_ELSEWHERE = Object.freeze([
  "profile_changed", "profile_ceiling_set", "profile_baseline_reset", "profile_baseline_reset_override", "profile_proposed",
  "profile_downgrade_vetoed", "profile_upgrade_refused", "mode_changed", "spec_changed", "position_closed", "probation_set",
  "probation_reverted", "lens_weight_floor", "limit_placed", "limit_moved", "limit_cancelled", "limit_filled", "limit_fail_closed", "limit_fault_cleared",
  "pm_stop_loosened", "pm_tp_moved", "autonomous_recovery",
  // Feed content staleness (src/feed-stale.mjs): told once per episode by the relay.
  "feed_stale",
  // MS2: the mode probation passed (src/mode-selector.mjs tells it in one line; its failure is a mode_changed).
  "mode_probation_passed",
  // FS1: an owner feature-switch change (src/feature-switch-store.mjs tells it in one line next to its audit row).
  "feature_switch"
]);
/** Not a change of what Omega trades with: a state, a reading or a refused attempt (health alerts carry the problems). */
export const NOT_A_CHANGE = Object.freeze([
  "plan", "intent_reconciled", "symbol_refused", "terminal_error", "account_seen", "spec_validated", "account_ref_upgraded",
  "owner_sub_seen", "profile_control_refused", "profile_review_pending", "mode_unchanged", "liquidity_backfill_failed",
  // MS1: the mode selector's daily outcome (src/mode-selector.mjs), a reading; a change is its own mode_changed.
  "mode_selector_run",
  // Recovery backoff (src/recovery-hold.mjs): a healthy state after a recovery, which re-arms the watchdog.
  "recovery_rearmed"
]);

/** The settings keys in words (anything else is shown by its own name). */
const SETTING_WORDS = Object.freeze({
  enabled: "engine", live_armed: "live arm", risk_pct: "risk per trade %", max_positions: "max positions",
  max_daily_loss_pct: "daily loss limit %", max_spread_points: "max spread (points)", max_signal_age_ms: "max signal age",
  policy_auto: "Aether policy auto", entry_order: "entry order", pm_loosen_enabled: "stop/target loosening (A8)",
  positioning_enabled: "positioning lens", liquidity_enabled: "liquidity lens", wait_bias_entry: "WAIT-with-bias entry",
  tp_ladder: "TP ladder", trailing_stop_r: "trailing stop R", sor_mode: "order routing", profit_lock_gate: "profit-lock gate", change_thresholds: "change thresholds", pm_fast_1m: "1m fast-protect layer", reentry_1m: "1m re-entry", limit_supersede: "newer signal supersedes a resting limit", cd_gate: "confidence-drop gate", zone_mgmt: "zone-typed management", zone_sd: "supply/demand box levels in management"
});
// Keys whose value never appears in a line, by exact name (a pattern hid ladder_lock_pips: orchestrator review of #511):
// identity and credentials, and prices (the private chat may carry them, but this audit says what changed, not where).
const HIDDEN_KEYS = new Set(["login", "password", "account", "account_ref", "account_number", "server", "email", "sub", "actor_sub",
  "envelope", "token", "secret", "kid", "ip", "public_key", "private_key", "sl", "tp", "price", "entry", "stop", "target", "fill_price"]);
const hidden = (k) => HIDDEN_KEYS.has(String(k).toLowerCase());

/** Pure: who made a change, in words; never an email or an Access identity. "owner" only for a person's identity. */
export function actorLabel(actor) {
  const a = String(actor ?? "").trim();
  if (!a) return "unknown";
  if (a.startsWith("agent:")) return `agent ${a.slice(6).replace(/[^a-z0-9_-]/gi, "").slice(0, 30) || "?"}`;
  if (/^aether/i.test(a)) return a.toLowerCase().startsWith("aether-rollback") ? "Aether (rollback)" : "Aether";
  if (a.includes("@") || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(a) || a === "owner" || a === "person") return "owner";
  if (/\.access$/.test(a)) return "service token"; // a Cloudflare Access service token (its client id ends in .access)
  return a.replace(/[^a-z0-9_ -]/gi, "").slice(0, 30) || "unknown";
}

/** Pure: a value in words. */
export function valueWords(key, v) {
  if (v === true) return "on";
  if (v === false) return "off";
  if (v == null) return "—";
  if (key === "max_signal_age_ms" && Number.isFinite(Number(v))) return `${Math.round(Number(v) / 60_000)} min`;
  if (typeof v === "object") return JSON.stringify(v).slice(0, 60);
  return String(v).slice(0, 60);
}

const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
const parse = (t, d = null) => { try { return t == null ? d : JSON.parse(t); } catch { return d; } };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Pure: one sweep over the audit rows after the cursor. `state` is KV audit:notify:v1 ({ cursor, baseline, sent_ms,
 * pending }); `rows` the omega_events rows (id order); `context.ea_version` the terminal's OmegaExecutor version.
 * Returns { state, lines }. Settings rows are compared key by key with the baseline (the settings last told); a key told
 * less than AUDIT_DEBOUNCE_MS ago waits in `pending` and goes with a later sweep, showing where it ended. A key changed
 * and changed back inside its minute says nothing. Other actions are one line each.
 */
export function auditSweep(state, rows, { now = Date.now(), context = {} } = {}) {
  const s = { cursor: Number(state?.cursor) || 0, baseline: { ...(state?.baseline ?? {}) }, sent_ms: { ...(state?.sent_ms ?? {}) }, pending: { ...(state?.pending ?? {}) } };
  const lines = [];
  for (const r of rows || []) {
    s.cursor = Math.max(s.cursor, Number(r.id) || 0);
    const detail = parse(r.detail, {});
    if (r.action === "settings") {
      const next = detail && typeof detail === "object" ? detail : {};
      for (const k of Object.keys(next)) {
        if (hidden(k)) continue;
        const from = Object.hasOwn(s.pending, k) ? s.pending[k].from : s.baseline[k];
        if (same(next[k], s.baseline[k])) continue;
        s.pending[k] = { from, to: next[k], actor: actorLabel(r.actor), ms: Number(r.ms) || now };
        s.baseline[k] = next[k];
      }
      continue;
    }
    const what = AUDIT_ACTIONS[r.action];
    if (!what) continue;
    const parts = Object.entries(detail && typeof detail === "object" ? detail : {})
      .filter(([k, v]) => !hidden(k) && v != null && typeof v !== "object")
      .slice(0, 4).map(([k, v]) => `${k} ${valueWords(k, v)}`);
    lines.push(`XAUUSD SYSTEM · ${what} by ${actorLabel(r.actor)} · ${hhmm(Number(r.ms) || now)} UTC${parts.length ? `\n${parts.join(" · ")}` : ""}`);
  }
  // The settings changes whose minute has passed, grouped by who made them.
  const due = Object.entries(s.pending).filter(([k]) => !(Number(s.sent_ms[k]) > 0 && now - Number(s.sent_ms[k]) < AUDIT_DEBOUNCE_MS));
  const byActor = new Map();
  for (const [k, p] of due) {
    delete s.pending[k];
    if (same(p.from, p.to)) continue;
    s.sent_ms[k] = now;
    const ea = k === "entry_order" && p.to !== "market" ? ` (EA ${context.ea_version ?? "version unknown"}${context.ea_ok === true ? ", ok" : context.ea_ok === false ? ", needs 1.21" : ""})` : "";
    const list = byActor.get(p.actor) ?? [];
    list.push({ ms: p.ms, text: `• ${SETTING_WORDS[k] ?? k}: ${valueWords(k, p.from)} → ${valueWords(k, p.to)}${ea}` });
    byActor.set(p.actor, list);
  }
  for (const [actor, list] of byActor) {
    const last = Math.max(...list.map((x) => x.ms));
    lines.push(`XAUUSD SYSTEM · Omega settings changed by ${actor} · ${hhmm(last)} UTC\n${list.map((x) => x.text).join("\n")}`);
  }
  // Old send times are kept a day at most.
  for (const [k, t] of Object.entries(s.sent_ms)) if (now - Number(t) > 86_400_000) delete s.sent_ms[k];
  return { state: s, lines };
}

export const AUDIT_FAILED_KEY = "audit:notify:failed";
export const AUDIT_MAX_FAILS = 3;

/** The private chat send, answering whether Telegram took the line (a 429 or 400 is a failure, unlike sendOmegaTelegram). */
export async function telegramSend(env, text) {
  if (!env?.TELEGRAM_BOT_TOKEN || !env?.TELEGRAM_CHAT_ID) return false;
  try {
    const { escHtml } = await import("./omega-broker.mjs");
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: escHtml(text), parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000)
    });
    return r.ok;
  } catch { return false; }
}

/**
 * The sweep: reads the audit rows after the cursor, sends the lines, stores the state. On its first run it starts at
 * the newest row with the settings in force as the baseline and sends nothing (no flood of old changes). A line Telegram
 * does not take keeps the cursor where it was, so the next sweep sends again; after AUDIT_MAX_FAILS sweeps in a row the
 * cursor moves on and the health alert audit_telegram_failed says so. Two sweeps at the same moment (a save and the cron)
 * may send a line twice: an audit channel prefers twice to never. Never throws.
 */
export async function runAuditNotify(env, { now = Date.now(), send = null } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv?.put) return { status: "unavailable" };
  try {
    const stored = parse(await kv.get(AUDIT_NOTIFY_KEY), null);
    if (!stored) {
      const top = await db.prepare("SELECT MAX(id) AS id FROM omega_events").first();
      const settings = parse((await db.prepare("SELECT settings FROM omega_settings WHERE id = 1").first())?.settings, {});
      await kv.put(AUDIT_NOTIFY_KEY, JSON.stringify({ cursor: Number(top?.id) || 0, baseline: settings ?? {}, sent_ms: {}, pending: {} }));
      return { status: "started", cursor: Number(top?.id) || 0 };
    }
    const actions = ["settings", ...Object.keys(AUDIT_ACTIONS).filter((a) => a !== "settings")];
    const rows = (await db.prepare(`SELECT id, ms, actor, action, detail FROM omega_events WHERE id > ? AND action IN (${actions.map(() => "?").join(", ")}) ORDER BY id LIMIT ${BATCH}`).bind(Number(stored.cursor) || 0, ...actions).all()).results ?? [];
    if (!rows.length && !Object.keys(stored.pending ?? {}).length) return { status: "quiet" };
    let context = {};
    if (rows.some((r) => r.action === "settings")) {
      try {
        const v = parse((await db.prepare("SELECT state FROM omega_bridge WHERE id = 1").first())?.state, null)?.executor?.version ?? null;
        const { versionAtLeast } = await import("./account-spec.mjs");
        context = { ea_version: v, ea_ok: v ? versionAtLeast(v, "1.21") : null };
      } catch { context = {}; }
    }
    const { state, lines } = auditSweep(stored, rows, { now, context });
    const out = typeof send === "function" ? send : (t) => telegramSend(env, t);
    let failed = 0;
    for (const line of lines) { let ok = false; try { ok = (await out(line)) !== false; } catch { ok = false; } if (!ok) failed += 1; }
    if (failed) {
      const fails = (Number(stored.fails) || 0) + 1;
      if (fails < AUDIT_MAX_FAILS) {
        await kv.put(AUDIT_NOTIFY_KEY, JSON.stringify({ ...stored, fails }));
        return { status: "send_failed", failed, fails, retry: true };
      }
      await kv.put(AUDIT_FAILED_KEY, JSON.stringify({ at: new Date(now).toISOString(), lines: failed, sweeps: fails }), { expirationTtl: 7 * 86_400 });
      await kv.put(AUDIT_NOTIFY_KEY, JSON.stringify({ ...state, fails: 0 }));
      return { status: "send_failed", failed, fails, retry: false };
    }
    await kv.put(AUDIT_NOTIFY_KEY, JSON.stringify({ ...state, fails: 0 }));
    return { status: "ok", rows: rows.length, lines: lines.length, held: Object.keys(state.pending).length };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 160) };
  }
}

/** The health alert when audit lines were given up on (Telegram refused them AUDIT_MAX_FAILS sweeps in a row), for a week. */
export async function auditNotifyIssue(env) {
  try {
    const f = parse(await env?.SIGNAL_CACHE?.get?.(AUDIT_FAILED_KEY), null);
    if (!f) return null;
    return { key: `audit_telegram_failed:${f.at}`, kind: "audit_telegram_failed", subject: `Telegram refused ${f.lines} change-audit line${f.lines === 1 ? "" : "s"} ${f.sweeps} sweeps in a row (last ${String(f.at).slice(0, 16).replace("T", " ")} UTC); the changes are in the Omega audit (omega_events) but were not told`, detail: f };
  } catch { return null; }
}
