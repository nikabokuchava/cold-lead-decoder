# Architecture Decision Records

Cold Lead Decoder: single input (a company domain) → one Node route handler →
static scrape + DeepSeek call → Zod-validated card. No DB, no auth, no queue,
no headless browser in v1 (persistence is limited to eval-run metrics, see
ADR-007).

## Tech Stack (locked)

- **Framework:** Next.js 15.5.20 (App Router, TypeScript)
- **API:** one Route Handler `POST /api/decode`, Node runtime (not Edge, not Server Action)
- **LLM:** DeepSeek via OpenAI SDK — model `deepseek-chat`, **thinking disabled**, `response_format: { type: "json_object" }`, capped `max_tokens`, exponential backoff on 429/500/503
- **Validation:** Zod (single source of truth for API + UI)
- **Testing:** Vitest 3.2.7
- **Scraping:** native `fetch` + `@mozilla/readability` + `jsdom`; `cheerio` fallback
- **UI:** Tailwind (no component library)
- **Deploy:** Vercel; in-memory `lru-cache` 24h domain cache (feature-flagged via `ENABLE_CACHE`), not Vercel KV

## Records

### ADR-001 — Framework: Next.js 15.5.20 App Router + TypeScript
One Next.js app, App Router, TypeScript. One page, one route handler. Originally built on Next.js 14; upgraded to 15.5.20 as a security-driven dependency remediation once no maintained Next 14 patch cleared the applicable high-severity advisories (all fixed versions were 15.5.16+). The upgrade required only one config change — `experimental.serverComponentsExternalPackages` renamed to the now-stable top-level `serverExternalPackages` in `next.config.mjs` — no async-params migration was needed since the app has no dynamic route segments.

### ADR-002 — API surface: single Node Route Handler `POST /api/decode`
Not Edge (Readability/jsdom need Node). Not Server Action (no curlable contract, hard to test/reuse). Route handler graduates into the future SaaS endpoint.

### ADR-003 — Scraping: static `fetch` + Readability/cheerio, homepage + conditional `/about`
No headless browser in v1. Detect thin content → fetch `/about` once → if still thin, set `degraded=true` and continue (never abort). Hard caps: 8s timeout, ≤3 redirects, ~1.5 MB body cap, real User-Agent.

### ADR-004 — LLM: DeepSeek `deepseek-chat`, thinking disabled, JSON mode + mandatory repair retry
DeepSeek's `json_object` mode guarantees parseable JSON, **not schema-valid** JSON (no Anthropic-style tool enforcement). System prompt must explicitly direct the model to return a single JSON object. Backoff on 429/500/503. One repair call on Zod failure. Hard fail after second failure. `deepseek-chat` is intentionally used over `deepseek-v4-flash` for JSON mode reliability; v4-flash can be re-evaluated via A/B eval harness when needed.

### ADR-005 — Schema: Zod as single source of truth, shared by API + UI
`lib/schema/leadCard.ts` is the contract. Rules enforced in Zod, not just the prompt: `follow_up_angles` length exactly 2; `positioning_signals` 2–4; `likely_pain_points` 2–3; every string non-empty and length-capped; `source_pages` ⊆ pages actually fetched. `evidence.opener_basis` is **required** in the schema — a deliberate deviation from the original architecture brainstorm, which had it optional-in-Zod / required-in-prompt only — to prevent silent prompt drift.

### ADR-006 — SSRF guard: DNS-resolve and check resolved IP, re-check after every redirect
String/regex checks on the hostname alone miss a public hostname that resolves to an internal IP. `lib/scraper/fetch.ts` resolves every host with both `dns.promises.resolve4` and `resolve6` and rejects the request if *any* resolved address falls in `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `100.64/10` (CGNAT, RFC 6598), `::1`, or `fc00::/7`; IP literals in the URL are checked the same way. The full check re-runs on every redirect hop before it's followed. No shell, pure `fetch`.

**Known limitation, not a gap in the design:** the validation DNS lookup and the actual `fetch()` connection are two separate resolutions. A record with a very short TTL that changes between those two lookups (classic TTL-based DNS rebinding) could still let the connection land on a private address after the check passed. Closing that fully would require resolving once and connecting to the validated IP directly (bypassing the platform's `fetch` DNS resolution), which is out of scope for v1.

### ADR-007 — Persistence: eval metrics only
Storage is allowed exclusively for evaluation run metrics (one row per nightly cron attempt against a fixed domain set). User data, sessions, scraped text, LLM responses, auth, and billing remain explicitly out of scope. The metrics table lives in Neon (Postgres); access is via `@neondatabase/serverless` (`lib/db/evalStore.ts`). The optional per-domain output cache (`lib/cache/domainCache.ts`) is an in-process `lru-cache` (max 500 entries, 24h TTL), not Vercel KV — it is process-local and does not persist across deploys or across concurrent instances. Billing-phase concerns (Prisma singleton, Stripe idempotency, RLS, `org_id` FK) remain deferred.

### ADR-008 — Failure UX: every failure has a defined card state, never a raw 500
Invalid domain → inline field error. Fetch fail/timeout → "Couldn't reach this site". Thin content → card renders with "Based on limited public info" badge. Generic opener (banned-phrase guard) → mark `low_confidence` in `confidence_notes`, do not retry (keeps demo fast). LLM/validation hard fail → "Decode failed, try another domain" + retry button.

### ADR-009 — UI components: strictly pure Tailwind CSS, no external libraries
No `shadcn/ui`, Radix, MUI, Headless UI, Chakra, DaisyUI, or any pre-built component kit in v1. All UI primitives (buttons, badges, inputs, skeletons, toasts) are hand-rolled with Tailwind utility classes. Rationale: zero dependency surface, zero bundle bloat, full control over keyboard/ARIA, and no risk of design drift from a third-party theme. `clsx` / `tailwind-merge` may be added later if class composition becomes unwieldy, but are **not** part of v1.

### ADR-010 — Rate limiting: in-memory sliding window, process-local by design
`lib/security/rateLimiter.ts` keys a sliding-window limiter on client IP, defaulting to 5 requests per 60 seconds (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`). Buckets are cleaned via a lazy sweep that runs at most once per window, so memory stays bounded without a background timer.

**Known limitation, not a gap in the design:** state lives in a plain `Map` inside a single function instance — it resets on every cold start and is not shared across concurrent Vercel instances. The effective global limit scales with however many instances are warm, not with the configured value. Adequate for a demo; a production deployment would need a shared store (e.g. Redis/Upstash).
