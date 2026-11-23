// The Intelligence pages' shared helpers (Track C2, first used by the Liquidity page; C3 and C4 add to it): the per-page
// GET allow-list, the price and time formats with their scale and zone, the New York clock of the baseline and the
// market hours, the feed-scale bands of lens B, the LIQUIDITY card's weight rule, and (C3) the charts' keys, a close
// time snapped to its candle, the Projection Agent's seat rules and the measured record's (the pattern agents' rules are
// lib/patternRules.ts). Pure: no React, no request.
import { CHART_READ, get, type GetOptions } from "./api";
import { T } from "./tokens";

export const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
export const str = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);
export const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
export const obj = (x: unknown): Record<string, any> | null => (x != null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, any>) : null);

// ---------------------------------------------------------------- the reads (GET only, one allow-list per page)

/**
 * The Liquidity page's reads, the only paths it may GET (brief rule 3: GET only, from a per-page allow-list). Each is
 * polled once: the view (120 s), the lens (120 s, for the analyst panel and the score), the 15m candles (CHART_READ,
 * 60 s), the 15m chart plane (CHART_READ, 300 s) and the latest decision (120 s).
 */
export const LIQUIDITY_READS = {
  liquidity: { path: "/api/liquidity", everyMs: 120_000, chart: false },
  lens: { path: "/api/lens", everyMs: 120_000, chart: false },
  candles: { path: "/api/ohlcv?timeframe=M15&limit=200", everyMs: 60_000, chart: true },
  plane: { path: "/api/hud/levels?tf=15", everyMs: 300_000, chart: true },
  decision: { path: "/api/engine/decision", everyMs: 120_000, chart: false }
} as const;
export type LiquidityRead = keyof typeof LIQUIDITY_READS;

/**
 * The Chart patterns page's reads (Track C3, owner ruling at the mockup's approval: the candles are the view's own 60
 * closed bars per chart and "armed" is its decision.trade_agent, so no /api/ohlcv and no /api/engine/decision read).
 * Each is polled once: the view (120 s, backend B9), the strategy agents (120 s, the pattern agents' records) and the
 * neuron allocation (300 s, the Projection Agent's seat per room).
 */
export const CHART_PATTERNS_READS = {
  patterns: { path: "/api/chart-patterns", everyMs: 120_000, chart: false },
  agents: { path: "/api/strategy-agents", everyMs: 120_000, chart: false },
  seat: { path: "/api/neuron-allocation", everyMs: 300_000, chart: false }
} as const;
export type ChartPatternsRead = keyof typeof CHART_PATTERNS_READS;

/** The allow-list's paths. */
export const allowedPaths = (reads: Record<string, { path: string }>): string[] => Object.values(reads).map((r) => r.path);

/**
 * A GET of an allow-listed read: a chart read (candles, the chart plane) keeps the browser's cache (CHART_READ), the
 * others are no-store (api.ts). A path outside the list throws before any request.
 */
export function intelGet<T = any>(reads: Record<string, { path: string; chart: boolean }>, key: string): Promise<T> {
  const r = reads[key];
  if (!r || !allowedPaths(reads).includes(r.path)) return Promise.reject(new Error(`not allowed: ${key}`));
  const opts: GetOptions = r.chart ? CHART_READ : {};
  return get<T>(r.path, opts);
}

// ---------------------------------------------------------------- prices and their scale

const PRICE = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A price with two decimals and a thousands separator ("2,684.20"), "—" when missing. */
export const price = (x: unknown): string => (num(x) ? PRICE.format(x) : "—");
/** A range "2,675.60–2,676.05", or one price when low and high are the same. */
export const priceRange = (lo: unknown, hi: unknown): string => (!num(lo) || !num(hi) ? "—" : Math.abs(hi - lo) < 0.005 ? price(lo) : `${price(lo)}–${price(hi)}`);
/** A signed value: "+1.98", "−1.08" (a true minus). */
export const signed = (x: unknown, digits = 2): string => (num(x) ? `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(digits)}` : "—");
/** A percentile as an ordinal: 0.97 reads "97th", 0.62 "62nd". */
export function pctl(x: unknown): string {
  if (!num(x)) return "—";
  const n = Math.round(x * 100);
  const t = n % 100;
  const suf = t >= 11 && t <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suf}`;
}
/** A share as a whole percentage: 0.57 reads "57%". */
export const pc = (x: unknown): string => (num(x) ? `${Math.round(x * 100)}%` : "—");

/** The scales a price can be on (brief rule 7): every price on screen carries one. */
export const SCALE = { feed: "feed scale", broker: "broker scale" } as const;

/** The broker-to-feed basis when known (broker − feed), else null: without it no lens B level is drawn. */
export function knownBasis(scale: any): number | null {
  const s = obj(scale);
  return s && s.feed_basis_known === true && num(s.feed_basis) ? s.feed_basis : null;
}

// ---------------------------------------------------------------- zones and roles (PriceChart's ZONE_COLOR)

/** The zone colours of the War Room chart (components/PriceChart.tsx): support bull, resistance bear, at price ok. */
export const ZONE_COLOR: Record<string, string> = { support: T.bullFill, resistance: T.bearFill, "at price": T.okFill };
/** A zone's label colour: the text value of its role. */
export const ZONE_TEXT: Record<string, string> = { support: T.bull, resistance: T.bear, "at price": T.ok };
export type Role = "support" | "resistance" | "at price";
/** A zone's role against the last close: above it resistance, below it support, around it at price. */
export function roleOf(lo: number, hi: number, last: number | null): Role {
  if (!num(last)) return "at price";
  if (lo <= last && last <= hi) return "at price";
  return lo > last ? "resistance" : "support";
}
/** The role in words with its glyph: "▲ support", "▼ resistance", "at price". */
export const ROLE_WORD: Record<Role, string> = { support: "▲ support", resistance: "▼ resistance", "at price": "at price" };

/** Lens B's level kinds in words: pool, HVN (an acronym), sweep. */
export const kindWord = (k: unknown): string => { const s = str(k) ?? "level"; return s.toLowerCase() === "hvn" ? "HVN" : s.replace(/_/g, " "); };

/** One lens B level on the feed scale, ready to draw: from *_feed only. */
export type FeedLevel = { kind: string; low: number; high: number; brokerMid: number; role: Role; inKeyZone: boolean };

/**
 * Lens B's levels on the chart's feed scale (brief C2): only from low_feed and high_feed, and none at all while the
 * broker-to-feed basis is unknown (scale.feed_basis_known false or no basis). The broker label is the band's middle on
 * the broker scale, (low_feed + high_feed) / 2 + basis, to the cent. A level without both *_feed values is left out.
 */
export function feedLevels(levels: unknown, scale: unknown, last: number | null): FeedLevel[] {
  const basis = knownBasis(scale);
  if (basis == null) return [];
  const out: FeedLevel[] = [];
  for (const l of arr(levels)) {
    const lo = l?.low_feed, hi = l?.high_feed;
    if (!num(lo) || !num(hi) || lo > hi) continue;
    out.push({ kind: kindWord(l.kind), low: lo, high: hi, brokerMid: Math.round(((lo + hi) / 2 + basis) * 100) / 100, role: roleOf(lo, hi, last), inKeyZone: l.in_key_zone === true });
  }
  return out;
}

/** The ATR distance of a band's middle from the last close, in ATR(15m) on the feed scale, or null. */
export const atrDistance = (lo: number, hi: number, last: unknown, atr: unknown): number | null => (num(last) && num(atr) && atr > 0 ? ((lo + hi) / 2 - last) / atr : null);

// ---------------------------------------------------------------- the LIQUIDITY card (backend B15)

/** The most weight the LIQUIDITY card carries in the council, whatever lens B's weight. */
export const LIQUIDITY_CARD_MAX = 0.06;
/** The LIQUIDITY card's weight: a tenth of lens B's council weight, at most 0.06 (0.36 gives 0.036). Council only, never counted. */
export const liquidityCardWeight = (councilWeight: unknown): number | null => (num(councilWeight) && councilWeight >= 0 ? Math.min(LIQUIDITY_CARD_MAX, 0.1 * councilWeight) : null);
/** The weight as shown: rounded to the cent with the exact value beside it, "0.04 (0.036)". */
export const cardWeightText = (w: unknown): string => (num(w) ? `${w.toFixed(2)} (${Number(w.toFixed(3))})` : "—");

// ---------------------------------------------------------------- scores

/** The decisive readings a lens needs before its floor can act (src/lens-policy.mjs LENS_SCORE_MIN_N). */
export const LENS_MIN_N = 20;
/** Lens B's score kinds in their order; others follow. */
export const KIND_ORDER = ["sweep", "block", "maker", "skip", "level"];
export const kindsInOrder = (kinds: unknown): [string, any][] => {
  const o = obj(kinds) ?? {};
  const rank = (k: string) => { const i = KIND_ORDER.indexOf(k); return i < 0 ? KIND_ORDER.length : i; };
  return Object.entries(o).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
};
/** A score kind in words: "h4" reads "4H". */
export const scoreKindWord = (k: string): string => (/^h(\d+)$/i.test(k) ? `${k.slice(1)}H` : /^d1$/i.test(k) ? "1D" : k.replace(/_/g, " "));

// ---------------------------------------------------------------- clocks: UTC, the viewer's zone, New York

const two = (n: number) => String(n).padStart(2, "0");
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Thu 14:21" in UTC. */
export const utcDayTime = (ms: number): string => { const d = new Date(ms); return `${DAY_NAMES[d.getUTCDay()]} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
/** "21:21" in UTC (HH:MM). */
export const utcTime = (ms: number): string => { const d = new Date(ms); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };
/** "Thu 21:21" in the viewer's zone. */
export const localDayTime = (ms: number): string => { const d = new Date(ms); return `${DAY_NAMES[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())}`; };
export const localTime = (ms: number): string => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
/** The viewer's zone as the header writes it: "GMT+7", "local" on UTC. */
export function zoneLabel(ms: number): string {
  const off = -new Date(ms).getTimezoneOffset();
  const abs = Math.abs(off);
  return off === 0 ? "local" : `GMT${off > 0 ? "+" : "-"}${Math.floor(abs / 60)}${abs % 60 ? `:${two(abs % 60)}` : ""}`;
}
/** "14:28 UTC · 21:28 GMT+7". */
export const clockPair = (ms: number): string => `${utcTime(ms)} UTC · ${localTime(ms)} ${zoneLabel(ms)}`;
/** A short age: "45s", "7m", "3h", "2d". */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** New York's clock at an instant: weekday (Sun 0), hour, minute and the date. */
export function nyClock(ms: number): { wd: number; hour: number; minute: number; date: string } {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { wd: DAY_NAMES.indexOf(p.weekday), hour: Number(p.hour), minute: Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}
/** New York's offset from UTC at an instant, in hours (−5 EST, −4 EDT). */
export function nyOffsetHours(ms: number): number {
  const c = nyClock(ms);
  const asUtc = Date.UTC(Number(c.date.slice(0, 4)), Number(c.date.slice(5, 7)) - 1, Number(c.date.slice(8, 10)), c.hour, c.minute);
  return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 3_600_000);
}
/** "EST (UTC−5)" or "EDT (UTC−4)", from the date. */
export const nyZoneText = (ms: number): string => { const o = nyOffsetHours(ms); return `${o === -4 ? "EDT" : "EST"} (UTC−${Math.abs(o)})`; };
/** The hour of the week in New York (Sun 00:00 is 0), as the baseline keys it (src/liquidity-lens.mjs nyHourOfWeek). */
export const nyHourOfWeek = (ms: number): number => { const c = nyClock(ms); return c.wd * 24 + c.hour; };
/** Whether a New York hour of the week is closed for gold: Friday from 17:00 to Sunday 18:00, and 17:00 Monday to Thursday. */
export function closedHour(how: number): boolean {
  const d = Math.floor(how / 24), h = how % 24;
  return d === 6 || (d === 0 && h < 18) || (d === 5 && h >= 17) || (d >= 1 && d <= 4 && h === 17);
}
/** Whether gold is closed at an instant (the weekend or the daily break, src/market-hours.mjs goldPausedAt). */
export const marketClosedAt = (ms: number): boolean => closedHour(nyHourOfWeek(ms));
/** The next open after a closed instant: Sunday 18:00 New York over the weekend, else 18:00 the same day. */
export function nextOpenMs(ms: number): number {
  let t = Math.floor(ms / 3_600_000) * 3_600_000;
  for (let i = 0; i < 24 * 8; i++) { t += 3_600_000; if (!marketClosedAt(t + 1)) return t; }
  return t;
}
/** "Sun 18:00 New York · Sun 23:00 UTC · Mon 06:00 GMT+7". */
export function openText(ms: number): string {
  const c = nyClock(ms);
  return `${DAY_NAMES[c.wd]} ${two(c.hour)}:${two(c.minute)} New York · ${utcDayTime(ms)} UTC · ${localDayTime(ms)} ${zoneLabel(ms)}`;
}

/** The weekday names, Sunday first, as the baseline's rows. */
export const WEEKDAYS = DAY_NAMES;

/** Words for a key: "partial_close" reads "partial close". */
export const words = (x: unknown): string => (str(x) ?? "—").replace(/_/g, " ");

// ---------------------------------------------------------------- the chart patterns (Track C3)

/** The view's charts, in tab order (backend B9 charts keys). */
export const TF_KEYS = ["15", "60", "240", "D"] as const;
export type TfKey = (typeof TF_KEYS)[number];
/** A chart's label on the page: B9 labels the daily chart "daily"; the page shows it as 1D (owner ruling). */
export const TF_LABEL: Record<TfKey, string> = { "15": "15m", "60": "1H", "240": "4H", D: "1D" };
/** The room of each chart, as the Projection Agent's seat keys it (seat.rooms). */
export const TF_ROOM: Record<TfKey, string> = { "15": "M15", "60": "H1", "240": "H4", D: "D1" };
/** A chart key of the view, or null. */
export const tfKey = (x: unknown): TfKey | null => (TF_KEYS as readonly unknown[]).includes(x) ? (x as TfKey) : null;

/**
 * A close time on a chart's candles: the latest candle opened before it (its open time, unix seconds), or null outside
 * the candles (at or before the first open, or after the last candle's close). On the 15m and 1H charts a bar's close
 * is the next bar's open, so it snaps to its own bar exactly; a daily close (15:00 UTC on the feed) snaps to the day it
 * closes. `at` is an ISO time or unix ms.
 */
export function snapToCandle(at: unknown, times: number[], intervalS: number): number | null {
  const ms = typeof at === "string" ? Date.parse(at) : num(at) ? at : NaN;
  if (!Number.isFinite(ms) || !times.length || !num(intervalS)) return null;
  const t = ms / 1000;
  if (t <= times[0] || t > times[times.length - 1] + intervalS) return null;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] < t) lo = mid; else hi = mid - 1; }
  return times[lo];
}

/** A price's distance from the last price in ATR(1H), or null. */
export const atrFrom = (p: unknown, last: unknown, atr: unknown): number | null => (num(p) && num(last) && num(atr) && atr > 0 ? (p - last) / atr : null);

/** The Projection Agent's seat rules (src/agent-allocation.mjs ALLOCATION_RULES): to shadow below 45% from 60 scored, back to live at 50%. */
export const SEAT_RULES = { demote_below: 0.45, promote_at: 0.5, min_scored: 60 } as const;
/** The measured record's follow-up (src/pattern-calibration.mjs CALIBRATION): 30 to 120 bars, active from 20 breakouts. */
export const RECORD_RULES = { horizon: 30, horizon_max: 120, min_sample: 20 } as const;
/** A pattern held back once its own record is negative over this many setups (src/strategy-agents.mjs PATTERN_BREAKER). */
export const PATTERN_BREAKER_MIN = 15;
