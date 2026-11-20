"use client";

import { attributionLink } from "@/lib/marketing/attributionLinks";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { findUseCase } from "@/lib/marketing/useCases";
import { LiveStatsStrip } from "@/components/marketing/live/LiveStatsStrip";

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e0f11] focus-visible:shadow-none";

const DAYS = ["MON", "TUE", "WED", "THU"] as const;

export function startHrefForWebsite(input: string, startHref = "/start"): string {
  const site = input.trim();
  if (!site) return startHref;
  const url = new URL(startHref, "https://www.zaviagent.com");
  url.searchParams.set("website", site);
  return `${url.pathname}${url.search}${url.hash}`;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function UseCasesMenuPanel({
  hoveredSlug,
  onNavigate,
  startHref = "/start",
}: {
  hoveredSlug: string | null;
  onNavigate: () => void;
  startHref?: string;
}) {
  const u = hoveredSlug ? findUseCase(hoveredSlug) : undefined;
  return u ? (
    <UseCaseWeek key={u.slug} slug={u.slug} onNavigate={onNavigate} startHref={startHref} />
  ) : (
    <LiveRest onNavigate={onNavigate} />
  );
}

function LiveRest({ onNavigate }: { onNavigate: () => void }) {
  return (
    <aside
      data-testid="use-cases-panel-rest"
      className="flex flex-col gap-3 rounded-[20px] bg-[#f0f0f0] p-4 text-[#0e0f11]"
    >
      <LiveStatsStrip tone="light" />
      <p className="text-[13px] leading-snug text-[#8a8a84]">
        Hover a business type to see what Zavi could do for yours this week.
      </p>
      <p className="border-t border-black/[0.08] pt-2.5 text-[13px] leading-snug text-[#595959]">
        Customer story:{" "}
        <Link
          href="/live/upcar"
          onClick={onNavigate}
          className={`font-semibold text-[#0e0f11] underline underline-offset-2 hover:opacity-80 ${FOCUS}`}
        >
          how Upcar runs on Zavi →
        </Link>
      </p>
    </aside>
  );
}

function UseCaseWeek({ slug, onNavigate, startHref }: { slug: string; onNavigate: () => void; startHref: string }) {
  const u = findUseCase(slug)!;
  const router = useRouter();
  const [site, setSite] = useState("");
  const href = startHrefForWebsite(site, startHref);

  return (
    <aside
      data-testid="use-cases-panel-week"
      className="flex flex-col gap-3 rounded-[20px] bg-[#f0f0f0] p-4 text-[#0e0f11]"
    >
      <div>
        <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-[#595959]">
          Your week with Zavi
          <span className="rounded-full bg-[#0e0f11]/[0.07] px-2 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-[#595959]">
            Example plan
          </span>
        </p>
        <p className="mt-2 text-[20px] font-bold leading-snug">
          What Zavi could do for {lowerFirst(u.week.owner)} this week
        </p>
      </div>
      <ol className="grid gap-2">
        {u.week.days.map((d, i) => (
          <li
            key={DAYS[i]}
            className="grid grid-cols-[38px_1fr] gap-2 rounded-[12px] bg-white px-3 py-2.5 text-[14px] leading-snug"
          >
            <span className="pt-px text-[12px] font-semibold tracking-[0.08em] text-[#8a8a84]">{DAYS[i]}</span>
            <span>{d}</span>
          </li>
        ))}
      </ol>
      <form
        className="flex items-center gap-2 rounded-full border border-black/10 bg-white p-1.5 focus-within:border-black/30"
        onSubmit={(e) => {
          e.preventDefault();
          onNavigate();
          router.push(attributionLink(href, window.location.href));
        }}
      >
        <input
          type="text"
          inputMode="url"
          aria-label="Your website"
          placeholder="yoursite.com"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          className="min-h-10 min-w-0 flex-1 border-0 bg-transparent px-3 text-[14px] text-[#0e0f11] outline-none placeholder:text-[#8a8a84]"
        />
        <Link
          href={href}
          onClick={onNavigate}
          className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full bg-[#0e0f11] px-4 text-[14px] font-semibold text-white transition-opacity duration-200 hover:opacity-90 ${FOCUS} focus-visible:rounded-full`}
        >
          Make it mine
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </form>
    </aside>
  );
}
