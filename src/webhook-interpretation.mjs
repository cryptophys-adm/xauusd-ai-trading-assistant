// Plain-language reading of the three TradingView webhook alerts for one H1 candle.
//
// The codes are decoded exactly as the installed Pine scripts emit them
// (pinescript/ssot/The-Prophet-v7.02-R38.txt, Global-Multiverse-Interceptor-v12.70.txt
// and the shared MizanLib structure core). This is a deterministic description of
// what the indicators said; it is not a trade signal and never changes the H1 decision.

export const STRUCTURE_SUBTYPES = {
  1: { text: "a bull trap (a fake breakout up)", lean: -1 },
  2: { text: "a true breakout up", lean: 1 },
  3: { text: "a bear trap (a liquidity sweep down that reversed)", lean: 1 },
  4: { text: "a true breakdown", lean: -1 }
};

export const TRADE_MANAGEMENT = {
  0: "nominal, with nothing to manage",
  1: "bullish trend continuation (adding to longs is allowed)",
  "-1": "bearish trend continuation (adding to shorts is allowed)",
  2: "overbought, a take-profit zone for longs",
  "-2": "oversold, a take-profit zone for shorts",
  3: "a possible reversal",
  4: "a risk condition that calls for cutting losses",
  5: "waiting for the higher-timeframe filter, so hold",
  6: "price discovery to the upside",
  "-6": "price discovery to the downside"
};

export const GMI_VERDICTS = {
  3: "a bullish verdict",
  "-3": "a bearish verdict",
  4: "an extension state where open risk should be reviewed",
  "-1": "an exhaustion or risk alert",
  2: "preparing for a long",
  0: "wait and observe"
};

export const GMI_GATES = {
  2: "Prophet, GMI and the volume profile all agree on direction",
  1: "the confluence gate passed, but without full agreement on direction",
  "-1": "the confluence gate found a conflict between Prophet, GMI and the volume profile",
  "-2": "the volume profile is not valid, so the confluence gate could not be checked",
  0: "the confluence gate was not active on this candle"
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function present(payload) {
  return Boolean(payload && typeof payload === "object" && Object.keys(payload).length);
}

function dirWord(dir) {
  return dir > 0 ? "bullish" : dir < 0 ? "bearish" : "neutral";
}

/** Prophet structure (divergence / break) from d_enc and the subtype code. */
export function describeStructure(dEnc, subtype) {
  if (dEnc === 1) return { text: "a bullish divergence", lean: 1 };
  if (dEnc === -1) return { text: "a bearish divergence", lean: -1 };
  if (dEnc === 3 || dEnc === -3) {
    const sub = STRUCTURE_SUBTYPES[subtype];
    return sub ? { text: `a structure break classified as ${sub.text}`, lean: sub.lean } : { text: "a structure break whose type is not resolved yet", lean: 0 };
  }
  return { text: "no divergence, with momentum in line with price", lean: 0 };
}

/**
 * Prophet as one indicator (owner decision 2026-11-06). Prophet R38 and the Prophet R37 core
 * inside GMI share one MizanLib structure core (their d_enc and subtype are identical in
 * production), so they read as one Prophet: the R38 signal and trade management, the R37
 * consensus direction and confirmation candle, and the shared structure once. The two alerts stay
 * separate in TradingView for calibration.
 */
function interpretProphet(r38, r37) {
  const has38 = present(r38), has37 = present(r37);
  if (!has38 && !has37) return null;
  const buy = has38 && (r38.buy_confirmed === true || num(r38.direction) === 1);
  const sell = has38 && (r38.sell_confirmed === true || num(r38.direction) === -1);
  const signal = !has38
    ? "the signal alert has not arrived"
    : buy
      ? `a confirmed BUY signal on this closed candle${r38.buy_high_quality === true ? " that also passed the high-quality filter" : ""}`
      : sell
        ? `a confirmed SELL signal on this closed candle${r38.sell_high_quality === true ? " that also passed the high-quality filter" : ""}`
        : "no buy or sell confirmation on this closed candle";
  const dir = has37 ? num(r37.direction) ?? 0 : null;
  const direction = dir == null
    ? ""
    : dir
      ? ` Its direction is ${dirWord(dir)}, with momentum and structure in agreement.`
      : " It has no clear direction: its momentum and structure do not agree, or both are flat.";
  const shared = has38 ? r38 : r37;
  const structure = describeStructure(num(shared.d_enc), num(shared.structure_subtype));
  const bEnc = has37 ? num(r37.b_enc) : null;
  const confirmation = bEnc === 3 ? "a bullish confirmation candle"
    : bEnc === -3 ? "a bearish confirmation candle (a close below the previous low)"
      : bEnc === -4 ? "a bearish structure confirmation"
        : bEnc === 2 ? "a divergence still waiting for its confirmation candle"
          : has37 ? "no confirmation candle" : null;
  const event = has37 && r37.bull_event === true ? " A fresh bullish structure event printed on this candle." : has37 && r37.bear_event === true ? " A fresh bearish structure event printed on this candle." : "";
  const tm = has38 ? TRADE_MANAGEMENT[num(r38.t_enc)] ?? "not reported" : null;
  const confirmed = buy ? 1 : sell ? -1 : 0;
  const confirmationLean = bEnc === 3 ? 1 : bEnc === -3 || bEnc === -4 ? -1 : 0;
  return {
    source: "Prophet",
    confirmed,
    lean: confirmed || dir || structure.lean || confirmationLean,
    text: `Prophet: ${signal}.${direction} The structure shows ${structure.text}${confirmation ? `, and ${confirmation}` : ""}.${event}${tm ? ` Its trade-management state is ${tm}.` : ""}`
  };
}

function interpretGmi(g) {
  if (!present(g)) return null;
  const verdict = num(g.verdict);
  const gate = num(g.gate);
  const gmiDir = num(g.gmi_dir) ?? 0;
  const verdictText = GMI_VERDICTS[verdict] ?? "not reported";
  const gateText = GMI_GATES[gate] ?? "the confluence gate status is not reported";
  const own = gmiDir ? `its own read leans ${dirWord(gmiDir)}` : "its own read has no direction";
  const conflict = g.conflict === true || gate === -1;
  const confirmed = (verdict === 3 || verdict === -3) && gate === 2 && !conflict ? Math.sign(verdict) : 0;
  const text = conflict && gmiDir
    ? `GMI v12.70: ${own}, but ${gateText}, so its verdict is ${verdictText}.`
    : `GMI v12.70: ${own}; ${gateText}, and the verdict is ${verdictText}.`;
  return { source: "GMI v12.70", confirmed, lean: verdict === 3 || verdict === -3 ? Math.sign(verdict) : gmiDir, conflict, text };
}

function overall(readings) {
  const confirmed = readings.map(r => r.confirmed).filter(Boolean);
  const leans = readings.map(r => r.lean).filter(Boolean);
  const conflict = readings.some(r => r.conflict);
  if (confirmed.length && confirmed.every(d => d === confirmed[0]) && !leans.some(d => d !== confirmed[0])) {
    return { bias: dirWord(confirmed[0]), text: `Overall the TradingView indicators point ${confirmed[0] > 0 ? "up" : "down"}, with a confirmed ${confirmed[0] > 0 ? "buy" : "sell"} signal.` };
  }
  if (!leans.length) return { bias: "neutral", text: "Overall the TradingView indicators show no direction on this candle." };
  if (leans.every(d => d === leans[0])) {
    const why = conflict ? "no buy or sell signal is confirmed and GMI reports a conflict" : "no buy or sell signal is confirmed";
    return { bias: dirWord(leans[0]), text: `Overall the TradingView indicators lean ${dirWord(leans[0])}, but ${why}, so they support waiting rather than an entry.` };
  }
  return { bias: "mixed", text: "Overall the TradingView indicators are mixed: some lean bullish and some lean bearish, so they support waiting rather than an entry." };
}

/**
 * Plain-language reading of the three webhook payloads.
 * Returns { available, bias, summary, lines: [{ source, text }], missing }.
 */
export function interpretWebhooks({ prophetR38, prophetR37, gmi } = {}) {
  const readings = [interpretProphet(prophetR38, prophetR37), interpretGmi(gmi)];
  // The alerts stay three in TradingView; a missing one is named by its alert.
  const missing = [[prophetR38, "Prophet R38"], [prophetR37, "Prophet R37"], [gmi, "GMI v12.70"]].filter(([p]) => !present(p)).map(([, n]) => n);
  const got = readings.filter(Boolean);
  if (!got.length) {
    return { available: false, bias: "unavailable", summary: "No TradingView alert has arrived for this candle yet.", lines: [], missing };
  }
  const o = overall(got);
  const gap = missing.length ? ` The ${missing.join(" and ")} alert has not arrived.` : "";
  return { available: true, bias: o.bias, summary: o.text + gap, lines: got.map(r => ({ source: r.source, text: r.text })), missing };
}

function parse(text) {
  if (text && typeof text === "object") return text;
  if (typeof text !== "string" || !text) return {};
  try { return JSON.parse(text) || {}; } catch { return {}; }
}

/**
 * What to store per webhook in ai_syntheses: the indicator fields of the payload, plus
 * any `metrics` sub-object. Storing only `metrics` (the old behaviour) dropped the
 * indicator fields whenever an alert carried one. Top-level indicator fields win.
 */
export function storedIndicatorMetrics(payload) {
  if (!payload || typeof payload !== "object") return payload ?? null;
  const { metrics, ...fields } = payload;
  return metrics && typeof metrics === "object" && !Array.isArray(metrics) ? { ...metrics, ...fields } : fields;
}

/** Reading straight from an ai_syntheses row (prophet_metrics and gmi_metrics JSON columns). */
export function interpretWebhookRow(row) {
  const prophet = parse(row?.prophet_metrics);
  return interpretWebhooks({ prophetR38: prophet.prophet_r38, prophetR37: prophet.prophet_r37_ssot, gmi: parse(row?.gmi_metrics) });
}
