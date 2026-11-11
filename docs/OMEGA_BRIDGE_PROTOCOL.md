# Omega bridge protocol (v1)

The contract between the Omega broker engine (the AI Worker, through the `xauusd-omega` Worker) and the
Omega bridge on the owner's MT5 host. Owner decisions of 2026-11-09: "Omega memegang akses broker",
"Bridge di host ini", "Mati sampai Anda aktifkan". See docs/SSOT.md "Omega broker engine"; installing
the bridge: docs/OMEGA_BRIDGE.md.

The bridge only makes outbound requests. Nothing calls the bridge.

## Sync

```
POST https://nexus.cryptophys.work/omega/api/bridge/sync
CF-Access-Client-Id: <the bridge's service token client id>
CF-Access-Client-Secret: <its secret>
Content-Type: application/json
```

- The service token's client id must equal the Omega Worker var `OMEGA_BRIDGE_CLIENT_ID`; otherwise
  403 (`bridge_not_configured` while the var is empty, `forbidden` for any other identity).
- The body is at most 64 KiB. The bridge syncs every 5 seconds (`OMEGA_SYNC_MS`).

### Request body

| Field | Type | Notes |
|---|---|---|
| `bridge_version` | string | e.g. `"1.0.0"` |
| `kid` | string | the first 16 hex characters of sha256(SPKI DER of the bridge's public key) |
| `public_key` | string | the bridge's RSA-3072 public key, SPKI DER, standard base64 |
| `state` | object or null | the executor state below; `null` when the EA has not written one (or it does not parse) |
| `results` | array | the outcome of each intent the EA executed since the last sync |
| `corpus` | object, optional | Corpus Oracle (owner 2026-11-11, docs/RFC_CORPUS_ORACLE.md): `{ "server", "symbol", "timeframe": "M1", "bars": [[t_ms UTC, open, high, low, close, tick_volume, spread], …] }`, the closed M1 bars of `omega/corpus.json` after the server's last `corpus_cursor_ms`, at most 240; cut first when the body is too large. Never a login or an account number. |

`state` (written by `OmegaExecutor.mq5`; the bridge forwards it as is):

```json
{
  "connected": true,
  "server": "Monex-Demo",
  "received_ms": 1794225600000,
  "account": { "trade_mode": "demo", "currency": "USD", "balance": 10000, "equity": 10012.5, "day_start_balance": 10000, "day_realized_pl": 0 },
  "symbol": { "name": "XAUUSD", "digits": 2, "point": 0.01, "tick_size": 0.01, "tick_value": 1, "volume_min": 0.01, "volume_max": 50, "volume_step": 0.01, "stops_level_points": 0, "bid": 4101.0, "ask": 4101.2, "spread_points": 20 },
  "positions": [ { "ticket": 123456789, "side": "BUY", "volume": 0.1, "open_price": 4101.2, "sl": 4096.2, "tp": 4111.2, "profit": 12.5, "intent_id": "open:1794225600000:B", "opened_ms": 1794225610000 } ]
}
```

- `received_ms` is when the EA wrote the state (ms since the epoch, UTC). The engine plans nothing when
  it is older than 60 seconds or `connected` is not `true`.
- `trade_mode` is `demo`, `real` or `contest` (from `ACCOUNT_TRADE_MODE`); anything but `demo` needs the
  owner's `LIVE` arm.
- `positions` are this executor's positions only (its magic number); `intent_id` is the position's
  order comment. At most 50.
- **Never** the account login or number, here or anywhere else the bridge sends or logs.

`results`:

```json
[ { "id": "open:1794225600000:B", "ok": true, "ticket": 123456789, "executed_ms": 1794225610000 },
  { "id": "cl:123456789:opp", "ok": false, "error": "requote", "executed_ms": 1794225611000 } ]
```

`ticket` is the position ticket of an `open`; `error` is the terminal's text for a failure.

### Response body (200)

```json
{
  "ok": true,
  "intents": [ { "id": "open:1794225600000:B", "kind": "open", "side": "BUY", "volume": 0.1, "sl": 4096.2, "tp": 4111.2, "signal_issued_ms": 1794225600000, "reason": "signal" } ],
  "connection": null,
  "settings_version": 3,
  "corpus_cursor_ms": null,
  "notes": [ { "code": "spread" } ]
}
```

`intents` are every intent still waiting for a result, oldest first:

| `kind` | Fields | The executor |
|---|---|---|
| `open` | `side` (`BUY`/`SELL`), `volume`, `sl`, `tp` | market order on the chart symbol, comment = `id` |
| `close` | `ticket` | closes that position if it is its own (magic) |
| `close_all` | — | closes every own position and deletes every own pending order |

`connection` is one of:

- `null`: nothing to change;
- `{ "version": 4, "server": "Monex-Demo", "envelope": { … } }`: log the terminal in with these
  credentials when `version` is newer than the version the bridge last applied;
- `{ "version": 5, "cleared": true }`: the owner disconnected; clear the terminal login when `version` is
  newer than the last applied.

`notes` are the planner's reasons for not trading (for logs only).

`corpus_cursor_ms` is the newest broker minute the AI Worker kept from Omega's active broker, pair and
user (`null` while `CORPUS_ORACLE_MODE` is `off` or the corpus was refused); the bridge then sends only
newer bars.

Errors: 400 `{ "ok": false, "error": … }` for a bad body (e.g. `kid and public_key are required`,
`state_too_large`), 413 above 64 KiB, 502 `sync_failed` when the AI Worker is unreachable (retry with
backoff).

## Intent ids and idempotency

- Ids are deterministic and at most **31 characters** (the MT5 order comment): `open:<issued_ms>:<B|S>`,
  `cl:<ticket>:opp`, `ka:<kill key>`, and a retry of a close or kill appends `:<n>` (1 to 9).
- **The bridge never executes an id twice**, across restarts (the executor keeps `processed.txt`).
- The server marks an intent `sent` the first time it returns it and keeps returning it until a result
  arrives. It marks it `expired` after 2 minutes without a result; a late result still lands. An open is
  never retried; a close or kill that is still needed gets a new attempt id.

## The credentials envelope

The Omega page builds it in the owner's browser (`workers/xauusd-omega/public/omega-crypto.js`):

```json
{ "v": 1, "kid": "0123456789abcdef", "wrapped_key": "<base64, 384 bytes>", "iv": "<base64, 12 bytes>", "ciphertext": "<base64>" }
```

- A random 32-byte AES-256-GCM key and 12-byte IV encrypt the UTF-8 JSON
  `{"server": "...", "login": "...", "password": "..."}`; `ciphertext` is the AES-GCM output with its
  16-byte tag **appended** (the WebCrypto format).
- `wrapped_key` is the raw AES key encrypted with RSA-OAEP (SHA-256, MGF1-SHA-256) to the bridge's public
  key. All fields are standard base64 with padding.
- The bridge refuses an envelope whose `kid` is not its own. When the bridge's key changes, the server
  drops the stored envelope (`needs_reentry`) and the owner enters the credentials again.

Opening it in Node:

```js
import { privateDecrypt, createDecipheriv, constants } from "node:crypto";

export function openEnvelope(envelope, privateKey) {
  const aesKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(envelope.wrapped_key, "base64"));
  const ct = Buffer.from(envelope.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString("utf8"));
}
```

`test/omega-broker.test.mjs` proves this round trip against the page's module.
