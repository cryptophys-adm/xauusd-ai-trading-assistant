# XAUUSD AI Trading Assistant

Cloudflare Worker for receiving TradingView webhook payloads from Prophet R38, Prophet R37 SSOT, and GMI v12.70; persisting candle evidence in D1; running the configured Cloudflare Workers AI analysis stages; and sending a Telegram summary when all three source payloads for a candle are available.

## Cloudflare resources wired to this project

- Worker name: xauusd-ai-trading-assistant
- Custom domain target: ai.cryptophys.work
- D1: xauusd-signals (database ID is in wrangler.jsonc)
- KV: xauusd-signal-cache
- KV: xauusd-webhook-buffer
- KV: xauusd-knowledge-base

The repository was populated from the actual Cloudflare resource inventory. The three XAUUSD KV namespaces existed but were empty at inspection time. The Worker itself did not exist yet. The D1 database had these tables: webhook_sources, ai_syntheses, trade_decisions.

## Pipeline

1. POST /webhook accepts one of the three configured indicator sources.
2. The request must include the shared secret in the JSON field secret or the X-Webhook-Secret header.
3. The payload is recorded in D1 and cached in KV.
4. Analysis starts only after Prophet R38, Prophet R37 SSOT, and GMI v12.70 have all supplied payloads for the same candle key.
5. Clef Flash produces structured directional/risk assessments; Gemma 4 synthesizes the indicator evidence; Nemotron produces a final decision proposal.
6. The final proposal and model outputs are stored in D1. A Telegram message is sent when Telegram secrets are configured.

The Worker is advisory only. It does not place, modify, or close trades.

## Required secrets

Set these as Worker secrets; do not commit them:

- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID
- WEBHOOK_SECRET

## Deploy

Install dependencies and authenticate Wrangler to the intended Cloudflare account:

```sh
npm install
npx wrangler whoami
npx wrangler deploy
```

The Wrangler config references existing Cloudflare resource IDs. Do not recreate those resources.

## TradingView webhook payload

Configure each alert to POST JSON to https://ai.cryptophys.work/webhook. Example shape:

```json
{
  "secret": "<shared-webhook-secret>",
  "source": "prophet_r38",
  "ticker": "OANDA:XAUUSD",
  "timeframe": "60",
  "candle_time": "2026-10-31T10:00:00Z",
  "candle_key": "OANDA:XAUUSD:60:2026-10-31T10:00:00Z",
  "metrics": {
    "bias": "example indicator output",
    "close": 0
  }
}
```

Replace the example metrics with actual TradingView alert fields. Do not use placeholder data for live alerts. The three source alerts must use the same candle_key for the same closed candle.

## Notes

- The Workers AI model identifiers were checked against the account's Cloudflare model catalog: `@cf/cloudflare/clef-flash`, `@cf/google/gemma-4-26b-a4b-it`, and `@cf/nvidia/nemotron-3-120b-a12b`.
- Model availability, quotas, and billing are controlled by Cloudflare. This repository does not assert that three model calls fit a Free plan.
- The KV knowledge-base namespace was empty during inspection. The checked-in knowledge-base-v3.json is the initial project policy document; upload it to KV only after reviewing it.
- No real TradingView alert has been verified by this commit. Configure alert payloads and secrets before treating the service as live.
