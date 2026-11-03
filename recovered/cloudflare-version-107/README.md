# Cloudflare production version 107 source recovery

Recovered from the Cloudflare Workers uploaded source map for production version 107 of `xauusd-ai-trading-assistant`.

Version ID: `c01cbafd-b4e2-41f4-b9f5-98c4ac145e7e`
Production deployment ID: `04660a3b-caf8-4b72-b550-ed8ff929675c`
Source map files: `lib/contracts.ts`, `lib/auth.ts`, `lib/validation.ts`, `src/dashboard.ts`, `src/index.ts`.

SHA-256:
- `lib/contracts.ts`: `eae890246409824e92a90154d8e2024563bd2da94e5aeb4b46f12b9cf09d19a5`
- `lib/auth.ts`: `bcabb136d277477fc56c5dbbc7718a2f05ea01149bd689fb9765c95da0b3810e`
- `lib/validation.ts`: `34afb53e5a17e5d7edbbe3185df5dfa356b510a8dece4bb718d69a77f0757ff9`
- `src/dashboard.ts`: `076983d11a6b2cbe211bdeab113cd8e06eb3724804875bcef5a089d2dfc0fdfa`
- `src/index.ts`: `df498d3d3996ad6bda52e3e3fd0b1bd339f9ecbd2a285f6ac484c05f1603b31c`

The recovered `src/index.ts` is retained as a forensic reference, not as the active application entrypoint. It must not replace the richer GitHub `main` implementation wholesale. The root `lib/*` and `src/dashboard.ts` files are the exact recovered source dependencies being merged additively.
