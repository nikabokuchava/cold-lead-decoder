"use client";

import type { LeadCard as LeadCardData } from "../lib/schema/leadCard";
import { useState } from "react";

export interface LeadCardProps {
  card: LeadCardData;
}

function CopyIcon({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="8" height="9" rx="1.5" />
      <path d="M10 5V3.5A1.5 1.5 0 0 0 8.5 2h-5A1.5 1.5 0 0 0 2 3.5v7A1.5 1.5 0 0 0 3.5 12H5" />
    </svg>
  );
}

function CheckIcon({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5L6.5 12 13 4" />
    </svg>
  );
}

function Eyebrow({
  children,
  color = "text-neutral-500",
}: {
  children: React.ReactNode;
  color?: string;
}): JSX.Element {
  return (
    <h3
      className={`font-mono text-[10px] font-medium uppercase tracking-[0.22em] ${color}`}
    >
      {children}
    </h3>
  );
}

function BulletList({ items }: { items: readonly string[] }): JSX.Element {
  return (
    <ul className="mt-3 space-y-2.5">
      {items.map((s) => (
        <li
          key={s}
          className="flex gap-3 text-[13.5px] leading-relaxed text-neutral-300"
        >
          <span className="mt-[9px] h-[3px] w-[3px] shrink-0 rounded-full bg-neutral-600" />
          <span>{s}</span>
        </li>
      ))}
    </ul>
  );
}

function SourceLinks({ urls }: { urls: readonly string[] }): JSX.Element | null {
  if (urls.length === 0) return null;
  const seen = new Set<string>();
  const items: { href: string; label: string }[] = [];
  for (const u of urls) {
    let host: string;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      host = parsed.hostname;
    } catch {
      continue;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    items.push({ href: u, label: host });
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 normal-case tracking-normal">
      <span className="text-[10px] uppercase tracking-[0.18em] text-neutral-600">
        Sources
      </span>
      {items.map((it) => (
        <a
          key={it.href}
          href={it.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-neutral-500 hover:text-neutral-300 hover:underline"
        >
          {it.label}
        </a>
      ))}
    </div>
  );
}

export function LeadCard({ card }: LeadCardProps): JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "ok" | "err">("idle");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(card.personalized_opener);
      setCopyState("ok");
    } catch {
      setCopyState("err");
    }
    window.setTimeout(() => setCopyState("idle"), 2000);
  };

  const monogram = card.company_name.charAt(0).toUpperCase();

  return (
    <article
      data-testid="lead-card"
      className="rounded-2xl border border-neutral-800/70 bg-neutral-900/40 p-8 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]"
    >
      {/* Header */}
      <header className="flex items-start justify-between gap-5">
        <div className="flex items-center gap-3.5">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-neutral-800 to-neutral-900 ring-1 ring-inset ring-white/[0.06]">
            <span className="font-mono text-[17px] font-medium text-amber-400">
              {monogram}
            </span>
          </div>
          <div>
            <h2 className="text-[19px] font-semibold tracking-tight text-neutral-50">
              {card.company_name}
            </h2>
            <p className="mt-1 font-mono text-[11px] leading-none text-neutral-500">
              <span className="text-neutral-400">{card.domain}</span>
              <span className="mx-2 text-neutral-700">/</span>
              <span className="uppercase tracking-[0.12em]">{card.category}</span>
            </p>
          </div>
        </div>
        {card.degraded ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-amber-300">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            Based on limited public info
          </span>
        ) : null}
      </header>

      {/* Summary */}
      <p className="mt-6 text-[14.5px] leading-relaxed text-neutral-300">
        {card.summary}
      </p>

      {/* Signals + Pain points */}
      <div className="mt-7 grid grid-cols-1 gap-x-8 gap-y-7 border-t border-neutral-800/60 pt-7 md:grid-cols-2">
        <section>
          <Eyebrow>Positioning signals</Eyebrow>
          <BulletList items={card.positioning_signals} />
        </section>
        <section>
          <Eyebrow>Likely pain points</Eyebrow>
          <BulletList items={card.likely_pain_points} />
        </section>
      </div>

      {/* Personalized opener — amber hero */}
      <section
        className="relative mt-7 overflow-hidden rounded-xl border border-amber-500/20 p-6"
        style={{
          background:
            "radial-gradient(130% 160% at 0% 0%, rgba(245,158,11,0.10) 0%, rgba(245,158,11,0.025) 45%, rgba(245,158,11,0) 75%)",
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            <Eyebrow color="text-amber-300/90">Personalized opener</Eyebrow>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy opener to clipboard"
            className={
              copyState === "err"
                ? "inline-flex items-center gap-1.5 rounded-md bg-red-500/20 px-3 py-1.5 text-[12px] font-medium text-red-200 ring-1 ring-inset ring-red-500/40 transition focus:outline-none focus:ring-2 focus:ring-red-400/40 focus:ring-offset-2 focus:ring-offset-neutral-950"
                : "inline-flex items-center gap-1.5 rounded-md bg-amber-400 px-3 py-1.5 text-[12px] font-medium text-neutral-950 transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:ring-offset-2 focus:ring-offset-neutral-950"
            }
          >
            {copyState === "ok" ? (
              <>
                <CheckIcon /> Copied
              </>
            ) : copyState === "err" ? (
              <>Copy failed</>
            ) : (
              <>
                <CopyIcon /> Copy opener
              </>
            )}
          </button>
        </div>
        <p className="mt-4 text-[17px] leading-[1.55] text-amber-50">
          {card.personalized_opener}
        </p>
        <div className="mt-4 border-t border-amber-500/10 pt-3">
          <p className="font-mono text-[11.5px] leading-relaxed text-amber-200/55">
            <span className="text-amber-200/80">Evidence —</span>{" "}
            <em className="not-italic">{card.evidence.opener_basis}</em>
          </p>
        </div>
      </section>

      {/* Follow-up angles */}
      <section className="mt-7">
        <Eyebrow>Follow-up angles</Eyebrow>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {card.follow_up_angles.map((angle, i) => (
            <div
              key={angle}
              className="rounded-xl border border-neutral-800/60 bg-neutral-900/30 p-4"
            >
              <div className="font-mono text-[10px] font-medium tracking-[0.18em] text-neutral-600">
                {String(i + 1).padStart(2, "0")}
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-neutral-300">
                {angle}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-6 flex items-center justify-between gap-4 border-t border-neutral-800/60 pt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-600">
        <SourceLinks urls={card.source_pages} />
        {card.confidence_notes ? (
          <span className="flex max-w-[60%] items-center gap-1.5 normal-case tracking-normal text-amber-400/70">
            <span className="h-1 w-1 shrink-0 rounded-full bg-amber-400/70" />
            <span className="truncate">{card.confidence_notes}</span>
          </span>
        ) : (
          <span>Live · Public scrape</span>
        )}
      </footer>
    </article>
  );
}
