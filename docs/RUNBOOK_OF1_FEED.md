# OF1 runbook: the OANDA feed terminal on the existing VPS (F6)

A second MT5 terminal on the owner's VPS acts as a **data-only gold feed**. Its job is to give the MT5 fallback, and through it MX1's gold reference, a broker other than the executor's.

It is built from these pieces:

| Piece | What it is |
|---|---|
| F1 | The server routes |
| F2 | Bridge 1.8.0 with `OMEGA_ROLE=feed` (1.8.1 also sends the macro corpus) |
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

**Bridge 1.8.1 (macro export step 2, 2026-11-27).** The feed bridge also sends its terminal's `omega/corpus_macro.json` (OmegaFeed 1.01) with its sync: per base only the bars after the server's cursor, only once the server answers `corpus_macro_cursors`, and only when the file changed. Before the server ingests the feed's macro bars (macro export step 3) it sends nothing more than 1.8.0. The executor is not changed: `/opt/omega-bridge` and `omega-bridge` stay as they are. One VPS change at a time, with the owner's go, after OmegaFeed 1.01 is installed and checked (section 3).

1. Copy the repo's `bridge/omega-bridge` over `/opt/omega-bridge-oanda`, as root, at the merged commit. Only the feed's copy.
2. Check the version and the syntax:

   ```bash
   grep -E '^export const BRIDGE_VERSION' /opt/omega-bridge-oanda/src/daemon.mjs && for f in /opt/omega-bridge-oanda/src/*.mjs; do node --check "$f" || echo "SYNTAX FAIL $f"; done
   ```

   Expect `export const BRIDGE_VERSION = "1.8.1";` and no `SYNTAX FAIL`.
3. Restart only the feed's bridge, then check its start line:

   ```bash
   systemctl restart omega-bridge@oanda
   ```

   ```bash
   journalctl -u omega-bridge@oanda -n 20 -o cat | grep -E 'feed_started|feed_sync_http|feed_loop_error'
   ```

   Expect `feed_started` with `"version":"1.8.1"` and no `feed_sync_http` or `feed_loop_error`. The executor's `omega-bridge` keeps its PID and `NRestarts`.

**Bridge 1.8.2 and `feed-run.sh` (feed incident 2026-11-27).** After the bridge empties `Password=` (once the terminal is logged in), the old `run.sh` started the terminal without `/config`, so after any restart (a reboot, a unit restart, a crash) the chart opened without OmegaFeed and the feed went stale. 1.8.2 keeps a credential-free `startup.ini` beside `login.ini` (no `[Common]` section: no login, no password; `[StartUp]` Expert=OmegaFeed on the feed's symbol, M1; algo trading off; owned like `login.ini`, mode 600), and `bridge/omega-bridge/feed-run.sh` always passes a `/config`: `login.ini` while it holds a password, else `startup.ini` (the saved account logs in by itself). Install both together, one VPS change, with the owner's go. The executor is not changed.

1. Copy the repo's `bridge/omega-bridge` over `/opt/omega-bridge-oanda` at the merged commit (only the feed's copy) and check it as for 1.8.1. Expect `export const BRIDGE_VERSION = "1.8.2";` and no `SYNTAX FAIL`.
2. Restart only the feed's bridge, then check that `startup.ini` exists and holds no login (counts only, nothing printed from the file):

   ```bash
   systemctl restart omega-bridge@oanda
   ```

   ```bash
   f=/opt/mt5-oanda/startup.ini; ls -l "$f" && echo "login lines: $(grep -Ec '^(Login|Password|Server)=' "$f")" && echo "expert lines: $(grep -c '^Expert=OmegaFeed$' "$f")"
   ```

   Expect mode `-rw-------` with the same owner as `login.ini`, `login lines: 0` and `expert lines: 1`.
3. Compare the current start script with the new one before replacing it. Show the diff (both files hold paths only, no secret):

   ```bash
   diff -u /opt/mt5-oanda/run.sh /opt/omega-bridge-oanda/feed-run.sh
   ```

   **Stop and report** if the current script does anything the new one does not (another environment variable, a flag, a path, a wine option). Otherwise keep a backup and install it with the old file's owner and mode:

   ```bash
   r=/opt/mt5-oanda/run.sh; cp -p "$r" "$r.bak" && install -o "$(stat -c %u "$r")" -g "$(stat -c %g "$r")" -m "$(stat -c %a "$r")" /opt/omega-bridge-oanda/feed-run.sh "$r" && sh -n "$r" && echo installed
   ```

4. Restart the feed terminal with the guarded line (section 3), then check after two minutes that the EA writes again (times only):

   ```bash
   T="/opt/mt5-oanda/prefix/drive_c/Program Files/OANDA MetaTrader 5"; date -u; stat -c '%y %n' "$T/MQL5/Files/omega/state.json" "$T/MQL5/Files/omega/corpus.json"
   ```

   Both files must be under a minute old. Then check that the terminal logged in by itself from its saved account (`startup.ini` holds no login, so this only works if MT5 kept the password from the earlier `/config` login). Print only these two fields:

   ```bash
   T="/opt/mt5-oanda/prefix/drive_c/Program Files/OANDA MetaTrader 5"; python3 -c 'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8-sig")); print(d.get("connected"), d.get("server"))' "$T/MQL5/Files/omega/state.json"
   ```

   Expect `True OANDA_Global-Live-1`. **If it prints `False`, stop:** re-enter the feed login on Nexus > Live > Data feeds (the bridge restarts with the login file) and report.

   If the EA did not attach at all (the files stay old), compare the two files' line endings first, by counts only (`startup.ini` uses LF):

   ```bash
   for f in /opt/mt5-oanda/login.ini /opt/mt5-oanda/startup.ini; do printf '%s CR=%s lines=%s\n' "$f" "$(tr -cd '\r' < "$f" | wc -c)" "$(wc -l < "$f")"; done
   ```

   Report the counts before trying anything else. Rollback: `cp -p /opt/mt5-oanda/run.sh.bak /opt/mt5-oanda/run.sh`.

## 1b. Bridge 1.8.3 and OmegaFeed 1.02: the backfill (BF1 b + c, one VPS change with the owner's go)

**What it does.** Since BF1 (a) the server answers each feed sync with `corpus_backfill_from_ms`: the feed source's first missing trading minute in the last 10 hours, or null. Bridge 1.8.3 walks that hole once, oldest first. Each sync sends up to 200 bars from the walk's position plus the newest 40 after the server's cursor, so the feed stays fresh. When `corpus.json` does not reach back that far, the bridge writes `omega/corpus_from.json` (`{"from_ms":…,"until_ms":…}`, one line, times only). OmegaFeed 1.02 then writes the closed M1 bars from there to the last closed bar (at most 600), and echoes `backfill_from_ms` in `corpus.json`. Once the walk ends, or the server answers null, the bridge removes the request file and the EA returns to its last `CorpusBars` bars. A minute the broker never had (a holiday's early close, 26 Nov 19:25Z) is walked once and then left; it ages out of the server's 10-hour window. Still no trade code, no account data, no intents. The executor's bridge and EA are not changed. Install the bridge and the EA together.

**The VPS runs bridge 1.8.1 on the feed (read from D1 2026-11-28).** This install therefore also brings 1.8.2's `startup.ini` and `feed-run.sh` (above). Do those steps 2 to 4 in the same change.

1. Back up the feed's bridge, then copy the repo's `bridge/omega-bridge` over `/opt/omega-bridge-oanda` at the merged commit (only the feed's copy):

   ```bash
   cp -a /opt/omega-bridge-oanda /opt/omega-bridge-oanda.bak-1.8.1 && echo backed-up
   ```

   Check it as for 1.8.1. Expect `export const BRIDGE_VERSION = "1.8.3";` and no `SYNTAX FAIL`.
2. If `startup.ini` and `feed-run.sh` are not installed yet, do 1.8.2's steps 2 to 4 above.
3. Install OmegaFeed 1.02 with section 3's steps 1 to 4 (copy, compile, check `Result: 0 errors`). Restart only the feed's terminal with the guarded line there, then restart the feed's bridge:

   ```bash
   systemctl restart omega-bridge@oanda
   ```

4. Check the start line and any backfill events. The events carry times only:

   ```bash
   journalctl -u omega-bridge@oanda --since -10min -o cat | grep -E 'feed_started|feed_backfill|feed_sync_http|feed_loop_error'
   ```

   Expect `feed_started` with `"version":"1.8.3"` and no `feed_sync_http` or `feed_loop_error`. `feed_backfill_*` lines appear only while the server reports a hole.
5. Check that the EA writes 1.02's corpus. This prints the bar count, the first and last bar times and whether it answers a request; no prices:

   ```bash
   T="/opt/mt5-oanda/prefix/drive_c/Program Files/OANDA MetaTrader 5"; python3 -c 'import json,sys,datetime as D; d=json.load(open(sys.argv[1], encoding="utf-8-sig")); b=d["bars"]; f=lambda ms: D.datetime.fromtimestamp(ms/1000, D.timezone.utc).isoformat(); print(len(b), f(b[0][0]), f(b[-1][0]), "backfill_from_ms" in d)' "$T/MQL5/Files/omega/corpus.json"; ls -l "$T/MQL5/Files/omega/corpus_from.json" 2>/dev/null || echo "no request file"
   ```

   Without a hole: about 120 bars, `False`, `no request file`. During a walk the request file exists, and after the EA's next write the count is up to 600 and the flag is `True`.
6. The agent then checks read-only that the feed source's `corpus_sources.backfill_from_ms` turns null once a hole is walked (D1, no rows of prices). The first real test is the next reconnect or broker switch.

**Rollback.** Restore the bridge backup and the 1.01 EA (section 3 with the 1.01 file from the previous commit), then restart only the feed's terminal (guarded line) and `omega-bridge@oanda`:

```bash
rm -rf /opt/omega-bridge-oanda && cp -a /opt/omega-bridge-oanda.bak-1.8.1 /opt/omega-bridge-oanda && echo restored
```

A leftover `omega/corpus_from.json` is harmless to 1.01, which never reads it. Remove it with `rm -f "$T/MQL5/Files/omega/corpus_from.json"`.

## 1c. Bridge 1.8.4: the feed keeps its login across restarts (KeepPrivate, one VPS change with the owner's go)

**Why.** On 28 Nov 10:16Z (and 27 Nov 13:09) a guarded restart started the feed terminal with `startup.ini`; OmegaFeed loaded but the terminal did not log in. `startup.ini` holds no login by design: the terminal logs in with the account it saved. MT5 saves the password only when the login file asks it to: `[Common] KeepPrivate=1` (MetaQuotes "Platform Start" help: "KeepPrivate — saving the password between connections: 1 — to save, 0 — not to save"). Bridges up to 1.8.3 never wrote it, so the password the bridge clears after the login was never saved. 1.8.4 writes `KeepPrivate=1` with every feed login, keeps it in the cleared file, and refuses to write a login file without it. `startup.ini` is unchanged (no `[Common]`). The executor, its bridge and its EA are not changed.

**Order matters.** The password is saved only at a login applied by 1.8.4. Re-entering the login on 1.8.3 restores the feed for now but does not survive the next restart.

**Pre-check (the stick point).** If `feed_credentials_cleared` already ran under 1.8.3 (it has on this VPS: the 1.8.3 login was cleared once the terminal connected), MT5 never saved that password, and nothing 1.8.4 does to the file can bring it back. The owner's re-entry after the 1.8.4 install (step 2) is then required, not optional. Check it by event names and times only:

```bash
journalctl -u omega-bridge@oanda --since "2026-11-27" -o cat | grep -E '"event":"feed_(connection_applied|credentials_cleared)"' | tail -4
```

A `feed_credentials_cleared` line with no later 1.8.4 `feed_connection_applied` means: do step 2.

1. Back up the feed's bridge, then copy the repo's `bridge/omega-bridge` over `/opt/omega-bridge-oanda` at the merged commit (only the feed's copy):

   ```bash
   cp -a /opt/omega-bridge-oanda /opt/omega-bridge-oanda.bak-1.8.3 && echo backed-up
   ```

   Check it as for 1.8.1. Expect `export const BRIDGE_VERSION = "1.8.4";` and no `SYNTAX FAIL`. Then restart only the feed's bridge:

   ```bash
   systemctl restart omega-bridge@oanda
   ```

2. The owner re-enters the feed login once on Nexus > Live > Data feeds. The bridge applies it (with `KeepPrivate=1`) and restarts the feed terminal with the login file.
3. Check the login file asks MT5 to save the password, by counts only (nothing printed from the file):

   ```bash
   f=/opt/mt5-oanda/login.ini; echo "keep_private_1: $(grep -c '^KeepPrivate=1' "$f") keep_private_0: $(grep -c '^KeepPrivate=0' "$f")"
   ```

   Expect `keep_private_1: 1 keep_private_0: 0`. Once the terminal reports it is logged in, the bridge logs `feed_credentials_cleared` and the same check still shows `keep_private_1: 1`.
4. The real test: one guarded restart of the feed terminal (section 3's guarded line). `run.sh` now passes `startup.ini`. After two minutes, check as in 1.8.2's step 4 that `state.json` and `corpus.json` are under a minute old and that `connected` is `True` (the two-field print there; no other field).
5. If it prints `False`, stop and report: the saved-password path does not hold on this VPS either, and the owner re-enters the login (the feed comes back on the login file).

**Rollback.** Restore the 1.8.3 backup and restart only `omega-bridge@oanda`:

```bash
rm -rf /opt/omega-bridge-oanda && cp -a /opt/omega-bridge-oanda.bak-1.8.3 /opt/omega-bridge-oanda && echo restored
```

A `KeepPrivate=1` left in the login file is harmless to 1.8.3.

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

   **OmegaFeed 1.01 (macro export, 2026-11-27).** The same three steps (copy, compile, check) install 1.01 over 1.00. Then restart only the feed's own terminal unit, never the executor's:

   ```bash
   U="$(grep -E '^TERMINAL_SERVICE=' /etc/omega-bridge/oanda.env | cut -d= -f2 | tr -d '"')"; case "$U" in mt5-oanda|mt5-oanda.service) systemctl restart "$U" && echo "restarted $U" ;; *) echo "STOP: TERMINAL_SERVICE is '$U', not mt5-oanda; nothing restarted" ;; esac
   ```

   The line restarts only `mt5-oanda`. Any other value, an empty one included, prints `STOP` and restarts nothing: never fall back to a default unit. Report it instead.

   1.01 also writes `omega/corpus_macro.json` once per closed gold M1 bar. It holds the closed M1 bars of the symbols in the input `MacroSymbols` (`XAGUSD=XAGUSD,USOIL=USOIL.sml,EURUSD=EURUSD.sml,GBPUSD=GBPUSD.sml,USDJPY=USDJPY.sml,USDCAD=USDCAD,USDCHF=USDCHF`; explicit names, nothing guessed; `MacroEnabled=false` turns it off). After two minutes, check that the file names all seven bases. The command prints bases, symbols and bar counts only, no prices:

   ```bash
   T="/opt/mt5-oanda/prefix/drive_c/Program Files/OANDA MetaTrader 5"; python3 -c 'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8-sig")); print([(s["base"], s["symbol"], len(s["bars"])) for s in d["series"]])' "$T/MQL5/Files/omega/corpus_macro.json"
   ```

   **Before bridge 1.8.2 and `feed-run.sh` are installed** (section 1), a restart of `mt5-oanda` starts the terminal without its EA once the bridge has emptied `Password=` (2026-11-27 13:09Z): `state.json` stops. Then the owner re-enters the feed login on Nexus > Live > Data feeds; the bridge writes the login and restarts the terminal with `/config`, and the EA attaches. With 1.8.2 and `feed-run.sh` a restart keeps the EA.

   A base missing from the list means that symbol has no name or no bars on this server: report which one. The file is sent by the feed bridge from 1.8.1 (section 1, "Bridge 1.8.1"), and only once the server ingests the feed's macro bars (macro export step 3); until then it is written but not sent.
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
   - empties `Password=` once the terminal reports it is logged in on that server. From bridge 1.8.2 with `feed-run.sh`, `run.sh` then passes the credential-free `startup.ini` with `/config`, so every later start opens the chart with OmegaFeed (before 1.8.2 it passed no `/config` and the EA did not attach).

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
