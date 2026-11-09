// Omega broker credentials envelope (docs/OMEGA_BRIDGE_PROTOCOL.md), built in the browser with WebCrypto:
// AES-256-GCM over the UTF-8 JSON {server, login, password} (12-byte IV, 16-byte tag appended), and the
// raw AES key wrapped with RSA-OAEP SHA-256 to the bridge's public key. Only the bridge can open it.
// No dependencies; the tests import this file as is.

const b64 = (bytes) => { let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The bridge key id: the first 16 hex characters of sha256(SPKI DER). */
export async function keyId(publicKeySpkiBase64) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64(publicKeySpkiBase64)));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildEnvelope(publicKeySpkiBase64, kid, { server, login, password }) {
  if (await keyId(publicKeySpkiBase64) !== kid) throw new Error("the bridge key does not match its id");
  const publicKey = await crypto.subtle.importKey("spki", unb64(publicKeySpkiBase64), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify({ server, login, password }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, await crypto.subtle.exportKey("raw", aesKey));
  return { v: 1, kid, wrapped_key: b64(wrapped), iv: b64(iv), ciphertext: b64(ciphertext) };
}
