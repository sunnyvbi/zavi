"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Skeleton } from "../Skeleton";

const GONE_STATUSES: ReadonlySet<string> = new Set(["fell_back_old", "deleting", "deleted"]);

export const SITE_CUSTOM_DOMAINS_SOON = "Custom domains are coming soon";
export const SITE_NOT_LIVE_YET = "Not live yet. When you publish, your site goes live at this address.";
export const SITE_GONE = "This site is no longer published.";

export function siteAddress(site: { hostname: string; status: string }, deployedUrl: string | null): {
  url: string | null;
  live: boolean;
} {
  if (deployedUrl) return { url: deployedUrl, live: true };
  if (GONE_STATUSES.has(site.status) || !site.hostname) return { url: null, live: false };
  return { url: `https://${site.hostname}`, live: false };
}

export const SITE_DOMAINS_TITLE = "Domains";
export const SITE_DOMAINS_INTRO = "The address your site is reachable at.";

function DomainsHeader() {
  return (
    <div className="mb-5">
      <h2 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">{SITE_DOMAINS_TITLE}</h2>
      <p className="mt-0.5 text-[13px] text-[#8c8c8c]">{SITE_DOMAINS_INTRO}</p>
    </div>
  );
}

export function SiteDomainsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading domains" data-section-skeleton="domains" className="mx-auto max-w-[720px] p-4 sm:p-6">
      <DomainsHeader />
      <div aria-hidden>
        <div data-skeleton-row className="rounded-xl border border-[#f0f0f0] p-4">
          <Skeleton className="h-4 w-24" />
          <div className="mt-2 flex min-w-0 items-center gap-2">
            <Skeleton className="h-9 min-w-0 flex-1" rounded="rounded-lg" />
            <Skeleton className="h-10 w-[84px] shrink-0" rounded="rounded-cta" delayMs={120} />
            <Skeleton className="h-10 w-[80px] shrink-0" rounded="rounded-cta" delayMs={120} />
          </div>
        </div>
        <div data-skeleton-row className="mt-6">
          <Skeleton className="mb-2 h-4 w-32" delayMs={240} />
          <Skeleton className="h-[52px] w-full" rounded="rounded-xl" delayMs={240} />
        </div>
      </div>
    </div>
  );
}

export function SiteDomainsView({
  site,
  deployedUrl,
}: {
  site: { hostname: string; status: string };
  deployedUrl: string | null;
}) {
  const { url, live } = siteAddress(site, deployedUrl);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 3000);
    } catch {
      setCopied(false);
    }
  }, [url]);

  return (
    <div className="mx-auto max-w-[720px] p-4 sm:p-6">
      <DomainsHeader />

      <section aria-label="Site address" className="rounded-xl border border-[#f0f0f0] p-4">
        <h3 className="text-[13px] font-semibold text-[#0e0f11]">Zavi address</h3>
        {url ? (
          <>
            <div className="mt-2 flex min-w-0 items-center gap-2">
              <span
                data-testid="site-address"
                className="min-w-0 flex-1 truncate rounded-lg bg-[#f9f9f9] px-3 py-2 font-mono text-[13px] text-[#0e0f11]"
                title={url}
              >
                {url.replace(/^https:\/\//, "")}
              </span>
              <button
                type="button"
                onClick={() => void copy()}
                aria-label={copied ? "Copied address" : "Copy address"}
                title={copied ? "Copied" : "Copy"}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-cta border border-[#f0f0f0] bg-white text-[#0e0f11] transition-colors hover:bg-[#f9f9f9]"
              >
                {copied ? <Check className="h-4 w-4 text-[#595959]" aria-hidden /> : <Copy className="h-4 w-4 text-[#595959]" aria-hidden />}
              </button>
              {live && (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open site"
                  className="inline-flex h-10 shrink-0 items-center gap-2 rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-medium text-[#0e0f11] transition-colors hover:bg-[#f9f9f9]"
                >
                  <ExternalLink className="h-4 w-4 text-[#595959]" aria-hidden />
                  Open
                </a>
              )}
            </div>
            {!live && <p className="mt-2 text-[13px] text-[#595959]">{SITE_NOT_LIVE_YET}</p>}
          </>
        ) : (
          <p className="mt-2 text-[13px] text-[#595959]">{SITE_GONE}</p>
        )}
      </section>

      <section aria-label="Custom domains" className="mt-6">
        <h3 className="mb-2 text-[14px] font-semibold text-[#0e0f11]">Custom domains</h3>
        <p className="rounded-xl border border-[#f0f0f0] bg-[#f9f9f9] p-4 text-[13px] text-[#595959]">
          {SITE_CUSTOM_DOMAINS_SOON}
        </p>
      </section>
    </div>
  );
}
