"use client";

import { useState } from "react";
import { ExternalLink, Globe } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { siteBadge, siteHref } from "@/lib/workspace/buildHistory";
import { formatArtifactDate, formatArtifactDateShort } from "./formatArtifact";
import type { ArtifactView, SiteArtifact } from "./types";
import { RebuildOldSiteButton } from "@/components/workspace/OldSiteRebuild";

const BADGE_TONE = {
  success: "bg-success/15 text-success",
  progress: "bg-ink/[0.06] text-ink",
  muted: "bg-ink/[0.04] text-inkMuted",
  danger: "bg-danger/10 text-danger",
} as const;

function StatusBadge({ site }: { site: SiteArtifact }) {
  const badge = siteBadge(site, site.built ? "ready" : undefined);
  if (!badge) return null;
  return (
    <span
      data-site-status={badge.label}
      className={cn("shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium", BADGE_TONE[badge.tone])}
    >
      {badge.label}
    </span>
  );
}

function LiveLink({ site, className }: { site: SiteArtifact; className?: string }) {
  const href = siteHref(site);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${site.title} live site`}
      title={site.hostname}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-full text-inkMuted hover:bg-creamDeep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30",
        className,
      )}
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  );
}

function useThumbnail(site: SiteArtifact): [string | null, () => void] {
  const url = site.thumbnail_url ?? null;
  const [failed, setFailed] = useState<string | null>(null);
  return [url && url !== failed ? url : null, () => setFailed(url)];
}

export function SiteArtifactItem({
  site,
  view,
  onOpen,
}: {
  site: SiteArtifact;
  view: ArtifactView;
  onOpen: (() => void) | null;
}) {
  const [thumb, thumbFailed] = useThumbnail(site);
  const open = onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${site.title} in Build`}
      className="absolute inset-0 rounded-cta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/30"
    />
  ) : null;

  if (view === "list") {
    return (
      <Card data-site-artifact={site.id} className="relative flex items-center gap-4 p-3">
        {open}
        <span className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-creamDeep text-[#2f7cf6]">
          {thumb ? (
            <img
              src={thumb}
              alt=""
              data-site-thumbnail=""
              loading="lazy"
              decoding="async"
              onError={thumbFailed}
              className="h-full w-full object-cover object-left-top"
            />
          ) : (
            <Globe className="h-6 w-6" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-ink" title={site.title}>
            {site.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-inkMuted">
            <Badge>Website</Badge>
            <StatusBadge site={site} />
            <span>{formatArtifactDate(site.created_at)}</span>
            <span className="truncate">{site.hostname}</span>
          </div>
          {site.old_pipeline ? (
            <div className="relative z-10 mt-2">
              <p className="mb-1.5 text-xs text-inkMuted">Made with our earlier builder. It stays live but can&apos;t be changed.</p>
              <RebuildOldSiteButton />
            </div>
          ) : null}
        </div>
        <LiveLink site={site} className="relative" />
      </Card>
    );
  }

  return (
    <div data-tile="site" data-site-artifact={site.id} className="group relative">
      <div className={cn("relative flex aspect-square flex-col overflow-hidden rounded-xl bg-creamDeep", thumb ? "" : "p-3")}>
        <div className={cn("flex shrink-0 items-center gap-1", thumb && "h-6 px-3")} aria-hidden="true">
          <span className="h-1.5 w-1.5 rounded-full bg-ink/15" />
          <span className="h-1.5 w-1.5 rounded-full bg-ink/15" />
          <span className="h-1.5 w-1.5 rounded-full bg-ink/15" />
        </div>
        {thumb ? (
          <>
            <img
              src={thumb}
              alt={`Preview of ${site.title}`}
              data-site-thumbnail=""
              loading="lazy"
              decoding="async"
              onError={thumbFailed}
              className="min-h-0 w-full flex-1 bg-cream object-cover object-left-top"
            />
            <span className="absolute bottom-2 left-2 rounded-full bg-cream shadow-sm empty:hidden">
              <StatusBadge site={site} />
            </span>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
            <Globe className="h-6 w-6 text-[#2f7cf6]" aria-hidden="true" />
            <span className="line-clamp-2 text-[14px] font-semibold leading-5 text-ink">{site.title}</span>
            <StatusBadge site={site} />
          </div>
        )}
        {open}
      </div>
      <LiveLink site={site} className="absolute right-2 top-2 z-10 bg-cream/90" />
      <div className="mt-2 min-w-0 px-0.5">
        <h2 className="truncate text-[13px] font-medium leading-4 text-ink" title={site.title}>
          {site.title}
        </h2>
        <p className="mt-0.5 truncate text-[11px] leading-4 text-inkLight" title={site.hostname}>
          Website · {formatArtifactDateShort(site.created_at)}
        </p>
        {site.old_pipeline ? (
          <div className="relative z-10 mt-1.5">
            <p className="mb-1 text-[11px] leading-4 text-inkMuted">Earlier builder: live, can&apos;t be changed.</p>
            <RebuildOldSiteButton />
          </div>
        ) : null}
      </div>
    </div>
  );
}
