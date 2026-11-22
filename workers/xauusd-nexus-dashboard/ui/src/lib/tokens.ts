/**
 * The Nexus colour set (owner-approved mockup "Nexus colours and text", 2026-11-22). One source with the @theme block
 * in src/index.css: the same names and the same values (test/nexus-tokens.test.mjs checks both agree).
 *
 * - Direction: green bullish, red bearish, amber neutral. A direction always carries ▲ ▼ · or its word.
 * - Status, as the header shows it (components/HeaderStatus.tsx): cyan ok, amber late, red fault, grey off.
 * - Each colour has a text value (4.5:1 or more on the panel #0b0f18) and a fill value for bars, dots, lines and
 *   chip borders. A chip is its fill at 30% for the border and 10% for the background, with the text value as text.
 * - `dim` is for rules and disabled lines only, never for text.
 */
export const T = {
  bull: "#4ade80", bullFill: "#22c55e",
  bear: "#f87171", bearFill: "#ef4444",
  neutral: "#fcd34d", neutralFill: "#fbbf24",
  ok: "#67e8f9", okFill: "#22d3ee",
  late: "#fcd34d", lateFill: "#fbbf24",
  fault: "#f87171", faultFill: "#ef4444",
  off: "#94a3b8", offFill: "#94a3b8",
  shadow: "#c4b5fd", shadowFill: "#a78bfa",
  fg: "#e6edf3", fg2: "#8b949e", muted: "#7d8590", dim: "#484f58",
  ground: "#05070c", panel: "#0b0f18", bar: "#0f1522",
  border: "rgba(255,255,255,0.10)", borderSoft: "rgba(255,255,255,0.05)", track: "rgba(255,255,255,0.07)",
} as const;

/** "#rrggbb" at an alpha, as rgba(). */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * One candle palette for every chart (War Room and Omega): the bull and bear fills, the same green and red as the
 * zones, the plan lines, bid/ask and position lines.
 */
export const CANDLE = {
  upColor: T.bullFill, downColor: T.bearFill,
  borderUpColor: T.bullFill, borderDownColor: T.bearFill,
  wickUpColor: T.bullFill, wickDownColor: T.bearFill,
} as const;
/** A volume bar in the candle's colour, at `alpha`. */
export const volumeColor = (up: boolean, alpha = 0.35) => rgba(up ? T.bullFill : T.bearFill, alpha);
/** The KWW band's own hue (yellow): its mean, its ±1σ and its ±1.618σ edges, which are no direction. */
export const KWW = { mean: "rgba(250,204,21,0.9)", band: "rgba(250,204,21,0.35)", edge: "rgba(250,204,21,0.6)" } as const;

export type Tone = "bull" | "bear" | "neutral" | "ok" | "late" | "fault" | "off" | "shadow" | "plain";

/** Chip classes per tone: border at 30% of the fill, background at 10%, text in the text colour. */
export const CHIP: Record<Tone, string> = {
  bull: "border-bull-fill/30 bg-bull-fill/10 text-bull",
  bear: "border-bear-fill/30 bg-bear-fill/10 text-bear",
  neutral: "border-neutral-fill/30 bg-neutral-fill/10 text-neutral",
  ok: "border-ok-fill/30 bg-ok-fill/10 text-ok",
  late: "border-late-fill/30 bg-late-fill/10 text-late",
  fault: "border-fault-fill/30 bg-fault-fill/10 text-fault",
  off: "border-off-fill/30 bg-off-fill/8 text-off",
  shadow: "border-ghost-fill/30 bg-ghost-fill/10 text-ghost",
  plain: "border-white/10 bg-white/4 text-fg-2",
};

/** Text classes per tone. */
export const TEXT: Record<Tone, string> = {
  bull: "text-bull", bear: "text-bear", neutral: "text-neutral", ok: "text-ok", late: "text-late", fault: "text-fault",
  off: "text-off", shadow: "text-ghost", plain: "text-fg",
};

/** Fill classes per tone (dots, bars). */
export const FILL: Record<Tone, string> = {
  bull: "bg-bull-fill", bear: "bg-bear-fill", neutral: "bg-neutral-fill", ok: "bg-ok-fill", late: "bg-late-fill",
  fault: "bg-fault-fill", off: "bg-off-fill", shadow: "bg-ghost-fill", plain: "bg-fg-2",
};

const BULL = new Set(["BUY", "BULLISH", "LONG", "UP", "bullish", "long", "up"]);
const BEAR = new Set(["SELL", "BEARISH", "SHORT", "DOWN", "bearish", "short", "down"]);
const NEUTRAL = new Set(["WAIT", "HOLD", "NEUTRAL", "neutral"]);

/** The tone of a stance, bias or side. CLOSE is an action, not a direction: the text colour. */
export function directionTone(v?: string | null): Tone {
  if (!v) return "plain";
  if (BULL.has(v)) return "bull";
  if (BEAR.has(v)) return "bear";
  if (NEUTRAL.has(v)) return "neutral";
  return "plain";
}

/** The glyph that carries a direction without its colour: ▲ bullish, ▼ bearish, · neutral; none for WAIT, HOLD, CLOSE. */
export function directionGlyph(v?: string | null): string {
  if (!v) return "";
  if (BULL.has(v)) return "▲";
  if (BEAR.has(v)) return "▼";
  if (v === "NEUTRAL" || v === "neutral") return "·";
  return "";
}
