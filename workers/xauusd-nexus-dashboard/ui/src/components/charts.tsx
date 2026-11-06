import { useId } from "react";
import { motion } from "framer-motion";

/** Palette shared with the obsidian theme (Tailwind emerald-400, rose-400, amber-300, cyan-400, slate-500). */
export const C = { bull: "#34d399", bear: "#fb7185", wait: "#fcd34d", cyan: "#22d3ee", violet: "#a78bfa", muted: "#64748b", track: "rgba(255,255,255,0.07)" };
export const STANCE_COLOR: Record<string, string> = { BUY: C.bull, BULLISH: C.bull, SELL: C.bear, BEARISH: C.bear, WAIT: C.wait, HOLD: C.wait, CLOSE: C.cyan, NEUTRAL: C.muted };
export const leanColor = (v: number | null | undefined) => (v == null || Math.abs(v) < 0.1 ? C.muted : v > 0 ? C.bull : C.bear);

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
};
function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const [x0, y0] = polar(cx, cy, r, from), [x1, y1] = polar(cx, cy, r, to);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

/**
 * Semicircle gauge for a value in [-1, 1]: bearish on the left, bullish on the right, with a
 * red-amber-green track and a needle. `label` is printed under the value.
 */
export function SentimentGauge({ value, label }: { value: number | null; label: string }) {
  const v = value == null ? 0 : Math.max(-1, Math.min(1, value));
  const deg = -90 + (v + 1) * 90;
  const [nx, ny] = polar(100, 100, 62, deg);
  // Unique per instance: the panel is rendered twice (phone and desktop), and a duplicate id
  // would bind the gradient of the hidden copy.
  const gid = `gauge-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 200 122" className="w-full" role="img" aria-label={`Sentiment ${label}`}>
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="180" y2="0">
          <stop offset="0%" stopColor={C.bear} /><stop offset="50%" stopColor={C.wait} /><stop offset="100%" stopColor={C.bull} />
        </linearGradient>
      </defs>
      <path d={arc(100, 100, 80, -90, 90)} stroke={C.track} strokeWidth="14" fill="none" strokeLinecap="round" />
      <path d={arc(100, 100, 80, -90, 90)} stroke={`url(#${gid})`} strokeWidth="14" fill="none" strokeLinecap="round" opacity={value == null ? 0.25 : 0.9} />
      {[-90, -45, 0, 45, 90].map((t) => { const [a, b] = polar(100, 100, 92, t), [c, d] = polar(100, 100, 97, t); return <line key={t} x1={a} y1={b} x2={c} y2={d} stroke={C.muted} strokeWidth="1.5" />; })}
      {value != null && (
        <motion.line x1="100" y1="100" initial={{ x2: 100, y2: 34 }} animate={{ x2: nx, y2: ny }} transition={{ type: "spring", stiffness: 60, damping: 12 }}
          stroke="#e2e8f0" strokeWidth="3" strokeLinecap="round" />
      )}
      <circle cx="100" cy="100" r="6" fill="#e2e8f0" />
      <text x="22" y="118" textAnchor="middle" fontSize="8" fill={C.bear} letterSpacing="1.5">BEAR</text>
      <text x="178" y="118" textAnchor="middle" fontSize="8" fill={C.bull} letterSpacing="1.5">BULL</text>
      <text x="100" y="119" textAnchor="middle" fontSize="11" fill="#cbd5e1"><tspan className="mono" fontWeight="800" fill={leanColor(value)}>{value == null ? "—" : `${v > 0 ? "+" : ""}${Math.round(v * 100)}`}</tspan>{` · ${label}`}</text>
    </svg>
  );
}

/** Donut of named parts; the center shows `center` (for example the total). */
export function Donut({ parts, center, sub, size = 96 }: { parts: { label: string; value: number; color: string }[]; center?: string; sub?: string; size?: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  let start = 0;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
      <circle cx="50" cy="50" r="38" stroke={C.track} strokeWidth="12" fill="none" />
      {total > 0 && parts.filter((p) => p.value > 0).map((p) => {
        const sweep = (p.value / total) * 360;
        const d = sweep >= 359.99 ? null : arc(50, 50, 38, start, start + sweep);
        const el = d ? <path key={p.label} d={d} stroke={p.color} strokeWidth="12" fill="none" /> : <circle key={p.label} cx="50" cy="50" r="38" stroke={p.color} strokeWidth="12" fill="none" />;
        start += sweep;
        return el;
      })}
      {center && <text x="50" y={sub ? 50 : 55} textAnchor="middle" className="mono" fontSize="17" fontWeight="800" fill="#e2e8f0">{center}</text>}
      {sub && <text x="50" y="64" textAnchor="middle" fontSize="8" fill="#94a3b8">{sub}</text>}
    </svg>
  );
}

/** Horizontal bar centered on zero for a value in [-1, 1] (or scaled by `max`). */
export function DivergingBar({ value, max = 1, height = 8 }: { value: number | null; max?: number; height?: number }) {
  const v = value == null ? 0 : Math.max(-max, Math.min(max, value)) / max;
  const w = Math.abs(v) * 50;
  return (
    <div className="relative w-full overflow-hidden rounded-full" style={{ height, background: C.track }}>
      <div className="absolute inset-y-0 left-1/2 w-px bg-white/25" />
      {value != null && (
        <motion.div className="absolute inset-y-0 rounded-full" initial={{ width: 0 }} animate={{ width: `${w}%` }} transition={{ duration: 0.6, ease: "easeOut" }}
          style={{ [v >= 0 ? "left" : "right"]: "50%", background: leanColor(value), boxShadow: `0 0 10px ${leanColor(value)}66` }} />
      )}
    </div>
  );
}

/** One stacked bar of stance counts, in a fixed stance order. */
export function StackedBar({ mix, height = 10 }: { mix: Record<string, number>; height?: number }) {
  const order = ["BUY", "HOLD", "WAIT", "CLOSE", "SELL"];
  const total = order.reduce((s, k) => s + (mix[k] ?? 0), 0);
  return (
    <div className="flex w-full overflow-hidden rounded-full" style={{ height, background: C.track }} role="img" aria-label={order.filter((k) => mix[k]).map((k) => `${k} ${mix[k]}`).join(", ")}>
      {total > 0 && order.filter((k) => mix[k]).map((k) => (
        <motion.div key={k} title={`${k} ${mix[k]}`} initial={{ width: 0 }} animate={{ width: `${(mix[k] / total) * 100}%` }} transition={{ duration: 0.5 }}
          style={{ background: STANCE_COLOR[k] }} className="h-full border-r border-black/30 last:border-r-0" />
      ))}
    </div>
  );
}
