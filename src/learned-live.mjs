// Autonomous promotion of learned notes (owner 2026-11-13: "Apakah menyambungkan ini masih manual? Jika
// iya, buat agar autonomous"). Before, a note that the shadow knowledge arm found better
// (src/shadow-knowledge.mjs) waited for an owner PR to enter the bundled pack. Now, once an hour:
//   promote  a text item whose shadow verdict reads "better_than_active" (discovery better than the
//            agent's own opening, Holm-adjusted p < 0.05, the newest 100 bars no worse) goes live for
//            exactly what was tested: the tested agent(s), on the 1H chart (the shadow arm runs the 1H
//            room only), never the moderator or another chart;
//   retire   a live item leaves when (a) Aether's pack no longer carries it (a person rejected it), or
//            (b) the agent's scored 1H statements since the promotion are significantly worse than its
//            own control accuracy in the test (one-sided binomial p < 0.05, from 40 decided calls).
// Every change is stored in D1 `learned_live` (with the verdict it rests on) and told to the owner on
// Telegram. The live items join the bundled pack in every prompt that reads learned notes (still only
// with LEARNED_KNOWLEDGE_ENABLED), and the shadow arm stops spending calls on them.
// Switch: LEARNED_AUTO_PROMOTION = "on" (default) | "off" (nothing promoted; live items retire at once).
import { LEARNED_PACK } from "./learned-knowledge.mjs";
import { storedPack } from "./aether-pack.mjs";
import { tally } from "./shadow-versions.mjs";

export const LEARNED_LIVE_VERSION = "cryptophys.learned-live.v1";
export const LIVE_RULES = Object.freeze({ chart: "60", min_decided: 40, alpha: 0.05, cache_ms: 5 * 60_000 });
const TEXT_KINDS = new Set(["caution", "role_reminder"]);
const PRICE = /\b\d{3,}(?:[.,]\d+)?\b/;
const ORDER = /\b(?:buy|sell|long|short|entry|stop[- ]?loss|take[- ]?profit|lot|leverage|position size)\b/i;

export function learnedAutoPromotion(env) {
  return String(env?.LEARNED_AUTO_PROMOTION ?? "on").trim().toLowerCase() === "off" ? "off" : "on";
}

export const LEARNED_LIVE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS learned_live (
    item_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    item_json TEXT NOT NULL,
    verdict_json TEXT NOT NULL,
    promoted_at TEXT NOT NULL,
    retired_at TEXT,
    reason TEXT,
    PRIMARY KEY (item_id, version)
  )`
];
let schemaReady = false;
let cache = null;
export function resetLearnedLiveForTests() { schemaReady = false; cache = null; }
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of LEARNED_LIVE_SCHEMA_SQL) await db.prepare(sql).run();
  schemaReady = true;
}

/** Pure: why a live item may not be used (empty when it may): text kind, plain words, no levels, a narrow audience. */
export function liveItemProblems(it) {
  if (!it || typeof it !== "object") return ["not_an_object"];
  const out = [];
  if (!TEXT_KINDS.has(it.kind)) out.push("kind_not_text");
  if (typeof it.item_id !== "string" || !/^[a-z0-9][a-z0-9_.:-]{2,95}$/.test(it.item_id)) out.push("item_id_invalid");
  if (!Number.isInteger(it.version) || it.version < 1) out.push("version_invalid");
  const agents = it.audience?.agents;
  if (!Array.isArray(agents) || !agents.length || agents.includes("moderator") || !agents.every((a) => typeof a === "string" && /^[a-z0-9][a-z0-9_-]{1,39}$/.test(a))) out.push("audience_invalid");
  if (JSON.stringify(it.audience?.charts) !== JSON.stringify([LIVE_RULES.chart])) out.push("audience_charts_invalid");
  const text = typeof it.text === "string" ? it.text.trim() : "";
  if (!text || text.length > 400) out.push("text_length");
  if (PRICE.test(text)) out.push("text_price_like_number");
  if (ORDER.test(text)) out.push("text_order_wording");
  return out;
}

/** Pure: P(X <= k) for X ~ Binomial(n, p): how unlikely so few right calls are at the tested rate. */
export function binomialLower(k, n, p) {
  if (n <= 0) return 1;
  let term = Math.pow(1 - p, n), sum = term;
  for (let i = 1; i <= k; i++) { term *= ((n - i + 1) / i) * (p / (1 - p)); sum += term; }
  return Math.min(1, sum);
}

/**
 * Pure: the promotions and retirements from the shadow verdicts (compareShadowKnowledge candidates), the
 * pack's items, the live items and each live item's scored statements since its promotion
 * ({ [item_id@version]: [{ stance, result }] }).
 */
export function planPromotions({ candidates = [], packItems = [], live = [], retired = [], scored = {}, now = Date.now(), rules = LIVE_RULES } = {}) {
  const key = (id, v) => `${id}@${v}`;
  // A retired version never comes back by itself: a new version of the item is a new test.
  const liveKeys = new Set([...live, ...retired].map((l) => key(l.item_id, l.version)));
  const inPack = new Map(packItems.map((it) => [key(it.item_id, it.version), it]));
  const promote = [], retire = [];
  // Every agent an item was found better for (one subject per agent).
  const better = new Map();
  for (const c of candidates) {
    if (!String(c.verdict ?? "").startsWith("better_than_active") || !c.item_id || !c.agent) continue;
    const k = key(c.item_id, c.item_version);
    better.set(k, [...(better.get(k) || []), c]);
  }
  for (const [k, list] of better) {
    if (liveKeys.has(k)) continue;
    const it = inPack.get(k);
    if (!it || !TEXT_KINDS.has(it.kind)) continue;
    const item = {
      item_id: it.item_id, version: it.version, kind: it.kind, label: "learned",
      audience: { agents: [...new Set(list.map((c) => c.agent))].sort(), charts: [rules.chart] },
      situation: { ...(it.situation || {}), chart: rules.chart }, text: String(it.text ?? "").trim(),
      content_sha256: it.content_sha256 ?? null,
      review: { shadow_verdict: list[0].verdict, promoted_on: new Date(now).toISOString().slice(0, 10), auto: true }
    };
    if (liveItemProblems(item).length) continue;
    const verdict = list.map((c) => ({ agent: c.agent, discovery: c.discovery, holdout: c.holdout, paired: c.paired }));
    promote.push({ item, verdict });
  }
  for (const l of live) {
    const k = key(l.item_id, l.version);
    if (!inPack.has(k)) { retire.push({ ...l, reason: "no longer in Aether's pack (a person rejected it, or Aether withdrew it)" }); continue; }
    const t = tally(scored[k] || []);
    const decided = t.directional.hit + t.directional.miss + t.wait.hit + t.wait.missed_opportunity;
    const right = t.directional.hit + t.wait.hit;
    const base = Math.min(...(l.verdict || []).map((v) => Number(v.discovery?.control_accuracy)).filter(Number.isFinite));
    if (decided < rules.min_decided || !Number.isFinite(base) || base <= 0 || base >= 1) continue;
    const p = binomialLower(right, decided, base);
    if (p < rules.alpha) retire.push({ ...l, reason: `worse live: ${right} of ${decided} decided calls right since the promotion, against ${Math.round(base * 100)}% in the test (p ${Math.round(p * 1000) / 1000})` });
  }
  return { promote, retire };
}

async function liveRows(db) {
  await ensureSchema(db);
  const rows = (await db.prepare("SELECT item_id, version, item_json, verdict_json, promoted_at FROM learned_live WHERE status = 'live' ORDER BY promoted_at").all()).results || [];
  return rows.map((r) => {
    let item = null, verdict = [];
    try { item = JSON.parse(r.item_json); } catch { item = null; }
    try { verdict = JSON.parse(r.verdict_json); } catch { verdict = []; }
    return { item_id: r.item_id, version: Number(r.version), item, verdict, promoted_at: r.promoted_at };
  }).filter((r) => r.item);
}

/** The live items (for the prompts and the shadow arm), cached a few minutes per isolate. Never throws. */
export async function liveItems(env, { now = Date.now() } = {}) {
  if (!env?.DB || learnedAutoPromotion(env) === "off") return [];
  if (cache && now - cache.at < LIVE_RULES.cache_ms) return cache.items;
  try { cache = { at: now, items: (await liveRows(env.DB)).map((r) => r.item) }; } catch { cache = { at: now, items: [] }; }
  return cache.items;
}

/** The item versions the shadow arm no longer tests: live ones (now in the agent's own opening) and retired ones. */
export async function promotedKeys(env) {
  if (!env?.DB) return new Set();
  try {
    await ensureSchema(env.DB);
    return new Set(((await env.DB.prepare("SELECT item_id, version FROM learned_live").all()).results || []).map((r) => `${r.item_id}@${r.version}`));
  } catch { return new Set(); }
}

/** The pack the prompts read: the bundled learned pack (owner PRs) and the autonomously promoted items. */
export async function effectiveLearnedPack(env, { now = Date.now(), bundled = LEARNED_PACK } = {}) {
  const live = await liveItems(env, { now });
  if (!live.length) return bundled;
  const ids = new Set((bundled?.items || []).map((it) => `${it.item_id}@${it.version}`));
  const extra = live.filter((it) => !ids.has(`${it.item_id}@${it.version}`));
  return { ...bundled, version: `${bundled?.version ?? "bundled"}+live`, items: [...(bundled?.items || []), ...extra], live_items: extra.length };
}

/** Pure: the owner's Telegram line for the changes of one run (null when nothing changed). */
export function promotionMessage({ promoted = [], retired = [] } = {}) {
  if (!promoted.length && !retired.length) return null;
  const lines = ["🧠 Learned notes (autonomous)"];
  for (const p of promoted) lines.push(`+ live: ${p.item.item_id} v${p.item.version} for ${p.item.audience.agents.join(", ")} on the 1H room: better than the agent's own opening in shadow (${p.verdict.map((v) => `p_holm ${v.discovery?.p_holm ?? "?"}`).join(", ")}).`);
  for (const r of retired) lines.push(`− retired: ${r.item_id} v${r.version}: ${r.reason}.`);
  return lines.join("\n");
}

/**
 * Hourly (the parity sweep, after the pack pull): promote and retire. `knowledge` is readShadowKnowledge's
 * result. Never throws; returns what changed and the Telegram line.
 */
export async function runLearnedPromotion(env, { knowledge, now = Date.now() } = {}) {
  if (!env?.DB) return { status: "unavailable" };
  try {
    await ensureSchema(env.DB);
    const at = new Date(now).toISOString();
    const live = await liveRows(env.DB);
    if (learnedAutoPromotion(env) === "off") {
      for (const l of live) await env.DB.prepare("UPDATE learned_live SET status = 'retired', retired_at = ?, reason = ? WHERE item_id = ? AND version = ? AND status = 'live'").bind(at, "autonomous promotion switched off", l.item_id, l.version).run();
      cache = null;
      return { status: "disabled", retired: live.length, message: promotionMessage({ retired: live.map((l) => ({ ...l, reason: "autonomous promotion switched off" })) }) };
    }
    let stored = null;
    try { stored = await storedPack(env); } catch { stored = null; }
    // Without a stored pack (Aether never reached), nothing is promoted and nothing is retired for absence.
    if (!stored?.pack) return { status: "no_pack", live: live.length };
    const scored = {};
    for (const l of live) {
      const rows = [];
      for (const agent of l.item.audience.agents) {
        const r = (await env.DB.prepare("SELECT stance, result FROM outcome_scores WHERE subject = ? AND timeframe = ? AND statement_close >= ?").bind(`agent:${agent}`, LIVE_RULES.chart, l.promoted_at).all()).results || [];
        rows.push(...r);
      }
      scored[`${l.item_id}@${l.version}`] = rows;
    }
    const retired = (await env.DB.prepare("SELECT item_id, version FROM learned_live WHERE status = 'retired'").all()).results || [];
    const plan = planPromotions({ candidates: knowledge?.candidates || [], packItems: stored.pack.items || [], live, retired: retired.map((r) => ({ item_id: r.item_id, version: Number(r.version) })), scored, now });
    for (const p of plan.promote) {
      await env.DB.prepare("INSERT INTO learned_live (item_id, version, status, item_json, verdict_json, promoted_at) VALUES (?, ?, 'live', ?, ?, ?) ON CONFLICT(item_id, version) DO NOTHING")
        .bind(p.item.item_id, p.item.version, JSON.stringify(p.item), JSON.stringify(p.verdict), at).run();
    }
    for (const r of plan.retire) {
      await env.DB.prepare("UPDATE learned_live SET status = 'retired', retired_at = ?, reason = ? WHERE item_id = ? AND version = ? AND status = 'live'").bind(at, r.reason.slice(0, 300), r.item_id, r.version).run();
    }
    if (plan.promote.length || plan.retire.length) cache = null;
    return { status: "ok", promoted: plan.promote.length, retired: plan.retire.length, live: live.length + plan.promote.length - plan.retire.length, message: promotionMessage({ promoted: plan.promote, retired: plan.retire }) };
  } catch (e) { return { status: "failed", error: String(e?.message ?? e).slice(0, 200) }; }
}

/** For /api/tuning and the Aether page: the live items and the recent retirements. */
export async function readLearnedLive(env) {
  if (!env?.DB) return null;
  await ensureSchema(env.DB);
  const rows = (await env.DB.prepare("SELECT item_id, version, status, item_json, promoted_at, retired_at, reason FROM learned_live ORDER BY promoted_at DESC LIMIT 30").all()).results || [];
  return {
    version: LEARNED_LIVE_VERSION, mode: learnedAutoPromotion(env), rules: { ...LIVE_RULES },
    items: rows.map((r) => { let it = {}; try { it = JSON.parse(r.item_json); } catch { it = {}; } return { item_id: r.item_id, version: r.version, status: r.status, agents: it.audience?.agents ?? [], chart: it.audience?.charts?.[0] ?? null, text: it.text ?? null, promoted_at: r.promoted_at, retired_at: r.retired_at, reason: r.reason }; })
  };
}
