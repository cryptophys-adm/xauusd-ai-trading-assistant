// The Positioning & Liquidity analyst's scheduled work (docs/RFC_POSITIONING_LIQUIDITY.md §4.2, §4.3, §7, §10): the
// ledger step's lens B facts and baseline, both lenses' readings and scores, the automatic floor, the health checks,
// the bridge sync's spike clock and block readings, the report to Aether and the page's read. D1 and KV only; no model
// call; no price leaves the Worker (the levels stay in KV for Omega's own planner).
import { corpusSource } from "./corpus-oracle.mjs";
import { goldPausedAt } from "./market-hours.mjs";
import {
  LENS_MODES, LENS_NAME, LENS_SWITCHES, lensKnobs, lensWeights, readLensState, recordLensReading, ensureLensReadingsSchema, lensReadingStatements, lensScore, lensFloorStep, lensReport, lensReportDraft, forbiddenReportKeys, floorHolds, LENS_FLOOR_KEY
} from "./lens-policy.mjs";
import { positioningNow, scorePositioning, cotFreshness, positioningLine, positioningLean, positioningPackFact } from "./positioning-lens.mjs";
import {
  LIQUIDITY_BASELINE_WEEKS, LIQUIDITY_STATE_KEY, LIQUIDITY_SPIKE_KEY, baselineKey, baselineIdentity, buildBaseline, finishBaseline, hourBaseline, eligibleMinutes,
  nyHourOfWeek, readBrokerBars, backfillBrokerBars, markBackfillRebuilt, SWEEP_SCORE_BARS_15M, liquidityFacts, detectSweeps, scoreSweep, atr15, readLiquidityState, ensureLiquiditySchema, BASELINE_MIN_BARS, liquidityLine,
  liquidityConditions, liquidityConditionsOn
} from "./liquidity-lens.mjs";

const M1 = 60_000, HOUR = 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const parse = (s, d = null) => { try { return typeof s === "string" ? JSON.parse(s) : (s ?? d); } catch { return d; } };
const MODES = new Set(LENS_MODES);
export const LIQUIDITY_REPLAY_KEY = "liquidity:replay:v1";
/** B2: the sweep replay of the minutes a backfill added, once per backfill identity. */
export const liquidityReplayKey = (identity) => `liquidity:replay:v2:${identity}`;

async function modeNow(env) {
  const pinned = String(env?.TRADING_MODE ?? "").trim().toLowerCase();
  if (MODES.has(pinned)) return pinned;
  try { const v = String((await env?.SIGNAL_CACHE?.get?.("trading:mode")) ?? "").trim().toLowerCase(); if (MODES.has(v)) return v; } catch { /* default */ }
  return "intraday";
}

/** The active account from the last bridge state: its opaque reference, source and digits (never the login). */
export async function activeAccount(env) {
  try {
    const st = parse((await env.DB.prepare("SELECT state FROM omega_bridge WHERE id = 1").first())?.state, null);
    const conn = await env.DB.prepare("SELECT version, status FROM omega_connection WHERE id = 1").first().catch(() => null);
    const ref = typeof st?.account_ref === "string" ? st.account_ref : null;
    const server = st?.server, symbol = st?.symbol?.name;
    if (!ref || !server || !symbol) return null;
    return { accountRef: ref, legacy: st?.account?.login_hash ? false : true, source: corpusSource(server, symbol), digits: Number.isInteger(st?.symbol?.digits) ? st.symbol.digits : null, connectionVersion: Number(conn?.version) || null, receivedMs: Number(st?.received_ms) || null, connected: st?.connected === true };
  } catch { return null; }
}

/** Inserts a reading or scores a pending one. Returns "added", "scored" or "same". */
export async function upsertReading(db, r, { lens, kind, mode = null, now = Date.now() }) {
  const added = await recordLensReading(db, { id: r.id, lens, kind, at_ms: r.at_ms, mode, side: r.side ?? null, outcome: r.outcome ?? null, detail: r.detail ?? null }, { now });
  if (added) return "added";
  if (!r.outcome) return "same";
  const u = await db.prepare("UPDATE lens_readings SET outcome = ?, scored_ms = ? WHERE id = ? AND outcome IS NULL").bind(r.outcome, now, r.id).run();
  return Number(u?.meta?.changes) > 0 ? "scored" : "same";
}

// ---------------------------------------------------------------- lens B: the baseline and the facts

/**
 * The baseline in force for the account: rebuilt from the archive when missing or its identity changed (a new account,
 * server, symbol or digits: a reset, with an event), else the hours that ended since the last update recomputed from
 * their 8 weeks. Returns { baseline, reset }.
 */
export async function updateBaseline(env, acct, { now = Date.now(), log = null, rebuild = false } = {}) {
  const kv = env.SIGNAL_CACHE, db = env.DB;
  const identity = baselineIdentity(acct);
  let stored = parse(await kv.get(baselineKey(acct.accountRef)), null);
  const prevIdentity = parse(await kv.get(LIQUIDITY_STATE_KEY), null)?.identity ?? null;
  const eligible = eligibleMinutes(now);
  let reset = false;
  if (!stored || stored.identity !== identity || rebuild) {
    const from = now - LIQUIDITY_BASELINE_WEEKS * WEEK;
    const bars = await readBrokerBars(db, { accountRef: acct.accountRef, source: acct.source, fromMs: from, toMs: Math.floor(now / HOUR) * HOUR, digits: acct.digits ?? undefined });
    reset = Boolean(prevIdentity && prevIdentity !== identity) || Boolean(stored && stored.identity !== identity);
    stored = { ...buildBaseline(bars, { identity, now, eligible }), reset_at: reset ? new Date(now).toISOString() : (stored?.identity === identity ? stored.reset_at : null), hour_ms: Math.floor(now / HOUR) * HOUR };
    if (reset && typeof log === "function") await log("liquidity_baseline_reset", { from: prevIdentity ? "previous account, source or digits" : null, baseline: stored.baseline });
  } else {
    const hourNow = Math.floor(now / HOUR) * HOUR;
    let h = Math.max(Number(stored.hour_ms) || hourNow - HOUR, hourNow - WEEK);
    const hours = { ...(stored.hours ?? {}) };
    for (; h < hourNow; h += HOUR) {
      const how = nyHourOfWeek(h + 30 * M1);
      const list = [];
      for (let w = 0; w < LIQUIDITY_BASELINE_WEEKS; w++) {
        const s = h - w * WEEK;
        list.push(...(await readBrokerBars(db, { accountRef: acct.accountRef, source: acct.source, fromMs: s - HOUR, toMs: s + 2 * HOUR, digits: acct.digits ?? undefined })).filter((b) => nyHourOfWeek(b.t) === how));
      }
      hours[how] = hourBaseline(list, { minBars: Math.min(BASELINE_MIN_BARS, Math.floor(0.75 * (eligible[how] ?? 60))) });
    }
    stored = { ...finishBaseline({ identity, hours, eligible, now, reset_at: stored.reset_at ?? null }), hour_ms: hourNow };
  }
  await kv.put(baselineKey(acct.accountRef), JSON.stringify(stored), { expirationTtl: 30 * 86_400 });
  return { baseline: stored, reset };
}

/** Pure: each hour of the week's median spread, for the signal (the live gate compares Omega's spread with it). */
export function mediansOf(baseline) {
  const out = {};
  for (const [h, e] of Object.entries(baseline?.hours ?? {})) if (finite(e?.spread_median) && e.spread_median > 0) out[h] = e.spread_median;
  return out;
}

/**
 * The ledger step's lens B: the archive's backfill (once), the baseline, the facts of the last closed bar for the
 * mode in force, one liquidity_readings row, the shared state (KV liquidity:state:v1), the sweeps as readings and
 * their scores, and the day-one replay of the archive's sweeps (once). Runs whatever the switch says (the facts are
 * measured; the readers check the switch). Never throws.
 */
export async function runLiquidityStep(env, { now = Date.now(), log = null } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv?.put) return { status: "unavailable" };
  try {
    const acct = await activeAccount(env);
    if (!acct) return { status: "no_account" };
    await ensureLiquiditySchema(db);
    await ensureLensReadingsSchema(db);
    const backfill = await backfillBrokerBars(env, { ...acct, now, log });
    // B2: rows a backfill added rebuild the baseline once and replay their sweeps once, driven by the stored marker (so
    // a step that fails after the marker was written still does both at the next step).
    const marker = backfill.marker ?? null;
    const pending = Boolean(marker && (marker.added > 0 || marker.resumed === true));
    const rebuild = pending && marker.rebuilt !== true;
    const prev = await readLiquidityState(env);
    const hourly = rebuild || !prev || !finite(prev.baseline_at) || Math.floor(now / HOUR) !== Math.floor(prev.baseline_at / HOUR) || prev.identity !== baselineIdentity(acct);
    let baseline = hourly ? null : parse(await kv.get(baselineKey(acct.accountRef)), null), reset = false;
    if (!baseline) ({ baseline, reset } = await updateBaseline(env, acct, { now, log, rebuild }));
    if (rebuild) await markBackfillRebuilt(env, backfill.identity, marker);
    const mode = await modeNow(env);
    const lens = await readLensState(env, { now });
    const knobs = lensKnobs("liquidity", mode, { policy: lens.policy, floor: lens.floor, enabled: lens.switches.liquidity, baseline: baseline.baseline });
    const windowMin = Math.max(knobs.profile_window_min, knobs.sweep_lookback_min + 60, 16 * 15);
    const bars = await readBrokerBars(db, { accountRef: acct.accountRef, source: acct.source, fromMs: now - windowMin * M1, digits: acct.digits ?? undefined });
    const { facts, levels, sweeps } = liquidityFacts({ bars, baseline, knobs, now });
    const at = Math.floor(now / M1) * M1;
    await db.prepare("INSERT OR REPLACE INTO liquidity_readings (at_ms, account_ref, mode, baseline, facts_json, levels_json) VALUES (?, ?, ?, ?, ?, ?)").bind(at, acct.accountRef, mode, facts.baseline, JSON.stringify(facts), JSON.stringify(levels)).run();
    if (new Date(now).getUTCMinutes() < 5) await db.prepare("DELETE FROM liquidity_readings WHERE at_ms < ?").bind(now - 30 * DAY).run();
    const medians = mediansOf(baseline);
    const vals = Object.values(medians).sort((a, b) => a - b);
    const state = { at_ms: now, identity: baseline.identity, mode, facts, levels, medians, median_any: vals.length ? vals[Math.floor(vals.length / 2)] : null, baseline: baseline.baseline, baseline_weeks: baseline.baseline_weeks, baseline_at: hourly ? now : prev?.baseline_at ?? now, archive_last_ms: bars.at(-1)?.t ?? null };
    await kv.put(LIQUIDITY_STATE_KEY, JSON.stringify(state), { expirationTtl: 2 * DAY });
    // Sweeps: each detected sweep (not excluded) is a reading; scored on the bars after it (eight 15m bars).
    const atr = atr15(bars);
    let replay = null;
    if (!(await kv.get(LIQUIDITY_REPLAY_KEY))) replay = await replaySweeps(env, acct, { baseline, knobs, now, mode, key: LIQUIDITY_REPLAY_KEY });
    else if (pending && finite(marker.from_ms) && finite(marker.to_ms) && !(await kv.get(liquidityReplayKey(backfill.identity)))) {
      replay = await replaySweeps(env, acct, { baseline, knobs, now, mode, key: liquidityReplayKey(backfill.identity), fromMs: marker.from_ms, toMs: marker.to_ms });
    }
    else for (const s of sweeps) await upsertReading(db, { id: `sweep:${s.t}:${s.side}`, at_ms: s.t, side: s.side === "buy_side" ? -1 : 1, detail: { vol_pctl: s.vol_pctl, atr15: finite(atr) ? Math.round(atr * 1000) / 1000 : null } }, { lens: "liquidity", kind: "sweep", mode, now });
    const scored = await scorePendingSweeps(env, acct, { now });
    return { status: "ok", baseline: baseline.baseline, baseline_weeks: baseline.baseline_weeks, reset, backfill: backfill.status, ...(backfill.status === "backfilled" && backfill.added > 0 ? { backfill_added: backfill.added } : {}), ...(rebuild ? { rebuilt: true } : {}), available: facts.available, sweeps: sweeps.length, scored, ...(replay ? { replay } : {}) };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * The day-one replay (RFC §7.2): every sweep of the archive's bars, recorded and scored at once. Once (KV marker). B2's
 * replay of a backfill covers only the minutes it added (`fromMs`..`toMs`, with the lookback and the scoring bars around
 * them). The readings go through db.batch (two statements a sweep at most), so the replay stays far under D1's
 * queries per invocation.
 */
async function replaySweeps(env, acct, { baseline, knobs, now, mode, key = LIQUIDITY_REPLAY_KEY, fromMs = null, toMs = null }) {
  const db = env.DB;
  const span = finite(fromMs) && finite(toMs);
  const lead = (knobs.sweep_lookback_min + 16 * 15) * M1, tail = (SWEEP_SCORE_BARS_15M + 1) * 15 * M1;
  const bars = await readBrokerBars(db, { accountRef: acct.accountRef, source: acct.source, fromMs: span ? Math.max(now - 30 * DAY, fromMs - lead) : now - 30 * DAY, toMs: span ? toMs + tail : Infinity, digits: acct.digits ?? undefined });
  const sweeps = detectSweeps(bars.slice(-30_000), { baseline, lookbackMin: knobs.sweep_lookback_min, spikePctl: knobs.spike_pctl, ...(span ? { fromMs } : {}) }).filter((s) => !span || s.t <= toMs);
  const statements = [];
  for (const s of sweeps) {
    const before = bars.filter((b) => b.t <= s.t && b.t > s.t - 16 * 15 * M1);
    const atr = atr15(before);
    const outcome = scoreSweep(s, bars, { atr, now });
    // The INSERT first, then (with an outcome) the UPDATE: only the INSERT's changes count a reading added.
    lensReadingStatements(db, { id: `sweep:${s.t}:${s.side}`, lens: "liquidity", kind: "sweep", at_ms: s.t, mode, side: s.side === "buy_side" ? -1 : 1, outcome, detail: { vol_pctl: s.vol_pctl, replay: true, atr15: finite(atr) ? Math.round(atr * 1000) / 1000 : null } }, { now })
      .forEach((st, j) => statements.push({ st, insert: j === 0 }));
  }
  let added = 0;
  for (let i = 0; i < statements.length; i += 50) {
    const part = statements.slice(i, i + 50);
    const results = typeof db.batch === "function" ? (await db.batch(part.map((x) => x.st))) ?? [] : await (async () => { const out = []; for (const x of part) out.push(await x.st.run()); return out; })();
    added += part.filter((x, j) => x.insert && Number(results[j]?.meta?.changes) > 0).length;
  }
  await env.SIGNAL_CACHE.put(key, JSON.stringify({ at: new Date(now).toISOString(), sweeps: sweeps.length, ...(span ? { from_ms: fromMs, to_ms: toMs } : {}) }));
  return { sweeps: sweeps.length, added };
}


/** Scores the pending sweep readings of the last two days on the archive's bars. */
async function scorePendingSweeps(env, acct, { now }) {
  const db = env.DB;
  const rows = (await db.prepare("SELECT id, at_ms, side, detail_json FROM lens_readings WHERE lens = 'liquidity' AND kind = 'sweep' AND outcome IS NULL AND at_ms > ? ORDER BY at_ms LIMIT 50").bind(now - 2 * DAY).all()).results ?? [];
  let n = 0;
  for (const r of rows) {
    const t = Number(r.at_ms);
    const bars = await readBrokerBars(db, { accountRef: acct.accountRef, source: acct.source, fromMs: t - 16 * 15 * M1, toMs: t + 9 * 15 * M1, digits: acct.digits ?? undefined });
    const bar = bars.find((b) => b.t === t);
    if (!bar) { await db.prepare("UPDATE lens_readings SET outcome = 'neutral', scored_ms = ? WHERE id = ?").bind(now, r.id).run(); n += 1; continue; }
    const side = Number(r.side) < 0 ? "buy_side" : "sell_side";
    const sweep = { t, side, extreme: side === "buy_side" ? bar.h : bar.l, close: bar.c };
    const outcome = scoreSweep(sweep, bars, { atr: atr15(bars.filter((b) => b.t <= t)), now });
    if (outcome) { await db.prepare("UPDATE lens_readings SET outcome = ?, scored_ms = ? WHERE id = ? AND outcome IS NULL").bind(outcome, now, r.id).run(); n += 1; }
  }
  return n;
}

// ---------------------------------------------------------------- lens B: the blocks and the maker choices

/**
 * The bridge sync's block reading: a new entry the spread spike held back (`liquidity_spread_spike`), once per signal
 * and side; scored later from the v4 replay, which runs without the lens (a loss avoided is a hit).
 */
export async function recordSpikeBlock(db, signal, { now = Date.now() } = {}) {
  const issued = Number(signal?.issued_ms), side = signal?.side === "BUY" ? 1 : signal?.side === "SELL" ? -1 : null;
  if (!db || !finite(issued) || !side) return false;
  return recordLensReading(db, { id: `block:${issued}:${side > 0 ? "B" : "S"}`, lens: "liquidity", kind: "block", at_ms: issued, mode: typeof signal?.trading_mode === "string" ? signal.trading_mode : null, side }, { now });
}

/**
 * Scores the block and maker readings from the v4 rows of their decision (ledger_omega4: r_omega4 the taker, r_limit
 * the maker). Block: v4 lost (hit) or won (miss). Maker: the maker's R above the taker's (hit) or below (miss).
 */
export async function scoreLedgerReadings(env, { now = Date.now() } = {}) {
  const db = env.DB;
  const rows = (await db.prepare("SELECT id, kind, at_ms, side FROM lens_readings WHERE lens = 'liquidity' AND kind IN ('block', 'maker') AND outcome IS NULL AND at_ms > ? LIMIT 100").bind(now - 14 * DAY).all()).results ?? [];
  let n = 0;
  for (const r of rows) {
    const key = `OANDA:XAUUSD:15:${Number(r.at_ms) - 15 * M1}`;
    let v = null;
    try { v = await db.prepare("SELECT omega4_status, r_omega4, limit_status, r_limit FROM ledger_omega4 WHERE decision_key = ? AND side = ?").bind(key, Number(r.side) > 0 ? "BUY" : "SELL").first(); } catch { v = null; }
    if (!v) { if (now - Number(r.at_ms) > 7 * DAY) { await db.prepare("UPDATE lens_readings SET outcome = 'neutral', scored_ms = ? WHERE id = ?").bind(now, r.id).run(); n += 1; } continue; }
    let outcome = null;
    if (r.kind === "block") {
      if (v.omega4_status === "skipped") outcome = "neutral";
      else if (v.omega4_status === "closed" && finite(Number(v.r_omega4))) outcome = Number(v.r_omega4) < 0 ? "hit" : Number(v.r_omega4) > 0 ? "miss" : "neutral";
    } else if (v.omega4_status === "closed" && finite(Number(v.r_omega4))) {
      const maker = v.limit_status === "closed" ? Number(v.r_limit) : v.limit_status === "missed" ? 0 : null;
      if (finite(maker)) outcome = maker > Number(v.r_omega4) ? "hit" : maker < Number(v.r_omega4) ? "miss" : "neutral";
    }
    if (outcome) { await db.prepare("UPDATE lens_readings SET outcome = ?, scored_ms = ? WHERE id = ? AND outcome IS NULL").bind(outcome, now, r.id).run(); n += 1; }
  }
  return n;
}

// ---------------------------------------------------------------- the ledger step (both lenses)

/**
 * The 5-minute ledger step's lens work: lens B's facts, lens A's 4H readings (hourly, the first run replays the 4H
 * series point in time), the block and maker scores, then the automatic floor (an omega_events row and one private
 * Telegram line through `notify`). Never throws.
 */
export async function runLensStep(env, { now = Date.now(), notify = null } = {}) {
  const out = {};
  out.liquidity = await runLiquidityStep(env, { now, log: (action, detail) => omegaEvent(env.DB, now, action, detail) });
  try {
    const hour = new Date(now).getUTCMinutes() < 5 || !(await env.SIGNAL_CACHE.get("lens:positioning:scored"));
    if (hour) {
      const mode = await modeNow(env);
      const lens = await readLensState(env, { now });
      const knobs = lensKnobs("positioning", mode, { policy: lens.policy, floor: lens.floor });
      await ensureLensReadingsSchema(env.DB);
      // Only new readings and pending ones that now have an outcome are written (one read of what is stored).
      const known = new Map(((await env.DB.prepare("SELECT id, outcome FROM lens_readings WHERE lens = 'positioning' AND at_ms > ?").bind(now - 200 * DAY).all()).results ?? []).map((x) => [x.id, x.outcome]));
      out.positioning = await scorePositioning(env, { now, knobs, mode, record: (r, m) => (known.has(r.id) && (known.get(r.id) != null || r.outcome == null) ? "same" : upsertReading(env.DB, { ...r, detail: { lean: r.lean, series: r.series } }, { lens: "positioning", kind: "h4", mode: m, now })) });
      await env.SIGNAL_CACHE.put("lens:positioning:scored", new Date(now).toISOString(), { expirationTtl: 2 * HOUR });
      await ensureLensReadingsSchema(env.DB);
      out.ledger_readings = await scoreLedgerReadings(env, { now });
    }
  } catch (e) { out.positioning = { status: "failed", error: String(e?.message ?? e).slice(0, 160) }; }
  out.floor = await lensFloorStep(env, { now, notify, log: (action, detail) => omegaEvent(env.DB, now, action, detail) });
  return out;
}

async function omegaEvent(db, now, action, detail) {
  try { await db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(now, "agent:lens", action, JSON.stringify(detail)).run(); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- the bridge sync: the spike clock

let spikeMemo = { spike: false, since: null, wrote: 0 };
export function resetSpikeMemoForTests() { spikeMemo = { spike: false, since: null, wrote: 0 }; }
/**
 * The start of the live spread spike (the deferral's clock, RFC §6), kept in KV while it lasts (written at most every
 * 30 s); a spike not seen for 2 minutes starts again. Read only while the spread spikes. Returns the start or null.
 */
export async function spikeSince(env, spike, { now = Date.now() } = {}) {
  if (!spike) { spikeMemo = { spike: false, since: null, wrote: spikeMemo.wrote }; return null; }
  let since = spikeMemo.spike ? spikeMemo.since : null;
  if (since == null) {
    let rec = null;
    try { rec = parse(await env?.SIGNAL_CACHE?.get?.(LIQUIDITY_SPIKE_KEY), null); } catch { rec = null; }
    since = rec && finite(rec.since_ms) && finite(rec.last_ms) && now - rec.last_ms < 2 * M1 ? rec.since_ms : now;
  }
  if (now - spikeMemo.wrote >= 30_000) {
    try { await env?.SIGNAL_CACHE?.put?.(LIQUIDITY_SPIKE_KEY, JSON.stringify({ since_ms: since, last_ms: now }), { expirationTtl: 3600 }); } catch { /* the memo holds */ }
    spikeMemo.wrote = now;
  }
  spikeMemo = { ...spikeMemo, spike: true, since };
  return since;
}

// ---------------------------------------------------------------- health (RFC §10)

/** The lens checks of the health step: cot_stale, liquidity_archive_stale, lens_at_floor (info, reported once). */
export async function lensHealthIssues(env, now = Date.now()) {
  const out = [];
  try {
    const lens = await readLensState(env, { now });
    if (lens.switches.positioning) {
      const f = await cotFreshness(env, { now });
      if (f.rows > 0 && (f.stale || f.fetch_fail_streak >= 3)) out.push({ key: "cot_stale", kind: "cot_stale", subject: f.stale ? `The CFTC positioning report is stale: the newest known is ${f.age_days == null ? "missing" : `${Math.round(f.age_days)} days old`}; the POSITIONING witness is out of the quorum` : `The CFTC positioning fetch failed ${f.fetch_fail_streak} runs in a row`, detail: { age_days: f.age_days, fetch_fail_streak: f.fetch_fail_streak, series: f.series } });
    }
    if (lens.switches.liquidity && !goldPausedAt(now)) {
      const acct = await activeAccount(env);
      const state = await readLiquidityState(env);
      if (acct?.connected && finite(acct.receivedMs) && now - acct.receivedMs < 5 * M1 && String(env?.CORPUS_ORACLE_MODE ?? "off").toLowerCase() === "shadow") {
        const last = Number(state?.archive_last_ms);
        if (!finite(last) || now - last > 30 * M1) out.push({ key: "liquidity_archive_stale", kind: "liquidity_archive_stale", subject: `No broker M1 bar archived for ${finite(last) ? `${Math.round((now - last) / M1)} minutes` : "the connected account yet"} while the market is open and Omega is connected; the liquidity lens has no facts`, detail: { minutes: finite(last) ? Math.round((now - last) / M1) : null } });
      }
    }
    // The daily lens report refused, here by the price filter or by Aether's validator: the report is dark until fixed.
    try {
      const last = JSON.parse((await env?.SIGNAL_CACHE?.get?.(LENS_REPORT_LAST_KEY)) || "null");
      if (last && (last.status === "refused_locally" || last.status === "rejected")) {
        const what = last.status === "rejected" ? `Aether refused it (${String(last.reason ?? "no reason given").replace(/[^a-z0-9_:,. -]/gi, "").slice(0, 120)})` : `the price filter refused the key${(last.keys ?? []).length === 1 ? "" : "s"} ${(last.keys ?? []).map((k) => String(k).replace(/[^a-z0-9_.\[\]]/gi, "").slice(0, 60)).join(", ") || "(unknown)"}`;
        out.push({ key: `lens_report_refused:${last.status}`, kind: "lens_report_refused", subject: `The ${LENS_NAME} analyst's daily report reaches no knowledge: ${what}`, detail: { status: last.status, at: last.at ?? null, keys: last.keys ?? null } });
      }
    } catch { /* none */ }
    for (const l of ["positioning", "liquidity"]) {
      if (lens.switches[l] && floorHolds(l, { policy: lens.policy, floor: lens.floor })) out.push({ key: `lens_at_floor:${l}`, kind: "lens_at_floor", report_once: true, subject: `The ${l} lens of the ${LENS_NAME} analyst is at its floor weight in every mode (score ${Math.round((lens.floor[l].score ?? 0) * 100)}% over ${lens.floor[l].n ?? 0} readings); Aether can raise it again`, detail: { lens: l, score: lens.floor[l].score ?? null, n: lens.floor[l].n ?? null } });
    }
  } catch { /* never fatal */ }
  return out;
}

// ---------------------------------------------------------------- the report and the page

async function scores(env, state) {
  const out = {};
  try {
    await ensureLensReadingsSchema(env.DB);
    for (const l of ["positioning", "liquidity"]) {
      const k = lensKnobs(l, "intraday", { policy: state.policy, floor: state.floor });
      const rows = (await env.DB.prepare("SELECT kind, outcome FROM lens_readings WHERE lens = ? AND outcome IN ('hit', 'miss') ORDER BY at_ms DESC LIMIT ?").bind(l, k.score_window).all()).results ?? [];
      out[l] = { ...lensScore(rows, { window: k.score_window }), score_floor: k.score_floor, score_window: k.score_window };
    }
  } catch { /* none */ }
  return out;
}

/** GET /api/lens: the Nexus panel's read: per lens the weight per mode and its source, the score, floored, the baseline, the COT freshness, the switches. No price. */
export async function lensStatus(env, { now = Date.now() } = {}) {
  const state = await readLensState(env, { now, fresh: true });
  const liq = await readLiquidityState(env);
  const cot = await cotFreshness(env, { now });
  const sc = await scores(env, state);
  const mode = await modeNow(env);
  const posFacts = await positioningNow(env, { now, knobs: lensKnobs("positioning", mode, { policy: state.policy, floor: state.floor }) });
  return {
    agent: LENS_NAME, mode, switches: { positioning_enabled: state.switches.positioning, liquidity_enabled: state.switches.liquidity, setting: LENS_SWITCHES },
    doctrine_sha: state.policy?.doctrine_sha ?? null, policy_pulled_at: state.policy?.pulled_at ?? null,
    positioning: {
      weights: lensWeights("positioning", { policy: state.policy, floor: state.floor, enabled: state.switches.positioning }),
      score: sc.positioning ?? null, floored: floorHolds("positioning", state), floor: state.floor?.positioning ?? null,
      cot: { as_of: cot.as_of, series: cot.series, age_days: cot.age_days, stale: cot.stale, fetch_fail_streak: cot.fetch_fail_streak },
      facts: state.switches.positioning && posFacts ? { crowding: posFacts.crowding, divergence: posFacts.divergence, net_pctl_3y: posFacts.net_pctl_3y, net_change_z: posFacts.net_change_z, stale: posFacts.stale, line: positioningLine(posFacts) } : null
    },
    liquidity: {
      weights: lensWeights("liquidity", { policy: state.policy, floor: state.floor, enabled: state.switches.liquidity, baseline: liq?.baseline ?? null }),
      score: sc.liquidity ?? null, floored: floorHolds("liquidity", state), floor: state.floor?.liquidity ?? null,
      baseline: liq?.baseline ?? "unavailable", baseline_weeks: liq?.baseline_weeks ?? 0, updated_at: finite(liq?.at_ms) ? new Date(liq.at_ms).toISOString() : null,
      facts: state.switches.liquidity && liq?.facts ? { ...liq.facts } : null, line: state.switches.liquidity && liq?.facts ? liquidityLine(liq.facts) : null
    }
  };
}

/** The daily lens report to Aether (cryptophys.lens-report.v1) through KnowledgeIngress.ingestLensReport, when the binding offers it. */
export async function pushLensReport(env, { now = Date.now() } = {}) {
  if (typeof env?.AETHER?.ingestLensReport !== "function") return { status: "disabled" };
  const kv = env.SIGNAL_CACHE;
  const day = new Date(now).toISOString().slice(0, 10);
  if ((await kv?.get?.("lens:report:day")) === day) return { status: "sent_today" };
  const state = await readLensState(env, { now, fresh: true });
  const liq = await readLiquidityState(env);
  const cot = await cotFreshness(env, { now });
  const report = lensReport({ state, scores: await scores(env, state), positioning: { series: cot.series, age_days: cot.age_days, stale: cot.stale }, liquidity: { baseline: liq?.baseline ?? null, baseline_weeks: liq?.baseline_weeks ?? 0 }, now });
  const remember = async (out) => { try { await kv?.put?.(LENS_REPORT_LAST_KEY, JSON.stringify({ ...out, at: new Date(now).toISOString() }), { expirationTtl: 30 * DAY }); } catch { /* the alert reads none */ } return out; };
  if (!report) {
    // A key the price filter refuses (it matches substrings: "slippage" contains "sl"): the report would go dark, so say
    // which keys (paths only, never a value), as the health alert lens_report_refused (orchestrator note on #505).
    const draft = lensReportDraft({ state, scores: await scores(env, state), positioning: { series: cot.series, age_days: cot.age_days, stale: cot.stale }, liquidity: { baseline: liq?.baseline ?? null, baseline_weeks: liq?.baseline_weeks ?? 0 }, now });
    return remember({ status: "refused_locally", keys: forbiddenReportKeys(draft).slice(0, 5) });
  }
  let res;
  try { res = await env.AETHER.ingestLensReport(report); } catch (e) { return { status: "transport_failed", error: String(e?.message ?? e).slice(0, 160) }; }
  await kv?.put?.("lens:report:day", day, { expirationTtl: 2 * DAY });
  return remember({ status: res?.accepted ? "accepted" : "rejected", ...(res?.reason ? { reason: String(res.reason).slice(0, 120) } : {}) });
}
export { LENS_FLOOR_KEY };
export const LENS_REPORT_LAST_KEY = "lens:report:last";

// ---------------------------------------------------------------- the rooms' context line (RFC §2, §3.5, §4.3)

/**
 * B16: what the 15m and 1H rooms read of lens B. "conditions" (the default): the brief's line plus lens B's conditions
 * (liquidityConditions), which the room's risk desk (its data) and moderator (its prompt) read, while lens B is on, above
 * its floor and fresh. "brief": the brief's line only, the prompts byte for byte as before B16. Env LENS_ROOM_LINE.
 */
export const LENS_ROOM_LINES = Object.freeze(["conditions", "brief"]);
export function lensRoomLine(env) {
  return String(env?.LENS_ROOM_LINE ?? "conditions").trim().toLowerCase() === "brief" ? "brief" : "conditions";
}
/** The 15m and 1H rooms' charts, the only ones that read lens B (and its conditions). */
export const LIQUIDITY_ROOM_CHARTS = Object.freeze(["M15", "H1"]);
/** Pure: the conditions line a room's prompts read, from its stored brief's context (null: today's prompts). */
export function roomConditionsLine(env, chart, context) {
  if (lensRoomLine(env) !== "conditions" || !LIQUIDITY_ROOM_CHARTS.includes(chart)) return null;
  return context?.lens === "liquidity" && typeof context.conditions === "string" && context.conditions ? context.conditions : null;
}

/**
 * The analyst's line in a room's brief: lens A in the 4H and 1D rooms, lens B in the 15m and 1H rooms. Built from the
 * facts by a template (no model call), with its bias, outside the room's quorum and the crowd (it is not on the roster).
 * No price. Null when the lens is switched off or has nothing to say. B16: lens B's line also carries `conditions`
 * (liquidityConditions' plain words, no sweep, no price) while LENS_ROOM_LINE is "conditions" and lens B is on, above
 * its floor and its state fresh (liquidityConditionsOn, the LIQUIDITY card's gates).
 */
export async function roomContextLine(env, chart, { now = Date.now() } = {}) {
  try {
    const lens = await readLensState(env, { now });
    if (chart === "H4" || chart === "D1") {
      if (!lens.switches.positioning) return null;
      const mode = await modeNow(env);
      const k = lensKnobs("positioning", mode, { policy: lens.policy, floor: lens.floor });
      const f = await positioningNow(env, { now, knobs: k });
      if (!f) return null;
      const lean = positioningLean(f, k);
      return { analyst: LENS_NAME, lens: "positioning", line: positioningLine(f), bias: !finite(lean) || Math.abs(lean) < 0.15 ? "NEUTRAL" : lean > 0 ? "BULLISH" : "BEARISH", outside_quorum: true };
    }
    if (chart === "M15" || chart === "H1") {
      if (!lens.switches.liquidity) return null;
      const st = await readLiquidityState(env);
      if (!st?.facts) return null;
      const sw = st.facts.sweep && st.facts.sweep.age_min <= 15 ? st.facts.sweep.side : null;
      const out = { analyst: LENS_NAME, lens: "liquidity", line: liquidityLine(st.facts), bias: sw === "sell_side" ? "BULLISH" : sw === "buy_side" ? "BEARISH" : "NEUTRAL", baseline: st.facts.baseline ?? st.baseline ?? "insufficient", outside_quorum: true };
      if (lensRoomLine(env) === "conditions") {
        const knobs = lensKnobs("liquidity", await modeNow(env), { policy: lens.policy, floor: lens.floor, enabled: lens.switches.liquidity, baseline: st.baseline ?? null });
        const c = liquidityConditionsOn(st, knobs, now) ? liquidityConditions(st.facts, { knobs, stateAtMs: st.at_ms, now }) : null;
        if (c) out.conditions = c.line;
      }
      return out;
    }
  } catch { /* no line */ }
  return null;
}

/** Lens A's fact for the mode council and the profile review (RFC §3.5): crowding and divergence; null when off. */
export async function positioningPack(env, { now = Date.now() } = {}) {
  try {
    const lens = await readLensState(env, { now });
    if (!lens.switches.positioning) return null;
    const k = lensKnobs("positioning", await modeNow(env), { policy: lens.policy, floor: lens.floor });
    return positioningPackFact(await positioningNow(env, { now, knobs: k }));
  } catch { return null; }
}
