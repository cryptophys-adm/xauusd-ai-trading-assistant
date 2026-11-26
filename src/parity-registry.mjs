// Autonomous provenance registry for local-computation engines.
//
// Replaces the operator-approved hash allowlist. A local engine implementation
// (engine + source_hash + implementation_hash) becomes trusted only through
// measured parity: for each closed candle where TradingView's own outputs
// arrive by webhook, the local outputs and the raw candle inputs are compared
// field by field. The AI Worker holds the promotion/revocation privilege, but
// the decision is a deterministic rule, never a model judgement:
//   - N consecutive fully matching candles  -> approved
//   - any mismatch on an approved hash      -> revoked (fail closed)
//   - a revoked hash must re-earn N consecutive matches
// Mizan is a shared library with no webhook of its own: a Mizan hash is
// trusted only while approved Prophet AND GMI implementations declare it as
// their Mizan dependency.

export const PARITY_REGISTRY_VERSION = "cryptophys.engine-parity-registry.v1";

/** Webhook fields each local engine must reproduce (source -> fields). */
export const PARITY_FIELDS = Object.freeze({
  prophet: Object.freeze({
    prophet_r38: Object.freeze(["direction", "buy_confirmed", "sell_confirmed", "buy_high_quality", "sell_high_quality", "t_enc", "d_enc", "structure_subtype"]),
    // structure_state is a chart-relative bar_index and is not comparable across systems.
    prophet_r37_ssot: Object.freeze(["direction", "d_enc", "b_enc", "structure_subtype", "bull_event", "bear_event"])
  }),
  gmi: Object.freeze({
    gmi_v12_70: Object.freeze(["verdict", "gate", "gmi_dir", "prophet_dir", "conflict"])
  }),
  // Separate HUD identities (RFC §3). Approved prophet/gmi identities above are untouched.
  prophet_hud: Object.freeze({
    prophet_r38_hud: Object.freeze(["cshi_score", "cycle_intensity", "d_enc", "structure_subtype", "t_enc"])
  }),
  gmi_hud: Object.freeze({
    // The Grid Bot Protocol fields (2026-11-07): CSHI viability, deploy status code (1 muddy waters,
    // 2 toxic chop, 3 optimal, 4 trending or dead), muddy waters and grid viable.
    gmi_v12_70_hud: Object.freeze(["verdict", "gate", "gmi_dir", "prophet_dir", "conflict", "cshi_viability", "deploy_status", "muddy_waters", "grid_viable"])
  })
});

/** Raw candle inputs carried by every webhook payload; the local engine must have used the same bar. */
export const INPUT_FIELDS = Object.freeze(["o", "h", "l", "c", "volume"]);

export const DEFAULT_POLICY = Object.freeze({ promoteAfter: 24, absTolerance: 1e-6, relTolerance: 1e-9 });

const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const HASH = /^[a-f0-9]{64}$/;

export function policyFromEnv(env = {}) {
  const int = Number.parseInt(String(env.PARITY_PROMOTE_AFTER ?? ""), 10);
  const abs = Number(env.PARITY_ABS_TOLERANCE);
  const rel = Number(env.PARITY_REL_TOLERANCE);
  return {
    promoteAfter: Number.isInteger(int) && int >= 1 ? int : DEFAULT_POLICY.promoteAfter,
    absTolerance: Number.isFinite(abs) && abs >= 0 ? abs : DEFAULT_POLICY.absTolerance,
    relTolerance: Number.isFinite(rel) && rel >= 0 ? rel : DEFAULT_POLICY.relTolerance
  };
}

export function normalizeHash(value) {
  const hash = typeof value === "string" ? value.trim().toLowerCase() : "";
  return HASH.test(hash) ? hash : null;
}

export const BASE_ENGINES = Object.freeze(["mizan", "prophet", "gmi", "prophet_hud", "gmi_hud", "gmi_adopt", "prophet_adopt"]);

/** A HUD field group whose local and webhook fields share their names (null === null is equal). */
function hudGroup(engine, source, fields) {
  return Object.freeze({ engine, source, kind: "hud", fields: Object.freeze(Object.fromEntries(fields.split(" ").map((f) => [f, f]))), nullEqual: true, requireFinite: false });
}

/**
 * Parity field groups (B7): a group of fields of one engine's records that earns its own parity
 * trust, so one bad field revokes only its group and not the whole engine identity. Keyed by group
 * id. Each group names the base engine whose records carry it, the webhook source it is compared
 * with, and its fields as { local field: webhook field } (the fieldMap of compareWithWebhooks).
 * A group's identity is the engine identity (its source and implementation hashes) plus the group
 * id (groupIdentityOf), so it has its own 24-candle window, approval and revocation in the same
 * registry tables.
 *   - kind "hud": a HUD group; only a HUD group may set nullEqual (null === null counts as equal).
 *   - kind "witness": requireFinite, a candle matches only when every field is a finite number on
 *     both sides; null (or any non-finite value) on both sides is incomplete, never a match.
 * A group is compared only for an engine whose records are ingested and observed (evidence-fusion
 * INGEST_ENGINES). B11a ingests prophet_adopt (gmi_adopt follows in B11b/c): its groups have an
 * identity, the engine itself never does (ingest registers group identities only). probe_mizan is
 * neither ingested nor a base engine yet (B26), so its group has no identity (groupIdentityOf null).
 */
export const PARITY_GROUPS = Object.freeze({
  // MZ1, the Mizan witness (owner 2026-11-23). Carried by the Mizan Probe's records (engine
  // probe_mizan, B26) and its alert (source probe_mizan_hud, B10). Nothing produces either yet.
  probe_mizan_witness: Object.freeze({
    engine: "probe_mizan",
    source: "probe_mizan_hud",
    kind: "witness",
    fields: Object.freeze({ net_witness: "net_witness", prior_edge: "prior_edge" }),
    nullEqual: false,
    requireFinite: true
  }),
  // B10: the GMI R12 adoption alert (source gmi_v12_70_adopt_hud, pinescript/candidates
  // Global-Multiverse-Interceptor-v12.70.hud.v2.txt; RFC_INDICATOR_ADOPTION stages 1, 2, 4 and 6).
  // Engine gmi_adopt: B11's adopt records. cvd_life_pct is sent but never compared (it accumulates
  // from the chart's first bar, like structure_state).
  gmi_adopt_hud: hudGroup("gmi_adopt", "gmi_v12_70_adopt_hud", "swc tva_period smr_bull_pct smr_bear_pct mml"),
  gmi_adopt_flow: hudGroup("gmi_adopt", "gmi_v12_70_adopt_hud", "buy_vol sell_vol bar_delta delta_pct cvd14 cvd14_pct vol_surge wai wai_ok wai_acc wai_dist vpt_flow vpt_gap"),
  gmi_adopt_kin: hudGroup("gmi_adopt", "gmi_v12_70_adopt_hud", "jerk jerk_shock kin_phase rev_bars jma_bars jma_vel jma_long jma_short"),
  gmi_adopt_zone: hudGroup("gmi_adopt", "gmi_v12_70_adopt_hud", "whale whale_n mitig_bull mitig_bear wz1 wz2 wz3 wz4 wz5 wz1_hp wz2_hp wz3_hp wz4_hp wz5_hp"),
  gmi_adopt_zone_levels: hudGroup("gmi_adopt", "gmi_v12_70_adopt_hud", "wz1_top wz1_bot wz2_top wz2_bot wz3_top wz3_bot wz4_top wz4_bot wz5_top wz5_bot"),
  gmi_adopt_burst: hudGroup("gmi_adopt", "gmi_v12_70_adopt_hud", "burst bp_sqz bp_imb bp_ign bp_warp bp_mml"),
  gmi_adopt_order: hudGroup("gmi_adopt", "gmi_v12_70_adopt_hud", "ob_in_bull ob_in_bear ob_bull_n ob_bear_n ob_bull_hv ob_bear_hv"),
  gmi_adopt_levels: hudGroup("gmi_adopt", "gmi_v12_70_adopt_hud", "ob_bull_top ob_bull_bot ob_bear_top ob_bear_bot ob_bull_sl ob_bear_sl"),
  gmi_adopt_plan: hudGroup("gmi_adopt", "gmi_v12_70_adopt_hud", "plan_dir sl_state box_top box_bot box_tp box_rr cap_pct"),
  // B10: the Prophet R38 adoption alert (source prophet_r38_adopt_hud, The-Prophet-v7.02-R38.hud.v2.txt;
  // stages 1, 2 and 6). Engine prophet_adopt: B11's adopt records.
  prophet_adopt_hud: hudGroup("prophet_adopt", "prophet_r38_adopt_hud", "cshi cshi_tier er vol_anom"),
  prophet_adopt_core: hudGroup("prophet_adopt", "prophet_r38_adopt_hud", "early_buy early_sell bull_div bear_div bull_div_age bull_div_osc bear_div_age bear_div_osc pro_fast pro_slow pro_core"),
  prophet_adopt_ob: hudGroup("prophet_adopt", "prophet_r38_adopt_hud", "buy_ob_score sell_ob_score buy_ob_hv sell_ob_hv bull_tp_score bear_tp_score ob_bull_n ob_bear_n ob_filter buy_stop sell_stop buy_risk sell_risk buy_reward sell_reward buy_rr sell_rr buy_ready sell_ready"),
  prophet_adopt_scalp: hudGroup("prophet_adopt", "prophet_r38_adopt_hud", "mom mom_delta mom_ctx cross_up cross_dn ct_bull ct_bear proj_main proj_alt proj_slope"),
  prophet_adopt_plan: hudGroup("prophet_adopt", "prophet_r38_adopt_hud", "buy_entry_ref sell_entry_ref buy_entry sell_entry pos entry_ok tp_struct tp_reached reversal mom_weak exit_code exit_key tk_latched tk_dir tk_reached tk_just_hit tk_last_hit tk_hit"),
  // B10: the Cryptophys Mizan Probe's alert (source probe_mizan_hud, Cryptophys-Mizan-Probe.v1.txt, 15m;
  // stage 5). Engine probe_mizan: the Probe's local port (B26). probe_mizan_core is the Mizan
  // Oracle's HUD identity.
  probe_mizan_core: hudGroup("probe_mizan", "probe_mizan_hud", "z hurst entropy phi_wave regime oracle er psi_ad rho ent_dyn mml noise vol_t conf zone risk"),
  probe_mizan_mtf: hudGroup("probe_mizan", "probe_mizan_hud", "mtf_h mtf_z true_phi phi_t psi_d gravity roc_dxy roc_usdt macro"),
  probe_mizan_decision: hudGroup("probe_mizan", "probe_mizan_hud", "prior_edge markov reward break_bias grav_bonus poc_bonus fvg_bonus sing_bonus smr_bias div_bonus net_raw net_core net_final action_code safe veto"),
  probe_mizan_state: hudGroup("probe_mizan", "probe_mizan_hud", "bos sweep trap fvg smri q_net energy ext_lo ext_hi tp sl macro_tl")
});

const TIMEFRAME_SUFFIX = /_(m5|m15|h4|d1)$/;

/**
 * Pure: the declaration problems of a group registry ([] when sound). A group id never starts
 * with "mizan" (isTrusted reads an engine id starting with "mizan" as the Mizan library, trusted
 * only through its dependants), never equals or scopes a base engine id, and never carries a
 * timeframe suffix (groupIdentityOf adds it).
 */
export function parityGroupProblems(groups = PARITY_GROUPS) {
  const problems = [];
  for (const [groupId, g] of Object.entries(groups || {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(groupId)) problems.push(`${groupId}:id_invalid`);
    if (groupId.startsWith("mizan")) problems.push(`${groupId}:id_starts_with_mizan`);
    if (BASE_ENGINES.includes(groupId) || BASE_ENGINES.includes(groupId.replace(TIMEFRAME_SUFFIX, ""))) problems.push(`${groupId}:id_is_an_engine`);
    if (TIMEFRAME_SUFFIX.test(groupId)) problems.push(`${groupId}:id_has_timeframe_suffix`);
    if (typeof g?.engine !== "string" || !g.engine) problems.push(`${groupId}:engine_missing`);
    if (typeof g?.source !== "string" || !g.source) problems.push(`${groupId}:source_missing`);
    if (!isRecord(g?.fields) || !Object.keys(g.fields).length || !Object.values(g.fields).every((f) => typeof f === "string" && f)) problems.push(`${groupId}:fields_invalid`);
    if (g?.nullEqual === true && g?.kind !== "hud") problems.push(`${groupId}:null_equal_outside_hud`);
    if (g?.nullEqual === true && g?.requireFinite === true) problems.push(`${groupId}:null_equal_with_require_finite`);
  }
  return problems;
}

/** Pure: the group ids declared for a base engine, in declaration order. */
export function groupsFor(engine, groups = PARITY_GROUPS) {
  return Object.entries(groups || {}).filter(([, g]) => g?.engine === engine).map(([id]) => id);
}

/** Pure: the compareWithWebhooks options of a group: its fieldMap, and nullEqual only for a HUD group. */
export function groupCompareOptions(groupId, groups = PARITY_GROUPS) {
  const g = groups?.[groupId];
  if (!g) return null;
  return {
    fieldMap: { [g.source]: { ...g.fields } },
    nullEqual: g.kind === "hud" && g.nullEqual === true,
    requireFinite: g.requireFinite === true
  };
}

/**
 * The registry identity of a field group on one record: the record's engine identity (its source
 * and implementation hashes) under the engine id <group id><timeframe suffix> (probe_mizan_witness
 * on 15m: probe_mizan_witness_m15), never a Mizan dependant. Null when the record does not carry
 * the group (another engine) or has no identity.
 */
export function groupIdentityOf(record, groupId, groups = PARITY_GROUPS) {
  const g = groups?.[groupId];
  if (!g || record?.engine !== g.engine) return null;
  const id = identityOf(record);
  if (!id) return null;
  return {
    engine: groupId + id.engine.slice(String(record.engine).length),
    sourceHash: id.sourceHash, implementationHash: id.implementationHash,
    mizanSourceHash: null, mizanImplementationHash: null,
    group: groupId, parentEngine: id.engine
  };
}

// Registry engine ids are scoped by chart timeframe. H1 keeps the bare id, so the
// approved H1 prophet/gmi rows (and their streaks) are untouched; every other
// timeframe earns its own approval under a suffixed id (prophet_m5, gmi_m5, ...).
// The same source and implementation hash approved on H1 says nothing about 5m.
const TIMEFRAME_SCOPE = Object.freeze({
  "60": "", "60M": "", "1H": "", "H1": "",
  "5": "_m5", "5M": "_m5", "M5": "_m5",
  "15": "_m15", "15M": "_m15", "M15": "_m15",
  // H4 and D1 charts (owner decision 2026-11-05). Pine v6 timeframe.period is "240" and "1D".
  "240": "_h4", "4H": "_h4", "H4": "_h4",
  "1D": "_d1", "D": "_d1", "D1": "_d1"
});

/** Registry engine id for an engine on a chart timeframe, or null when the timeframe is not supported. */
export function scopedEngine(engine, timeframe) {
  if (!BASE_ENGINES.includes(engine)) return null;
  const raw = timeframe == null || String(timeframe).trim() === "" ? "60" : String(timeframe).trim().toUpperCase();
  const suffix = TIMEFRAME_SCOPE[raw];
  return suffix === undefined ? null : engine + suffix;
}

/** Extracts the registry identity of a local calculation record, or null. */
export function identityOf(record) {
  const base = record?.engine;
  const engine = scopedEngine(base, record?.timeframe);
  const sourceHash = normalizeHash(record?.provenance?.source_hash);
  const implementationHash = normalizeHash(record?.provenance?.implementation_hash);
  if (!engine || !sourceHash || !implementationHash) return null;
  const dep = record?.provenance?.dependencies?.mizan;
  return {
    engine, sourceHash, implementationHash,
    mizanSourceHash: base === "mizan" ? null : normalizeHash(dep?.source_hash),
    mizanImplementationHash: base === "mizan" ? null : normalizeHash(dep?.implementation_hash)
  };
}

function sameValue(a, b, policy) {
  if (typeof a === "number" && typeof b === "number") {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= policy.absTolerance + policy.relTolerance * Math.max(Math.abs(a), Math.abs(b));
  }
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  return false;
}

/** Sources whose webhooks must all be present before an engine can be compared. */
export function requiredSourcesFor(engine) {
  return Object.keys(PARITY_FIELDS[engine] || {});
}

/**
 * Compares one local record against TradingView webhook payloads for the same
 * candle. Returns status "match", "mismatch", "incomplete" (local side did not
 * supply a required value), or "not_comparable" (engine has no webhook map or
 * webhooks are not all present yet).
 */
/**
 * The engine internals behind a mismatch, kept in the comparison detail (2026-11-09: the GMI
 * gmi_dir mismatches on 5m conflict bars, where Pine and the local engine reset the verdict to 0
 * after gmi_dir was taken, so only gmi_dir shows that the verdict branch BEFORE the reset
 * differed). Unverified internals, for diagnosis only; never compared. Never a price: the value
 * area enters only as the close's position against it, the zones only as their flags.
 * 2026-11-09 (5m bar 08:35 UTC): the local branch was jma_long (+3) where Pine's verdict before the
 * reset was -3, so the JMA inputs (pct_rank, the kinetics) and the zone flags are kept too.
 */
const DIAGNOSTIC_KEYS = ["branch", "htf_state", "mtf_state", "ltf_state", "ext_state", "fp_status", "is_chaos", "entropy", "intrabars", "pct_rank", "s_theta", "s_omega", "s_alpha", "global_h"];
const isFiniteNum = (x) => typeof x === "number" && Number.isFinite(x);
function valueAreaPosition(close, vah, val) {
  if (![close, vah, val].every(isFiniteNum)) return null;
  return close > vah ? "above_vah" : close < val ? "below_val" : "inside";
}
function localDiagnostics(record) {
  const d = isRecord(record?.values?.diagnostics) ? record.values.diagnostics : null;
  if (!d) return {};
  const out = Object.fromEntries(DIAGNOSTIC_KEYS.filter((k) => k in d).map((k) => [k, d[k]]));
  const position = valueAreaPosition(record?.values?.candle?.c, d.vah, d.val);
  if (position) out.value_area = position;
  if (isRecord(d.zones)) {
    const flags = Object.entries(d.zones).filter(([, v]) => typeof v === "boolean");
    if (flags.length) out.zones = Object.fromEntries(flags);
  }
  return Object.keys(out).length ? { local_diagnostics: out } : {};
}

/**
 * Every compared field on both sides, not only those that differ (owner 2026-11-14: "kerjakan 1 dan 2"):
 * TradingView's verdict and gmi_dir together tell which way its verdict branch went before a conflict
 * reset it, and prophet_dir whether the Prophet side agreed. TradingView's shared_core_status is kept
 * too. Signals only: the input bar (prices) is not repeated here.
 */
function comparedValues(record, webhookPayloads, fieldMap) {
  const comparable = isRecord(record?.values?.comparable) ? record.values.comparable : {};
  const out = {};
  for (const [source, map] of Object.entries(fieldMap)) {
    // A group fieldMap ({ local field: webhook field }) names the webhook's fields by their own names.
    const fields = Array.isArray(map) ? map : Object.keys(map);
    const hookFields = Array.isArray(map) ? map : Object.values(map);
    const local = isRecord(comparable[source]) ? comparable[source] : {};
    const webhook = isRecord(webhookPayloads?.[source]) ? webhookPayloads[source] : {};
    out[source] = {
      local: Object.fromEntries(fields.filter((f) => f in local).map((f) => [f, local[f]])),
      webhook: Object.fromEntries([...hookFields, "shared_core_status"].filter((f) => f in webhook).map((f) => [f, webhook[f]]))
    };
  }
  return out;
}

/** A group fieldMap as { source: { local field: webhook field } } (an array maps each field to itself). */
function normalizeFieldMap(fieldMap) {
  const out = {};
  for (const [source, fields] of Object.entries(fieldMap)) {
    out[source] = Array.isArray(fields) ? Object.fromEntries(fields.map((f) => [f, f])) : isRecord(fields) ? { ...fields } : {};
  }
  return out;
}

/**
 * Options (B7, field groups; without them the comparison is exactly the engine's):
 *   - fieldMap: { source: [fields] | { local field: webhook field } } replaces PARITY_FIELDS[engine];
 *   - nullEqual: local null and webhook null count as equal (HUD groups only, groupCompareOptions);
 *   - requireFinite: every field must be a finite number on both sides; non-finite on both sides
 *     is incomplete (missing "null:<source>:<field>", listed in null_fields), on one side a mismatch.
 */
export function compareWithWebhooks(record, webhookPayloads, policy = DEFAULT_POLICY, options = {}) {
  const engine = record?.engine;
  const grouped = isRecord(options?.fieldMap);
  const fieldMap = grouped ? normalizeFieldMap(options.fieldMap) : PARITY_FIELDS[engine];
  const nullEqual = grouped && options.nullEqual === true;
  const requireFinite = grouped && options.requireFinite === true;
  if (!fieldMap) return { status: "not_comparable", reason: "engine_has_no_webhook_counterpart" };
  const sources = Object.keys(fieldMap);
  const absentSources = sources.filter((source) => !isRecord(webhookPayloads?.[source]));
  if (absentSources.length) return { status: "not_comparable", reason: "webhooks_not_all_present", absent_sources: absentSources };

  const comparable = isRecord(record?.values?.comparable) ? record.values.comparable : {};
  const candle = isRecord(record?.values?.candle) ? record.values.candle : {};
  const mismatches = [];
  const missing = [];
  const nullFields = [];
  let compared = 0;

  for (const source of sources) {
    const webhook = webhookPayloads[source];
    for (const field of INPUT_FIELDS) {
      if (!(field in candle)) { missing.push(`input:${field}`); continue; }
      if (!(field in webhook)) continue; // producer omitted it; nothing to verify against
      compared++;
      if (!sameValue(candle[field], webhook[field], policy)) mismatches.push({ source, field: `input:${field}`, local: candle[field], webhook: webhook[field] });
    }
    const local = isRecord(comparable[source]) ? comparable[source] : null;
    if (grouped) {
      for (const [field, hookField] of Object.entries(fieldMap[source])) {
        if (!local || !(field in local)) { missing.push(`${source}:${field}`); continue; }
        if (!(hookField in webhook)) { missing.push(`webhook:${source}:${hookField}`); continue; }
        const a = local[field], b = webhook[hookField];
        const at = hookField === field ? {} : { webhook_field: hookField };
        if (requireFinite) {
          const fa = isFiniteNum(a), fb = isFiniteNum(b);
          if (!fa && !fb) { missing.push(`null:${source}:${field}`); nullFields.push(`${source}:${field}`); continue; }
          compared++;
          if (!fa || !fb || !sameValue(a, b, policy)) mismatches.push({ source, field, ...at, local: a, webhook: b });
          continue;
        }
        compared++;
        if (nullEqual && a === null && b === null) continue;
        if (!sameValue(a, b, policy)) mismatches.push({ source, field, ...at, local: a, webhook: b });
      }
      continue;
    }
    for (const field of fieldMap[source]) {
      if (!local || !(field in local)) { missing.push(`${source}:${field}`); continue; }
      if (!(field in webhook)) { missing.push(`webhook:${source}:${field}`); continue; }
      compared++;
      if (!sameValue(local[field], webhook[field], policy)) mismatches.push({ source, field, local: local[field], webhook: webhook[field] });
    }
  }
  const uniqueMissing = [...new Set(missing)];
  // Only the input bar differs (open, high, low, close or volume) while every indicator field
  // agrees: the engine computed correctly on a bar that TradingView later finalised differently
  // (production 2026-11-06). That says nothing against the implementation, so it is recorded
  // apart and does not revoke; repeated input mismatches still do (see recordComparison).
  if (mismatches.length && mismatches.every((m) => String(m.field).startsWith("input:"))) return { status: "input_mismatch", compared, mismatches, missing: uniqueMissing };
  if (mismatches.length) return { status: "mismatch", compared, mismatches, missing: uniqueMissing, values: comparedValues(record, webhookPayloads, fieldMap), ...localDiagnostics(record) };
  // A witness group whose fields are null on both sides: an explicit incomplete state, never a match.
  if (uniqueMissing.length) return { status: "incomplete", compared, mismatches: [], missing: uniqueMissing, ...(nullFields.length ? { reason: "fields_not_finite", null_fields: nullFields } : {}) };
  return { status: "match", compared, mismatches: [], missing: [] };
}

// ---------------------------------------------------------------------------
// D1 persistence. All updates are single statements so concurrent webhook and
// local-calculation arrivals cannot lose increments; each (identity, candle) is
// counted at most once.

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS engine_parity_registry (
    engine TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    implementation_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'approved', 'revoked')),
    consecutive_matches INTEGER NOT NULL DEFAULT 0,
    total_matches INTEGER NOT NULL DEFAULT 0,
    total_mismatches INTEGER NOT NULL DEFAULT 0,
    total_incomplete INTEGER NOT NULL DEFAULT 0,
    mizan_source_hash TEXT,
    mizan_implementation_hash TEXT,
    last_candle_key TEXT,
    last_result TEXT,
    last_detail TEXT,
    first_seen_at TEXT NOT NULL,
    approved_at TEXT,
    revoked_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (engine, source_hash, implementation_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS engine_parity_comparisons (
    engine TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    implementation_hash TEXT NOT NULL,
    candle_key TEXT NOT NULL,
    result TEXT NOT NULL,
    detail TEXT,
    compared_at TEXT NOT NULL,
    PRIMARY KEY (engine, source_hash, implementation_hash, candle_key)
  )`,
  // Resource audit P0 (2026-11-14): the latest comparisons (status, parity view) and a candle's (HUD store).
  "CREATE INDEX IF NOT EXISTS idx_parity_comparisons_at ON engine_parity_comparisons(compared_at)",
  "CREATE INDEX IF NOT EXISTS idx_parity_comparisons_candle ON engine_parity_comparisons(candle_key)"
];

let schemaReady = false;
export async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}
export function resetSchemaCacheForTests() { schemaReady = false; }

export async function registerIdentity(db, id, now = new Date().toISOString()) {
  await db.prepare(
    `INSERT INTO engine_parity_registry (engine, source_hash, implementation_hash, mizan_source_hash, mizan_implementation_hash, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(engine, source_hash, implementation_hash) DO UPDATE SET
       mizan_source_hash = COALESCE(excluded.mizan_source_hash, engine_parity_registry.mizan_source_hash),
       mizan_implementation_hash = COALESCE(excluded.mizan_implementation_hash, engine_parity_registry.mizan_implementation_hash)`
  ).bind(id.engine, id.sourceHash, id.implementationHash, id.mizanSourceHash, id.mizanImplementationHash, now, now).run();
}

/** Consecutive input mismatches (on different candles) after which the identity is revoked. */
export const INPUT_MISMATCH_REVOKE_AFTER = 3;

/**
 * Records one comparison and applies the promotion/revocation rule. Returns
 * { counted: false } when this identity already has a result for the candle.
 *
 * An input mismatch (only the bar differs) is recorded but neither counts nor revokes, and it
 * stays open: when the pull adapter republishes the candle on the final bar, the new
 * comparison replaces it and counts. INPUT_MISMATCH_REVOKE_AFTER input mismatches in a row
 * (on different candles) mean the data pipeline itself is wrong, so they revoke like a mismatch.
 */
export async function recordComparison(db, id, candleKey, comparison, policy = DEFAULT_POLICY, now = new Date().toISOString()) {
  if (!["match", "mismatch", "incomplete", "input_mismatch"].includes(comparison.status)) return { counted: false, reason: comparison.status };
  let status = comparison.status;
  let escalated = false;
  if (status === "input_mismatch") {
    const previous = (await db.prepare(
      "SELECT result FROM engine_parity_comparisons WHERE engine = ? AND source_hash = ? AND implementation_hash = ? AND candle_key <> ? ORDER BY compared_at DESC LIMIT ?"
    ).bind(id.engine, id.sourceHash, id.implementationHash, candleKey, INPUT_MISMATCH_REVOKE_AFTER - 1).all())?.results || [];
    if (previous.length === INPUT_MISMATCH_REVOKE_AFTER - 1 && previous.every((r) => r.result === "input_mismatch")) { status = "mismatch"; escalated = true; }
  }
  const detail = JSON.stringify({ compared: comparison.compared, mismatches: comparison.mismatches.slice(0, 20), missing: comparison.missing.slice(0, 40), ...(escalated ? { reason: "repeated_input_mismatch" } : {}), ...(comparison.local_diagnostics ? { local_diagnostics: comparison.local_diagnostics } : {}), ...(comparison.values ? { values: comparison.values } : {}), ...(comparison.intrabars ? { intrabars: comparison.intrabars } : {}) });
  const inserted = await db.prepare(
    `INSERT INTO engine_parity_comparisons (engine, source_hash, implementation_hash, candle_key, result, detail, compared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(engine, source_hash, implementation_hash, candle_key) DO UPDATE SET
       result = excluded.result, detail = excluded.detail, compared_at = excluded.compared_at
     WHERE engine_parity_comparisons.result = 'input_mismatch'`
  ).bind(id.engine, id.sourceHash, id.implementationHash, candleKey, status, detail, now).run();
  if (!inserted?.meta?.changes) return { counted: false, reason: "already_compared" };

  const key = [id.engine, id.sourceHash, id.implementationHash];
  if (status === "input_mismatch") {
    await db.prepare(
      `UPDATE engine_parity_registry SET last_candle_key = ?, last_result = 'input_mismatch', last_detail = ?, updated_at = ?
       WHERE engine = ? AND source_hash = ? AND implementation_hash = ?`
    ).bind(candleKey, detail, now, ...key).run();
    return { counted: false, result: "input_mismatch" };
  }
  comparison = { ...comparison, status };

  if (comparison.status === "match") {
    // Placeholders in order: the promotion threshold (status), the threshold and the approval time
    // (approved_at), the threshold (revoked_at). Until 2026-11-25 the bind passed the threshold as the
    // approval time and the time as the revoked_at threshold, so every promotion stored approved_at
    // "24.0" and never cleared revoked_at (repairApprovedAt fixes the stored rows once).
    await db.prepare(
      `UPDATE engine_parity_registry SET
         consecutive_matches = consecutive_matches + 1,
         total_matches = total_matches + 1,
         status = CASE WHEN status <> 'approved' AND consecutive_matches + 1 >= ? THEN 'approved' ELSE status END,
         approved_at = CASE WHEN status <> 'approved' AND consecutive_matches + 1 >= ? THEN ? ELSE approved_at END,
         revoked_at = CASE WHEN status = 'approved' OR consecutive_matches + 1 >= ? THEN NULL ELSE revoked_at END,
         last_candle_key = ?, last_result = 'match', last_detail = ?, updated_at = ?
       WHERE engine = ? AND source_hash = ? AND implementation_hash = ?`
    ).bind(policy.promoteAfter, policy.promoteAfter, now, policy.promoteAfter, candleKey, detail, now, ...key).run();
  } else if (comparison.status === "mismatch") {
    await db.prepare(
      `UPDATE engine_parity_registry SET
         consecutive_matches = 0,
         total_mismatches = total_mismatches + 1,
         status = CASE WHEN status = 'approved' THEN 'revoked' ELSE status END,
         revoked_at = CASE WHEN status = 'approved' THEN ? ELSE revoked_at END,
         last_candle_key = ?, last_result = 'mismatch', last_detail = ?, updated_at = ?
       WHERE engine = ? AND source_hash = ? AND implementation_hash = ?`
    ).bind(now, candleKey, detail, now, ...key).run();
  } else {
    // Incomplete local output neither advances nor resets the streak.
    await db.prepare(
      `UPDATE engine_parity_registry SET total_incomplete = total_incomplete + 1,
         last_candle_key = ?, last_result = 'incomplete', last_detail = ?, updated_at = ?
       WHERE engine = ? AND source_hash = ? AND implementation_hash = ?`
    ).bind(candleKey, detail, now, ...key).run();
  }
  return { counted: true, result: comparison.status, ...(escalated ? { escalated: "repeated_input_mismatch" } : {}) };
}

/**
 * One-time reconciliation (owner approval 2026-11-06): comparisons stored as `mismatch` before the
 * input-mismatch rule, whose mismatches are all input-bar fields, are reclassified as
 * `input_mismatch`; an identity revoked only by such comparisons (no indicator mismatch since its
 * approval) is restored to approved. A revocation by an indicator mismatch, or by repeated input
 * mismatches (detail.reason "repeated_input_mismatch"), is never touched.
 * A row whose approved_at is not an ISO timestamp (the "24.0" of the old bind) has an unknown
 * approval time, so "no mismatch since its approval" cannot be decided: it is never restored.
 * Single-shot: the sweep runs it only through reclassifyOnce (parity-sweep.mjs).
 * Returns { reclassified, restored: [engine] }.
 */
export async function reclassifyInputOnlyMismatches(db, now = new Date().toISOString()) {
  const inputOnly = `result = 'mismatch'
    AND COALESCE(json_extract(detail, '$.reason'), '') <> 'repeated_input_mismatch'
    AND json_array_length(json_extract(detail, '$.mismatches')) > 0
    AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(detail, '$.mismatches')) WHERE json_extract(value, '$.field') NOT LIKE 'input:%')`;
  const counts = (await db.prepare(`SELECT engine, source_hash, implementation_hash, COUNT(*) AS n FROM engine_parity_comparisons WHERE ${inputOnly} GROUP BY engine, source_hash, implementation_hash`).all())?.results || [];
  const updated = await db.prepare(`UPDATE engine_parity_comparisons SET result = 'input_mismatch' WHERE ${inputOnly}`).run();
  for (const c of counts) {
    await db.prepare("UPDATE engine_parity_registry SET total_mismatches = MAX(total_mismatches - ?, 0), updated_at = ? WHERE engine = ? AND source_hash = ? AND implementation_hash = ?")
      .bind(Number(c.n) || 0, now, c.engine, c.source_hash, c.implementation_hash).run();
  }
  const revoked = (await db.prepare(
    `SELECT r.engine, r.source_hash, r.implementation_hash FROM engine_parity_registry r
     WHERE r.status = 'revoked' AND r.approved_at IS NOT NULL AND r.approved_at GLOB '${ISO_TIMESTAMP_GLOB}'
       AND NOT EXISTS (SELECT 1 FROM engine_parity_comparisons c WHERE c.engine = r.engine AND c.source_hash = r.source_hash
                       AND c.implementation_hash = r.implementation_hash AND c.result = 'mismatch' AND c.compared_at >= r.approved_at)`
  ).all())?.results || [];
  for (const r of revoked) {
    await db.prepare("UPDATE engine_parity_registry SET status = 'approved', revoked_at = NULL, updated_at = ? WHERE engine = ? AND source_hash = ? AND implementation_hash = ? AND status = 'revoked'")
      .bind(now, r.engine, r.source_hash, r.implementation_hash).run();
  }
  return { reclassified: Number(updated?.meta?.changes) || 0, restored: revoked.map((r) => r.engine) };
}

/** An ISO timestamp as recordComparison writes it (new Date().toISOString()): it starts "YYYY-MM-DDT". */
export const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;
/** The same test in SQL (GLOB), for the registry queries. */
const ISO_TIMESTAMP_GLOB = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*";
export const isIsoTimestamp = (value) => typeof value === "string" && ISO_TIMESTAMP.test(value);

/** Short display id of a registry identity: engine and the first 8 characters of both hashes. */
const identityLabel = (r) => `${r.engine}:${String(r.source_hash).slice(0, 8)}:${String(r.implementation_hash).slice(0, 8)}`;

/**
 * One-time repair (2026-11-25) of the approved_at written by the old recordComparison bind ("24.0").
 * For each registry row whose approved_at is set but not an ISO timestamp: the approval time is the
 * compared_at of the match that completed the streak, that is the promoteAfter-th comparison with
 * result 'match' (by compared_at) after the identity's last 'mismatch', or from its first comparison
 * when it has none. 'incomplete' and 'input_mismatch' neither advance nor reset the streak, so only
 * 'match' rows are counted. When that match exists, approved_at becomes its compared_at and, for an
 * approved row, revoked_at becomes NULL. When it does not (fewer matches after the last mismatch, as
 * for every revoked row), the row is not written and is listed in skipped.
 * Writes only approved_at and revoked_at: never status, a counter or updated_at, so isTrusted is
 * unchanged. Idempotent: a repaired row is ISO, so a second run finds it no more.
 * Returns { repaired, skipped: [identity], revoked_cleared }.
 */
export async function repairApprovedAt(db, policy = DEFAULT_POLICY) {
  const rows = (await db.prepare(
    `SELECT engine, source_hash, implementation_hash, status, approved_at, revoked_at FROM engine_parity_registry
     WHERE approved_at IS NOT NULL AND NOT (approved_at GLOB '${ISO_TIMESTAMP_GLOB}')
     ORDER BY engine, source_hash, implementation_hash`
  ).all())?.results || [];
  let repaired = 0;
  let revokedCleared = 0;
  const skipped = [];
  for (const r of rows) {
    const key = [r.engine, r.source_hash, r.implementation_hash];
    const last = await db.prepare(
      "SELECT MAX(compared_at) AS at FROM engine_parity_comparisons WHERE engine = ? AND source_hash = ? AND implementation_hash = ? AND result = 'mismatch'"
    ).bind(...key).first();
    const lastMismatch = last?.at ?? null;
    const completing = await db.prepare(
      `SELECT compared_at FROM engine_parity_comparisons
       WHERE engine = ? AND source_hash = ? AND implementation_hash = ? AND result = 'match' AND (? IS NULL OR compared_at > ?)
       ORDER BY compared_at ASC, candle_key ASC LIMIT 1 OFFSET ?`
    ).bind(...key, lastMismatch, lastMismatch, Math.max(0, policy.promoteAfter - 1)).first();
    if (!isIsoTimestamp(completing?.compared_at)) { skipped.push(identityLabel(r)); continue; }
    const clear = r.status === "approved";
    const written = await db.prepare(
      `UPDATE engine_parity_registry SET approved_at = ?, revoked_at = CASE WHEN ? THEN NULL ELSE revoked_at END
       WHERE engine = ? AND source_hash = ? AND implementation_hash = ? AND approved_at = ? AND status = ?`
    ).bind(completing.compared_at, clear ? 1 : 0, ...key, r.approved_at, r.status).run();
    if (!written?.meta?.changes) { skipped.push(identityLabel(r)); continue; }
    repaired += 1;
    if (clear && r.revoked_at != null) revokedCleared += 1;
  }
  return { repaired, skipped, revoked_cleared: revokedCleared };
}

/** True when the identity is currently trusted for the local_computation lane. */
export async function isTrusted(db, id) {
  if (id.engine === "mizan" || id.engine.startsWith("mizan_")) {
    // Mizan is trusted per timeframe: only approved Prophet AND GMI identities on
    // the same timeframe scope (for example prophet_m5 and gmi_m5) vouch for it.
    const suffix = id.engine.slice("mizan".length);
    const row = await db.prepare(
      `SELECT
         SUM(CASE WHEN engine = ? THEN 1 ELSE 0 END) AS prophet,
         SUM(CASE WHEN engine = ? THEN 1 ELSE 0 END) AS gmi
       FROM engine_parity_registry
       WHERE status = 'approved' AND mizan_source_hash = ? AND mizan_implementation_hash = ?`
    ).bind("prophet" + suffix, "gmi" + suffix, id.sourceHash, id.implementationHash).first();
    return Number(row?.prophet) > 0 && Number(row?.gmi) > 0;
  }
  const row = await db.prepare(
    "SELECT status FROM engine_parity_registry WHERE engine = ? AND source_hash = ? AND implementation_hash = ?"
  ).bind(id.engine, id.sourceHash, id.implementationHash).first();
  return row?.status === "approved";
}

export async function listRegistry(db, limit = 50) {
  const result = await db.prepare(
    `SELECT engine, source_hash, implementation_hash, status, consecutive_matches, total_matches, total_mismatches,
            total_incomplete, mizan_source_hash, mizan_implementation_hash, last_candle_key, last_result, last_detail,
            first_seen_at, approved_at, revoked_at, updated_at
     FROM engine_parity_registry ORDER BY updated_at DESC LIMIT ?`
  ).bind(Math.max(1, Math.min(200, limit))).all();
  return (result?.results || []).map((row) => ({ ...row, last_detail: (() => { try { return JSON.parse(row.last_detail); } catch { return null; } })() }));
}
