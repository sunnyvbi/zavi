"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Globe } from "lucide-react";
import { trackEvent } from "@/lib/analytics/events";
import { liveStartHref } from "@/lib/marketing/liveFrom";
import { attributionLink } from "@/lib/marketing/attributionLinks";

function SiteField({ value, onChange, big }: { value: string; onChange: (v: string) => void; big?: boolean }) {
  return (
    <label className={`flex min-w-0 flex-1 items-center gap-2 rounded-full border border-white/20 bg-white/[0.06] px-4 text-white ${big ? "min-h-14" : "min-h-12"}`}>
      <Globe aria-hidden className="h-4 w-4 shrink-0 text-white/50" />
      <span className="sr-only">Your website</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="yourwebsite.com"
        inputMode="url"
        autoComplete="url"
        autoCapitalize="none"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-white/40"
      />
    </label>
  );
}

function useGo(slug: string, placement: "hero" | "bar") {
  const router = useRouter();
  return (site: string) => (e: FormEvent) => {
    e.preventDefault();
    trackEvent("live_cta_clicked", { slug, placement, has_site: site.trim().length > 0 });
    router.push(attributionLink(liveStartHref(slug, site), window.location.href));
  };
}

export function LiveSiteBox({ slug, starterUsd }: { slug: string; starterUsd: number }) {
  const [site, setSite] = useState("");
  const go = useGo(slug, "hero");
  return (
    <form onSubmit={go(site)} className="w-full sm:basis-full">
      <p className="mb-2 text-[15px] font-semibold text-white">Want Zavi on your business? Same agent, your site.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <SiteField value={site} onChange={setSite} big />
        <button
          type="submit"
          className="inline-flex min-h-14 shrink-0 items-center justify-center gap-2 rounded-full bg-[#027bff] px-7 text-[17px] font-semibold whitespace-nowrap text-white shadow-[0_0_32px_rgba(2,123,255,0.65)] transition hover:bg-[#026ae0]"
        >
          Run Zavi on my site <ArrowRight aria-hidden className="h-5 w-5" />
        </button>
      </div>
      <p className="mt-2 text-[13px] text-white/60">
        Free growth score in about 2 minutes, then Zavi takes your goal as its mission. Free to start · no card · no ad budget needed · Starter $
        {starterUsd}/mo when you want more.
      </p>
    </form>
  );
}

export function LiveSiteBar({ slug }: { slug: string }) {
  const [site, setSite] = useState("");
  const go = useGo(slug, "bar");
  return (
    <form onSubmit={go(site)} className="flex gap-2">
      <SiteField value={site} onChange={setSite} />
      <button type="submit" aria-label="Run Zavi on my site" className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[#027bff] text-white">
        <ArrowRight aria-hidden className="h-5 w-5" />
      </button>
    </form>
  );
}
