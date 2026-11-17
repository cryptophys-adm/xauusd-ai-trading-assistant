// A guard against the Tailwind 4 upgrade tool's word renames (2026-11-17, #432; the platform hit the same bug in its
// own migration). `@tailwindcss/upgrade` renamed the plain word "shadow" to "shadow-sm" in UI text and in a status
// comparison (`a.status === "shadow"`), not only in class strings. In this repo "shadow" is a live value: mode
// switches, the shadow kill switch, shadow arms, shadow-test labels and proposal states. Tailwind 4's small shadow is
// `shadow-xs` (v3's `shadow-sm`), and nothing here uses v4's `shadow-sm`, so the token never belongs in the source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../workers/xauusd-nexus-dashboard/ui/src/", import.meta.url);
const files = readdirSync(root, { recursive: true }).map(String).filter((f) => /\.(tsx?|css)$/.test(f));

test("TG1 no \"shadow-sm\" anywhere in the Nexus UI source (the upgrade tool's rename of the word \"shadow\")", () => {
  assert.ok(files.length > 20, "the UI source was found");
  const hits = files.flatMap((f) => readFileSync(new URL(f, root), "utf8").split("\n").map((l, i) => [f, i + 1, l]).filter(([, , l]) => /\bshadow-sm\b/.test(l)));
  assert.deepEqual(hits.map(([f, n]) => join(f) + ":" + n), [], "use shadow-xs for a small shadow; \"shadow\" as a word or a value stays \"shadow\"");
});

test("TG2 the live \"shadow\" values the tool once rewrote are intact", () => {
  const read = (f) => readFileSync(new URL(f, root), "utf8");
  assert.match(read("pages/Strategy.tsx"), /a\.status === "shadow"/, "the strategy agents' shadow count");
  assert.match(read("pages/Neurons.tsx"), /label="Live \/ shadow"/);
  assert.match(read("components/AppShell.tsx"), /key: "shadow"/, "the Shadow versions page route");
});
