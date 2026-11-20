"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Check, Clock, ImageIcon, Upload, Video, X } from "lucide-react";
import { creatorApi, CreatorApiError, money, type CreatorJob } from "@/lib/creator/api";
import { ROUNDS_LINE, packageTerms, specFromSaved, type SavedPackage } from "@/lib/creator/packageSpec";
import { BTN_PRIMARY, BTN_SECONDARY, BTN_SMALL, Bone, Card, EmptySlot, ErrorNote, FIELD, H1, RING, StatusPill } from "./areaUi";
import { Composer, MessageList, dayLabel, stamp, type Line } from "./CreatorThread";
import { InlineConfirm } from "@/components/humans/InlineConfirm";

type Tone = "neutral" | "good" | "wait" | "bad" | "dark";

export type JobState =
  | "checkout_pending"
  | "awaiting_acceptance"
  | "product_pending"
  | "in_progress"
  | "late"
  | "submitted"
  | "revision_requested"
  | "resubmitted"
  | "revision_requested_2"
  | "resubmitted_2"
  | "cancel_requested"
  | "in_dispute"
  | "approved"
  | "approved_setup"
  | "auto_accepted"
  | "mediation_pay_full"
  | "mediation_pay_part"
  | "mediation_refund"
  | "declined"
  | "expired"
  | "withdrawn"
  | "payment_failed"
  | "no_show"
  | "cancel_agreed"
  | "cancel_no_response";

const CHANGE_ROUNDS = 2;

export function jobState(job: CreatorJob, now: Date = new Date()): JobState {
  const used = job.revisions_used ?? 0;
  switch (job.status) {
    case "checkout_pending":
      return "checkout_pending";
    case "awaiting_acceptance":
      return "awaiting_acceptance";
    case "in_progress":
      if (job.can_mark_product_received || (job.product_needed && !job.product_received_at)) return "product_pending";
      if (job.due_at && now.getTime() > new Date(job.due_at).getTime()) return "late";
      return "in_progress";
    case "submitted":
      return used >= 2 ? "resubmitted_2" : used === 1 ? "resubmitted" : "submitted";
    case "revision_requested":
      return used >= 2 ? "revision_requested_2" : "revision_requested";
    case "cancel_requested":
      return "cancel_requested";
    case "in_dispute":
      return "in_dispute";
    case "completed":
      if (job.closed_reason === "auto_accepted") return job.payout_status === "transferred" ? "approved" : "auto_accepted";
      if (job.closed_reason === "mediation_pay_full") return "mediation_pay_full";
      if (job.closed_reason === "mediation_pay_part") return "mediation_pay_part";
      if (job.closed_reason === "mediation_refund") return "mediation_refund";
      return job.payout_status === "awaiting_payout_account" ? "approved_setup" : "approved";
    default:
      switch (job.closed_reason) {
        case "declined":
          return "declined";
        case "expired":
          return "expired";
        case "payment_failed":
          return "payment_failed";
        case "no_show":
          return "no_show";
        case "cancel_agreed":
          return "cancel_agreed";
        case "cancel_no_response":
          return "cancel_no_response";
        case "mediation_refund":
          return "mediation_refund";
        default:
          return "withdrawn";
      }
  }
}

export const JOB_TONE: Record<JobState, Tone> = {
  checkout_pending: "wait",
  awaiting_acceptance: "dark",
  product_pending: "wait",
  in_progress: "neutral",
  late: "bad",
  submitted: "wait",
  revision_requested: "bad",
  resubmitted: "wait",
  revision_requested_2: "bad",
  resubmitted_2: "wait",
  cancel_requested: "bad",
  in_dispute: "wait",
  approved: "good",
  approved_setup: "wait",
  auto_accepted: "good",
  mediation_pay_full: "good",
  mediation_pay_part: "wait",
  mediation_refund: "neutral",
  declined: "neutral",
  expired: "neutral",
  withdrawn: "neutral",
  payment_failed: "neutral",
  no_show: "bad",
  cancel_agreed: "neutral",
  cancel_no_response: "neutral",
};

const CLOSED: ReadonlySet<JobState> = new Set([
  "approved",
  "approved_setup",
  "auto_accepted",
  "mediation_pay_full",
  "mediation_pay_part",
  "mediation_refund",
  "declined",
  "expired",
  "withdrawn",
  "payment_failed",
  "no_show",
  "cancel_agreed",
  "cancel_no_response",
]);

export type JobBucket = "awaiting_acceptance" | "in_progress" | "awaiting_approval";

export const JOB_BUCKETS: { key: JobBucket; label: string }[] = [
  { key: "awaiting_acceptance", label: "Awaiting acceptance" },
  { key: "in_progress", label: "In progress" },
  { key: "awaiting_approval", label: "Awaiting approval" },
];

const BUCKET_OF: Partial<Record<JobState, JobBucket>> = {
  awaiting_acceptance: "awaiting_acceptance",
  product_pending: "in_progress",
  in_progress: "in_progress",
  late: "in_progress",
  in_dispute: "in_progress",
  revision_requested: "in_progress",
  revision_requested_2: "in_progress",
  submitted: "awaiting_approval",
  resubmitted: "awaiting_approval",
  resubmitted_2: "awaiting_approval",
};

export function jobBucket(job: CreatorJob, now: Date = new Date()): JobBucket | null {
  return BUCKET_OF[jobState(job, now)] ?? null;
}

export type JobCounts = Record<JobBucket, number> & { pending: number };

export function jobCounts(jobs: CreatorJob[], now: Date = new Date()): JobCounts {
  const c: JobCounts = { awaiting_acceptance: 0, in_progress: 0, awaiting_approval: 0, pending: 0 };
  for (const j of jobs) {
    const b = jobBucket(j, now);
    if (!b) continue;
    c[b] += 1;
    c.pending += 1;
  }
  return c;
}

export const JOBS_CHANGED = "zavi:creator-jobs-changed";

export function jobStateLabel(state: JobState, biz: string): string {
  const labels: Record<JobState, string> = {
    checkout_pending: `Waiting for ${biz} to pay`,
    awaiting_acceptance: "Booking request",
    product_pending: "Waiting for the product",
    in_progress: "In progress",
    late: "Past the due date",
    submitted: "Sent, waiting for review",
    revision_requested: "Changes requested, 1 of 2",
    resubmitted: "New version sent, 1 of 2 used",
    revision_requested_2: "Changes requested, 2 of 2",
    resubmitted_2: "New version sent, 2 of 2 used",
    cancel_requested: `${biz} asked to cancel`,
    in_dispute: "Zavi is looking at it",
    approved: "Approved and paid",
    approved_setup: "Approved, payout waiting",
    auto_accepted: "Accepted automatically",
    mediation_pay_full: "Zavi decided: paid in full",
    mediation_pay_part: "Zavi decided: paid in part",
    mediation_refund: "Zavi decided: refunded",
    declined: "You passed",
    expired: "Expired, no answer",
    withdrawn: `${biz} withdrew`,
    payment_failed: "Payment failed",
    no_show: "Cancelled, missed deadline",
    cancel_agreed: "Cancelled, you agreed",
    cancel_no_response: "Cancelled, no answer",
  };
  return labels[state];
}

export function payoutStep(payout_status: string | undefined): { label: string; paid: boolean } {
  if (payout_status === "transferred") return { label: "Paid", paid: true };
  if (payout_status === "awaiting_payout_account") return { label: "Set up payouts", paid: false };
  if (payout_status === "ready" || payout_status === "transferring") return { label: "On the way", paid: false };
  if (payout_status === "not_due" || payout_status === undefined) return { label: "Paid", paid: false };
  return { label: "Pending", paid: false };
}

export function listLabel(state: JobState, biz: string, payout_status?: string): string {
  if (state !== "approved" && state !== "mediation_pay_full") return jobStateLabel(state, biz);
  return payout_status === undefined ? "Paid" : payoutStep(payout_status).label;
}

export function utcText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function bizOf(job: CreatorJob): string {
  return job.business_name?.trim() || "The business";
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function jobTitle(job: CreatorJob): string {
  const pkg = job.package ?? {};
  const t = pkg["title"];
  if (typeof t === "string" && t.trim()) return t.trim();
  const tt = obj(pkg["terms"])["title"];
  if (typeof tt === "string" && tt.trim()) return tt.trim();
  const bt = job.brief?.["title"];
  if (typeof bt === "string" && bt.trim()) return bt.trim();
  return job.source === "offer" ? "Custom offer" : "A job";
}

export function jobTerms(job: CreatorJob, biz: string): string {
  const pkg = job.package ?? {};
  if (job.source === "offer") {
    const terms = obj(pkg["terms"]);
    const dueDate = typeof terms["due_date"] === "string" ? dayLabel(terms["due_date"]) : job.due_at ? dayLabel(job.due_at) : null;
    const when = dueDate ? `Due ${dueDate}.` : `Delivered in ${String(pkg["delivery_days"] ?? "")} days.`;
    const who = job.offer_proposed_by === "tenant" ? `Custom offer from ${biz}.` : "Your custom offer.";
    return `${who} ${when} ${ROUNDS_LINE}.`;
  }
  if (pkg["kind"] === "ugc_video") {
    return packageTerms(specFromSaved({ ...(pkg as unknown as SavedPackage), title: String(pkg["title"] ?? ""), price_cents: job.price_cents }));
  }
  const days = pkg["delivery_days"] ?? job.brief?.["delivery_days"];
  return typeof days === "number" ? `Delivered in ${days} days. ${ROUNDS_LINE}.` : `${ROUNDS_LINE}.`;
}

export function jobSteps(job: CreatorJob, biz: string): string[] {
  const tail = ["Draft sent", "Approved", payoutStep(job.payout_status).label];
  if (job.source === "offer") {
    if (job.offer_proposed_by === "tenant") return ["You accepted", `${biz} pays`, ...tail];
    return job.product_needed ? ["Offer accepted", "Product received", ...tail] : ["Offer accepted", `${biz} paid`, ...tail];
  }
  const first = job.source === "applicant" ? "Hired" : "Booked";
  return [first, job.product_needed ? "Product received" : "Accepted", ...tail];
}

export function answerConfirm(kind: "accept" | "pass", job: CreatorJob, bizName: string, now: Date = new Date()): { text: string; label: string } {
  const biz = bizName === "The business" ? "the business" : bizName;
  if (kind === "pass") {
    return {
      text: `Passing releases the hold on ${biz}'s card. Nothing is charged and the booking closes.`,
      label: "Yes, pass",
    };
  }
  const d = job.package?.["delivery_days"];
  const days = typeof d === "number" && Number.isInteger(d) && d > 0 ? d : 7;
  const due = job.product_needed
    ? `The ${days} days to deliver start when you mark the product received.`
    :
      `The work is due ${days} days after you accept (${dayLabel(new Date(now.getTime() + days * 86_400_000).toISOString())} if you accept now).`;
  return {
    text: `Accepting charges ${biz}'s card ${money(job.price_cents)} plus Zavi's fee and starts the job. ${due}`,
    label: "Yes, accept",
  };
}

type Run = "accept" | "pass" | "product" | "extension" | "help" | "cancel_agree" | "cancel_decline" | "cancel_dispute";
type Action = { label: string; kind: "primary" | "secondary"; href: string } | { label: string; kind: "primary" | "secondary"; run: Run };

type View = {
  headline: string;
  body: string;
  done: number;
  actions: Action[];
  deliver?: boolean;
  changes?: number;
};

const HELP: Action = { label: "Ask Zavi to step in", kind: "secondary", run: "help" };

function autoAcceptedPayout(job: CreatorJob, biz: string, payout: string, now: Date): string {
  const closed = job.closed_at ? Date.parse(job.closed_at) : NaN;
  const ready = job.payout_ready_at ? Date.parse(job.payout_ready_at) : NaN;
  const created = Date.parse(job.created_at);
  const end = Number.isFinite(closed)
    ? closed + 10 * 86_400_000
    : Number.isFinite(ready) && !(ready < created)
      ? ready
      : NaN;
  if (!Number.isFinite(end) || now.getTime() < end) {
    const on = Number.isFinite(end) ? `, on ${utcText(new Date(end).toISOString()).split(" at ")[0]}` : "";
    return `Your payout of ${payout} is released after a 10 day buffer${on}. During those 10 days ${biz} can still ask Zavi to step in.`;
  }
  const where =
    job.payout_status === "transferring"
      ? `Your payout of ${payout} is on its way.`
      : job.payout_status === "awaiting_payout_account"
        ? `Finish your Stripe setup and Zavi sends your payout of ${payout}.`
        : `Zavi has not sent your payout of ${payout} yet.`;
  return `The 10 days to ask Zavi to step in have passed. ${where}`;
}

const NO_PAYOUT = new Set<JobState>([
  "mediation_refund",
  "declined",
  "expired",
  "withdrawn",
  "payment_failed",
  "no_show",
  "cancel_agreed",
  "cancel_no_response",
]);

export function viewFor(state: JobState, job: CreatorJob, biz: string, now: Date = new Date()): View {
  const payout = money(job.amount_cents);
  switch (state) {
    case "checkout_pending":
      return {
        headline: `Waiting for ${biz} to pay`,
        body: `You accepted ${biz}'s custom offer. They are asked to pay, and the job starts when they do. You don't need to do anything yet.`,
        done: 1,
        actions: [],
      };
    case "awaiting_acceptance":
      return {
        headline: `${biz} wants to book you`,
        body: `Their card is on hold until you answer. Accept and the card is charged and the job starts${
          job.due_after_accept ? `, due ${job.due_after_accept}` : ""
        }. Pass and the hold is released; nothing is charged.`,
        done: 1,
        actions: [
          { label: "Accept", kind: "primary", run: "accept" },
          { label: "Pass", kind: "secondary", run: "pass" },
        ],
      };
    case "product_pending": {
      const pkg = job.package ?? {};
      const terms = obj(pkg["terms"]);
      const due = typeof terms["due_date"] === "string" ? dayLabel(terms["due_date"]) : null;
      const what = job.source === "offer" && job.offer_proposed_by !== "tenant" ? "accepted your offer" : "booked you";
      const days = pkg["delivery_days"];
      const dueLine = due
        ? ` The work is due ${due}, the date in your offer.`
        : typeof days === "number"
          ? ` The work is due ${days} days after it arrives.`
          : "";
      return {
        headline: "Waiting for the product",
        body: `${biz} ${what} and is sending you a product for it. Share your delivery address in the chat, and mark Product received when it arrives.${dueLine}`,
        done: 1,
        actions: [{ label: "Mark product received", kind: "primary", run: "product" }, HELP],
      };
    }
    case "in_progress":
      return {
        headline: "Make and send your video",
        body: "Upload your draft when it's ready. You can ask for more time once, before the due date.",
        done: 2,
        deliver: true,
        actions: [{ label: "Ask for more time", kind: "secondary", run: "extension" }],
      };
    case "late":
      return {
        headline: "Your draft is past the due date",
        body: `The due date was ${job.due_at ? utcText(job.due_at) : "passed"}. Send your draft now.`,
        done: 2,
        deliver: true,
        actions: [],
      };
    case "submitted":
      return {
        headline: `Sent. Waiting for ${biz} to review`,
        body: `${biz} can approve it or ask for changes that match what was ordered.`,
        done: 3,
        actions: [HELP],
      };
    case "revision_requested":
      return {
        headline: `${biz} asked for changes`,
        body: `Send the new version when it's ready. There is no timer on changes; ${biz} then has 72 hours to review the new version.`,
        done: 2,
        changes: 1,
        deliver: true,
        actions: [HELP],
      };
    case "resubmitted":
      return {
        headline: `New version sent. Waiting for ${biz}`,
        body: `${biz} can approve it or use their last round of changes.`,
        done: 3,
        changes: 1,
        actions: [HELP],
      };
    case "revision_requested_2":
      return {
        headline: `${biz} asked for changes again`,
        body: `This is the last round in the order. After this version ${biz} can approve it or ask Zavi for help, but can't request more changes.`,
        done: 2,
        changes: 2,
        deliver: true,
        actions: [HELP],
      };
    case "resubmitted_2":
      return {
        headline: `Last version sent. Waiting for ${biz}`,
        body: `Both rounds of changes are used. ${biz} can approve it or ask Zavi for help, but can't ask for more changes.`,
        done: 3,
        changes: 2,
        actions: [HELP],
      };
    case "cancel_requested":
      return {
        headline: `${biz} asked to cancel`,
        body: `If you agree, the job is cancelled and ${biz} is refunded in full, including the 10% Zavi fee. If you decline, the job carries on exactly where it was. If you don't think that's fair, ask Zavi to step in.`,
        done: 2,
        actions: [
          { label: "Agree to cancel", kind: "secondary", run: "cancel_agree" },
          { label: "Decline, keep the job", kind: "primary", run: "cancel_decline" },
          { label: "Ask Zavi to step in", kind: "secondary", run: "cancel_dispute" },
        ],
      };
    case "in_dispute":
      return {
        headline: "Zavi was asked to step in",
        body: "The money waits where it is until Zavi decides. Nobody is paid and nobody is refunded in the meantime. Zavi emails you both when it decides.",
        done: job.submissions.length > 0 ? 3 : 2,
        actions: [],
      };
    case "approved":
      return {
        headline: `Approved. You were paid ${payout}`,
        body: `Zavi sent ${payout} to your Stripe account. Stripe decides when it lands in your bank, usually a couple of days.`,
        done: 5,
        actions: [{ label: "See earnings", kind: "secondary", href: "/creator/earnings" }],
      };
    case "approved_setup":
      return {
        headline: `Approved. Your ${payout} is waiting`,
        body: `${biz} approved your work. Finish your Stripe setup and Zavi sends your payout.`,
        done: 4,
        actions: [{ label: "Set up payouts", kind: "primary", href: "/creator/earnings" }],
      };
    case "auto_accepted":
      return {
        headline: "Your work was accepted automatically",
        body: `${biz} did not review in time, so the job closed as accepted. ${autoAcceptedPayout(job, biz, payout, now)}`,
        done: 4,
        actions: [{ label: "See earnings", kind: "secondary", href: "/creator/earnings" }],
      };
    case "mediation_pay_full":
      return {
        headline: "Zavi decided: you are paid in full",
        body: `Zavi has finished looking at this job. Your payout for this job is ${payout}.`,
        done: 5,
        actions: [],
      };
    case "mediation_pay_part":
      return {
        headline: "Zavi decided: you are paid in part",
        body: `Zavi has finished looking at this job. Your payout for this job is ${payout}. ${biz} is refunded the rest.`,
        done: 5,
        actions: [],
      };
    case "mediation_refund":
      return {
        headline: `Zavi decided: ${biz} is refunded`,
        body: "Zavi has finished looking at this job. No payout is due on it.",
        done: 3,
        actions: [],
      };
    case "declined":
      return {
        headline: "You passed on this booking",
        body: `The hold on ${biz}'s card was released. Nothing was charged.`,
        done: 1,
        actions: [],
      };
    case "expired":
      return {
        headline: "This booking expired",
        body: `You didn't answer within 72 hours, so the booking was cancelled and the hold on ${biz}'s card was released. Nothing was charged.`,
        done: 1,
        actions: [],
      };
    case "withdrawn":
      return {
        headline: `${biz} withdrew the booking`,
        body: `${biz} cancelled before you accepted. The hold on their card was released.`,
        done: 1,
        actions: [],
      };
    case "payment_failed":
      return {
        headline: "The booking was cancelled",
        body: `${biz} could not be charged, so the job is cancelled before it started. This does not count against you and it is not a missed deadline.`,
        done: 1,
        actions: [],
      };
    case "no_show":
      return {
        headline: "Cancelled: no draft arrived",
        body: `No draft arrived within 3 days after the due date, so the job was cancelled, ${biz} was refunded in full and you got a missed deadline mark.`,
        done: 2,
        actions: [],
      };
    case "cancel_agreed":
      return {
        headline: "Cancelled. You agreed",
        body: `${biz} is refunded in full, including the 10% Zavi fee. No payout is due on a cancelled job, and this does not count as a missed deadline.`,
        done: 2,
        actions: [],
      };
    case "cancel_no_response":
      return {
        headline: "Cancelled: no answer to the request",
        body: `You didn't answer ${biz}'s request within 72 hours, so the job was cancelled and ${biz} was refunded in full, including the 10% Zavi fee. No payout is due on a cancelled job, and this does not count as a missed deadline.`,
        done: 2,
        actions: [],
      };
  }
}

function pickDefault(jobs: CreatorJob[]): string | null {
  const open = jobs.find((j) => !CLOSED.has(jobState(j)));
  return (open ?? jobs[0])?.id ?? null;
}

export const JOB_REFRESH_MS = 20_000;

export function CreatorJobsScreen({ orderId }: { orderId?: string }) {
  const [jobs, setJobs] = useState<CreatorJob[] | null>(null);
  const [job, setJob] = useState<CreatorJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const selectedId = orderId ?? (jobs ? pickDefault(jobs) : null);

  const [bucket, setBucket] = useState<JobBucket | null>(null);

  const listSeq = useRef(0);
  const jobSeq = useRef(0);

  const loadList = useCallback(() => {
    const seq = ++listSeq.current;
    creatorApi
      .jobs("all")
      .then((v) => {
        if (seq !== listSeq.current) return;
        setJobs(v.jobs);
        setError(null);
        window.dispatchEvent(new CustomEvent<number>(JOBS_CHANGED, { detail: jobCounts(v.jobs).pending }));
      })
      .catch((e: unknown) => {
        if (seq === listSeq.current) setError(e instanceof CreatorApiError ? e.message : "Your jobs did not load.");
      });
  }, []);

  const loadJob = useCallback(() => {
    if (!selectedId) return;
    const seq = ++jobSeq.current;
    creatorApi
      .job(selectedId)
      .then((v) => {
        if (seq !== jobSeq.current) return;
        setJob(v.job);
        setJobError(null);
      })
      .catch((e: unknown) => {
        if (seq === jobSeq.current) setJobError(e instanceof CreatorApiError ? e.message : "That job did not load.");
      });
  }, [selectedId]);

  useEffect(loadList, [loadList]);
  useEffect(loadJob, [loadJob]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      loadList();
      loadJob();
    };
    const timer = window.setInterval(refresh, JOB_REFRESH_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadList, loadJob]);

  const jobLoaded = !!job;
  useEffect(() => {
    if (!jobLoaded) return;
    const id = window.location.hash.slice(1);
    if (id === "feedback" || id === "messages") document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [jobLoaded]);

  const reload = useCallback(() => {
    loadList();
    loadJob();
  }, [loadList, loadJob]);

  const empty = !!jobs && jobs.length === 0 && !orderId;
  const state = job ? jobState(job) : null;
  const closed = state ? CLOSED.has(state) : false;
  const counts = jobs ? jobCounts(jobs) : null;
  const shown = jobs && bucket ? jobs.filter((j) => jobBucket(j) === bucket) : jobs;

  return (
    <div>
      <H1 title="Jobs" />
      {counts && jobs && jobs.length > 0 ? (
        <div role="group" aria-label="Filter jobs by status" className="mt-4 flex flex-wrap gap-2">
          {[{ key: null, label: "All", n: jobs.length }, ...JOB_BUCKETS.map((b) => ({ ...b, n: counts[b.key] }))].map((b) => {
            const on = bucket === b.key;
            return (
              <button
                key={b.label}
                type="button"
                aria-pressed={on}
                onClick={() => setBucket(b.key)}
                className={`${RING} inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-colors ${
                  on ? "border-foreground bg-foreground text-white" : "border-black/15 bg-white text-foreground hover:bg-black/[0.03]"
                }`}
              >
                {b.label}
                <span className={`tabular-nums ${on ? "text-white/80" : "text-muted"}`}>{b.n}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <div className="space-y-4">
          <Card className="p-2">
            {error && !jobs ? (
              <div className="p-2">
                <ErrorNote message={error} />
              </div>
            ) : !jobs ? (
              <JobListSkeleton />
            ) : jobs.length === 0 ? (
              <p className="px-3 py-3 text-[14px] text-muted">
                No jobs yet. When you accept a booking, get hired from a brief or a business accepts your offer, the job shows here.
              </p>
            ) : (
              <ul className="divide-y divide-black/[0.06]">
                {shown && shown.length === 0 ? (
                  <li className="px-3 py-3 text-[14px] text-muted">No jobs with this status right now.</li>
                ) : null}
                {(shown ?? []).map((j) => {
                  const s = jobState(j);
                  const biz = bizOf(j);
                  const current = j.id === selectedId;
                  const inner = (
                    <>
                      <span className={`min-w-0 break-words text-[14px] text-foreground ${current ? "font-semibold" : ""}`}>
                        {biz === "The business" ? jobTitle(j) : `${biz}: ${jobTitle(j)}`}
                      </span>
                      <StatusPill tone={JOB_TONE[s]}>
                        {current && !((s === "approved" || s === "mediation_pay_full") && j.payout_status !== "transferred")
                          ? jobStateLabel(s, biz)
                          : listLabel(s, biz, j.payout_status)}
                      </StatusPill>
                    </>
                  );
                  return (
                    <li key={j.id}>
                      {current ? (
                        <div aria-current="true" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-black/[0.03] px-3 py-3">
                          {inner}
                        </div>
                      ) : (
                        <Link
                          href={`/creator/jobs/${j.id}`}
                          className={`${RING} flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-3 hover:bg-black/[0.03]`}
                        >
                          {inner}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {empty ? (
            <>
              <EmptySlot>The job you open shows here: what to deliver, the due date, and what happens next.</EmptySlot>
              <EmptySlot>Upload your draft here once a job is in progress.</EmptySlot>
            </>
          ) : jobError && job?.id !== selectedId ? (
            <div className="space-y-3">
              <ErrorNote message={jobError} />
              <Link href="/creator/jobs" className="text-[13px] font-semibold underline">
                Back to your jobs
              </Link>
            </div>
          ) : job && state ? (
            <JobDetail key={`${job.id}:${job.status}:${job.revisions_used ?? 0}`} job={job} state={state} onChanged={reload} />
          ) : jobs && jobs.length > 0 ? (
            <JobDetailSkeleton />
          ) : null}
        </div>

        <JobMessages
          key={job?.id ?? "none"}
          job={empty ? null : job}
          loading={!empty && !job && !error && !jobError}
          closed={closed}
          onSent={loadJob}
        />
      </div>
    </div>
  );
}

function JobListSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading your jobs.</span>
      <ul aria-hidden="true" className="divide-y divide-black/[0.06]">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center justify-between gap-3 px-3 py-3.5">
            <Bone className="h-4 w-1/2 rounded-full" />
            <Bone className="h-6 w-24 shrink-0 rounded-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function JobDetailSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading this job.</span>
      <div aria-hidden="true" className="space-y-4">
        <Card>
          <Bone className="h-6 w-28 rounded-full" />
          <Bone className="mt-4 h-6 w-2/3 rounded-full" />
          <Bone className="mt-3 h-4 w-1/2 rounded-full" />
          <Bone className="mt-4 h-4 w-40 rounded-full" />
          <div className="mt-5 flex flex-wrap gap-3 border-t border-black/[0.06] pt-4">
            {[0, 1, 2, 3].map((i) => (
              <Bone key={i} className="h-5 w-24 rounded-full" />
            ))}
          </div>
        </Card>
        <Card>
          <Bone className="h-5 w-48 rounded-full" />
          <Bone className="mt-4 h-4 w-full rounded-full" />
          <Bone className="mt-2 h-4 w-3/4 rounded-full" />
        </Card>
      </div>
    </div>
  );
}

function JobDetail({ job, state, onChanged }: { job: CreatorJob; state: JobState; onChanged: () => void }) {
  const biz = bizOf(job);
  const v = viewFor(state, job, biz);
  const closed = CLOSED.has(state);
  const steps = jobSteps(job, biz);
  const done = payoutStep(job.payout_status).paid ? v.done : Math.min(v.done, steps.length - 1);
  const rounds = job.revisions_max ?? CHANGE_ROUNDS;
  const [busy, setBusy] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (job.extension_state === null) return;
    setAsking(false);
    setError(null);
  }, [job.extension_state]);
  const [helpFor, setHelpFor] = useState<"help" | "cancel_dispute" | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState<"accept" | "pass" | null>(null);

  async function run(kind: Run, fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof CreatorApiError ? e.message : "That did not go through. Try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function press(r: Run) {
    switch (r) {
      case "accept":
      case "pass":
        return setConfirming(r);
      case "product":
        return void run(r, () => creatorApi.productReceived(job.id));
      case "cancel_agree":
        return void run(r, () => creatorApi.answerCancellation(job.id, "agree"));
      case "cancel_decline":
        return void run(r, () => creatorApi.answerCancellation(job.id, "decline"));
      case "extension":
        return setAsking(true);
      case "help":
      case "cancel_dispute":
        return setHelpFor(r);
    }
  }

  const extensionUsed = job.extension_state !== null;
  const requestedDays =
    job.extension_state === "requested" && job.extension_requested_due_at && job.due_at
      ? Math.round((new Date(job.extension_requested_due_at).getTime() - new Date(job.due_at).getTime()) / 86_400_000)
      : null;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StatusPill tone={JOB_TONE[state]}>{v.headline}</StatusPill>
          {v.changes ? (
            <span className="text-[13px] font-semibold text-danger">
              Changes requested: {v.changes} of {rounds}, {Math.max(0, rounds - v.changes)} left
            </span>
          ) : null}
        </div>
        <h2 className="mt-3 break-words text-[20px] font-bold tracking-tight text-foreground">
          {jobTitle(job)}
          {biz === "The business" ? "" : ` for ${biz}`}
        </h2>
        <p className="mt-1 text-[14px] text-muted">{jobTerms(job, biz)}</p>
        <p className="mt-3 text-[14px] text-foreground">
          {NO_PAYOUT.has(state) ? (
            <>
              No payout on this job
              <span className="text-muted"> (the agreed fee was {money(job.price_cents)})</span>
            </>
          ) : job.part_paid ? (
            <>
              You receive <span className="font-semibold">{money(job.amount_cents)}</span>
              <span className="text-muted"> (part of {money(job.creator_payout_cents)}, after Zavi stepped in)</span>
            </>
          ) : (
            <>
              You receive <span className="font-semibold">{money(job.creator_payout_cents)}</span>
              <span className="text-muted"> ({money(job.price_cents)} less Zavi&apos;s 15%)</span>
            </>
          )}
        </p>

        <ol className="mt-5 flex flex-wrap gap-x-3 gap-y-2 border-t border-black/[0.06] pt-4">
          {steps.map((s, i) => {
            const ticked = i < done;
            const now = i === done && (!closed || i === steps.length - 1);
            return (
              <li key={s} className="flex items-center gap-2 text-[12px] font-semibold">
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full ${
                    ticked ? "bg-foreground text-white" : now ? "border-2 border-foreground bg-white" : "border border-black/15 bg-white"
                  }`}
                >
                  {ticked && <Check className="h-3 w-3" aria-hidden="true" />}
                </span>
                <span className={ticked || now ? "text-foreground" : "text-muted"}>{s}</span>
              </li>
            );
          })}
        </ol>
      </Card>

      <BriefPanel job={job} biz={biz} />

      <Card>
        <p className="text-[14px] leading-relaxed text-foreground">{v.body}</p>
        {job.deadline && !closed && (
          <p className="mt-3 flex gap-2 rounded-xl bg-warnBg px-4 py-3 text-[13px] leading-relaxed text-warn">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-semibold">Deadline: {job.deadline.deadline_text}.</span> {job.deadline.consequence_text}
            </span>
          </p>
        )}
        {(state === "revision_requested" || state === "revision_requested_2") && job.change_request_note ? (
          <div id="feedback" className="mt-3 scroll-mt-24 rounded-xl border border-warn/20 bg-warnBg px-4 py-3">
            <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-warn">What {biz} asked for</p>
            <p className="mt-1 whitespace-pre-wrap text-[14px] text-foreground">&ldquo;{job.change_request_note}&rdquo;</p>
          </div>
        ) : null}
        {state === "in_progress" && job.extension_state === "requested" && (
          <div role="status" data-testid="extension-requested" className="mt-3 flex items-start gap-3 rounded-xl border border-setup-progress/50 bg-setup-cool px-4 py-3">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-setup-progress" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-foreground">
                You asked for {requestedDays !== null && requestedDays > 0 ? `${requestedDays} more days` : "a new due date"}. Waiting for {biz}.
              </p>
              <p className="mt-0.5 text-[13px] leading-5 text-muted">
                {job.extension_requested_due_at ? `If ${biz} approves, your draft is due ${dayLabel(job.extension_requested_due_at)}. ` : ""}
                Until they answer, it is still due {job.due_at ? dayLabel(job.due_at) : "on the agreed date"}. You can ask for more time only once per job.
              </p>
            </div>
          </div>
        )}
        {state === "in_progress" && job.extension_state === "declined" && (
          <div role="status" data-testid="extension-declined" className="mt-3 flex items-start gap-3 rounded-xl border border-black/[0.08] bg-black/[0.03] px-4 py-3">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-foreground">
                {biz} kept the original due date{job.due_at ? ` of ${dayLabel(job.due_at)}` : ""}.
              </p>
              <p className="mt-0.5 text-[13px] leading-5 text-muted">Your request for more time was declined. Your draft is still due then, and a job can ask for more time only once.</p>
            </div>
          </div>
        )}
        {state === "in_progress" && job.extension_state === "approved" && (
          <div role="status" data-testid="extension-approved" className="mt-3 flex items-start gap-3 rounded-xl border border-success/25 bg-successBg px-4 py-3">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-foreground">{biz} gave you more time{job.due_at ? `. Your draft is now due ${dayLabel(job.due_at)}` : ""}.</p>
            </div>
          </div>
        )}
        {state === "in_dispute" && job.help_request && (
          <div data-testid="help-request" className="mt-3 rounded-xl border border-warn/20 bg-warnBg px-4 py-3">
            <p className="text-[12px] font-bold tracking-[0.08em] text-warn uppercase">You asked Zavi</p>
            <p className="mt-1 text-[14px] whitespace-pre-wrap text-foreground">&ldquo;{job.help_request.reason}&rdquo;</p>
            <p className="mt-1 text-[12px] text-muted">Sent {dayLabel(job.help_request.opened_at)}. Zavi emails you both when it decides.</p>
          </div>
        )}
        {asking && !extensionUsed && (
          <div className="mt-3 rounded-xl border border-black/[0.08] bg-white px-4 py-3">
            <p className="text-[14px] font-semibold text-foreground">How many more days? You can ask once.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {[2, 3, 5].map((d) => (
                <button
                  key={d}
                  type="button"
                  disabled={busy !== null || !job.due_at}
                  onClick={() =>
                    void run("extension", () =>
                      creatorApi.requestExtension(job.id, new Date(new Date(job.due_at as string).getTime() + d * 86_400_000).toISOString(), ""),
                    ).then((ok) => ok && setAsking(false))
                  }
                  className={BTN_SMALL}
                >
                  {d} days
                </button>
              ))}
              <button type="button" onClick={() => setAsking(false)} className={BTN_SMALL}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {helpFor && (
          <div data-testid="help-problem" className="mt-3 rounded-xl border border-black/[0.08] bg-white px-4 py-3">
            <p className="text-[14px] font-medium text-foreground">What should Zavi look at?</p>
            <p data-testid="help-warning" className="mt-1 text-[13px] leading-5 text-muted">
              Zavi staff step in on this job: the job and its money pause until they decide, and {biz} sees that Zavi is involved. For a question about the work, message {biz} in Messages instead.
            </p>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="What should Zavi look at?"
              className={`${FIELD} mt-2 resize-none px-4 py-3 leading-relaxed`}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy !== null || !reason.trim()}
                onClick={() =>
                  void run(helpFor, () =>
                    helpFor === "help" ? creatorApi.askZaviForHelp(job.id, reason.trim()) : creatorApi.answerCancellation(job.id, "dispute", reason.trim()),
                  )
                }
                className={BTN_SMALL}
              >
                {busy ? "Sending" : "Pause the job and ask Zavi"}
              </button>
              <button type="button" onClick={() => setHelpFor(null)} className={BTN_SMALL}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {error ? (
          <div className="mt-3">
            <ErrorNote message={error} />
          </div>
        ) : null}
        {v.actions.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-3">
            {v.actions.filter((a) => !("run" in a && a.run === "extension" && extensionUsed)).map((a) =>
              "href" in a ? (
                <Link key={a.label} href={a.href} className={a.kind === "primary" ? BTN_PRIMARY : BTN_SECONDARY}>
                  {a.label}
                </Link>
              ) : (
                <button
                  key={a.label}
                  type="button"
                  disabled={
                    busy !== null ||
                    (a.run === "extension" && (asking || extensionUsed || !job.due_at)) ||
                    ((a.run === "help" || a.run === "cancel_dispute") && helpFor !== null)
                  }
                  onClick={() => press(a.run)}
                  className={a.kind === "primary" ? BTN_PRIMARY : BTN_SECONDARY}
                >
                  {a.label}
                </button>
              ),
            )}
          </div>
        )}
        {confirming ? (
          <InlineConfirm
            {...(() => {
              const c = answerConfirm(confirming, job, biz);
              return { text: c.text, confirmLabel: busy ? "Working" : c.label };
            })()}
            busy={busy !== null}
            onCancel={() => setConfirming(null)}
            onConfirm={() =>
              void run(confirming, () => (confirming === "accept" ? creatorApi.accept(job.id) : creatorApi.pass(job.id, ""))).then(
                () => setConfirming(null),
              )
            }
            primaryClass={BTN_PRIMARY}
            secondaryClass={BTN_SECONDARY}
          />
        ) : null}
        {closed && <p className="mt-4 text-[13px] text-muted">This job is closed.</p>}
      </Card>

      {v.deliver && <DeliverCard job={job} changes={v.changes} biz={biz} onDone={onChanged} />}
    </>
  );
}

const BRIEF_FIELDS: [key: string, label: string][] = [
  ["title", "Title"],
  ["brief", "What they asked for"],
  ["angle", "Angle"],
  ["hook", "Hook"],
  ["format", "Format"],
  ["deliverables", "Deliverables"],
  ["delivery_days", "Days to deliver"],
  ["ad_rights_days", "Ad rights (days)"],
];

export function briefRows(brief: Record<string, unknown>): [label: string, value: string][] {
  return BRIEF_FIELDS.flatMap(([k, label]) => {
    const v = brief[k];
    if (v === null || v === undefined || typeof v === "object" || String(v).trim() === "") return [];
    return [[label, String(v)] as [string, string]];
  });
}

function BriefPanel({ job, biz }: { job: CreatorJob; biz: string }) {
  const rows = job.brief ? briefRows(job.brief) : [];
  const heading = job.source === "applicant" ? "The brief you were hired for" : `What ${biz} asked for`;
  if (rows.length === 0) {
    const ask = job.has_thread || CAN_START_THREAD.has(job.status) ? `Not sure what to film? Ask ${biz} in Messages before you start.` : null;
    return (
      <Card>
        <h3 className="text-[16px] font-semibold text-foreground">{heading}</h3>
        <p className="mt-2 text-[14px] leading-relaxed text-foreground">
          {biz} did not add instructions to this booking. You work to the package terms shown above.
        </p>
        {ask ? <p className="mt-2 text-[13px] leading-relaxed text-muted">{ask}</p> : null}
      </Card>
    );
  }
  return (
    <Card>
      <h3 className="text-[16px] font-semibold text-foreground">{heading}</h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[14px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="whitespace-pre-wrap break-words text-foreground">{String(v)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const ACCEPTED_TYPES = ["video/mp4", "video/quicktime", "video/webm", "image/png", "image/jpeg", "image/webp"];

export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function putWithProgress(url: string, file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("upload failed")));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(file);
  });
}

function PickedFile({
  file,
  progress,
  locked,
  onRemove,
}: {
  file: File;
  progress: number | null;
  locked: boolean;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const isImage = file.type.startsWith("image/");
  return (
    <li data-testid="picked-file" className="overflow-hidden rounded-2xl border border-black/[0.08] bg-white">
      <div className="relative bg-black">
        {url && isImage ? (
          <Image src={url} alt={`Preview of ${file.name}`} width={1280} height={720} unoptimized className="mx-auto max-h-80 w-full object-contain" />
        ) : url ? (
          <video src={url} controls playsInline preload="metadata" aria-label={`Preview of ${file.name}`} className="mx-auto max-h-80 w-full bg-black" />
        ) : (
          <div className="grid h-40 place-items-center text-white/60">
            {isImage ? <ImageIcon className="h-6 w-6" aria-hidden="true" /> : <Video className="h-6 w-6" aria-hidden="true" />}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 px-4 py-3">
        {isImage ? <ImageIcon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" /> : <Video className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-foreground" title={file.name}>
            {file.name}
          </p>
          <p className="text-[12px] text-muted">
            {fileSize(file.size)}
            {progress !== null ? ` · ${progress >= 1 ? "Uploaded" : `Uploading ${Math.round(progress * 100)}%`}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={locked}
          aria-label={`Remove ${file.name}`}
          className={`${RING} grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full text-muted hover:bg-black/[0.05] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40`}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {progress !== null && (
        <div className="h-1 w-full bg-black/[0.06]" role="progressbar" aria-label={`Uploading ${file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <div className="h-1 bg-foreground transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </li>
  );
}

function DeliverCard({ job, changes, biz, onDone }: { job: CreatorJob; changes?: number; biz: string; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [fractions, setFractions] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  function add(picked: File[]) {
    const ok = picked.filter((f) => ACCEPTED_TYPES.includes(f.type) && f.size <= MAX_UPLOAD_BYTES);
    const refused = picked.filter((f) => !ok.includes(f));
    setError(
      refused.length > 0
        ? `${refused.map((f) => f.name).join(", ")}: use an MP4, MOV or WebM video, or a PNG, JPEG or WebP image, up to 500 MB.`
        : null,
    );
    setFiles((prev) => [...prev, ...ok]);
  }

  async function submit() {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setFractions({});
    try {
      const uploaded: { kind: string; storage_path: string; mime_type: string; bytes: number }[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgress(`Uploading ${i + 1} of ${files.length}`);
        setFractions((m) => ({ ...m, [i]: 0 }));
        const slot = await creatorApi.uploadUrl(job.id, file.type);
        await putWithProgress(slot.signed_url, file, (f) => setFractions((m) => ({ ...m, [i]: f })));
        setFractions((m) => ({ ...m, [i]: 1 }));
        uploaded.push({
          kind: file.type.startsWith("image/") ? "image" : "video",
          storage_path: slot.path,
          mime_type: file.type,
          bytes: file.size,
        });
      }
      setProgress("Sending");
      await creatorApi.submit(job.id, uploaded, "");
      setFiles([]);
      setFractions({});
      onDone();
    } catch (e) {
      setFractions({});
      setError(e instanceof CreatorApiError ? e.message : "That upload did not finish. Try again.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Card>
      <h3 className="text-[16px] font-semibold text-foreground">{changes ? "Send the new version" : "Deliver"}</h3>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ACCEPTED_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="deliver-input"
        onChange={(e) => {
          add(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {files.length > 0 && (
        <ul className="mt-3 space-y-3">
          {files.map((f, i) => (
            <PickedFile
              key={`${f.name}:${f.size}:${i}`}
              file={f}
              progress={fractions[i] ?? null}
              locked={busy}
              onRemove={() => {
                setFractions({});
                setFiles((prev) => prev.filter((_, k) => k !== i));
              }}
            />
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(Array.from(e.dataTransfer.files ?? []));
        }}
        className={`${RING} mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-center transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          dragging ? "border-foreground/50 bg-black/[0.03]" : "border-black/15 bg-white/70 hover:border-black/30 hover:bg-white"
        } ${files.length > 0 ? "px-4 py-3" : "flex-col px-6 py-8"}`}
      >
        <Upload className={files.length > 0 ? "h-4 w-4 text-muted" : "h-6 w-6 text-muted"} aria-hidden="true" />
        <span className="text-[14px] font-semibold text-foreground">{files.length > 0 ? "Add another file" : "Upload your video"}</span>
        {files.length === 0 && <span className="text-[13px] text-muted">Drag it here or click. MP4 or MOV, up to 500 MB</span>}
      </button>
      {error ? (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
      <button type="button" disabled={files.length === 0 || busy} onClick={() => void submit()} className={`${BTN_PRIMARY} mt-4`}>
        {busy ? (progress ?? "Sending") : files.length > 1 ? `Submit ${files.length} files for approval` : "Submit for approval"}
      </button>
      <p className="mt-3 text-[13px] text-muted">
        {biz} then has 72 hours to approve or ask for changes. If they don&apos;t answer, it is accepted automatically.
      </p>
    </Card>
  );
}

const CAN_START_THREAD: ReadonlySet<string> = new Set(["in_progress", "submitted", "revision_requested", "cancel_requested", "in_dispute"]);

function JobMessages({ job, loading, closed, onSent }: { job: CreatorJob | null; loading: boolean; closed: boolean; onSent: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const biz = job ? bizOf(job) : "The business";
  const canWrite = !!job && !closed && (job.has_thread || CAN_START_THREAD.has(job.status));
  const lines: Line[] = (job?.thread ?? [])
    .filter((m) => m.sender_kind === "creator" || m.sender_kind === "tenant")
    .map((m) => ({ from: m.sender_kind === "creator" ? "me" : "them", body: m.body, at: stamp(m.created_at) }));

  async function send(body: string): Promise<boolean> {
    if (!job) return false;
    setBusy(true);
    setError(null);
    try {
      await creatorApi.sendMessage(job.id, body);
      onSent();
      return true;
    } catch (e) {
      setError(e instanceof CreatorApiError ? e.message : "That message did not send.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="messages" className="h-fit scroll-mt-24">
    <Card className="h-fit">
      <h3 className="text-[16px] font-semibold text-foreground">{job && biz !== "The business" ? `Messages with ${biz}` : "Messages"}</h3>
      <div className="mt-4">
        {!job && loading ? (
          <div role="status" aria-live="polite">
            <span className="sr-only">Loading messages.</span>
            <div aria-hidden="true" className="space-y-3">
              <Bone className="h-10 w-3/4 rounded-2xl" />
              <Bone className="ml-auto h-10 w-2/3 rounded-2xl" />
              <Bone className="h-24 w-full rounded-2xl" />
            </div>
          </div>
        ) : !job ? (
          <EmptySlot>Messages with the business show here once you have a job.</EmptySlot>
        ) : !job.has_thread && !canWrite ? (
          <EmptySlot>{closed ? "No messages on this job." : `You can message ${biz} once you accept the job.`}</EmptySlot>
        ) : lines.length === 0 ? (
          <EmptySlot>No messages yet. Sort out product, timing and anything else here.</EmptySlot>
        ) : (
          <MessageList messages={lines} them={biz} />
        )}
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      ) : null}
      {canWrite && <Composer onSend={send} busy={busy} />}
      {job && closed && <p className="mt-4 text-[13px] text-muted">The job is closed. Messages stay here.</p>}
    </Card>
    </div>
  );
}
