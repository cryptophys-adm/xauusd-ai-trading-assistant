// Publishers for Threads and Instagram (content roadmap P2). Both use Meta's two-step flow: create a media
// container, then publish it. The token travels in the POST body; the GET reads (status, quota, refresh) carry
// it as a query parameter as Meta expects, and this Worker never logs a request URL. Each
// call can run as a dry run: the requests it would send, with the token replaced by "[token]".
//
// Not verified against Meta's own pages from here (developers.facebook.com was unreachable from the build
// session): the endpoint shapes below follow the published guides. Before CONTENT_PUBLISH is turned on, one
// dry run and one real post on a test account confirm them. The daily publishing limit is read from Meta's own
// limit endpoint at run time, never assumed.
export const THREADS_BASE = "https://graph.threads.net/v1.0";
export const INSTAGRAM_BASE = "https://graph.instagram.com";
const STATUS_POLLS = 5;

const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]));
const redact = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === "access_token" ? "[token]" : v]));

async function call(fetcher, method, url, params) {
  const res = method === "GET"
    ? await fetcher(`${url}?${form(params)}`, { method: "GET" })
    : await fetcher(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(params) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || body?.error) {
    const e = new Error(`${res.status} ${String(body?.error?.message ?? "request failed").slice(0, 200)}`);
    e.status = res.status; e.code = body?.error?.code ?? null;
    throw e;
  }
  return body;
}

/** Waits until a container is ready (Threads: status FINISHED; Instagram: status_code FINISHED). */
async function waitReady(fetcher, url, token, field, { sleep, polls = STATUS_POLLS }) {
  for (let i = 0; i < polls; i++) {
    const s = await call(fetcher, "GET", url, { fields: field, access_token: token });
    const v = String(s?.[field] ?? "").toUpperCase();
    if (v === "FINISHED" || v === "PUBLISHED") return v;
    if (v === "ERROR" || v === "EXPIRED") throw new Error(`container ${v.toLowerCase()}`);
    await sleep(i === 0 ? 2_000 : 5_000);
  }
  throw new Error("container not ready in time");
}

/**
 * One Threads text post. `account` is { user_id, access_token }. Returns { remote_id } (the published post's id),
 * or { dry_run: true, requests } when `dryRun`.
 */
export async function publishThreads({ account, text, fetcher = (...a) => fetch(...a), dryRun = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const uid = String(account?.user_id ?? "");
  const create = { url: `${THREADS_BASE}/${uid}/threads`, params: { media_type: "TEXT", text, access_token: account?.access_token } };
  const publish = { url: `${THREADS_BASE}/${uid}/threads_publish`, params: { creation_id: "<container>", access_token: account?.access_token } };
  if (dryRun) return { dry_run: true, requests: [create, publish].map((r) => ({ method: "POST", url: r.url, params: redact(r.params) })) };
  if (!uid || !account?.access_token) throw new Error("threads account not configured");
  const container = await call(fetcher, "POST", create.url, create.params);
  await waitReady(fetcher, `${THREADS_BASE}/${container.id}`, account.access_token, "status", { sleep });
  const post = await call(fetcher, "POST", publish.url, { ...publish.params, creation_id: container.id });
  return { remote_id: String(post.id), container_id: String(container.id) };
}

/**
 * One Instagram image post (Instagram has no text-only post). `imageUrl` must be a public JPEG URL.
 * Returns { remote_id }, or { dry_run: true, requests } when `dryRun`.
 */
export async function publishInstagram({ account, caption, imageUrl, fetcher = (...a) => fetch(...a), dryRun = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const uid = String(account?.user_id ?? "");
  const create = { url: `${INSTAGRAM_BASE}/${uid}/media`, params: { image_url: imageUrl, caption, access_token: account?.access_token } };
  const publish = { url: `${INSTAGRAM_BASE}/${uid}/media_publish`, params: { creation_id: "<container>", access_token: account?.access_token } };
  if (dryRun) return { dry_run: true, requests: [create, publish].map((r) => ({ method: "POST", url: r.url, params: redact(r.params) })) };
  if (!uid || !account?.access_token) throw new Error("instagram account not configured");
  if (!/^https:\/\//.test(String(imageUrl ?? ""))) throw new Error("instagram needs a public https image URL");
  const container = await call(fetcher, "POST", create.url, create.params);
  await waitReady(fetcher, `${INSTAGRAM_BASE}/${container.id}`, account.access_token, "status_code", { sleep });
  const post = await call(fetcher, "POST", publish.url, { ...publish.params, creation_id: container.id });
  return { remote_id: String(post.id), container_id: String(container.id) };
}

/** Today's publishing quota as Meta reports it: { used, total } or null when it cannot be read. */
export async function publishingQuota({ channel, account, fetcher = (...a) => fetch(...a) }) {
  const uid = String(account?.user_id ?? "");
  if (!uid || !account?.access_token) return null;
  const url = channel === "threads" ? `${THREADS_BASE}/${uid}/threads_publishing_limit` : `${INSTAGRAM_BASE}/${uid}/content_publishing_limit`;
  try {
    const body = await call(fetcher, "GET", url, { fields: "quota_usage,config", access_token: account.access_token });
    const row = Array.isArray(body?.data) ? body.data[0] : body;
    const used = Number(row?.quota_usage), total = Number(row?.config?.quota_total);
    return Number.isFinite(used) ? { used, total: Number.isFinite(total) ? total : null } : null;
  } catch { return null; }
}

/**
 * A refreshed long-lived token (each lasts about 60 days; refreshed when older than REFRESH_AFTER_DAYS).
 * Returns { access_token, expires_in } or throws.
 */
export const REFRESH_AFTER_DAYS = 30;
export async function refreshToken({ channel, token, fetcher = (...a) => fetch(...a) }) {
  const url = channel === "threads" ? "https://graph.threads.net/refresh_access_token" : `${INSTAGRAM_BASE}/refresh_access_token`;
  const body = await call(fetcher, "GET", url, { grant_type: channel === "threads" ? "th_refresh_token" : "ig_refresh_token", access_token: token });
  if (!body?.access_token) throw new Error("no token in the refresh answer");
  return { access_token: String(body.access_token), expires_in: Number(body.expires_in) || null };
}
