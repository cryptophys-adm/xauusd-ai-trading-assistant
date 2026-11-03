# Knowledge Base v4 (derived from the Pine SSOT)

Knowledge base v4 is what the Analyst, Counselor and Reasoner agents use to interpret evidence. It replaces the v3 starter policy. v3 said explicitly that no Pine source was available and that field meanings must not be inferred.

## Naming
- **Local computation engines:** MizanLib (engine id `mizan`), Prophet and GMI.
- **Webhook sources:** `prophet_r38`, `prophet_r37_ssot` and `gmi_v12_70`.
- See [PINE_SOURCE_VERIFICATION.md](PINE_SOURCE_VERIFICATION.md) for how the Pine files were checked against the installed indicators.

## What it contains
- **`field_dictionary`:** the meaning of every compared field.
  - `prophet_r38`: `direction`, `buy_confirmed`, `sell_confirmed`, `buy_high_quality`, `sell_high_quality`, `t_enc`, `d_enc`, `structure_subtype`. `buy_confirmed` and `sell_confirmed` include the V2 gate rules and thresholds.
  - `prophet_r37_ssot`: the consensus `direction`, `d_enc`, `b_enc`, `subtype` and the bull/bear events.
  - `gmi_v12_70`: `verdict`, `gate`, `gmi_dir`, `prophet_dir`, `conflict`.
  - It also documents the MizanLib structure state machine. Note the inverted sign of the resolved states: `d_enc` 3 is bearish and −3 is bullish.
- **`input_lanes`:** how to treat the TradingView webhook, local_computation and news lanes. Local values count only when they are `approved_by_parity`; diagnostics are never decisive.
- **`decision_policy`:** the project's rules applied to those encodings.
  - Prophet is the base bias and is read from `prophet_r37_ssot.direction`. R38 confirmations are entry triggers.
  - GMI validates or blocks through `gate`, `conflict` and `verdict`. `t_enc` 4 is the only management veto.
- **`news_policy`:** news is context only and never an entry.

## Every meaning is checked against the Pine source
- **Line references:** each entry cites `{file, line, contains}` in `pinescript/ssot/`. There are 53 references.
  - `test/knowledge-base.test.mjs` fails if a cited line no longer contains the quoted text.
  - So when a Pine file changes, the knowledge base must be reviewed before CI turns green.
- **Provenance:** `scripts/build-knowledge-base.mjs --write` produces two files:
  - `src/knowledge-base.generated.mjs`, which is bundled into the AI Worker;
  - `knowledge-base-v4.json`, a human-readable audit copy.

  Both carry the sha256 of every Pine source, the local-engine identities and a content hash. A test fails if either file is stale.

## Runtime
- **Bundled with the Worker:** the AI Worker no longer reads `knowledge-base:v3` from KV, so the knowledge base cannot drift from the deployed code.
- **Prompt views:** `src/knowledge-prompt.mjs` builds compact views for the prompts.
  - Line references are stripped from both views.
  - **Technical view:** about 12.8 KB, given to the technical analysis chain.
  - **News view:** about 1.2 KB, given to the news chain.
- **Agent instructions:** all three technical agents are told to decode every numeric field with `policy.field_dictionary` and quote the decoded meaning.
- **Fingerprint:** the analysis fingerprint includes the knowledge base `content_sha256`, so a candle is re-analysed after a knowledge base change.
- **Health check:** `GET /health` reports `knowledge_base.content_sha256`.

## Updating
1. Edit `knowledge/kb-v4.mjs`, citing the Pine line for any new meaning.
2. Run `node scripts/build-knowledge-base.mjs --write`.
3. Run `npm test`.
