// CH1, change thresholds for the confidence, share and stance triggers (owner 2026-11-23, relayed by the orchestrator:
// "supaya tidak terlalu dini, perubahan confluence dan confidence perlu threshold atau ambang perubahan"; the option
// chosen: "Live semua (Rekomendasi)"). A change of the agents' confidence, the quorum's share or the decision's stance
// acts only when it is large enough, and for the slower modes only when it holds on two consecutive closed 15m
// decisions. Pure; imports only the confidence helpers.
//
// The switch is the Omega setting `change_thresholds`, a token list (default all on, "off" for none):
//   conf    confidenceTrend needs a change of at least CONFIDENCE_CHANGE_MIN (0.05) in every mode, for the Position
//           Manager (cut_loss's confidence reason, A8's confidence_drop and confidence_rising), Omega's confidence_drop
//           close and its extend gate (where "unknown" reads as the last known state), and the limit council's
//           confidence reasons;
//   tpw     take_profit_weakening needs a measured reason (measuredFall), else the rules below it run;
//   limit   a resting limit's cancel_share_drop per mode, confirmed on 2 decisions outside scalp (pendingShareFall);
//   skip    an entry council's skip needs a measured skip reason that holds, under "limit" as under "council", with
//           measuredFall's thresholds for confidence_drop and quorum_share_drop;
//   stance  a reason "the decision is <the other side>" (cut_loss, the pending council's move and cancel) needs that
//           stance on 2 consecutive closed decisions.
// Each token off is today's rule for its trigger, byte for byte. lean_flip and powerBand are unchanged (owner).
//
// Persistence is counted in closed 15m decisions, never in 5-minute runs: the history (decisionHistory) is the
// decision rows before the latest one, so every run on the same decision reads the same history.
import { confidenceTrend, CONFIDENCE_CHANGE_MIN } from "./agent-confidence.mjs";

export { CONFIDENCE_CHANGE_MIN };
export const CHANGE_TOKENS = Object.freeze(["conf", "tpw", "limit", "skip", "stance"]);
/** The setting's default: every token on (the owner: "Live semua"). */
export const CHANGE_THRESHOLDS_ALL = CHANGE_TOKENS.join(",");
/** The setting with every token off: today's rules. */
export const CHANGE_THRESHOLDS_OFF = "off";
/** The least fall of the quorum's share on the side, per mode (scalp, intraday and range 0.10; swing 0.15). */
export const SHARE_FALL_MIN = Object.freeze({ scalp: 0.1, intraday: 0.1, range: 0.1, swing: 0.15 });
/** How many consecutive closed 15m decisions the change must hold on, per mode. */
export const CONFIRM_DECISIONS = Object.freeze({ scalp: 1, intraday: 2, range: 2, swing: 2 });
const MODES = Object.freeze(["scalp", "intraday", "swing", "range"]);
const M15 = 15 * 60_000;
const EPS = 1e-9;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const share100 = (v) => Math.round(v * 100);

/** Pure: the setting's canonical value ("conf,tpw,..." in CHANGE_TOKENS order, or "off"), or null when unreadable. */
export function normalizeChangeThresholds(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (s === "" || s === "off" || s === "none") return CHANGE_THRESHOLDS_OFF;
  if (s === "on" || s === "all") return CHANGE_THRESHOLDS_ALL;
  const parts = s.split(/[\s,]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => !CHANGE_TOKENS.includes(p))) return null;
  const on = new Set(parts);
  return CHANGE_TOKENS.filter((t) => on.has(t)).join(",");
}

/**
 * Pure: the tokens on in Omega's settings (a frozen array in CHANGE_TOKENS order). A setting never stored (settings
 * from before CH1) is the default, every token on; a value that cannot be read is the default too.
 */
export function changeTokens(settings) {
  const raw = settings && typeof settings === "object" ? settings.change_thresholds : undefined;
  const v = raw === undefined || raw === null ? CHANGE_THRESHOLDS_ALL : normalizeChangeThresholds(raw) ?? CHANGE_THRESHOLDS_ALL;
  return Object.freeze(v === CHANGE_THRESHOLDS_OFF ? [] : v.split(","));
}
/** Pure: whether a token is on in a token list (null or absent: none is). */
export const changeOn = (changes, token) => Array.isArray(changes) && changes.includes(token);

/** Pure: a mode's thresholds: { mode, share_fall, confirm, conf_drop } (conf_drop null for swing: the share only). */
export function changeRule(mode) {
  const m = MODES.includes(mode) ? mode : "intraday";
  return { mode: m, share_fall: SHARE_FALL_MIN[m], confirm: CONFIRM_DECISIONS[m], conf_drop: m === "swing" ? null : CONFIDENCE_CHANGE_MIN };
}

/** Pure: the confidence trend with the `conf` token on (CONFIDENCE_CHANGE_MIN) or off (today's band). */
export function trendFor(now, prev, changes) {
  return changeOn(changes, "conf") ? confidenceTrend(now, prev, { min: CONFIDENCE_CHANGE_MIN }) : confidenceTrend(now, prev);
}

const closeMsOf = (d) => (isNum(d?.close_ms) ? d.close_ms : Date.parse(String(d?.bar_close ?? "")));
const shareOf = (q, side) => { const v = q?.[side === "BUY" ? "long_share" : "short_share"]; return isNum(v) ? v : null; };

/**
 * Pure: what the change thresholds read of the decisions before `d` (the latest closed one): `r1` the decision row
 * just before it, `r2` the one before that (rows as stored, newest first). The same rows give the same history live
 * (the Position Manager, the limit council and the signal read them from engine_decisions) and in v4 (its decision
 * rows), so persistence is counted per closed 15m decision.
 *   prev   r1 when it closed exactly 15 minutes before d: { close_ms, stance, long_share, short_share };
 *   prev2  r2 when prev is there and r2 closed 15 minutes before it: { close_ms, long_share, short_share };
 *   last   r1 whatever its age: its own agent confidences and the ones before them (the last known trend), and,
 *          with prev there, r1's agent_confidence_prev is the confidence of the decision two closes back.
 */
export function decisionHistory(d, r1 = null, r2 = null) {
  const c0 = closeMsOf(d), c1 = closeMsOf(r1), c2 = closeMsOf(r2);
  const prev = r1 && isNum(c0) && c0 - c1 === M15 ? { close_ms: c1, stance: typeof r1.stance === "string" ? r1.stance : null, long_share: shareOf(r1.quorum, "BUY"), short_share: shareOf(r1.quorum, "SELL") } : null;
  const prev2 = prev && r2 && c1 - c2 === M15 ? { close_ms: c2, long_share: shareOf(r2.quorum, "BUY"), short_share: shareOf(r2.quorum, "SELL") } : null;
  const last = r1 && isNum(c1) ? { close_ms: c1, agent_confidence: r1.agent_confidence ?? null, agent_confidence_prev: r1.agent_confidence_prev ?? null } : null;
  return { prev, prev2, last };
}

/**
 * Pure: the readings of one side the measured reasons need, from a decision carrying `decision_history`:
 * { share, share_prev, share_prev2, conf, conf_prev, conf_prev2, stance_prev }. `conf_prev` is the decision's own
 * agent_confidence_prev (the bar before, as today); conf_prev2 is the bar before that.
 */
export function sideReadings(decision, side, agent) {
  const k = side === "BUY" ? "long" : "short";
  const h = decision?.decision_history ?? null;
  const num = (v) => (isNum(v) ? v : null);
  return {
    share: shareOf(decision?.quorum, side), share_prev: shareOf(decision?.quorum_prev, side) ?? (h?.prev ? shareOf(h.prev, side) : null), share_prev2: h?.prev2 ? shareOf(h.prev2, side) : null,
    conf: num(decision?.agent_confidence?.[agent]?.[k]), conf_prev: num(decision?.agent_confidence_prev?.[agent]?.[k]), conf_prev2: h?.prev ? num(h.last?.agent_confidence_prev?.[agent]?.[k]) : null,
    stance_prev: h?.prev?.stance ?? null
  };
}

/**
 * Pure: the measured fall behind a weakening (take_profit_weakening) or a skip, by the mode's rule (changeRule):
 *   scalp            the share on the side fell at least 0.10 since the decision before, OR the agent's confidence
 *                    dropped at least 0.05 since it;
 *   intraday, range  the same, confirmed on 2 consecutive closed decisions: both the decision before and this one
 *                    are at least that far under the level before the drop (the decision two closes back);
 *   swing            the share fell at least 0.15, confirmed on 2 decisions (no confidence reason).
 * Returns { share: text | null, conf: text | null, text: the reasons joined, or null when none holds }.
 */
export function measuredFall({ mode, side, agent = "zone_pullback", share, share_prev, share_prev2, conf, conf_prev, conf_prev2 }) {
  const rule = changeRule(mode);
  const two = rule.confirm >= 2;
  const fell = (now, before, t) => isNum(now) && isNum(before) && before - now >= t - EPS;
  const sideWord = side === "BUY" ? "bullish" : "bearish";
  let shareText = null, confText = null;
  if (two ? fell(share_prev, share_prev2, rule.share_fall) && fell(share, share_prev2, rule.share_fall) : fell(share, share_prev, rule.share_fall)) {
    shareText = two
      ? `the quorum's ${sideWord} share fell from ${share100(share_prev2)}% to ${share100(share_prev)}% and ${share100(share)}% on 2 decisions (at least ${share100(rule.share_fall)} points, ${rule.mode})`
      : `the quorum's ${sideWord} share fell ${share100(share_prev)}% to ${share100(share)}% (at least ${share100(rule.share_fall)} points, ${rule.mode})`;
  }
  if (rule.conf_drop != null && (two ? fell(conf_prev, conf_prev2, rule.conf_drop) && fell(conf, conf_prev2, rule.conf_drop) : fell(conf, conf_prev, rule.conf_drop))) {
    confText = two
      ? `the ${agent} confidence dropped from ${conf_prev2} to ${conf_prev} and ${conf} on 2 decisions (at least ${rule.conf_drop}, ${rule.mode})`
      : `the ${agent} confidence dropped ${conf_prev} to ${conf} (at least ${rule.conf_drop}, ${rule.mode})`;
  }
  const parts = [shareText, confText].filter(Boolean);
  return { share: shareText, conf: confText, text: parts.length ? parts.join("; ") : null };
}

/** Pure: the decision's stance against `side` on this decision and the one before it (2 consecutive closed decisions). */
export function stanceAgainstConfirmed(side, stance, stancePrev) {
  const other = side === "BUY" ? "SELL" : side === "SELL" ? "BUY" : null;
  return other != null && stance === other && stancePrev === other;
}

/**
 * Pure: the `limit` token's cancel of a resting limit on its side's quorum share (cancel_share_drop): the share fell at
 * least `threshold` below the placing decision's (`share0`) on the current decision, and, outside scalp, on the decision
 * before it too, that one closed after the placing decision and 15 minutes before the current one.
 */
export function pendingShareFall({ mode, threshold, share0, share, sharePrev = null, prevMs = null, currentMs = null, placedDecisionMs = null }) {
  const fell = (x) => isNum(x) && x >= 0 && isNum(share0) && share0 >= 0 && share0 - x >= threshold - EPS;
  if (!fell(share)) return false;
  if (changeRule(mode).confirm < 2) return true;
  return isNum(prevMs) && isNum(currentMs) && currentMs - prevMs === M15 && isNum(placedDecisionMs) && prevMs > placedDecisionMs && fell(sharePrev);
}

/** The words a held-back close carries in its `why` (the brake counts them; docs/SSOT.md); heldTag is their start. */
export const heldText = (token, what) => `${heldTag(token)} ${what} back`;
export const heldTag = (token) => `change threshold ${token} held the`;
