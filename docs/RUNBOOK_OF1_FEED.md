# OF1 runbook: the OANDA feed terminal on the existing VPS (F6)

A second MT5 terminal on the owner's VPS acts as a **data-only gold feed**. Its job is to give the MT5 fallback, and through it MX1's gold reference, a broker other than the executor's.

It is built from these pieces:

| Piece | What it is |
|---|---|
| F1 | The server routes |
| F2 | Bridge 1.8.0 with `OMEGA_ROLE=feed` |
| F3 | `ea/mt5/OmegaFeed.mq5`, which contains no trade code |
| F5 | `OMEGA_FEED_CLIENT_ID` |

The VPS Claude runs these steps with the owner. Rules for every step:

- **Never print secrets.** Do not print a login, a password or an account number. Do not print the contents of any env file or ini.
- **Do not touch the existing stack.** The existing prefix, `mt5-terminal`, `mt5-xvfb` and `omega-bridge` stay as they are.

Phases 0–1 are already done: `/opt/mt5-oanda`, Xvfb `:2`, and the units `xvfb-oanda` and `mt5-oanda`.

## 0. Pre-checks

1. Run these and report the numbers only:

   ```bash
   nproc
   ```

   ```bash
   free -h
   ```

   ```bash
   df -h /
   ```

2. Go on only if at least 1 GiB of memory is available.

3. Confirm the executor's sync URL, read-only. Never print the `CF_ACCESS` lines:

   ```bash
   grep -E '^OMEGA_URL=' /etc/omega-bridge/env
   ```

   The expected output is `OMEGA_URL=https://nexus.cryptophys.work/omega`. The feed uses the same base URL. Its route is `/omega/api/bridge/feed-sync` on `nexus.cryptophys.work`, behind the same Access app; `omega.cryptophys.work` has no Access app.

4. Record the existing units' PIDs and `NRestarts`, so step 5 can compare them:

   ```bash
   systemctl show -p MainPID,NRestarts mt5-terminal mt5-xvfb omega-bridge
   ```

## 1. Bridge 1.8.0 for the feed

1. Copy the repo's `bridge/omega-bridge` into `/opt/omega-bridge-oanda`, as root, at the merged commit.
   - The existing `/opt/omega-bridge` is not touched.
2. Install `bridge/omega-bridge/omega-bridge@.service` as `/etc/systemd/system/omega-bridge@.service`.
3. Create the state dir:

   ```bash
   install -d -m 700 /var/lib/omega-bridge-oanda
   ```

4. Create `/etc/omega-bridge/oanda.env` with mode 600, owned by root, from `feed.env.example`. Fill in the paths of the feed terminal. The terminal is the portable OANDA install in the second prefix, with the terminal directory `T="/opt/mt5-oanda/prefix/drive_c/Program Files/OANDA MetaTrader 5"`:
   - `MT5_FILES_DIR="/opt/mt5-oanda/prefix/drive_c/Program Files/OANDA MetaTrader 5/MQL5/Files"` (quoted: the path has spaces; portable, so `MQL5` sits in the terminal directory);
   - `TERMINAL_INI=/opt/mt5-oanda/login.ini` (the file `run.sh` passes as `/config:Z:\opt\mt5-oanda\login.ini`);
   - `TERMINAL_SERVICE`: `mt5-oanda.service`;
   - `OMEGA_SYMBOL`: `XAUUSD.sml`;
   - `CF_ACCESS_CLIENT_ID`: the feed token's client id;
   - `OMEGA_URL`: `https://nexus.cryptophys.work/omega`, the same as the executor.
5. Leave **`CF_ACCESS_CLIENT_SECRET=__OWNER_FILLS__`** as the placeholder.

## 2. The secret (owner only)

1. The owner opens their own SSH session and runs:

   ```bash
   sudoedit /etc/omega-bridge/oanda.env
   ```

2. The owner replaces `__OWNER_FILLS__` with the token's secret.
3. The VPS Claude never reads the file. It checks only these two things:

   ```bash
   stat -c '%a %U' /etc/omega-bridge/oanda.env
   ```

   The expected output is `600 root`.

   ```bash
   grep -c __OWNER_FILLS__ /etc/omega-bridge/oanda.env
   ```

   The expected output is `0`.

The bridge refuses to start while the placeholder is still in the file.

## 3. The EA

1. Before step 4, confirm the terminal directory and the MetaEditor binary. If the `ls` fails, the install path differs: report it and stop.

   ```bash
   T="/opt/mt5-oanda/prefix/drive_c/Program Files/OANDA MetaTrader 5"; ls -d "$T/MQL5/Experts" "$T/MQL5/Files" "$T/MetaEditor64.exe"
   ```

2. Copy the EA from the merged repo checkout into that Experts directory, owned by `mt5`:

   ```bash
   install -o mt5 -g mt5 -m 644 ea/mt5/OmegaFeed.mq5 "/opt/mt5-oanda/prefix/drive_c/Program Files/OANDA MetaTrader 5/MQL5/Experts/OmegaFeed.mq5"
   ```

3. Compile it under Wine as user `mt5`, on the feed's display `:2` and in the feed's own prefix. Never use the executor's prefix or `:99`.

   ```bash
   cd "/opt/mt5-oanda/prefix/drive_c/Program Files/OANDA MetaTrader 5" && sudo -u mt5 env HOME=/opt/mt5-oanda WINEPREFIX=/opt/mt5-oanda/prefix DISPLAY=:2 wine MetaEditor64.exe /portable /compile:"MQL5\Experts\OmegaFeed.mq5" /log:"MQL5\Experts\OmegaFeed.log"
   ```

4. Check that the `.ex5` exists and the log reports 0 errors. The log is UTF-16, hence `iconv`.

   ```bash
   T="/opt/mt5-oanda/prefix/drive_c/Program Files/OANDA MetaTrader 5"; ls -l "$T/MQL5/Experts/OmegaFeed.ex5" && iconv -f UTF-16LE -t UTF-8 "$T/MQL5/Experts/OmegaFeed.log" | grep -Ei "result|error"
   ```

   The expected output is a line like `Result: 0 errors, 0 warnings`. Any error: stop and report the log lines, which hold no secrets.
2. The login ini starts the chart with `Expert=OmegaFeed` and `Symbol=XAUUSD.sml`. The bridge writes these when it applies the login.
3. Algo trading stays **off** in that terminal (`AllowLiveTrading=0`):
   - the bridge forces it on every sync;
   - the EA has no trade code anyway.

## 4. Start and log in

1. Start the bridge:

   ```bash
   systemctl daemon-reload
   ```

   ```bash
   systemctl enable --now omega-bridge@oanda
   ```

2. The bridge makes its own RSA-3072 key in `/var/lib/omega-bridge-oanda` and registers it with its first feed-sync.
3. **Login through Nexus. Prerequisite: F4, the Nexus feed-connection card (frontend session), must be live; without it there is no login path.** The owner opens the Omega Setup feed Connection card for bridge `oanda`. The card posts to the server route `POST /api/feed-connection`, and the server refuses it with `feed_bridge_not_seen` until the bridge's first sync in step 2. The owner enters the OANDA login and server there; it is sealed in the browser to the feed's key.
4. The bridge then:
   - writes the login into `TERMINAL_INI`;
   - restarts `mt5-oanda`;
   - empties `Password=` once the terminal reports it is logged in on that server. `run.sh` passes `/config` only while `Password=` is non-empty, so the next start needs no login file.

## 5. Verify (read-only)

- On the VPS, run these and expect `active`:

  ```bash
  systemctl is-active omega-bridge@oanda mt5-oanda xvfb-oanda
  ```

- Check the bridge's log events:

  ```bash
  journalctl -u omega-bridge@oanda -n 50 -o cat
  ```

  Expect `feed_started`, then `feed_connection_applied`, then `feed_credentials_cleared`.
- The existing units keep the PIDs and `NRestarts` recorded in step 0, item 4.
- On the server, through the agent session's read-only D1, check:
  - `omega_feed_bridges` has a fresh `synced_ms` for `oanda`;
  - `corpus_sources` has a `mt5:oanda…:XAUUSD.SML` row whose `last_minute_ms` is under 2 minutes old;
  - `corpus_feeds` marks that row as a feed.
- During a TradingView outage, the 1m series' `fallback.source` names the OANDA source. The Omega overview's `bridge.symbol_check.reference` then reads "(fallback, another broker)".

## Rollback

1. Stop the feed units:

   ```bash
   systemctl disable --now omega-bridge@oanda mt5-oanda xvfb-oanda
   ```

2. Remove `/opt/omega-bridge-oanda`, `/var/lib/omega-bridge-oanda`, `/etc/omega-bridge/oanda.env` and `/etc/systemd/system/omega-bridge@.service`.
3. Optionally remove `/opt/mt5-oanda` as well.
4. On Omega, the owner clears the feed connection with `DELETE /api/feed-connection`, giving a reason. No manual D1 write is needed.

## Reboot

The pending kernel reboot goes in the market-closed weekend window, not during trading hours.
