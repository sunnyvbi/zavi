"use client";

import Link from "next/link";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
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
import { formatCents } from "./creatorMoney";
import type { CreatorJobsResponse, CreatorJobSummary, CreatorOrderStatus } from "./creatorJobTypes";

export const JOB_STATUS_LABEL: Record<CreatorOrderStatus, string> = {
  checkout_pending: "Payment not finished",
  awaiting_acceptance: "Waiting for the creator",
  in_progress: "In progress",
  submitted: "Ready for your review",
  revision_requested: "Changes requested",
  cancel_requested: "Cancellation requested",
  in_dispute: "Zavi is stepping in",
  completed: "Done",
  cancelled: "Cancelled",
};

const TONE: Record<CreatorOrderStatus, "neutral" | "ok" | "warn" | "bad" | "info"> = {
  checkout_pending: "neutral",
  awaiting_acceptance: "info",
  in_progress: "info",
  submitted: "warn",
  revision_requested: "warn",
  cancel_requested: "warn",
  in_dispute: "bad",
  completed: "ok",
  cancelled: "neutral",
};

export function HumanJobsIsland() {
  const { data, loading, error, sessionExpired, notBuilt, reload } =
    useHumanResource<CreatorJobsResponse>("/api/humans/orders");

  return (
    <HumanSectionShell
      title="Jobs"
      lede="Every creator you have booked or hired. Zavi holds your payment until you approve the work, and the same deadline you see here is the one the creator sees."
    >
      <HumanSectionTabs active="/humans/jobs" />

      {sessionExpired ? (
        <HumanSessionExpired next="/humans/jobs" />
      ) : notBuilt ? (
        <HumanNotBuilt what="The Jobs list" />
      ) : loading && !data ? (
        <HumanSkeleton />
      ) : error ? (
        <HumanError message={error} onRetry={reload} />
      ) : (!data || data.jobs.length === 0) && !CREATOR_MARKETPLACE_ENABLED ? (
        <HumanEmpty
          title="No existing jobs"
          body="Creator jobs this workspace already booked appear here until they are finished and settled."
        />
      ) : !data || data.jobs.length === 0 ? (
        <HumanEmpty
          title="No jobs yet"
          body="A job starts when you book a creator's package or hire someone who applied to one of your briefs. Your card is held, not charged, until the creator accepts."
          action={
            <Link
              href="/humans"
              className="inline-flex items-center justify-center rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-cream hover:bg-ink/90"
            >
              Open your briefs
            </Link>
          }
        />
      ) : (
        <ul className="space-y-4">
          {data.jobs.map((j) => (
            <li key={j.id}>
              <JobRow job={j} />
            </li>
          ))}
        </ul>
      )}
    </HumanSectionShell>
  );
}

function JobRow({ job }: { job: CreatorJobSummary }) {
  return (
    <Link
      href={`/humans/jobs/${encodeURIComponent(job.id)}`}
      className="block rounded-xl border border-ink/[0.08] bg-white px-4 py-4 shadow-[0_1px_2px_rgba(25,25,25,0.04)] transition-colors hover:border-ink/20 hover:bg-ink/[0.01]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold leading-[1.4] text-ink">
            {job.title || "Creator job"}
          </p>
          <p className="mt-1 text-[12px] text-inkMuted">
            {job.creator_display_name ? `${job.creator_display_name} · ` : ""}
            {job.source === "applicant"
              ? "Hired from a brief"
              : job.source === "offer"
                ? "Custom offer"
                : "Booked package"}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold tabular-nums text-ink">
            {formatCents(job.money.business_total_cents, job.money.currency)}
          </span>
          <HumanChip tone={TONE[job.status]}>{JOB_STATUS_LABEL[job.status]}</HumanChip>
        </div>
      </div>

      <p className="mt-2 text-[12px] text-inkMuted">
        {formatCents(job.money.price_cents, job.money.currency)} to the creator plus{" "}
        {formatCents(job.money.business_fee_cents, job.money.currency)} Zavi fee (
        {job.money.business_fee_label}).
      </p>

      {}
      {job.deadline ? (
        <p className="mt-3 max-w-[74ch] text-[13px] leading-[1.55] text-inkMuted">
          {job.deadline.line}
        </p>
      ) : null}
    </Link>
  );
}
