// Owner notifications from the Cerebrum kernel to the owner's Telegram (owner 2026-11-11: "buat notif
// telegram jika ada yang perlu approve owner di semua cerebrum"). The platform holds no Telegram
// credential; this Worker already does (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID). The kernel calls the
// RPC entrypoint OwnerNotifier over a Service Binding (cryptophys-ai-kernel, binding OWNER_TELEGRAM).
// The message is plain text built here from bounded fields: no HTML, links only to the Cerebrum
// Console, at most OWNER_NOTIFY_MAX_PER_HOUR messages an hour. No price, size or credential.

export const OWNER_NOTIFY_MAX_PER_HOUR = 12;
const CONSOLE_PREFIX = "https://nexus.cryptophys.work/console/";
const CHANGES = Object.freeze({ opened: "needs you", changed: "updated", closed: "resolved" });
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, n);

/** Pure: the Telegram text of a notice, or null when the input is not a valid owner notice. */
export function ownerNoticeText(input) {
  if (!input || typeof input !== "object") return null;
  const change = Object.hasOwn(CHANGES, input.change) ? input.change : null;
  const title = clean(input.title, 200);
  if (!change || !title) return null;
  const link = typeof input.link === "string" && input.link.startsWith(CONSOLE_PREFIX) && input.link.length <= 300 ? input.link : CONSOLE_PREFIX;
  const lines = (Array.isArray(input.lines) ? input.lines : []).slice(0, 10).map((l) => clean(l, 300)).filter(Boolean);
  const more = Array.isArray(input.lines) && input.lines.length > 10 ? [`… and ${input.lines.length - 10} more`] : [];
  const head = change === "closed" ? `✅ Cerebrum: ${title} (${CHANGES[change]})` : `🔔 Cerebrum ${CHANGES[change]}: ${title}`;
  return [head, ...(change === "closed" ? [] : [...lines.map((l) => `• ${l}`), ...more]), "", `Console: ${link}`].join("\n").slice(0, 3500);
}

/** Sends one notice. Returns { sent } or { sent: false, reason }. Never throws. */
export async function notifyOwner(env, input, { now = Date.now(), send } = {}) {
  const text = ownerNoticeText(input);
  if (!text) return { sent: false, reason: "invalid_notice" };
  if (!env?.TELEGRAM_BOT_TOKEN || !env?.TELEGRAM_CHAT_ID) return { sent: false, reason: "telegram_not_configured" };
  const hourKey = `owner-notify:count:${new Date(now).toISOString().slice(0, 13)}`;
  let count = 0;
  try { count = Number(await env.SIGNAL_CACHE?.get?.(hourKey)) || 0; } catch { count = 0; }
  if (count >= OWNER_NOTIFY_MAX_PER_HOUR) return { sent: false, reason: "rate_limited" };
  try {
    await send(text);
    try { await env.SIGNAL_CACHE?.put?.(hourKey, String(count + 1), { expirationTtl: 7200 }); } catch { /* best effort */ }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: String(e?.message ?? e).slice(0, 120) };
  }
}
