// The public projection, content roadmap P1 (docs/RFC_CONTENT_AGENT.md §2.1; owner 2026-11-14: "lanjutkan
// semua"). A read-only view of past Decision Engine decisions that a future content agent may read, and the
// only one: no account data, no Omega state, no entry, stop, target, plan, zone, lot or price level, and only
// decisions older than the delay (PUBLIC_DELAY_HOURS). Realtime since 2026-11-25 (owner: "harus realtime", then
// "Semua sekarang"): production sets the delay to 0, so the newest 15m decision is public at once, its side,
// confidence and reasons included, while a position on it may still be running; never a price, entry, stop or
// target (PUBLIC_FORBIDDEN_KEYS, recapLeaks). Unset, null, empty or invalid keeps the default, 24 hours. The
// GET /api/public-projection route is behind the same Cloudflare Access as the rest of /api.
//
// What a recap holds: the bar's time and session, the stance and bias, the quorum's shares, the chart patterns
// by name and status (never their bounds or targets), the reasons and risks in plain words with every sentence
// that names a price or order wording removed, the guardrail checks that held a side back, and the outcome on
// the 15m bars once the horizon has closed. src/content-guardian.mjs checks every draft made from it.
import { SCORING_VERSION, scoreStance } from "./outcome-scoring.mjs";

export const PUBLIC_PROJECTION_VERSION = "cryptophys.public-projection.v1";
export const DEFAULT_PUBLIC_DELAY_HOURS = 24;
const SERIES_15M = "market-data:v2:series:OANDA:XAUUSD|15m";
/** Keys a recap may never carry, at any depth. */
export const PUBLIC_FORBIDDEN_KEYS = Object.freeze([
  "entry", "entry_price", "entry_zone", "entry_low", "entry_high", "entry_zone_low", "entry_zone_high", "stop", "stop_loss", "sl", "take_profit", "tp", "tp1", "tp2", "target", "targets", "trade", "trade_plan",
  "plan", "plans", "strategy_plans", "key_levels", "zones", "levels", "upper", "lower", "close", "price", "atr", "lots", "lot", "size",
  "position_size_pct", "balance", "equity", "margin", "account", "positions", "omega", "worker_version", "decision_json"
]);
/** A number that reads like a gold price (3 to 5 digits, or 1–2 digits, a comma and 3 digits). */
export const PRICE_LIKE = /\$?\b(?:\d{1,2},\d{3}|\d{3,5})(?:\.\d+)?\b/;
/** Order and plan wording: a recap is a commentary, never an instruction. */
export const ORDER_WORDING = /\b(entry|entries|enter|stop[- ]?loss|stop|take[- ]?profit|target|targets|limit order|market order|order|buy now|sell now|lot|lots|position size|reward[- ]to[- ]risk|risk[- ]to[- ]reward|r:r|rrr|plan)\b/i;

/** The public delay in hours: PUBLIC_DELAY_HOURS, 0 (realtime) to 14 days; unset, null, empty or invalid: 24. */
export function publicDelayHours(env) {
  const raw = env?.PUBLIC_DELAY_HOURS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_PUBLIC_DELAY_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 24 * 14) : DEFAULT_PUBLIC_DELAY_HOURS;
}

const parse = (v, d) => { if (v && typeof v === "object") return v; try { return JSON.parse(v); } catch { return d; } };
const round2 = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Pure: the sentences of a text that name no price and use no order wording. */
export function publicSentences(text, { max = 3, len = 240 } = {}) {
  const parts = (Array.isArray(text) ? text : [text]).flatMap((t) => String(t ?? "").split(/(?<=[.!?])\s+/));
  return parts.map((s) => clip(s, len)).filter((s) => s && !PRICE_LIKE.test(s) && !ORDER_WORDING.test(s)).slice(0, max);
}

/** Trading session of a bar close (UTC hours). */
export function sessionOfClose(iso) {
  const h = new Date(iso).getUTCHours();
  return h < 7 ? "asia" : h < 13 ? "london" : h < 21 ? "new_york" : "late";
}

/** Checks a recap never names (Z2's zone_ahead reads the plan's zones: publicRecap stays as it was before it). */
// B18 (errata E4): room_liquidity, lens B's own block, never reaches public output; its WAIT does, as any WAIT.
const HELD_BACK_HIDDEN = Object.freeze(["zone_ahead", "room_liquidity"]);
/** Pure: the guardrail checks that failed on one side, by name only. */
function heldBack(guardrails, side) {
  const g = guardrails?.[side];
  const checks = Array.isArray(g?.checks) ? g.checks : [];
  return checks.filter((c) => c && c.pass === false && typeof c.id === "string" && !HELD_BACK_HIDDEN.includes(c.id)).map((c) => c.id).slice(0, 8);
}

/** Pure: one decision row (engine_decisions with decision_json) as a public recap. */
export function publicRecap(row, { outcome = null } = {}) {
  const d = parse(row?.decision_json, {}) || {};
  const quorum = d.quorum && typeof d.quorum === "object" ? d.quorum : null;
  const patterns = (Array.isArray(d.chart_patterns) ? d.chart_patterns : [])
    .filter((p) => p && typeof p.id === "string" && ["confirmed", "forming"].includes(p.status))
    .map((p) => ({ timeframe: String(p.tf ?? ""), pattern: p.id, status: p.status }))
    .slice(0, 6);
  const barClose = row?.bar_close ?? d.bar_close ?? null;
  return {
    bar_close: barClose,
    session: barClose ? sessionOfClose(barClose) : null,
    timeframe: "15m",
    stance: ["BUY", "SELL", "WAIT"].includes(row?.stance ?? d.stance) ? (row?.stance ?? d.stance) : null,
    bias: ["BULLISH", "BEARISH", "NEUTRAL"].includes(d.bias) ? d.bias : null,
    confidence: round2(row?.confidence ?? d.confidence),
    quorum: quorum ? { bias: quorum.bias ?? null, long_share: round2(quorum.long_share), short_share: round2(quorum.short_share), witnesses: Number.isFinite(Number(quorum.witnesses)) ? Number(quorum.witnesses) : null } : null,
    patterns,
    reasons: publicSentences(parse(d.reasons, d.reasons) ?? []),
    risks: publicSentences(parse(d.risks, d.risks) ?? []),
    held_back: { long: heldBack(d.guardrails, "long"), short: heldBack(d.guardrails, "short") },
    outcome
  };
}

/** Pure: the keys and strings of a value that would leak a level or private data (empty when clean). */
export function recapLeaks(value, path = "") {
  const out = [];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...recapLeaks(v, `${path}[${i}]`)));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (PUBLIC_FORBIDDEN_KEYS.includes(k.toLowerCase())) out.push(`${path}.${k}: forbidden key`);
      out.push(...recapLeaks(v, `${path}.${k}`));
    }
  } else if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    if (PRICE_LIKE.test(value)) out.push(`${path}: price-like number`);
    if (ORDER_WORDING.test(value)) out.push(`${path}: order wording`);
  }
  return out;
}

/** GET /api/public-projection: the recaps of decisions older than the delay, newest first. Read-only. */
/**
 * RC1 (orchestrator 2026-11-26, from the CTA session): the PublicProjection.recaps RPC's row limit. It passed only `days`,
 * so readPublicProjection's default LIMIT 50 applied; with PUBLIC_DELAY_HOURS 0 (RT1, #590) the 50 newest 15m decisions
 * cover about 12.5 hours, and the CTA recap window found none. Pure: the caller's `limit` when given, else one row per
 * 15m bar over the window, both ends included (days x 96 + 1), within 1..200. The dashboard's /api/public-projection keeps its default.
 */
export const RECAPS_MAX_LIMIT = 200;
export function recapsLimit({ days = 2, limit = undefined } = {}) {
  const asked = Number(limit);
  const n = Number.isFinite(asked) && asked > 0 ? asked : Math.min(14, Math.max(1, Math.round(Number(days) || 2))) * 96 + 1;
  return Math.min(RECAPS_MAX_LIMIT, Math.max(1, Math.round(n)));
}

export async function readPublicProjection(env, { days = 7, limit = 50, now = Date.now() } = {}) {
  const delay = publicDelayHours(env);
  const until = new Date(now - delay * 3_600_000).toISOString();
  const n = Math.min(14, Math.max(1, Math.round(Number(days) || 7)));
  const since = new Date(now - delay * 3_600_000 - n * 86_400_000).toISOString();
  const rows = (await env.DB.prepare("SELECT bar_close, stance, confidence, decision_json FROM engine_decisions WHERE bar_close >= ? AND bar_close <= ? ORDER BY bar_close DESC LIMIT ?")
    .bind(since, until, Math.min(200, Math.max(1, Math.round(Number(limit) || 50)))).all())?.results || [];
  let bars = [];
  try {
    const record = JSON.parse((await env.SIGNAL_CACHE?.get?.(SERIES_15M)) || "null");
    bars = (Array.isArray(record?.candles) ? record.candles : []).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.close_time && Date.parse(c.close_time) <= now).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
  } catch { bars = []; }
  const recaps = rows.map((r) => {
    const s = scoreStance({ stance: r.stance, bars, closeMs: Date.parse(r.bar_close) });
    return publicRecap(r, { outcome: s.result ?? null });
  });
  // A recap that would still leak is dropped, never shown (the test walks every key and string).
  const clean = recaps.filter((r) => !recapLeaks(r).length);
  return {
    version: PUBLIC_PROJECTION_VERSION, delay_hours: delay, until, scoring_version: SCORING_VERSION,
    capacity: "education", dropped: recaps.length - clean.length, recaps: clean
  };
}
