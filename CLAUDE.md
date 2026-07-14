# Cold Lead Decoder — Project Constitution

> Single input (a company domain) → one Node route handler → static scrape + DeepSeek call → Zod-validated card. No DB, no auth, no queue, no headless browser in v1.

## Tech Stack (locked)

- **Framework:** Next.js 15.5.20 (App Router, TypeScript)
- **API:** one Route Handler `POST /api/decode`, Node runtime (not Edge, not Server Action)
- **LLM:** DeepSeek via OpenAI SDK — model `deepseek-chat`, **thinking disabled**, `response_format: { type: "json_object" }`, capped `max_tokens`, exponential backoff on 429/500/503
- **Validation:** Zod (single source of truth for API + UI)
- **Testing:** Vitest 3.2.7
- **Scraping:** native `fetch` + `@mozilla/readability` + `jsdom`; `cheerio` fallback
- **UI:** Tailwind (no component library)
- **Deploy:** Vercel; in-memory `lru-cache` 24h domain cache (feature-flagged via `ENABLE_CACHE`), not Vercel KV. Neon (Postgres) is used exclusively for eval-run metrics — no user data, sessions, or app state touch a database.

## Known limitations

- **SSRF guard** resolves DNS and checks the resolved IP before connecting, but the validation lookup and the actual `fetch()` are two separate resolutions — a short-TTL DNS record could still enable a rebinding attack between them. See ADR-006.
- **Rate limiter** is process-local (in-memory `Map`), not distributed — the effective limit scales with the number of warm instances, not the configured value.

## Architecture Decision Records

Full ADR-001 through ADR-010 (framework, API surface, scraping, LLM contract,
schema authority, SSRF policy, persistence, failure UX, UI dependencies) live
in [`docs/architecture-decisions.md`](./docs/architecture-decisions.md), kept
in sync with the current implementation.

## Scope (v1 cut list)

Out of scope for v1: headless browser, multi-page crawl, provider router, DB (beyond eval metrics), auth, queue, two-stage prompts, component library, streaming, settings/themes.
