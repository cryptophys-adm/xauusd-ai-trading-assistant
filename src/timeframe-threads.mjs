// Threads per timeframe (owner decision 2026-11-05, step 4): Nexus shows the Thread of each
// timeframe as a tab in the right panel: D1, H4, H1 and 15m.
//
//   H1  is the existing Threads 1H (the H1 decision chain and its debate);
//   15m is the Live War Room 15m (src/war-room.mjs);
//   H4 and D1 are new and run here, once per closed H4 or D1 bar.
//
// An H4/D1 thread has five agents, each with one role and its own data (no redundancy):
//   structure  Prophet R38 and the R37 shared core on that chart (local records);
//   gmi        GMI v12.70 on that chart (local records);
//   technical  the price action of the last closed bars of that chart;
//   macro      Macro & Aether on that chart (DXY/USDT macro cycle and shift, kinetic spread,
//              consolidation gravity, Q-gravity, SMRI);
//   risk       volatility of that chart and what would invalidate a move.
// The moderator then writes the TLDR for the Nexus tab. Advisory only: stances are discussion
// positions, never orders, and no price level comes from here.
//
// Calibration: H4 and D1 earn parity approval only once the owner installs the TradingView
// alerts on those charts. The brief stores each indicator desk's status once; agents never
// repeat it, and an uncalibrated desk speaks at confidence <= 0.4.
//
// Runs from the parity sweep cron (at most every 15 minutes), behind TF_THREADS_ENABLED, with
// its own hourly call budget (TF_THREADS_MAX_CALLS_PER_HOUR).
import { chatMessages } from "./model-text.mjs";
import { naturalLanguageErrors } from "./natural-language.mjs";
import { BUS_DEFAULT_MODEL, BUS_MAX_TOKENS } from "./multi-agent-bus.mjs";
import { ensureThreadSchema, rowToThreadMessage, ROOM_STANCES, threadInternals } from "./agent-threads.mjs";
import { validateOpening, UNCALIBRATED_CONFIDENCE_CAP } from "./war-room.mjs";
import { closedHtfCandleKeys, OBSERVED_PREFIX } from "./parity-sweep.mjs";
import { computeMacroAether } from "../local-engines/producer/src/macro-aether.mjs";

const { runStep, writeMessage, upsertThread, callsInLastHour, RULES_NO_REFS, clip, inUnit, parseJson } = threadInternals;

export const TF_THREAD_CHARTS = Object.freeze({
  H4: { period: "240", series: "4h", label: "4-hour", engines: { prophet: "prophet_h4", gmi: "gmi_h4" } },
  D1: { period: "1D", series: "1D", label: "daily", engines: { prophet: "prophet_d1", gmi: "gmi_d1" } }
});
export const TF_AGENTS = Object.freeze({
  structure: { name: "Structure Desk", role: "Prophet R38 and the R37 shared structure core on this chart" },
  gmi: { name: "GMI Desk", role: "the GMI v12.70 verdict, gate and branch on this chart" },
  technical: { name: "Technical Analyst", role: "price action only: the last closed candles of this chart" },
  macro: { name: "Macro Desk", role: "the Macro & Aether sensors on this chart: dollar and USDT macro cycle and shift, kinetic spread, volume-profile gravity, fair-value-gap pull and the smart-money reservoir" },
  risk: { name: "Risk Manager", role: "risk only: volatility of this chart and what would invalidate a move" }
});
export const TF_OPENING_MS = 120_000;
export const TF_CONCLUSION_MS = 60_000;
const CLAIM_MAX = 320;
const SYMBOL = "OANDA:XAUUSD";

export function tfThreadsEnabled(env) {
  return String(env?.TF_THREADS_ENABLED || "").toLowerCase() === "true";
}

const OPENING_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { agent: { type: "string" }, stance: { type: "string", enum: [...ROOM_STANCES] }, confidence: { type: "number" }, claim: { type: "string" } },
  required: ["agent", "stance", "confidence", "claim"]
});
const CONCLUSION_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { stance: { type: "string", enum: [...ROOM_STANCES] }, confidence: { type: "number" }, summary: { type: "string" }, reasons: { type: "array", items: { type: "string" } } },
  required: ["stance", "confidence", "summary", "reasons"]
});

const RULES = [
  "Stances: BUY, SELL, HOLD (keep an existing position), WAIT (stay flat), CLOSE (exit an existing position). They describe the bias of this timeframe for discussion only.",
  "Never give entry, stop loss, take profit or position size. Never mention calibration, verification or comparators: readers see each desk's status once, next to its name."
].join("\n");

/** The moderator's TLDR: a stance, a short summary and one to three reasons, in plain language. */
export function validateTfConclusion(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  const errors = [];
  if (!ROOM_STANCES.includes(o.stance)) errors.push("stance_invalid");
  if (!inUnit(o.confidence)) errors.push("confidence_out_of_range");
  if (typeof o.summary !== "string" || !o.summary.trim()) errors.push("summary_missing");
  else errors.push(...naturalLanguageErrors(o.summary));
  if (Array.isArray(o.reasons)) o.reasons = o.reasons.filter(r => !(typeof r === "string" && !r.trim()));
  if (!Array.isArray(o.reasons) || o.reasons.length < 1 || o.reasons.some(r => typeof r !== "string")) errors.push("reasons_invalid");
  else for (const r of o.reasons.slice(0, 3)) errors.push(...naturalLanguageErrors(r));
  return { valid: errors.length === 0, errors };
}

const round = (x, d = 2) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

async function seriesBars(env, key) {
  try {
    const record = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:" + key)) || "null");
    return Array.isArray(record?.candles) ? record.candles : [];
  } catch { return []; }
}

async function localRecord(env, candleKey, engine) {
  for (const prefix of ["localcalc:", OBSERVED_PREFIX]) {
    try {
      const raw = await env.WEBHOOK_BUFFER?.get?.(prefix + candleKey + ":" + engine);
      if (raw) return { record: JSON.parse(raw), trusted: prefix === "localcalc:" };
    } catch { /* unreadable: try the next */ }
  }
  return null;
}

async function parityStatus(db, engine) {
  try {
    const row = await db.prepare("SELECT status, consecutive_matches FROM engine_parity_registry WHERE engine = ? ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1").bind(engine).first();
    if (row?.status === "approved") return { label: "verified by parity against TradingView", approved: true };
    return { label: `not yet calibrated against TradingView (${Number(row?.consecutive_matches) || 0} of 24 matches)`, approved: false };
  } catch { return { label: "not yet calibrated against TradingView", approved: false }; }
}

/** Evidence for one closed H4 or D1 bar; null fields stay null, never invented. */
export async function tfEvidence(env, chart, candleKey) {
  const spec = TF_THREAD_CHARTS[chart];
  const openMs = Number(candleKey.split(":").at(-1));
  const bars = (await seriesBars(env, `${SYMBOL}|${spec.series}`)).filter((b) => Date.parse(b.open_time) <= openMs);
  const last = bars.at(-1);
  if (!last || Date.parse(last.open_time) !== openMs) return null;
  const recent = bars.slice(-8).map((b) => ({ open: b.open_time, o: round(b.open), h: round(b.high), l: round(b.low), c: round(b.close) }));
  const ranges = bars.slice(-14).map((b) => b.high - b.low);
  const prophet = await localRecord(env, candleKey, "prophet");
  const gmi = await localRecord(env, candleKey, "gmi");
  let macro = null;
  try {
    const external = {};
    for (const sym of ["TVC:DXY", "CRYPTOCAP:USDT"]) external[sym] = { H4: { candles: await seriesBars(env, `${sym}|4h`) } };
    const m = computeMacroAether({ chartBars: bars.slice(-1000), external, chartKey: chart });
    if (m) { const { open_fvg_targets: _t, ...rest } = m; macro = rest; }
  } catch { macro = null; }
  const r38 = prophet?.record?.values?.comparable?.prophet_r38 || null;
  const r37 = prophet?.record?.values?.comparable?.prophet_r37_ssot || null;
  const g = gmi?.record?.values?.comparable?.gmi_v12_70 || null;
  const gd = gmi?.record?.values?.diagnostics || {};
  return {
    chart, candle_key: candleKey, bar_open: last.open_time, bar_close: last.close_time,
    technical: { recent, average_range_14: round(ranges.reduce((a, b) => a + b, 0) / Math.max(ranges.length, 1)) },
    structure: r38 || r37 ? { r38, r37 } : null,
    gmi: g ? { ...g, branch: gd.branch ?? null, htf_state: gd.htf_state ?? null, ltf_state: gd.ltf_state ?? null, footprint: gd.fp_status ?? null } : null,
    macro
  };
}

function openingMessages(agent, chart, data) {
  const spec = TF_THREAD_CHARTS[chart], desk = TF_AGENTS[agent];
  return chatMessages([
    `You are the ${desk.name} in the XAUUSD ${spec.label} Thread, which meets at every closed ${spec.label} candle. Your only role: ${desk.role}.`,
    RULES_NO_REFS,
    RULES,
    "Give one claim from your own data only. Do not repeat what the other desks cover (Structure Desk, GMI Desk, Technical Analyst, Macro Desk, Risk Manager).",
    `When your data is not yet calibrated, keep your confidence at or below ${UNCALIBRATED_CONFIDENCE_CAP}.`,
    `Required JSON: {"agent":"${agent}","stance":"BUY|SELL|HOLD|WAIT|CLOSE","confidence":0..1,"claim":"<= ${CLAIM_MAX - 40} chars"}`,
    "YOUR DATA:",
    JSON.stringify(data)
  ]);
}

function conclusionMessages(chart, bus) {
  const spec = TF_THREAD_CHARTS[chart];
  return chatMessages([
    `You are the moderator of the XAUUSD ${spec.label} Thread. Write the TLDR for the ${spec.label} tab: the bias of this timeframe in one short summary and one to three reasons.`,
    RULES_NO_REFS,
    RULES,
    "Weigh claims by their argument and evidence, not by the number of desks; a desk verified by parity outweighs an uncalibrated one (each entry states its status). Call desks by their names. No repetition.",
    'Required JSON: {"stance":"BUY|SELL|HOLD|WAIT|CLOSE","confidence":0..1,"summary":"<= 320 chars","reasons":["<= 160 chars", "at most 3"]}',
    "THE DESKS:",
    JSON.stringify(bus)
  ]);
}

/** Runs the thread of one closed H4 or D1 bar; idempotent per bar. */
export async function runTimeframeThread(env, { chart, candleKey }, { clock = () => Date.now() } = {}) {
  const spec = TF_THREAD_CHARTS[chart];
  if (!spec) return { status: "unsupported_chart" };
  const db = env.DB;
  await ensureThreadSchema(db);
  const evidence = await tfEvidence(env, chart, candleKey);
  if (!evidence) return { status: "no_bar" };
  if (!evidence.structure && !evidence.gmi) return { status: "no_local_records" };
  const runId = evidence.bar_open;
  const threadId = `tf:${chart}`;
  await upsertThread(db, { id: threadId, kind: "tf", refKey: chart, title: `Thread ${chart} · XAUUSD ${spec.label}`, post: null, now: clock() });
  const existing = new Map(((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ?").bind(threadId, runId).all()).results || []).map(r => [r.step, rowToThreadMessage(r)]));
  if (existing.get("conclusion")?.status === "ok") return { status: "already_complete", calls: 0 };

  const [pStatus, gStatus] = await Promise.all([parityStatus(db, spec.engines.prophet), parityStatus(db, spec.engines.gmi)]);
  const roster = Object.keys(TF_AGENTS).filter(id => (id === "structure" ? evidence.structure : id === "gmi" ? evidence.gmi : id === "macro" ? evidence.macro : true));
  const status = { structure: pStatus, gmi: gStatus, technical: { label: "closed TradingView bars" }, macro: { label: "not yet calibrated against TradingView" }, risk: { label: "closed TradingView bars" } };
  const base = (step, agent) => ({ thread_id: threadId, run_id: runId, step, agent, parent_id: null, bar_time: evidence.bar_close });
  if (!existing.has("brief")) {
    await writeMessage(db, { ...base("brief", "system"), ts: new Date(clock()).toISOString(), status: "info", body: { chart, candle_key: candleKey, roster, calibration: Object.fromEntries(roster.map(id => [id, { label: status[id].label }])), bar: evidence.technical.recent.at(-1) } });
  }

  const tfEnv = { ...env, MULTI_AGENT_FALLBACK_MODEL: env.MULTI_AGENT_MODEL || BUS_DEFAULT_MODEL };
  const maxPerHour = Number(env.TF_THREADS_MAX_CALLS_PER_HOUR ?? 24);
  let remaining = 0;
  try { remaining = (Number.isFinite(maxPerHour) ? maxPerHour : 0) - (await callsInLastHour(db, clock(), "tf")); } catch { remaining = 0; }
  let calls = 0;
  const phase = (ms) => {
    const deadline = clock() + ms;
    const runState = { primaryError: null };
    const budgetOk = async () => clock() < deadline && remaining-- > 0;
    return (stepBase, opts) => { calls += 1; return runStep(tfEnv, db, stepBase, { ...opts, deadline, clock, runState, budgetOk }); };
  };
  const dataFor = (id) => ({
    structure: { status: status.structure.label, ...evidence.structure },
    gmi: { status: status.gmi.label, ...evidence.gmi },
    technical: evidence.technical,
    macro: { status: status.macro.label, ...evidence.macro },
    risk: { average_range_14: evidence.technical.average_range_14, recent: evidence.technical.recent.slice(-4), structure: evidence.structure?.r38 ?? null }
  })[id];
  const uncalibrated = (id) => (id === "structure" && !pStatus.approved) || (id === "gmi" && !gStatus.approved) || id === "macro";

  const open = phase(TF_OPENING_MS);
  const openings = await Promise.all(roster.map(agent => {
    const prior = existing.get("open:" + agent);
    if (prior?.status === "ok") return prior;
    return open(base("open:" + agent, agent), {
      messages: openingMessages(agent, chart, dataFor(agent)), schemaName: "tf_thread_opening", schema: OPENING_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low", validate: (o) => validateOpening(o, agent, { verifiedLines: uncalibrated(agent) ? 0 : null }),
      toBody: (o) => ({ body: { claim: clip(o.claim, CLAIM_MAX), name: TF_AGENTS[agent].name }, refs: [] })
    });
  }));
  const answered = openings.filter(m => m?.status === "ok");
  if (!answered.length) return { status: "no_openings", calls };
  const bus = answered.map(m => ({ id: m.agent, name: TF_AGENTS[m.agent]?.name ?? m.agent, status: status[m.agent]?.label ?? null, stance: m.stance, confidence: m.confidence, claim: m.claim }));
  const conclude = phase(TF_CONCLUSION_MS);
  await conclude(base("conclusion", "moderator"), {
    messages: conclusionMessages(chart, bus), schemaName: "tf_thread_conclusion", schema: CONCLUSION_SCHEMA,
    maxTokens: BUS_MAX_TOKENS.moderator, effort: "low", validate: validateTfConclusion,
    toBody: (o) => ({ body: { summary: clip(o.summary, 400), reasons: o.reasons.slice(0, 3).map(r => clip(r, 200)) }, refs: [] })
  });
  return { status: "complete", calls, openings: answered.length };
}

/** Runs the thread of the latest closed H4 and D1 bar when its local records are in. */
export async function runPendingTimeframeThreads(env, { now = Date.now(), clock = () => Date.now() } = {}) {
  if (!tfThreadsEnabled(env)) return { status: "disabled" };
  const keys = await closedHtfCandleKeys(env, now, { lookback: 1 });
  const out = {};
  for (const key of keys) {
    const chart = key.split(":")[2] === "240" ? "H4" : "D1";
    try { out[chart] = await runTimeframeThread(env, { chart, candleKey: key }, { clock }); }
    catch (error) { out[chart] = { status: "error", error: error instanceof Error ? error.name : "UnknownError" }; }
  }
  return { status: "ok", charts: out };
}

/** The latest H4 or D1 thread for its Nexus tab. */
export async function readTimeframeThread(db, chart) {
  if (!TF_THREAD_CHARTS[chart]) return null;
  await ensureThreadSchema(db);
  const threadId = `tf:${chart}`;
  const run = (await db.prepare("SELECT MAX(run_id) AS r FROM agent_thread_messages WHERE thread_id = ?").bind(threadId).first())?.r;
  if (!run) return null;
  const rows = ((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? ORDER BY id").bind(threadId, run).all()).results || []).map(rowToThreadMessage);
  const brief = rows.find(m => m.step === "brief");
  const order = new Map((brief?.roster || []).map((id, i) => [id, i]));
  const posts = rows.filter(m => m.step.startsWith("open:")).sort((a, b) => (order.get(a.agent) ?? 99) - (order.get(b.agent) ?? 99))
    .map(m => ({ id: m.agent, name: TF_AGENTS[m.agent]?.name ?? m.agent, status: m.status, stance: m.stance, confidence: m.confidence, claim: m.claim ?? null, calibration: brief?.calibration?.[m.agent]?.label ?? null }));
  const c = rows.find(m => m.step === "conclusion");
  return {
    tf: chart, bar_open: run, bar_close: brief?.bar_time ?? rows[0]?.bar_time ?? null, candle_key: brief?.candle_key ?? null,
    conclusion: c ? { status: c.status, stance: c.stance, confidence: c.confidence, summary: c.summary ?? null, reasons: c.reasons ?? [] } : null,
    posts
  };
}
