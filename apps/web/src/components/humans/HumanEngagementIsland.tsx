"use client";

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
import type { HumanEngagementResponse } from "./humanTypes";

export type EngagementView = "work" | "receipt";

export function HumanEngagementIsland({
  engagementId,
  view,
}: {
  engagementId: string;
  view: EngagementView;
}) {
  const { data, loading, error, sessionExpired, notBuilt, reload } =
    useHumanResource<HumanEngagementResponse>(
      `/api/humans/engagements/${encodeURIComponent(engagementId)}`,
    );

  const base = `/humans/engagements/${encodeURIComponent(engagementId)}`;
  const here = view === "receipt" ? `${base}/receipt` : base;

  return (
    <HumanSectionShell
      title={
        data ? `@${data.engagement.member_handle}` : "Engagement"
      }
      lede={
        data
          ? `Working on “${data.engagement.brief_title}”. Zavi does not hold or route payment in this phase. The human member is invoiced out of band, per engagement.`
          : "An approved human engagement: the work, and the receipt that proves what it did."
      }
      breadcrumb={[
        { label: "Engagements" },
        { label: data?.engagement.member_handle ?? engagementId },
      ]}
    >
      <HumanViewTabs
        active={here}
        tabs={[
          { href: base, label: "Work" },
          { href: `${base}/receipt`, label: "Receipt" },
        ]}
      />

      <div className="mt-6">
        {sessionExpired ? (
          <HumanSessionExpired next={here} />
        ) : notBuilt ? (
          <HumanNotBuilt what="This engagement" />
        ) : loading && !data ? (
          <HumanSkeleton rows={2} />
        ) : error ? (
          <HumanError message={error} onRetry={reload} />
        ) : !data ? (
          <HumanNotBuilt what="This engagement" />
        ) : view === "receipt" ? (
          <Receipt data={data} />
        ) : (
          <Work data={data} />
        )}
      </div>
    </HumanSectionShell>
  );
}

function Work({ data }: { data: HumanEngagementResponse }) {
  const e = data.engagement;
  return (
    <div className="space-y-4">
      <HumanCard>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[16px] font-semibold text-ink">
              @{e.member_handle}
            </p>
            <p className="mt-0.5 text-[12px] text-inkMuted">
              {e.member_platform} ·{" "}
              <Link
                href={`/humans/briefs/${encodeURIComponent(e.brief_id)}/applications`}
                className="underline underline-offset-2 hover:text-ink"
              >
                {e.brief_title}
              </Link>
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold tabular-nums text-ink">
              {e.agreed_rate_usd != null ? `$${e.agreed_rate_usd}` : "-"}
            </span>
            <HumanChip tone={e.status === "delivered" ? "ok" : "info"}>
              {e.status}
            </HumanChip>
          </div>
        </div>
        {e.utm_campaign ? (
          <p className="mt-3 text-[12px] text-inkMuted">
            Assets ship tagged{" "}
            <span className="font-medium text-ink">{e.utm_campaign}</span>. One
            human asset per ad, dynamic creative off. Otherwise the receipt
            can&apos;t tell which asset did the work.
          </p>
        ) : null}
      </HumanCard>

      {data.deliverables.length === 0 ? (
        <HumanEmpty
          title="Nothing delivered yet"
          body="Deliverables appear here as the human member submits them. You accept or send each one back before it goes live in an ad."
        />
      ) : (
        <ul className="space-y-3">
          {data.deliverables.map((d) => (
            <li key={d.id}>
              <HumanCard>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="min-w-0 flex-1 text-[16px] font-medium text-ink">
                    {d.label}
                  </p>
                  <HumanChip
                    tone={
                      d.status === "accepted"
                        ? "ok"
                        : d.status === "rejected"
                          ? "bad"
                          : "warn"
                    }
                  >
                    {d.status}
                  </HumanChip>
                </div>
                {d.asset_url ? (
                  <a
                    href={d.asset_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex rounded-full border border-ink/15 px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
                  >
                    Open asset
                  </a>
                ) : null}
              </HumanCard>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-xl border border-ink/[0.08] bg-cream px-4 py-3.5">
        <p className="text-[13px] font-semibold text-ink">
          Payment happens outside Zavi
        </p>
        <p className="mt-1 max-w-[66ch] text-[13px] leading-[1.55] text-inkMuted">
          There is no payout rail in this phase. Zavi never collects bank or tax
          details from human members, and never moves money between you and
          them. You settle the agreed rate directly.
        </p>
      </div>
    </div>
  );
}

function Receipt({ data }: { data: HumanEngagementResponse }) {
  const r = data.receipt;
  if (!r.available) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
        <p className="text-[16px] font-semibold text-amber-900">
          No verified receipt for this engagement
        </p>
        <p className="mt-1 max-w-[66ch] text-[13px] leading-[1.55] text-amber-800">
          {r.reason ||
            "A verified receipt joins ad spend to bookings in your own database. Zavi can't produce one until your database is connected and reachable."}
        </p>
        <p className="mt-2 max-w-[66ch] text-[13px] leading-[1.55] text-amber-800">
          We show nothing rather than a zero: an unmeasured result and a result
          of zero are not the same claim.
        </p>
        <Link
          href="/workspace?tab=settings"
          className="mt-3 inline-flex rounded-full border border-amber-300 bg-white px-3.5 py-1.5 text-[13px] font-medium text-amber-900 hover:bg-amber-100"
        >
          Connect a database
        </Link>
      </div>
    );
  }

  const stats = [
    { k: "Spend", v: r.spend_usd != null ? `$${r.spend_usd.toFixed(2)}` : "-" },
    {
      k: "Attributed revenue",
      v:
        r.attributed_revenue_usd != null
          ? `$${r.attributed_revenue_usd.toFixed(2)}`
          : "-",
    },
    {
      k: "Attributed conversions",
      v: r.attributed_conversions != null ? String(r.attributed_conversions) : "-",
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {stats.map((s) => (
          <HumanCard key={s.k}>
            <p className="text-[12px] font-medium uppercase tracking-wide text-inkMuted">
              {s.k}
            </p>
            <p className="mt-1.5 text-[20px] font-semibold tabular-nums text-ink">
              {s.v}
            </p>
          </HumanCard>
        ))}
      </div>
      <p className="max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
        Attribution is joined on{" "}
        <span className="font-medium text-ink">
          {data.engagement.utm_campaign ?? "the brief's campaign tag"}
        </span>{" "}
        against bookings in your own database, not on numbers the human member
        reported.
      </p>
    </div>
  );
}
