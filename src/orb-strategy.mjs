// Session Opening Range Breakout (ORB) Strategy Agent (RFC_STRATEGY_AGENTS, docs/adoption/ORB_STRATEGY_AGENT.md).
//
// Pure and deterministic adoption into the XAUUSD strategy agent registry.
// Evaluates session opening ranges for London and New York, confirms closed-bar
// breakouts beyond range extremes with ATR normalization, supports retests,
// and respects global guardrails.
//
// Status: "shadow" by default. Never live without explicit owner configuration.

import { finishPlan, AGENT_RULES } from "./strategy-agents.mjs";

export const ORB_AGENT_VERSION = "cryptophys.orb-strategy.v1";
export const ORB_AGENT_ID = "orb_breakout";

export const ORB_RULES = Object.freeze({
  range_duration_min: 45, // 45 minutes opening range (3 x 15m closed bars)
  max_range_bars: 4,      // up to 60 minutes
  min_range_atr: 0.25,    // range smaller than 0.25 ATR is noise/holiday/flat
  max_range_atr: 3.5,     // range wider than 3.5 ATR is exhausted / news shock
  breakout_atr: 0.05,     // closed bar must close at least 0.05 ATR beyond edge
  retest_atr: 0.20,       // entry considered retest if within 0.20 ATR of broken edge
  invalidation_midpoint: true, // close back across range midpoint invalidates setup
  expiry_hours: 4.5,      // setup expires 4.5 hours after session open
  pad_atr: 0.10           // stop padding beyond range extreme or breakout candle
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;

// Timezone formatters handling daylight saving time (DST) explicitly
const LONDON_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/London",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

const NY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

const WD_MAP = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

/**
 * Pure: parses timestamp into timezone-aware components respecting regional DST.
 */
export function sessionTimeInZone(ms, fmt) {
  try {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    return {
      weekday: WD_MAP[parts.weekday] ?? 0,
      hour: Number(parts.hour) || 0,
      minute: Number(parts.minute) || 0
    };
  } catch {
    const d = new Date(ms);
    return { weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
}

/**
 * Supported XAUUSD active breakout sessions:
 * - London: Session opens at 08:00 local UK time (GMT / BST).
 * - New York: Session opens at 08:00 local US/Eastern time (EST / EDT).
 */
export const SESSIONS_CONFIG = Object.freeze({
  london: Object.freeze({
    id: "london",
    label: "London",
    openHour: 8,
    openMinute: 0,
    timeZone: "Europe/London",
    formatter: LONDON_FMT
  }),
  new_york: Object.freeze({
    id: "new_york",
    label: "New York",
    openHour: 8,
    openMinute: 0,
    timeZone: "America/New_York",
    formatter: NY_FMT
  })
});

/**
 * Determines whether a bar open timestamp falls within a session's opening range window.
 */
export function getBarSessionInfo(barMs, sessionDef) {
  const t = sessionTimeInZone(barMs, sessionDef.formatter);
  // Weekend exclusion
  if (t.weekday === 0 || t.weekday === 6) {
    return { inSession: false, isWeekend: true };
  }

  const minutesFromOpen = (t.hour - sessionDef.openHour) * 60 + (t.minute - sessionDef.openMinute);
  return {
    inSession: minutesFromOpen >= 0 && minutesFromOpen < ORB_RULES.expiry_hours * 60,
    inOpeningRange: minutesFromOpen >= 0 && minutesFromOpen < ORB_RULES.range_duration_min,
    minutesFromOpen,
    weekday: t.weekday
  };
}

/**
 * Identifies the latest session and extracts the opening range from closed 15m bars.
 * Uses closed bars only.
 */
export function findSessionOpeningRange(bars, atr) {
  if (!Array.isArray(bars) || bars.length < 1 || !isNum(atr) || atr <= 0) {
    return { status: "insufficient_data", reason: "missing_bars_or_atr" };
  }

  const lastBar = bars.at(-1);
  const lastMs = Date.parse(lastBar.open_time || lastBar.time);
  if (!isNum(lastMs)) {
    return { status: "insufficient_data", reason: "invalid_timestamp" };
  }

  // Check both New York and London in priority of recency
  const candidateSessions = [SESSIONS_CONFIG.new_york, SESSIONS_CONFIG.london];

  for (const sDef of candidateSessions) {
    const curInfo = getBarSessionInfo(lastMs, sDef);
    if (curInfo.isWeekend) {
      return { status: "rejected", reason: "weekend_market_closed" };
    }
    if (!curInfo.inSession) continue;

    // Find all bars belonging to today's session
    const sessionBars = [];
    for (let i = bars.length - 1; i >= 0; i--) {
      const b = bars[i];
      const ms = Date.parse(b.open_time || b.time);
      if (!isNum(ms)) break;
      const bInfo = getBarSessionInfo(ms, sDef);
      if (bInfo.weekday !== curInfo.weekday) break; // crossed day boundary
      if (bInfo.minutesFromOpen >= 0 && bInfo.minutesFromOpen < ORB_RULES.expiry_hours * 60) {
        sessionBars.unshift({ ...b, ms, bInfo });
      } else if (bInfo.minutesFromOpen < 0) {
        break; // before session open
      }
    }

    const rangeBars = sessionBars.filter((b) => b.bInfo.inOpeningRange);
    const postRangeBars = sessionBars.filter((b) => !b.bInfo.inOpeningRange);

    if (rangeBars.length < 2) {
      return { status: "range_forming", session: sDef.id, reason: "opening_range_still_forming" };
    }

    const rangeHigh = Math.max(...rangeBars.map((b) => b.high));
    const rangeLow = Math.min(...rangeBars.map((b) => b.low));
    const rangeSpan = rangeHigh - rangeLow;
    const midpoint = (rangeHigh + rangeLow) / 2;

    // Range size validation
    if (rangeSpan < ORB_RULES.min_range_atr * atr) {
      return { status: "rejected", session: sDef.id, reason: "range_too_narrow", rangeSpan, atr };
    }
    if (rangeSpan > ORB_RULES.max_range_atr * atr) {
      return { status: "rejected", session: sDef.id, reason: "range_too_wide", rangeSpan, atr };
    }

    return {
      status: "range_ready",
      session: sDef.id,
      sessionLabel: sDef.label,
      rangeHigh: r2(rangeHigh),
      rangeLow: r2(rangeLow),
      rangeSpan: r2(rangeSpan),
      midpoint: r2(midpoint),
      rangeBars,
      postRangeBars,
      lastBar
    };
  }

  return { status: "rejected", reason: "outside_active_orb_session" };
}

/**
 * Pure: evaluates ORB setup and returns a deterministic plan or null with diagnostic reasons.
 */
export function evaluateOrbSetup(dir, ctx) {
  const bars = ctx.bars || [];
  const atr = ctx.atr;
  const price = ctx.price;

  if (![1, -1].includes(dir) || !isNum(price) || !isNum(atr) || atr <= 0) {
    return { plan: null, reason: "invalid_inputs" };
  }

  const orbRange = findSessionOpeningRange(bars, atr);
  if (orbRange.status !== "range_ready") {
    return { plan: null, reason: orbRange.reason || orbRange.status, details: orbRange };
  }

  const { session, sessionLabel, rangeHigh, rangeLow, rangeSpan, midpoint, postRangeBars, lastBar } = orbRange;

  if (!postRangeBars.length) {
    return { plan: null, reason: "waiting_for_breakout_candle", session };
  }

  // Inspect breakout bars
  const edge = dir > 0 ? rangeHigh : rangeLow;
  let breakoutBar = null;
  let breakoutIdx = -1;

  for (let i = 0; i < postRangeBars.length; i++) {
    const b = postRangeBars[i];
    const broke = dir > 0
      ? b.close - edge >= ORB_RULES.breakout_atr * atr
      : edge - b.close >= ORB_RULES.breakout_atr * atr;

    if (broke) {
      breakoutBar = b;
      breakoutIdx = i;
      break;
    }
  }

  if (!breakoutBar) {
    return { plan: null, reason: "no_closed_bar_breakout", session };
  }

  // Check invalidation: has any closed bar after breakout closed past midpoint?
  const barsAfterBreakout = postRangeBars.slice(breakoutIdx + 1);
  for (const b of barsAfterBreakout) {
    const invalidated = dir > 0 ? b.close < midpoint : b.close > midpoint;
    if (invalidated) {
      return { plan: null, reason: "breakout_invalidated_by_midpoint_close", session };
    }
  }

  // Retest or expansion condition
  const distFromEdge = dir > 0 ? price - edge : edge - price;
  const isRetesting = Math.abs(distFromEdge) <= ORB_RULES.retest_atr * atr;
  const isExtended = distFromEdge > 2.0 * atr;

  if (isExtended) {
    return { plan: null, reason: "breakout_extended_beyond_risk_limit", session };
  }

  // Entry: at price if retesting/holding, or limit at range edge
  const entry = isRetesting ? price : edge;
  // Stop: range midpoint or opposite extreme of breakout bar, padded by pad_atr
  const barExtreme = dir > 0 ? breakoutBar.low : breakoutBar.high;
  const rawStop = dir > 0
    ? Math.min(midpoint, barExtreme) - ORB_RULES.pad_atr * atr
    : Math.max(midpoint, barExtreme) + ORB_RULES.pad_atr * atr;

  const plan = finishPlan(
    ORB_AGENT_ID,
    dir,
    {
      entry,
      stop: rawStop,
      atLevel: isRetesting,
      entryNote: isRetesting
        ? `price retests ${sessionLabel} opening range edge (${edge}) after breakout`
        : `a breakout above ${sessionLabel} opening range (${rangeLow}–${rangeHigh})`,
      stopNote: `behind ${sessionLabel} ORB midpoint / breakout base (${r2(rawStop)})`,
      setup: `${sessionLabel} session opening range breakout (${rangeSpan}pt range)`
    },
    ctx
  );

  if (!plan) {
    return { plan: null, reason: "plan_guardrail_rejected", session };
  }

  return {
    plan: {
      ...plan,
      session,
      orb: {
        session,
        range_high: rangeHigh,
        range_low: rangeLow,
        range_span: rangeSpan,
        retest: isRetesting,
        breakout_candle_time: breakoutBar.open_time || breakoutBar.time
      }
    },
    reason: "ok"
  };
}

/**
 * The ORB Strategy Agent object conforming to the strategy agent contract:
 * { id, version, label, fits, plan(dir, ctx) }
 */
export const orbStrategy = Object.freeze({
  id: ORB_AGENT_ID,
  version: 1,
  label: "Session opening range breakout",
  fits: "A session expansion: after the London (08:00 UK) or New York (08:00 NY) opening range forms (45m), a closed 15m bar breaks out beyond the range extreme with ATR confirmation. Enter on breakout or retest of the range edge, stop at range midpoint or breakout base, target at the next key level. Shadow-only by default.",
  plan(dir, ctx) {
    const outcome = evaluateOrbSetup(dir, ctx);
    return outcome.plan ?? null;
  }
});
