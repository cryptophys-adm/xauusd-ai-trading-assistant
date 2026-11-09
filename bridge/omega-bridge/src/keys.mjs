import crypto from "node:crypto";
import nodeFs from "node:fs";
import path from "node:path";

export const DEFAULT_STATE_DIR = "/var/lib/omega-bridge";

/**
 * Compute the 16-hex-character key identifier (kid) from SPKI DER bytes.
 * @param {Buffer | Uint8Array} spkiDer
 * @returns {string}
 */
export function computeKid(spkiDer) {
  return crypto.createHash("sha256").update(spkiDer).digest("hex").slice(0, 16);
}

/**
 * Extract SPKI DER, base64 public key, and kid from a private or public KeyObject.
 * @param {crypto.KeyObject | string | Buffer} keyInput
 */
export function exportPublicKeyInfo(keyInput) {
  const privateOrPublic =
    keyInput instanceof crypto.KeyObject ? keyInput : crypto.createPrivateKey(keyInput);
  const publicKey =
    privateOrPublic.type === "public" ? privateOrPublic : crypto.createPublicKey(privateOrPublic);
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const publicKeyBase64 = Buffer.from(spkiDer).toString("base64");
  const kid = computeKid(spkiDer);
  return {
    publicKey,
    spkiDer: Buffer.from(spkiDer),
    publicKeyBase64,
    public_key: publicKeyBase64,
    spkiBase64: publicKeyBase64,
    kid,
  };
}

/**
 * Load an existing RSA-3072 private key from `$OMEGA_STATE_DIR/key.pem`,
 * or generate and persist a new one with mode 0600.
 *
 * @param {string | { stateDir?: string, fs?: typeof nodeFs }} [stateDirOrOptions]
 * @param {{ fs?: typeof nodeFs }} [maybeOptions]
 */
export function loadOrCreateKeyPair(stateDirOrOptions, maybeOptions = {}) {
  let stateDir = process.env.OMEGA_STATE_DIR || DEFAULT_STATE_DIR;
  let fs = nodeFs;

  if (typeof stateDirOrOptions === "string" && stateDirOrOptions.length > 0) {
    stateDir = stateDirOrOptions;
    if (maybeOptions && maybeOptions.fs) fs = maybeOptions.fs;
  } else if (stateDirOrOptions && typeof stateDirOrOptions === "object") {
    if (typeof stateDirOrOptions.stateDir === "string" && stateDirOrOptions.stateDir.length > 0) {
      stateDir = stateDirOrOptions.stateDir;
    }
    if (stateDirOrOptions.fs) fs = stateDirOrOptions.fs;
  } else if (maybeOptions && maybeOptions.fs) {
    fs = maybeOptions.fs;
  }

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(stateDir, "key.pem");

  let privateKey;
  if (fs.existsSync(keyPath)) {
    const pem = fs.readFileSync(keyPath, "utf8");
    fs.chmodSync(keyPath, 0o600);
    privateKey = crypto.createPrivateKey(pem);
  } else {
    const generated = crypto.generateKeyPairSync("rsa", {
      modulusLength: 3072,
    });
    privateKey = generated.privateKey;
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const tmpPath = `${keyPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, pem, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, keyPath);
    fs.chmodSync(keyPath, 0o600);
  }

  const pubInfo = exportPublicKeyInfo(privateKey);
  return {
    privateKey,
    publicKey: pubInfo.publicKey,
    spkiDer: pubInfo.spkiDer,
    publicKeyBase64: pubInfo.publicKeyBase64,
    public_key: pubInfo.public_key,
    spkiBase64: pubInfo.spkiBase64,
    kid: pubInfo.kid,
    keyPath,
  };
}

export const loadOrCreateKeys = loadOrCreateKeyPair;
