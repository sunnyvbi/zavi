"use client";

import { InlineConfirm } from "./InlineConfirm";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { CreatorMoneyLines, formatCents } from "./creatorMoney";
import { CreatorReceipt } from "./CreatorReceipt";
import { JOB_STATUS_LABEL } from "./HumanJobsIsland";
import { submissionPreviewNote } from "./creatorJobTypes";
import type {
  BusinessAction,
  CreatorActionResult,
  CreatorFulfilResult,
  CreatorJobActionOption,
  CreatorJobDetail,
  CreatorJobSubmission,
} from "./creatorJobTypes";

const POLL_MS = 2500;
const MAX_POLLS = 12;

export function HumanJobDetailIsland({
  orderId,
  justPaid = false,
}: {
  orderId: string;
  justPaid?: boolean;
}) {
  const path = `/api/humans/orders/${encodeURIComponent(orderId)}`;
  const { data, loading, error, sessionExpired, notBuilt, reload } =
    useHumanResource<CreatorJobDetail>(path);
  const [detail, setDetail] = useState<CreatorJobDetail | null>(null);
  const [fulfil, setFulfil] = useState<CreatorFulfilResult | null>(null);

  useEffect(() => {
    if (data) setDetail(data);
  }, [data]);

  const view = detail ?? data;
  const here = `/humans/jobs/${encodeURIComponent(orderId)}`;

  return (
    <HumanSectionShell
      title={view?.job.title || "Job"}
      lede={
        view
          ? `${view.job.creator_display_name ?? "This creator"} and your business, on one job. Zavi holds your payment until you approve the work.`
          : "One creator job: the work, the deadline, and what happens to your money."
      }
      breadcrumb={[{ label: "Jobs", href: "/humans/jobs" }, { label: view?.job.title ?? orderId }]}
    >
      {sessionExpired ? (
        <HumanSessionExpired next={here} />
      ) : notBuilt ? (
        <HumanNotBuilt what="This job" />
      ) : loading && !view ? (
        <HumanSkeleton rows={2} />
      ) : error ? (
        <HumanError message={error} onRetry={reload} />
      ) : !view ? (
        <HumanNotBuilt what="This job" />
      ) : (
        <div className="space-y-4">
          {justPaid ? (
            <PaymentReturn
              orderId={orderId}
              status={view.job.status}
              source={view.job.source}
              onSettled={(r) => {
                setFulfil(r);
                reload();
              }}
              result={fulfil}
            />
          ) : null}

          <Summary detail={view} />
          {view.receipt ? <CreatorReceipt receipt={view.receipt} orderId={view.job.id} /> : null}
          <Submissions submissions={view.submissions} />
          <Extension detail={view} />
          <Dispute detail={view} />
          <Thread detail={view} />
          <MessageCreator detail={view} />
          <Rebook detail={view} />
          <Actions
            orderId={orderId}
            actions={view.actions}
            approveConfirm={`Approving releases the agreed ${formatCents(view.job.money.price_cents, view.job.money.currency)} price to ${
              view.job.creator_display_name || "the creator"
            }. The job closes and this cannot be undone.`}
            quietWhenEmpty={view.rebook !== null}
            onDone={(next) => {
              if (next) setDetail(next);
              else reload();
            }}
          />
        </div>
      )}
    </HumanSectionShell>
  );
}

export function PaymentReturn({
  orderId,
  status,
  source,
  onSettled,
  result,
}: {
  orderId: string;
  status: string;
  source: CreatorJobDetail["job"]["source"];
  onSettled: (r: CreatorFulfilResult) => void;
  result: CreatorFulfilResult | null;
}) {
  const [polls, setPolls] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    if (status !== "checkout_pending") {
      done.current = true;
      return;
    }
    if (polls >= MAX_POLLS) return;
    const t = setTimeout(
      () => {
        void (async () => {
          try {
            const res = await apiFetch(
              `/api/humans/orders/${encodeURIComponent(orderId)}/fulfil`,
              { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
            );
            if (res.ok) {
              const body = (await res.json()) as CreatorFulfilResult;
              if (body.state !== "pending") {
                done.current = true;
                onSettled(body);
                return;
              }
            }
          } catch {
          }
          setPolls((n) => n + 1);
        })();
      },
      polls === 0 ? 0 : POLL_MS,
    );
    return () => clearTimeout(t);
  }, [polls, orderId, status, onSettled]);

  if (result?.state === "cancelled") {
    return (
      <Notice tone="bad" title="This job was cancelled">
        {result.message}
      </Notice>
    );
  }
  if (result?.state === "needs_staff") {
    return (
      <Notice tone="bad" title="Zavi staff have to look at this">
        {result.message}
      </Notice>
    );
  }
  if (result?.state === "already_done" && result.status === "cancelled") {
    return (
      <Notice tone="bad" title="This job was cancelled">
        This job was cancelled before it started, so your card was not charged.
      </Notice>
    );
  }
  if (result?.state === "fulfilled" || result?.state === "already_done") {
    if ((source === "offer" || source === "applicant") && result.status !== "awaiting_acceptance") {
      return (
        <Notice tone="ok" title="Paid. The job has started">
          Your card has been charged and the job is in progress. Zavi holds the money and pays the
          creator only when you approve the work.
        </Notice>
      );
    }
    return (
      <Notice tone="ok" title="Payment is held">
        Your card is held, not charged. The creator has 72 hours to accept. Zavi takes the money
        only when they accept, and pays it out only when you approve the work.
      </Notice>
    );
  }
  if (status !== "checkout_pending") return null;
  if (polls >= MAX_POLLS) {
    return (
      <Notice tone="warn" title="Still waiting on your bank">
        The hold has not come back from your bank yet. Nothing is lost: this page updates on its
        own once it lands, and Zavi is also told directly by Stripe.
      </Notice>
    );
  }
  return (
    <Notice tone="info" title="Confirming the hold on your card">
      This takes a few seconds. Do not pay again.
    </Notice>
  );
}

function Summary({ detail }: { detail: CreatorJobDetail }) {
  const j = detail.job;
  return (
    <HumanCard>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[16px] font-semibold text-ink">
            {j.creator_display_name || "Creator"}
          </p>
          <p className="mt-0.5 text-[12px] text-inkMuted">
            {j.source === "applicant"
              ? "Hired from a brief"
              : j.source === "offer"
                ? "Custom offer"
                : "Booked package"}
            {j.due_at
              ? ` · delivery agreed for ${j.deadline?.kind === "due" ? j.deadline.deadline_text : new Date(j.due_at).toISOString().slice(0, 10)}`
              : j.due_after_accept
                ? ` · due ${j.due_after_accept}`
                : ""}
          </p>
        </div>
        <HumanChip tone={j.status === "completed" ? "ok" : "info"}>
          {JOB_STATUS_LABEL[j.status]}
        </HumanChip>
      </div>

      <div className="mt-4 max-w-[46ch]">
        <CreatorMoneyLines money={j.money} creatorName={j.creator_display_name} emphasis={false} />
      </div>

      {j.deadline ? (
        <p className="mt-4 max-w-[74ch] rounded-lg bg-ink/[0.03] px-3.5 py-3 text-[13px] leading-[1.55] text-ink">
          {}
          {j.deadline.line}
        </p>
      ) : null}
    </HumanCard>
  );
}

function Submissions({ submissions }: { submissions: CreatorJobSubmission[] }) {
  if (submissions.length === 0) {
    return (
      <HumanEmpty
        title="Nothing submitted yet"
        body="The creator uploads their work here. You get 72 hours to approve it or ask for a change once it lands."
      />
    );
  }
  return (
    <div className="space-y-3">
      {submissions.map((s) => (
        <HumanCard key={s.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[16px] font-medium text-ink">
              Version {s.version}
              {s.position > 0 ? `, file ${s.position + 1}` : ""}
            </p>
            <HumanChip>{s.kind.replace("_", " ")}</HumanChip>
          </div>
          {s.note ? (
            <p className="mt-2 max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">{s.note}</p>
          ) : null}
          {s.play_url && (s.kind === "video" || s.kind === "raw_footage") ? (
            <video
              className="mt-3 w-full max-w-xl rounded-lg bg-black"
              src={s.play_url}
              controls
              preload="metadata"
              playsInline
            />
          ) : s.play_url && s.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="mt-3 w-full max-w-xl rounded-lg"
              src={s.play_url}
              alt={`Submitted image, version ${s.version}`}
            />
          ) : s.play_url ? (
            <a
              href={s.play_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex rounded-full border border-ink/15 px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
            >
              Open the file
            </a>
          ) : s.preview === "preparing" || s.preview === "failed" || s.preview === "unavailable" ? null : (
            <p className="mt-3 text-[13px] text-inkMuted">
              Zavi could not make a viewing link for this file. Reload the page to try again.
            </p>
          )}
          {submissionPreviewNote(s) ? (
            <p data-testid="preview-note" className="mt-3 max-w-[70ch] rounded-lg bg-amber-500/10 px-3 py-2 text-[13px] leading-[1.55] text-ink">
              {submissionPreviewNote(s)}
            </p>
          ) : null}
          {s.download_url ? (
            <a
              href={s.download_url}
              className="mt-3 inline-flex rounded-full border border-ink/15 px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04]"
            >
              Download the original
            </a>
          ) : null}
        </HumanCard>
      ))}
    </div>
  );
}

function Extension({ detail }: { detail: CreatorJobDetail }) {
  const e = detail.extension;
  if (!e || e.state !== "requested") return null;
  return (
    <Notice tone="warn" title="The creator asked to move the delivery date">
      {e.requested_due_at
        ? `They have asked for ${new Date(e.requested_due_at).toISOString().slice(0, 10)}. The new date only applies if you agree. If you keep the agreed date, nothing changes.`
        : "The new date only applies if you agree. If you keep the agreed date, nothing changes."}
    </Notice>
  );
}

function Dispute({ detail }: { detail: CreatorJobDetail }) {
  const d = detail.dispute;
  if (!d) return null;
  if (d.status === "open") {
    return (
      <Notice tone="warn" title="Zavi is stepping in">
        {d.opened_by === "tenant" ? "You asked" : "The creator asked"} Zavi to step in:{" "}
        {d.reason}. Zavi staff read the order, the thread and everything submitted, then decide:
        pay in full, pay part, or refund. The money waits until they do.
      </Notice>
    );
  }
  const outcome =
    d.outcome === "pay_full"
      ? "Zavi paid the creator in full."
      : d.outcome === "pay_part"
        ? "Zavi paid the creator part of the price and refunded you the rest."
        : "Zavi refunded you in full.";
  return (
    <Notice tone="ok" title="Zavi has decided">
      {outcome}
      {d.resolution_note ? ` ${d.resolution_note}` : ""}
    </Notice>
  );
}

function MessageCreator({ detail }: { detail: CreatorJobDetail }) {
  const memberId = detail.job.human_member_id;
  if (!memberId || !detail.thread.available || !detail.thread.thread_id) return null;
  return (
    <Link
      href={`/workspace?tab=channels&channel=ugc&drawer=thread&creator=${encodeURIComponent(memberId)}`}
      className="inline-flex rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-ink/90"
    >
      Message {detail.job.creator_display_name || "the creator"}
    </Link>
  );
}

function Thread({ detail }: { detail: CreatorJobDetail }) {
  const t = detail.thread;
  if (!t.available) {
    return (
      <Notice tone="info" title="The message thread is not wired up here yet">
        Messages between you and the creator are shipping on a sibling branch. Nothing is lost:
        every note you attach to an action below is delivered to the creator with it.
      </Notice>
    );
  }
  if (t.messages.length === 0) {
    return (
      <HumanEmpty
        title="No messages yet"
        body="Anything you and the creator agree about this job lives here, so Zavi staff can read it if either of you asks them to step in."
      />
    );
  }
  return (
    <HumanCard>
      <p className="text-[13px] font-semibold text-ink">Thread</p>
      <ul className="mt-3 space-y-3">
        {t.messages.map((m) => (
          <li key={m.id}>
            <p className="text-[12px] uppercase tracking-wide text-inkMuted">
              {m.sender_kind === "tenant" ? "You" : m.sender_kind === "creator" ? "Creator" : "Zavi"}
            </p>
            <p className="mt-0.5 max-w-[70ch] text-[13px] leading-[1.55] text-ink">{m.body}</p>
          </li>
        ))}
      </ul>
    </HumanCard>
  );
}

function Rebook({ detail }: { detail: CreatorJobDetail }) {
  const r = detail.rebook;
  if (!r) return null;
  const who = detail.job.creator_display_name || "this creator";
  return (
    <HumanCard>
      <p className="text-[13px] font-semibold text-ink">Book {who} again</p>
      <p className="mt-1.5 max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
        Same package, booked fresh. {r.title} costs{" "}
        {formatCents(r.price_cents, r.currency)} today, plus Zavi&apos;s 10% fee. You pick the
        delivery date and see the full total before anything is held on your card.
      </p>
      <Link
        href={`/humans/book?package_id=${encodeURIComponent(r.package_id)}`}
        className="mt-3 inline-flex rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-ink/90"
      >
        Book this package again
      </Link>
    </HumanCard>
  );
}

function Actions({
  orderId,
  actions,
  quietWhenEmpty = false,
  onDone,
  approveConfirm,
}: {
  orderId: string;
  actions: CreatorJobActionOption[];
  approveConfirm: string;
  quietWhenEmpty?: boolean;
  onDone: (next: CreatorJobDetail | null) => void;
}) {
  const [open, setOpen] = useState<BusinessAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(
    async (action: BusinessAction, body_note: string) => {
      setBusy(true);
      setErr(null);
      try {
        const res = await apiFetch(`/api/humans/orders/${encodeURIComponent(orderId)}/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, note: body_note || undefined }),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setErr(b?.error?.message ?? `HTTP ${res.status}`);
          return;
        }
        const body = (await res.json()) as CreatorActionResult;
        setOpen(null);
        setConfirming(false);
        setNote("");
        onDone(body.detail ?? null);
      } catch (e) {
        setErr((e as Error).message || "Network error");
      } finally {
        setBusy(false);
      }
    },
    [orderId, onDone],
  );

  if (actions.length === 0) {
    if (quietWhenEmpty) return null;
    return (
      <p className="text-[13px] text-inkMuted">
        There is nothing to do on this job right now.{" "}
        <Link href="/humans/jobs" className="underline underline-offset-2 hover:text-ink">
          Back to Jobs
        </Link>
      </p>
    );
  }

  return (
    <HumanCard>
      <p className="text-[13px] font-semibold text-ink">What you can do</p>
      {err ? (
        <p className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[13px] leading-[1.5] text-rose-800">
          {err}
        </p>
      ) : null}
      <ul className="mt-3 space-y-3">
        {actions.map((a) => (
          <li key={a.action} className="rounded-lg border border-ink/[0.08] px-3.5 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">{a.label}</p>
                <p className="mt-1 max-w-[70ch] text-[13px] leading-[1.55] text-inkMuted">
                  {a.consequence}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setErr(null);
                  if (a.wants_note) {
                    setOpen(open === a.action ? null : a.action);
                    return;
                  }
                  if (a.action === "approve") {
                    setConfirming(true);
                    return;
                  }
                  void run(a.action, "");
                }}
                className="shrink-0 rounded-full border border-ink/15 px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04] disabled:opacity-50"
              >
                {a.wants_note ? (open === a.action ? "Close" : a.label) : a.label}
              </button>
            </div>

            {a.action === "approve" && confirming ? (
              <InlineConfirm
                text={approveConfirm}
                confirmLabel={busy ? "Approving" : "Yes, approve and release"}
                busy={busy}
                onCancel={() => setConfirming(false)}
                onConfirm={() => void run("approve", "")}
                primaryClass="rounded-full border border-transparent bg-ink px-4 py-1.5 text-[13px] font-semibold text-cream hover:bg-ink/90 disabled:opacity-50"
                secondaryClass="rounded-full border border-ink/15 px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.04] disabled:opacity-50"
              />
            ) : null}

            {a.wants_note && open === a.action ? (
              <div className="mt-3">
                <label
                  htmlFor={`note-${a.action}`}
                  className="text-[14px] font-medium text-ink"
                >
                  {a.action.startsWith("ask_zavi") ? "Tell Zavi what is wrong" : "Tell the creator why"}
                </label>
                <textarea
                  id={`note-${a.action}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={4000}
                  className="mt-1.5 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-[13px] text-ink"
                  placeholder={
                    a.action.startsWith("ask_zavi")
                      ? "Only Zavi staff read this. The creator does not see it."
                      : "What needs to change, in your own words."
                  }
                />
                <button
                  type="button"
                  disabled={busy || note.trim().length === 0}
                  onClick={() => void run(a.action, note.trim())}
                  className="mt-2 rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-cream hover:bg-ink/90 disabled:opacity-50"
                >
                  {busy ? "Sending" : a.label}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </HumanCard>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "info";
  title: string;
  children: React.ReactNode;
}) {
  const map = {
    ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    bad: "border-rose-200 bg-rose-50 text-rose-900",
    info: "border-sky-200 bg-sky-50 text-sky-900",
  } as const;
  return (
    <div className={`rounded-xl border px-4 py-4 ${map[tone]}`}>
      <p className="text-[16px] font-semibold">{title}</p>
      <p className="mt-1 max-w-[70ch] text-[13px] leading-[1.55]">{children}</p>
    </div>
  );
}
