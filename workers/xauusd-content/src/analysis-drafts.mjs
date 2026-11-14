// Real-time analysis drafts (owner 2026-11-14 for the Threads account xauusd-ai-cta: "fokus pada hasil analytics
// dan key level. Tidak boleh ada advices buy/sell, kecuali info buy/sell zone"; "Real-time, hanya analisa").
// From the AI Worker's public analysis (src/public-analysis.mjs) only, in fixed Indonesian templates (no model
// writes public text):
//   - the key-level map, once a weekday at 06:09 UTC (13:09 WIB, before London): the demand zones ("area beli")
//     and supply zones ("area jual") as information, the price when read, the structure per chart;
//   - a pattern post when an H1, H4 or D1 pattern is confirmed (its breakout), or an H4 or D1 pattern is forming:
//     its catalogue name and chapter, its lines, what undoes it, the measured projection as analysis.
// Never the system's decision, an entry, a stop, a take profit or BUY/SELL as a signal: the content guardian's
// signal_words rule refuses them. Price levels are allowed here (allowLevels): they are the analysis itself.
import { checkContentDraft } from "../../../src/content-guardian.mjs";
import { dateId, CHANNELS, TEXT_LIMITS } from "./drafts.mjs";

export const ANALYSIS_DISCLAIMER = "Analisa edukasi dari sistem Cryptophys, bukan ajakan jual atau beli dan bukan saran investasi.";
export const ANALYSIS_HASHTAGS = Object.freeze({ threads: "#XAUUSD #emas #edukasi", instagram: "#XAUUSD #emas #gold #edukasi #analisisteknikal" });
/** At most this many pattern drafts a day per channel (the queue stays readable; each still needs approval). */
export const MAX_PATTERN_DRAFTS_PER_DAY = 4;
const TREND_ID = { up: "naik", down: "turun", range: "menyamping" };
const STRENGTH_ID = { strong: "kuat", moderate: "sedang", weak: "lemah" };
const f2 = (x) => (Number.isFinite(Number(x)) ? Number(x).toFixed(2) : "?");
const hhmm = (iso) => String(iso).slice(11, 16);

function finish(lines, channel) {
  const tail = ["", ANALYSIS_DISCLAIMER, ANALYSIS_HASHTAGS[channel] ?? ANALYSIS_HASHTAGS.threads];
  const max = TEXT_LIMITS[channel] ?? 500;
  // Too long: drop body lines from the end (never the title or the disclaimer).
  let body = [...lines];
  while (body.length > 1 && [...body, ...tail].join("\n").length > max) body.pop();
  // No blank line left over where a dropped line was.
  while (body.length > 1 && body.at(-1) === "") body.pop();
  const text = [...body, ...tail].join("\n");
  return text.length <= max ? text : null;
}

function zoneLine(z) {
  const meta = [STRENGTH_ID[z.strength] ?? null, z.sources ? `${z.sources} sumber` : null].filter(Boolean).join(", ");
  return `• ${f2(z.low)}–${f2(z.high)}${meta ? ` (${meta})` : ""}`;
}

/** Pure: the key-level map text for one channel, or null when there is no zone. */
export function keyLevelsText(analysis, { channel = "threads" } = {}) {
  const zones = analysis?.zones ?? [];
  const supply = zones.filter((z) => z.role === "supply").slice(-3);
  const demand = zones.filter((z) => z.role === "demand").slice(0, 3);
  if (!supply.length && !demand.length) return null;
  const lines = [`Edukasi · Peta level kunci XAUUSD · ${dateId(analysis.at)} ${hhmm(analysis.at)} UTC`];
  if (analysis.price != null) lines.push(`Harga saat dibaca: ${f2(analysis.price)}`);
  if (supply.length) lines.push("", "Zona penawaran (area jual):", ...supply.map(zoneLine));
  const at = zones.find((z) => z.role === "at_price");
  if (at) lines.push("", `Harga sedang berada di zona ${f2(at.low)}–${f2(at.high)}.`);
  if (demand.length) lines.push("", "Zona permintaan (area beli):", ...demand.map(zoneLine));
  const st = Object.entries(analysis.structure ?? {}).filter(([, s]) => s.trend).map(([c, s]) => `${c} ${TREND_ID[s.trend] ?? s.trend}${s.label ? ` (${s.label})` : ""}`);
  if (st.length) lines.push("", `Struktur: ${st.join(" · ")}`);
  lines.push("", "Zona = tempat level kunci dari beberapa chart menumpuk (Key Level Agent Cryptophys).");
  return finish(lines, channel);
}

/** Pure: one pattern's text for one channel. */
export function patternText(p, analysis, { channel = "threads" } = {}) {
  const ref = p.chapter ? ` · katalog Bulkowski bab ${p.chapter}` : "";
  const lines = [];
  if (p.status === "forming") {
    lines.push(`Edukasi · Pola terbentuk · XAUUSD ${p.chart}`, `${p.name}${ref}`, "",
      `Garis atas ${f2(p.upper)} · garis bawah ${f2(p.lower)}`,
      `Pola terkonfirmasi naik bila candle ${p.chart} ditutup di atas ${f2(p.upper)}, atau turun bila ditutup di bawah ${f2(p.lower)}.`);
  } else {
    const up = p.direction === "up";
    const line = up ? p.upper : p.lower, undo = up ? p.lower : p.upper;
    lines.push(`Edukasi · Breakout pola · XAUUSD ${p.chart}`, `${p.name}${ref} · arah ${up ? "naik" : p.direction === "down" ? "turun" : "belum jelas"}`, "",
      `Garis breakout ${f2(line)}`,
      `Pola batal bila candle ${p.chart} ditutup kembali ${up ? "di bawah" : "di atas"} ${f2(undo)}.`);
    if (p.projection != null) lines.push(`Proyeksi ukuran pola: ${f2(p.projection)} (analisa, bukan sasaran transaksi).`);
  }
  if (analysis?.price != null) lines.push(`Harga saat dibaca: ${f2(analysis.price)} · ${hhmm(analysis.at)} UTC`);
  return finish(lines, channel);
}

/** Which patterns are posted: confirmed on H1, H4, D1; forming on H4 and D1. */
export function postablePatterns(analysis) {
  return (analysis?.patterns ?? []).filter((p) => (p.status === "confirmed" && ["H1", "H4", "D1"].includes(p.chart)) || (p.status === "forming" && ["H4", "D1"].includes(p.chart)));
}
const patternKey = (p) => `${p.chart}:${p.pattern}:${p.status}:${Math.round(p.upper)}:${Math.round(p.lower)}`;

function draft({ id, kind, channel, text, now }) {
  const guardian = checkContentDraft({ text, chart: false, decisionTimes: [], allowLevels: true, now });
  return { id, kind, channel, text, image_url: null, window: null, decision_times: [], guardian, status: !guardian.pass ? "blocked" : channel === "instagram" ? "needs_image" : "pending" };
}

/**
 * Pure: the drafts of one run. `postedToday` is how many pattern drafts each channel already has today;
 * `known` the pattern keys already drafted (so a pattern is posted once per status).
 */
export function analysisDrafts(analysis, { now = Date.now(), channels = CHANNELS, levelsRun = false, postedToday = {}, known = new Set() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  const out = [];
  for (const channel of channels.filter((c) => CHANNELS.includes(c))) {
    if (levelsRun) {
      const text = keyLevelsText(analysis, { channel });
      if (text) out.push(draft({ id: `levels:${day}:${channel}`, kind: "key_levels", channel, text, now }));
    }
    let room = MAX_PATTERN_DRAFTS_PER_DAY - (Number(postedToday[channel]) || 0);
    for (const p of postablePatterns(analysis)) {
      if (room <= 0) break;
      const id = `pattern:${patternKey(p)}:${channel}`;
      if (known.has(id)) continue;
      const text = patternText(p, analysis, { channel });
      if (!text) continue;
      out.push(draft({ id, kind: "pattern", channel, text, now }));
      room -= 1;
    }
  }
  return out;
}
