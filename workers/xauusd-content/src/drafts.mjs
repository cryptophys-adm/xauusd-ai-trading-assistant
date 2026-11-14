// Drafts from the public projection (content roadmap P2; owner 2026-11-14: "persiapan engine post ke
// Instagram/threads"). Deterministic Indonesian templates, no model call: a language model never writes the
// public text, so nothing can slip a price or an instruction into it. Every draft goes through the content
// guardian (src/content-guardian.mjs) before it can be queued, and again before it is published.
import { checkContentDraft } from "../../../src/content-guardian.mjs";

export const DRAFT_VERSION = "cryptophys.content-draft.v1";
export const CHANNELS = Object.freeze(["threads", "instagram"]);
/** Text limits per channel: Threads posts are short; Instagram captions allow far more (kept short here). */
export const TEXT_LIMITS = Object.freeze({ threads: 500, instagram: 2200 });
export const DISCLAIMER = "Ini rekap edukasi dari sistem analisis kami, bukan ajakan jual atau beli dan bukan saran investasi.";
export const HASHTAGS = Object.freeze({ threads: "#XAUUSD #emas #edukasi", instagram: "#XAUUSD #emas #gold #edukasi #analisisteknikal" });

const DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const BIAS_ID = { BULLISH: "condong naik", BEARISH: "condong turun", NEUTRAL: "netral" };
const SESSION_ID = { asia: "Asia", london: "London", new_york: "New York", late: "penutupan" };

/** "Senin, 16 November 2026" (UTC). */
export function dateId(iso) {
  const d = new Date(iso);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const patternName = (id) => String(id ?? "").replace(/_/g, " ").trim();

/** Pure: the recaps of the window [from, to) (bar_close as ISO), a day's summary. */
export function summarizeDay(recaps, { from, to }) {
  const lo = Date.parse(from), hi = Date.parse(to);
  const day = (recaps || []).filter((r) => { const t = Date.parse(r?.bar_close ?? ""); return Number.isFinite(t) && t >= lo && t < hi; });
  const count = (f) => day.filter(f).length;
  const biases = ["BULLISH", "BEARISH", "NEUTRAL"].map((b) => [b, count((r) => r.bias === b)]).sort((a, b) => b[1] - a[1]);
  const sessions = {};
  for (const r of day) if (r.session) sessions[r.session] = sessions[r.session] || { BUY: 0, SELL: 0, WAIT: 0 }, sessions[r.session][r.stance] = (sessions[r.session][r.stance] || 0) + 1;
  const patterns = new Map();
  for (const r of day) for (const p of r.patterns || []) if (p.status === "confirmed") patterns.set(p.pattern, (patterns.get(p.pattern) || 0) + 1);
  const directional = day.filter((r) => r.stance === "BUY" || r.stance === "SELL");
  return {
    bars: day.length,
    buy: count((r) => r.stance === "BUY"), sell: count((r) => r.stance === "SELL"), wait: count((r) => r.stance === "WAIT"),
    main_bias: day.length && biases[0][1] > 0 ? biases[0][0] : null,
    sessions,
    confirmed_patterns: [...patterns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => patternName(p)),
    directional_hits: directional.filter((r) => r.outcome === "hit").length,
    directional_misses: directional.filter((r) => r.outcome === "miss").length,
    decision_times: day.map((r) => r.bar_close)
  };
}

/** Pure: the day's recap text for one channel, or null when the day had no decision. */
export function dailyRecapText(summary, { channel = "threads", dayIso }) {
  if (!summary?.bars) return null;
  const lines = [
    `Edukasi · Rekap XAUUSD ${dateId(dayIso)}`,
    "",
    `Sistem analisis kami membaca ${summary.bars} bar 15 menit: ${summary.buy} kali condong beli, ${summary.sell} kali condong jual, ${summary.wait} kali memilih menunggu.`
  ];
  if (summary.main_bias) lines.push(`Arah yang paling sering terbaca: ${BIAS_ID[summary.main_bias]}.`);
  const busiest = Object.entries(summary.sessions || {}).map(([s, v]) => [s, (v.BUY || 0) + (v.SELL || 0)]).sort((a, b) => b[1] - a[1])[0];
  if (busiest && busiest[1] > 0) lines.push(`Sinyal arah paling banyak muncul di sesi ${SESSION_ID[busiest[0]] ?? busiest[0]}.`);
  if (summary.confirmed_patterns?.length) lines.push(`Pola yang terkonfirmasi: ${summary.confirmed_patterns.join(", ")}.`);
  const decided = summary.directional_hits + summary.directional_misses;
  if (decided) lines.push(`Dari ${decided} bacaan arah yang sudah dinilai satu jam kemudian, ${summary.directional_hits} sesuai arah dan ${summary.directional_misses} tidak.`);
  lines.push("", DISCLAIMER, HASHTAGS[channel] ?? HASHTAGS.threads);
  const max = TEXT_LIMITS[channel] ?? 500;
  // Too long: drop the optional lines one at a time (the session, then the patterns, then the scored reads),
  // so the disclaimer is never cut.
  let keep = lines;
  for (const prefix of ["Sinyal ", "Pola ", "Dari "]) {
    if (keep.join("\n").length <= max) break;
    keep = keep.filter((l) => !l.startsWith(prefix));
  }
  return keep.join("\n").length <= max ? keep.join("\n") : null;
}

/**
 * Pure: the drafts of one day for the configured channels, each checked by the guardian. Instagram needs an
 * image (it has no text-only post): its draft waits with status "needs_image" until the card image exists.
 */
export function dailyDrafts(recaps, { now = Date.now(), channels = CHANNELS, delayHours = 24 } = {}) {
  const to = new Date(now - 24 * 3_600_000).toISOString();
  const from = new Date(now - 48 * 3_600_000).toISOString();
  const summary = summarizeDay(recaps, { from, to });
  const out = [];
  for (const channel of channels.filter((c) => CHANNELS.includes(c))) {
    const text = dailyRecapText(summary, { channel, dayIso: to });
    if (!text) continue;
    const guardian = checkContentDraft({ text, chart: false, decisionTimes: summary.decision_times, delayHours, now });
    out.push({
      id: `daily:${to.slice(0, 10)}:${channel}`, version: DRAFT_VERSION, kind: "daily_recap", channel, text,
      image_url: null, window: { from, to }, decision_times: summary.decision_times,
      guardian, status: !guardian.pass ? "blocked" : channel === "instagram" ? "needs_image" : "pending"
    });
  }
  return { summary, drafts: out };
}
