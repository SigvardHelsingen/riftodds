# Rift Odds engineering guidance

## Keep the interface intuitive

Treat this as a standing requirement when adding features:

- Integrate new data into the existing view where users expect it. Prefer match/build fold-outs and native disclosures over additional tabs.
- Lead with one plain-language takeaway; put methodology, sample sizes and detailed tables on demand.
- Keep filters consistent across the content they scope. Preserve user input, keyboard focus and context through asynchronous updates.
- Show uncertainty and missing data honestly. Small or unavailable samples are not zero; descriptive associations are not causal recommendations.
- Test mobile widths, keyboard interaction, stale requests, and private-data boundaries. Never gate numeric chart data behind hover alone.

## Validation and deployment

- Use fixture databases and mocked API responses for tests; never mutate production caches/member records as part of validation.
- Preserve low-memory/limited-API-budget safeguards. Network fetching and training must not block normal requests.
- Before a requested commit/push, validate the complete committed tree in a clean worktree. Include all dependent source/assets/tests.
- Do not commit `.env`, Riot verification files, cache databases, member databases, or browser tooling.
