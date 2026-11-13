// Calendar Agent (owner decision 2026-11-08): the projected effect of each scheduled USD event on
// gold, by fixed rules, so the direction is consistent and testable. A model may only explain it
// (the Macro War Room), never reverse it.
//
// The ForexFactory export has the forecast and the previous value but no actual, so the projection
// is a scenario before the release:
//   - which way gold usually moves if the actual beats or misses the forecast (the rule of the
//     event kind: stronger US data or a hawkish Fed lift the dollar and yields, which weighs on
//     gold; weaker data or a dovish Fed do the opposite);
//   - what the consensus already expects (forecast against previous), as a mild lean that is
//     largely priced in;
//   - the horizon: from 2 hours before the event to 4 hours after it.
// After the release the outcome is read from the news headlines, not from the calendar.
// Advisory only: context for the rooms and the news, never a price level and never a trade.

export const CALENDAR_AGENT_VERSION = "cryptophys.calendar-agent.v1";
export const HORIZON = Object.freeze({ before_ms: 2 * 3_600_000, after_ms: 4 * 3_600_000 });

/**
 * Event kinds, first match wins. `higher`: what a reading above the forecast does to the dollar
 * ("usd_up" = stronger dollar, so gold down; "usd_down" = weaker dollar, so gold up; null = no
 * number, the tone decides).
 */
export const EVENT_RULES = Object.freeze([
  { kind: "unemployment", re: /unemployment rate|jobless rate/i, higher: "usd_down", why: "more unemployment points to a softer economy and earlier rate cuts" },
  { kind: "claims", re: /unemployment claims|jobless claims|continuing claims/i, higher: "usd_down", why: "more claims point to a cooling labour market" },
  { kind: "rate_decision", re: /federal funds rate|rate decision|interest rate decision/i, higher: "usd_up", why: "a higher policy rate raises the cost of holding gold" },
  { kind: "fed_speech", re: /fomc|fed chair|powell|fed .*speaks|federal reserve|press conference|monetary policy|beige book/i, higher: null, why: "a hawkish tone lifts the dollar and yields, a dovish tone does the opposite" },
  { kind: "inflation", re: /\bcpi\b|consumer price|\bppi\b|producer price|\bpce\b|price index|inflation/i, higher: "usd_up", why: "hotter inflation delays rate cuts and lifts real yields" },
  { kind: "wages", re: /average hourly earnings|wage|employment cost/i, higher: "usd_up", why: "faster wage growth feeds inflation and keeps rates high" },
  { kind: "jobs", re: /non[- ]?farm|nfp|adp|employment change|jolts|job openings/i, higher: "usd_up", why: "stronger hiring supports the dollar and higher rates" },
  { kind: "growth", re: /\bgdp\b|retail sales|durable goods|industrial production|factory orders/i, higher: "usd_up", why: "stronger growth supports the dollar and yields" },
  { kind: "surveys", re: /\bpmi\b|\bism\b|consumer confidence|consumer sentiment|empire state|philly fed|manufacturing index/i, higher: "usd_up", why: "stronger activity surveys support the dollar" },
  { kind: "housing", re: /housing|home sales|building permits|pending home/i, higher: "usd_up", why: "a firmer housing market supports the dollar slightly" }
]);
const GENERIC = Object.freeze({ kind: "other", higher: "usd_up", why: "US data above expectations usually supports the dollar", generic: true });

/** Pure: the number of a calendar value ("0.3%", "1.2K", "-0.5%", "250K", "4.50%"), or null. */
export function parseValue(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().replace(/,/g, "").match(/^([+-]?\d+(?:\.\d+)?)\s*([KMBT%]?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2].toUpperCase()] ?? 1;
  return Number.isFinite(n) ? n * mult : null;
}

/** Pure: the rule of an event title. */
export function ruleOf(title) {
  return EVENT_RULES.find((r) => r.re.test(String(title || ""))) ?? GENERIC;
}

const goldOf = (usd) => (usd === "usd_up" ? -1 : usd === "usd_down" ? 1 : 0);
const word = (s) => (s > 0 ? "gold up" : s < 0 ? "gold down" : "no clear effect");

/** Pure: the projection of one event at `now`. Only USD events are projected. */
/**
 * Pure: the stored release (src/econ-releases.mjs) of a calendar event: the same minute within 10, the
 * same event kind first. Null when none.
 */
export function matchRelease(e, releases = []) {
  const t = Date.parse(e?.time);
  if (!Number.isFinite(t)) return null;
  const kind = ruleOf(e.title).kind;
  const near = (releases || []).filter((r) => Math.abs(Date.parse(r.time) - t) <= 10 * 60_000 && r.kind === kind);
  if (!near.length) return null;
  // ForexFactory and TradingView name the same release differently ("Core CPI m/m" and "Core Inflation
  // Rate MoM"; production 2026-11-10): the headline and the core print share a minute, so the match
  // prefers the same "core" word and the same period (month, quarter or year).
  const words = (x) => { const s = String(x || "").toLowerCase(); return { core: /\bcore\b/.test(s), period: /y\/y|yoy|year/.test(s) ? "y" : /q\/q|qoq|quarter|annuali[sz]ed/.test(s) ? "q" : /m\/m|mom|month/.test(s) ? "m" : null }; };
  const want = words(e.title);
  // The core and the headline print are different numbers: never one for the other (production
  // 2026-11-13: TradingView listed only "PPI MoM", and "Core PPI m/m" took its actual and surprise, so the
  // same surprise was read twice).
  const same = near.filter((r) => words(r.title).core === want.core);
  if (!same.length) return null;
  const score = (r) => (want.period && words(r.title).period === want.period ? 1 : 0) + (r.actual != null ? 0.5 : 0);
  return same.slice().sort((a, b) => score(b) - score(a))[0];
}

const fmtNum = (v, unit) => (v == null ? "n/a" : `${Math.round(v * 1000) / 1000}${unit === "%" ? "%" : ""}`);

/** A released surprise's pull on gold: the rule's direction weighted by the surprise's size (1.5 SD and more: whole). */
export function surprisePull(release) {
  return (release?.gold_direction || 0) * Math.min(1, Math.abs(release?.surprise_z ?? 1) / 1.5);
}

/**
 * The strength of a consensus lean from the measured pre-release drift (owner 2026-11-12): unmeasured
 * (fewer than 5 releases with a consensus) it stays whole, as before; with a learned pre-release horizon
 * it follows the hit rate there, 0.2 at 55 % to 1 at 75 % or more; measured without one, 0 (gold did not
 * drift the consensus way reliably, so the consensus is not held).
 */
export function consensusStrength(pre, { contrarian = false } = {}) {
  if (!pre || pre.horizon_hours == null) return 1;
  // Contrarian (owner 2026-11-12, CALENDAR_CONTRARIAN on): gold drifted against the consensus,
  // significantly (src/econ-releases.mjs preDriftStats): the lean turns the other way, by the same scale.
  if (contrarian && pre.horizon_hours === 0 && pre.contrarian_hours > 0 && pre.against_rate > 0) return -strengthOf(pre.against_rate);
  if (!(pre.horizon_hours > 0) || !(pre.hit_rate > 0)) return 0;
  return strengthOf(pre.hit_rate);
}
const strengthOf = (rate) => Math.round(Math.max(0.2, Math.min(1, (rate - 0.5) / 0.25)) * 100) / 100;
/** The same rule for a release's surprise (its learned post-release horizon and hit rate; never contrarian). */
export const surpriseStrength = (stat) => consensusStrength(stat);

export function projectEvent(e, now = Date.now(), { release = null, stat = null, pre = null, contrarian = false } = {}) {
  if (!e || e.currency !== "USD") return null;
  const rule = ruleOf(e.title);
  const t = Date.parse(e.time);
  const beat = goldOf(rule.higher);
  const forecast = parseValue(e.forecast), previous = parseValue(e.previous);
  // The consensus lean: a forecast above the previous reading is "firmer expected", which the
  // market prices in before the release; it is half as strong as a surprise and only a lean.
  let consensus = 0;
  if (beat && forecast != null && previous != null && forecast !== previous) consensus = Math.sign(forecast - previous) * beat;
  // Its strength from the measured pre-release drift of the event kind (owner 2026-11-12).
  const strength = consensus ? consensusStrength(pre, { contrarian }) : 0;
  // The learned horizons of the event kind (owner 2026-11-10 after, 2026-11-12 before), else the fixed 4 and 2 hours.
  const afterMs = stat?.horizon_hours > 0 ? stat.horizon_hours * 3_600_000 : HORIZON.after_ms;
  const beforeMs = pre?.horizon_hours > 0 ? pre.horizon_hours * 3_600_000 : strength < 0 ? pre.contrarian_hours * 3_600_000 : HORIZON.before_ms;
  const status = now < t - beforeMs ? "upcoming" : now <= t ? "imminent" : now <= t + afterMs ? "released" : "past";
  const lines = beat
    ? [`Above forecast: ${word(beat)}; below forecast: ${word(-beat)} (${rule.why}).`]
    : [`No number: a hawkish tone means gold down, a dovish tone gold up (${rule.why}).`];
  if (consensus) lines.push(`The forecast is ${forecast > previous ? "above" : "below"} the previous reading, so the consensus already leans ${word(consensus)}; much of that is priced in.`);
  if (consensus && pre?.samples) {
    lines.push(pre.horizon_hours == null
      ? `Only ${pre.samples} past releases of this kind with a consensus are measured before the release, so the consensus lean stands as a rule.`
      : pre.horizon_hours > 0
        ? `Before the release: in ${pre.samples} past releases of this kind gold drifted the consensus way ${Math.round(pre.hit_rate * 100)}% of the time over the ${pre.horizon_hours} hours before it (mean ${pre.mean_atr > 0 ? "+" : ""}${pre.mean_atr} ATR), so the consensus lean holds at ${strength} from ${pre.horizon_hours} hours before.`
        : strength < 0
          ? `Before the release: in ${pre.samples} past releases of this kind gold drifted against the consensus ${Math.round(pre.against_rate * 100)}% of the time over the ${pre.contrarian_hours} hours before it (mean ${pre.against_mean_atr} ATR, p ${pre.against_p}), so the lean is contrarian: ${word(-consensus)} at ${-strength} from ${pre.contrarian_hours} hours before.`
          : `Before the release: in ${pre.samples} past releases of this kind gold did not drift the consensus way reliably, so the consensus lean is not held.`);
  }
  // After the release (owner 2026-11-10): the actual against the forecast, its surprise and the rule's
  // effect on gold, with what gold did after the past releases of this kind.
  const released = release && release.actual != null && now >= t;
  let surprise = null;
  if (released) {
    const dir = release.gold_direction ?? 0;
    surprise = { actual: release.actual, forecast: release.forecast ?? null, previous: release.previous ?? null, surprise: release.surprise ?? null, surprise_z: release.surprise_z ?? null, gold_direction: dir };
    lines.push(`Released: actual ${fmtNum(release.actual, release.unit)} against a forecast of ${fmtNum(release.forecast, release.unit)}${release.surprise_z != null ? ` (a surprise of ${release.surprise_z > 0 ? "+" : ""}${release.surprise_z} standard deviations)` : ""}, so by rule ${dir ? word(dir) : "no clear effect"}.`);
  } else if (status === "released") lines.push("Released: no actual value is stored yet, so the outcome is read from the headlines.");
  if (stat?.samples) {
    lines.push(stat.horizon_hours == null
      ? `Only ${stat.samples} past releases of this kind are measured, so the 4-hour horizon stands.`
      : stat.horizon_hours > 0
        ? `In ${stat.samples} past releases of this kind gold moved the rule's way ${Math.round((stat.hit_rate ?? stat.horizons?.[`${stat.horizon_hours}h`]?.hit_rate ?? 0) * 100)}% of the time ${stat.horizon_hours} hour${stat.horizon_hours > 1 ? "s" : ""} after, its strongest reaction, so the release's effect is weighed until then.`
        : `In ${stat.samples} past releases of this kind gold did not follow the rule reliably at any horizon.`);
  }
  return {
    title: e.title, time: e.time, impact: e.impact, kind: rule.kind, generic: Boolean(rule.generic),
    gold_if_above_forecast: beat || null, gold_if_below_forecast: beat ? -beat : null,
    consensus_lean: (consensus && Math.round(consensus * strength * 100) / 100) || 0, status,
    horizon: { from: new Date(t - beforeMs).toISOString(), to: new Date(t + afterMs).toISOString(), hours_before: beforeMs / 3_600_000, learned_before: pre?.horizon_hours > 0, hours_after: afterMs / 3_600_000, learned: stat?.horizon_hours > 0 },
    ...(consensus && pre?.samples ? { pre_release: { samples: pre.samples, horizon_hours: pre.horizon_hours, hit_rate: pre.hit_rate ?? null, mean_atr: pre.mean_atr ?? null, strength, ...(strength < 0 ? { contrarian: true, contrarian_hours: pre.contrarian_hours, against_rate: pre.against_rate, against_p: pre.against_p } : {}) } } : {}),
    ...(surprise ? { release: surprise } : {}),
    ...(stat?.samples ? { history: { samples: stat.samples, horizon_hours: stat.horizon_hours, hit_rate: stat.hit_rate ?? null, peak: stat.peak } } : {}),
    text: lines.join(" ")
  };
}

/**
 * Pure: the outlook the Calendar Agent speaks from: the High-impact USD events from 6 hours back
 * to 48 hours ahead with their projection, and the net consensus lean of the next 24 hours
 * (-1 bearish to +1 bullish for gold; 0 when nothing leans).
 */
export function calendarOutlook(events, now = Date.now(), { impacts = ["High"], intel = null } = {}) {
  const list = (events || [])
    .filter((e) => e.currency === "USD" && impacts.includes(e.impact))
    // Up to a day back (the longest learned reaction horizon, 24 hours); past 6 hours only while still inside its horizon.
    .filter((e) => { const t = Date.parse(e.time); return t >= now - 24 * 3_600_000 && t <= now + 48 * 3_600_000; })
    .map((e) => projectEvent(e, now, { release: matchRelease(e, intel?.releases), stat: intel?.stats?.[ruleOf(e.title).kind] ?? null, pre: intel?.pre_stats?.[ruleOf(e.title).kind] ?? null, contrarian: intel?.contrarian === true })).filter(Boolean)
    .filter((p) => Date.parse(p.time) >= now - 6 * 3_600_000 || p.status === "released");
  const next24 = list.filter((p) => { const t = Date.parse(p.time); return t > now && t <= now + 24 * 3_600_000; });
  const leaning = next24.filter((p) => p.consensus_lean);
  const lean = leaning.length ? Math.round((leaning.reduce((s, p) => s + p.consensus_lean, 0) / next24.length) * 100) / 100 : 0;
  // The surprise lean of the releases still inside their horizon (owner 2026-11-10): the rule's direction
  // weighted by the size of the surprise, -1 to +1.
  const live = list.filter((p) => p.status === "released" && p.release && p.release.gold_direction);
  const surpriseLean = live.length ? Math.round(Math.max(-1, Math.min(1, live.reduce((s, p) => s + surprisePull(p.release), 0) / live.length)) * 100) / 100 : 0;
  return {
    version: CALENDAR_AGENT_VERSION,
    surprise_lean: surpriseLean,
    released: live.map((p) => ({ title: p.title, time: p.time, ...p.release, horizon_to: p.horizon.to, learned_horizon: p.horizon.learned })),
    events: list,
    next_24h: next24.length,
    consensus_lean: lean,
    summary: !list.length ? "No high-impact USD event in the next 48 hours."
      : next24.length ? `${next24.length} high-impact USD event${next24.length > 1 ? "s" : ""} in the next 24 hours; the consensus ${lean > 0 ? "leans gold up" : lean < 0 ? "leans gold down" : "does not lean either way"}. The surprise against the forecast decides the move.`
      : `No high-impact USD event in the next 24 hours; ${list.length} within 48 hours or just released.`
  };
}
