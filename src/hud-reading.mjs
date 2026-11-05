// Deterministic HUD reading: turns HUD data contracts (numbers, booleans, codes)
// into plain English sentences. Follows src/webhook-interpretation.mjs.
// Agents receive the reading, never raw codes alone.

export const HUD_READING_VERSION = "cryptophys.hud-reading.v1";

const code = (v) => (typeof v === "number" ? v : null);

export function readHud(agentId, data = {}) {
  const d = data || {};
  const lines = [];
  switch (agentId) {
    case "prophet":
      if (code(d.cshi_score) !== null) lines.push(`Market composite score is ${d.cshi_score}.`);
      if (code(d.cycle_intensity) !== null) lines.push(`Cycle intensity is ${d.cycle_intensity}.`);
      if (code(d.d_enc) !== null) lines.push(`Structure encoding is ${d.d_enc}.`);
      if (code(d.t_enc) !== null) lines.push(`Trade-management encoding is ${d.t_enc}.`);
      break;
    case "r37_funnel":
      if (typeof d.confirmed === "boolean") lines.push(d.confirmed ? "Confirmation stage passed on this bar." : "Confirmation stage did not pass on this bar.");
      if (typeof d.high_quality === "boolean") lines.push(d.high_quality ? "High-quality stage passed on this bar." : "High-quality stage did not pass on this bar.");
      break;
    case "trade_management":
      if (code(d.zone_state_code) !== null) lines.push(`Zone state code is ${d.zone_state_code}.`);
      if (code(d.kww_zscore) !== null) lines.push(`KWW z-score is ${d.kww_zscore}.`);
      if (code(d.prophet_dir) !== null && code(d.gmi_dir) !== null) lines.push(`Prophet direction ${d.prophet_dir}, GMI direction ${d.gmi_dir}, conflict ${Boolean(d.conflict)}, gate ${d.gate}.`);
      break;
    case "kinetic_engine":
      if (code(d.theta) !== null) lines.push(`Channel angle is ${d.theta}.`);
      if (code(d.entropy) !== null) lines.push(`Market entropy is ${d.entropy}.`);
      if (typeof d.is_chaos === "boolean") lines.push(d.is_chaos ? "Chaos regime is active." : "Chaos regime is not active.");
      break;
    case "fabio_amt":
      if (code(d.poc) !== null) lines.push(`POC (gravity) is ${d.poc}.`);
      if (code(d.vah) !== null && code(d.val) !== null) lines.push(`Value area is ${d.val} to ${d.vah}.`);
      if (code(d.fp_status_code) !== null) lines.push(`Squeeze status code is ${d.fp_status_code}.`);
      break;
    case "decision_matrix":
      if (code(d.verdict) !== null) lines.push(`Action verdict is ${d.verdict}.`);
      if (typeof d.is_chaos === "boolean") lines.push(d.is_chaos ? "System guard: chaos." : "System guard: calm.");
      break;
    default:
      // Generic fallback: emit "key: value" only for numbers/booleans/codes, never strings that look like code.
      for (const [k, v] of Object.entries(d)) {
        if (typeof v === "number" || typeof v === "boolean") lines.push(`${k} is ${v}.`);
      }
  }
  return { agent_id: agentId, version: HUD_READING_VERSION, available: lines.length > 0, lines };
}
