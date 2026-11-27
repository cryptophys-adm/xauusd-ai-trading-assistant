#!/usr/bin/env node
import { createDaemon } from "../src/daemon.mjs";
import { createFeedDaemon } from "../src/feed-daemon.mjs";

// F2: OMEGA_ROLE=feed runs the data-only feed loop (its own terminal, never an intent); anything else is the executor.
const feed = String(process.env.OMEGA_ROLE || "").trim().toLowerCase() === "feed";
const daemon = feed ? createFeedDaemon() : createDaemon();
daemon.start({ attachSignals: true }).catch((err) => {
  process.stdout.write(
    `${JSON.stringify({
      ts: Date.now(),
      level: "fatal",
      event: "daemon_fatal",
      error: err instanceof Error ? err.message : "fatal_error",
    })}\n`,
  );
  process.exitCode = 1;
});
