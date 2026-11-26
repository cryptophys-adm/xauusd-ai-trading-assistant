// omega-bridge 1.7.1 (owner 2026-11-26: "Ya, bridge saja"): the results-file race. OmegaExecutor opens results.txt,
// then writes; a native rename inside that window moves the file under the EA's handle and its write lands in a .done
// file already read. These tests cover the debounce, the .done re-read, the partial-line rule and the dedupe by intent
// id. Temp dirs only, no network (fetch is a stub).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RESULTS_DEBOUNCE_MS,
  RESULTS_PARTIAL_MAX_MS,
  RESULTS_REREAD_MS,
  collectResults,
  pruneDoneResults,
  resultsSettleLeftMs,
  splitCompleteLines,
} from "../src/files.mjs";
import {
  BRIDGE_VERSION,
  RESULT_IDS_MAX,
  RESULT_IDS_TTL_MS,
  createDaemon,
  createResultIdMemory,
  isResultsEvent,
} from "../src/daemon.mjs";

const LINE_A = "open:1794220800000:BUY;1;554433;;1794220801100;4101.20;1.0\n";
const LINE_B = "cl:554433:opp;1;554433;;1794220802200\n";
const LINE_C = "mt:554433:1;1;554433;;1794220803300\n";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omega-bridge-race-"));
}

/** Set a file's mtime `agoMs` before the wall clock. */
function age(file, agoMs) {
  const t = new Date(Date.now() - agoMs);
  fs.utimesSync(file, t, t);
}

function doneFiles(dir) {
  return fs.readdirSync(dir).filter((f) => /^results\.\d+\.done$/.test(f)).sort();
}

/** A daemon with a stubbed sync that records every result id it was sent. */
function daemonIn(root, extra = {}) {
  const omegaDir = path.join(root, "mt5", "omega");
  fs.mkdirSync(omegaDir, { recursive: true });
  const sent = [];
  const logs = [];
  let nowMs = 1794220800000;
  const daemon = createDaemon({
    omegaUrl: "https://nexus.cryptophys.work/omega",
    cfAccessClientId: "id",
    cfAccessClientSecret: "secret",
    stateDir: path.join(root, "state"),
    mt5FilesDir: omegaDir,
    terminalIni: path.join(root, "terminal.ini"),
    takeStartup: false,
    now: () => nowMs,
    logs,
    stdout: { write() {} },
    exec: async () => ({ stdout: "", stderr: "" }),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      for (const r of body.results) sent.push(r.id);
      return { status: 200, json: async () => ({ intents: [] }) };
    },
    ...extra,
  });
  return { daemon, omegaDir, sent, logs, advance: (ms) => { nowMs += ms; } };
}

test("RR0: the constants, the version and the event filter", () => {
  assert.equal(BRIDGE_VERSION, "1.7.1");
  assert.equal(RESULTS_DEBOUNCE_MS, 400);
  assert.equal(RESULTS_REREAD_MS, 60_000);
  assert.ok(RESULT_IDS_TTL_MS >= RESULTS_PARTIAL_MAX_MS + RESULTS_REREAD_MS, "an id outlives every re-read of its line");
  assert.equal(isResultsEvent("results.txt", "rename"), true);
  assert.equal(isResultsEvent("results.txt", "change"), true);
  assert.equal(isResultsEvent("results.1794220800000.done", "change"), true, "the EA's late write into a .done file");
  assert.equal(isResultsEvent("results.1794220800000.done", "rename"), false, "the bridge's own rename does not wake");
  assert.equal(isResultsEvent("state.json", "change"), false);
  assert.deepEqual(splitCompleteLines("a\nb"), { complete: "a\n", tail: "b" });
  assert.deepEqual(splitCompleteLines("a\r\n\0\0"), { complete: "a\r\n", tail: "" }, "NUL padding is not a partial line");
});

test("RR1 debounce: results.txt is never renamed while it is younger than the debounce", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "results.txt");
    fs.writeFileSync(file, LINE_A);
    const mtime = fs.statSync(file).mtimeMs;

    for (const after of [0, 100, RESULTS_DEBOUNCE_MS - 1]) {
      const pass = collectResults(dir, { now: () => 5000, fileNow: () => mtime + after });
      assert.deepEqual(pass.fresh, [], `nothing taken ${after} ms after the write`);
      assert.ok(pass.waitMs > 0 && pass.waitMs <= RESULTS_DEBOUNCE_MS, "it says how long to wait");
      assert.ok(fs.existsSync(file), "not renamed");
      assert.deepEqual(doneFiles(dir), []);
      assert.ok(resultsSettleLeftMs(dir, { fileNow: () => mtime + after }) > 0);
    }

    // A clock behind the file's mtime counts as a fresh write.
    assert.equal(collectResults(dir, { fileNow: () => mtime - 10_000 }).fresh.length, 0);
    assert.ok(fs.existsSync(file));

    const settled = collectResults(dir, { now: () => 5000, fileNow: () => mtime + RESULTS_DEBOUNCE_MS });
    assert.deepEqual(settled.fresh.map((r) => r.id), ["open:1794220800000:BUY"]);
    assert.equal(settled.waitMs, null);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(doneFiles(dir), ["results.5000.done"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RR1b debounce in the daemon: a tick waits for the file to settle, and renames nothing before", async () => {
  const root = tmp();
  try {
    const { daemon, omegaDir, sent } = daemonIn(root);
    fs.writeFileSync(path.join(omegaDir, "results.txt"), LINE_A);
    const t0 = Date.now();
    let renamedEarly = null;
    const probe = new Promise((resolve) => setTimeout(() => {
      renamedEarly = !fs.existsSync(path.join(omegaDir, "results.txt")) || doneFiles(omegaDir).length > 0;
      resolve();
    }, 150));
    const res = await daemon.tick();
    await probe;
    assert.equal(renamedEarly, false, "nothing renamed 150 ms after the write");
    assert.ok(Date.now() - t0 >= RESULTS_DEBOUNCE_MS - 50, "the tick waited for the debounce");
    assert.equal(res.ok, true);
    assert.deepEqual(sent, ["open:1794220800000:BUY"]);
    assert.equal(fs.existsSync(path.join(omegaDir, "results.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RR1c debounce of the wake: the watcher wakes a sync only after the file is quiet, and nothing is renamed before", async () => {
  const root = tmp();
  try {
    const { daemon, omegaDir, sent } = daemonIn(root, { syncMs: 60_000, now: undefined, clock: undefined });
    const running = daemon.start({ attachSignals: false });
    await new Promise((r) => setTimeout(r, 100)); // the first tick has run; the daemon sleeps 60 s
    const file = path.join(omegaDir, "results.txt");
    fs.writeFileSync(file, LINE_A);
    // The EA keeps writing for a while: each write restarts the debounce.
    await new Promise((r) => setTimeout(r, 250));
    fs.appendFileSync(file, LINE_B);
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(fs.existsSync(file), "not renamed while it is still being written");
    assert.deepEqual(sent, []);
    const deadline = Date.now() + 3000;
    while (sent.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    daemon.stop();
    await running;
    assert.deepEqual(sent, ["open:1794220800000:BUY", "cl:554433:opp"], "woken by the watcher, long before the 60 s period");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RR2 seen twice, applied once: a line in the original file and in every .done re-read is sent once", async () => {
  const root = tmp();
  try {
    const { daemon, omegaDir, sent, advance } = daemonIn(root);
    const file = path.join(omegaDir, "results.txt");
    fs.writeFileSync(file, LINE_A + LINE_B);
    age(file, 5000);
    await daemon.tick();
    assert.deepEqual(sent, ["open:1794220800000:BUY", "cl:554433:opp"]);

    // The next passes read the .done file again (it is inside the 60 s window): nothing is sent twice.
    for (let i = 0; i < 3; i++) {
      advance(5000);
      await daemon.tick();
    }
    // The same id arriving in a new results.txt beside its .done copy is still not sent again.
    fs.writeFileSync(file, LINE_A + LINE_C);
    age(file, 5000);
    advance(5000);
    await daemon.tick();
    assert.deepEqual(sent, ["open:1794220800000:BUY", "cl:554433:opp", "mt:554433:1"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RR2b one pass: the same id in results.txt and in a recent .done file is collected once", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "results.1000.done"), LINE_A);
    fs.writeFileSync(path.join(dir, "results.txt"), LINE_A + LINE_B);
    age(path.join(dir, "results.txt"), 5000);
    const pass = collectResults(dir, { now: () => 2000 });
    assert.deepEqual(pass.fresh.map((r) => r.id), ["open:1794220800000:BUY", "cl:554433:opp"]);
    assert.deepEqual(pass.reread, [], "the re-read copy of an id already collected is dropped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RR3 late line: a line appended to the file after its rename is picked up within the 60 s window", async () => {
  const root = tmp();
  try {
    const { daemon, omegaDir, sent, logs, advance } = daemonIn(root);
    const file = path.join(omegaDir, "results.txt");
    fs.writeFileSync(file, LINE_A);
    age(file, 5000);
    await daemon.tick();
    const [done] = doneFiles(omegaDir);
    assert.ok(done, "renamed to a .done file");

    // The EA's handle followed the rename: its next write lands in the .done file.
    fs.appendFileSync(path.join(omegaDir, done), LINE_B);
    advance(5000);
    await daemon.tick();
    assert.deepEqual(sent, ["open:1794220800000:BUY", "cl:554433:opp"]);
    assert.ok(logs.some((l) => l.includes('"event":"result_recovered"') && l.includes("cl:554433:opp")));

    // Outside the window (by its mtime) a .done file is no longer read.
    const dir = tmp();
    try {
      fs.writeFileSync(path.join(dir, "results.1000.done"), LINE_C);
      age(path.join(dir, "results.1000.done"), RESULTS_REREAD_MS + 5000);
      assert.deepEqual(collectResults(dir).reread, []);
      age(path.join(dir, "results.1000.done"), RESULTS_REREAD_MS - 5000);
      assert.deepEqual(collectResults(dir).reread.map((r) => r.id), ["mt:554433:1"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RR4 partial line: an incomplete last line is skipped, then processed once complete", async () => {
  const root = tmp();
  try {
    const { daemon, omegaDir, sent, advance } = daemonIn(root);
    const file = path.join(omegaDir, "results.txt");
    fs.writeFileSync(file, LINE_A + "cl:554433:opp;1;5544");
    age(file, 5000);
    await daemon.tick();
    assert.deepEqual(sent, ["open:1794220800000:BUY"], "the incomplete line is not sent");

    const [done] = doneFiles(omegaDir);
    fs.appendFileSync(path.join(omegaDir, done), "33;;1794220802200\n");
    advance(5000);
    await daemon.tick();
    advance(5000);
    await daemon.tick();
    assert.deepEqual(sent, ["open:1794220800000:BUY", "cl:554433:opp"], "sent once, when complete");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RR4b partial line past the 60 s window: still awaited, never pruned, read when complete; dropped only after 10 minutes", () => {
  const dir = tmp();
  try {
    const memo = { files: new Map(), dropped: new Set() };
    const partial = path.join(dir, "results.1000.done");
    fs.writeFileSync(partial, LINE_A + "cl:554433:opp;1;55");
    age(partial, 5 * 60_000); // 5 minutes: outside the 60 s window
    // 25 newer .done files would prune it to keep 20.
    for (let i = 1; i <= 25; i++) {
      fs.writeFileSync(path.join(dir, `results.${2000 + i}.done`), "");
      age(path.join(dir, `results.${2000 + i}.done`), 2 * 60_000);
    }

    let pass = collectResults(dir, { memo });
    assert.deepEqual(pass.reread.map((r) => r.id), ["open:1794220800000:BUY"], "its complete lines are read, the partial one is not");
    assert.ok(fs.existsSync(partial), "an awaited file is never pruned");
    assert.equal(doneFiles(dir).length, 21);

    // The EA's line completes. Even with the mtime held 5 minutes back, the awaited file is read again.
    fs.appendFileSync(partial, "4433;;1794220802200\n");
    age(partial, 5 * 60_000);
    pass = collectResults(dir, { memo });
    assert.deepEqual(pass.reread.map((r) => r.id), ["open:1794220800000:BUY", "cl:554433:opp"]);

    // Complete now and outside the window: no longer read, and prunable.
    pass = collectResults(dir, { memo });
    assert.deepEqual(pass.reread, []);
    assert.equal(fs.existsSync(partial), false, "pruned once it holds no incomplete line");

    // A line that never completes is given up after RESULTS_PARTIAL_MAX_MS, logged once, then pruned like any file.
    const stuck = path.join(dir, "results.3000.done");
    fs.writeFileSync(stuck, "mt:554433:1;1;55");
    age(stuck, 9 * 60_000);
    pass = collectResults(dir, { memo });
    assert.deepEqual(pass.dropped, []);
    assert.ok(fs.existsSync(stuck));
    age(stuck, RESULTS_PARTIAL_MAX_MS + 1000);
    pass = collectResults(dir, { memo });
    assert.deepEqual(pass.dropped, [{ file: "results.3000.done", id: "mt:554433:1" }]);
    assert.deepEqual(collectResults(dir, { memo }).dropped, [], "logged once");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RR4c a partial line in the daemon is logged as dropped after 10 minutes, never sent", async () => {
  const root = tmp();
  try {
    let wall = Date.now();
    const { daemon, omegaDir, sent, logs, advance } = daemonIn(root, { fileNow: () => wall });
    const file = path.join(omegaDir, "results.txt");
    fs.writeFileSync(file, "cl:554433:opp;1;5544");
    age(file, 5000);
    await daemon.tick();
    wall += RESULTS_PARTIAL_MAX_MS + 10_000;
    advance(RESULTS_PARTIAL_MAX_MS + 10_000);
    await daemon.tick();
    assert.deepEqual(sent, []);
    assert.equal(logs.filter((l) => l.includes('"event":"result_partial_line_dropped"')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RR5 dedupe bound: the memory of reported ids is capped by count and by age", () => {
  let t = 0;
  const mem = createResultIdMemory({ now: () => t, ttlMs: 1000, max: 100 });
  for (let i = 0; i < 250; i++) mem.add(`id:${i}`);
  assert.equal(mem.size, 100, "count cap");
  assert.equal(mem.has("id:0"), false, "the oldest go first");
  assert.equal(mem.has("id:249"), true);

  t = 500;
  mem.add("late");
  t = 1200; // the first 100 are older than the TTL, "late" is not
  mem.prune();
  assert.equal(mem.size, 1);
  assert.equal(mem.has("late"), true);
  t = 2000;
  mem.prune();
  assert.equal(mem.size, 0);

  // The defaults: 5000 ids, 30 minutes.
  const def = createResultIdMemory({ now: () => 0 });
  for (let i = 0; i < RESULT_IDS_MAX + 500; i++) def.add(`x:${i}`);
  assert.equal(def.size, RESULT_IDS_MAX);
});

test("RR5b daemon dedupe memory stays bounded over many results", async () => {
  const root = tmp();
  try {
    const { daemon, omegaDir, sent, advance } = daemonIn(root);
    // 40 passes of 200 results each: 8000 ids, more than RESULT_IDS_MAX, all sent exactly once.
    for (let p = 0; p < 40; p++) {
      const file = path.join(omegaDir, "results.txt");
      fs.writeFileSync(file, Array.from({ length: 200 }, (_, i) => `id:${p}:${i};1;;;${p * 1000 + i}\n`).join(""));
      age(file, 5000);
      advance(1000);
      await daemon.tick();
    }
    assert.equal(sent.length, 8000);
    assert.equal(new Set(sent).size, 8000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RR6 prune keeps the newest 20 and every file it is told to keep", () => {
  const dir = tmp();
  try {
    for (let i = 1; i <= 24; i++) fs.writeFileSync(path.join(dir, `results.${1000 + i}.done`), "");
    pruneDoneResults(dir, { keep: (name) => name === "results.1001.done" });
    const left = doneFiles(dir);
    assert.equal(left.length, 21);
    assert.ok(left.includes("results.1001.done"));
    assert.ok(!left.includes("results.1002.done"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RR7 restart: the reported ids persist in the state dir, so a restarted bridge re-sends no line it already sent", async () => {
  const { REPORTED_IDS_FILE } = await import("../src/daemon.mjs");
  const root = tmp();
  try {
    const first = daemonIn(root);
    const file = path.join(first.omegaDir, "results.txt");
    fs.writeFileSync(file, LINE_A + LINE_B);
    age(file, 5000);
    await first.daemon.tick();
    assert.deepEqual(first.sent, ["open:1794220800000:BUY", "cl:554433:opp"]);
    const stored = path.join(root, "state", REPORTED_IDS_FILE);
    assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(stored, "utf8")).ids.map(([id]) => id), ["open:1794220800000:BUY", "cl:554433:opp"]);
    assert.deepEqual(fs.readdirSync(path.join(root, "state")).filter((f) => f.includes(".tmp.")), [], "written by tmp + rename");

    // The bridge restarts: the .done file is still inside the 60 s window, and a late line was appended to it.
    const [done] = doneFiles(first.omegaDir);
    fs.appendFileSync(path.join(first.omegaDir, done), LINE_C);
    const second = daemonIn(root);
    await second.daemon.tick();
    assert.deepEqual(second.sent, ["mt:554433:1"], "only the line never sent before");
    assert.ok(!second.logs.some((l) => l.includes("reported_ids_unreadable")));

    // Without the file (as a 1.7.0 state dir), the restarted bridge sends the window's lines once more.
    fs.rmSync(stored);
    const third = daemonIn(root);
    await third.daemon.tick();
    assert.deepEqual(third.sent.sort(), ["cl:554433:opp", "mt:554433:1", "open:1794220800000:BUY"]);
    assert.ok(!third.logs.some((l) => l.includes("reported_ids_unreadable")), "a missing file is a first start, not a warning");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RR7b restart: a corrupt or invalid file means an empty set, one warning, no crash; old and invalid ids are dropped on load", async () => {
  const { REPORTED_IDS_FILE, readReportedIds, createResultIdMemory: mem } = await import("../src/daemon.mjs");
  for (const content of ["{not json", JSON.stringify({ v: 2, ids: [] }), JSON.stringify([1, 2]), ""]) {
    const root = tmp();
    try {
      fs.mkdirSync(path.join(root, "state"), { recursive: true });
      fs.writeFileSync(path.join(root, "state", REPORTED_IDS_FILE), content);
      const d = daemonIn(root);
      const file = path.join(d.omegaDir, "results.txt");
      fs.writeFileSync(file, LINE_A);
      age(file, 5000);
      const res = await d.daemon.tick();
      assert.equal(res.ok, true);
      assert.deepEqual(d.sent, ["open:1794220800000:BUY"]);
      assert.equal(d.logs.filter((l) => l.includes('"event":"reported_ids_unreadable"')).length, 1);
      assert.equal(readReportedIds(path.join(root, "state")).problem, null, "rewritten valid after the sync");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  const m = mem({ now: () => 10_000, ttlMs: 1000, max: 2 });
  m.load([["old", 1000], ["a", 9500], [42, 9600], ["b", 9700], ["c", 9800], ["", 9900], ["d", NaN]]);
  assert.deepEqual(m.entries().map(([id]) => id), ["b", "c"], "TTL, then the count cap; invalid pairs skipped");
});
