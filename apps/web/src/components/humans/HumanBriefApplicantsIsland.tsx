"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { HumanSectionShell } from "./HumanSectionShell";
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
import { RepostBriefButton } from "./RepostBriefButton";
import {
  bookableLine,
  closedReasonLine,
  runningTotalLine,
  shortDate,
  usd,
  type ApplicantView,
  type BriefApplicantsResponse,
} from "./humanPostedBriefs";

export function HumanBriefApplicantsIsland({ briefId }: { briefId: string }) {
  const path = `/api/humans/briefs/${encodeURIComponent(briefId)}/applicants`;
  const { data, loading, error, sessionExpired, notBuilt, reload } =
    useHumanResource<BriefApplicantsResponse>(path);

  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const hire = useCallback(
    async (application_id: string) => {
      setBusy(application_id);
      setProblem(null);
      setNote(null);
      try {
        const res = await apiFetch(`/api/humans/briefs/${encodeURIComponent(briefId)}/hire`, {
          method: "POST",
          body: JSON.stringify({ application_id }),
        });
        const body = (await res.json().catch(() => null)) as {
          checkout_url?: string | null;
          what_happens_next?: string;
          error?: { message?: string };
        } | null;
        if (!res.ok) {
          setProblem(body?.error?.message ?? `Could not hire (HTTP ${res.status}).`);
          return;
        }
        if (body?.checkout_url) {
          window.location.href = body.checkout_url;
          return;
        }
        setProblem(
          "Zavi could not open the payment step. Nothing was charged and nobody was told. Try again in a moment.",
        );
      } catch (e) {
        setProblem((e as Error).message ?? "Network error");
      } finally {
        setBusy(null);
      }
    },
    [briefId],
  );

  const closeBrief = useCallback(async () => {
    setBusy("close");
    setProblem(null);
    setNote(null);
    try {
      const res = await apiFetch(`/api/humans/briefs/${encodeURIComponent(briefId)}/close`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => null)) as {
        declined?: number;
        undo_message?: string;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        setProblem(body?.error?.message ?? `Could not close the brief (HTTP ${res.status}).`);
        return;
      }
      setNote(body?.undo_message ?? "The brief is closed.");
      reload();
    } catch (e) {
      setProblem((e as Error).message ?? "Network error");
    } finally {
      setBusy(null);
    }
  }, [briefId, reload]);

  return (
    <HumanSectionShell
      title={data?.brief.title || "Applicants"}
      lede="Creators apply with their own price. Hiring charges your card at once and starts the job, and everyone else gets your note."
      breadcrumb={[
        { label: "Briefs", href: "/humans" },
        { label: data?.brief.title || briefId },
      ]}
      actions={
        data?.brief.posted_at ? (
          <RepostBriefButton briefId={briefId} />
        ) : (
          <Link
            href={`/humans/briefs/${encodeURIComponent(briefId)}/post`}
            className="inline-flex items-center rounded-full border border-ink/15 px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
          >
            Edit the brief
          </Link>
        )
      }
    >
      {sessionExpired ? (
        <HumanSessionExpired next={`/humans/briefs/${briefId}/applicants`} />
      ) : notBuilt ? (
        <HumanNotBuilt what="This brief" />
      ) : loading && !data ? (
        <HumanSkeleton />
      ) : error && !data ? (
        <HumanError message={error} onRetry={reload} />
      ) : !data ? (
        <HumanNotBuilt what="This brief" />
      ) : (
        <div className="space-y-6">
          {problem ? (
            <p className="rounded-xl border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-[13px] text-ink">
              {problem}
            </p>
          ) : null}
          {note ? (
            <p className="rounded-xl border border-ink/15 bg-ink/[0.03] px-4 py-3 text-[13px] text-ink">
              {note}
            </p>
          ) : null}

          <HumanCard>
            <div className="flex flex-wrap items-center gap-2">
              <HumanChip tone={data.brief.open ? "ok" : "warn"}>
                {data.brief.open ? "Open for applications" : "Closed to new applications"}
              </HumanChip>
              <span className="text-[13px] text-ink">{data.spots_line}</span>
            </div>
            <p className="mt-2.5 max-w-[72ch] text-[13px] leading-[1.55] text-inkMuted">
              {data.answer_by_line}
            </p>
            {closedReasonLine(data.brief) ? (
              <p className="mt-2 text-[12px] text-inkMuted">{closedReasonLine(data.brief)}</p>
            ) : null}
            <p className="mt-3 text-[12px] text-inkMuted">{data.order}</p>
          </HumanCard>

          {data.applicants.length === 0 ? (
            <HumanEmpty
              title="Nobody has applied yet"
              body={`This is a real zero, not a loading state. Every approved creator in the lane can see the brief on the open board, and you told them you would answer by ${shortDate(
                data.brief.answer_by,
              )}.`}
              action={
                data.brief.posted_at ? (
                  <RepostBriefButton briefId={briefId} />
                ) : (
                  <Link
                    href={`/humans/briefs/${encodeURIComponent(briefId)}/post`}
                    className="inline-flex items-center justify-center rounded-full border border-ink/15 px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
                  >
                    Edit the brief
                  </Link>
                )
              }
            />
          ) : (
            <ul className="space-y-3">
              {data.applicants.map((a) => (
                <li key={a.application_id}>
                  <Applicant
                    applicant={a}
                    briefOpen={data.brief.open}
                    busy={busy === a.application_id}
                    disabled={busy !== null}
                    onHire={() => void hire(a.application_id)}
                  />
                </li>
              ))}
            </ul>
          )}

          {data.brief.open && data.applicants.some((a) => a.status === "applied") ? (
            <HumanCard>
              <p className="max-w-[72ch] text-[13px] leading-[1.55] text-ink">
                Not hiring anybody from this brief? You can answer everyone now instead of waiting for{" "}
                {shortDate(data.brief.answer_by)}.
              </p>
              <p className="mt-2 text-[12px] text-inkMuted">
                Your note goes to everyone still waiting and the brief closes. Notes cannot be taken back.
              </p>
              <button
                type="button"
                onClick={() => void closeBrief()}
                disabled={busy !== null}
                className="mt-4 rounded-full border border-ink/15 px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink/[0.04] disabled:opacity-50"
              >
                {busy === "close" ? "Sending" : "Answer everyone and close"}
              </button>
            </HumanCard>
          ) : null}
        </div>
      )}
    </HumanSectionShell>
  );
}

function Applicant({
  applicant,
  briefOpen,
  busy,
  disabled,
  onHire,
}: {
  applicant: ApplicantView;
  briefOpen: boolean;
  busy: boolean;
  disabled: boolean;
  onHire: () => void;
}) {
  const a = applicant;
  const hireable = a.status === "applied" || a.status === "shortlisted";
  const blocked = bookableLine(a);
  return (
    <HumanCard>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[16px] font-semibold text-ink">{a.display_name || "A Zavi creator"}</p>
          <p className="mt-0.5 text-[12px] text-inkMuted">
            {[a.city, a.country_code].filter(Boolean).join(", ") || "Location not given"} · applied{" "}
            {shortDate(a.applied_at)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold tabular-nums text-ink">
            {a.fees ? usd(a.fees.price_cents) : "no price"}
          </span>
          <HumanChip
            tone={a.status === "approved" ? "ok" : a.status === "rejected" ? "bad" : "warn"}
          >
            {a.status === "approved" ? "hired" : a.status}
          </HumanChip>
        </div>
      </div>

      {a.note ? (
        <p className="mt-3 max-w-[70ch] whitespace-pre-line text-[13px] leading-[1.55] text-inkMuted">
          {a.note}
        </p>
      ) : (
        <p className="mt-3 text-[13px] text-inkMuted">They did not leave a note.</p>
      )}

      <div className="mt-4 rounded-xl border border-ink/10 bg-ink/[0.02] px-3.5 py-3">
        <p className="text-[13px] font-medium text-ink">{runningTotalLine(a.fees)}</p>
      </div>

      {blocked ? <p className="mt-3 text-[12px] text-inkMuted">{blocked}</p> : null}

      {hireable ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={onHire}
            disabled={disabled || !a.bookable || !a.fees || !briefOpen}
            className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-cream hover:bg-ink/90 disabled:opacity-50"
          >
            {busy ? "Opening payment" : `Hire for ${a.fees ? usd(a.fees.business_total_cents) : "no price"}`}
          </button>
          <p className="mt-2 max-w-[70ch] text-[12px] text-inkMuted">
            Your card is held now and charged as soon as the hold is confirmed. The job starts straight away and
            everyone else who applied gets your note. There is no undo once the notes go out.
          </p>
        </div>
      ) : null}
    </HumanCard>
  );
}
