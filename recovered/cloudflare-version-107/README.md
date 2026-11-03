# Cloudflare production version 107 source recovery

Recovered from the uploaded Cloudflare Workers source map for production version 107 of `xauusd-ai-trading-assistant`.

- Version ID: `c01cbafd-b4e2-41f4-b9f5-98c4ac145e7e`
- Production deployment ID: `04660a3b-caf8-4b72-b550-ed8ff929675c`

Complete recovered source files and verified lengths:

| Source map path | Recovered repository path | Characters | Git blob SHA |
|---|---|---:|---|
| `lib/contracts.ts` | `lib/contracts.ts` | 6,887 | `a0ccbe8e2aaf415cbb0041f0336c91973a81e7a8` |
| `lib/auth.ts` | `lib/auth.ts` | 4,654 | `3f950dedcf376746471590a8555340b1c6cc6bac` |
| `lib/validation.ts` | `lib/validation.ts` | 9,508 | `99d342a0ae1cc9271a88e627222a1a6c1eb99789` |
| `src/dashboard.ts` | `src/dashboard.ts` | 13,290 | `dffd1e7b7adf37432a090bb4e90d8d2407ffb745` |
| `src/index.ts` | `recovered/cloudflare-version-107/src/index.ts` | 36,813 | `202bdb6bcf7ef70b5749bf669e3ee919d76e8ca7` |

The Git blob identifiers above refer to the full recovered file contents. The recovered production `src/index.ts` is retained as a forensic reference, not as the active application entrypoint. It must not replace the richer GitHub `main` implementation wholesale. The root `lib/*` and `src/dashboard.ts` files are its exact recovered dependencies and are integrated additively into the existing mainline runtime.
