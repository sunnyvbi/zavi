"use client";

import { channelForBriefKind } from "@zavi/shared";
import Link from "next/link";
import { HumanSectionShell, HumanViewTabs } from "./HumanSectionShell";
import {
  HumanCard,
  HumanChip,
  HumanEmpty,
  HumanError,
  HumanNotBuilt,
  HumanSessionExpired,
  HumanSkeleton,
} from "./HumanStates";
import { useHumanResource } from "./useHumanResource";
import type { HumanBriefDetailResponse } from "./humanTypes";

export type BriefView = "matches" | "applications";

export function HumanBriefDetailIsland({
  briefId,
  view,
}: {
  briefId: string;
  view: BriefView;
}) {
  const { data, loading, error, sessionExpired, notBuilt, reload } =
    useHumanResource<HumanBriefDetailResponse>(
      `/api/humans/briefs/${encodeURIComponent(briefId)}`,
    );

  const base = `/humans/briefs/${encodeURIComponent(briefId)}`;
  const here = `${base}/${view}`;

  return (
    <HumanSectionShell
      title={data?.brief.title || "Brief"}
      lede={
        data?.brief.utm_campaign
          ? `Every asset shipped against this brief carries ${data.brief.utm_campaign}. That tag is what makes the receipt attributable: one human asset per ad, dynamic creative off.`
          : "Human members matched to this brief, and the applications they've sent you."
      }
      breadcrumb={[
        { label: "Briefs", href: "/humans" },
        { label: data?.brief.title || briefId },
      ]}
      actions={
        <Link
          href={`/humans/creators?brief_id=${encodeURIComponent(briefId)}`}
          className="inline-flex items-center rounded-full border border-ink/15 bg-white px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
        >
          Book a creator for this
        </Link>
      }
    >
      <HumanViewTabs
        active={here}
        tabs={[
          {
            href: `${base}/matches`,
            label: "Matches",
            count: data?.matches.length ?? null,
          },
          {
            href: `${base}/applications`,
            label: "Applications",
            count: data?.applications.length ?? null,
          },
        ]}
      />

      <div className="mt-6">
        {sessionExpired ? (
          <HumanSessionExpired next={here} />
        ) : notBuilt ? (
          <HumanNotBuilt what="This brief" />
        ) : loading && !data ? (
          <HumanSkeleton />
        ) : error ? (
          <HumanError message={error} onRetry={reload} />
        ) : !data ? (
          <HumanNotBuilt what="This brief" />
        ) : view === "matches" ? (
          <MatchList data={data} />
        ) : (
          <ApplicationList data={data} />
        )}
      </div>
    </HumanSectionShell>
  );
}

function MatchList({ data }: { data: HumanBriefDetailResponse }) {
  if (data.matches.length === 0) {
    return (
      <HumanEmpty
        title="No human members match this brief yet"
        body="Matching is on the niches and rate the brief asks for. The human is being built one vetted person at a time, so a zero here means nobody on the roster fits yet, not that matching failed."
      />
    );
  }
  return (
    <>
      {}
      <p className="mb-3 text-[12px] leading-[1.5] text-inkMuted">
        Newest first. Zavi does not rank creators and does not pick one for you.
        Everyone who matches the niches and rate this brief asks for is shown.
      </p>
      <ul className="space-y-3">
        {data.matches.map((m) => (
        <li key={m.member_id}>
          <HumanCard>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[16px] font-semibold text-ink">
                  @{m.handle}
                </p>
                <p className="mt-0.5 text-[12px] text-inkMuted">
                  {m.platform} · {m.discipline.replace(/_/g, " ")}
                </p>
              </div>
              <p className="shrink-0 text-[13px] font-semibold tabular-nums text-ink">
                {m.rate_usd != null ? `$${m.rate_usd}` : "-"}
                <span className="ml-1 text-[12px] font-normal text-inkMuted">
                  {m.rate_unit === "per_hour"
                    ? "per hour"
                    : m.rate_unit === "per_month"
                      ? "per month"
                      : "per deliverable"}
                </span>
              </p>
            </div>
            {m.skills.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {m.skills.map((s) => (
                  <HumanChip key={s}>{s}</HumanChip>
                ))}
              </div>
            ) : null}
          </HumanCard>
        </li>
        ))}
      </ul>
    </>
  );
}

const HUMAN_REVIEW_HREF = `/workspace?tab=channels&channel=${channelForBriefKind("creative")?.slug ?? "ugc"}`;

function ApplicationList({ data }: { data: HumanBriefDetailResponse }) {
  if (data.applications.length === 0) {
    return (
      <HumanEmpty
        title="No applications yet"
        body="Matched human members apply to a brief with a pitch and a quoted rate. Nothing is assigned automatically. You approve each one, and that approval waits on the UGC channel."
        action={
          <Link
            href={HUMAN_REVIEW_HREF}
            className="inline-flex items-center justify-center rounded-full border border-ink/15 px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
          >
            Open UGC
          </Link>
        }
      />
    );
  }
  return (
    <ul className="space-y-3">
      {data.applications.map((a) => (
        <li key={a.id}>
          <HumanCard>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[16px] font-semibold text-ink">@{a.handle}</p>
                <p className="mt-0.5 text-[12px] text-inkMuted">{a.platform}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold tabular-nums text-ink">
                  {a.quoted_rate_usd != null ? `$${a.quoted_rate_usd}` : "-"}
                </span>
                <HumanChip
                  tone={
                    a.status === "approved"
                      ? "ok"
                      : a.status === "rejected"
                        ? "bad"
                        : "warn"
                  }
                >
                  {a.status}
                </HumanChip>
              </div>
            </div>
            {a.pitch ? (
              <p className="mt-3 max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
                {a.pitch}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {a.engagement_id ? (
                <Link
                  href={`/humans/engagements/${encodeURIComponent(a.engagement_id)}`}
                  className="rounded-full border border-transparent bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-cream hover:bg-ink/90"
                >
                  Open engagement
                </Link>
              ) : (
                <>
                  {}
                  <Link
                    href={`/humans/book?application_id=${encodeURIComponent(a.id)}`}
                    className="rounded-full border border-transparent bg-ink px-3.5 py-1.5 text-[13px] font-semibold text-cream hover:bg-ink/90"
                  >
                    Hire and pay
                  </Link>
                  {}
                  <Link
                    href={HUMAN_REVIEW_HREF}
                    className="rounded-full border border-ink/15 px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
                  >
                    Decide in UGC
                  </Link>
                </>
              )}
            </div>
          </HumanCard>
        </li>
      ))}
    </ul>
  );
}
