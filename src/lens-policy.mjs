// The Positioning & Liquidity analyst's weights, thresholds, score and rollback (docs/RFC_POSITIONING_LIQUIDITY.md §7,
// §8; owner 2026-11-20: "Sekarang breakglass urgent jadi langsung live"). One table of knobs per lens and mode, each a
// DOCTRINE_BOUNDS fact proposed to the platform: xauusd starts at the anchor, reads Aether's value back (KV
// lens:policy:v1, filled by the hourly Aether pack pull, src/omega-policy.mjs) and clamps it to the bound. A poor
// outcome score drops a lens's weight to the floor of its bound in every mode, at once; only a newer doctrine value from
// Aether lifts it. The owner's switches (Omega settings positioning_enabled, liquidity_enabled, default on) turn a lens
// off at once: off, it contributes nothing. No price anywhere in this module.

export const LENS_MODES = Object.freeze(["scalp", "intraday", "swing", "range"]);
export const LENSES = Object.freeze(["positioning", "liquidity"]);
export const LENS_POLICY_KEY = "lens:policy:v1";
export const LENS_FLOOR_KEY = "lens:floor:v1";
export const LENS_REPORT_VERSION = "cryptophys.lens-report.v1";
export const LENS_NAME = "Positioning & Liquidity";
/** The owner's switches (Omega settings, OMEGA_DEFAULTS true): the rollback switch of each lens. */
export const LENS_SWITCHES = Object.freeze({ positioning: "positioning_enabled", liquidity: "liquidity_enabled" });
/** A lens is floored by its score only once this many decisive readings stand in its window (RFC deviation: a floor). */
export const LENS_SCORE_MIN_N = 20;

const per = (scalp, intraday, swing, range) => Object.freeze({ scalp, intraday, swing, range });
const b = (min, max) => Object.freeze({ min, max });
const same = (min, max) => per(b(min, max), b(min, max), b(min, max), b(min, max));

/**
 * The knobs per mode (RFC §8): the fact's base name (the fact is `<base>_<mode>`), its unit, the start (the anchor
 * proposed to Aether) and the bound per mode.
 */
export const LENS_KNOBS = Object.freeze({
  "positioning.de_weight": Object.freeze({ lens: "positioning", unit: "share of the Decision Engine's witness weight; the other witnesses scale by 1 - w", start: per(0.02, 0.03, 0.05, 0.03), bounds: per(b(0.02, 0.04), b(0.02, 0.06), b(0.02, 0.1), b(0.02, 0.05)) }),
  "positioning.crowd_pctl": Object.freeze({ lens: "positioning", unit: "percentile of the managed-money net among the 156 weekly nets before it; the low side is 1 - value", start: per(0.9, 0.9, 0.9, 0.9), bounds: same(0.8, 0.95) }),
  "positioning.flow_z": Object.freeze({ lens: "positioning", unit: "standard deviations of the week's net change against the 156 weekly changes", start: per(1, 1, 1, 1), bounds: same(0.5, 2) }),
  "liquidity.council_weight": Object.freeze({ lens: "liquidity", unit: "weight of lens B in the councils, the filter and the reasons; 0 is muted", start: per(0.4, 0.3, 0.2, 0.3), bounds: per(b(0, 0.8), b(0, 0.6), b(0, 0.4), b(0, 0.6)) }),
  "liquidity.spike_pctl": Object.freeze({ lens: "liquidity", unit: "percentile of the M1 tick volume in its New York hour of the week, 8 weeks", start: per(0.95, 0.95, 0.97, 0.95), bounds: same(0.9, 0.99) }),
  "liquidity.thin_pctl": Object.freeze({ lens: "liquidity", unit: "percentile of the 15m tick-volume sum in its hour of the week, at or below which liquidity is thin", start: per(0.2, 0.2, 0.2, 0.2), bounds: same(0.05, 0.3) }),
  "liquidity.spread_widen": Object.freeze({ lens: "liquidity", unit: "ratio, the live spread over the hour of the week's median M1 spread", start: per(1.8, 2, 2.5, 2), bounds: same(1.5, 4) }),
  "liquidity.sweep_lookback_min": Object.freeze({ lens: "liquidity", unit: "minutes of broker M1 bars searched for the prior swing high or low", start: per(60, 180, 720, 180), bounds: per(b(30, 120), b(60, 360), b(240, 1440), b(60, 360)) }),
  "liquidity.pool_tol_atr": Object.freeze({ lens: "liquidity", unit: "multiple of ATR(14) of the closed 15m bars between swing extremes that count as equal", start: per(0.05, 0.05, 0.08, 0.05), bounds: same(0.02, 0.15) }),
  "liquidity.hvn_pctl": Object.freeze({ lens: "liquidity", unit: "percentile of the profile's bins (0.1 x ATR(14, 15m) wide) at or above which a bin is a node", start: per(0.85, 0.85, 0.85, 0.85), bounds: same(0.8, 0.95) }),
  "liquidity.profile_window_min": Object.freeze({ lens: "liquidity", unit: "minutes of broker M1 bars in the tick-volume profile", start: per(240, 1440, 7200, 1440), bounds: per(b(120, 480), b(480, 2880), b(2880, 14400), b(480, 2880)) })
});
/** The score knobs, per lens and not per mode (RFC §8): modes switch, and one mode alone rarely has the readings. */
export const LENS_SCORE_KNOBS = Object.freeze({
  "positioning.score_floor": Object.freeze({ lens: "positioning", unit: "hit share over the last score_window readings", start: 0.45, bound: b(0.4, 0.5) }),
  "positioning.score_window": Object.freeze({ lens: "positioning", unit: "number of scored readings (4H)", start: 60, bound: b(40, 200) }),
  "liquidity.score_floor": Object.freeze({ lens: "liquidity", unit: "hit share over the last score_window readings", start: 0.45, bound: b(0.4, 0.5) }),
  "liquidity.score_window": Object.freeze({ lens: "liquidity", unit: "number of scored readings (sweeps, blocks, maker choices)", start: 100, bound: b(50, 300) })
});
export const WEIGHT_KNOB = Object.freeze({ positioning: "positioning.de_weight", liquidity: "liquidity.council_weight" });

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const modeOf = (m) => (LENS_MODES.includes(m) ? m : "intraday");
const shortKey = (base) => base.split(".")[1];

/** Every fact name of the lens knobs (`positioning.de_weight_scalp`, …, `liquidity.score_window`). */
export function lensFactNames() {
  return [...Object.keys(LENS_KNOBS).flatMap((base) => LENS_MODES.map((m) => `${base}_${m}`)), ...Object.keys(LENS_SCORE_KNOBS)];
}

/** Pure: Aether's values (flat fact names) for the lens knobs, each clamped to its bound; other keys are dropped. */
export function lensPolicyFromPack(pack) {
  const v = pack?.values && typeof pack.values === "object" ? pack.values : pack?.facts && typeof pack.facts === "object" ? pack.facts : null;
  if (!v) return null;
  const out = {};
  for (const [base, k] of Object.entries(LENS_KNOBS)) {
    for (const m of LENS_MODES) {
      const x = Number(v[`${base}_${m}`]);
      if (v[`${base}_${m}`] != null && Number.isFinite(x)) out[`${base}_${m}`] = clamp(x, k.bounds[m].min, k.bounds[m].max);
    }
  }
  for (const [name, k] of Object.entries(LENS_SCORE_KNOBS)) {
    const x = Number(v[name]);
    if (v[name] != null && Number.isFinite(x)) out[name] = clamp(x, k.bound.min, k.bound.max);
  }
  if (!Object.keys(out).length) return null;
  return { values: out, doctrine_sha: typeof pack.doctrine_sha === "string" ? pack.doctrine_sha : null, version: pack.version ?? null };
}

/** Pure: whether a lens's floor still holds: Aether has not sent a weight for it under another doctrine version since. */
export function floorHolds(lens, { policy = null, floor = null } = {}) {
  const f = floor?.[lens];
  if (!f || !finite(f.at_ms)) return false;
  const base = WEIGHT_KNOB[lens];
  const hasWeight = LENS_MODES.some((m) => finite(policy?.values?.[`${base}_${m}`]));
  const pulled = Date.parse(policy?.pulled_at ?? "");
  const newer = hasWeight && typeof policy?.doctrine_sha === "string" && policy.doctrine_sha !== (f.doctrine_sha ?? null) && Number.isFinite(pulled) && pulled > f.at_ms;
  return !newer;
}

/**
 * Pure: one lens's knobs in force for a mode. `policy` is KV lens:policy:v1 ({ values, doctrine_sha, pulled_at }),
 * `floor` KV lens:floor:v1 ({ <lens>: { at_ms, doctrine_sha, score, n } }), `enabled` the owner's switch, `baseline`
 * lens B's baseline state ("sufficient" or not). Returns { lens, mode, enabled, weight, weight_source (anchor, aether,
 * floor_rollback, switch_off), floored, active (the weight is above its floor and the switch on), <thresholds>,
 * score_floor, score_window }.
 */
export function lensKnobs(lens, mode, { policy = null, floor = null, enabled = true, baseline = null } = {}) {
  const m = modeOf(mode);
  const out = { lens, mode: m, enabled: enabled !== false };
  const vals = policy?.values ?? {};
  for (const [base, k] of Object.entries(LENS_KNOBS)) {
    if (k.lens !== lens) continue;
    const x = vals[`${base}_${m}`];
    out[shortKey(base)] = finite(x) ? clamp(x, k.bounds[m].min, k.bounds[m].max) : k.start[m];
  }
  for (const [name, k] of Object.entries(LENS_SCORE_KNOBS)) {
    if (k.lens !== lens) continue;
    const x = vals[name];
    out[shortKey(name)] = finite(x) ? clamp(x, k.bound.min, k.bound.max) : k.start;
  }
  const base = WEIGHT_KNOB[lens], wk = LENS_KNOBS[base];
  const key = shortKey(base), floorValue = wk.bounds[m].min, anchor = wk.start[m];
  const fromAether = finite(vals[`${base}_${m}`]);
  const floored = floorHolds(lens, { policy, floor });
  let weight = out[key], source = fromAether ? "aether" : "anchor";
  // Lens B: while the baseline is insufficient, the weight in force may not rise above its anchor (RFC §4.2).
  if (lens === "liquidity" && baseline !== "sufficient" && weight > anchor) { weight = anchor; source = "anchor_baseline_insufficient"; }
  if (floored) { weight = floorValue; source = "floor_rollback"; }
  if (out.enabled !== true) { weight = 0; source = "switch_off"; }
  out[key] = weight;
  out.weight = weight;
  out.weight_source = source;
  out.anchor = anchor;
  out.floor_value = floorValue;
  out.floored = floored;
  // Lens B is on (gate, deferral, reasons, levels) only above its floor; lens A counts at its weight whenever it is on.
  out.active = out.enabled === true && (lens === "liquidity" ? weight > floorValue + 1e-12 : weight > 0);
  return out;
}

/** Pure: a lens's weight per mode in force, as the page and the report show it. */
export function lensWeights(lens, opts = {}) {
  return Object.fromEntries(LENS_MODES.map((m) => { const k = lensKnobs(lens, m, opts); return [m, { weight: k.weight, source: k.weight_source }]; }));
}

// ---------------------------------------------------------------- the switches and the stored state

/** Pure: the owner's switches from the Omega settings (missing: on). */
export function lensSwitchesFrom(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  return { positioning: s.positioning_enabled !== false, liquidity: s.liquidity_enabled !== false };
}

let memo = { at: 0, db: null, kv: null, value: null };
export function resetLensStateMemoForTests() { memo = { at: 0, db: null, kv: null, value: null }; }
const parse = (s, d = null) => { try { return typeof s === "string" ? JSON.parse(s) : (s ?? d); } catch { return d; } };

/**
 * The lenses' stored state: the owner's switches (omega_settings), Aether's policy and the floor (KV). Kept 30 s per
 * isolate (`fresh` skips the memo). Never throws: unreadable switches read as on, an unreadable policy as none.
 */
export async function readLensState(env, { now = Date.now(), fresh = false } = {}) {
  if (!fresh && memo.value && now - memo.at < 30_000 && memo.db === env?.DB && memo.kv === env?.SIGNAL_CACHE) return memo.value;
  let settings = null;
  try { settings = parse((await env?.DB?.prepare?.("SELECT settings FROM omega_settings WHERE id = 1")?.first?.())?.settings, null); } catch { settings = null; }
  let policy = null, floor = null;
  try { policy = parse(await env?.SIGNAL_CACHE?.get?.(LENS_POLICY_KEY), null); } catch { policy = null; }
  try { floor = parse(await env?.SIGNAL_CACHE?.get?.(LENS_FLOOR_KEY), null); } catch { floor = null; }
  const value = { switches: lensSwitchesFrom(settings), policy, floor: floor && typeof floor === "object" ? floor : {} };
  memo = { at: now, db: env?.DB, kv: env?.SIGNAL_CACHE, value };
  return value;
}

/** Stores Aether's lens values (from the hourly pack pull). Returns the stored record or null. */
export async function storeLensPolicy(env, pack, { now = Date.now() } = {}) {
  const p = lensPolicyFromPack(pack);
  if (!p || !env?.SIGNAL_CACHE?.put) return null;
  const rec = { ...p, pulled_at: new Date(now).toISOString() };
  await env.SIGNAL_CACHE.put(LENS_POLICY_KEY, JSON.stringify(rec));
  memo = { at: 0, db: null, kv: null, value: null };
  return rec;
}

// ---------------------------------------------------------------- the outcome score and the floor

export const LENS_READINGS_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS lens_readings (
    id TEXT PRIMARY KEY,
    lens TEXT NOT NULL,
    kind TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    mode TEXT,
    side INTEGER,
    outcome TEXT,
    detail_json TEXT,
    scored_ms INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS lens_readings_lens ON lens_readings (lens, at_ms)",
  "CREATE INDEX IF NOT EXISTS lens_readings_open ON lens_readings (outcome, kind, at_ms)"
]);
let readingsReady = null;
export function resetLensReadingsSchemaForTests() { readingsReady = null; }
export async function ensureLensReadingsSchema(db) {
  if (readingsReady === db) return;
  for (const q of LENS_READINGS_SQL) await db.prepare(q).run();
  readingsReady = db;
}

/** Records one reading (idempotent by id). `detail` must carry no price (callers pass counts, R, percentiles, codes). */
export async function recordLensReading(db, { id, lens, kind, at_ms, mode = null, side = null, outcome = null, detail = null }, { now = Date.now() } = {}) {
  await ensureLensReadingsSchema(db);
  const r = await db.prepare("INSERT OR IGNORE INTO lens_readings (id, lens, kind, at_ms, mode, side, outcome, detail_json, scored_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(String(id), lens, kind, at_ms, mode, side, outcome, detail ? JSON.stringify(detail) : null, outcome ? now : null).run();
  return Number(r?.meta?.changes) > 0;
}

/**
 * The statements of one reading, for a batch: the INSERT OR IGNORE, and with an outcome the UPDATE that scores a
 * pending row (upsertReading's two steps; B2's replay sends them through db.batch). The schema must exist.
 */
export function lensReadingStatements(db, { id, lens, kind, at_ms, mode = null, side = null, outcome = null, detail = null }, { now = Date.now() } = {}) {
  const out = [db.prepare("INSERT OR IGNORE INTO lens_readings (id, lens, kind, at_ms, mode, side, outcome, detail_json, scored_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(String(id), lens, kind, at_ms, mode, side, outcome, detail ? JSON.stringify(detail) : null, outcome ? now : null)];
  if (outcome) out.push(db.prepare("UPDATE lens_readings SET outcome = ?, scored_ms = ? WHERE id = ? AND outcome IS NULL").bind(outcome, now, String(id)));
  return out;
}

/** Pure: the score of readings (newest first): hits / (hits + misses) over the newest `window` decisive ones, per kind too. */
export function lensScore(rows, { window = 60 } = {}) {
  const decisive = (rows || []).filter((r) => r.outcome === "hit" || r.outcome === "miss").slice(0, window);
  const hits = decisive.filter((r) => r.outcome === "hit").length, misses = decisive.length - hits;
  const kinds = {};
  for (const r of decisive) {
    const k = (kinds[r.kind] ??= { hits: 0, misses: 0 });
    if (r.outcome === "hit") k.hits += 1; else k.misses += 1;
  }
  for (const k of Object.values(kinds)) k.share = k.hits + k.misses ? Math.round((k.hits / (k.hits + k.misses)) * 1000) / 1000 : null;
  return { hits, misses, n: decisive.length, share: decisive.length ? Math.round((hits / decisive.length) * 1000) / 1000 : null, kinds };
}

/** Pure: whether a score drops its lens to the floor: enough decisive readings and a share below the floor. */
export function belowFloor(score, { floor = 0.45, minN = LENS_SCORE_MIN_N } = {}) {
  return finite(score?.share) && score.n >= minN && score.share < floor;
}

/** The Telegram line of a drop to the floor (RFC §7.3). No price. */
export function floorLine(lens, score, floorShare) {
  const name = lens === "positioning" ? "Positioning lens" : "Liquidity lens";
  return `${name}: weight to its floor in every mode. Hit share ${Math.round(score.share * 100)}% over the last ${score.n} readings, floor ${Math.round(floorShare * 100)}%. Aether can raise it again.`;
}

/**
 * B19: the reading kinds the automatic floor reads, per lens (null: every kind). Lens B's hold and skip readings (B19)
 * are recorded and reported only; bringing them into the floor is a separate decision (orchestrator 2026-11-26).
 */
export const FLOOR_KINDS = Object.freeze({ liquidity: Object.freeze(["sweep", "block", "maker"]), positioning: null });

/**
 * The scoring step's rollback (RFC §7.3), after each scoring run: per lens, the score over its last score_window
 * readings; below score_floor (with LENS_SCORE_MIN_N decisive readings) the lens's weight drops to the floor of its
 * bound in every mode at once, with an omega_events row (lens_weight_floor) and one line to the owner's private chat
 * (`notify`, sendOmegaTelegram). Already floored: nothing again. A rollback never changes a hard guard and never closes
 * a position. Never throws.
 */
export async function lensFloorStep(env, { now = Date.now(), notify = null, log = null } = {}) {
  const db = env?.DB, kv = env?.SIGNAL_CACHE;
  if (!db || !kv?.put) return { status: "unavailable" };
  try {
    await ensureLensReadingsSchema(db);
    const state = await readLensState(env, { now, fresh: true });
    const floor = { ...(state.floor ?? {}) };
    const out = {};
    let changed = false;
    for (const lens of LENSES) {
      const k = lensKnobs(lens, "intraday", { policy: state.policy, floor });
      // B19: only FLOOR_KINDS count toward the floor (hold and skip are reported, not floored; orchestrator 2026-11-26).
      const kinds = FLOOR_KINDS[lens];
      const rows = (await db.prepare(`SELECT kind, outcome FROM lens_readings WHERE lens = ? AND outcome IN ('hit', 'miss')${kinds ? ` AND kind IN (${kinds.map(() => "?").join(", ")})` : ""} ORDER BY at_ms DESC LIMIT ?`).bind(lens, ...(kinds ?? []), k.score_window).all()).results ?? [];
      const score = lensScore(rows, { window: k.score_window });
      out[lens] = { score, floored: k.floored };
      if (k.floored || !belowFloor(score, { floor: k.score_floor })) continue;
      const before = lensWeights(lens, { policy: state.policy, floor, enabled: true, baseline: "sufficient" });
      floor[lens] = { at_ms: now, doctrine_sha: state.policy?.doctrine_sha ?? null, score: score.share, n: score.n, score_floor: k.score_floor };
      changed = true;
      out[lens].floored = true;
      out[lens].dropped = true;
      const detail = { lens, score: score.share, n: score.n, floor: k.score_floor, modes: LENS_MODES, weights_before: Object.fromEntries(Object.entries(before).map(([m, x]) => [m, x.weight])) };
      try { if (typeof log === "function") await log("lens_weight_floor", detail); else await db.prepare("INSERT INTO omega_events (ms, actor, action, detail) VALUES (?, ?, ?, ?)").bind(now, "agent:lens", "lens_weight_floor", JSON.stringify(detail)).run(); } catch { /* the KV floor stands */ }
      try { if (typeof notify === "function") await notify(floorLine(lens, score, k.score_floor)); } catch { /* best effort */ }
    }
    if (changed) { await kv.put(LENS_FLOOR_KEY, JSON.stringify(floor)); resetLensStateMemoForTests(); }
    return { status: changed ? "floored" : "ok", lenses: out };
  } catch (e) {
    return { status: "failed", error: String(e?.message ?? e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------- the report to Aether (no price)

/** Keys a lens report may never carry at any depth (RFC §10). Contracts and percentiles are not prices. */
export const LENS_REPORT_FORBIDDEN = /price|entry|stop|sl|tp|target|level|zone|bid|ask/i;
/** Fact names must pass the platform's prohibited filter (RFC §3.3, §8). */
export const PROHIBITED_FACT = /trad(e|ing)\b|order|wallet|withdraw|transfer|swap/;

/** Pure: every key of an object at any depth that a lens report may not carry. */
export function forbiddenReportKeys(obj, path = "") {
  const bad = [];
  if (Array.isArray(obj)) obj.forEach((x, i) => bad.push(...forbiddenReportKeys(x, `${path}[${i}]`)));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) {
    if (LENS_REPORT_FORBIDDEN.test(k)) bad.push(`${path}.${k}`);
    bad.push(...forbiddenReportKeys(v, `${path}.${k}`));
  }
  return bad;
}

/**
 * Pure: cryptophys.lens-report.v1: per lens the weight in force per mode with its source, the score overall and per
 * kind, the floor, lens B's baseline state and lens A's series and report age. R, shares and counts only; a report
 * with a forbidden key is refused (null).
 */
export function lensReport(args) {
  const report = lensReportDraft(args);
  return forbiddenReportKeys(report).length ? null : report;
}
/** Pure: the report before the price filter (lensReport refuses it when a key matches). */
export function lensReportDraft({ state, scores = {}, positioning = null, liquidity = null, now = Date.now() }) {
  const lens = (name, extra) => ({
    enabled: state?.switches?.[name] !== false,
    weights: lensWeights(name, { policy: state?.policy, floor: state?.floor, enabled: state?.switches?.[name] !== false, baseline: liquidity?.baseline ?? null }),
    score: scores[name] ?? null,
    floored: floorHolds(name, { policy: state?.policy, floor: state?.floor }),
    floor_event: state?.floor?.[name] ? { at: new Date(state.floor[name].at_ms).toISOString(), share: state.floor[name].score ?? null, n: state.floor[name].n ?? null } : null,
    ...extra
  });
  const report = {
    schema: LENS_REPORT_VERSION, agent: LENS_NAME, generated_at: new Date(now).toISOString(),
    doctrine_sha: state?.policy?.doctrine_sha ?? null,
    lenses: {
      positioning: lens("positioning", { series: positioning?.series ?? null, report_age_days: positioning?.age_days ?? null, stale: positioning?.stale ?? null }),
      liquidity: lens("liquidity", { baseline: liquidity?.baseline ?? "unavailable", baseline_weeks: liquidity?.baseline_weeks ?? 0 })
    }
  };
  return report;
}
