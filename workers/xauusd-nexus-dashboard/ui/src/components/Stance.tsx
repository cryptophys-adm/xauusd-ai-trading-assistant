import clsx from "clsx";
import { CHIP, TEXT, directionGlyph, directionTone } from "../lib/tokens";

/**
 * A room stance or a news bias as a small chip: green bullish, red bearish, amber neutral, with ▲ ▼ · so the
 * direction never rests on colour alone. CLOSE is an action, in the text colour.
 */
export function Stance({ value, className }: { value?: string | null; className?: string }) {
  if (!value) return null;
  const tone = directionTone(value);
  const glyph = directionGlyph(value);
  return (
    <span className={clsx("chip mono px-2 py-0.5", tone === "plain" ? "border-white/25 bg-white/5 text-fg" : CHIP[tone], className)}>
      {glyph && <span aria-hidden="true">{glyph}</span>}{value}
    </span>
  );
}

/** The text colour class of a stance, bias or side: CLOSE in the text colour, anything without a side amber. */
export function stanceColor(value?: string | null): string {
  if (value === "CLOSE") return "text-fg";
  const tone = directionTone(value);
  return tone === "plain" ? "text-neutral" : TEXT[tone];
}
