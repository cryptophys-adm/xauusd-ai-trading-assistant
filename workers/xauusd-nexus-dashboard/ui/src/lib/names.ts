// Canonical names (docs/SSOT.md §1 and §3): the four production Workers by their Worker names, and
// the parity engines by their indicator names. Every Nexus status label uses these.
export const WORKERS = Object.freeze({
  ai: { name: "xauusd-ai-trading-assistant", role: "AI Worker" },
  news: { name: "xauusd-fundamental-news-ingestion", role: "news Worker" },
  pull: { name: "xauusd-tradingview-pull-adapter", role: "pull adapter" },
  nexus: { name: "xauusd-nexus-dashboard", role: "Nexus" }
});

/** Registry engine id (base) → indicator name. "prophet" is the single Prophet reading of R38 and R37. */
export const ENGINES: Record<string, string> = Object.freeze({
  mizan: "MizanLib",
  prophet: "Prophet R38 + R37",
  gmi: "GMI v12.70",
  prophet_hud: "Prophet HUD",
  gmi_hud: "GMI HUD"
});
export const engineName = (base?: string | null) => (base && ENGINES[base]) || String(base ?? "");

/** Registry engine id → its chart, as the timeframe tabs name them. */
export function engineChart(engine?: string | null): string {
  const m = String(engine ?? "").match(/_(m5|m15|h4|d1)$/);
  return m ? ({ m5: "5m", m15: "15m", h4: "4H", d1: "D1" } as Record<string, string>)[m[1]] : "1H";
}
