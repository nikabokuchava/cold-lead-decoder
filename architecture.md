---
title: Cold Lead Decoder — MVP Architecture Brainstorm
date: 2026-05-19
tags: [architecture, mvp, cold-lead-decoder, llm, scraping, nextjs, micro-saas]
status: architecture-locked
recommended_stack: Next.js 14 (App Router, TS) + one Node route handler + DeepSeek (OpenAI SDK) + Zod + cheerio/readability + Tailwind + Vercel
---

> **Change note (2026-05-19): LLM provider switched from Anthropic → DeepSeek.** It's one provider swap, but it has two non-cosmetic consequences baked into the sections below: (1) DeepSeek has **no strict tool/schema-enforced structured output** like Anthropic — you get `response_format: {type:"json_object"}` (valid JSON only, *not* schema-valid), so **Zod + the repair retry move from "recommended" to load-bearing and mandatory**; (2) DeepSeek throttles with **HTTP 429 under concurrency**, which is a real *live-demo* risk and adds a retry/backoff requirement + makes the optional cache a demo-warming tactic. Model: **`deepseek-chat`, thinking disabled** (intentionally used over `deepseek-v4-flash` for JSON mode reliability; v4-flash can be re-evaluated via A/B eval harness when needed). Everything else in this doc stands.

> **Historical document.** This is the pre-implementation design brainstorm this v1 build was based on, kept for its reasoning trail — it is not a live spec. Where it disagrees with the shipped code, the code and [`docs/architecture-decisions.md`](./docs/architecture-decisions.md) are authoritative. Known drift since this was written:
> - **SSRF guard (§4 step 2, §6):** shipped as `dns.promises.resolve4` / `resolve6`, not `dns.promises.lookup`; see ADR-006 for the DNS-rebinding caveat this implies.
> - **Domain cache (§8, §12):** shipped as an in-process `lru-cache` (`lib/cache/domainCache.ts`), not Vercel KV.
> - **Persistence (§1, §13):** a later decision (ADR-007) added Neon Postgres for eval-run metrics only. The "no database" framing below refers to user data, sessions, and history, which remain genuinely out of scope.
> - **Framework version (§8, §14):** upgraded from Next.js 14 to Next.js 15.5.20 in a later security-driven dependency remediation — no maintained Next 14 patch cleared the applicable high-severity advisories; see ADR-001.

# Cold Lead Decoder — MVP Architecture Brainstorm

No code yet. This is the thinking pass. Opinionated, MVP-first, solo-builder-paced. The recurring theme: **strong contracts around fragile parts (scraping + LLM), nothing else.**

---

## 1. PRODUCT SHAPE

**Restated MVP.** One input (a company domain). The app reads that company's own public site (homepage, and `/about` only if the homepage is thin), feeds the cleaned text to one LLM call, and returns a single structured card: what they do, business signals, likely pains, one personalized cold-email opener, two follow-up angles. User copies the opener. No accounts, no storage, no second screen.

**Exact user + JTBD.** A solo founder / SDR / agency owner doing manual outbound. JTBD: *"Before I email this company cold, give me — in seconds — enough real, specific context to write a first line that doesn't sound like a bot."* They are not buying "research." They are buying the removal of 12 minutes of tab-hopping per lead.

**Good demo vs weak demo.** A weak version of this is a glorified "summarize this website" — bland bullets anyone gets from ChatGPT. The strong version is judged entirely on one thing: **does the opener reference a specific, true, non-obvious detail from *their* site?** If yes, the demo lands in 8 seconds. If the opener is "I noticed you're a software company" the whole product is dead on arrival. Every architecture decision below protects that one output.

**The single wow moment.** The `personalized_opener` field rendering with a concrete, site-sourced hook — visually the hero of the card, with a copy button. Everything else is supporting cast.

---

## 2. CORE ARCHITECTURE OPTIONS

### Option A — Simplest possible

| Aspect | Choice |
|---|---|
| Frontend | Next.js App Router, single page, Tailwind, one client component for the input |
| Backend | One **Server Action** |
| Scraping | `fetch()` + `cheerio` text extraction, homepage only |
| LLM | One DeepSeek call (OpenAI SDK), prompt asks for JSON |
| Schema/validation | `JSON.parse` + a couple of `if` checks |
| Rendering | Server-rendered card |
| Deployment | Vercel, zero config |

**Pros.** Buildable in a day. Nothing to operate. Perfect for a throwaway demo.
**Cons.** No clean API contract (Server Action is hard to test/curl/reuse). No schema enforcement → fragile against LLM drift. Homepage-only misses context on SPA sites. No retry on bad JSON.
**What goes wrong.** First JS-heavy SPA you demo returns empty HTML → garbage card → live demo dies. `JSON.parse` throws on a trailing comma → 500 on stage.

### Option B — Balanced production-minded MVP ✅

| Aspect | Choice |
|---|---|
| Frontend | Next.js App Router, one page, Tailwind, client component posts to API |
| Backend | One **Route Handler** `POST /api/decode` (Node runtime, not Edge) |
| Scraping | `fetch()` + `@mozilla/readability` (fallback `cheerio`), homepage + conditional `/about` |
| LLM | One DeepSeek `deepseek-chat` call (OpenAI SDK, thinking disabled) in `json_object` mode, **mandatory** repair retry |
| Schema/validation | **Zod schema = single source of truth**, shared by API + UI |
| Rendering | Client renders typed view model from validated JSON |
| Deployment | Vercel; optional Vercel KV cache keyed by domain (24h) |

**Pros.** Real API contract (curlable, testable, reusable as the future SaaS endpoint). Zod catches LLM drift before it hits the UI. Conditional `/about` fetch improves quality without crawling. Repair retry survives bad JSON live. Still one screen, one call, no DB.
**Cons.** Slightly more wiring than A (an extra hour or two). KV cache is one more moving part (so make it optional/feature-flagged).
**What goes wrong.** A genuinely empty SPA still yields thin text — handled by an explicit "limited public info" graceful-degrade path (see §7), not a crash.

### Option C — More scalable

| Aspect | Choice |
|---|---|
| Frontend | Same, + skeleton/streaming states |
| Backend | Next.js + separate **Playwright scraping microservice** (Fly.io/Render container) |
| Scraping | Static fetch first, headless browser fallback for JS-heavy sites |
| LLM | Two-stage: extract facts → reason into card; provider abstraction layer |
| Schema/validation | Zod + persisted schema version |
| Rendering | Same |
| Deployment | Vercel + container + queue (QStash/Inngest) + Postgres (cache/history) |

**Pros.** Handles JS-heavy sites properly; async-ready; this *is* the eventual product spine.
**Cons.** A microservice + queue + DB for a demo is exactly the fake complexity you said you don't want. Days become weeks. Headless browser = cold starts, memory, bot-blocking, ops.
**What goes wrong.** You spend week one debugging Playwright on a container instead of shipping the demo. Classic.

---

## 3. RECOMMENDED V1 ARCHITECTURE — **Option B**

One Next.js app, one Node route handler, static scrape with readability, one DeepSeek `json_object` call guarded by a shared Zod schema, one repair retry, no DB. Why it wins on each axis:

- **Speed.** ~1–2 days solo. No infra to stand up. One call path.
- **Reliability.** The two fragile parts (scrape, LLM) each get exactly one guard: graceful-degrade on thin content, Zod + repair retry on bad JSON. With DeepSeek this second guard is **not optional** — `json_object` mode guarantees *parseable* JSON but not *schema-valid* JSON (no Anthropic-style tool enforcement), so Zod is the only thing standing between model drift and a broken card. Add backoff retry on HTTP 429/500/503 (DeepSeek throttles under concurrency). Still the right, minimal amount of hardening — just two guards instead of one-and-a-half.
- **Demo clarity.** Single screen, single request, deterministic-looking output. Nothing async to "wait and refresh."
- **Maintainability.** Zod schema is the contract between scrape → LLM → API → UI. Change the card? Change one file.
- **Future extensibility.** A real `POST /api/decode` endpoint with a typed contract *is* the v1 of the SaaS API. Caching, auth, credits, history all bolt on around it without touching the core (see §12). Option A's Server Action would have to be thrown away; Option B's route handler graduates.

---

## 4. DATA FLOW (request lifecycle)

1. **Input.** User submits a string. Client does a cheap sanity check only (non-empty).
2. **Validation/normalization (server).** Strip `https://`, `www.`, paths, query. Validate it parses as a hostname with a real TLD. Reject obvious junk (`localhost`, literal IPs, no dot). **SSRF guard, hardened:** don't just regex the hostname — resolve it with Node's native `dns.promises.lookup` and reject if the *resolved* IP falls in a private/loopback/link-local/CGNAT range (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`). String checks alone miss a public hostname that resolves to an internal IP (DNS-rebinding). Re-apply the resolved-IP check after each redirect (step 3) — a 302 to an internal address is the classic bypass. Never pass the input to a shell; pure `fetch` only.
3. **Fetch homepage.** `GET https://<domain>/` with a real User-Agent, `Accept: text/html`, 8s timeout, follow ≤3 redirects, cap response body (~1.5 MB).
4. **Content cleanup.** Run Readability; fall back to `cheerio` (strip `script/style/nav/footer`, take main text). Collapse whitespace. Measure usable text length.
5. **Thin-content check.** If usable text < ~600 chars, fetch `/about` (and try `/about-us`) once, same rules, concatenate. If still thin → set `degraded=true` and continue with whatever exists (do **not** abort).
6. **Truncate.** Cap combined text to ~10–12k chars (front-load homepage). This bounds cost and latency.
7. **Structured extraction.** One DeepSeek call (`deepseek-chat`, thinking disabled): system prompt (role + rules) + user prompt (cleaned text + the JSON contract) with `response_format: { type: "json_object" }`. **The prompt must explicitly instruct the model to respond with JSON** — DeepSeek's JSON mode requires this, and without it the model can emit an unbounded whitespace stream that hangs the request until `max_tokens`. Always set a sane `max_tokens`.
8. **Response validation.** Zod-parse the model output. On failure: one **repair call** ("your previous output failed validation with these errors; return corrected JSON only"). On second failure → structured error.
9. **Business-reasoning quality gate (cheap, local).** Reject/flag an opener that contains banned generic phrases ("I hope this finds you well", "I came across your company", "as a leading provider"). If flagged → mark `low_confidence` in `confidence_notes` rather than retry (keeps demo fast).
10. **UI rendering.** Client receives validated JSON, renders the typed card. Opener block is visually dominant + copy-to-clipboard with confirmation.
11. **Error handling.** Every stage maps to one user-facing state: invalid domain → inline field error; fetch fail/timeout → "Couldn't reach this site"; thin content → card renders with a small "Based on limited public info" badge; LLM/validation hard fail → "Decode failed, try another domain" + retry button. Never a raw 500 on screen.

---

## 5. EXTRACTION CONTRACT (JSON schema)

Opinionated: required = anything the card visibly depends on; optional = honesty/diagnostics.

```jsonc
{
  "company_name":        "string",                  // REQUIRED
  "domain":              "string",                  // REQUIRED (echo normalized)
  "summary":             "string (1–2 sentences)",  // REQUIRED
  "category":            "string (short label)",    // REQUIRED
  "positioning_signals": ["string", ...],           // REQUIRED, 2–4 items
  "likely_pain_points":  ["string", ...],           // REQUIRED, 2–3 items
  "personalized_opener": "string (1–2 sentences)",  // REQUIRED — the hero
  "follow_up_angles":    ["string", "string"],      // REQUIRED, exactly 2
  "confidence_notes":    "string | null",           // OPTIONAL
  "source_pages":        ["url", ...],              // REQUIRED (pages actually fetched)
  "degraded":            "boolean",                 // REQUIRED (drives the UI badge)
  "evidence": {                                     // OPTIONAL but strongly recommended
    "opener_basis": "string"                        //   the exact site detail the opener leans on
  }
}
```

Rules enforced in Zod, not just the prompt: `follow_up_angles` length **exactly 2**; `positioning_signals` 2–4; `likely_pain_points` 2–3; every string non-empty and length-capped. `source_pages` must be a subset of pages you actually fetched. `evidence.opener_basis` is optional in the schema but **required by the prompt**.

---

## 6. SCRAPING STRATEGY

Decisive recommendation: **static `fetch()` + Readability, homepage + conditional `/about`, synchronous, no queue, no headless browser in v1.**

- **Simple fetch + HTML parse** — do this. Works for the large majority of marketing sites (they SSR for SEO).
- **Readability extraction** — do this on top. Strips nav/boilerplate so the LLM sees the actual pitch.
- **Headless browser fallback** — **do NOT build for v1.** Detect JS-only pages (thin text) and degrade gracefully instead.
- **Homepage only vs homepage + /about** — homepage first; fetch `/about` *only* when homepage text is thin.
- **Synchronous vs queued** — synchronous. Total budget ~8–12s fits a single request with a loading state.

Hard guards: timeout, body-size cap, redirect cap, real UA, and an **SSRF guard that resolves DNS and checks the resolved IP** against private/loopback/link-local/CGNAT ranges, re-checked after every redirect.

---

## 7. FAILURE MODES

| Failure | Why | Reduce it | Graceful product behavior |
|---|---|---|---|
| JS-heavy SPA, empty HTML | Client-rendered, no SSR | Thin-content detection → try `/about` | Render partial card + "Based on limited public info" badge |
| Weak/absent About page | Small or marketing-thin company | Homepage is primary anyway | Card from homepage only; `confidence_notes` set |
| Generic opener | The core risk | Force `evidence.opener_basis`; reject banned phrases locally | Show `confidence_notes`: "Limited specific signals found" |
| Hallucinated signals | Model fills gaps | "Use only the provided text" + `source_pages` subset check | Drop unverifiable signals |
| Slow response | Scrape + LLM latency | 8s fetch timeout, capped input, `deepseek-chat` thinking disabled, capped `max_tokens` | Skeleton card + status text |
| **DeepSeek 429 / throttle** | DeepSeek limits concurrency | Exponential backoff on 429/500/503; pre-warm cache for demo domains | "High demand — retrying…" then result |
| Schema breakage | LLM drift / non-schema JSON | `json_object` mode + Zod + mandatory repair retry | Hard fail after retry → clean error + retry button, never raw 500 |

**Design principle: every failure has a defined card state. The product is never blank and never lying confidently.**

---

## 8. MVP TECH STACK (decisive)

- **Framework:** Next.js 14, App Router, TypeScript
- **API:** one Route Handler `POST /api/decode`, **Node runtime** (not Edge)
- **Scraping:** native `fetch` + `@mozilla/readability` + `jsdom`, `cheerio` as fallback
- **LLM:** DeepSeek via OpenAI SDK (`baseURL: "https://api.deepseek.com"`). Model `deepseek-chat`, thinking disabled, `json_object` mode, capped `max_tokens`, backoff on 429/500/503. Behind a single `extractLeadCard()` function.
- **Validation:** Zod, schema shared by API and UI
- **UI:** Tailwind, no component library
- **State:** none server-side. Optional Vercel KV 24h domain cache — feature-flagged
- **Deploy:** Vercel

---

## 9. FILE / MODULE BREAKDOWN

```
/app
  /page.tsx                      # the one screen (input + result)
  /api/decode/route.ts           # POST handler: orchestrates the pipeline only
/components
  /DomainInput.tsx
  /LeadCard.tsx                  # renders the typed view model
  /CardStates.tsx                # Loading / Error / Degraded badge
/lib
  /domain/normalize.ts           # parse, strip, validate, SSRF guard
  /scraper/fetch.ts              # fetch w/ timeout, redirects, size cap, UA
  /scraper/extractText.ts        # readability + cheerio fallback, thin-check
  /scraper/collectSources.ts     # homepage + conditional /about, truncation
  /llm/deepseek.ts               # builds prompt, calls DeepSeek, backoff + repair retry
  /llm/prompt.ts                 # system + user prompt templates, banned phrases
  /schema/leadCard.ts            # Zod schema = single source of truth + types
  /opener/guard.ts               # local banned-phrase / generic check
  /pipeline/decode.ts            # orchestrator: normalize→scrape→llm→validate
/lib/log.ts                      # tiny structured logger
```

Rule: `route.ts` contains *no logic* — it calls `pipeline/decode.ts` and maps results to HTTP.

---

## 10. PROMPT / EXTRACTION DESIGN

**System prompt role.** "You are a senior B2B sales researcher preparing a one-screen brief for a cold outbound email. You only use facts present in the provided website text."

**User prompt structure:**
1. Task line: produce one JSON object matching the contract
2. Cleaned site text, clearly delimited with page labels
3. Schema with per-field instructions and length caps
4. Hard rules block
5. Forcing function for the opener

**DeepSeek JSON-mode requirement (non-negotiable).** System prompt must contain: *"Respond with a single valid JSON object and nothing else — no prose, no markdown fences."* Include a compact JSON shape example. Then let Zod be the real enforcer.

**Rules to include:**
- Use only the provided text. If unsupported, omit or note in `confidence_notes`.
- No marketing fluff. No "leading provider", "innovative", "cutting-edge".
- Pains must be plausible for this specific company's domain.

**Forcing opener quality.** Require `evidence.opener_basis`: "State the single concrete detail from the site the opener is built on. If you cannot find a specific detail, say so and write a deliberately modest opener — do not fabricate specificity."

---

## 11. OBSERVABILITY FOR MVP (lean)

**Log per request:** request id, normalized domain, pages fetched + HTTP status + bytes + ms, usable text length, `degraded` flag, LLM latency ms, DeepSeek HTTP status + `finish_reason` + retry count, validation result.

**Do NOT log:** full scraped content, full LLM output by default, PII. Use a `DEBUG` env flag for local debugging.

**Key correlation:** always log `usable_text_length` + `degraded` alongside validation result — this explains ~90% of bad cards.

---

## 12. FUTURE UPGRADE PATH

Each step bolts onto the same `pipeline/decode.ts` + Zod contract:

- **Caching:** flip the optional Vercel KV cache on (domain → card, 24h)
- **Saved history:** add Postgres/Supabase, persist `{domain, card_json, created_at}` (flat relational table — no embeddings, no chunks, no similarity search)
- **Credits/billing:** wrap `/api/decode` in auth + credit-check middleware; Stripe, $10 = 100 decodes. When this lands: Prisma singleton, `CHECK (credits >= 0)` DB constraint, Stripe webhook idempotency on `event.id`, Postgres RLS with `org_id`/`user_id` FK. **Billing-phase, not project Day-1.**
- **Bulk decode:** now a queue earns its keep (Inngest/QStash)
- **CRM export:** output adapter mapping card schema to HubSpot/Pipedrive fields
- **Headless rendering:** Playwright microservice as fallback inside `scraper/` — driven by real failure data
- **API product:** add keys + rate limiting, document it

Order of real value: **cache → history → credits → bulk.**

---

## 13. RUTHLESS SCOPE CONTROL (cut list)

If you catch yourself building any of these in v1, stop:

- Headless browser / Playwright "to be safe" → **cut**
- Multi-page crawl beyond homepage + one `/about` → **cut**
- Provider router / model picker / fallback LLM → **cut**
- Database / history / "just store it for later" → **cut**
- Auth, even "just a magic link for the demo" → **cut**
- Queue / background jobs for a single URL → **cut**
- Two-stage prompt pipeline → **cut**
- A component library for one card → **cut**
- Streaming the LLM token-by-token → **cut**
- Settings, themes, options, "advanced mode" → **cut**

The SSRF guard and the Zod+repair retry are the **only** two non-obvious things you're allowed to spend extra time on.

---

## 14. FINAL VERDICT

**Recommended architecture.** Build a single Next.js 14 (App Router, TypeScript) app with one Node-runtime route handler `POST /api/decode` that runs a linear pipeline: normalize+SSRF-guard → static fetch with timeouts → Readability/cheerio extraction → conditional `/about` → truncate → one DeepSeek call (`deepseek-chat`, thinking disabled, `json_object` mode, explicit JSON directive) → Zod validate → mandatory repair retry → backoff on 429/500/503 → banned-phrase opener check. No database, no auth, no queue, no headless browser.

**"Build this next" checklist:**
- [ ] 1. Scaffold Next.js + TS + Tailwind; one page with domain input and result area
- [ ] 2. Write `lib/schema/leadCard.ts` (Zod) first — it's the contract everything else conforms to
- [ ] 3. Build `lib/domain/normalize.ts` incl. SSRF guard; unit-test junk/private-host cases
- [ ] 4. Build `lib/scraper/` — fetch, Readability+cheerio, thin-content → conditional `/about`, truncation
- [ ] 5. Build `lib/llm/` — prompt templates, DeepSeek call, backoff, Zod parse, repair retry
- [ ] 6. Wire `lib/pipeline/decode.ts` + thin `route.ts` + opener guard + logger
- [ ] 7. Build `LeadCard` + Loading/Error/Degraded states; opener as visual hero with copy button
- [ ] 8. Test on ~12 real domains, tune prompt off failures, record 20-second demo

**3 biggest architecture mistakes to avoid:**
1. **Treating DeepSeek's `json_object` mode as schema enforcement.** It only guarantees parseable JSON — Zod + repair retry is mandatory.
2. **Building a headless-browser scraper for v1.** Graceful degradation demos better and ships in days.
3. **Ignoring DeepSeek 429s until demo day.** Add backoff retry from day one and pre-warm the cache for demo domains.

---

## 15. REVIEW RECONCILIATION (2026-05-19)

**Accepted (project Day-1):**
- *SEC-01 (DNS SSRF):* Resolve via `dns.promises` and check resolved IP (anti DNS-rebinding), re-check after redirects.

**Accepted but re-filed to billing phase (NOT project Day-1):**
- Prisma singleton, Stripe webhook idempotency, `CHECK (credits >= 0)`, RLS / JWT / `org_id` multi-tenancy — all correct for billing phase, not v1.

**Rejected / corrected:**
- *"Bridge Pattern" label* — this is a Humble Object / controller-service separation, not GoF Bridge.

**Accepted as metric, scoped down:**
- Copy-to-clipboard as opener-quality proxy → v1 implementation: one fire-and-forget structured log event (`opener_copied`), not a dashboard.

**Round 2 — rejected (verifier-bleed):**
- `org_id` FK on `chunks`/`documents` tables + similarity filter before top-k — correct pgvector/RAG principle imported from the wrong corpus. Cold Lead Decoder has no embeddings, no chunks, no similarity search in any phase. Filed under RAG projects only.
