// The content guardian, content roadmap P1 (docs/RFC_CONTENT_AGENT.md §1 and §2.2; owner 2026-11-14:
// "lanjutkan semua"). Deterministic checks of a public draft (a post or a caption) before it may go out; a
// failed check never publishes. It sits beside the decision-card guard (src/decision-cards.mjs cardLeaks) and
// the room compliance checks (src/compliance.mjs); Aether may run the same rules on what it audits. Nothing
// publishes yet: there is no content agent, and the first posts will wait for the owner's click anyway.
//
// The rules (POJK 6/2026 asks a publisher to state its capacity; until a lawyer confirms what forex and gold
// content may say, the content is education and analysis, a recap after a delay, never an instruction):
//   capacity        the draft says it is education ("edukasi" / "education");
//   disclaimer      it says it is not advice or an invitation ("bukan ajakan", "not financial advice", ...);
//   promised_return no promised or guaranteed return, no "risk-free", no "x% per month";
//   instruction     no live instruction (buy or sell now, entry at, set the stop or target, ...);
//   signal_words    no trading-signal vocabulary at all (owner 2026-11-14: "Tidak boleh ada advices buy/sell,
//                   kecuali info buy/sell zone"): entry, SL, TP, stop loss, take profit, cut loss, and BUY, SELL,
//                   LONG or SHORT written as a signal; a demand or supply zone ("area beli", "area jual") is information;
//   price_level     no price level (a gold price), unless the owner allows levels as commentary later;
//   account_data    no account, balance, equity, margin, lot or position;
//   internal        never Nexus or Omega (the private dashboards);
//   secret          nothing that looks like a key, token or private key;
//   attribution     a draft with a chart image names TradingView;
//   too_recent      every decision it covers is older than the public delay.
import { PRICE_LIKE } from "./public-projection.mjs";

export const CONTENT_GUARDIAN_VERSION = "cryptophys.content-guardian.v1";
const MONTHS = "jan|januari|january|feb|februari|february|mar|maret|march|apr|april|mei|may|jun|juni|june|jul|juli|july|agu|agustus|aug|august|sep|sept|september|okt|oktober|oct|october|nov|november|des|desember|dec|december";
export const CONTENT_CHECKS = Object.freeze(["capacity", "disclaimer", "promised_return", "instruction", "signal_words", "price_level", "account_data", "internal", "secret", "attribution", "too_recent"]);

const RULES = Object.freeze({
  capacity: /\b(edukasi|education(al)?)\b/i,
  disclaimer: /(bukan\s+(ajakan|rekomendasi|saran)|not\s+(financial|investment)\s+advice|disclaimer|tidak\s+(dimaksudkan|ditujukan)\s+sebagai\s+(ajakan|saran))/i,
  promised_return: /((pasti|dijamin|jaminan|guarantee[ds]?)\s*(profit|untung|cuan|return|hasil)|(profit|untung|cuan|return|hasil)\s+(pasti|dijamin|guaranteed)|profit\s+konsisten|consistent\s+profits?|risk[- ]?free|tanpa\s+risiko|anti\s+rugi|\b\d+(?:[.,]\d+)?\s*%\s*(per|a|tiap|setiap|sehari|sebulan|seminggu)\s*(hari|minggu|bulan|day|week|month)?)/i,
  instruction: /(\b(buy|sell|beli|jual|entry|masuk|open|long|short)\s+(now|sekarang|di\s+(harga|level)|at\s+\d|@\s*\d)|\b(pasang|set|taruh|place)\s+(sl|tp|stop|target|order|limit)|\bstop[- ]?loss\s*(di|at|@|:)\s*\d|\btake[- ]?profit\s*(di|at|@|:)\s*\d|\btarget\s*(di|at|@|:)\s*\d|\bsegera\s+(beli|jual|entry|masuk))/i,
  account_data: /\b(balance|saldo|equity|ekuitas|margin|lot|lots|lotsize|posisi\s+terbuka|open\s+positions?|akun\s+(saya|kami|trading)|my\s+account|our\s+account|floating)\b/i,
  internal: /\b(nexus|omega)\b/i,
  secret: /(sk-[A-Za-z0-9]{16,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY|\b[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9_-]{48,}\b)/
});

/**
 * Checks one draft. `chart` is true when it carries a chart image; `decisionTimes` are the bar closes of the
 * decisions it covers; `delayHours` is the public delay; `allowLevels` lets price levels through as commentary
 * (off until the owner decides). Returns { pass, failures: [{ check, detail }] }. Pure; never throws.
 */
export function checkContentDraft({ text = "", chart = false, decisionTimes = [], delayHours = 24, allowLevels = false, now = Date.now() } = {}) {
  const t = String(text ?? "");
  const failures = [];
  const fail = (check, detail) => failures.push({ check, detail });
  if (!t.trim()) fail("capacity", "empty draft");
  else {
    if (!RULES.capacity.test(t)) fail("capacity", "say it is education (edukasi)");
    if (!RULES.disclaimer.test(t)) fail("disclaimer", "say it is not advice or an invitation to trade");
  }
  const found = (k) => t.match(RULES[k])?.[0];
  if (found("promised_return")) fail("promised_return", found("promised_return"));
  if (found("instruction")) fail("instruction", found("instruction"));
  const signal = t.match(/\b(entry|entries|sl|tp\d?|stop[- ]?loss|take[- ]?profit|cut[- ]?loss)\b/i)?.[0] ?? t.match(/\b(BUY|SELL|LONG|SHORT)\b/)?.[0];
  if (signal) fail("signal_words", signal);
  // Dates are not levels: an ISO date, a time, and a year after a month name are left out of the price check.
  const undated = t.replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, " ").replace(/\b\d{1,2}[:.]\d{2}\b/g, " ")
    .replace(new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2},?\\s+)?(19|20)\\d{2}\\b`, "gi"), " ");
  if (!allowLevels && undated.match(PRICE_LIKE)) fail("price_level", undated.match(PRICE_LIKE)[0]);
  if (found("account_data")) fail("account_data", found("account_data"));
  if (found("internal")) fail("internal", found("internal"));
  if (found("secret")) fail("secret", "a key- or token-like string");
  if (chart && !/tradingview/i.test(t)) fail("attribution", "a chart image needs TradingView's attribution");
  const cutoff = now - Math.max(1, Number(delayHours) || 24) * 3_600_000;
  const recent = (Array.isArray(decisionTimes) ? decisionTimes : []).filter((x) => { const ms = Date.parse(x); return !Number.isFinite(ms) || ms > cutoff; });
  if (recent.length) fail("too_recent", `${recent.length} decision(s) newer than the ${delayHours}-hour delay`);
  return { version: CONTENT_GUARDIAN_VERSION, pass: failures.length === 0, failures };
}
