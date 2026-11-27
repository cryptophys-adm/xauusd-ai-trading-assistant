// Recovery backoff (server side, src/recovery-hold.mjs at the repo root): a sync that answers the directive "hold"
// restarts nothing on the bridge, and it keeps the bridge's own local restart off too. This pins that the bridge
// as it is (the executor's daemon, unchanged) honours the server's hold, so the hold needs no bridge install.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon } from "../src/daemon.mjs";
import { buildEnvelope } from "../../../workers/xauusd-omega/public/omega-crypto.js";

const fake = () => ["fake", "value", String(Date.now() % 991)].join("-");

test("RHB-1: 'hold' from the server: no terminal restart, and the bridge's local restart stays off; without it the local restart fires", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hold-"));
  try {
    const stateDir = path.join(tmp, "state"), files = path.join(tmp, "mt5-files", "omega"), ini = path.join(tmp, "terminal.ini");
    fs.mkdirSync(files, { recursive: true });
    fs.writeFileSync(ini, "[Common]\nLogin=\nPassword=\n[Experts]\nAllowLiveTrading=1\nEnabled=1\nAccount=0\nProfile=0\n", { mode: 0o600 });
    let nowMs = Date.parse("2026-11-09T11:00:00Z"); // a Monday: gold is open
    const execs = [], daemonLogs = [];
    let reply = null;
    const daemon = createDaemon({ omegaUrl: "https://example.invalid/omega", cfAccessClientId: "cid", cfAccessClientSecret: fake(), stateDir, mt5FilesDir: files,
      terminalIni: ini, terminalService: "mt5-terminal.service", symbol: "XAUUSD", syncMs: 5000, now: () => nowMs, logs: daemonLogs, stdout: { write() {} },
      exec: async (cmd, args) => { execs.push([cmd, ...args]); }, fetch: async () => ({ status: 200, json: async () => reply }) });
    const envelope = await buildEnvelope(daemon.keys.publicKeyBase64, daemon.keys.kid, { server: "AnyBroker-Live 2", login: "1", password: fake() });
    reply = { intents: [], connection: { version: 1, server: "AnyBroker-Live 2", envelope }, settings_version: 1 };
    await daemon.tick();
    const restarts = () => execs.filter((c) => c[0] === "systemctl" && c[1] === "restart").length;
    assert.equal(restarts(), 1, "the login is applied with one restart");
    // The EA runs on the applied server but the terminal never connects (so no symbol trial: that is the bridge's own
    // path for a terminal with no EA state on the applied server, and it is not the server's to hold).
    const writeState = () => fs.writeFileSync(path.join(files, "state.json"), JSON.stringify({ connected: false, trade_allowed: true, server: "AnyBroker-Live 2", received_ms: nowMs - 1000, positions: [] }));
    for (let i = 0; i < 4; i++) {
      nowMs += 4 * 60_000; writeState();
      reply = { intents: [], connection: { version: 1, server: "AnyBroker-Live 2", envelope }, settings_version: 1, recovery: { directive: "hold", reason: "recovery_held", action_id: "hold:1" } };
      await daemon.tick();
    }
    assert.equal(restarts(), 1, "four held syncs, four minutes apart: no restart at all");
    // Control: without the hold, the bridge's own local recovery restarts the stuck terminal.
    nowMs += 4 * 60_000; writeState();
    reply = { intents: [], connection: { version: 1, server: "AnyBroker-Live 2", envelope }, settings_version: 1 };
    await daemon.tick();
    assert.equal(restarts(), 2, "the local restart fires when the server sends nothing");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
