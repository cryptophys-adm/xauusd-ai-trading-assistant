// xauusd-content: the content engine (content roadmap P2, docs/RFC_CONTENT_AGENT.md; owner 2026-11-14:
// "persiapan engine post ke Instagram/threads"). Prepared, not publishing:
//   - drafts: Tuesday to Saturday the previous trading day's recap, from the AI Worker's public projection only
//     (PROJECTION.recaps), in fixed Indonesian templates (src/drafts.mjs), each checked by the content guardian;
//   - approval: every draft waits in the ContentDesk queue for a person (Nexus, over ContentApi); an approval
//     runs the guardian again;
//   - publishing: Threads (text) and Instagram (an image post; its image is the next step), only while
//     CONTENT_PUBLISH is "on" and the account is configured. It is "off": an approved draft waits.
// No public URL. The account tokens are Worker secrets set by the deploy workflow from GitHub secrets
// (THREADS_ACCESS_TOKEN, THREADS_USER_ID, INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_USER_ID); refreshed tokens are kept
// in the desk's storage. No token ever leaves this Worker or appears in an answer.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { dailyDrafts, CHANNELS } from "./drafts.mjs";
import { addDrafts, listDrafts, getDraft, draftEvents, decideDraft, recordPublish, deskCounts, storedToken, storeToken, draftIdsWithPrefix, kindCountsSince } from "./desk.mjs";
import { analysisDrafts } from "./analysis-drafts.mjs";
import { publishThreads, publishInstagram, publishingQuota, refreshToken, REFRESH_AFTER_DAYS } from "./publishers.mjs";

const publishOn = (env) => String(env?.CONTENT_PUBLISH ?? "off").trim().toLowerCase() === "on";
const channelsOf = (env) => String(env?.CONTENT_CHANNELS ?? CHANNELS.join(",")).split(",").map((c) => c.trim()).filter((c) => CHANNELS.includes(c));
const delayOf = (env) => { const n = Number(env?.PUBLIC_DELAY_HOURS ?? 24); return Number.isFinite(n) && n >= 1 ? n : 24; };
const SECRETS = Object.freeze({ threads: ["THREADS_ACCESS_TOKEN", "THREADS_USER_ID"], instagram: ["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_USER_ID"] });

/** The queue: one Durable Object (SQLite storage), named "desk". */
export class ContentDesk extends DurableObject {
  get sql() { return this.ctx.storage.sql; }
  async add(drafts, now) { return addDrafts(this.sql, drafts, { now }); }
  async list(input) { return listDrafts(this.sql, input ?? {}); }
  async get(id) { const d = getDraft(this.sql, id); return d ? { ...d, events: draftEvents(this.sql, id) } : null; }
  async decide(input, now) { return decideDraft(this.sql, input, { now }); }
  async published(input, now) { return recordPublish(this.sql, input, { now }); }
  async counts() { return deskCounts(this.sql); }
  async token(channel) { return storedToken(this.sql, channel); }
  async saveToken(channel, token, now) { storeToken(this.sql, channel, token, { now }); return true; }
  async idsWithPrefix(prefix) { return draftIdsWithPrefix(this.sql, prefix); }
  async kindCounts(kind, sinceIso) { return kindCountsSince(this.sql, kind, sinceIso); }
}
const desk = (env) => env.CONTENT_DESK.get(env.CONTENT_DESK.idFromName("desk"));

/** The account of a channel: the desk's refreshed token when it has one, else the secret. Never returned to a caller. */
async function accountOf(env, channel) {
  const [tokenVar, userVar] = SECRETS[channel] ?? [];
  const stored = await desk(env).token(channel).catch(() => null);
  const access_token = stored?.access_token || env?.[tokenVar] || null;
  const user_id = env?.[userVar] || null;
  return access_token && user_id ? { access_token, user_id, refreshed_at: stored?.refreshed_at ?? null } : null;
}

/** Publishes one approved draft now, when publishing is on. Never throws. */
export async function publishDraft(env, draft, { now = Date.now(), fetcher } = {}) {
  if (!publishOn(env)) return { status: "approved", held: "publishing_off" };
  if (draft?.status !== "approved") return { status: draft?.status ?? "missing", held: "not_approved" };
  const account = await accountOf(env, draft.channel);
  if (!account) return { status: "approved", held: "account_not_configured" };
  try {
    const r = draft.channel === "threads"
      ? await publishThreads({ account, text: draft.text, fetcher })
      : await publishInstagram({ account, caption: draft.text, imageUrl: draft.image_url, fetcher });
    return desk(env).published({ id: draft.id, remoteId: r.remote_id }, now);
  } catch (error) {
    return desk(env).published({ id: draft.id, error: String(error?.message ?? error) }, now);
  }
}

/** The day's drafts from the public projection, queued once. */
export async function draftDay(env, { now = Date.now() } = {}) {
  const projection = await env.PROJECTION.recaps({ days: 3 });
  const { summary, drafts } = dailyDrafts(projection?.recaps ?? [], { now, channels: channelsOf(env), delayHours: delayOf(env) });
  const added = drafts.length ? await desk(env).add(drafts, now) : [];
  return { bars: summary.bars, drafts: drafts.map((d) => ({ id: d.id, status: d.status, guardian_pass: d.guardian.pass })), added };
}

/** The real-time analysis drafts (key-level map at 06 UTC, pattern posts every hour), queued once. */
export const RECAP_CRON = "17 22 * * 2-6";
export const ANALYSIS_CRON = "9 * * * 1-5";
export async function draftAnalysis(env, { now = Date.now() } = {}) {
  const analysis = await env.PROJECTION.analysis();
  const d = desk(env);
  const known = new Set(await d.idsWithPrefix("pattern:"));
  const postedToday = await d.kindCounts("pattern", new Date(now).toISOString().slice(0, 10));
  const drafts = analysisDrafts(analysis, { now, channels: channelsOf(env), levelsRun: new Date(now).getUTCHours() === 6, postedToday, known });
  const added = drafts.length ? await d.add(drafts, now) : [];
  return { zones: analysis?.zones?.length ?? 0, patterns: analysis?.patterns?.length ?? 0, drafts: drafts.map((x) => ({ id: x.id, status: x.status })), added };
}

/** Refreshes a channel's long-lived token when it is older than REFRESH_AFTER_DAYS (only while publishing is on). */
async function refreshTokens(env, { now = Date.now() } = {}) {
  if (!publishOn(env)) return { status: "publishing_off" };
  const out = {};
  for (const channel of channelsOf(env)) {
    const account = await accountOf(env, channel);
    if (!account) { out[channel] = "not_configured"; continue; }
    const age = account.refreshed_at ? now - Date.parse(account.refreshed_at) : Infinity;
    if (age < REFRESH_AFTER_DAYS * 86_400_000) { out[channel] = "fresh"; continue; }
    try { await desk(env).saveToken(channel, await refreshToken({ channel, token: account.access_token }), now); out[channel] = "refreshed"; }
    catch (e) { out[channel] = `failed: ${String(e?.message ?? e).slice(0, 120)}`; }
  }
  return out;
}

/** Nexus's door (Service Binding, behind Cloudflare Access there): the queue, a decision, a dry run, the status. */
export class ContentApi extends WorkerEntrypoint {
  async drafts(input) { return { drafts: await desk(this.env).list(input ?? {}), counts: await desk(this.env).counts() }; }
  async draft(id) { return desk(this.env).get(String(id ?? "")); }
  /** { id, decision: "approve" | "reject", actor, reason }. An approved draft is published at once only while publishing is on. */
  async decide(input) {
    const now = Date.now();
    const r = await desk(this.env).decide({ ...(input ?? {}), delayHours: delayOf(this.env) }, now);
    if (!r.ok || r.status !== "approved") return r;
    return { ...r, publish: await publishDraft(this.env, await desk(this.env).get(r.id), { now }) };
  }
  /** The requests a draft would send, with the token replaced (never sends anything). */
  async preview(id) {
    const d = await desk(this.env).get(String(id ?? ""));
    if (!d) return { ok: false, error: "no such draft" };
    const account = { user_id: "<user>", access_token: "[token]" };
    const plan = d.channel === "threads" ? await publishThreads({ account, text: d.text, dryRun: true }) : await publishInstagram({ account, caption: d.text, imageUrl: d.image_url, dryRun: true });
    return { ok: true, id: d.id, channel: d.channel, ...plan };
  }
  async status() {
    const accounts = {};
    for (const c of CHANNELS) {
      const a = await accountOf(this.env, c);
      accounts[c] = { configured: Boolean(a), refreshed_at: a?.refreshed_at ?? null, quota: a && publishOn(this.env) ? await publishingQuota({ channel: c, account: a }) : null };
    }
    return { publish: publishOn(this.env) ? "on" : "off", channels: channelsOf(this.env), threads_handle: this.env?.THREADS_HANDLE ?? null, delay_hours: delayOf(this.env), accounts, counts: await desk(this.env).counts() };
  }
  /** Drafts now (the same as the scheduled runs): the recap and the analysis. */
  async draftNow() { return { recap: await draftDay(this.env), analysis: await draftAnalysis(this.env) }; }
}

/** The platform's health read (ADR-0013 external organ; bound by the platform as EXT_XAUUSD_CONTENT). */
export class ContentHealth extends WorkerEntrypoint {
  async health() {
    try { return { ok: true, service: "xauusd-content", publish: publishOn(this.env) ? "on" : "off", counts: await desk(this.env).counts() }; }
    catch (e) { return { ok: false, service: "xauusd-content", error: String(e?.message ?? e).slice(0, 200) }; }
  }
}

export default {
  async fetch() {
    // No public surface: everything goes through ContentApi and ContentHealth.
    return new Response("Not found", { status: 404 });
  },
  async scheduled(event, env, ctx) {
    const fail = (e) => ({ status: "error", message: String(e?.message ?? e).slice(0, 200) });
    if (event?.cron === ANALYSIS_CRON) {
      const drafted = await draftAnalysis(env, { now: event.scheduledTime || Date.now() }).catch(fail);
      if (drafted?.added?.length || drafted?.status === "error") console.log("content_analysis_drafts", JSON.stringify(drafted));
      return;
    }
    const drafted = await draftDay(env).catch(fail);
    console.log("content_drafts", JSON.stringify(drafted));
    const tokens = await refreshTokens(env).catch((e) => ({ status: "error", message: String(e?.message ?? e).slice(0, 200) }));
    if (tokens?.status !== "publishing_off") console.log("content_tokens", JSON.stringify(tokens));
  }
};
