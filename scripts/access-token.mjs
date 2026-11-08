// Cloudflare Access service-token headers for the deploy smoke tests (CI only, never a Worker).
// Normalises the repository secrets CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET the way the
// platform's access-headers.sh does: strips CR/LF, surrounding whitespace and an accidental
// "CF-Access-Client-Id:" / "CF-Access-Client-Secret:" prefix. `shape` describes the values
// without revealing them, for an error message when Access refuses the token.

const clean = (value, header) =>
  String(value ?? "").replace(/[\r\n]/g, "").replace(new RegExp(`^\\s*(${header}:)?\\s*`, "i"), "").replace(/\s+$/, "");

/** @returns {{ headers: Record<string, string> | null, problems: string[], shape: string }} */
export function accessToken(env = process.env) {
  const rawId = env.CF_ACCESS_CLIENT_ID, rawSecret = env.CF_ACCESS_CLIENT_SECRET;
  if (!rawId && !rawSecret) return { headers: null, problems: [], shape: "not set" };
  const id = clean(rawId, "CF-Access-Client-Id"), secret = clean(rawSecret, "CF-Access-Client-Secret");
  const problems = [];
  if (!id || !secret) problems.push("set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET");
  if (id.startsWith("cfast_") || secret.endsWith(".access")) problems.push("the two secrets look swapped (the Client ID ends with .access; a new Client Secret starts with cfast_)");
  else if (id && !id.endsWith(".access")) problems.push("CF_ACCESS_CLIENT_ID should be the token's Client ID, which ends with .access");
  if (/\s/.test(id) || /\s/.test(secret)) problems.push("a value contains whitespace inside it");
  const parts = [
    `Client ID length ${id.length}${id.endsWith(".access") ? ", ends with .access" : ""}`,
    `Client Secret length ${secret.length}${secret.startsWith("cfast_") ? ", cfast_ format" : ""}`
  ];
  if (id !== rawId || secret !== rawSecret) parts.push("whitespace or a header prefix was removed");
  return { headers: problems.length ? null : { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret }, problems, shape: parts.join("; ") };
}

/** True when a manual-redirect response is Cloudflare Access sending the client to its login page. */
export function isAccessLogin(response) {
  const location = response.headers.get("location") || "";
  return response.status >= 300 && response.status < 400 && /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\//.test(location);
}
