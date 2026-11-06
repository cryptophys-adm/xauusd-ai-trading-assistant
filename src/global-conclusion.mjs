// Global Conclusion (owner decision 2026-11-06): one multi-timeframe summary of the D1, 4H, 1H
// and 15m War Rooms and News Daily, for the right panel of Nexus.
//
// Deterministic: no model call. Each room contributes its lean (the confidence-weighted mean
// direction of its agents' biases), weighted D1 30, 4H 25, 1H 20, 15m 15 and News 10; a missing room
// drops out and the rest renormalise. The action is the strategy engine's decision (owner decision
// 2026-11-06: the consensus of all agents decides, src/strategy-engine.mjs). Without a strategy it
// falls back to the H1 decision, which stands only when the global bias does not lean against it.
// Advisory only: no levels, sizes or orders are produced here.
import { roomLean, loadStrategyInputs, buildStrategy } from "./strategy-engine.mjs";

export { roomLean };

export const GLOBAL_CONCLUSION_VERSION = "cryptophys.global-conclusion.v1";
export const GLOBAL_WEIGHTS = Object.freeze({ D1: 0.3, H4: 0.25, H1: 0.2, M15: 0.15, NEWS: 0.1 });
const NEUTRAL_BAND = 0.1;
const SPEC = {
  D1: { label: "D1", role: "macro trend", periodMs: 86_400_000 },
  H4: { label: "4H", role: "intraday trend", periodMs: 14_400_000 },
  H1: { label: "1H", role: "swing trend", periodMs: 3_600_000 },
  M15: { label: "15m", role: "structure", periodMs: 900_000 },
  NEWS: { label: "News", role: "fundamentals", periodMs: 3_600_000 }
};

const direction = (s) => (s === "BUY" || s === "BULLISH" ? 1 : s === "SELL" || s === "BEARISH" ? -1 : 0);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const side = (v) => (v == null || Math.abs(v) < NEUTRAL_BAND ? "NEUTRAL" : v > 0 ? "BULLISH" : "BEARISH");
const word = (v) => {
  if (v == null) return "no data";
  const a = Math.abs(v), s = v > 0 ? "bullish" : "bearish";
  return a < NEUTRAL_BAND ? "neutral" : a < 0.3 ? `slightly ${s}` : a < 0.6 ? s : `strongly ${s}`;
};

function newsLean(news) {
  const c = news?.counts ?? {};
  const b = Number(c.bullish) || 0, s = Number(c.bearish) || 0, n = Number(c.neutral) || 0;
  return b + s + n ? r2((b - s) / (b + s + n)) : null;
}

/** Pure: the Global Conclusion from the latest rooms, News Daily and the H1 decision. */
export function buildGlobalConclusion({ d1 = null, h4 = null, h1 = null, m15 = null, news = null, h1Decision = null, strategy = null, now = Date.now() } = {}) {
  const rooms = { D1: d1, H4: h4, H1: h1, M15: m15 };
  const timeframes = Object.entries(rooms).map(([key, room]) => {
    const at = room?.bar_close ?? room?.bar_time ?? null;
    const c = room?.conclusion?.status === "ok" ? room.conclusion : null;
    const lean = room ? roomLean(room.openings) : null;
    return {
      key, label: SPEC[key].label, role: SPEC[key].role, available: Boolean(room && (c || lean != null)), lean, side: side(lean),
      action: c?.stance ?? null, confidence: c?.confidence ?? null, summary: c?.summary ?? null, at,
      stale: Boolean(at && now - Date.parse(at) > 2 * SPEC[key].periodMs)
    };
  });
  const nl = newsLean(news);
  const t = news?.tldr?.status === "ok" ? news.tldr : null;
  timeframes.push({
    key: "NEWS", label: "News", role: SPEC.NEWS.role, available: Boolean(t || nl != null), lean: nl, side: side(nl),
    action: t?.stance ?? null, confidence: t?.confidence ?? null, summary: t?.summary ?? null, at: news?.run_at ?? null,
    stale: Boolean(news?.run_at && now - Date.parse(news.run_at) > 3 * SPEC.NEWS.periodMs)
  });

  let s = 0, w = 0;
  for (const tf of timeframes) if (isNum(tf.lean)) { s += tf.lean * GLOBAL_WEIGHTS[tf.key]; w += GLOBAL_WEIGHTS[tf.key]; }
  const score = w ? r2(s / w) : null;
  const bias = side(score);
  const leaning = timeframes.filter((tf) => isNum(tf.lean));
  const withBias = bias === "NEUTRAL" ? leaning.filter((tf) => tf.side === "NEUTRAL").length : leaning.filter((tf) => tf.side === bias).length;

  const decision = h1Decision?.decision ?? null;
  const dir = direction(decision);
  let action = decision && ["BUY", "SELL", "WAIT", "HOLD", "CLOSE"].includes(decision) ? decision : "WAIT";
  let actionReason = decision ? `The H1 decision is ${decision}.` : "No H1 decision is available, so the action is WAIT.";
  if (dir && isNum(score) && score * dir < -NEUTRAL_BAND) {
    action = "WAIT";
    actionReason = `The timeframes lean ${word(score)}, against the H1 ${decision}, so the global action is WAIT.`;
  }
  // Owner decision 2026-11-06: the decision is the consensus of all agents, so the strategy
  // engine's decision is the global action when it is available; the H1 chain stays for reference.
  if (strategy?.decision) {
    action = strategy.decision;
    actionReason = `Strategy engine: ${strategy.headline}`;
  }

  const parts = timeframes.filter((tf) => tf.available).map((tf) => `${tf.label} ${word(tf.lean)}`);
  const summary = !parts.length
    ? "No timeframe has concluded yet; the global action is WAIT."
    : `Global bias ${word(score)}${isNum(score) ? ` (${score >= 0 ? "+" : ""}${Math.round(score * 100)})` : ""}, ${bias === "NEUTRAL" ? "the timeframes are split" : `${withBias} of ${leaning.length} agreeing`}: ${parts.join(", ")}. ${actionReason}`;

  return {
    version: GLOBAL_CONCLUSION_VERSION,
    bias, score, action, action_reason: actionReason,
    alignment: { with_bias: withBias, of: leaning.length },
    h1_decision: decision ? { decision, confidence: h1Decision?.confidence ?? null, candle_key: h1Decision?.candle_key ?? null } : null,
    timeframes, summary, weights: GLOBAL_WEIGHTS,
    // Owner decision 2026-11-06: the Global Conclusion and the strategy engine are one "Global
    // decision" in Nexus, so the full strategy (layers, plan, RRR, vetoes) travels here.
    strategy: strategy ?? null
  };
}

/** Reads the latest rooms, News Daily and the strategy inputs, and builds the Global Conclusion. */
export async function readGlobalConclusion(env, { now = Date.now() } = {}) {
  const inputs = await loadStrategyInputs(env, { now });
  const { D1: d1, H4: h4, H1: h1, M15: m15 } = inputs.rooms;
  let strategy = null;
  try { strategy = buildStrategy(inputs); } catch { strategy = null; }
  return buildGlobalConclusion({ d1, h4, h1, m15, news: inputs.news, h1Decision: inputs.h1Chain, strategy, now });
}
