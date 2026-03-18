# Lead Pipeline Template

This template captures the raw intake, enrichment, zone tracking, and run history that the DFW lead pipeline depends on. Make a copy, populate the seeded zone data, and then point Salvo to the new sheet by setting `SALVO_LEAD_PIPELINE_SHEET_ID` in your environment (or whichever env variable your deployment prefers).

## Layout

- **Raw Leads**: Intake bucket that captures the day, run, source, contact details, offering, and current status columns. Include a structured `Lead Priority`, `Assigned Agent`, and `Next Steps` column so the automation can filter fresh items.
- **Enriched Leads**: Normalized version of each row after the enrichment skill runs. Store firmographic tags, service vertical, revenue band, and `Notes / Action` so analysts can audit enrichment outcomes.
- **Zone Tracking**: One row per zone, with columns for `Zone Name`, `Priority (1=highest)`, `Target Zip Codes`, `Progress (%)`, `Scrapes This Week`, and `Last Update`. This sheet tracks which DFW neighborhoods still need coverage.
- **Run History**: Append every strategist/scraper run with `Run ID`, `Agent Profile`, `Contract Family`, `Status`, `Duration`, and `Artifacts`. Use this tab to measure throughput and triage failures.

## Seeded Zone Data
| Zone | Priority | Zip Codes |
| --- | --- | --- |
| Dallas CBD | 1 | 75201, 75202, 75204 |
| Uptown / Turtle Creek | 1 | 75205, 75208 |
| Deep Ellum / Downtown East | 2 | 75226, 75202 |
| Oak Lawn / Victory Park | 2 | 75219, 75202 |
| Oak Cliff | 3 | 75203, 75208, 75224 |
| East Dallas | 3 | 75214, 75218 |
| North Dallas | 3 | 75225, 75240, 75287 |
| Far North Dallas | 4 | 75098, 75243, 75022 |
| Plano | 4 | 75093, 75024, 75025 |
| Richardson | 4 | 75080, 75081, 75082 |
| Irving | 4 | 75060, 75061, 75039 |
| Las Colinas | 4 | 75039, 75038 |
| Garland | 5 | 75040, 75041, 75042 |
| Carrollton / Addison | 5 | 75006, 75034, 75007 |
| Frisco | 5 | 75033, 75035, 75036 |
| McKinney | 5 | 75069, 75070, 75071 |
| Arlington | 6 | 76010, 76011, 76018 |
| Fort Worth East | 6 | 76102, 76112, 76120 |

Use the `Priority` column to order follow-ups; values 1-3 should be scraped multiple times per week, while 4-6 are on rotation.

## How to Use This Template

1. Open the current template and choose `File → Make a copy` to create a writable worksheet for the current campaign.
2. Rename the copy to include the date or campaign name, then note the new Spreadsheet ID (`docs.google.com/spreadsheets/d/<ID>/`) and update `SALVO_LEAD_PIPELINE_SHEET_ID` locally or in your deployment environment.
3. Populate the `Raw Leads` tab with new tasks before kicking off scraper/strategist runs. The automation expects the headers described above so it can map columns reliably.
4. After each run, append the results to the `Run History` tab and mark the zone progress that was consumed.
5. Review the `Zone Tracking` tab weekly to confirm the `Progress (%)` and `Scrapes This Week` numbers, and allow the strategist to re-prioritize high-value zones.

## Keeping the Template in Sync

Whenever the seeded zip codes change, update `packages/shared/src/lead-pipeline.ts` so the automation matches the sheet. Also keep this markdown doc synced with the template tabs and any new columns that the pipeline relies on.
