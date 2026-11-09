import crypto from "node:crypto";

const STANDARD_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64Strict(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid envelope ${fieldName}: expected a non-empty base64 string`);
  }
  if (value.length % 4 !== 0 || !STANDARD_BASE64_RE.test(value)) {
    throw new Error(`Invalid envelope ${fieldName}: malformed standard base64`);
  }
  return Buffer.from(value, "base64");
}

function assertCredentialField(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid envelope payload: missing or empty ${fieldName}`);
  }
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`Invalid envelope payload: forbidden control characters in ${fieldName}`);
  }
}

/**
 * Open a WebCrypto-produced credential envelope using the bridge's RSA-3072 private key.
 * Never includes decrypted plaintext or credentials in any error message.
 *
 * @param {{ v: number, kid: string, wrapped_key: string, iv: string, ciphertext: string }} envelope
 * @param {crypto.KeyObject | string | Buffer} privateKey
 * @param {string} kid
 * @returns {{ server: string, login: string, password: string }}
 */
export function openEnvelope(envelope, privateKey, kid) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Invalid envelope: expected an object");
  }
  if (envelope.v !== 1) {
    throw new Error("Invalid envelope: unsupported version");
  }
  if (typeof kid !== "string" || kid.length === 0) {
    throw new Error("Invalid bridge key id (kid)");
  }
  if (typeof envelope.kid !== "string" || envelope.kid !== kid) {
    throw new Error("Envelope kid does not match bridge key id");
  }
  if (!privateKey) {
    throw new Error("Missing bridge private key");
  }

  const wrappedKeyBuf = decodeBase64Strict(envelope.wrapped_key, "wrapped_key");
  const ivBuf = decodeBase64Strict(envelope.iv, "iv");
  const ciphertextWithTag = decodeBase64Strict(envelope.ciphertext, "ciphertext");

  if (ivBuf.length !== 12) {
    throw new Error("Invalid envelope iv: expected 12 bytes");
  }
  if (ciphertextWithTag.length <= 16) {
    throw new Error("Invalid envelope ciphertext: too short to contain GCM tag");
  }

  const keyObj =
    privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey);

  let aesKey;
  try {
    aesKey = crypto.privateDecrypt(
      {
        key: keyObj,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      wrappedKeyBuf,
    );
  } catch {
    throw new Error("Envelope wrapped_key RSA-OAEP decryption failed");
  }

  let plainBuf;
  try {
    if (aesKey.length !== 32) {
      throw new Error("Invalid envelope wrapped_key: unwrapped key is not 32 bytes");
    }

    const body = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
    const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);

    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, ivBuf, {
        authTagLength: 16,
      });
      decipher.setAuthTag(authTag);
      plainBuf = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new Error("Envelope AES-GCM authentication or decryption failed");
    }

    let parsed;
    try {
      parsed = JSON.parse(plainBuf.toString("utf8"));
    } catch {
      throw new Error("Invalid envelope payload: malformed UTF-8 JSON");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid envelope payload: expected JSON object");
    }

    assertCredentialField(parsed.server, "server");
    assertCredentialField(parsed.login, "login");
    assertCredentialField(parsed.password, "password");

    return {
      server: parsed.server,
      login: parsed.login,
      password: parsed.password,
    };
  } finally {
    if (aesKey) aesKey.fill(0);
    if (plainBuf) plainBuf.fill(0);
  }
}
