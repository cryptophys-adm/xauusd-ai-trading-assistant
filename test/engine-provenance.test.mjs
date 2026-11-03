import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderGenerated, GENERATED_PATH, computeProvenance } from "../scripts/engine-provenance.mjs";

test("generated engine provenance matches the current source and implementation bytes", () => {
  const current = readFileSync(new URL("../" + GENERATED_PATH, import.meta.url), "utf8");
  assert.equal(current, renderGenerated(), "stale provenance: run `node scripts/engine-provenance.mjs --write`");
});

test("provenance identities are SHA-256 and distinct per engine", () => {
  const p = computeProvenance();
  for (const engine of ["mizan", "prophet"]) {
    assert.match(p[engine].source_hash, /^[a-f0-9]{64}$/);
    assert.match(p[engine].implementation_hash, /^[a-f0-9]{64}$/);
  }
  assert.notEqual(p.mizan.implementation_hash, p.prophet.implementation_hash);
});
