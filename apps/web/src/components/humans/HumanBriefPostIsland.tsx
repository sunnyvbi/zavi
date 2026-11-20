"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { HumanSectionShell } from "./HumanSectionShell";
import {
  HumanCard,
  HumanChip,
  HumanError,
  HumanNotBuilt,
  HumanSectionHeading,
  HumanSessionExpired,
  HumanSkeleton,
} from "./HumanStates";
import { useHumanResource } from "./useHumanResource";
import { RepostBriefButton } from "./RepostBriefButton";
import {
  closedReasonLine,
  shortDate,
  type BriefWorkbenchResponse,
} from "./humanPostedBriefs";

type Form = {
  title: string;
  angle: string;
  hook: string;
  format: string;
  deliverables: string;
  budget_usd: string;
  delivery_days: string;
  applicant_cap: string;
  answer_by: string;
  decline_note: string;
  niches: string;
  platforms: string;
  locations: string;
};

function formFrom(d: BriefWorkbenchResponse): Form {
  const f = d.brief.filters ?? {};
  return {
    title: d.brief.title ?? "",
    angle: d.brief.angle ?? "",
    hook: d.brief.hook ?? "",
    format: d.brief.format ?? "",
    deliverables: d.brief.deliverables === null ? "" : String(d.brief.deliverables),
    budget_usd: d.brief.budget_usd === null ? "" : String(d.brief.budget_usd),
    delivery_days: d.brief.delivery_days === null ? "" : String(d.brief.delivery_days),
    applicant_cap: d.brief.applicant_cap === null ? "" : String(d.brief.applicant_cap),
    answer_by: d.brief.answer_by ? shortDate(d.brief.answer_by) : "",
    decline_note: d.decline_note,
    niches: (f.niches ?? []).join(", "),
    platforms: (f.platforms ?? []).join(", "),
    locations: (f.locations ?? []).join(", "),
  };
}

function list(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function HumanBriefPostIsland({ briefId }: { briefId: string }) {
  const path = `/api/humans/briefs/${encodeURIComponent(briefId)}/workbench`;
  const { data, loading, error, sessionExpired, notBuilt, reload } =
    useHumanResource<BriefWorkbenchResponse>(path);

  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState<BriefWorkbenchResponse | null>(null);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (data && !form) setForm(formFrom(data));
    if (data) setSaved(data);
  }, [data, form]);

  const view = saved ?? data;

  const send = useCallback(
    async (kind: "save" | "publish") => {
      if (!form) return;
      if (view?.creator_preview.posted_at) return;
      setBusy(kind);
      setProblem(null);
      setNote(null);
      try {
        const patch = await apiFetch(`/api/humans/briefs/${encodeURIComponent(briefId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            title: form.title,
            angle: form.angle,
            hook: form.hook,
            format: form.format,
            deliverables: form.deliverables === "" ? null : Number(form.deliverables),
            budget_usd: form.budget_usd === "" ? null : Number(form.budget_usd),
            lane: "ugc_video",
            delivery_days: form.delivery_days === "" ? null : Number(form.delivery_days),
            applicant_cap: form.applicant_cap === "" ? null : Number(form.applicant_cap),
            answer_by: form.answer_by === "" ? null : new Date(`${form.answer_by}T00:00:00.000Z`).toISOString(),
            decline_note: form.decline_note.trim() === "" ? null : form.decline_note,
            filters: {
              niches: list(form.niches),
              platforms: list(form.platforms),
              locations: list(form.locations),
            },
          }),
        });
        const patchBody = (await patch.json().catch(() => null)) as
          | (BriefWorkbenchResponse & { error?: { message?: string } })
          | null;
        if (!patch.ok) {
          setProblem(patchBody?.error?.message ?? `Could not save (HTTP ${patch.status}).`);
          return;
        }
        if (patchBody) setSaved(patchBody);
        if (kind === "save") {
          setNote("Saved. The panel below is what creators see, read back from the saved brief.");
          return;
        }

        const pub = await apiFetch(`/api/humans/briefs/${encodeURIComponent(briefId)}/publish`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        const pubBody = (await pub.json().catch(() => null)) as
          | (BriefWorkbenchResponse & {
              first_publish?: boolean;
              fit_alerts?: { matched: number; alerted: number };
              error?: { message?: string };
            })
          | null;
        if (!pub.ok) {
          setProblem(pubBody?.error?.message ?? `Could not post the brief (HTTP ${pub.status}).`);
          return;
        }
        if (pubBody?.brief) setSaved(pubBody);
        const alerted = pubBody?.fit_alerts?.alerted ?? 0;
        setNote(
          pubBody?.first_publish === false
            ? "This brief was already on the board, so nothing changed and nobody was alerted twice."
            : alerted > 0
              ? `Posted. ${alerted} creators who match your filters were alerted. Every approved creator in the lane can see it on the open board.`
              : "Posted. Every approved creator in the lane can see it on the open board. Nobody matched your alert filters, so no alerts went out.",
        );
      } catch (e) {
        setProblem((e as Error).message ?? "Network error");
      } finally {
        setBusy(null);
      }
    },
    [briefId, form, view],
  );

  return (
    <HumanSectionShell
      title={view?.brief.title || "Post a brief"}
      lede="Zavi's agent drafted this. Every field is yours to change, and whatever you save is exactly what creators read. Creators quote their own price."
      breadcrumb={[
        { label: "Briefs", href: "/humans" },
        { label: view?.brief.title || briefId, href: `/humans/briefs/${briefId}/applicants` },
        { label: "Post" },
      ]}
    >
      {sessionExpired ? (
        <HumanSessionExpired next={`/humans/briefs/${briefId}/post`} />
      ) : notBuilt ? (
        <HumanNotBuilt what="This brief" />
      ) : loading && !view ? (
        <HumanSkeleton />
      ) : error && !view ? (
        <HumanError message={error} onRetry={reload} />
      ) : !view || !form ? (
        <HumanNotBuilt what="This brief" />
      ) : (
        <div className="space-y-8">
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

          <section>
            <HumanSectionHeading>The brief</HumanSectionHeading>
            <HumanCard>
              <div className="space-y-4">
                <Field label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} />
                <Field
                  label="Angle"
                  value={form.angle}
                  rows={3}
                  onChange={(v) => setForm({ ...form, angle: v })}
                />
                <Field label="Hook" value={form.hook} rows={2} onChange={(v) => setForm({ ...form, hook: v })} />
                <Field label="Format" value={form.format} onChange={(v) => setForm({ ...form, format: v })} />
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field
                    label="Deliverables"
                    value={form.deliverables}
                    onChange={(v) => setForm({ ...form, deliverables: v })}
                  />
                  <Field
                    label="Budget in dollars"
                    value={form.budget_usd}
                    hint="A guide for creators. They quote their own price."
                    onChange={(v) => setForm({ ...form, budget_usd: v })}
                  />
                  <Field
                    label="Days to deliver"
                    value={form.delivery_days}
                    onChange={(v) => setForm({ ...form, delivery_days: v })}
                  />
                </div>
              </div>
            </HumanCard>
          </section>

          <section>
            <HumanSectionHeading>Who gets alerted</HumanSectionHeading>
            <HumanCard>
              <p className="mb-4 max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
                These only decide who gets a nudge. Everyone approved in the lane can see the brief and apply
                either way, so a narrow filter costs you reach and never blocks anybody.
              </p>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field
                  label="Niches"
                  value={form.niches}
                  hint="Comma separated"
                  onChange={(v) => setForm({ ...form, niches: v })}
                />
                <Field
                  label="Platforms"
                  value={form.platforms}
                  hint="Comma separated"
                  onChange={(v) => setForm({ ...form, platforms: v })}
                />
                <Field
                  label="Locations"
                  value={form.locations}
                  hint="City, or a two letter country code"
                  onChange={(v) => setForm({ ...form, locations: v })}
                />
              </div>
            </HumanCard>
          </section>

          <section>
            <HumanSectionHeading>Answering applicants</HumanSectionHeading>
            <HumanCard>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Answer everyone by"
                  value={form.answer_by}
                  hint="YYYY-MM-DD. Leave blank for 5 days from posting."
                  onChange={(v) => setForm({ ...form, answer_by: v })}
                />
                <Field
                  label="Application limit"
                  value={form.applicant_cap}
                  hint="The brief closes at this many. Leave blank for 20."
                  onChange={(v) => setForm({ ...form, applicant_cap: v })}
                />
              </div>
              <div className="mt-4">
                <Field
                  label="The note everyone who is not hired gets"
                  value={form.decline_note}
                  rows={3}
                  hint="Sent when you hire, or when the answer-by date passes. It cannot be taken back."
                  onChange={(v) => setForm({ ...form, decline_note: v })}
                />
                {view.decline_note_is_default ? (
                  <p className="mt-2 text-[12px] text-inkMuted">
                    This is the default wording. It does not claim you watched anyone&apos;s intro, because
                    that may not be true. Change it to whatever is.
                  </p>
                ) : null}
              </div>
              <p className="mt-4 text-[12px] text-inkMuted">{view.answer_by_line}</p>
            </HumanCard>
          </section>

          <section>
            <HumanSectionHeading>What creators see</HumanSectionHeading>
            <HumanCard>
              <p className="mb-4 max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
                Read back from the saved brief, not from the form above. If an edit is missing here, it did not
                save. Your reason for the brief and your campaign tag are never part of this.
              </p>
              <dl className="space-y-2.5 text-[13px]">
                <Row label="Business">{view.creator_preview.business_name}</Row>
                <Row label="Title">{view.creator_preview.title}</Row>
                <Row label="Angle">{view.creator_preview.angle}</Row>
                <Row label="Hook">{view.creator_preview.hook}</Row>
                <Row label="Format">{view.creator_preview.format}</Row>
                <Row label="Deliverables">{view.creator_preview.deliverables ?? "not set"}</Row>
                <Row label="Budget">
                  {view.creator_preview.budget_usd === null ? "not shown" : `$${view.creator_preview.budget_usd}`}
                </Row>
                <Row label="Days to deliver">{view.creator_preview.delivery_days ?? "not set"}</Row>
                <Row label="Answer by">{shortDate(view.creator_preview.answer_by)}</Row>
                <Row label="Places">{view.spots_line}</Row>
              </dl>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <HumanChip tone={view.creator_preview.open ? "ok" : "warn"}>
                  {view.creator_preview.posted_at
                    ? view.creator_preview.open
                      ? "On the open board"
                      : "Closed to new applications"
                    : "Not posted yet"}
                </HumanChip>
                <span className="text-[12px] text-inkMuted">{view.order_line}</span>
              </div>
              {closedReasonLine(view.creator_preview) ? (
                <p className="mt-3 text-[12px] text-inkMuted">{closedReasonLine(view.creator_preview)}</p>
              ) : null}
            </HumanCard>
          </section>

          {view.brief.rationale ? (
            <section>
              <HumanSectionHeading>Why Zavi drafted this</HumanSectionHeading>
              <HumanCard>
                <p className="max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">{view.brief.rationale}</p>
                <p className="mt-3 text-[12px] text-inkMuted">
                  Yours only. This and your campaign tag never reach a creator.
                </p>
              </HumanCard>
            </section>
          ) : null}

          {view.creator_preview.posted_at ? (
          <div className="space-y-2">
            <p className="max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
              This brief is posted, so it is locked: creators applied to these words. To change it,
              close it and repost an editable copy.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <RepostBriefButton briefId={briefId} />
              <Link
                href={`/humans/briefs/${encodeURIComponent(briefId)}/applicants`}
                className="text-[13px] text-inkMuted underline hover:text-ink"
              >
                See applicants
              </Link>
            </div>
          </div>
          ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void send("save")}
              disabled={busy !== null}
              className="rounded-full border border-ink/15 px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink/[0.04] disabled:opacity-50"
            >
              {busy === "save" ? "Saving" : "Save"}
            </button>
            {confirming && (
              <>
                <span className="text-[13px] font-semibold text-ink">Publish for good? You can&apos;t edit it after.</span>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy !== null}
                  className="rounded-full border border-ink/15 px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink/[0.04] disabled:opacity-50"
                >
                  Not yet
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => {
                if (!confirming) return setConfirming(true);
                setConfirming(false);
                void send("publish");
              }}
              disabled={busy !== null}
              className="rounded-full border border-transparent bg-ink px-4 py-2 text-[13px] font-semibold text-cream hover:bg-ink/90 disabled:opacity-50"
            >
              {busy === "publish"
                ? "Posting"
                : confirming
                  ? "Yes, post it"
                  : view.creator_preview.posted_at
                    ? "Save and keep it posted"
                    : "Save and post to the board"}
            </button>
            <Link
              href={`/humans/briefs/${encodeURIComponent(briefId)}/applicants`}
              className="text-[13px] text-inkMuted underline hover:text-ink"
            >
              See applicants
            </Link>
          </div>
          )}
        </div>
      )}
    </HumanSectionShell>
  );
}

function Field({
  label,
  value,
  onChange,
  rows,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-[14px] font-medium text-ink">{label}</span>
      {rows && rows > 1 ? (
        <textarea
          value={value}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-[16px] leading-[1.5] text-ink"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-ink/15 bg-cream px-3 py-2 text-[16px] text-ink"
        />
      )}
      {hint ? <span className="mt-1 block text-[12px] text-inkMuted">{hint}</span> : null}
    </label>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-3">
      <dt className="w-[120px] shrink-0 text-inkMuted">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink">{children}</dd>
    </div>
  );
}
