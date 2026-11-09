#!/usr/bin/env node
import { createDaemon } from "../src/daemon.mjs";

const daemon = createDaemon();
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
