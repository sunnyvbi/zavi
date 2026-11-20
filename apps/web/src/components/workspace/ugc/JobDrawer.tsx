"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Clock3, Lock, Mail, RotateCcw, Star, type LucideIcon } from "lucide-react";
import { VideoTile } from "../actions/creators/VideoTile";
import { InlineConfirm } from "@/components/humans/InlineConfirm";
import { CreatorReceipt } from "@/components/humans/CreatorReceipt";
import {
  isNeverPaidJob,
  submissionPreviewNote,
  type BusinessAction,
  type CreatorActionResult,
  type CreatorFulfilResult,
  type CreatorJobActionOption,
  type CreatorJobDetail,
} from "@/components/humans/creatorJobTypes";
import { dayTimeUtc, firstName, money, shortDay, useUgcDrawer } from "./hub";
import { Avatar, BTN_PRIMARY, BTN_SECONDARY, CARD, Chip, DrawerNote, FIELD, SideDrawer, Thread, stamp, termsLine, type ThreadItem, type Tone } from "./ui";
import { callJson, useCreatorCards } from "./useCards";
import { PublishCard } from "./PublishCard";

type View = {
  chip: [Tone, string];
  title: string;
  body: string[];
  work: boolean;
  pay?: boolean;
  facts?: { Icon: LucideIcon; text: string; sub?: string }[];
};

const STAGES = ["Booked", "Accepted", "Delivered", "Paid out"] as const;

export function stageOf(
  status: string,
  closed_reason: string | null = null,
  payout_status: string | null = null,
  delivered = false,
): number | null {
  switch (status) {
    case "awaiting_acceptance":
      return 1;
    case "in_dispute":
      return delivered ? 3 : 2;
    case "in_progress":
    case "revision_requested":
    case "cancel_requested":
      return 2;
    case "submitted":
      return 3;
    case "completed":
      if (!isAcceptedJob({ status, closed_reason })) return null;
      return payout_status === "transferred" ? STAGES.length : STAGES.length - 1;
    default:
      return null;
  }
}

const REASON: Record<string, [string, string, string]> = {
  checkout_abandoned: ["Closed, not paid", "The payment was never finished", "Nothing was charged."],
  payment_failed: ["Payment failed, job cancelled", "The charge didn't go through", "The job is cancelled. Nothing was charged."],
  declined: ["Declined, hold released", "passed on this booking", "Nothing was charged and the hold on your card is released."],
  expired: ["No answer, hold released", "didn't answer in 72 hours", "Nothing was charged and the hold on your card is released."],
  withdrawn: ["You cancelled, hold released", "You cancelled before the creator accepted", "Nothing was charged and the hold on your card is released."],
  creator_removed: ["Creator removed, hold released", "is no longer on Zavi", "Nothing was charged and the hold on your card is released."],
  no_show: ["Not delivered, refunded", "didn't deliver in time", "The job is cancelled and your payment is refunded in full."],
  cancel_agreed: ["Cancelled, refunded", "agreed to cancel", "Your payment is refunded in full, including the 10% Zavi fee."],
  cancel_no_response: ["Cancelled, refunded", "didn't answer the cancellation", "72 hours without an answer counts as agreeing. Your payment is refunded in full, including the 10% Zavi fee."],
  mediation_refund: ["Zavi decided: refund", "Zavi decided you are refunded", "Your payment is refunded in full."],
  mediation_pay_full: ["Zavi decided: pay in full", "Zavi decided the creator is paid in full", "Nothing is refunded."],
  mediation_pay_part: ["Zavi decided: pay part", "Zavi decided the creator is paid part", "The rest of your payment is refunded to your card."],
  approved: ["Approved and paid", "You approved the work", ""],
};

const POLL_MS = 2500;
const MAX_POLLS = 12;
export const PREVIEW_POLL_MS = 10_000;
const MAX_PREVIEW_POLLS = 60;

export type PaymentState =
  | "unpaid"
  | "left"
  | "confirming"
  | "slow"
  | { problem: "needs_staff" | "cancelled"; message: string };

export function jobView(d: CreatorJobDetail, payment: PaymentState = "unpaid"): View {
  const j = d.job;
  if (j.status === "completed" && d.dispute?.status === "open") {
    return statusView({ ...d, job: { ...j, status: "in_dispute" } }, payment);
  }
  const v = statusView(d, payment);
  const outcome = d.dispute?.status === "resolved" ? d.dispute.outcome : null;
  if (!outcome || (j.status !== "completed" && j.status !== "cancelled")) return v;
  const n = firstName(j.creator_display_name || "The creator");
  const decided =
    outcome === "refund"
      ? "Zavi decided: your card is refunded in full."
      : outcome === "pay_part"
        ? `Zavi decided: ${n} is paid part, and the rest goes back to your card.`
        : `Zavi decided: ${n} is paid in full.`;
  const note = d.dispute?.resolution_note?.trim();
  return { ...v, chip: ["zinc", "Zavi decided"], title: decided, body: note ? [note, ...v.body] : v.body, facts: undefined };
}

function statusView(d: CreatorJobDetail, payment: PaymentState): View {
  const j = d.job;
  const n = firstName(j.creator_display_name || "The creator");
  const total = money(j.money.business_total_cents);
  const due = shortDay(j.due_at);
  const by = dayTimeUtc(j.deadline?.deadline_at);
  const used = d.revisions?.used ?? 0;
  const left = d.revisions?.left ?? 2;
  const changes = `Changes requested: ${used} of 2, ${left} left`;
  const snapDays = (d.package_snapshot as Record<string, unknown> | null)?.delivery_days;
  const days = typeof snapDays === "number" ? snapDays : null;
  const latest = d.submissions.reduce((m, s) => (s.version > m ? s.version : m), 0);
  const deliveredOn = dayTimeUtc(d.submissions.find((s) => s.version === latest)?.created_at);

  switch (j.status) {
    case "checkout_pending":
      if (typeof payment === "object") {
        return payment.problem === "needs_staff"
          ? { chip: ["red", "Zavi staff are checking this"], title: "Zavi staff have to look at this", body: [payment.message, "Do not pay again."], work: false }
          : { chip: ["red", "Cancelled"], title: "This job was cancelled", body: [payment.message], work: false };
      }
      if (payment === "confirming") {
        return {
          chip: ["amber", "Confirming your payment"],
          title: j.source === "booking" ? "Confirming the hold on your card" : "Confirming your payment",
          body: ["This takes a few seconds. Do not pay again."],
          work: false,
        };
      }
      if (payment === "slow") {
        return {
          chip: ["amber", "Confirming your payment"],
          title: "Still waiting on your bank",
          body: [
            `The ${j.source === "booking" ? "hold" : "payment"} has not come back from your bank yet. Nothing is lost: this updates on its own once it lands, and Zavi is also told directly by Stripe.`,
          ],
          work: false,
        };
      }
      if (j.awaiting_hire_approval) {
        return {
          chip: ["amber", "Waiting for your approval"],
          title: "Approve the hire card to start",
          body: [`Zavi proposed hiring ${n}. Approve or turn it down on its hire card in your channel. Nothing is charged until you approve.`],
          work: false,
        };
      }
      if (j.source !== "offer") {
        return {
          chip: ["amber", "Not paid"],
          title: "Nothing was charged",
          body: [`You left the payment page, so nothing was charged and no job was started. Book or hire ${n} again any time.`],
          work: false,
        };
      }
      if (j.offer_expired) {
        return {
          chip: ["zinc", "Closed, not paid"],
          title: "This offer expired before it was paid",
          body: [`Nothing was charged and no job was started. Send ${n} a new offer to work together.`],
          work: false,
        };
      }
      return {
        chip: ["amber", payment === "left" ? "Not paid" : "Waiting for your payment"],
        title: "Pay to start the job",
        pay: true,
        body: [
          ...(payment === "left" ? ["You left the payment page, so nothing was charged."] : []),
          "Nothing is charged yet. Paying charges your card and the job starts as soon as the payment goes through.",
        ],
        work: false,
      };
    case "awaiting_acceptance": {
      const fee = j.money.business_total_cents - j.money.price_cents;
      return {
        chip: ["amber", `Waiting for ${n}`],
        title: `${n} has until ${by} to accept`,
        body: [
          `${total} is held on your card, not charged. It is charged when ${n} accepts.`,
          ...(j.due_after_accept ? [`The work is due ${j.due_after_accept}.`] : []),
          `If ${n} declines or doesn't answer within 72 hours, the hold is released and nothing is charged. We email you when ${n} answers.`,
        ],
        facts: [
          {
            Icon: Lock,
            text: `${total} held on your card, not charged`,
            sub: `Charged only when ${n} accepts. ${money(j.money.price_cents)} price + ${money(fee)} Zavi fee.`,
          },
          ...(j.due_after_accept ? [{ Icon: Clock3, text: `Due ${j.due_after_accept}` }] : []),
          {
            Icon: RotateCcw,
            text: `No answer by ${by}? The hold is released`,
            sub: `Same if ${n} declines. Nothing is charged.`,
          },
          { Icon: Mail, text: `We email you when ${n} answers` },
        ],
        work: false,
      };
    }
    case "in_progress":
      if (d.extension?.state === "requested") {
        return {
          chip: ["amber", "New date requested"],
          title: `${n} asked to move the due date from ${due} to ${shortDay(d.extension.requested_due_at)}`,
          body: ["A creator can ask for one new date before the due date. It only changes if you agree."],
          work: false,
        };
      }
      if (j.product_needed && !j.product_received_at) {
        return {
          chip: ["amber", "Waiting for your product"],
          title: `Send ${n} the product`,
          body: [
            `Ask ${n} for a delivery address in the job chat below, then ship the product.`,
            `The ${days ? `${days} ` : ""}days to deliver start when ${n} marks Product received. Zavi holds your ${total} until you approve the work.`,
          ],
          work: false,
        };
      }
      if (j.product_needed && j.product_received_at) {
        return {
          chip: ["blue", `Product received, due ${due}`],
          title: `${n} marked Product received on ${shortDay(j.product_received_at)}`,
          body: [`The ${days ? `${days} ` : ""}days to deliver started then, so the work is due ${due}.`],
          work: false,
        };
      }
      return {
        chip: ["blue", `In progress, due ${due}`],
        title: `${n} is working on it. Due ${due}`,
        body: [`Zavi holds your ${total} until you approve the work.`],
        work: false,
      };
    case "submitted":
      return {
        chip: ["green", `${latest > 1 ? "New version" : "Delivered"}, review by ${by}`],
        title: latest > 1 ? `${n} sent a new version on ${deliveredOn}` : `${n} delivered on ${deliveredOn}`,
        body: [
          left > 0 ? `Approve it, or ask for changes that match what you ordered. ${changes}.` : `${changes}. If it still isn't right, ask Zavi for help.`,
          `If you don't answer by ${by} (72 hours), the job closes as accepted and ${n} is paid 10 days later.`,
        ],
        work: true,
      };
    case "revision_requested":
      return {
        chip: ["amber", `Changes requested: ${used} of 2`],
        title: used > 1 ? `You asked ${n} for changes again` : `You asked ${n} for changes`,
        body: [
          left > 0
            ? `${n} is making the change and sends a new version here. ${changes}.`
            : `${n} is making the change and sends a new version here. ${changes}: after this version you can approve it or ask Zavi for help.`,
        ],
        work: true,
      };
    case "cancel_requested":
      return {
        chip: ["amber", `You asked to cancel, ${n} answers by ${by}`],
        title: `${n} has until ${by} to answer`,
        body: ["If they agree, or say nothing, your card is refunded in full including the 10% Zavi fee. If they decline, the job carries on."],
        work: false,
      };
    case "in_dispute":
      return {
        chip: ["amber", "Zavi is stepping in"],
        title: "Zavi staff are looking at this job",
        body: [
          "Zavi staff read the order, the thread and everything submitted, then decide: pay in full, pay part, or refund. The money waits until they do.",
          "Both of you get an email when Zavi decides.",
        ],
        work: true,
      };
    default: {
      const r: [string, string, string] =
        j.source === "applicant" && j.closed_reason === "checkout_abandoned"
          ? [
              "Not hired, hold released",
              "The hire didn't go through",
              "The payment was not finished, or another hire filled the brief first. Nothing was charged.",
            ]
          : j.closed_reason === "auto_accepted"
            ? autoAcceptedReason(d, n)
            : (REASON[j.closed_reason ?? ""] ?? ["Closed", "This job is closed", ""]);
      const approved = j.closed_reason === "approved";
      const accepted = approved || j.closed_reason === "auto_accepted";
      const snap = (d.package_snapshot ?? {}) as Record<string, unknown>;
      const adVideo = typeof snap.kind !== "string" || snap.kind === "ugc_video";
      const adDays = adVideo && typeof snap.ad_rights_days === "number" && snap.ad_rights_days > 0 ? snap.ad_rights_days : null;
      return {
        chip: ["zinc", approved && j.money.payout_status !== "transferred" ? "Approved" : r[0]],
        title: approved
          ? `You approved${j.closed_at ? ` on ${shortDay(j.closed_at)}` : ""}. ${afterWindowPayout(j.money.payout_status, n)}`
          : r[1].startsWith("You") || r[1].startsWith("Zavi") || r[1].startsWith("The") || r[1].startsWith("Nobody")
            ? r[1]
            : `${n} ${r[1]}`,
        body: approved
          ? [
              `Your agreed ${money(j.money.price_cents)} payment to ${n} is released. If ${n}'s Stripe setup isn't finished yet, Zavi holds it until it is.`,
              ...(adDays ? [`You can run this video as an ad for ${adDays} days, the ad rights in the package.`] : []),
            ]
          : [
              r[2],
              ...(accepted && adDays ? [`You can run this video as an ad for ${adDays} days, the ad rights in the package.`] : []),
            ].filter(Boolean),
        work: j.status === "completed",
      };
    }
  }
}

function autoAcceptedReason(d: CreatorJobDetail, n: string): [string, string, string] {
  const open = d.actions.some((a) => a.action === "ask_zavi_in_buffer");
  const closed = d.job.closed_at ? Date.parse(d.job.closed_at) : NaN;
  const until = Number.isFinite(closed) ? dayTimeUtc(new Date(closed + 10 * 86_400_000).toISOString()) : "";
  return [
    "Accepted automatically",
    "Nobody reviewed in 72 hours, so the job closed as accepted",
    open
      ? `${n} is paid ${until ? `on ${until}` : "10 days after the job closed"}. Until then you can ask Zavi to step in, and the payout is held until Zavi decides.`
      : `The 10 days to ask Zavi to step in have passed. ${afterWindowPayout(d.job.money.payout_status, n)}`,
  ];
}

function afterWindowPayout(payout_status: string, n: string): string {
  if (payout_status === "transferred") return `${n}'s payout is released.`;
  if (payout_status === "transferring") return `${n}'s payout is on its way.`;
  if (payout_status === "awaiting_payout_account") return `Zavi pays ${n} once their Stripe setup is finished.`;
  return `Zavi has not sent ${n}'s payout yet.`;
}

export function isAcceptedJob(j: Pick<CreatorJobDetail["job"], "status" | "closed_reason">): boolean {
  return j.status === "completed" && (j.closed_reason === "approved" || j.closed_reason === "auto_accepted");
}

const NOTE_PROMPT: Partial<Record<CreatorJobActionOption["action"], string>> = {
  request_change: "what should change?",
  request_cancellation: "why do you want to cancel?",
};

export function JobDrawer({ review = false }: { review?: boolean }) {
  const drawer = useUgcDrawer();
  const orderId = drawer.params.job ?? "";
  const [detail, setDetail] = useState<CreatorJobDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void callJson<CreatorJobDetail>(`/api/humans/orders/${encodeURIComponent(orderId)}`).then((r) => {
      if (!alive) return;
      if (r.ok) setDetail(r.data);
      else setLoadError(r.message);
    });
    return () => {
      alive = false;
    };
  }, [orderId, tick]);

  const previewPending = Boolean(detail?.submissions.some((x) => x.preview === "preparing" || x.preview === "failed"));
  const previewPolls = useRef(0);
  useEffect(() => {
    previewPolls.current = 0;
  }, [orderId]);
  useEffect(() => {
    if (!previewPending || previewPolls.current >= MAX_PREVIEW_POLLS) return;
    const t = setTimeout(() => {
      previewPolls.current += 1;
      setTick((x) => x + 1);
    }, PREVIEW_POLL_MS);
    return () => clearTimeout(t);
  }, [previewPending, detail]);

  const [polls, setPolls] = useState(0);
  const settled = useRef(false);
  const [problem, setProblem] = useState<{ problem: "needs_staff" | "cancelled"; message: string } | null>(null);
  const pending = detail?.job.status === "checkout_pending";
  useEffect(() => {
    if (!pending || settled.current || polls >= MAX_POLLS) return;
    const t = setTimeout(
      () => {
        void callJson<CreatorFulfilResult>(`/api/humans/orders/${encodeURIComponent(orderId)}/fulfil`, { body: {} }).then((r) => {
          if (r.ok && r.data.state !== "pending") {
            settled.current = true;
            if (r.data.state === "cancelled" || r.data.state === "needs_staff") setProblem({ problem: r.data.state, message: r.data.message });
            setTick((x) => x + 1);
            return;
          }
          setPolls((x) => x + 1);
        });
      },
      polls === 0 ? 0 : POLL_MS,
    );
    return () => clearTimeout(t);
  }, [pending, polls, orderId]);
  const payment: PaymentState = problem
    ? problem
    : drawer.params.paid === "1"
      ? polls >= MAX_POLLS
        ? "slow"
        : "confirming"
      : drawer.params.cancelled === "1"
        ? "left"
        : "unpaid";

  const n = firstName(detail?.job.creator_display_name || "the creator");
  const title = review
    ? `Review ${n}'s video`
    : detail
      ? isNeverPaidJob(detail.job)
        ? "Payment not finished"
        : `Job #${detail.job.id.slice(0, 8)}`
      : "Job";

  return (
    <SideDrawer title={title} onClose={drawer.close}>
      {!detail ? <DrawerNote>{loadError ?? "Loading the job…"}</DrawerNote> : <JobBody detail={detail} payment={payment} onChanged={setDetail} review={review} />}
    </SideDrawer>
  );
}

function JobBody({
  detail,
  payment,
  onChanged,
  review = false,
}: {
  detail: CreatorJobDetail;
  payment: PaymentState;
  onChanged: (d: CreatorJobDetail) => void;
  review?: boolean;
}) {
  const drawer = useUgcDrawer();
  const j = detail.job;
  const cards = useCreatorCards(j.human_member_id ? [j.human_member_id] : []);
  const photoUrl = j.human_member_id ? (cards[j.human_member_id]?.photo_url ?? null) : null;
  const accepted = isAcceptedJob(j);
  const name = j.creator_display_name || "Creator";
  const n = firstName(name);
  const v = jobView(detail, payment);
  const latest = detail.submissions.reduce((m, s) => (s.version > m ? s.version : m), 0);
  const video = detail.submissions.find((s) => s.version === latest && s.kind === "video") ?? detail.submissions.find((s) => s.version === latest);
  const noChangesLeft = (detail.revisions?.left ?? 2) === 0;
  const actions = detail.actions.map((a) => ({
    ...a,
    label:
      a.action === "approve"
        ? `Approve and release ${money(j.money.price_cents)}`
        : noChangesLeft && a.action === "ask_zavi"
          ? "Ask Zavi for help"
          : a.label,
  }));
  const snap = (detail.package_snapshot ?? {}) as Record<string, unknown>;
  const brief = (detail.brief_snapshot ?? {}) as Record<string, unknown>;
  const num = (k: string) => (typeof snap[k] === "number" ? (snap[k] as number) : null);
  const terms =
    snap.kind === "ugc_video"
      ? termsLine({
          id: "",
          kind: "ugc_video",
          title: "",
          price_cents: 0,
          business_total_cents: 0,
          delivery_days: num("delivery_days") ?? 0,
          video_count: num("video_count"),
          video_length_seconds: num("video_length_seconds"),
          ad_rights_days: num("ad_rights_days"),
        })
      : null;
  const asked = [brief.brief, brief.title].find((x): x is string => typeof x === "string" && x.trim().length > 0) ?? null;
  const ordered = [terms, asked].filter((x): x is string => Boolean(x));
  const len = num("video_length_seconds");

  return (
    <>
      <div className="flex flex-wrap items-start gap-3">
        <Avatar name={name} size="size-12" photoUrl={photoUrl} />
        <div className="min-w-0 flex-1">
          <p className="text-[20px] font-bold tracking-tight text-ink">
            {name}: {j.title}
          </p>
          <p className="mt-0.5 text-[13px] text-inkMuted">
            {money(j.money.business_total_cents)} with Zavi&apos;s fee{isNeverPaidJob(j) ? "" : ` · Job #${j.id.slice(0, 8)}`}
          </p>
        </div>
        <Chip tone={v.chip[0]}>{v.chip[1]}</Chip>
      </div>

      {v.work && video && (
        <div className="mt-4 rounded-2xl bg-creamDeep p-4">
          <VideoTile
            waiting={video.preview === "preparing" || video.preview === "failed"}
            watermarked={video.watermarked === true}
            url={video.play_url}
            caption={
              video.preview === "unavailable"
                ? video.preview_unavailable_reason === "not_built"
                  ? "Preview could not be built"
                  : "No preview for this file"
                : video.preview === "preparing" || video.preview === "failed"
                ? "Preview being prepared"
                : `${len ? `${len}s video` : "Video"} · ${shortDay(video.created_at)}`
            }
          />
          {submissionPreviewNote(video) ? (
            <p data-testid="preview-note" className="mx-auto mt-3 max-w-md text-center text-[13px] leading-5 text-inkMuted">
              {submissionPreviewNote(video)}
            </p>
          ) : video.download_url ? (
            <div className="mt-3 text-center">
              <a href={video.download_url} className={BTN_SECONDARY}>
                Download the original
              </a>
              <p className="mt-2 text-[13px] text-inkMuted">Post it from your own account or ad account.</p>
            </div>
          ) : (
            <p className="mt-3 text-center text-[13px] text-inkMuted">Download it and post it from your own account or ad account.</p>
          )}
        </div>
      )}

      <div className={`${CARD} mt-4`}>
        <Progress status={j.status} closedReason={j.closed_reason} payoutStatus={j.money.payout_status} delivered={detail.submissions.length > 0} />
        <p className="text-[16px] font-semibold text-ink">{v.title}</p>
        {v.facts ? (
          <ul className="mt-3 grid gap-3">
            {v.facts.map(({ Icon, text, sub }) => (
              <li key={text} className="flex items-start gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bone text-inkSoft">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className="text-[14px] font-medium text-ink">{text}</p>
                  {sub && <p className="mt-0.5 text-[13px] leading-relaxed text-inkMuted">{sub}</p>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          v.body.map((b) => (
            <p key={b} className="mt-1.5 text-[14px] leading-relaxed text-inkSoft">
              {b}
            </p>
          ))
        )}
        {v.pay && <PayToStart job={j} />}
        {accepted && (
          <div className="mt-4 flex flex-wrap gap-2">
            {}
            <button
              type="button"
              onClick={() => (detail.rebook ? drawer.open("hire", { package: detail.rebook.package_id }) : drawer.open("find"))}
              className={BTN_PRIMARY}
            >
              Book {n} again
            </button>
          </div>
        )}
        <Actions
          orderId={j.id}
          actions={actions}
          onDone={(d) => d && onChanged(d)}
          confirm={{
            approve: {
              text: `Approving releases the agreed ${money(j.money.price_cents)} price to ${n}. The job closes and this cannot be undone.`,
              label: `Yes, release ${money(j.money.price_cents)}`,
            },
          }}
        />
      </div>

      {j.status === "completed" && <ReviewBox orderId={j.id} name={name} />}

      {}
      {j.status === "completed" && <PublishCard orderId={j.id} first={n} />}

      {ordered.length > 0 && (
        <div className={`${CARD} mt-4`}>
          <p className="text-[14px] font-semibold text-ink">What you ordered</p>
          {ordered.map((line, i) => (
            <p key={i} className={`${i === 0 ? "mt-1" : "mt-2"} text-[14px] whitespace-pre-line text-inkSoft`}>
              {line}
            </p>
          ))}
        </div>
      )}

      {detail.receipt && <CreatorReceipt receipt={detail.receipt} orderId={j.id} className="mt-4" />}

      <DeliveryReceipt submissions={detail.submissions} orderId={j.id} />

      <Messages detail={detail} name={name} first={n} />

      {accepted && (typeof snap.kind !== "string" || snap.kind === "ugc_video") && (
        <p className="mt-4 rounded-xl bg-creamDeep px-4 py-3 text-[14px] text-ink">
          Next:{" "}
          <a href="/workspace?tab=channels&channel=meta_ads" className="font-semibold underline underline-offset-2">
            run it as an ad in Meta Ads
          </a>
          .{num("ad_rights_days") ? ` Ad rights last ${num("ad_rights_days")} days, from ${n}'s package.` : ""}
        </p>
      )}
    </>
  );
}

export function deliveryVersions(submissions: CreatorJobDetail["submissions"]): { version: number; at: string; files: number }[] {
  const byVersion = new Map<number, { version: number; at: string; files: number }>();
  for (const s of submissions ?? []) {
    const row = byVersion.get(s.version);
    if (!row) byVersion.set(s.version, { version: s.version, at: s.created_at, files: 1 });
    else {
      row.files += 1;
      if (s.created_at < row.at) row.at = s.created_at;
    }
  }
  return [...byVersion.values()].sort((a, b) => a.version - b.version);
}

function DeliveryReceipt({ submissions, orderId }: { submissions: CreatorJobDetail["submissions"]; orderId: string }) {
  const versions = deliveryVersions(submissions);
  if (versions.length === 0) return null;
  return (
    <section aria-label="Delivery receipt" className="mt-4 rounded-2xl border border-ink/[0.08] bg-cream p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[14px] font-semibold text-ink">Delivery receipt</p>
        <p className="text-[12px] text-inkMuted">Job #{orderId.slice(0, 8)}</p>
      </div>
      <dl className="mt-3 space-y-1.5 text-[13px]">
        {versions.map((v) => (
          <div key={v.version} className="flex justify-between gap-3 text-inkMuted">
            <dt>
              Version {v.version} · {v.files} {v.files === 1 ? "file" : "files"}
            </dt>
            <dd className="tabular-nums">Delivered {dayTimeUtc(v.at)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Progress({
  status,
  closedReason,
  payoutStatus,
  delivered,
}: {
  status: string;
  closedReason: string | null;
  payoutStatus: string | null;
  delivered: boolean;
}) {
  const at = stageOf(status, closedReason, payoutStatus, delivered);
  if (at === null) return null;
  return (
    <ol aria-label="Job progress" className="mb-4 flex items-center">
      {STAGES.map((label, i) => {
        const done = i < at;
        const current = i === at;
        return (
          <li key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <span
                aria-current={current ? "step" : undefined}
                className={`flex size-6 items-center justify-center rounded-full text-[11px] font-bold ${
                  done ? "bg-ink text-cream" : current ? "border-2 border-ink bg-cream text-ink" : "border border-rule bg-cream text-inkLight"
                }`}
              >
                {done ? <Check className="size-3.5" strokeWidth={3} aria-hidden="true" /> : i + 1}
              </span>
              <span className={`text-[11px] font-medium ${done || current ? "text-ink" : "text-inkLight"}`}>{label}</span>
            </div>
            {i < STAGES.length - 1 && <span className={`mx-1.5 mb-4 h-0.5 flex-1 rounded-full ${i < at ? "bg-ink" : "bg-bone"}`} />}
          </li>
        );
      })}
    </ol>
  );
}

function PayToStart({ job }: { job: CreatorJobDetail["job"] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pay = async () => {
    setBusy(true);
    setErr(null);
    const path =
      job.source === "offer" && job.offer_id
        ? `/api/creators/offers/${encodeURIComponent(job.offer_id)}/checkout`
        : `/api/humans/orders/${encodeURIComponent(job.id)}/checkout`;
    const r = await callJson<{ checkout_url: string | null }>(path, { body: {} });
    if (r.ok && r.data.checkout_url) {
      window.location.assign(r.data.checkout_url);
      return;
    }
    setBusy(false);
    setErr(r.ok ? "Zavi could not open the payment page. Nothing was charged. Try again in a moment." : r.message);
  };
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void pay()} className={BTN_PRIMARY}>
          {busy ? "Opening the payment page" : "Pay to start"}
        </button>
      </div>
      {err && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-600">{err}</p>}
    </>
  );
}

export function groupJobActions<A extends { action: string }>(actions: A[]) {
  const isPrimary = (a: A) => a.action === "approve" || a.action === "approve_extension";
  const isSecondary = (a: A) => a.action === "request_change" || a.action === "decline_extension";
  const primary = actions.filter(isPrimary);
  const secondary = actions.filter(isSecondary);
  const rest = actions.filter((a) => !isPrimary(a) && !isSecondary(a));
  const grouped = primary.length + secondary.length > 0;
  return { primary, secondary, loose: grouped ? [] : rest, others: grouped ? rest : [] };
}

function Actions({
  orderId,
  actions,
  onDone,
  confirm = {},
}: {
  orderId: string;
  actions: CreatorJobActionOption[];
  onDone: (d: CreatorJobDetail | null) => void;
  confirm?: Partial<Record<BusinessAction, { text: string; label: string }>>;
}) {
  const [open, setOpen] = useState<BusinessAction | null>(null);
  const [confirming, setConfirming] = useState<BusinessAction | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(
    async (action: BusinessAction, text: string) => {
      setBusy(true);
      setErr(null);
      const r = await callJson<CreatorActionResult>(`/api/humans/orders/${encodeURIComponent(orderId)}/actions`, {
        body: { action, note: text || undefined },
      });
      setBusy(false);
      if (!r.ok) {
        setErr(r.message);
        return;
      }
      setOpen(null);
      setConfirming(null);
      setNote("");
      onDone(r.data.detail);
    },
    [orderId, onDone],
  );

  if (actions.length === 0) return null;
  const opened = actions.find((a) => a.action === open);
  const { primary, secondary, loose, others } = groupJobActions(actions);
  const press = (a: CreatorJobActionOption) => {
    setErr(null);
    if (a.wants_note) {
      setConfirming(null);
      setOpen(a.action);
    } else if (confirm[a.action]) {
      setOpen(null);
      setConfirming(a.action);
    } else void run(a.action, "");
  };
  const button = (a: CreatorJobActionOption, cls: string) => (
    <button key={a.action} type="button" disabled={busy} aria-pressed={open === a.action || undefined} onClick={() => press(a)} className={cls}>
      {a.label}
    </button>
  );
  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {primary.map((a) => button(a, BTN_PRIMARY))}
        {secondary.map((a) => button(a, BTN_SECONDARY))}
        {loose.map((a) => button(a, BTN_SECONDARY))}
        {others.length > 0 ? (
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
            className="inline-flex h-10 items-center gap-1 rounded-cta px-2 text-[14px] font-medium text-inkMuted hover:text-ink"
          >
            More options
            <ChevronDown className={`h-4 w-4 transition-transform ${moreOpen ? "rotate-180" : ""}`} aria-hidden />
          </button>
        ) : null}
      </div>
      {moreOpen && others.length > 0 ? (
        <ul className="mt-2 grid gap-2 rounded-xl border border-rule p-2">
          {others.map((a) => (
            <li key={a.action}>
              <button
                type="button"
                disabled={busy}
                onClick={() => press(a)}
                className="w-full rounded-cta px-3 py-2 text-left hover:bg-bone disabled:opacity-50"
              >
                <span className="block text-[14px] font-semibold text-ink">{a.label}</span>
                <span className="mt-0.5 block text-[13px] leading-snug text-inkMuted">{a.consequence}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {confirming && confirm[confirming] && (
        <InlineConfirm
          text={confirm[confirming]!.text}
          confirmLabel={busy ? "Working" : confirm[confirming]!.label}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void run(confirming, "")}
          primaryClass={BTN_PRIMARY}
          secondaryClass={BTN_SECONDARY}
        />
      )}
      {opened && (
        <div className="mt-3 grid gap-2 rounded-xl border border-rule p-3">
          <label className="block">
            <span className="text-[14px] font-medium text-ink">
              {opened.label}: {NOTE_PROMPT[opened.action] ?? "what should Zavi know?"}
            </span>
            {}
            <span className="mt-1 block text-[13px] leading-snug text-inkMuted">{opened.consequence}</span>
            {(opened.action === "ask_zavi" || opened.action === "ask_zavi_in_buffer") && (
              <span data-testid="ask-zavi-hint" className="mt-1 block text-[13px] leading-snug text-inkMuted">
                For a question about the work, message the creator instead: this is for a problem Zavi staff have to decide, and the creator sees that Zavi is involved.
              </span>
            )}
            <textarea rows={3} className={`${FIELD} mt-2`} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(null)} className={BTN_SECONDARY}>
              Not now
            </button>
            <button type="button" disabled={busy || !note.trim()} onClick={() => void run(opened.action, note.trim())} className={BTN_PRIMARY}>
              Send
            </button>
          </div>
        </div>
      )}
      {err && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-600">{err}</p>}
      <details className="group mt-3 border-t border-rule pt-3 text-[13px] leading-snug">
        <summary className="cursor-pointer list-none font-medium text-inkMuted hover:text-ink">
          What each option does
          <ChevronDown className="ml-1 inline h-4 w-4 align-[-3px] transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <dl className="mt-2 grid gap-2">
          {actions.map((a) => (
            <div key={a.action}>
              <dt className="inline font-semibold text-ink">{a.label}: </dt>
              <dd className="inline text-inkSoft">{a.consequence}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}

export type HistoryEntry =
  | { kind: "msg"; key: string; at: string; from: "me" | "them"; text: string }
  | { kind: "change"; key: string; at: string; round: number; note: string | null }
  | { kind: "delivery"; key: string; at: string; version: number; files: CreatorJobDetail["submissions"]; note: string | null };

export function jobHistory(
  detail: Pick<CreatorJobDetail, "submissions" | "change_requests">,
  messages: CreatorJobDetail["thread"]["messages"],
): HistoryEntry[] {
  const changes = detail.change_requests ?? [];
  const notes = new Set(changes.map((c) => (c.note ?? "").trim()).filter(Boolean));
  const out: HistoryEntry[] = [];
  for (const m of messages) {
    if (m.sender_kind === "tenant" && notes.has(m.body.trim())) continue;
    out.push({ kind: "msg", key: `m:${m.id}`, at: m.created_at, from: m.sender_kind === "tenant" ? "me" : "them", text: m.body });
  }
  for (const c of changes) out.push({ kind: "change", key: `c:${c.round}`, at: c.created_at, round: c.round, note: c.note });
  const versions = new Map<number, CreatorJobDetail["submissions"]>();
  for (const sub of detail.submissions) versions.set(sub.version, [...(versions.get(sub.version) ?? []), sub]);
  for (const [version, files] of versions) {
    const sorted = [...files].sort((x, y) => x.position - y.position);
    const at = sorted.reduce((m, x) => (x.created_at < m ? x.created_at : m), sorted[0].created_at);
    out.push({ kind: "delivery", key: `v:${version}`, at, version, files: sorted, note: sorted.find((x) => x.note)?.note ?? null });
  }
  return out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
}

function Messages({ detail, name, first }: { detail: CreatorJobDetail; name: string; first: string }) {
  const [messages, setMessages] = useState(detail.thread.messages);
  const [threadId, setThreadId] = useState(detail.thread.thread_id);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setMessages(detail.thread.messages), [detail.thread.messages]);
  useEffect(() => setThreadId(detail.thread.thread_id), [detail.thread.thread_id]);
  const memberId = detail.job.human_member_id ?? null;
  const canWrite = detail.thread.available && (threadId !== null || memberId !== null);
  const send = useCallback(
    async (text: string) => {
      if (threadId) {
        const r = await callJson<{ message: (typeof messages)[number] }>(`/api/creators/threads/${threadId}/messages`, {
          body: { body: text },
        });
        if (!r.ok) {
          setError(r.message);
          return false;
        }
        setError(null);
        setMessages((m) => [...m, r.data.message]);
        return true;
      }
      if (!memberId) return false;
      const r = await callJson<{ thread: { id: string }; message: (typeof messages)[number] }>(
        `/api/creators/${encodeURIComponent(memberId)}/threads`,
        { body: { body: text } },
      );
      if (!r.ok) {
        setError(r.message);
        return false;
      }
      setError(null);
      setThreadId(r.data.thread.id);
      setMessages((m) => [...m, r.data.message]);
      return true;
    },
    [threadId, memberId],
  );
  const max = detail.revisions?.max ?? 2;
  const items: ThreadItem[] = jobHistory(detail, messages).map((h): ThreadItem => {
    if (h.kind === "msg") return { kind: "msg", key: h.key, from: h.from, text: h.text, at: stamp(h.at) };
    if (h.kind === "change")
      return {
        kind: "card",
        key: h.key,
        node: (
          <div className="rounded-xl border border-rule bg-creamDeep px-4 py-3">
            <p className="text-[13px] font-semibold text-ink">
              You asked for changes · round {h.round} of {max}
              <span className="font-normal text-inkLight"> · {stamp(h.at)}</span>
            </p>
            <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{h.note ?? "No note was added to this request."}</p>
          </div>
        ),
      };
    return {
      kind: "card",
      key: h.key,
      node: (
        <div className="rounded-xl border border-rule px-4 py-3">
          <p className="text-[13px] font-semibold text-ink">
            {first} delivered version {h.version}
            <span className="font-normal text-inkLight"> · {stamp(h.at)}</span>
          </p>
          {h.note ? <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-ink/80">&ldquo;{h.note}&rdquo;</p> : null}
          <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {h.files.map((file, i) => (
              <li key={file.id}>
                {file.play_url ? (
                  <a href={file.play_url} target="_blank" rel="noopener noreferrer" className="font-medium text-ink underline underline-offset-2">
                    {file.kind === "video" ? "Watch" : "Open"} {h.files.length > 1 ? `file ${i + 1}` : file.kind === "video" ? "video" : "file"}
                  </a>
                ) : (
                  <span className="text-inkMuted">File {i + 1}: link unavailable right now</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ),
    };
  });
  return (
    <div className={`${CARD} mt-4`}>
      <p className="text-[16px] font-semibold text-ink">History and messages with {first}</p>
      <p className="mt-0.5 mb-4 text-[13px] text-inkMuted">
        Messages, change requests and every version {first} sent. Each new message emails the other side, at most one email every 15 minutes.
      </p>
      {!detail.thread.available ? (
        <p className="mb-3 text-[14px] text-inkMuted">Messages for this job aren&apos;t available right now.</p>
      ) : items.length === 0 ? (
        <p className="mb-3 text-[14px] text-inkMuted">No messages with {first} yet.</p>
      ) : null}
      {error && <p className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-600">{error}</p>}
      {canWrite ? (
        <Thread them={name} placeholder={`Message ${first}`} onSend={send} items={items} />
      ) : items.length > 0 ? (
        <Thread them={name} placeholder="" onSend={async () => false} items={items} readOnly />
      ) : null}
    </div>
  );
}

const AXES = [
  { id: "communication", label: "Communication" },
  { id: "timeliness", label: "On time" },
  { id: "satisfaction", label: "Happy with the result" },
] as const;
type Axis = (typeof AXES)[number]["id"];

function ReviewBox({ orderId, name }: { orderId: string; name: string }) {
  const first = firstName(name);
  const [existing, setExisting] = useState<boolean | null>(null);
  const [scores, setScores] = useState<Record<Axis, number>>({ communication: 0, timeliness: 0, satisfaction: 0 });
  const [note, setNote] = useState("");
  const [posted, setPosted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void callJson<{ review: unknown }>(`/api/humans/orders/${encodeURIComponent(orderId)}/review`).then((r) =>
      setExisting(r.ok ? r.data.review !== null : false),
    );
  }, [orderId]);
  const done = AXES.every((a) => scores[a.id] > 0);
  const avg = Math.round(((scores.communication + scores.timeliness + scores.satisfaction) / 3) * 10) / 10;
  const post = async () => {
    setErr(null);
    const r = await callJson(`/api/humans/orders/${encodeURIComponent(orderId)}/review`, {
      body: { ...scores, body: note.trim() || null },
    });
    if (r.ok) setPosted(true);
    else setErr(r.message);
  };
  if (existing === null) return null;
  return (
    <div className={`${CARD} mt-4`}>
      <p className="text-[16px] font-semibold text-ink">Review {first}</p>
      <p className="mt-0.5 text-[14px] text-inkMuted">Businesses see the average and the number of reviews on {first}&apos;s card in Find creators.</p>
      {posted || existing ? (
        <p className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-[14px] font-medium text-emerald-600">
          {posted ? `Thanks. Your review (${avg} out of 5) is on ${first}'s card.` : `You reviewed ${first}. It is on ${first}'s card.`}
        </p>
      ) : (
        <>
          <div className="mt-3 grid gap-2">
            {AXES.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[14px] font-medium text-ink">{a.label}</span>
                <div className="flex gap-0.5" role="radiogroup" aria-label={a.label}>
                  {[1, 2, 3, 4, 5].map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={scores[a.id] === k}
                      aria-label={`${a.label}: ${k} out of 5`}
                      onClick={() => setScores((s) => ({ ...s, [a.id]: k }))}
                      className="cursor-pointer rounded p-0.5"
                    >
                      <Star className={`h-6 w-6 ${k <= scores[a.id] ? "fill-[#946300] text-amber-600" : "text-inkLight"}`} />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <label className="mt-3 block">
            <span className="text-[14px] font-medium text-ink">Note</span>
            <span className="ml-1.5 text-[13px] text-inkMuted">optional</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={`What was it like working with ${first}?`} className={`${FIELD} mt-1.5`} />
          </label>
          {err && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[13px] text-red-600">{err}</p>}
          <div className="mt-3 flex items-center justify-end gap-3">
            {!done && <span className="text-[13px] text-inkMuted">Rate all three to post</span>}
            <button type="button" disabled={!done} onClick={() => void post()} className={`${BTN_PRIMARY} disabled:bg-ink/25`}>
              Post review
            </button>
          </div>
        </>
      )}
    </div>
  );
}
