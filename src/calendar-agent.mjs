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
  { kind: "jobs", re: /non-?farm|nfp|adp|employment change|jolts|job openings/i, higher: "usd_up", why: "stronger hiring supports the dollar and higher rates" },
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
export function projectEvent(e, now = Date.now()) {
  if (!e || e.currency !== "USD") return null;
  const rule = ruleOf(e.title);
  const t = Date.parse(e.time);
  const beat = goldOf(rule.higher);
  const forecast = parseValue(e.forecast), previous = parseValue(e.previous);
  // The consensus lean: a forecast above the previous reading is "firmer expected", which the
  // market prices in before the release; it is half as strong as a surprise and only a lean.
  let consensus = 0;
  if (beat && forecast != null && previous != null && forecast !== previous) consensus = Math.sign(forecast - previous) * beat;
  const status = now < t - HORIZON.before_ms ? "upcoming" : now <= t ? "imminent" : now <= t + HORIZON.after_ms ? "released" : "past";
  const lines = beat
    ? [`Above forecast: ${word(beat)}; below forecast: ${word(-beat)} (${rule.why}).`]
    : [`No number: a hawkish tone means gold down, a dovish tone gold up (${rule.why}).`];
  if (consensus) lines.push(`The forecast is ${forecast > previous ? "above" : "below"} the previous reading, so the consensus already leans ${word(consensus)}; much of that is priced in.`);
  if (status === "released") lines.push("Released: the outcome is read from the headlines.");
  return {
    title: e.title, time: e.time, impact: e.impact, kind: rule.kind, generic: Boolean(rule.generic),
    gold_if_above_forecast: beat || null, gold_if_below_forecast: beat ? -beat : null,
    consensus_lean: consensus, status,
    horizon: { from: new Date(t - HORIZON.before_ms).toISOString(), to: new Date(t + HORIZON.after_ms).toISOString() },
    text: lines.join(" ")
  };
}

/**
 * Pure: the outlook the Calendar Agent speaks from: the High-impact USD events from 6 hours back
 * to 48 hours ahead with their projection, and the net consensus lean of the next 24 hours
 * (-1 bearish to +1 bullish for gold; 0 when nothing leans).
 */
export function calendarOutlook(events, now = Date.now(), { impacts = ["High"] } = {}) {
  const list = (events || [])
    .filter((e) => e.currency === "USD" && impacts.includes(e.impact))
    .filter((e) => { const t = Date.parse(e.time); return t >= now - 6 * 3_600_000 && t <= now + 48 * 3_600_000; })
    .map((e) => projectEvent(e, now)).filter(Boolean);
  const next24 = list.filter((p) => { const t = Date.parse(p.time); return t > now && t <= now + 24 * 3_600_000; });
  const leaning = next24.filter((p) => p.consensus_lean);
  const lean = leaning.length ? Math.round((leaning.reduce((s, p) => s + p.consensus_lean, 0) / next24.length) * 100) / 100 : 0;
  return {
    version: CALENDAR_AGENT_VERSION,
    events: list,
    next_24h: next24.length,
    consensus_lean: lean,
    summary: !list.length ? "No high-impact USD event in the next 48 hours."
      : next24.length ? `${next24.length} high-impact USD event${next24.length > 1 ? "s" : ""} in the next 24 hours; the consensus ${lean > 0 ? "leans gold up" : lean < 0 ? "leans gold down" : "does not lean either way"}. The surprise against the forecast decides the move.`
      : `No high-impact USD event in the next 24 hours; ${list.length} within 48 hours or just released.`
  };
}
