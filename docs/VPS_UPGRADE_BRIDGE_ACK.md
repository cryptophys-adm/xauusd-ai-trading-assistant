# VPS runbook: omega-bridge 1.7.1 (lost acks from the results-file race)

> **Fill in before use:** `<MERGED_COMMIT>` is the full SHA of this fix's merge commit on `main`. It is known only
> after the PR merges. Until someone replaces every `<MERGED_COMMIT>` below with it, do not run this runbook.

Written for a Claude Code session on the owner's trading VPS. The owner runs it. Follow the steps in order. **Stop and
report at the first check that fails.** Do not improvise a fix.

Shell variables do not survive between commands in a Claude Code session, so the steps save `REPO`, `F`, `OLD` and `B`
in small files under `/root` (`bridge-ack-*.txt`) and each command block reads them back.

## What changes, and what it means for the VPS

- Owner 2026-11-26: "Ya, bridge saja". The fix is in the bridge only (`bridge/omega-bridge/src/files.mjs` and
  `src/daemon.mjs`, version 1.7.0 → 1.7.1). The EA (`ea/mt5/OmegaExecutor.mq5`) does not change.
- The bridge now renames `results.txt` only after 400 ms without a write, reads the `.done` files of the last 60 s
  again, skips an incomplete last line until it is complete, and sends each intent id once (docs/OMEGA_BRIDGE.md
  "Results-file race").
- On this host the upgrade is: copy the bridge's `src/` into `/opt/omega-bridge`, then restart `omega-bridge.service`.
  That is the only restart. The bridge has no npm dependencies (`bridge/omega-bridge/package.json` lists none), so
  there is no `npm ci`.
- **The bridge serves no `/health`.** It only makes outbound requests (docs/OMEGA_BRIDGE_PROTOCOL.md: "Nothing calls
  the bridge"). Here, its version is the `daemon_started` line in its journal and the `BRIDGE_VERSION` line in the
  installed code. Its state is read from the EA's `state.json` and the bridge's `intents.txt`, printing only the safe
  fields named below. The Worker-side health (`bridge.bridge_version` in the Omega `/api/health`) needs a Cloudflare
  Access login. The orchestrator checks it, not this session.

Where the names come from:

| Name | Source in the repository |
|---|---|
| `/root/omega-bridge-agy` (the checkout) | docs/OMEGA_BRIDGE.md, "Install the `omega-bridge` daemon" and "Calm mode" update steps |
| `/opt/omega-bridge` (the installed bridge) | `bridge/omega-bridge/omega-bridge.service` (`WorkingDirectory`, `ExecStart`), docs/OMEGA_BRIDGE.md |
| `omega-bridge.service`, `journalctl -u omega-bridge` | `bridge/omega-bridge/omega-bridge.service` (`SyslogIdentifier=omega-bridge`), docs/OMEGA_BRIDGE.md |
| `mt5-terminal.service` (never restarted here) | `DEFAULT_TERMINAL_SERVICE` in `bridge/omega-bridge/src/daemon.mjs`, docs/OMEGA_BRIDGE.md |
| `.../MQL5/Files/omega` (the exchange directory) | `DEFAULT_OMEGA_FILES_DIR` in `bridge/omega-bridge/src/files.mjs`, docs/OMEGA_BRIDGE.md "Local File Exchange" |
| Node 20+ | docs/OMEGA_BRIDGE.md, "Install the `omega-bridge` daemon" |

## Rules for the VPS session

1. **No EA change.** Do not copy, compile, attach or edit anything under `ea/` or in `MQL5/Experts`.
2. **No terminal restart.** Never restart, stop or start `mt5-terminal.service`. Restart only `omega-bridge.service`.
3. **Never print a key, env file or account data.** Never `cat`, `less`, `head`, `tail`, `grep` or `echo` the contents
   of `/etc/omega-bridge/env`, `/opt/mt5-ingestion-gateway/config/terminal_gateway.ini`, `/var/lib/omega-bridge/*` or
   `MQL5/Files/omega/verified_symbol.txt`, and never print `state.json` whole. Read `state.json` and `intents.txt`
   only through the commands below, which print counts, ages and booleans. Do not paste journal lines. The commands
   below print only event names and the fields named.
4. No `wrangler` command of any kind on this host (AGENTS.md rules 1 and 2). Never deploy from the VPS.
5. Stop and report at the first failed check.

## The check script

Save it once, before step 1. It reads the EA's `state.json` and the bridge's `intents.txt` and prints only booleans,
counts and ages: never an account field, a ticket, a price or an intent id. Steps 1.5 and 4 run it.

```bash
cat > /root/bridge-ack-check.py <<'PY'
import json, os, sys, time
d = sys.argv[1]
now = time.time() * 1000
def text(name):
    with open(os.path.join(d, name), "rb") as f:
        return f.read().decode("utf-8", "replace").lstrip("\ufeff").replace("\x00", "").strip()
try:
    s = json.loads(text("state.json"))
except Exception as e:
    print("state.json unreadable:", type(e).__name__); s = None
if s is not None:
    rm = s.get("received_ms")
    print("connected:", s.get("connected") is True)
    print("state_age_s:", round((now - rm) / 1000, 1) if isinstance(rm, (int, float)) else None)
    print("positions:", len(s.get("positions") or []))
    print("orders:", len(s.get("orders") or []))
try:
    lines = [l for l in text("intents.txt").splitlines() if l.strip()]
    head = lines[0].split(";") if lines else []
    written = int(head[1]) if len(head) > 1 and head[1].isdigit() else None
    print("intents_age_s:", round((now - written) / 1000, 1) if written else None)
    print("pending_intents:", len([l for l in lines[1:] if not l.startswith("#")]))
except Exception as e:
    print("intents.txt unreadable:", type(e).__name__)
names = os.listdir(d)
print("results_txt_present:", "results.txt" in names)
print("done_files:", len([n for n in names if n.startswith("results.") and n.endswith(".done")]))
PY
```

## 1. Preconditions

1. **Find the repository checkout.** docs/OMEGA_BRIDGE.md installs from `/root/omega-bridge-agy`:
   ```bash
   git -C /root/omega-bridge-agy remote get-url origin
   ```
   If that path does not exist, find the checkout without guessing:
   ```bash
   find / -xdev -path '*/docs/OMEGA_BRIDGE.md' -not -path '*/node_modules/*' 2>/dev/null
   ```
   The checkout is two levels above the file found. Save it as `REPO`:
   ```bash
   echo /root/omega-bridge-agy | tee /root/bridge-ack-repo.txt   # or the directory you found
   ```
2. **Verify the commit.**
   ```bash
   REPO=$(cat /root/bridge-ack-repo.txt); cd "$REPO" && git status --short
   git rev-parse HEAD | tee /root/bridge-ack-old-commit.txt
   git fetch origin
   git cat-file -t <MERGED_COMMIT>
   git merge-base --is-ancestor <MERGED_COMMIT> origin/main && echo "on main"
   git show -s --format='%H %s' <MERGED_COMMIT>
   git show <MERGED_COMMIT>:bridge/omega-bridge/src/daemon.mjs | grep -m1 'export const BRIDGE_VERSION'
   ```
   - `git status --short` must print nothing. If it lists files, **stop and report**. Do not stash, reset or commit.
   - `git cat-file -t` must print `commit`, and the next command must print `on main`.
   - The subject names the bridge 1.7.1 fix, and the last line is `export const BRIDGE_VERSION = "1.7.1";`.
3. **What the upgrade moves over.** Both commands use the commit recorded in step 1.2:
   ```bash
   REPO=$(cat /root/bridge-ack-repo.txt); OLD=$(cat /root/bridge-ack-old-commit.txt); cd "$REPO"
   git diff --name-only "$OLD" <MERGED_COMMIT> -- bridge/ ea/
   git diff --name-only "$OLD" <MERGED_COMMIT> -- ea/ bridge/omega-bridge/bin bridge/omega-bridge/omega-bridge.service bridge/omega-bridge/package.json bridge/omega-bridge/env.example
   ```
   - The first list should hold only `bridge/omega-bridge/src/daemon.mjs`, `bridge/omega-bridge/src/files.mjs` and
     files under `bridge/omega-bridge/test/`.
   - The second must print nothing. If it lists any file, other PRs changed the EA, the bridge's entry point, its
     service unit or its configuration since `OLD`. **Stop and report** the names. Those changes need their own
     runbook.
4. **The installed bridge is the one you think it is.**
   ```bash
   REPO=$(cat /root/bridge-ack-repo.txt); OLD=$(cat /root/bridge-ack-old-commit.txt)
   grep -m1 'export const BRIDGE_VERSION' /opt/omega-bridge/src/daemon.mjs
   git -C "$REPO" diff --quiet "$OLD" -- bridge/omega-bridge/src && echo "checkout src unchanged since OLD"
   diff -rq "$REPO/bridge/omega-bridge/src" /opt/omega-bridge/src && echo "installed src equals the checkout"
   ```
   Expect `export const BRIDGE_VERSION = "1.7.0";` and both `echo` lines. If `diff -rq` lists files, the installed
   bridge is not the checkout's `OLD`: **stop and report** the file names that `diff -rq` printed. Print nothing else.
5. **Omega must be flat: no open Omega position, no pending order and no pending intent.** No Cloudflare token is
   needed. The exchange directory is `DEFAULT_OMEGA_FILES_DIR` unless `MT5_FILES_DIR` moved it. Find it from the EA's
   own `state.json` (the EA rewrites it every 2 s), without reading the env file:
   ```bash
   echo "/opt/mt5-ingestion-gateway/prefix/drive_c/Program Files/MetaTrader 5/MQL5/Files/omega" > /root/bridge-ack-files-dir.txt
   F=$(cat /root/bridge-ack-files-dir.txt); ls -l --time-style=+%s "$F/state.json" "$F/intents.txt"
   ```
   If either file is missing, or `state.json`'s time (seconds since the epoch) is more than a minute old, find the
   directory the EA writes now:
   ```bash
   find / -xdev -path '*/MQL5/Files/omega/state.json' -printf '%T@ %h\n' 2>/dev/null | sort -n | tail -n 3
   ```
   The newest line is that directory: write it (the part after the time) into `/root/bridge-ack-files-dir.txt`
   instead. Then run the check script (saved in "The check script" above; it prints only booleans, counts and ages):
   ```bash
   python3 /root/bridge-ack-check.py "$(cat /root/bridge-ack-files-dir.txt)"
   ```
   Flat means `positions: 0`, `orders: 0` and `pending_intents: 0` (`intents.txt` is rewritten after each answered sync
   with every intent still waiting for a result). If any is above 0, **wait** and run the script again every few
   minutes until all three read 0. Do not close anything yourself. `connected: True` and a `state_age_s` under about
   60 are also expected here; if not, **stop and report**: the terminal is not healthy before the upgrade.
6. **Market window.** Prefer a quiet window: the daily break (22:00-23:00 UTC) or the weekend.
   ```bash
   date -u
   ```
   Outside one, go ahead only if Omega is flat (step 5) and the owner said to.
7. **Node.**
   ```bash
   /usr/bin/node --version
   ```
   `ExecStart` in `omega-bridge.service` runs `/usr/bin/node`. It must be v20 or later. Nothing here installs or
   upgrades Node. If it is older, **stop and report**.
8. **Free disk.**
   ```bash
   df -h /opt /root
   du -sh /opt/omega-bridge
   ```
   The backup needs about the size `du` prints (the bridge is a few hundred KB). Stop if either filesystem is above
   95 % full.

## 2. Back up (copy only, never print)

```bash
B=/root/backup-bridge-ack-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$B"
cp -a /opt/omega-bridge "$B/opt-omega-bridge"
cp -a /etc/systemd/system/omega-bridge.service "$B/" 2>/dev/null || true
cp /root/bridge-ack-old-commit.txt "$B/old-commit.txt"
grep -m1 'export const BRIDGE_VERSION' /opt/omega-bridge/src/daemon.mjs | tee "$B/version-before.txt"
systemctl show mt5-terminal.service -p ActiveEnterTimestamp | tee "$B/terminal-started-before.txt"
echo "$B" | tee /root/bridge-ack-backup-path.txt
ls -la "$B"
```

- Do not copy, open or print `/etc/omega-bridge/env` or `/var/lib/omega-bridge/*`. The upgrade changes neither.
- **Record the running version.** The bridge has no `/health`. Its last start line in the journal says which version
  runs. This prints only three fields:
  ```bash
  B=$(cat /root/bridge-ack-backup-path.txt)
  journalctl -u omega-bridge --no-pager -o cat | grep '"event":"daemon_started"' | tail -n 1 \
    | python3 -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); print("running:", d.get("bridge_version"), "calm_mode:", d.get("calm_mode"), "results_debounce_ms:", d.get("results_debounce_ms"))' \
    | tee "$B/running-before.txt"
  ```
  Expect `running: 1.7.0`. If the journal no longer holds a start line, `running: None` is fine: step 1.4 already read
  the installed version.

## 3. Install

Follow the bridge's own update steps (docs/OMEGA_BRIDGE.md "Calm mode", **Update on the VPS**), on the merged commit:

1. Check out the merged commit:
   ```bash
   cd "$(cat /root/bridge-ack-repo.txt)" && git checkout <MERGED_COMMIT> && git rev-parse HEAD
   ```
   `git rev-parse HEAD` must print `<MERGED_COMMIT>`. A "detached HEAD" notice is expected.
2. **The bridge's tests (optional; CI already ran them).** They need no `npm install` and no network. They use temp
   directories only and take a few seconds:
   ```bash
   cd "$(cat /root/bridge-ack-repo.txt)" && nice -n 19 node --test bridge/omega-bridge/test/*.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)'
   ```
   Expect `# fail 0`. A failure means **stop and report**. Do not install.
3. Copy the code:
   ```bash
   REPO=$(cat /root/bridge-ack-repo.txt)
   sudo cp -r "$REPO/bridge/omega-bridge/src" /opt/omega-bridge/
   diff -rq "$REPO/bridge/omega-bridge/src" /opt/omega-bridge/src && echo "installed src equals <MERGED_COMMIT>"
   grep -m1 'export const BRIDGE_VERSION' /opt/omega-bridge/src/daemon.mjs
   for f in /opt/omega-bridge/src/*.mjs; do /usr/bin/node --check "$f" || echo "SYNTAX FAIL $f"; done
   ```
   Expect the `echo` line, `export const BRIDGE_VERSION = "1.7.1";` and no `SYNTAX FAIL`. `bin/` is unchanged (step
   1.3), so it is not copied. No `npm ci`: the bridge has no dependencies.
4. Restart the bridge, and **only** the bridge:
   ```bash
   date '+%Y-%m-%d %H:%M:%S' | tee /root/bridge-ack-restart-time.txt
   sudo systemctl restart omega-bridge.service
   systemctl is-active omega-bridge.service
   ```
   It must print `active`. Never run `systemctl restart mt5-terminal.service`, and never touch the EA.

## 4. Verify

1. **Version and settings.** Wait about 10 s after the restart, then:
   ```bash
   journalctl -u omega-bridge --since "$(cat /root/bridge-ack-restart-time.txt)" --no-pager -o cat | grep '"event":"daemon_started"' | tail -n 1 \
     | python3 -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); print("running:", d.get("bridge_version"), "calm_mode:", d.get("calm_mode"), "results_debounce_ms:", d.get("results_debounce_ms"), "results_reread_ms:", d.get("results_reread_ms"))'
   ```
   Expect `running: 1.7.1 calm_mode: True results_debounce_ms: 400 results_reread_ms: 60000`.
2. **Connected, with fresh state.** Run the check from step 1.5 twice, 15 s apart:
   ```bash
   python3 /root/bridge-ack-check.py "$(cat /root/bridge-ack-files-dir.txt)"
   ```
   Expect `connected: True`, a `state_age_s` under about 60, and an `intents_age_s` under about 15. The bridge rewrites
   `intents.txt` only after the Worker answered a sync, so a fresh one shows that the bridge reaches Omega.
3. **No errors since the restart.** This prints event names and counts only:
   ```bash
   journalctl -u omega-bridge --since "$(cat /root/bridge-ack-restart-time.txt)" --no-pager -o cat \
     | python3 -c '
   import json,sys,collections
   c=collections.Counter()
   for l in sys.stdin:
       try: d=json.loads(l)
       except Exception: continue
       if d.get("level") in ("error","warn"): c[d.get("event")]+=1
   print(dict(c) or "no warnings or errors")'
   ```
   Expect `no warnings or errors`. `result_recovered` (a warning) is the fix at work: a line the EA wrote after a rename,
   now reported. Note how many there are. Any `sync_*` error or `result_partial_line_dropped` means **stop and
   report** (names and counts only).
4. **The terminal was not restarted.**
   ```bash
   systemctl show mt5-terminal.service -p ActiveEnterTimestamp
   cat "$(cat /root/bridge-ack-backup-path.txt)/terminal-started-before.txt"
   ```
   The two timestamps must be equal. If they differ, **stop and report**.
5. **The next intents ack normally.** Omega was flat, so the next intent may take a while. When it comes, run the
   step 4.2 check again a few times:
   - `pending_intents` goes above 0, then back to 0 within about 10 s;
   - `results_txt_present` is `False` again within about a second after the EA wrote it;
   - `done_files` grows by one each time, and stays at 20 at most.
   Then run step 4.3 again. Expect no new error. Report what you saw, or "no intent yet" with the time.
6. **Over the next 24 hours** CA1's `intent_reconciled` close rows should drop toward 0, because the acks now arrive. The
   orchestrator checks that from D1. **This session does not need to.**
7. Report: `OLD`, `<MERGED_COMMIT>`, the version before and after, the step 4.2 output, the step 4.3 counts, the step
   4.4 timestamps, and "no terminal restart, no EA change".

## 5. Roll back (only if a check failed, or the owner asks)

1. Put the saved bridge back and restart **only** the bridge:
   ```bash
   B=$(cat /root/bridge-ack-backup-path.txt)
   sudo mv /opt/omega-bridge "/opt/omega-bridge.failed-$(date -u +%Y%m%dT%H%M%SZ)"
   sudo cp -a "$B/opt-omega-bridge" /opt/omega-bridge
   grep -m1 'export const BRIDGE_VERSION' /opt/omega-bridge/src/daemon.mjs
   date '+%Y-%m-%d %H:%M:%S' | tee /root/bridge-ack-restart-time.txt
   sudo systemctl restart omega-bridge.service
   systemctl is-active omega-bridge.service
   ```
   Expect `export const BRIDGE_VERSION = "1.7.0";` and `active`.
2. Check it as in step 4: step 4.1 must print `running: 1.7.0`, and steps 4.2 and 4.4 must pass as before.
3. Put the checkout back:
   ```bash
   B=$(cat /root/bridge-ack-backup-path.txt); cd "$(cat /root/bridge-ack-repo.txt)" && git checkout "$(cat "$B/old-commit.txt")" && git rev-parse HEAD
   ```
- The `.done` files 1.7.1 wrote have the same format, and 1.7.0 prunes them as before. Leave them.
- Never restart `mt5-terminal.service`, and never touch the EA, in a rollback either.
- Leave `$B` and `/opt/omega-bridge.failed-*` in place for the report. Never print their contents.
