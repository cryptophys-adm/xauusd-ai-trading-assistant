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

4. Create `/etc/omega-bridge/oanda.env` with mode 600, owned by root, from `feed.env.example`. Fill in the paths of the feed terminal:
   - `MT5_FILES_DIR`: its `MQL5/Files` directory;
   - `TERMINAL_INI`: the `login.ini` that `run.sh` reads;
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

1. Compile `ea/mt5/OmegaFeed.mq5` in the feed terminal, under `/opt/mt5-oanda`'s `MQL5/Experts`.
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
3. **Login through Nexus.** The owner opens the Omega Setup feed Connection card for bridge `oanda`. It needs the frontend card (F4) and the server route `POST /api/feed-connection`. The owner enters the OANDA login and server there; it is sealed in the browser to the feed's key.
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
