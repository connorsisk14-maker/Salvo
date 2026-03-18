# Agent Fleet

| Profile | Trust Tier | Role | Notes |
| --- | --- | --- | --- |
| `builder` | standard | General-purpose executor for scaffolding, tooling, and patching. | Default tier allows filesystem writes and tests but disables network. |
| `researcher` | restricted | Hands research findings through the research pipeline and publishes memories. | Runs with limited tooling; relies on LLM-driven planning to avoid high-risk operations. |
| `debugger` | restricted | Investigates flakey runs or policy violations. | Mirrors `researcher` capabilities but focuses on policy/evaluation state. |
| `documenter` | restricted | Produces manuals, runbook updates, or release notes. | Filesystem write allowed; command execution limited to documentation tooling. |
| `content` | restricted | Writes marketing/communications summarizing findings. | Writes Markdown/text artifacts while respecting citation guidance. |
| `lead_scraper` | scraper | Scrapes leads, drives Google Sheets updates, and seeds strategists. | Needs network/HTTP access; forbidden from filesystem writes outside allowed paths. |
| `lead_strategist` | scraper | Processes scraped leads with summarization, scoring, and outreach prep. | Bridges to `skills` such as `scaffold_module`, `web_search_extract`, and future scraper helpers. |
| `ops` | scraper | Monitors health, orchestrates restarts, and escalates incidents. | Structured to be conservative; has full visibility into daemon/state tables. |

## Operating notes
- Story-level trust tiers are enforced via `AGENT_TRUST_TIER_POLICIES` in `packages/shared/src/runtime.ts`; the control plane can override a workspace’s tier through `/trust-tier` endpoints.
- New agent profiles must be added to this table and to `AGENT_PROFILES` before being used in contracts or the dashboard.
