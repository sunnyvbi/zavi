"use client";

import Link from "next/link";
import { HumanSectionShell } from "./HumanSectionShell";
import { HumanSectionTabs } from "./HumanSectionTabs";
import {
  HumanChip,
  HumanEmpty,
  HumanError,
  HumanNotBuilt,
  HumanSessionExpired,
  HumanSkeleton,
} from "./HumanStates";
import { useHumanResource } from "./useHumanResource";
import type { HumanBriefsResponse } from "./humanTypes";

function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return "-";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function HumanBriefsIsland() {
  const { data, loading, error, sessionExpired, notBuilt, reload } =
    useHumanResource<HumanBriefsResponse>("/api/humans/briefs");

  return (
    <HumanSectionShell
      title="Human"
      lede="The vetted people your agents can brief directly. A brief starts in the growth agent's diagnosis, gets matched to human members here, and ends in an engagement with an attributed receipt."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/humans/creators"
            className="inline-flex items-center justify-center rounded-full border border-ink/15 px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
          >
            Find creators
          </Link>
          <Link
            href="/humans/library"
            className="inline-flex items-center justify-center rounded-full border border-ink/15 px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
          >
            Library
          </Link>
        </div>
      }
    >
      <HumanSectionTabs active="/humans" />
      {sessionExpired ? (
        <HumanSessionExpired next="/humans" />
      ) : notBuilt ? (
        <HumanNotBuilt what="The human brief list" />
      ) : loading && !data ? (
        <HumanSkeleton />
      ) : error ? (
        <HumanError message={error} onRetry={reload} />
      ) : !data || data.briefs.length === 0 ? (
        <HumanEmpty
          title="No briefs yet"
          body="Briefs are written by your growth agent when it finds a creative problem worth solving: fatigued ads, a missing angle, an objection nobody is answering. Ask the performance marketer to look at your ads and one will land here."
          action={
            <Link
              href="/workspace?agent=performance-marketer"
              className="inline-flex items-center justify-center rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-cream hover:bg-ink/90"
            >
              Open the performance marketer
            </Link>
          }
        />
      ) : (
        <ul className="space-y-4">
          {data.briefs.map((b) => (
            <li key={b.id}>
              <Link
                href={`/humans/briefs/${encodeURIComponent(b.id)}/matches`}
                className="block rounded-xl border border-ink/[0.08] bg-white px-4 py-4 shadow-[0_1px_2px_rgba(25,25,25,0.04)] transition-colors hover:border-ink/20 hover:bg-ink/[0.01]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[16px] font-semibold leading-[1.4] text-ink">
                      {b.title || "Untitled brief"}
                    </p>
                    <p className="mt-1 text-[12px] text-inkMuted">
                      Written {relativeTime(b.created_at)}
                      {b.utm_campaign ? ` · ${b.utm_campaign}` : ""}
                    </p>
                  </div>
                  <HumanChip
                    tone={b.status === "open" ? "info" : "neutral"}
                  >
                    {b.status || "draft"}
                  </HumanChip>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <HumanChip>
                    {b.match_count ?? 0} match
                    {b.match_count === 1 ? "" : "es"}
                  </HumanChip>
                  <HumanChip>
                    {b.application_count ?? 0} application
                    {b.application_count === 1 ? "" : "s"}
                  </HumanChip>
                  <HumanChip tone={b.engagement_count ? "ok" : "neutral"}>
                    {b.engagement_count ?? 0} engagement
                    {b.engagement_count === 1 ? "" : "s"}
                  </HumanChip>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </HumanSectionShell>
  );
}
