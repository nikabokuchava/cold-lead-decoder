import { LeadCardSchema, type LeadCard } from "../schema/leadCard";
import type { ScrapeResult } from "../scraper/extract";
import type { GenerateLeadCardInput } from "../llm/repair";
import type { OpenerGuard } from "../opener/guard";
import { SSRFBlockedError } from "../scraper/fetch";
import { getCached, setCached } from "../cache/domainCache";

export type PipelineFetcher = (domain: string) => Promise<ScrapeResult>;
export type PipelineGenerator = (
  input: GenerateLeadCardInput,
) => Promise<LeadCard>;

export interface PipelineOpts {
  fetcher: PipelineFetcher;
  generator: PipelineGenerator;
  openerGuard: OpenerGuard;
}

export type DecodeResult =
  | { kind: "ok"; card: LeadCard }
  | {
      kind: "error";
      reason: "invalid_domain" | "fetch_blocked" | "decode_failed";
      message: string;
    };

const DEGRADED_NOTE = "Based on limited public info";

function normalizeDomain(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("invalid domain");
  let s = trimmed.replace(/^https?:\/\//i, "");
  s = s.split(/[/?#]/, 1)[0];
  s = s.replace(/^www\./i, "");
  if (!s || /\s/.test(s) || !s.includes(".")) {
    throw new Error("invalid domain");
  }
  return s.toLowerCase();
}

function mergeNotes(existing: string | null, addition: string): string {
  const merged = existing ? `${existing} | ${addition}` : addition;
  return merged.slice(0, 400);
}

export async function decodePipeline(
  domain: string,
  { fetcher, generator, openerGuard }: PipelineOpts,
): Promise<DecodeResult> {
  let normalized: string;
  try {
    normalized = normalizeDomain(domain);
  } catch (err) {
    return {
      kind: "error",
      reason: "invalid_domain",
      message: err instanceof Error ? err.message : "invalid domain",
    };
  }

  const cacheEnabled = process.env.ENABLE_CACHE === "true";

  if (cacheEnabled) {
    const cached = getCached(normalized);
    if (cached !== undefined) {
      const parsed = LeadCardSchema.safeParse(cached);
      if (parsed.success) {
        return { kind: "ok", card: parsed.data };
      }
    }
  }

  try {
    const scrape = await fetcher(normalized);

    const card = await generator({
      domain: normalized,
      pageText: scrape.text,
      sourcePages: scrape.pages,
      degraded: scrape.degraded,
    });

    // Keep only source_pages we actually fetched (model may echo/invent URLs).
    const allowedPages = new Set(scrape.pages);
    const keptPages = card.source_pages.filter((p) => allowedPages.has(p));
    card.source_pages = keptPages.length > 0 ? keptPages : scrape.pages;

    let notes = card.confidence_notes;
    if (card.degraded && !(notes ?? "").toLowerCase().includes("limited")) {
      notes = mergeNotes(notes, DEGRADED_NOTE);
    }

    const verdict = openerGuard(card.personalized_opener);
    if (!verdict.valid) {
      notes = mergeNotes(notes, verdict.note);
    }

    const finalCard =
      notes === card.confidence_notes ? card : { ...card, confidence_notes: notes };

    if (cacheEnabled) {
      setCached(normalized, finalCard);
    }

    return { kind: "ok", card: finalCard };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof SSRFBlockedError) {
      return { kind: "error", reason: "fetch_blocked", message };
    }
    return { kind: "error", reason: "decode_failed", message };
  }
}
