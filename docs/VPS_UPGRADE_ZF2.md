# VPS runbook: ZF2 (weekly HUD snapshot)

> **Merged commit:** ZF2 merged into `main` as `e7c055b428eab917deb9c5d00553aa3dae0c4054` (PR #600, 2026-11-26). This runbook checks out exactly that
> commit; its first 12 characters are `e7c055b428ea`.

Written for a Claude Code session on the owner's trading VPS. The owner runs it ("Lanjutkan dan beri panduan claude di
VPS untuk upgrade", 2026-11-26). Follow the steps in order. Stop and report at the first check that fails.

## What ZF2 changes, and what it means for the VPS

- ZF2 adds a weekly (`1W`) HUD snapshot so the zone typing can read weekly boxes (docs/CHANGELOG.md 2026-11-26,
  docs/SSOT.md "Weekly snapshot (ZF2)").
- **Where the producer runs.** The HUD snapshot producer (`local-engines/producer/src/hud-snapshot.mjs`) runs in the
  pull adapter Worker `xauusd-tradingview-pull-adapter` (`market-data-ingestion/src/local-publisher.mjs`, cron every
  minute). It does not run on the VPS. AGENTS.md and docs/SSOT.md: "The VPS runs the bridge and the EA only."
- **Deploy order.** The two Workers deploy from GitHub Actions when the PR merges into `main`:
  `deploy-worker.yml` deploys the AI Worker `xauusd-ai-trading-assistant`, which accepts `1W`, and
  `deploy-market-data-ingestion.yml` deploys the pull adapter, which sends `W1`. The VPS step comes only after both
  runs are green. If the pull adapter goes live a few minutes before the AI Worker, its W1 sends are refused and retried
  every minute until the AI Worker accepts them. That is harmless.
- **So on the VPS, ZF2 needs no restart and no install.** No bridge file (`bridge/omega-bridge/`) and no EA file
  (`ea/mt5/`) changes. This runbook moves the VPS checkout to the merged commit, so the host keeps following `main`
  (AGENTS.md rule 5). Then it checks from the VPS that the weekly snapshot is being written.
- **Restarts:** none. Do not restart the bridge (`omega-bridge.service`), the MT5 terminal (`mt5-terminal.service`)
  or the EA.

## Rules for the VPS session

1. Change nothing in the EA. Do not restart the MT5 terminal. Do not restart `omega-bridge.service`.
2. Never print or paste a key, password, login, account number or token, and never put one in a command line.
3. Never `cat`, `less`, `head`, `grep` or `echo` the contents of `/etc/omega-bridge/env`,
   `/opt/mt5-ingestion-gateway/config/terminal_gateway.ini`, `/var/lib/omega-bridge/*` or
   `MQL5/Files/omega/verified_symbol.txt`. Copying them with `cp` is allowed (step 3). Printing them is not.
4. No `wrangler` command of any kind on this host (AGENTS.md rules 1 and 2). Workers deploy only by merging into `main`.
5. Do not copy anything into `/opt/omega-bridge`. ZF2 changes no bridge file.
6. Stop and report at the first failed check. Do not improvise a fix.

## 1. Preconditions

1. **Find the repository checkout.** docs/OMEGA_BRIDGE.md installs from `/root/omega-bridge-agy`. Check that it is a
   git checkout of this repository:
   ```bash
   git -C /root/omega-bridge-agy remote get-url origin
   ```
   If that path does not exist, find the checkout without guessing:
   ```bash
   find / -xdev -path '*/docs/OMEGA_BRIDGE.md' -not -path '*/node_modules/*' 2>/dev/null
   ```
   The checkout is the directory two levels above the file that turns up. Below, `REPO` stands for that directory
   (`REPO=/root/omega-bridge-agy` or the one you found).
2. **Check that no producer runs here.** Neither the repository nor docs/SSOT.md defines a producer service on the VPS.
   Run:
   ```bash
   systemctl list-units --type=service --all | grep -i -E 'omega|mt5|producer|hud|market|ingest'
   ```
   Expect `omega-bridge.service` and `mt5-terminal.service` (the names in `bridge/omega-bridge/omega-bridge.service`).
   Other units, such as an MT5 ingestion gateway, are not the HUD producer. Leave them alone. If a unit plainly runs
   `hud-snapshot.mjs` or `local-publisher.mjs`, **stop and report**: that would contradict docs/SSOT.md.
3. **Node.** The repository pins no Node version: there is no `engines` field and no `.nvmrc`. docs/OMEGA_BRIDGE.md
   requires Node 20+ for the bridge, and the CI runs the tests on Node 22. Check:
   ```bash
   node --version
   ```
   v20 or later is fine. Nothing in this runbook installs or upgrades Node.
4. **Free disk.** The checkout update needs a few MB:
   ```bash
   df -h "$REPO" /root
   ```
   Stop if the filesystem is above 95 % full.
5. **Market state.** Nothing restarts, so trading is not interrupted. Still, prefer a quiet window: the daily break
   (22:00-23:00 UTC) or the weekend.
6. **The Workers are deployed.** The AI Worker reports the commit it runs:
   ```bash
   curl -s https://ai.cryptophys.work/health | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status"), d.get("commit"))'
   ```
   Expect `ok` and `e7c055b428ea` (the first 12 characters of the merged commit), or of a later `main` commit that contains it. If the
   commit is older, wait for `deploy-worker.yml` to finish, then check again. Do not deploy anything yourself.

## 2. Record the current state

1. Record the commit the checkout is on now (`OLD`). Keep it for the rollback:
   ```bash
   cd "$REPO" && git rev-parse HEAD | tee /root/zf2-old-commit.txt
   git status --short
   ```
   If `git status --short` lists changed files, **stop and report**. Do not stash, reset or commit them.
2. Stop nothing.

## 3. Back up (copy only, never print)

```bash
B=/root/backup-zf2-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$B"
cp -a /etc/omega-bridge/env "$B/" 2>/dev/null || true
cp -a /etc/systemd/system/omega-bridge.service "$B/" 2>/dev/null || true
cp -a /opt/omega-bridge "$B/opt-omega-bridge"
ls -la "$B"
```

`ls -la` lists names, sizes and modes only. Never open the copied files. ZF2 changes none of them: this is a precaution.

## 4. Move the checkout to the merged commit

1. Fetch, then check out:
   ```bash
   cd "$REPO"
   git fetch origin
   git checkout e7c055b428eab917deb9c5d00553aa3dae0c4054
   git rev-parse HEAD
   ```
   `git rev-parse HEAD` must print `e7c055b428eab917deb9c5d00553aa3dae0c4054`. A "detached HEAD" notice is expected.
2. Confirm that no file the VPS runs has changed (both commands must print nothing):
   ```bash
   git diff --name-only "$(cat /root/zf2-old-commit.txt)" e7c055b428eab917deb9c5d00553aa3dae0c4054 -- bridge/ ea/
   git diff --name-only "$(cat /root/zf2-old-commit.txt)" e7c055b428eab917deb9c5d00553aa3dae0c4054 -- package-lock.json bridge/omega-bridge/package.json
   ```
   If the first command lists files, the checkout moved over other changes as well, made by other PRs since `OLD`.
   **Stop and report** them: those changes need their own runbook. If the second lists files, do not run `npm`: the
   bridge has no dependencies, and ZF2 changes no lockfile. Report it.
3. **The producer's tests (optional; CI already ran them).** Both files need no `npm install`. They take about
   30 seconds of CPU, so run them at low priority:
   ```bash
   cd "$REPO" && nice -n 19 node --test local-engines/producer/test/hud-snapshot-weekly.test.mjs test/hud-weekly.test.mjs
   ```
   Expect `# fail 0`. A failure is a report, not a reason to change anything.
4. **Restart: none.** The producer is the pull adapter Worker, and it is already live (step 1.6). Restart nothing on
   this host.

## 5. Verify

You need no Cloudflare token for any of these checks.

1. **The pull adapter's health.** The pull adapter `xauusd-tradingview-pull-adapter` serves a public `GET /health`
   (no token) on its `workers.dev` URL, written here as `<PULL_ADAPTER_URL>`. This public repository does not write
   the URL down, because it names the owner's Cloudflare account. Get it one of two ways, and never guess it:
   - **Ask the owner** for the pull adapter's workers.dev URL.
   - **Or read it from the deploy run's summary.** The latest successful run of **Deploy market data ingestion**
     (`deploy-market-data-ingestion.yml`) prints it only there, as "Deployed URL" in the run's summary. With the
     GitHub CLI signed in on this host:
     ```bash
     gh run list --repo cryptophys-adm/xauusd-ai-trading-assistant --workflow deploy-market-data-ingestion.yml --status success --limit 1
     gh run view <run id> --repo cryptophys-adm/xauusd-ai-trading-assistant --log | grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -n1
     ```
   Then set it once, and do not paste it into any file, issue or chat outside this VPS session:
   ```bash
   PULL=<PULL_ADAPTER_URL>
   ```
   ```bash
   curl -s "$PULL/health" | python3 -c '
   import json,sys
   d=json.load(sys.stdin); h=d.get("last_hud_publish") or {}
   print("commit", d.get("commit"), "published_at", h.get("published_at"))
   for c,r in sorted((h.get("charts") or {}).items()): print(c, r)'
   ```
   What to look for:
   - `commit` is `e7c055b428ea` (the first 12 characters of the merged commit) (or a later `main` commit).
   - `published_at` is within the last few minutes. The summary is rewritten every minute.
   - **W1:** `status` is `published` or `already_published`, the `candle_key` starts with `OANDA:XAUUSD:1W:`, and
     `chart_plane` is `cryptophys.chart-plane.weekly.v1` on the run that published it. The first publish comes at the
     latest a minute after the deploy: the latest weekly close is always within the 6-day catch-up window, except
     between Saturday 22:00 and Sunday 22:00 UTC, while the market is shut. That first publish reads
     `catch_up: true`. `published` means the AI Worker stored it with status 202, so `hud:1W:latest` exists.
     `already_published` with a `1W` key means it was stored on an earlier minute. The candle key is the open of the
     last closed week: `OANDA:XAUUSD:1W:1794780000000` (week of 2026-11-15 22:00 UTC) until the close on
     2026-11-29 at 22:00 UTC, then `OANDA:XAUUSD:1W:1795384800000`, and so on, one week (604800000 ms) at a time.
   - **Not good:** `rejected` (the AI Worker refused it: wait for `deploy-worker.yml`, then check again after
     2 minutes; still `rejected`, stop and report), `insufficient_hud_history` (the bundle holds fewer than 200 weekly
     bars: report), `hud_snapshot_failed` or `post_failed` (report).
2. **The four other charts keep writing.** In the same output, `H1`, `M15`, `H4` and `D1` show the statuses and
   `1H`/`15`/`240`/`1D` candle keys they showed before. Each reads `published`, `already_published` or, between
   closes, `no_fresh_close`. H1 and M15 must reach `published` on each new bar: H1 within a few minutes of the hour,
   M15 within a few minutes of each quarter hour, while the market is open. Check twice, 15 minutes apart.
3. **The AI Worker still answers:**
   ```bash
   curl -s https://ai.cryptophys.work/health | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status"))'
   ```
   It must print `ok`.
4. **The bridge and the EA are untouched:**
   ```bash
   systemctl is-active omega-bridge.service mt5-terminal.service
   journalctl -u omega-bridge --since '-15 min' --no-pager | tail -n 20
   ```
   Both must be `active`. The log must show the usual sync lines, with no new errors since the step 4 checkout.
   Do not paste log lines that contain an account or a login.
5. Report: `OLD`, `e7c055b428eab917deb9c5d00553aa3dae0c4054`, the W1 line, the four other charts' lines, both health statuses, and "no
   restart".

## 6. Roll back (only if a check failed and the owner asks)

ZF2 ran nothing new on this host, so the VPS rollback only puts the checkout back:

```bash
cd "$REPO" && git checkout "$(cat /root/zf2-old-commit.txt)" && git rev-parse HEAD
```

- Restart nothing. The "same process" is the pull adapter Worker, not a VPS process. Never roll it back from the VPS
  (no `wrangler`, AGENTS.md rule 2). A Worker rollback is a revert PR merged into `main`, done by the owner or a cloud
  session.
- Then verify the four charts as in step 5.2. After a revert of ZF2 is deployed, `W1` disappears from
  `last_hud_publish`, and `hud:1W:latest` expires on its own within 8 days. That is harmless, because nothing but the
  zone typing reads it.
- The backup in `$B` is not needed for a ZF2 rollback, since ZF2 touched none of those files. Leave it in place. Never
  print it.
