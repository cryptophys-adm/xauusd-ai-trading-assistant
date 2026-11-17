# Omega Broker Bridge (`omega-bridge` & `OmegaExecutor.mq5`)

Owner decisions 2026-11-09: Omega (`xauusd-omega`, `https://nexus.cryptophys.work/omega`) decides and sizes trades and holds encrypted broker connection payloads; the owner's MetaTrader 5 terminal on the MT5 host executes through an outbound-only local bridge (`bridge/omega-bridge/`) and a local file-exchange Expert Advisor (`ea/mt5/OmegaExecutor.mq5`). The engine is off by default.

> **Important:** Never run `OmegaExecutor.mq5` on the same trading account as `CryptophysXAUUSD.mq5` (`ea/mt5/CryptophysXAUUSD.mq5`), or H1 decisions will be executed twice.

---

## Architecture & Security

1. **Outbound-only sync:** `omega-bridge` polls `POST {OMEGA_URL}/api/bridge/sync` every `OMEGA_SYNC_MS` (default `5000` ms) authenticated with a Cloudflare Access service token (`CF-Access-Client-Id` and `CF-Access-Client-Secret`).
2. **End-to-end encrypted credentials:**
   - On startup, `omega-bridge` loads or generates an RSA-3072 private key at `$OMEGA_STATE_DIR/key.pem` (default `/var/lib/omega-bridge/key.pem`, mode `0600`) and publishes its SPKI DER base64 public key and 16-hex-char `kid` (`sha256(SPKI DER).slice(0, 16)`) in every sync request.
   - The browser at `nexus.cryptophys.work/omega` encrypts `{"server","login","password"}` with WebCrypto (`AES-256-GCM` 32-byte random key, 12-byte IV, 16-byte tag appended) and wraps the 32-byte AES key with `RSA-OAEP` (`SHA-256`, `MGF1-SHA-256`) using the bridge's public key.
   - When `connection.version` in the sync response is greater than the version recorded in `$OMEGA_STATE_DIR/applied.json`, the bridge verifies `envelope.kid === kid`, decrypts the envelope in memory, updates `TERMINAL_INI` (`/opt/mt5-ingestion-gateway/config/terminal_gateway.ini`, preserving mode `0600` and owner `uid`/`gid`), runs `systemctl restart mt5-terminal.service`, and records `{ version, server, applied_ms }` in `applied.json`.
3. **Zero account-number leakage:** Account login/number, password, raw envelope, and Access client secret are never included in `state.json`, `applied.json`, sync payloads, error messages, or stdout JSON logs.

---

## Cloudflare Access Service Token

1. In **Cloudflare Zero Trust → Access → Service Auth**, create a service token named **`cryptophys-agent-omega-bridge`** (the `cryptophys-agent-` prefix is required by the platform Access provisioning workflow).
2. Run **Provision Cloudflare Access** (`PROVISION`) in `cryptophys-cloud-platform` so the token is admitted to the `external-agents` Access policy.
3. Set the Omega Worker variable **`OMEGA_BRIDGE_CLIENT_ID`** to the service token's **Client ID**. The server only accepts `/api/bridge/sync` calls whose `CF-Access-Client-Id` matches `OMEGA_BRIDGE_CLIENT_ID`.
4. Store `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in `/etc/omega-bridge/env` (mode `0600`) on the MT5 host.

---

## Host Installation

### 1. Copy `OmegaExecutor.mq5` and compile in MetaEditor
Since 1.13 (2026-11-12) the EA writes no macro bars by default (`CorpusMacroEnabled = false`): the broker supplies XAUUSD only, plus the USD calendar. Since 1.11 (2026-11-12) the EA's local break-even and micro trailing are off by default: Omega alone moves stops and targets. Since 1.12 the EA reports its version and these inputs to the server, and the Omega page shows "EA stop control": "Omega only" when both are off, a red warning while one is still on. A chart that keeps inputs from an older attachment keeps its old values, so after recompiling, re-attach the EA (or set `AutoBreakEvenEnabled` and `TrailingStopEnabled` to false in its inputs).

Copy `ea/mt5/OmegaExecutor.mq5` into the Wine prefix's `MQL5/Experts/` directory and compile it into `OmegaExecutor.ex5`:

```bash
sudo -u mt5 cp /root/omega-bridge-agy/ea/mt5/OmegaExecutor.mq5 \
  "/opt/mt5-ingestion-gateway/prefix/drive_c/Program Files/MetaTrader 5/MQL5/Experts/OmegaExecutor.mq5"

sudo -u mt5 WINEPREFIX=/opt/mt5-ingestion-gateway/prefix \
  wine "/opt/mt5-ingestion-gateway/prefix/drive_c/Program Files/MetaTrader 5/metaeditor64.exe" \
  /compile:"C:\\Program Files\\MetaTrader 5\\MQL5\\Experts\\OmegaExecutor.mq5" \
  /log:"C:\\Program Files\\MetaTrader 5\\MQL5\\Experts\\OmegaExecutor.log"
```
(Alternatively, open MetaEditor inside the Wine desktop session and press **F7** to compile `OmegaExecutor.mq5`.)

### 2. Install the `omega-bridge` daemon
Copy `bridge/omega-bridge` to `/opt/omega-bridge` and verify the Node 20+ binary path (`/usr/bin/node`, `which node`):

```bash
sudo mkdir -p /opt/omega-bridge /var/lib/omega-bridge /etc/omega-bridge
sudo chmod 0700 /var/lib/omega-bridge /etc/omega-bridge
sudo cp -r /root/omega-bridge-agy/bridge/omega-bridge/src /opt/omega-bridge/
sudo cp -r /root/omega-bridge-agy/bridge/omega-bridge/bin /opt/omega-bridge/
sudo chmod 0755 /opt/omega-bridge/bin/omega-bridge.mjs
```

### 3. Create `/etc/omega-bridge/env` (`0600`)
Copy `bridge/omega-bridge/env.example` to `/etc/omega-bridge/env`, restrict permissions to `0600`, and fill in the Access service token credentials:

```bash
sudo cp /root/omega-bridge-agy/bridge/omega-bridge/env.example /etc/omega-bridge/env
sudo chown root:root /etc/omega-bridge/env
sudo chmod 0600 /etc/omega-bridge/env
```

 Verify `/usr/bin/node --version` is Node 20+ (update `ExecStart` in `omega-bridge.service` if `node` lives at another path such as `/usr/local/bin/node`).

### 4. Enable and start the systemd service

```bash
sudo cp /root/omega-bridge-agy/bridge/omega-bridge/omega-bridge.service /etc/systemd/system/omega-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now omega-bridge.service
```

---

## Local File Exchange (`$MT5_FILES_DIR/omega/`)

Default directory: `/opt/mt5-ingestion-gateway/prefix/drive_c/Program Files/MetaTrader 5/MQL5/Files/omega`

| File | Writer | Reader | Format & Lifecycle |
|---|---|---|---|
| `state.json` | `OmegaExecutor.mq5` (via `state.tmp` + `FileMove(..., FILE_REWRITE)` every `StateEverySeconds=2`) | `omega-bridge` | JSON object with `connected`, `server`, `account` (`trade_mode`, `currency`, `balance`, `equity`, `day_start_balance`, `day_realized_pl`), `symbol` spec, `positions` (only `MagicNumber=920200`), and `received_ms` (UTC ms). Parse errors are treated as `state: null`. Never contains login. |
| `intents.txt` | `omega-bridge` (atomic `intents.txt.tmp.*` + `rename`) | `OmegaExecutor.mq5` | ASCII text. Line 1: `#v1;<written_ms>`. Subsequent lines: `id;kind;side;volume;sl;tp;ticket` (`kind` is `open`, `close`, or `close_all`). |
| `processed.txt` | `OmegaExecutor.mq5` | `OmegaExecutor.mq5` | One executed intent `id` per line. Loaded at `OnInit` and appended after each intent is handled so no intent `id` is ever executed twice across restarts. |
| `results.txt` | `OmegaExecutor.mq5` (append) | `omega-bridge` | ASCII lines: `id;ok(1\|0);ticket;error;executed_ms`. On each cycle, `omega-bridge` atomically renames `results.txt` to `results.<ms>.done`, reads and reports the results, and prunes `.done` files keeping only the newest 20. |

---

## One-Terminal Limitation & `OMEGA_TAKE_STARTUP`

MT5's `[StartUp]` section in `/opt/mt5-ingestion-gateway/config/terminal_gateway.ini` can launch only one Expert Advisor on startup:

- **`OMEGA_TAKE_STARTUP=true` (default):** When applying credentials, `omega-bridge` sets:
  ```ini
  [StartUp]
  Expert=OmegaExecutor
  Symbol=<gold symbol of the selected server>
  Period=M1

  [Charts]
  ProfileLast=Omega
  ```
  and removes `ExpertParameters`. On this host, that **replaces** the `[StartUp]` entry for the `m1_ohlcv_ingest` EA.

  **The chart symbol follows the selected server (2026-11-16).** A `[StartUp] Symbol` the server does not have
  leaves the chart empty and OmegaExecutor never runs `OnInit` (no `state.json`): FxPro-MT5 Demo names gold
  `GOLD`, Monex-Demo `XAUUSD.m`. The bridge tries, in order, the symbol already proven on that server
  (`$OMEGA_STATE_DIR/symbols.json`), `OMEGA_SYMBOL`, then `XAUUSD`, `GOLD`, `XAUUSD.m`, `XAUUSDm` and the
  other names on the USD gold list. After 120 s without an EA for the server the bridge sets the next name and
  restarts the terminal (`symbol_trial_next`). The trial in progress is `$OMEGA_STATE_DIR/symbol-trial.json`;
  the stale-state watchdog waits for it. If the applied server has no EA state for 120 s, no trial runs and no
  symbol is proven, the bridge starts one from the ini's current symbol.

  **USD gold only (owner 2026-11-17, PR #405; OmegaExecutor 1.14, omega-bridge 1.3.0).** One list of exact
  names (`src/gold-symbol.mjs`, the EA's `GOLD_USD_SYMBOLS`, the bridge's `GOLD_SYMBOL_CANDIDATES`; a test keeps
  them equal) and the contract checked at every layer:
  - **EA:** a symbol is traded only when its name is on the list exactly (no prefix match: `GOLDEURO`, `GOLDgr`
    and `XAUUSD_mini` never pass), its profit currency is `USD`, its contract size is 1 to 100 oz, it is not
    disabled and it has a price. Otherwise the EA trades nothing: `state.json` carries `symbol_error`
    (`no_usd_gold_symbol (<last name>:<reason>)`), every open intent gets the result `symbol_error`, the corpus
    is not written. There is no fallback to a symbol without a price or to the chart symbol. Closes and stop
    changes on existing tickets still run. `state.json` reports `symbol.chart`, `currency_profit`,
    `currency_base` and `contract_size`.
  - **Bridge:** a chart symbol is remembered for the server (`symbol_confirmed`) only when the EA trades a
    symbol that passes the same check. An EA that runs but refuses (`symbol_refused`, logged once) is not
    restarted: another chart name cannot help, the EA checks every listed name itself. When every name failed
    the search ends `exhausted` (`symbol_trial_exhausted`); a login failure in the terminal log ends it
    `stopped` (`symbol_trial_stopped`). Both are sticky: no more restarts for a symbol until the owner applies
    the connection again. A proven symbol is never forgotten because the terminal is quiet; a server with one
    starts on it with no trial. To clear it on purpose, delete the server's entry in
    `$OMEGA_STATE_DIR/symbols.json` (or the file) and apply the connection again. Every sync carries
    `bridge_symbol` (`status` confirmed | trial | exhausted | stopped | none, `chart_symbol`, `learned`, `tried`,
    `error`).
  - **Server:** `planIntents` opens nothing while the symbol is not verified (note `symbol_unverified`; an EA
    older than 1.14 reports no contract and is never verified). Open positions keep their management. The
    Omega page shows the check on the bridge card (`bridge.symbol_check`), `/api/health` reports
    `bridge.symbol`, a change of symbol is the event `symbol_changed`, a refusal `symbol_refused`, an exhausted
    or stopped search `bridge_symbol`, and the health alert `omega_symbol` says which symbol and why.

  **Own chart profile.** MT5 saves every open chart into the current profile and adds the `[StartUp]` chart
  again at each start: the shared `Default` profile had grown to ~70 charts, most on a symbol the next
  server lacked. The bridge therefore selects the profile `Omega`, and the drop-in
  `bridge/omega-bridge/mt5-terminal-omega-profile.conf` (installed as
  `/etc/systemd/system/mt5-terminal.service.d/omega-profile.conf`) empties it before every terminal start.
  It runs only when systemd starts or restarts the terminal, never while it runs, so it cannot remove the EA's
  chart mid-session. The EA runs on its compiled input defaults (`ExpertParameters` is removed), so nothing it
  needs lives in the profile; an input changed by hand on the chart is lost at the next restart. The drop-in
  needs `WINEPREFIX` in `mt5-terminal.service` and fails the start with a clear message when it is empty.
- **`OMEGA_TAKE_STARTUP=false`:** `omega-bridge` leaves `[StartUp]` untouched so `m1_ohlcv_ingest` remains the startup EA. In that mode, you must attach `OmegaExecutor` manually to an `XAUUSD` chart inside the MT5 chart profile (`Profile=1`) so both EAs run side by side in the same terminal.

---

## Key Rotation

To rotate the bridge's RSA-3072 key pair:

1. Delete `/var/lib/omega-bridge/key.pem` (and optionally `/var/lib/omega-bridge/applied.json`) and restart the bridge:
   ```bash
   sudo rm -f /var/lib/omega-bridge/key.pem
   sudo systemctl restart omega-bridge.service
   ```
2. On start, `omega-bridge` generates a new RSA-3072 `key.pem` (`0600`) with a new `kid` and sends the new `public_key` and `kid` on its next `/api/bridge/sync` call.
3. Because the bridge's `kid` changed (and any queued envelope with the old `kid` is refused), the Omega page (`https://nexus.cryptophys.work/omega`) detects the new bridge key and prompts the owner to submit the broker credentials again.

---

## Troubleshooting

- **HTTP 403 (`sync_forbidden`):** Logged at most once per minute with `"hint": "check OMEGA_BRIDGE_CLIENT_ID / the Access service token"`. Verify that:
  1. `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in `/etc/omega-bridge/env` belong to an active `cryptophys-agent-omega-bridge` token;
  2. The `Provision Cloudflare Access` workflow has been run;
  3. The Omega Worker's `OMEGA_BRIDGE_CLIENT_ID` matches `CF_ACCESS_CLIENT_ID`.
- **`algo_trading_disabled` in results:** `!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)` in MT5. Ensure `[Experts] Enable=1` and `AllowLiveTrading=1` are set in `terminal_gateway.ini` (applied automatically when a connection envelope is opened) and that the Algo Trading button is enabled in the terminal.
- **`state: null` in sync requests:** `OmegaExecutor.ex5` is not compiled, not attached to a chart, or `MT5_FILES_DIR` does not point to the active Wine prefix's `MQL5/Files/omega` directory. Check `sudo journalctl -u omega-bridge -f` and the MT5 Experts log.
