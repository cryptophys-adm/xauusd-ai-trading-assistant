// Broker labels follow the connected broker (orchestrator relay, owner 2026-11-18: "label notif alert juga cek ulang
// harus dinamis sesuai dengan brokernya"; the line "Omega Order Executed (Monex)" was hard-coded while the account was
// FxPro). A broker name may appear only in the broker presets the setup offers and in comments.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { brokerLabel } from "../src/account-spec.mjs";

const BROKERS = /\b(monex|mifx|fxpro|efxpro|dupoin|valetax|exness)\b/i;
const codeLines = (text) => text.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => {
  const t = l.trim();
  return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
});

test("BL1 brokerLabel: the broker from the server once validated, DEMO/LIVE, the broker's symbol; else broker unknown", () => {
  const ex = { server: "FxPro-MT5 Demo", account: { trade_mode: "demo" }, symbol: { name: "GOLD" } };
  assert.equal(brokerLabel(ex, { validated: true }), "FxPro (DEMO) · GOLD");
  assert.equal(brokerLabel({ ...ex, account: { trade_mode: "real" } }, { validated: true }), "FxPro (LIVE) · GOLD");
  assert.equal(brokerLabel(ex, { validated: false }), "broker unknown (DEMO) · GOLD", "a spec not validated names no broker");
  assert.equal(brokerLabel({ server: "Monex-Demo", account: { trade_mode: "demo" }, symbol: { name: "XAUUSD.m" } }, { validated: true }), "Monex (DEMO) · XAUUSD.m");
  assert.equal(brokerLabel(null), "broker unknown (?)");
});

test("BL2 no broker name in the server's code outside comments (notifications, events, alerts)", () => {
  const dirs = ["../src/", "../workers/xauusd-omega/src/"];
  const hits = [];
  for (const d of dirs) {
    const root = new URL(d, import.meta.url);
    for (const f of readdirSync(root).filter((x) => /\.(mjs|ts|js)$/.test(x))) {
      for (const [n, l] of codeLines(readFileSync(new URL(f, root), "utf8"))) if (BROKERS.test(l)) hits.push(`${d}${f}:${n}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("BL3 the Omega page names brokers only in its presets and the server matcher; nothing is preselected", () => {
  const ui = readFileSync(new URL("../workers/xauusd-nexus-dashboard/ui/src/pages/Omega.tsx", import.meta.url), "utf8");
  const start = ui.indexOf("const BROKER_PRESETS"), end = ui.indexOf("const MT5_TFS");
  assert.ok(start > 0 && end > start, "the presets and the matcher sit together");
  // The BrokerKey type lists the preset keys; it is part of the presets.
  const outside = (ui.slice(0, start) + ui.slice(end)).replace(/^type BrokerKey = .*$/m, "");
  const hits = codeLines(outside).filter(([, l]) => BROKERS.test(l)).map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`);
  assert.deepEqual(hits, []);
  assert.match(ui, /useState<BrokerKey>\("custom"\)/);
  assert.match(ui, /const \[bServer, setBServer\] = useState\(""\)/);
});

test("BL4 every Omega Telegram line carries the label", () => {
  const src = readFileSync(new URL("../src/omega-broker.mjs", import.meta.url), "utf8");
  for (const head of ["Omega Order Executed", "Omega Position", "Extended TP Expanded (Runner)", "Omega Intent Rejected"]) {
    assert.ok(new RegExp(`${head.replace(/[()]/g, "\\$&")}[^<]*· \\$\\{label\\}</b>`).test(src), head);
  }
});
