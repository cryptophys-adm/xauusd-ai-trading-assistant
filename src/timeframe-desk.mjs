// The timeframe desk of a War Room (owner decision 2026-11-06): each room's desk analyses only its
// own chart. It reads the local Prophet R38, Prophet R37 and GMI records of the bar that just
// closed (the parity-approved copy when the identity is approved, else the observed copy) and
// decodes them into plain sentences with the same interpreter as the TradingView alerts.
//
// - 15m room: the 15m Desk (prophet_m15 / gmi_m15 are parity approved).
// - 1H room: the 1H Desk keeps the authoritative H1 decision chain and adds this reading.
// - 4H and D1 rooms: the 4H Desk and D1 Desk (candidate identities until their alerts calibrate
//   them, so they speak at confidence 0.4 or lower, like any uncalibrated agent).
import { interpretWebhooks } from "./webhook-interpretation.mjs";
import { OBSERVED_PREFIX } from "./parity-sweep.mjs";

async function readRecord(env, candleKey, engine) {
  for (const [prefix, approved] of [["localcalc:", true], [OBSERVED_PREFIX, false]]) {
    try {
      const raw = await env?.WEBHOOK_BUFFER?.get?.(prefix + candleKey + ":" + engine);
      if (raw) return { comparable: JSON.parse(raw)?.values?.comparable || {}, approved };
    } catch { /* unreadable: try the next copy */ }
  }
  return null;
}

/**
 * The desk's reading of one bar: plain sentences, whether parity approved the records, and the
 * Prophet R38 confirmations. `available` is false when neither record exists.
 */
export async function chartDeskReading(env, candleKey) {
  const [p, g] = await Promise.all([readRecord(env, candleKey, "prophet"), readRecord(env, candleKey, "gmi")]);
  if (!p && !g) return { available: false, approved_by_parity: false, reading: [], buy_confirmed: false, sell_confirmed: false };
  const r38 = p?.comparable?.prophet_r38 ?? null;
  const read = interpretWebhooks({ prophetR38: r38 || undefined, prophetR37: p?.comparable?.prophet_r37_ssot || undefined, gmi: g?.comparable?.gmi_v12_70 || undefined });
  const reading = read.available ? [read.summary.replace(/ The .* alert has not arrived\.$/, ""), ...read.lines.map((l) => l.text)] : [];
  return {
    available: reading.length > 0,
    approved_by_parity: [p, g].filter(Boolean).every((x) => x.approved),
    reading,
    buy_confirmed: r38?.buy_confirmed === true,
    sell_confirmed: r38?.sell_confirmed === true
  };
}

/** The evidence label shown once next to the desk. */
export function chartDeskLabel(tfLabel, desk) {
  return desk?.approved_by_parity ? `parity-approved ${tfLabel} chain` : `${tfLabel} local records, not parity approved`;
}
