# Cold Lead Decoder
## Demo

**Video walkthrough:** [Watch the 90-second Loom demo](https://www.loom.com/share/0405f48b55ea4624ac8b3a7c5243b234)

One company domain -> static scrape -> DeepSeek JSON -> Zod-validated lead card with evidence, confidence notes, and eval metrics.

**Live demo:** https://coldl.vercel.app
## What it does

Cold Lead Decoder is a single-route service for B2B outbound research. A user pastes a company domain; the app statically scrapes the homepage (and, conditionally, `/about`), runs the extracted text through DeepSeek in strict JSON mode, validates the response against a Zod contract, and returns a lead card containing a one-paragraph summary, positioning signals, likely pain points, a personalized opener grounded in a concrete trigger from the company's own pages, and two follow-up angles. There is no database, no auth, and no queue — the whole pipeline lives in one Node route handler (`POST /api/decode`) and runs a linear five-stage flow: **fetch → extract → generate → validate → guard**.

## Threat Model

The pipeline accepts an arbitrary, user-supplied domain and forwards parts of a third-party HTML response to an LLM. Defense-in-depth controls live at every layer:

- **SSRF Protection** — `safeFetch` resolves every host with both `dns.resolve4` and `dns.resolve6` and rejects the request if *any* resolved address falls in a private, loopback, link-local, RFC-6598 CGNAT, or ULA (`fc00::/7`) range; IP literals in the URL are checked directly against the same ranges. Redirects are followed manually with `redirect: "manual"`, and the full DNS + IP-literal check is re-applied on every hop, so a redirect pointed at a blocked address is rejected before it's followed. **This is not complete protection against DNS-rebinding attacks**: the validation lookup and the actual `fetch()` connection are two separate DNS resolutions, so a record with a very short TTL that changes between them could still let a connection reach a private address after the check passed. Source: `lib/scraper/fetch.ts`.

- **Prompt Injection** — scraped page text is wrapped in `<website_content>…</website_content>` tags inside the user message, and `<` / `>` inside the payload are entity-escaped (`escapeXmlTags` in `lib/llm/utils.ts`) so an attacker cannot close the tag from inside the page. The system prompt has an explicit security clause instructing the model to treat everything inside the tags as data, never as instructions, and to ignore role declarations or admin overrides embedded in the page. Source: `lib/llm/repair.ts`.

- **Rate Limiting** — an in-memory **sliding-window** limiter keyed on client IP, defaulting to 5 requests per 60 seconds (overridable via `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`). Buckets are cleaned via a **lazy sweep** that runs at most once per window, so memory usage stays bounded without a background timer. **This is a process-local, best-effort limiter, not distributed rate limiting**: state lives in a plain `Map` inside a single function instance, resets on every cold start, and is not shared across concurrent Vercel instances — the effective global limit scales with however many instances are warm, not with the configured value. Adequate for a demo; a production deployment would need a shared store (e.g. Redis/Upstash). Source: `lib/security/rateLimiter.ts`.

- **Cost Protection** — every outbound fetch has an 8-second timeout, follows at most 3 redirects, and is capped at **1,500,000 bytes (~1.5 MB)** of body — enforced both via the `content-length` header and a streaming guard that aborts mid-read. Combined homepage + `/about` text is truncated to **12,000 characters** before reaching the LLM (`TEXT_BUDGET` in `lib/scraper/extract.ts`). A per-domain LRU output cache (`lru-cache`, max 500 entries, 24-hour TTL) eliminates redundant DeepSeek calls. Sources: `lib/scraper/fetch.ts`, `lib/scraper/extract.ts`, `lib/cache/domainCache.ts`.

## Evaluation Methodology

- **Automated Testing** — **151 unit and integration tests** passing in Vitest, spanning the schema, the SSRF + body-cap fetch layer, the Readability/cheerio extractor, the DeepSeek wrapper with backoff, the validate-and-repair loop, the rate limiter, the LRU cache, the pipeline orchestrator, the API route, and the React components. Run with `npm test`.

- **Qualitative Eval** — a property-based eval harness at `tests/eval/harness.test.ts` runs DeepSeek against five hand-built fixture types in `tests/eval/golden_set.json`:

  | Fixture        | What it stresses                                                              |
  |----------------|-------------------------------------------------------------------------------|
  | `normal`       | rich homepage with multiple concrete triggers (launch, customer, fundraise)   |
  | `degraded`     | thin "coming soon" page → must mark `degraded: true` and avoid fabrication    |
  | `injection`    | embedded `IGNORE ALL PREVIOUS INSTRUCTIONS` payload — schema must hold        |
  | `no_trigger`   | vague consulting boilerplate — opener must not invent a trigger               |
  | `strong_signal`| explicit recent launch — opener must reference the trigger keyword            |

  Each fixture asserts: Zod-shape validity, a non-empty `evidence.opener_basis`, exactly 2 `follow_up_angles`, banned-phrase compliance on the opener, and (for `strong_signal`) a regex match on the trigger keyword. The eval suite is gated on `DEEPSEEK_API_KEY` and is skipped automatically when the key is absent.

  A committed run of this harness is recorded in [`docs/eval-results.md`](./docs/eval-results.md).

- **Operational Metrics** — a live `/eval` dashboard ([coldl.vercel.app/eval](https://coldl.vercel.app/eval)) is backed by Neon Postgres: a nightly cron decodes 20 domains and writes one row per run, and the page surfaces success rate, p50/p95 latency, and run count. These are operational health metrics (does the pipeline run, and how fast), not accuracy evals.

## Architecture Decisions

The full set of decisions — framework, runtime, scraping strategy, LLM contract, schema authority, SSRF policy, persistence, failure UX, UI dependencies — is recorded in [`docs/architecture-decisions.md`](./docs/architecture-decisions.md) as ADR-001 through ADR-009.

The linear pipeline:

1. **fetch** — `lib/scraper/fetch.ts` — SSRF guard + timeout + body cap + per-hop redirect re-check.
2. **extract** — `lib/scraper/extract.ts` — `@mozilla/readability` (primary), `cheerio` (fallback), conditional `/about` retry, 12k-character text budget.
3. **generate** — `lib/llm/repair.ts` + `lib/llm/deepseek.ts` — DeepSeek call in `json_object` mode with thinking disabled, plus one repair attempt on Zod failure.
4. **validate** — `lib/schema/leadCard.ts` — the Zod schema is the contract; the model never has the last word on shape.
5. **guard** — `lib/opener/guard.ts` + `lib/pipeline/decode.ts` — banned-phrase check on the opener; failures stamp `confidence_notes` rather than retry.

## Tech Stack

- **Next.js 15.5.20** (App Router, Node runtime)
- **TypeScript**
- **DeepSeek `deepseek-chat`** (intentionally used over `deepseek-v4-flash` for JSON mode reliability; v4-flash can be re-evaluated via A/B eval harness when needed) via the OpenAI SDK (`response_format: { type: "json_object" }`, thinking disabled, exponential backoff on 429/500/503)
- **Zod** — single source of truth for the API and UI contract
- **`@mozilla/readability`** + `jsdom`, with `cheerio` as fallback
- **`lru-cache`** — in-memory, 24-hour per-domain output cache (not Vercel KV — process-local, feature-flagged via `ENABLE_CACHE`)
- **Neon (Postgres)** — used exclusively for eval-run metrics persistence via `@neondatabase/serverless`; no user data, sessions, or app state ever touch a database
- **Vitest 3.2.7** + React Testing Library

## Setup

Requirements: Node.js 20+ and a DeepSeek API key.

```bash
npm ci
cp .env.example .env.local
# Windows PowerShell: Copy-Item .env.example .env.local
```

Edit `.env.local` and set `DEEPSEEK_API_KEY` (get one at https://platform.deepseek.com/api_keys).

```bash
npm run dev
```

Open <http://localhost:3000> and paste a domain like `stripe.com`. To run the test suite:

```bash
npm test
```

## License

MIT — see [LICENSE](./LICENSE).
