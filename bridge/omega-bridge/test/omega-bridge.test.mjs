import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadOrCreateKeyPair, computeKid } from "../src/keys.mjs";
import { openEnvelope } from "../src/envelope.mjs";
import { applyCredentials, clearCredentials } from "../src/ini.mjs";
import {
  readState,
  writeIntents,
  consumeResults,
} from "../src/files.mjs";
import { createDaemon } from "../src/daemon.mjs";

const { subtle } = crypto.webcrypto;

function makeTempDir(prefix = "omega-bridge-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Build a WebCrypto envelope exactly as the browser does:
 * - import SPKI DER base64 public key for RSA-OAEP (SHA-256)
 * - generate a random 32-byte AES-256-GCM key and 12-byte IV
 * - AES-GCM encrypt UTF-8 JSON {"server","login","password"} (16-byte tag appended by WebCrypto)
 * - RSA-OAEP encrypt the raw 32-byte AES key
 */
async function buildBrowserEnvelope(publicKeyBase64, kid, payloadObj) {
  const spkiDer = Buffer.from(publicKeyBase64, "base64");
  const rsaPubKey = await subtle.importKey(
    "spki",
    spkiDer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );

  const aesKey = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawAesBytes = new Uint8Array(await subtle.exportKey("raw", aesKey));
  assert.equal(rawAesBytes.byteLength, 32);

  const iv = crypto.randomBytes(12);
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(payloadObj));

  const cipherBuffer = await subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    plaintextBytes,
  );
  const wrappedKeyBuffer = await subtle.encrypt({ name: "RSA-OAEP" }, rsaPubKey, rawAesBytes);

  return {
    v: 1,
    kid,
    wrapped_key: Buffer.from(wrappedKeyBuffer).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
    ciphertext: Buffer.from(cipherBuffer).toString("base64"),
  };
}

test("keys: creates RSA-3072 key.pem with mode 0600 and reloads idempotently", () => {
  const tmpDir = makeTempDir();
  try {
    const first = loadOrCreateKeyPair(tmpDir);
    assert.ok(fs.existsSync(first.keyPath));

    const stat = fs.statSync(first.keyPath);
    assert.equal(stat.mode & 0o777, 0o600, "key.pem must have mode 0600");
    assert.match(first.kid, /^[0-9a-f]{16}$/);
    assert.equal(first.kid, computeKid(Buffer.from(first.publicKeyBase64, "base64")));

    const details = first.publicKey.asymmetricKeyDetails;
    assert.equal(details?.modulusLength, 3072);

    const second = loadOrCreateKeyPair(tmpDir);
    assert.equal(second.kid, first.kid);
    assert.equal(second.publicKeyBase64, first.publicKeyBase64);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("envelope: WebCrypto RSA-OAEP + AES-256-GCM round trip and refusal of wrong kid or tampered ciphertext without leaking plaintext", async () => {
  const tmpDir = makeTempDir();
  try {
    const keys = loadOrCreateKeyPair(tmpDir);
    const secretPayload = {
      server: "Monex-Live",
      login: "88776655",
      password: "SuperSecretBrokerPassword!42",
    };

    const envelope = await buildBrowserEnvelope(keys.publicKeyBase64, keys.kid, secretPayload);
    const opened = openEnvelope(envelope, keys.privateKey, keys.kid);
    assert.deepEqual(opened, secretPayload);

    // Refuse wrong kid
    assert.throws(
      () => openEnvelope({ ...envelope, kid: "0000000000000000" }, keys.privateKey, keys.kid),
      (err) => {
        assert.match(err.message, /kid/i);
        assert.ok(!err.message.includes(secretPayload.login));
        assert.ok(!err.message.includes(secretPayload.password));
        return true;
      },
    );

    // Refuse tampered ciphertext (flip a byte in ciphertext and in GCM tag)
    const ctBuf = Buffer.from(envelope.ciphertext, "base64");
    ctBuf[0] ^= 0xff;
    const tamperedEnvelope = {
      ...envelope,
      ciphertext: ctBuf.toString("base64"),
    };
    assert.throws(
      () => openEnvelope(tamperedEnvelope, keys.privateKey, keys.kid),
      (err) => {
        assert.match(err.message, /AES-GCM/i);
        assert.ok(!err.message.includes(secretPayload.login));
        assert.ok(!err.message.includes(secretPayload.password));
        assert.ok(!err.message.includes(secretPayload.server));
        return true;
      },
    );

    // Refuse invalid plaintext JSON or missing fields without leaking plaintext
    const badEnvelope = await buildBrowserEnvelope(keys.publicKeyBase64, keys.kid, {
      server: "Monex-Live",
      login: "88776655",
      password: "",
    });
    assert.throws(
      () => openEnvelope(badEnvelope, keys.privateKey, keys.kid),
      (err) => {
        assert.ok(!err.message.includes("88776655"));
        assert.ok(!err.message.includes("Monex-Live"));
        return true;
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ini: applyCredentials and clearCredentials preserve comments, unrelated keys, and CRLF/LF line endings, and create missing sections", () => {
  const sampleIniCrlf = [
    "; Gateway configuration file",
    "[Common]",
    "Login=11111",
    "Server=Monex-Demo",
    "Password=oldpass",
    "NewsEnable=0",
    "KeepPrivate=1",
    "; keep this comment",
    "[Experts]",
    "Enable=0",
    "AllowLiveTrading=0",
    "AllowDllImport=0",
    "Account=1",
    "Profile=1",
    "[StartUp]",
    "Expert=m1_ohlcv_ingest",
    "Symbol=REPLACE_SYMBOL",
    "Period=M1",
    "ExpertParameters=m1_ohlcv_ingest.set",
    "",
  ].join("\r\n");

  const updated = applyCredentials(sampleIniCrlf, {
    server: "Monex-Real",
    login: "998877",
    password: "new-secret-password",
    takeStartup: true,
    symbol: "XAUUSD",
  });

  // CRLF preserved, no bare LF
  assert.ok(updated.includes("\r\n"));
  assert.equal(updated.replace(/\r\n/g, "").includes("\n"), false);

  // Comments and unrelated keys preserved
  assert.ok(updated.includes("; Gateway configuration file\r\n"));
  assert.ok(updated.includes("; keep this comment\r\n"));
  assert.ok(updated.includes("NewsEnable=0\r\n"));
  assert.ok(updated.includes("KeepPrivate=1\r\n"));
  assert.ok(updated.includes("AllowDllImport=0\r\n"));
  assert.ok(updated.includes("Account=1\r\n"));
  assert.ok(updated.includes("Profile=1\r\n"));

  // Credentials and Experts flags updated
  assert.ok(updated.includes("Login=998877\r\n"));
  assert.ok(updated.includes("Server=Monex-Real\r\n"));
  assert.ok(updated.includes("Password=new-secret-password\r\n"));
  assert.ok(updated.includes("Enable=1\r\n"));
  assert.ok(updated.includes("AllowLiveTrading=1\r\n"));

  // StartUp taken over and ExpertParameters removed
  assert.ok(updated.includes("Expert=OmegaExecutor\r\n"));
  assert.ok(updated.includes("Symbol=XAUUSD\r\n"));
  assert.ok(updated.includes("Period=M1\r\n"));
  assert.ok(!updated.includes("ExpertParameters"));

  // When takeStartup is false, StartUp section is untouched
  const keptStartup = applyCredentials(sampleIniCrlf, {
    server: "Monex-Real",
    login: "998877",
    password: "new-secret-password",
    takeStartup: false,
    symbol: "XAUUSD",
  });
  assert.ok(keptStartup.includes("Expert=m1_ohlcv_ingest\r\n"));
  assert.ok(keptStartup.includes("Symbol=REPLACE_SYMBOL\r\n"));
  assert.ok(keptStartup.includes("ExpertParameters=m1_ohlcv_ingest.set\r\n"));

  // clearCredentials empties Login/Password and sets AllowLiveTrading=0 while preserving CRLF and Server
  const cleared = clearCredentials(updated);
  assert.ok(cleared.includes("Login=\r\n"));
  assert.ok(cleared.includes("Password=\r\n"));
  assert.ok(cleared.includes("Server=Monex-Real\r\n"));
  assert.ok(cleared.includes("AllowLiveTrading=0\r\n"));
  assert.ok(cleared.includes("; keep this comment\r\n"));
  assert.equal(cleared.replace(/\r\n/g, "").includes("\n"), false);

  // Creating missing sections from an empty INI
  const fromEmpty = applyCredentials("", {
    server: "Monex-Demo",
    login: "12345",
    password: "pw",
    takeStartup: true,
    symbol: "XAUUSD.m",
  });
  assert.ok(fromEmpty.includes("[Common]\nLogin=12345\nServer=Monex-Demo\nPassword=pw"));
  assert.ok(fromEmpty.includes("[Experts]\nEnable=1\nAllowLiveTrading=1"));
  assert.ok(fromEmpty.includes("[StartUp]\nExpert=OmegaExecutor\nSymbol=XAUUSD.m\nPeriod=M1"));
});

test("files: intents.txt format & atomic write, state.json parse handling, and results.txt parsing & 20-file rotation", () => {
  const tmpDir = makeTempDir();
  try {
    const omegaDir = path.join(tmpDir, "omega");

    // 1. intents.txt format and atomic write
    const intents = [
      {
        id: "open:1794220800000:BUY",
        kind: "open",
        side: "BUY",
        volume: 0.25,
        sl: 2635.5,
        tp: 2680.0,
        reason: "quorum_buy",
      },
      {
        id: "close:778899",
        kind: "close",
        ticket: 778899,
        reason: "manual_close",
      },
      {
        id: "close_all:1794220900000",
        kind: "close_all",
        reason: "kill",
      },
    ];

    const intentsPath = writeIntents(omegaDir, intents, { now: () => 1794220805000 });
    const intentsText = fs.readFileSync(intentsPath, "ascii");
    assert.equal(
      intentsText,
      [
        "#v1;1794220805000",
        "open:1794220800000:BUY;open;BUY;0.25;2635.5;2680;",
        "close:778899;close;;;;;778899",
        "close_all:1794220900000;close_all;;;;;",
        "",
      ].join("\n"),
    );
    // Ensure no leftover tmp file
    const remainingTmp = fs.readdirSync(omegaDir).filter((f) => f.includes(".tmp."));
    assert.equal(remainingTmp.length, 0);

    // 2. state.json reading and parse-error resilience + login stripping
    assert.equal(readState(omegaDir), null);
    fs.writeFileSync(path.join(omegaDir, "state.json"), "{broken json");
    assert.equal(readState(omegaDir), null);

    fs.writeFileSync(
      path.join(omegaDir, "state.json"),
      JSON.stringify({
        connected: true,
        server: "Monex-Demo",
        login: "123456",
        account: {
          login: "123456",
          trade_mode: "demo",
          currency: "USD",
          balance: 10000,
          equity: 10005.5,
          day_start_balance: 10000,
          day_realized_pl: 0,
        },
        received_ms: 1794220800000,
      }),
    );
    const state = readState(omegaDir);
    assert.equal(state.connected, true);
    assert.equal(state.login, undefined);
    assert.equal(state.account.login, undefined);

    // 3. results.txt parsing and rotation (keep only newest 20 .done files)
    for (let i = 1; i <= 24; i++) {
      fs.writeFileSync(path.join(omegaDir, `results.${1000 + i}.done`), "");
    }
    fs.writeFileSync(
      path.join(omegaDir, "results.txt"),
      [
        "open:1794220800000:BUY;1;554433;;1794220801100",
        "close:778899;0;778899;Market closed;1794220801200",
        "close_all:1794220900000;1;;;1794220801300",
        "",
      ].join("\n"),
    );

    const results = consumeResults(omegaDir, { now: () => 2000 });
    assert.deepEqual(results, [
      {
        id: "open:1794220800000:BUY",
        ok: true,
        ticket: 554433,
        executed_ms: 1794220801100,
      },
      {
        id: "close:778899",
        ok: false,
        ticket: 778899,
        error: "Market closed",
        executed_ms: 1794220801200,
      },
      {
        id: "close_all:1794220900000",
        ok: true,
        executed_ms: 1794220801300,
      },
    ]);

    assert.equal(fs.existsSync(path.join(omegaDir, "results.txt")), false);
    const doneFiles = fs
      .readdirSync(omegaDir)
      .filter((f) => /^results\.\d+\.done$/.test(f))
      .sort();
    assert.equal(doneFiles.length, 20);
    assert.ok(doneFiles.includes("results.2000.done"));
    assert.ok(!doneFiles.includes("results.1001.done"));
    assert.ok(!doneFiles.includes("results.1005.done"));
    assert.ok(doneFiles.includes("results.1006.done"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("daemon: applies new connection once, restarts terminal once, skips same version, backs off on 500, rate-limits 403, and never logs secrets", async () => {
  const tmpDir = makeTempDir();
  try {
    const stateDir = path.join(tmpDir, "state");
    const mt5FilesDir = path.join(tmpDir, "mt5-files", "omega");
    const terminalIni = path.join(tmpDir, "terminal_gateway.ini");
    fs.mkdirSync(mt5FilesDir, { recursive: true });

    const initialIni = [
      "[Common]",
      "Login=0000",
      "Server=Monex-Demo",
      "Password=init",
      "NewsEnable=0",
      "KeepPrivate=1",
      "[Experts]",
      "Enable=1",
      "AllowLiveTrading=0",
      "AllowDllImport=0",
      "Account=1",
      "Profile=1",
      "[StartUp]",
      "Expert=m1_ohlcv_ingest",
      "Symbol=REPLACE_SYMBOL",
      "Period=M1",
      "ExpertParameters=m1_ohlcv_ingest.set",
      "",
    ].join("\n");
    fs.writeFileSync(terminalIni, initialIni, { mode: 0o600 });

    const sensitiveLogin = "77665544";
    const sensitivePassword = "UltraSecretPassword#999";
    const sensitiveClientSecret = "cf-access-super-secret-token-value";

    let nowMs = 1794220800000;
    const execCalls = [];
    const syncBodies = [];
    const capturedLogs = [];
    const stdoutLines = [];
    let nextResponseFactory = null;

    const daemon = createDaemon({
      omegaUrl: "https://nexus.cryptophys.work/omega",
      cfAccessClientId: "client-id-123",
      cfAccessClientSecret: sensitiveClientSecret,
      stateDir,
      mt5FilesDir,
      terminalIni,
      terminalService: "mt5-terminal.service",
      takeStartup: true,
      symbol: "XAUUSD",
      syncMs: 5000,
      now: () => nowMs,
      logs: capturedLogs,
      stdout: {
        write(chunk) {
          stdoutLines.push(String(chunk).trim());
        },
      },
      exec: async (cmd, args) => {
        execCalls.push({ cmd, args });
      },
      fetch: async (url, init) => {
        assert.equal(url, "https://nexus.cryptophys.work/omega/api/bridge/sync");
        assert.equal(init.headers["CF-Access-Client-Id"], "client-id-123");
        assert.equal(init.headers["CF-Access-Client-Secret"], sensitiveClientSecret);
        assert.equal(init.headers["content-type"], "application/json");
        assert.ok(Buffer.byteLength(init.body, "utf8") <= 65536);
        syncBodies.push(JSON.parse(init.body));
        return nextResponseFactory();
      },
    });

    const envelope = await buildBrowserEnvelope(daemon.keys.publicKeyBase64, daemon.keys.kid, {
      server: "Monex-Live",
      login: sensitiveLogin,
      password: sensitivePassword,
    });

    // Write a result before Cycle 1 to verify results reporting
    fs.writeFileSync(
      path.join(mt5FilesDir, "results.txt"),
      "open:1794220700000:BUY;1;900100;;1794220701000\n",
    );

    // Cycle 1: returns connection v1 and an intent
    nextResponseFactory = () => ({
      status: 200,
      json: async () => ({
        intents: [
          {
            id: "open:1794220800000:BUY",
            kind: "open",
            side: "BUY",
            volume: 0.1,
            sl: 2640,
            tp: 2670,
            reason: "quorum",
          },
        ],
        connection: {
          version: 1,
          server: "Monex-Live",
          envelope,
        },
        settings_version: 1,
      }),
    });

    const res1 = await daemon.tick();
    assert.equal(res1.ok, true);
    assert.equal(res1.appliedConnection, true);
    assert.equal(res1.delayMs, 5000);
    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0], {
      cmd: "systemctl",
      args: ["restart", "mt5-terminal.service"],
    });
    assert.equal(syncBodies[0].bridge_version, "1.0.0");
    assert.equal(syncBodies[0].kid, daemon.keys.kid);
    assert.equal(syncBodies[0].public_key, daemon.keys.publicKeyBase64);
    assert.equal(syncBodies[0].results.length, 1);
    assert.equal(syncBodies[0].results[0].id, "open:1794220700000:BUY");

    // Verify INI updated and mode 0600 kept
    const iniAfterV1 = fs.readFileSync(terminalIni, "utf8");
    assert.ok(iniAfterV1.includes(`Login=${sensitiveLogin}`));
    assert.ok(iniAfterV1.includes(`Password=${sensitivePassword}`));
    assert.ok(iniAfterV1.includes("Server=Monex-Live"));
    assert.ok(iniAfterV1.includes("AllowLiveTrading=1"));
    assert.ok(iniAfterV1.includes("Expert=OmegaExecutor"));
    assert.equal(fs.statSync(terminalIni).mode & 0o777, 0o600);

    // Verify applied.json stores version and server, never login or password
    const appliedText = fs.readFileSync(path.join(stateDir, "applied.json"), "utf8");
    const appliedJson = JSON.parse(appliedText);
    assert.equal(appliedJson.version, 1);
    assert.equal(appliedJson.server, "Monex-Live");
    assert.ok(!appliedText.includes(sensitiveLogin));
    assert.ok(!appliedText.includes(sensitivePassword));

    // Cycle 2: same connection version 1 -> must NOT re-apply or restart terminal, and previous result is not re-sent
    nowMs += 5000;
    const res2 = await daemon.tick();
    assert.equal(res2.ok, true);
    assert.equal(res2.appliedConnection, false);
    assert.equal(execCalls.length, 1, "must not restart terminal again for same version");
    assert.deepEqual(syncBodies[1].results, []);

    // Cycle 3, 4, 5: HTTP 500 -> exponential backoff up to 60s
    nextResponseFactory = () => ({
      status: 500,
      json: async () => ({ error: "internal_error" }),
    });
    const b1 = await daemon.tick();
    assert.equal(b1.ok, false);
    assert.equal(b1.delayMs, 10000);

    const b2 = await daemon.tick();
    assert.equal(b2.delayMs, 20000);

    const b3 = await daemon.tick();
    assert.equal(b3.delayMs, 40000);

    const b4 = await daemon.tick();
    assert.equal(b4.delayMs, 60000);

    const b5 = await daemon.tick();
    assert.equal(b5.delayMs, 60000);

    // Cycle 6 & 7: HTTP 403 -> logged once per minute with hint
    nextResponseFactory = () => ({
      status: 403,
      json: async () => ({}),
    });
    const logsBefore403 = capturedLogs.length;
    await daemon.tick();
    assert.equal(capturedLogs.length, logsBefore403 + 1);
    assert.match(
      capturedLogs[capturedLogs.length - 1],
      /check OMEGA_BRIDGE_CLIENT_ID \/ the Access service token/,
    );

    // Immediate second 403 within the same minute must not log again
    nowMs += 10000;
    await daemon.tick();
    assert.equal(capturedLogs.length, logsBefore403 + 1);

    // After 60s, 403 is logged again
    nowMs += 60000;
    await daemon.tick();
    assert.equal(capturedLogs.length, logsBefore403 + 2);

    // Verify start() and clean stop()
    nextResponseFactory = () => {
      daemon.stop();
      return {
        status: 200,
        json: async () => ({ intents: [], connection: null, settings_version: 1 }),
      };
    };
    await daemon.start({ attachSignals: false });

    // Verify no log line ever contains login, password, envelope, or client secret
    assert.ok(stdoutLines.length > 0);
    for (const line of [...capturedLogs, ...stdoutLines]) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.ts, "number");
      assert.ok(!line.includes(sensitiveLogin), "log must never contain login");
      assert.ok(!line.includes(sensitivePassword), "log must never contain password");
      assert.ok(!line.includes(sensitiveClientSecret), "log must never contain client secret");
      assert.ok(!line.includes(envelope.ciphertext), "log must never contain ciphertext");
      assert.ok(!line.includes(envelope.wrapped_key), "log must never contain wrapped_key");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
