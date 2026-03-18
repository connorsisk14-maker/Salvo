# Lead Generation Setup

1. The lead pipeline depends on a Google Sheet configured under the `google_sheets` integration key (`POST /integrations/google_sheets/config`). Store the spreadsheet ID and service account JSON there.
2. Use the `packages/adapters/src/google-sheets.ts` adapter to read/write the sheet; the `googleSheets` skill pipeline currently seeds DFW zone data through `packages/skills/src/builtin/expand-zones.ts` and expects the sheet template to include tabs for `raw`, `enriched`, `zones`, and `runs`.
3. Document zone priorities in the spreadsheet so `expand_zones` can return unscheduled areas; the adapter publishes each completion to `.salvo/dfw-zones.json` and includes artifact metadata, which the Control Center can rehydrate on restart.
4. Populate the sheet with 15–20 DFW zones plus metadata (zip codes, priority, target streets) before running the `lead_scraper` profile; failure to do so means the scraper will fall back to the default zone map in `expand-zones`.

## Monitoring
- Watch `docs/PERFORMANCE.md` for load testing guidelines and recommended concurrency (3–5 simultaneous runs via `scripts/load-test.mjs`).
- When new seeds are required for professional services verticals, note the configuration in `docs/LEAD_GEN_SETUP.md` so the pipeline can continue to reuse the same spreadsheet schema.
