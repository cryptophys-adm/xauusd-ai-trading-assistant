// The Signal Ledger's "Omega with limit entry" policy (docs/RFC_OMEGA_LIMIT_ENTRY.md §8, stage 2: measurement only;
// owner 2026-11-20, scope and order confirmed). A counterfactual beside v4 (src/ledger-omega4.mjs) on the same Decision
// Engine signals: the same simulated account, the same gates and the same management, only the entry differs.
//   taker  v4: planIntents opens at market (an ENTER_LIMIT plan waits for price within 0.35 x the stop of its level);
//   maker  this policy: a resting limit at the decision's level (signal.entry, feed scale, basis 0), placed at the first
//          minute planIntents' own gates pass for the signal, sized by planIntents as if filled at the limit (the probe:
//          planIntents on the same inputs with the symbol priced at the limit). It fills when a 1m bar's range reaches it
//          (a BUY limit when the ask's low does, a SELL limit when the bid's high does) while it is alive:
//            - at most max_pending_life minutes from its placement (pending_expired);
//            - no deterministic cancel in the meantime, checked at each minute's open, in this order: kill, paused,
//              blackout (a news blackout), daily_loss_limit (the equity at the profile's daily loss floor),
//              profile_downgrade (ADR-0020 A7: a downgrade, to Safe or one step), pending_expired, decision_against
//              (a later decision on the other side), quorum_share_drop (its side's share of the 15m quorum,
//              quorum.long_share or short_share, fell by more than cancel_share_drop from the placing decision);
//          and it is never placed when:
//            - limit_through_price: price is already through the level at placement (a missed entry, never a market
//              fallback);
//            - limit_out_of_band: the level is further than placement_band x the plan's stop distance from price.
//          Once filled it is a v4 trade: planIntents, the TP ladder and the Position Manager manage it from the fill
//          (replayOmega4 with this module's entry policy; nothing of v4's machinery is copied here).
// One resting order at a time (RFC §6): a second signal while one rests is pending_order_exists; the resting order counts
// toward max_positions and risk in the only way it can, by holding every other entry back.
// Not modelled (no council in a replay): the council's place/keep/move; move_max_atr is clamped and recorded but moves
// nothing; the Decision Engine veto (de_veto) and disarm (the replay keeps the arm on, as v4); the fill-time re-check of
// the hard guards (the daily loss floor is checked every minute while the order rests).
// It never feeds a room, a prompt or a decision. R multiples and times only reach Aether (executionReport's limit block).
import { replayOmega4, minuteBars, decisionFromRow, DECISION_SQL, loadOmega4Context, windowBars, MAX_REPLAY_MINUTES, OMEGA4_SIM, OMEGA4_CHECKPOINT_KEY } from "./ledger-omega4.mjs";
import { effectiveLimits } from "./account-spec.mjs";
import { TRADING_MODES, ensureLedgerSchema, ledgerSeries, OMEGA_LIMIT_VERSION } from "./signal-ledger.mjs";

export { OMEGA_LIMIT_VERSION };
export const OMEGA_LIMIT_CHECKPOINT_KEY = "ledger:omega-limit:checkpoint:v1";
const M1 = 60_000;

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => (finite(x) ? Math.round(x * 1000) / 1000 : null);
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// The knobs (RFC §7): start values per mode, clamped to ADR-0020 Amendment 7's doctrine bounds.

/** The start values per mode (RFC §7, narrowed in the platform session's review of 2026-11-20). */
export const LIMIT_KNOB_START = Object.freeze({
  scalp: Object.freeze({ max_pending_life: 30, move_max_atr: 0.25, cancel_share_drop: 0.05, placement_band: 0.35 }),
  intraday: Object.freeze({ max_pending_life: 60, move_max_atr: 0.5, cancel_share_drop: 0.05, placement_band: 0.35 }),
  swing: Object.freeze({ max_pending_life: 240, move_max_atr: 0.5, cancel_share_drop: 0.05, placement_band: 0.35 }),
  range: Object.freeze({ max_pending_life: 60, move_max_atr: 0.25, cancel_share_drop: 0.05, placement_band: 0.35 })
});
const shared = { move_max_atr: Object.freeze({ min: 0, max: 0.5 }), cancel_share_drop: Object.freeze({ min: 0.03, max: 0.1 }), placement_band: Object.freeze({ min: 0.1, max: 0.6 }) };
/** The doctrine bounds per mode (ADR-0020 A7, cryptophys-cloud-platform ed43279): minutes, × ATR(14) 15m, share, × stop. */
export const LIMIT_KNOB_BOUNDS = Object.freeze({
  scalp: Object.freeze({ max_pending_life: Object.freeze({ min: 15, max: 60 }), ...shared }),
  intraday: Object.freeze({ max_pending_life: Object.freeze({ min: 30, max: 240 }), ...shared }),
  swing: Object.freeze({ max_pending_life: Object.freeze({ min: 60, max: 720 }), ...shared }),
  range: Object.freeze({ max_pending_life: Object.freeze({ min: 30, max: 240 }), ...shared })
});
/** The platform fact each knob is read from once a reader exists (RFC §7); none does yet, so the start values hold. */
export const LIMIT_KNOB_FACTS = Object.freeze({ max_pending_life: "omega.limit_life_min_<mode>", move_max_atr: "omega.limit_move_max_atr_<mode>", cancel_share_drop: "omega.limit_cancel_share_drop_<mode>", placement_band: "omega.limit_band_<mode>" });
export const LIMIT_KNOBS_SOURCE = "start_values";

/**
 * Pure: the knobs of `mode` (an unknown mode reads as intraday): the start values, or the numbers in `overrides`, each
 * clamped to its doctrine bound. `source` says where they came from.
 */
export function limitKnobs(mode, overrides = null) {
  const m = TRADING_MODES.includes(mode) ? mode : "intraday";
  const start = LIMIT_KNOB_START[m], bounds = LIMIT_KNOB_BOUNDS[m];
  const out = { mode: m };
  let overridden = false;
  for (const k of Object.keys(start)) {
    const v = Number(overrides?.[k]);
    const raw = overrides && overrides[k] != null && Number.isFinite(v) ? v : start[k];
    if (raw !== start[k]) overridden = true;
    out[k] = Math.min(bounds[k].max, Math.max(bounds[k].min, raw));
  }
  out.source = overridden ? "overrides_clamped" : LIMIT_KNOBS_SOURCE;
  return out;
}

// ---------------------------------------------------------------------------
// The entry policy: the hooks replayOmega4 calls (atOpen, afterPlan, inMinute), its state carried in the checkpoint.

const PROFILE_RANK = Object.freeze({ safe: 0, conservative: 1, aggressive: 2 });
/** Why a resting limit is cancelled at this minute's open, or null (the order of the reasons is the header's). */
export function limitCancelReason({ pending, now, decision = null, mode = "active", blackout = null, equity = null, dayStart = null, profile = null, settings = {} }) {
  if (!pending) return null;
  if (mode === "killed") return "kill";
  if (mode === "paused") return "paused";
  if (blackout) return "blackout";
  const lim = typeof profile === "string" ? effectiveLimits(profile, settings) : null;
  const lossPct = lim && lim.profile !== "custom" && finite(lim.max_daily_loss_pct) ? lim.max_daily_loss_pct : Number(settings.max_daily_loss_pct);
  if (finite(equity) && finite(dayStart) && dayStart > 0 && finite(lossPct) && equity <= dayStart * (1 - lossPct / 100)) return "daily_loss_limit";
  const was = PROFILE_RANK[pending.profile], is = PROFILE_RANK[profile];
  if (was != null && is != null && is < was) return "profile_downgrade";
  if (now >= pending.placed_ms + pending.knobs.max_pending_life * M1) return "pending_expired";
  if (decision && finite(decision.close_ms) && decision.close_ms > pending.close_ms) {
    const other = pending.side === "BUY" ? "SELL" : "BUY";
    if (decision.stance === other) return "decision_against";
    const share = Number(decision.quorum?.[pending.side === "BUY" ? "long_share" : "short_share"]);
    if (finite(pending.share0) && finite(share) && pending.share0 - share > pending.knobs.cancel_share_drop + 1e-9) return "quorum_share_drop";
  }
  return null;
}

/** The reasons a limit entry was missed (never filled): at placement, then while it rested. */
export const LIMIT_MISSED_REASONS = Object.freeze(["limit_through_price", "limit_out_of_band", "pending_expired", "decision_against", "quorum_share_drop", "blackout", "daily_loss_limit", "profile_downgrade", "kill", "paused", "data_gap"]);

/**
 * The limit entry policy for replayOmega4 (`entry`). `state` is the checkpoint's `entry` of the run before. `knobsFor(mode)`
 * gives a mode's knobs (limitKnobs by default).
 */
export function limitEntryPolicy({ state = null, knobsFor = (m) => limitKnobs(m) } = {}) {
  let pending = state?.pending && typeof state.pending === "object" ? JSON.parse(JSON.stringify(state.pending)) : null;
  const decided = new Map(Array.isArray(state?.decided) ? state.decided.filter((x) => Array.isArray(x) && typeof x[0] === "string" && finite(x[1])) : []);
  const outcomes = new Map();  // decision key -> the outcome this run reached (missed, or resting at its end)
  const stats = { probes: 0, placed: 0, filled: 0, missed: 0 };
  let lastMs = null;

  const end = (gate, now) => {
    outcomes.set(pending.key, { ...meta(pending), status: "missed", gate, ended_ms: now });
    stats.missed += 1;
    pending = null;
  };
  const meta = (p) => ({ key: p.key, side: p.side, issued_ms: p.issued_ms, mode: p.mode, agent: p.agent, placed_ms: p.placed_ms ?? null, away_r: p.away_r ?? null, knobs: p.knobs });

  return {
    stats, outcomes,
    get pending() { return pending; },
    busy: () => pending != null,
    atOpen({ now, decision, mode, blackout, executor, profile, settings }) {
      lastMs = now;
      if (!pending) return;
      const gate = limitCancelReason({ pending, now, decision, mode, blackout, equity: executor?.account?.equity, dayStart: executor?.account?.day_start_balance, profile, settings });
      if (gate) end(gate, now);
    },
    afterPlan({ now, signal, decision, entryKey, entryLive, input, plan, executorFor, sym, bid0, ask0, spread, notes, trades, recentIntentIds }) {
      lastMs = now;
      if (!entryKey || !entryLive || trades.has(entryKey) || decided.has(entryKey) || (signal.side !== "BUY" && signal.side !== "SELL")) return;
      if (pending) { notes.set(entryKey, { gate: "pending_order_exists", last_ms: now }); return; }
      const buy = signal.side === "BUY", level = r2(Number(signal.entry)), planStop = Math.abs(Number(signal.entry) - Number(signal.stop));
      if (!(level > 0) || !(planStop > 0)) { notes.set(entryKey, { gate: "bad_input", last_ms: now }); return; }
      // planIntents' own gates and sizing, as if filled at the limit: the symbol shows the level as the price it enters at.
      const probeSym = { ...sym, bid: buy ? r2(level - spread) : level, ask: buy ? level : r2(level + spread) };
      const executor = executorFor(probeSym);
      const out = plan({ ...input, executor, pmActions: [], recentIntentIds: recentIntentIds() });
      stats.probes += 1;
      const it = out.intents.find((x) => x.kind === "open");
      if (!it) { notes.set(entryKey, { gate: out.notes.at(-1)?.code ?? "no_note", last_ms: now }); return; }
      const knobs = knobsFor(signal.trading_mode);
      const away = buy ? ask0 - level : level - bid0;
      const p = {
        key: entryKey, side: signal.side, issued_ms: signal.issued_ms, close_ms: finite(decision?.close_ms) ? decision.close_ms : signal.issued_ms,
        mode: it.mode ?? signal.trading_mode ?? null, agent: it.strategy ?? (signal.trade_agent || null), placed_ms: now, level, it,
        share0: Number(decision?.quorum?.[buy ? "long_share" : "short_share"]), profile: input.account?.profile ?? null,
        equity: executor.account.equity, note_codes: out.notes.map((n) => n.code), away_r: r3(away / planStop), knobs
      };
      decided.set(entryKey, now);
      if (away <= 0) { pending = p; end("limit_through_price", now); return; }
      if (away > knobs.placement_band * planStop + 1e-9) { pending = p; end("limit_out_of_band", now); return; }
      pending = p;
      stats.placed += 1;
    },
    inMinute({ now, bar, spread, fill }) {
      lastMs = now;
      if (!pending || pending.placed_ms > now) return;
      const buy = pending.side === "BUY";
      // The ask's low (bid low + spread) reaches a BUY limit; the bid's high a SELL limit. A gap through it at the
      // minute's open fills at the open (the broker's better price); the stop and the target stay where they were placed.
      const reached = buy ? bar.l + spread <= pending.level + 1e-9 : bar.h >= pending.level - 1e-9;
      if (!reached) return;
      const openPx = buy ? r2(bar.o + spread) : r2(bar.o);
      const px = buy ? Math.min(pending.level, openPx) : Math.max(pending.level, openPx);
      const it = px === pending.it.entry ? pending.it : { ...pending.it, entry: px, r_dist: r2(Math.abs(px - pending.it.sl)) };
      fill({ key: pending.key, it, issuedMs: pending.issued_ms, mode: pending.mode, agent: pending.agent, equity: pending.equity, profile: pending.profile, noteCodes: pending.note_codes,
        extra: { policy: OMEGA_LIMIT_VERSION, placed_at: iso(pending.placed_ms), wait_min: Math.round((now - pending.placed_ms) / M1), away_r: pending.away_r, knobs: pending.knobs } });
      outcomes.delete(pending.key);
      stats.filled += 1;
      pending = null;
    },
    /** The state the next run goes on from (the resting order, the signals already tried in the last day). */
    state() {
      const keep = (lastMs ?? 0) - 86_400_000;
      return { pending, decided: [...decided].filter(([, ms]) => ms > keep) };
    },
    /** Pure-ish: the outcome of the order still resting when the run ends (it is written as "resting"). */
    resting() { return pending ? { ...meta(pending), status: "resting", gate: null, ended_ms: null } : null; },
    decided
  };
}

// ---------------------------------------------------------------------------
// The replay and its records.

/** Pure: a v4-shaped record of the limit replay as the limit_* columns of ledger_omega4 (no price in limit_json). */
function limitColumns(r) {
  return {
    decision_key: r.decision_key, side: r.side, issued_ms: r.issued_ms, trading_mode: r.trading_mode, agent: r.agent,
    limit_status: r.omega4_status, limit_gate: r.omega4_gate, limit_filled_at: r.omega4_filled_at, limit_closed_at: r.omega4_closed_at,
    limit_exit: r.omega4_exit, r_limit: r.r_omega4, limit_json: r.omega4_json
  };
}
function outcomeColumns(o) {
  return {
    decision_key: o.key, side: o.side, issued_ms: o.issued_ms, trading_mode: TRADING_MODES.includes(o.mode) ? o.mode : null, agent: o.agent ?? null,
    limit_status: o.status, limit_gate: o.gate, limit_filled_at: null, limit_closed_at: null, limit_exit: null, r_limit: null,
    limit_json: JSON.stringify({ version: OMEGA_LIMIT_VERSION, gate: o.gate, placed_at: o.placed_ms != null ? iso(o.placed_ms) : null, ended_at: o.ended_ms != null ? iso(o.ended_ms) : null,
      life_min: o.placed_ms != null && o.ended_ms != null ? Math.round((o.ended_ms - o.placed_ms) / M1) : null, away_r: o.away_r ?? null, knobs: o.knobs ?? null })
  };
}

/**
 * Pure: the limit policy replayed on the 1m bars (the arguments of replayOmega4, and `knobsFor`). Returns replayOmega4's
 * result with its records as limit_* rows ({ decision_key, side, issued_ms, trading_mode, agent, regime, limit_status
 * (pending, skipped, resting, missed, open, closed), limit_gate, limit_filled_at, limit_closed_at, limit_exit, r_limit,
 * limit_json }) and the policy's counts (`limit`: probes, placed, filled, missed).
 */
export function replayOmegaLimit({ state = null, knobsFor, ...opts } = {}) {
  const policy = limitEntryPolicy({ state: state?.entry ?? null, knobsFor });
  const run = replayOmega4({ ...opts, state, entry: policy, version: OMEGA_LIMIT_VERSION });
  const regimeOf = new Map((Array.isArray(opts.decisions) ? opts.decisions : []).map((d) => [d?.decision_key, typeof d?.context?.regime_1h === "string" && d.context.regime_1h ? d.context.regime_1h : null]));
  const records = {};
  for (const [key, r] of Object.entries(run.records)) {
    const traded = r.omega4_status === "open" || r.omega4_status === "closed";
    // A signal this policy already tried (placed, missed or filled in a run before) keeps its row; only its outcome moves it.
    if (!traded && policy.decided.has(key) && !policy.outcomes.has(key)) continue;
    records[key] = limitColumns(r);
  }
  for (const o of [...policy.outcomes.values(), policy.resting()].filter(Boolean)) records[o.key] = outcomeColumns(o);
  for (const r of Object.values(records)) r.regime = regimeOf.get(r.decision_key) ?? null;
  return { ...run, records, limit: { ...policy.stats } };
}

// ---------------------------------------------------------------------------
// D1, KV and the cron.

const UPSERT_SQL = `INSERT INTO ledger_omega4 (decision_key, side, issued_ms, trading_mode, agent, omega4_status, regime, limit_status, limit_gate, limit_filled_at, limit_closed_at, limit_exit, r_limit, limit_json, updated_at)
  VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(decision_key) DO UPDATE SET regime = excluded.regime, limit_status = excluded.limit_status, limit_gate = excluded.limit_gate, limit_filled_at = excluded.limit_filled_at,
  limit_closed_at = excluded.limit_closed_at, limit_exit = excluded.limit_exit, r_limit = excluded.r_limit, limit_json = excluded.limit_json, updated_at = excluded.updated_at`;
const FIELDS = ["regime", "limit_status", "limit_gate", "limit_filled_at", "limit_closed_at", "limit_exit", "r_limit", "limit_json"];

/**
 * The cron step, after v4 in the same ledger run (runOmega4Step): the limit replay from its own checkpoint, never past
 * the minute v4 has replayed (`untilMs`), for at most `maxMinutes` minutes (what v4 left of MAX_REPLAY_MINUTES this run).
 * `shared` is what v4 loaded this run ({ from, m1, decisions, ctx }): reused when this replay starts at or after v4's
 * start (so the steady state reads nothing twice), else loaded again. Records go to the limit_* columns of
 * ledger_omega4, the checkpoint to KV. Never throws.
 */
export async function runOmegaLimit(env, { now = Date.now(), bars = null, maxMinutes = MAX_REPLAY_MINUTES, untilMs = null, shared = null } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  const t0 = Date.now();
  try {
    await ensureLedgerSchema(env.DB);
    let cp = null;
    try { cp = JSON.parse((await env.SIGNAL_CACHE?.get?.(OMEGA_LIMIT_CHECKPOINT_KEY)) || "null"); } catch { cp = null; }
    if (cp?.version !== OMEGA_LIMIT_VERSION || !finite(cp?.at_ms)) cp = null;
    // Never ahead of v4: the taker side of every pair is v4's record of the same decision.
    let until = finite(untilMs) ? untilMs : null;
    if (until == null) { try { const v4 = JSON.parse((await env.SIGNAL_CACHE?.get?.(OMEGA4_CHECKPOINT_KEY)) || "null"); if (finite(v4?.at_ms)) until = v4.at_ms - M1; } catch { until = null; } }
    if (until == null) return { status: "waiting_for_v4" };
    if (!(maxMinutes > 0)) return { status: "no_budget", ms: Date.now() - t0 };
    if (cp && cp.at_ms > until) return { status: "caught_up", ms: Date.now() - t0 };
    let m1, decisions, ctx;
    const reuse = shared && Array.isArray(shared.m1) && shared.m1.length && finite(shared.from) && cp && cp.at_ms >= shared.from;
    if (reuse) ({ m1, decisions, ctx } = shared);
    else {
      const raw = bars ?? (await ledgerSeries(env)).bars;
      m1 = await windowBars(env, minuteBars(raw), { cp, now });
    }
    if (m1.length < 60) return { status: "no_bars" };
    const earliest = m1[0].t + OMEGA4_SIM.warmup_ms;
    if (cp && m1[0].t >= cp.at_ms) {
      // Neither the KV series nor the archive reaches the checkpoint (as v4): an open trade is marked out at its last R,
      // a resting order as missed, and the replay starts again where the bars begin.
      await env.DB.prepare("UPDATE ledger_omega4 SET limit_status = 'closed', limit_exit = 'data_gap', r_limit = CAST(json_extract(limit_json, '$.open_r') AS REAL), limit_closed_at = ?, updated_at = ? WHERE limit_status = 'open'").bind(iso(earliest), iso(now)).run();
      await env.DB.prepare("UPDATE ledger_omega4 SET limit_status = 'missed', limit_gate = 'data_gap', updated_at = ? WHERE limit_status = 'resting'").bind(iso(now)).run();
      cp = null;
    }
    const from = cp ? cp.at_ms : earliest;
    if (!reuse) {
      decisions = ((await env.DB.prepare(DECISION_SQL).bind(iso(from - 2 * 3600_000)).all()).results ?? []).map(decisionFromRow).filter(Boolean);
      ctx = await loadOmega4Context(env, { sinceMs: from, now });
    }
    const run = replayOmegaLimit({ bars: m1, decisions, from, to: until, state: cp, maxSteps: maxMinutes, ...ctx });
    const keys = Object.keys(run.records);
    const stored = new Map();
    for (let i = 0; i < keys.length; i += 50) {
      const part = keys.slice(i, i + 50);
      for (const r of (await env.DB.prepare(`SELECT decision_key, ${FIELDS.join(", ")} FROM ledger_omega4 WHERE decision_key IN (${part.map(() => "?").join(", ")})`).bind(...part).all()).results ?? []) stored.set(r.decision_key, r);
    }
    const writes = [];
    for (const key of keys) {
      const r = run.records[key], s = stored.get(key);
      if (s && FIELDS.every((f) => (s[f] ?? null) === (r[f] ?? null))) continue;
      writes.push(env.DB.prepare(UPSERT_SQL).bind(r.decision_key, r.side, r.issued_ms, r.trading_mode, r.agent, r.regime, r.limit_status, r.limit_gate, r.limit_filled_at, r.limit_closed_at, r.limit_exit, r.r_limit, r.limit_json, iso(now)));
    }
    for (let i = 0; i < writes.length; i += 50) {
      const part = writes.slice(i, i + 50);
      if (typeof env.DB.batch === "function") await env.DB.batch(part);
      else for (const st of part) await st.run();
    }
    const next = { ...run.checkpoint, last_ms: run.last_ms ?? cp?.last_ms ?? null };
    if (next.at_ms !== cp?.at_ms) await env.SIGNAL_CACHE?.put?.(OMEGA_LIMIT_CHECKPOINT_KEY, JSON.stringify(next), { expirationTtl: 7 * 86_400 });
    return {
      status: "ok", from: iso(from), to: run.last_ms != null ? iso(run.last_ms) : null, more: run.more, reused: Boolean(reuse),
      decisions: run.decisions, minutes: run.steps, plans: run.plans, probes: run.limit.probes, position_actions: run.pm_calls,
      placed: run.limit.placed, filled: run.limit.filled, missed: run.limit.missed, records: keys.length, written: writes.length, open: run.open_positions, ms: Date.now() - t0
    };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200), ms: Date.now() - t0 };
  }
}

/** LEDGER_OMEGA_LIMIT "off" stops the limit replay (default on; LEDGER_OMEGA4 "off" stops it too, with v4). */
export const omegaLimitEnabled = (env) => String(env?.LEDGER_OMEGA_LIMIT ?? "on").trim().toLowerCase() !== "off";
