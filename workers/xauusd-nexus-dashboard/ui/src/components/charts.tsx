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

type Levels = { h6: number; h5: number; h4: number; h3: number; l3: number; l4: number; l5: number; l6: number };
type Cpr = { pivot: number; tc: number; bc: number; position?: string | null } | null;

/**
 * Vertical price ladder: one Camarilla set (H6 down to L6) with the H3–L3 range, the H4–H5
 * breakout and L4–L5 breakdown zones shaded, the daily and weekly pivot ranges as bands, and the
 * close as a marker (clamped to an edge with an arrow when it is outside the ladder).
 */
export function LevelLadder({ levels, close, daily, weekly, height = 300 }: { levels: Levels; close: number | null; daily?: Cpr; weekly?: Cpr; height?: number }) {
  const W = 300, padT = 10, padB = 10, x0 = 70, x1 = 236;
  // Keep the ladder on the Camarilla set: the close and a pivot range near it extend it by at most
  // a quarter of its span; a pivot range further away shows as an edge marker with its price.
  const span = levels.h6 - levels.l6 || 1;
  const near = (p: number) => p <= levels.h6 + span * 0.25 && p >= levels.l6 - span * 0.25;
  const vals = [levels.h6, levels.l6, ...(close != null ? [close] : []), ...[daily, weekly].flatMap((c) => (c && near(c.pivot) ? [c.tc, c.bc] : []))];
  const hi = Math.min(Math.max(...vals), levels.h6 + span * 0.25), lo = Math.max(Math.min(...vals), levels.l6 - span * 0.25);
  const y = (p: number) => padT + ((hi - p) / (hi - lo || 1)) * (height - padT - padB);
  const yc = (p: number) => Math.max(padT, Math.min(height - padB, y(p)));
  const zone = (a: number, b: number, color: string, op: number) => <rect x={x0} width={x1 - x0} y={yc(Math.max(a, b))} height={Math.max(1, yc(Math.min(a, b)) - yc(Math.max(a, b)))} fill={color} opacity={op} />;
  const rows: [keyof Levels, string, string][] = [["h6", "H6", C.bull], ["h5", "H5", C.bull], ["h4", "H4", C.bull], ["h3", "H3", C.wait], ["l3", "L3", C.wait], ["l4", "L4", C.bear], ["l5", "L5", C.bear], ["l6", "L6", C.bear]];
  const out = close == null ? null : close > hi ? "up" : close < lo ? "down" : null;
  const band = (c: Cpr, label: string, color: string) => c && (c.pivot > hi || c.pivot < lo ? (
    <text key={label} x={x1} y={c.pivot > hi ? padT + 2 : height - 2} textAnchor="end" fontSize="8.5" fill={color} className="mono">{c.pivot > hi ? "▲" : "▼"} {label} {c.pivot.toFixed(2)}</text>
  ) : (
    <g key={label}>
      <rect x={x1 - 34} width={30} y={yc(c.tc)} height={Math.max(2, yc(c.bc) - yc(c.tc))} fill={color} opacity={0.55} rx={2} />
      <line x1={x1 - 38} x2={x1} y1={yc(c.pivot)} y2={yc(c.pivot)} stroke={color} strokeWidth={1.2} strokeDasharray="2 2" />
      <text x={x1 + 4} y={yc(c.pivot) + 3} fontSize="8" fill={color}>{label}</text>
    </g>
  ));
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={`Camarilla ladder, close ${close ?? "unknown"}`}>
      {zone(levels.h3, levels.l3, C.wait, 0.08)}
      {zone(levels.h4, levels.h5, C.bull, 0.1)}
      {zone(levels.l4, levels.l5, C.bear, 0.1)}
      {rows.map(([k, name, color]) => (
        <g key={k}>
          <line x1={x0} x2={x1} y1={y(levels[k])} y2={y(levels[k])} stroke={color} strokeOpacity={k === "h3" || k === "l3" || k === "h4" || k === "l4" ? 0.9 : 0.45} strokeWidth={k === "h4" || k === "l4" ? 1.6 : 1} />
          <text x={x0 - 6} y={y(levels[k]) + 3} textAnchor="end" fontSize="9" fill={color} className="mono">{name} {levels[k].toFixed(2)}</text>
        </g>
      ))}
      {band(daily ?? null, "D pivot", C.cyan)}
      {band(weekly ?? null, "W pivot", C.violet)}
      {close != null && (
        <g>
          <line x1={x0 - 2} x2={x1 + 2} y1={yc(close)} y2={yc(close)} stroke="#e2e8f0" strokeWidth={2} />
          <polygon points={`${x1 + 2},${yc(close)} ${x1 + 9},${yc(close) - 4} ${x1 + 9},${yc(close) + 4}`} fill="#e2e8f0" />
          <rect x={x0 + 4} y={yc(close) - 15} width={78} height={13} rx={3} fill="#0b1220" stroke="#e2e8f0" strokeOpacity={0.4} />
          <text x={x0 + 43} y={yc(close) - 5.5} textAnchor="middle" fontSize="9" fontWeight="700" fill="#e2e8f0" className="mono">{out === "up" ? "▲ " : out === "down" ? "▼ " : ""}{close.toFixed(2)}</text>
        </g>
      )}
    </svg>
  );
}

/** Radar of axes in [0, 1] (a hexagon for six). A missing value is drawn at the centre, dashed. */
export function RegimeRadar({ axes, size = 220, color = C.cyan }: { axes: { key: string; label: string; value: number | null }[]; size?: number; color?: string }) {
  const n = axes.length, cx = 110, cy = 104, R = 72;
  const at = (i: number, r: number) => { const a = (-90 + (360 / n) * i) * (Math.PI / 180); return [cx + R * r * Math.cos(a), cy + R * r * Math.sin(a)] as const; };
  const ring = (r: number) => axes.map((_, i) => at(i, r).join(",")).join(" ");
  const shape = axes.map((a, i) => at(i, a.value ?? 0).join(",")).join(" ");
  return (
    <svg viewBox="-34 0 288 214" width="100%" style={{ maxWidth: size + 60 }} role="img" aria-label={axes.map((a) => `${a.label} ${a.value ?? "n/a"}`).join(", ")}>
      {[0.25, 0.5, 0.75, 1].map((r) => <polygon key={r} points={ring(r)} fill="none" stroke={C.track} strokeWidth={r === 1 ? 1.4 : 1} />)}
      {axes.map((_, i) => { const [x, y] = at(i, 1); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={C.track} />; })}
      <motion.polygon initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5 }} style={{ transformOrigin: `${cx}px ${cy}px` }}
        points={shape} fill={color} fillOpacity={0.2} stroke={color} strokeWidth={1.8} />
      {axes.map((a, i) => { const [x, y] = at(i, a.value ?? 0); return <circle key={a.key} cx={x} cy={y} r={2.6} fill={a.value == null ? "transparent" : color} stroke={color} strokeDasharray={a.value == null ? "1.5 1.5" : undefined} />; })}
      {axes.map((a, i) => {
        const [x, y] = at(i, 1.2);
        const anchor = Math.abs(x - cx) < 6 ? "middle" : x > cx ? "start" : "end";
        return (
          <text key={a.key} x={x} y={y + 3} textAnchor={anchor} fontSize="8.5" fill="#94a3b8">
            {a.label}<tspan className="mono" fill={a.value == null ? C.muted : "#e2e8f0"}>{a.value == null ? " –" : ` ${Math.round(a.value * 100)}`}</tspan>
          </text>
        );
      })}
    </svg>
  );
}
