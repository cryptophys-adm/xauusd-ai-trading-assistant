// End to end, with the real code on both sides: the Omega bridge daemon (bridge/omega-bridge) syncs
// through the Omega Worker's handler (Access JWT of its service token) into the AI Worker's gateway
// functions (src/omega-broker.mjs over a sqlite D1); the page's envelope module encrypts the broker
// credentials to the daemon's key; the daemon logs the terminal in and writes the executor's intents.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, resetKeyCacheForTests } from "../workers/xauusd-omega/src/omega.mjs";
import { bridgeSync, brokerOverview, setConnection, clearConnection, writeSettings, bridgeKey, resetOmegaBrokerSchemaForTests } from "../src/omega-broker.mjs";
import { buildEnvelope } from "../workers/xauusd-omega/public/omega-crypto.js";
import { createDaemon } from "../bridge/omega-bridge/src/daemon.mjs";

const TEAM = "cryptophys.cloudflareaccess.com";
const BRIDGE_ID = "bridge-client.access";
const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const certsFetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
async function jwt(claims, nowSec) {
  const h = enc({ alg: "RS256", kid: "k1" }), b = enc({ iss: `https://${TEAM}`, exp: nowSec + 600, ...claims });
  return `${h}.${b}.${b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${b}`))))}`;
}

function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a.map((v) => (v === undefined ? null : v)); return stmt; },
        async run() { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; }
      };
      return stmt;
    }
  };
}

const ISSUED = Date.parse("2026-11-09T11:00:00Z");
let clock = ISSUED + 5 * 60_000;
const SIGNAL = { side: "BUY", entry: 4100, stop: 4095, tp1: 4110, issued_ms: ISSUED, expires_ms: ISSUED + 3_600_000, blackout: false, kill: false, paused: false };
const INI = "; MT5 gateway\r\n[Common]\r\nLogin=REPLACE_LOGIN\r\nServer=Monex-Demo\r\nPassword=REPLACE_PASSWORD\r\nKeepPrivate=1\r\n[Experts]\r\nEnable=1\r\nAllowLiveTrading=0\r\n[StartUp]\r\nExpert=m1_ohlcv_ingest\r\nSymbol=REPLACE_SYMBOL\r\nPeriod=M1\r\nExpertParameters=m1_ohlcv_ingest.set\r\n";

test("bridge ⇄ Omega ⇄ engine: key registration, encrypted login, a sized order, its result, disconnect", async () => {
  resetKeyCacheForTests();
  resetOmegaBrokerSchemaForTests();
  const dir = mkdtempSync(join(tmpdir(), "omega-e2e-"));
  try {
    const files = join(dir, "MQL5", "Files", "omega");
    mkdirSync(files, { recursive: true });
    const iniPath = join(dir, "terminal_gateway.ini");
    writeFileSync(iniPath, INI, { mode: 0o600 });

    // The AI Worker side: the gateway functions over a sqlite D1, the H1 signal injected.
    const aiEnv = { DB: d1(), SIGNAL_CACHE: { get: async () => null, put: async () => {} }, OMEGA_ENGINE_ENABLED: "true" };
    const OMEGA = {
      overview: async () => ({ broker: await brokerOverview(aiEnv, { now: clock }) }),
      bridgeKey: async () => bridgeKey(aiEnv, { now: clock }),
      bridgeSync: (input) => bridgeSync(aiEnv, input, { now: clock, signal: SIGNAL })
    };
    const omegaEnv = { ACCESS_TEAM_DOMAIN: TEAM, OMEGA, OMEGA_BRIDGE_CLIENT_ID: BRIDGE_ID };

    // The bridge's HTTP: Cloudflare Access turns the service token into a JWT, then the Omega Worker.
    const seen = [];
    const fetchViaAccess = async (url, init) => {
      assert.equal(url, "https://nexus.cryptophys.work/omega/api/bridge/sync");
      assert.ok(init.headers["CF-Access-Client-Secret"], "the service token is sent");
      seen.push(JSON.parse(init.body));
      const req = new Request(url, { method: init.method, body: init.body, headers: { "content-type": "application/json", "cf-access-jwt-assertion": await jwt({ common_name: BRIDGE_ID }, Math.floor(clock / 1000)) } });
      return handle(req, omegaEnv, { fetchImpl: certsFetch, now: Math.floor(clock / 1000) });
    };
    const execs = [], logs = [];
    const daemon = createDaemon({
      env: {}, omegaUrl: "https://nexus.cryptophys.work/omega", cfAccessClientId: BRIDGE_ID, cfAccessClientSecret: "s3cret-token",
      stateDir: join(dir, "state"), mt5FilesDir: join(dir, "MQL5", "Files"), terminalIni: iniPath, symbol: "XAUUSD",
      fetch: fetchViaAccess, exec: async (cmd, args) => { execs.push([cmd, ...args]); return { stdout: "", stderr: "" }; },
      now: () => clock, logs, stdout: { write() {} }
    });

    // 1. First sync: no EA state yet. The bridge registers its key; nothing is planned.
    assert.equal((await daemon.tick()).ok, true);
    const key = await bridgeKey(aiEnv, { now: clock });
    assert.equal(key.kid, daemon.keys.kid);
    assert.equal(readFileSync(join(files, "intents.txt"), "utf8").trim(), `#v1;${clock}`);

    // 2. The owner enters the credentials on the page (browser-side encryption) and enables the engine.
    const envelope = await buildEnvelope(key.public_key, key.kid, { server: "Monex-Demo", login: "5550123", password: "hunter2!" });
    assert.equal((await setConnection(aiEnv, { envelope, server: "Monex-Demo", actor: "owner@example.com" }, { now: clock })).ok, true);
    assert.equal((await writeSettings(aiEnv, { body: { enabled: true }, actor: "owner@example.com" }, { now: clock })).ok, true);
    for (const row of aiEnv.DB.raw.prepare("SELECT * FROM omega_connection").all()) {
      assert.ok(!JSON.stringify(row).includes("5550123") && !JSON.stringify(row).includes("hunter2"), "D1 never holds the login or the password");
    }

    // 3. The EA writes its state; the next sync logs the terminal in and carries the sized order.
    clock += 5_000;
    const state = {
      connected: true, server: "Monex-Demo", received_ms: clock - 1_000,
      account: { trade_mode: "demo", currency: "USD", balance: 10_000, equity: 10_000, day_start_balance: 10_000, day_realized_pl: 0 },
      symbol: { name: "XAUUSD", digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, volume_min: 0.01, volume_max: 50, volume_step: 0.01, stops_level_points: 0, bid: 4101, ask: 4101.2, spread_points: 20 },
      positions: []
    };
    writeFileSync(join(files, "state.json"), JSON.stringify(state));
    const t3 = await daemon.tick();
    assert.equal(t3.appliedConnection, true);
    const ini = readFileSync(iniPath, "utf8");
    assert.match(ini, /\r\nLogin=5550123\r\n/);
    assert.match(ini, /\r\nPassword=hunter2!\r\n/);
    assert.match(ini, /AllowLiveTrading=1/);
    assert.match(ini, /Expert=OmegaExecutor/);
    assert.match(ini, /^; MT5 gateway\r\n/, "comments and CRLF kept");
    assert.equal(statSync(iniPath).mode & 0o777, 0o600);
    assert.deepEqual(execs, [["systemctl", "restart", "mt5-terminal.service"]]);
    const intents = readFileSync(join(files, "intents.txt"), "utf8").trim().split("\n");
    assert.deepEqual(intents, [`#v1;${clock}`, `open:${ISSUED}:B;open;BUY;0.1;4096.2;4111.2;`]);

    // 4. The same connection version is not applied twice.
    clock += 5_000;
    writeFileSync(join(files, "state.json"), JSON.stringify({ ...state, received_ms: clock - 1_000 }));
    assert.equal((await daemon.tick()).appliedConnection, false);
    assert.equal(execs.length, 1);

    // 5. The EA executed it: the result reaches the intent, the order is no longer offered.
    clock += 5_000;
    writeFileSync(join(files, "results.txt"), `open:${ISSUED}:B;1;987654321;;${clock - 500}\n`);
    writeFileSync(join(files, "state.json"), JSON.stringify({ ...state, received_ms: clock - 1_000, positions: [{ ticket: 987654321, side: "BUY", volume: 0.1, open_price: 4101.2, sl: 4096.2, tp: 4111.2, profit: 0, intent_id: `open:${ISSUED}:B`, opened_ms: clock - 500 }] }));
    await daemon.tick();
    const row = aiEnv.DB.raw.prepare("SELECT status, result FROM omega_intents").get();
    assert.equal(row.status, "done");
    assert.equal(JSON.parse(row.result).ticket, 987654321);
    assert.equal(readFileSync(join(files, "intents.txt"), "utf8").trim(), `#v1;${clock}`);

    // 6. Disconnect: the bridge empties the terminal login and restarts it.
    assert.equal((await clearConnection(aiEnv, { actor: "owner@example.com", reason: "switch broker" }, { now: clock })).ok, true);
    clock += 5_000;
    await daemon.tick();
    assert.match(readFileSync(iniPath, "utf8"), /\r\nLogin=\r\n[\s\S]*\r\nPassword=\r\n[\s\S]*AllowLiveTrading=0/);
    assert.equal(execs.length, 2);

    // Nothing the bridge sent or logged carries the login, the password or the token secret.
    const outbound = JSON.stringify(seen) + logs.join("\n");
    for (const secret of ["5550123", "hunter2", "s3cret-token"]) assert.ok(!outbound.includes(secret), secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
