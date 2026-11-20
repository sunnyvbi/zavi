
import { createHash } from "node:crypto";

import { creatorInboxClient } from "@/services/tenant-client";
import { readPii } from "@/services/humans/store";
import { resolveAgentEmailRecipients } from "@/services/notifications/agent-email-recipients";
import { sgSend } from "@/email/sendAuthEmail";
import { renderCreatorNotificationEmail } from "@/email/templates/creator-notification";
import { webBaseUrl } from "@/services/web-base";
import { deadlineCopy, type DeadlineAudience, type DeadlineKind } from "./deadline-copy";
import { firstWord } from "./deadlines";
import { businessJobLink, UGC_HUB_PATH } from "./hub-links";
import { scrubContact as scrubContactDetails } from "./contact-scrub";

const TABLE = "creator_notifications";

export type NotifyRecipient =
  | { kind: "creator"; human_member_id: string }
  | { kind: "tenant"; tenant_id: string };

export type CreatorNotificationEvent =
  | "booking_request_received"
  | "custom_offer_received"
  | "custom_offer_accepted"
  | "thread_message"
  | "brief_fits_you"
  | "brief_application_received"
  | "hired"
  | "not_hired"
  | "creator_accepted"
  | "creator_passed"
  | "submission_received"
  | "revision_requested"
  | "product_received"
  | "due_date_nudge"
  | "grace_nudge"
  | "auto_accepted"
  | "approved"
  | "paid"
  | "payout_setup_needed"
  | "cancellation_requested"
  | "cancellation_declined"
  | "cancellation_revoked"
  | "cancellation_outcome"
  | "dispute_opened"
  | "dispute_resolved"
  | "payment_failed"
  | "tax_forms_ready"
  | "creator_live"
  | "country_needed";

export type ReminderHour = 24 | 60;

export type ReminderWindow = Extract<
  DeadlineKind,
  "accept" | "review" | "cancel_response" | "offer_expiry"
>;

export type NotifyVars = {
  business_name?: string | null;
  creator_name?: string | null;
  job_title?: string | null;
  brief_title?: string | null;
  price_cents?: number | null;
  payout_cents?: number | null;
  business_total_cents?: number | null;
  payout_waiting?: boolean | null;
  refund_cents?: number | null;
  note?: string | null;
  reason?: string | null;
  year?: number | null;
  repeat_booking?: boolean | null;
  order_source?: "booking" | "offer" | "applicant" | null;
  extension?: "requested" | "approved" | "declined" | null;
  mediation?: "pay_full" | "pay_part" | "refund" | null;
  payout_sent?: boolean | null;
  extension_from?: string | null;
  extension_to?: string | null;
  deadline_kind?: DeadlineKind | null;
  deadline_at?: string | Date | null;
  country_missing?: boolean | null;
  affiliate_only?: boolean | null;
  affiliate_link?: string | null;
  link_path?: string | null;
  message_body?: string | null;
};

export type NotifyInput = {
  recipient: NotifyRecipient;
  event: CreatorNotificationEvent;
  order_id?: string | null;
  scope_id?: string | null;
  vars?: NotifyVars;
  dedupe_key?: string | null;
  dedupe_window?: string | null;
  email_cta_url?: string | null;
};

export type NotifyResult = {
  written: boolean;
  emailed: boolean;
  notification_id: string | null;
  dedupe_key: string;
  reason?: "duplicate" | "no_recipient_email" | "email_failed";
};

function usd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "the agreed amount";
  return `$${(cents / 100).toFixed(2)}`;
}

function refundLine(v: NotifyVars, sent: string): string {
  if (v.reason === "refund_on_hold") {
    return "The refund is on hold because there is a chargeback on this payment with your bank, so the refund can't be sent through Zavi. Zavi staff will follow up with you.";
  }
  if (v.reason === "refund_already_done") {
    return "This charge was already refunded, so no new refund was sent.";
  }
  return sent;
}

function name(v: string | null | undefined, fallback: string): string {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : fallback;
}

function userText(s: string | null | undefined): string {
  const t = (s ?? "").trim();
  return t.length > 0 ? scrubContactDetails(t).body : "";
}

function extensionDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

export function previewText(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[\s.,;:!?]+$/, "")}...`;
}

const MESSAGE_PREVIEW_CHARS = 200;
const SUBJECT_SNIPPET_CHARS = 60;

function webOrigin(): string {
  return webBaseUrl();
}

export function safeEmailCtaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "checkout.stripe.com" ? u.toString() : null;
  } catch {
    return null;
  }
}

function defaultLinkPath(
  recipientKind: NotifyRecipient["kind"],
  event: CreatorNotificationEvent | "reminder",
  order_id: string | null,
  scope_id: string | null,
): string {
  if (recipientKind === "creator") {
    if (event === "brief_fits_you") {
      return scope_id ? `/creator/briefs?brief=${encodeURIComponent(scope_id)}` : "/creator/briefs";
    }
    if (event === "payout_setup_needed" || event === "tax_forms_ready") {
      return "/creator/earnings";
    }
    return order_id ? `/creator/jobs/${order_id}` : "/creator";
  }
  return order_id ? businessJobLink(order_id) : UGC_HUB_PATH;
}

function buildDedupeKey(args: {
  scope: string;
  event: string;
  window: string;
  recipient: NotifyRecipient;
}): string {
  const rid =
    args.recipient.kind === "creator" ? args.recipient.human_member_id : args.recipient.tenant_id;
  const key = `cn:${args.scope}:${args.event}:${args.window}:${args.recipient.kind}:${rid}`;
  if (key.length <= 255) return key;
  return `cn:h:${createHash("sha256").update(key).digest("hex")}`;
}

export const THREAD_NOTIFY_WINDOW_SECONDS = 900;

export function threadDedupeKey(args: {
  thread_id: string;
  event: CreatorNotificationEvent;
  recipient: NotifyRecipient;
  now?: Date;
}): string {
  const bucket = Math.floor((args.now ?? new Date()).getTime() / 1000 / THREAD_NOTIFY_WINDOW_SECONDS);
  const rid =
    args.recipient.kind === "creator" ? args.recipient.human_member_id : args.recipient.tenant_id;
  const key = `thread:${args.thread_id}:${args.event}:${bucket}:${args.recipient.kind}:${rid}`;
  if (key.length <= 255) return key;
  return `cn:h:${createHash("sha256").update(key).digest("hex")}`;
}

type Copy = {
  title: string;
  intro: string;
  lines: string[];
  cta: string;
  subject?: string;
  quote?: string;
  quoteFrom?: string;
  footer?: string;
};

function buildCopy(
  event: CreatorNotificationEvent,
  recipientKind: NotifyRecipient["kind"],
  v: NotifyVars,
): Copy {
  const biz = name(userText(v.business_name), BUSINESS_NAME_FALLBACK);
  const creator = name(userText(v.creator_name), "The creator");
  const job = name(userText(v.job_title), "the job");
  const brief = name(userText(v.brief_title), "the brief");
  const note = userText(v.note);
  const reason = userText(v.reason);

  const forCreator = recipientKind === "creator";

  switch (event) {
    case "booking_request_received":
      return forCreator && v.repeat_booking === true
        ? {
            title: `${biz} wants to book you again`,
            intro: `${biz} has worked with you before and finished that job. They want to book you again for ${job}. Their card is on hold until you answer.`,
            lines: [
              `You keep ${usd(v.payout_cents)} after the 15% creator fee.`,
              "Nothing is charged to them, and nothing is owed by you, until you accept.",
            ],
            cta: "Open the request",
          }
        : {
            title: `New booking request from ${biz}`,
            intro: `${biz} wants to book you for ${job}. Their card is on hold until you answer.`,
            lines: [
              `You keep ${usd(v.payout_cents)} after the 15% creator fee.`,
              "Nothing is charged to them, and nothing is owed by you, until you accept.",
            ],
            cta: "Open the request",
          };

    case "brief_application_received":
      return {
        title: `${creator} applied to ${clamp(brief, 120)}`,
        intro: `${creator} applied to ${brief}. Nothing is charged until you hire.`,
        lines: [
          `Their price is ${usd(v.price_cents)}. If you hire them you pay ${usd(v.business_total_cents)}, which includes the 10% Zavi fee.`,
        ],
        cta: "See applicants",
      };

    case "custom_offer_received":
      return forCreator
        ? {
            title: `${biz} sent you a custom offer`,
            intro: `${biz} put together a custom offer for ${job}.`,
            lines: [`You keep ${usd(v.payout_cents)} after the 15% creator fee.`],
            cta: "See the offer",
          }
        : {
            title: `${creator} sent you a custom offer`,
            intro: `${creator} replied with a custom offer for ${job}.`,
            lines: [
              `You pay ${usd(v.business_total_cents)} in total, which includes the 10% Zavi fee.`,
              "Nothing is charged until you accept. If you accept, your card is charged and the job starts straight away.",
            ],
            cta: "See the offer",
          };

    case "custom_offer_accepted":
      return {
        title: `${creator} accepted your custom offer`,
        intro: `${creator} said yes to ${job}. Pay to start the job.`,
        lines: [
          `You pay ${usd(v.business_total_cents)} in total, which includes the 10% Zavi fee.`,
          "Nothing has been charged yet. When you pay, the job starts and Zavi holds the money until you approve the work.",
          "The payment link works for 24 hours. If it runs out, ask the creator to send the offer again.",
        ],
        cta: "Pay and start the job",
      };

    case "thread_message": {
      const sender = forCreator ? biz : creator;
      const message = userText(v.message_body);
      const hasJob = userText(v.job_title).length > 0;
      return {
        title: `New message from ${sender}`,
        subject: message
          ? `${sender}: ${previewText(message, SUBJECT_SNIPPET_CHARS)}`
          : `New message from ${sender}`,
        intro: hasJob ? `About ${job}.` : "",
        quote: message ? previewText(message, MESSAGE_PREVIEW_CHARS) : undefined,
        quoteFrom: sender,
        lines: [],
        cta: "Read and reply",
        footer: "Contact details are removed from messages. Keep the conversation on Zavi.",
      };
    }

    case "product_received":
      return {
        title: `${creator} has the product for ${clamp(job, 90)}`,
        intro: `${creator} marked the product as received, so the delivery clock has started.`,
        lines: [],
        cta: "Open the job",
      };

    case "brief_fits_you":
      return {
        title: `A brief that fits you: ${clamp(brief, 120)}`,
        intro: `${biz} posted a brief in your lane.`,
        lines: [
          "You apply with your own price and a short note. Everyone approved in this lane can see it and apply.",
        ],
        cta: "Read the brief",
      };

    case "hired":
      return v.order_source === "offer"
        ? {
            title: `${biz} started your custom offer`,
            intro: `${biz} paid for ${job}. The job is in progress now.`,
            lines: [
              `Agreed price ${usd(v.price_cents)}. You keep ${usd(v.payout_cents)} after the 15% creator fee.`,
              "Their card has been charged and Zavi holds the money until the work is approved.",
            ],
            cta: "Open the job",
          }
        : {
            title: `You were hired for ${clamp(job, 120)}`,
            intro: `${biz} picked you from ${brief}. The job is in progress now.`,
            lines: [
              `Agreed price ${usd(v.price_cents)}. You keep ${usd(v.payout_cents)} after the 15% creator fee.`,
              "Their card has been charged and Zavi holds the money until the work is approved.",
            ],
            cta: "Open the job",
          };

    case "not_hired":
      return {
        title: `${biz} went with someone else`,
        intro: note.length > 0 ? note : `Thanks for applying to ${brief}. ${biz} picked another creator this time.`,
        lines: ["Your application is closed. Nothing was charged and nothing is owed."],
        cta: "See open briefs",
      };

    case "creator_accepted":
      return {
        title: `${creator} accepted your booking`,
        intro: `${creator} is starting on ${job}.`,
        lines: [
          `Your card has been charged ${usd(v.business_total_cents)}, which includes the 10% Zavi fee.`,
          "Zavi holds the money until you approve the work.",
        ],
        cta: "Open the job",
      };

    case "creator_passed":
      return {
        title: `${creator} passed on your booking`,
        intro: `${creator} is not taking ${job}.`,
        lines: [
          "Nothing was charged. The hold on your card has been released.",
          "You can book another creator whenever you are ready.",
        ],
        cta: "Find creators",
      };

    case "submission_received":
      return {
        title: `${creator} sent work for ${clamp(job, 100)}`,
        intro: `${creator} uploaded a draft for you to look at.`,
        lines: ["Accept it, or ask for changes that match what was ordered."],
        cta: "Review the work",
      };

    case "revision_requested":
      return {
        title: `${biz} asked for changes`,
        intro:
          note.length > 0
            ? note
            : `${biz} asked for changes on ${job}. The notes are in the job thread.`,
        lines: [
          "Changes have to match what was ordered. Anything outside it needs a new order or a custom offer.",
        ],
        cta: "Open the job",
      };

    case "due_date_nudge": {
      const from = extensionDay(v.extension_from);
      const to = extensionDay(v.extension_to);
      if (v.extension === "requested" && !forCreator) {
        return {
          title: `${creator} asked for more time on ${clamp(job, 100)}`,
          intro: `${creator} asked to move the due date${from && to ? ` from ${from} to ${to}` : ""}. Approve or decline it in the job. Until you answer, the due date stays ${from || "as agreed"}.`,
          lines: [],
          cta: "Answer in the job",
        };
      }
      if (v.extension === "approved" && forCreator) {
        return {
          title: `${biz} gave you more time on ${clamp(job, 100)}`,
          intro: `${biz} approved your request. Your draft is now due ${to || "on the new date"}.`,
          lines: [],
          cta: "Open the job",
        };
      }
      if (v.extension === "declined" && forCreator) {
        return {
          title: `${biz} kept the original due date for ${clamp(job, 100)}`,
          intro: `${biz} declined your request for more time. Your draft is still due ${from || "on the agreed date"}.`,
          lines: [],
          cta: "Open the job",
        };
      }
      return {
        title: `Delivery is due for ${clamp(job, 100)}`,
        intro: forCreator
          ? `Your draft for ${biz} is due.`
          : `${creator} is due to deliver ${job}.`,
        lines: [],
        cta: "Open the job",
      };
    }

    case "grace_nudge":
      return {
        title: `${clamp(job, 100)} is past its delivery date`,
        intro: forCreator
          ? `Your draft for ${biz} has not arrived yet.`
          : `${creator} has not delivered ${job} yet.`,
        lines: [],
        cta: "Open the job",
      };

    case "auto_accepted":
      return forCreator
        ? {
            title: "Your work was accepted automatically",
            intro: `${biz} did not review in time, so ${job} closed as accepted.`,
            lines: [
              `Your payout of ${usd(v.payout_cents)} is released after a 10 day buffer.`,
              "If the business asks Zavi to step in during the buffer, the money waits until Zavi decides.",
            ],
            cta: "See earnings",
          }
        : {
            title: `${clamp(job, 100)} closed as accepted`,
            intro: `Nobody reviewed the work in time, so the job closed as accepted.`,
            lines: [
              `${creator}'s agreed ${usd(v.price_cents)} is released after a 10 day buffer.`,
              "You can still ask Zavi to step in during the buffer.",
            ],
            cta: "Open the job",
          };

    case "approved":
      return {
        title: `${biz} approved your work`,
        intro: `${biz} accepted the delivery for ${job}.`,
        lines: [
          v.payout_waiting
            ? `Your payout of ${usd(v.payout_cents)} is waiting. Finish your Stripe setup and Zavi sends it.`
            : v.payout_sent === false
              ? `Your payout of ${usd(v.payout_cents)} has not been sent yet. Zavi is sorting it out.`
              : `Your payout of ${usd(v.payout_cents)} is on its way to Stripe now.`,
        ],
        cta: "See earnings",
      };

    case "paid":
      return {
        title: `You were paid ${usd(v.payout_cents)}`,
        intro: `Zavi sent ${usd(v.payout_cents)} to your Stripe account for ${job}.`,
        lines: ["Stripe decides when it lands in your bank, usually a couple of days."],
        cta: "See earnings",
      };

    case "payout_setup_needed":
      return {
        title: "Finish your Stripe setup to get paid",
        intro: "Your money is waiting. Zavi cannot send it until Stripe has your details.",
        lines: [
          "Stripe asks for your identity, your bank account and your tax details. Zavi never sees or stores your bank details.",
        ],
        cta: "Finish Stripe setup",
      };

    case "cancellation_requested":
      return {
        title: `${biz} asked to cancel ${clamp(job, 100)}`,
        intro: `${biz} wants to cancel the job.`,
        lines: [
          "If you agree, the job cancels and the business is refunded to the card.",
          "If you think that is wrong, you can ask Zavi to step in and a person will read the thread.",
        ],
        cta: "Answer the request",
      };

    case "cancellation_declined":
      return {
        title: `${clamp(job, 90)} is carrying on`,
        intro: forCreator
          ? `You declined the request to cancel ${job}, so the job carries on.`
          : `${creator} declined the request to cancel ${job}, so the job carries on.`,
        lines: [
          "Nothing was charged and nothing was refunded. The job is exactly where it was.",
          forCreator
            ? "If you would rather a person looked at this, you can still ask Zavi to step in."
            : "You can still ask Zavi to step in if you think that is wrong.",
        ],
        cta: "Open the job",
      };

    case "cancellation_revoked":
      return {
        title: `${clamp(job, 90)} is carrying on`,
        intro: forCreator
          ? `${biz} took back the request to cancel ${job}, so the job carries on.`
          : `You took back the request to cancel ${job}, so the job carries on.`,
        lines: [
          "Nothing was charged and nothing was refunded. The job is exactly where it was.",
        ],
        cta: "Open the job",
      };

    case "cancellation_outcome":
      return {
        title: `${clamp(job, 100)} was cancelled`,
        intro: note.length > 0 ? note : `${job} is cancelled and closed.`,
        lines: [
          forCreator
            ? "No payout is due on a cancelled job, and this does not count as a missed deadline."
            : refundLine(v, `${usd(v.refund_cents)} goes back to the card you paid with, including the 10% Zavi fee.`),
        ],
        cta: "Open the job",
      };

    case "dispute_opened":
      return {
        title: `Zavi was asked to step in on ${clamp(job, 90)}`,
        intro:
          note.length > 0
            ? note
            : "Someone asked Zavi to look at this job. A person on the Zavi team will read the brief, the submissions and the thread.",
        lines: ["The money waits where it is until Zavi decides. Nobody is paid and nobody is refunded in the meantime."],
        cta: "Open the job",
      };

    case "dispute_resolved":
      return {
        title: `Zavi decided on ${clamp(job, 100)}`,
        intro: note.length > 0 ? note : `Zavi has finished looking at ${job}.`,
        lines: [
          forCreator
            ? v.mediation === "refund"
              ? "Zavi refunded the business, so no payout is due on this job."
              : `Your payout for this job is ${usd(v.payout_cents)}.`
            : refundLine(
                v,
                typeof v.refund_cents === "number" && v.refund_cents > 0
                  ? `${usd(v.refund_cents)} goes back to your card.`
                  : "Nothing goes back to your card.",
              ),
        ],
        cta: "Open the job",
      };

    case "payment_failed":
      return forCreator
        ? {
            title: `The booking for ${clamp(job, 90)} was cancelled`,
            intro: `${biz} could not be charged, so the job is cancelled before it started.`,
            lines: [
              "This does not count against you and it is not a missed deadline.",
              "They can book you again once their card works.",
            ],
            cta: "Open your inbox",
          }
        : {
            title: `Your card could not be charged for ${clamp(job, 90)}`,
            intro:
              reason.length > 0
                ? `The charge for ${job} did not go through: ${reason}`
                : `The charge for ${job} did not go through.`,
            lines: [
              "The job is cancelled and nothing was charged. Book again once the card is ready.",
            ],
            cta: "Find creators",
          };

    case "tax_forms_ready": {
      const year = v.year ?? new Date().getUTCFullYear() - 1;
      return {
        title: `Your ${year} tax forms are ready`,
        intro: `Your ${year} tax forms for work done on Zavi are ready in Stripe.`,
        lines: ["Open Earnings and use the tax forms button to sign in to Stripe and download them."],
        cta: "Open earnings",
      };
    }

    case "creator_live":
      if (v.affiliate_only === true) {
        return {
          title: "Your affiliate link is ready",
          intro: "Share it anywhere. When someone you send subscribes to Zavi, you earn commission.",
          lines: [
            ...(v.affiliate_link ? [`Your link: ${v.affiliate_link}`] : []),
            "Say you are a Zavi affiliate when you share your link.",
          ],
          cta: "Open your affiliate page",
        };
      }
      return {
        title: "You're live on Zavi",
        intro: "Your first package is saved.",
        lines: [
          ...(v.country_missing === true ? ["Add your country and businesses can book you."] : []),
          ...(v.affiliate_link ? [`Your affiliate link is ready too: ${v.affiliate_link}`] : []),
        ],
        cta: "Go to your creator area",
      };

    case "country_needed":
      return {
        title: "Add your country so businesses can book you",
        intro: "Until you add it, you don't show up in Find creators.",
        lines: ["Zavi can pay creators in the US, Canada, the UK, the EEA and Switzerland."],
        cta: "Add your country",
      };

    default: {
      const never: never = event;
      throw new Error(`notify: no copy defined for event '${String(never)}'.`);
    }
  }
}

export const BUSINESS_NAME_FALLBACK = "A Zavi business";

export const REMINDER_AUDIENCE: Record<ReminderWindow, NotifyRecipient["kind"] | null> = {
  accept: "creator",
  review: "tenant",
  cancel_response: "creator",
  offer_expiry: null,
};

export const BUSINESS_ONLY_EVENTS: readonly string[] = [
  "brief_application_received",
  "custom_offer_accepted",
  "creator_accepted",
  "creator_passed",
  "submission_received",
  "product_received",
];

const REMINDER_TITLE: Record<ReminderWindow, string> = {
  accept: "Reminder: a booking is waiting for your answer",
  review: "Reminder: work is waiting for your review",
  cancel_response: "Reminder: a cancellation request is waiting for your answer",
  offer_expiry: "Reminder: a custom offer is waiting",
};

const REMINDER_INTRO: Record<ReminderWindow, string> = {
  accept: "You have not answered this booking request yet.",
  review: "You have not accepted this delivery or asked for changes yet.",
  cancel_response: "You have not answered this cancellation request yet.",
  offer_expiry: "This custom offer has not been accepted yet.",
};

async function resolveAddresses(recipient: NotifyRecipient): Promise<string[]> {
  if (recipient.kind === "creator") {
    const pii = await readPii(recipient.human_member_id);
    const email = (pii?.email ?? "").trim();
    return email.length > 0 ? [email] : [];
  }
  const rows = await resolveAgentEmailRecipients(recipient.tenant_id);
  return rows.map((r) => r.email).filter((e) => e.trim().length > 0);
}

async function dispatch(args: {
  recipient: NotifyRecipient;
  kind: string;
  title: string;
  intro: string;
  lines: string[];
  cta: string;
  link_path: string;
  order_id: string | null;
  dedupe_key: string;
  email_cta_url?: string | null;
  subject?: string;
  quote?: string;
  quoteFrom?: string;
  footer?: string;
}): Promise<NotifyResult> {
  const { recipient } = args;

  const title = clamp(args.title, 200);
  const intro = (args.intro ?? "").trim();
  const quote = (args.quote ?? "").trim();
  const lines = args.lines.map((l) => (l ?? "").trim()).filter((l) => l.length > 0);
  const bodyLines = [intro, quote, ...lines].filter((l) => l.length > 0);
  const body = clamp(bodyLines.join("\n\n"), 2000);
  const link_path = clamp(args.link_path.startsWith("/") ? args.link_path : "/", 500);

  const row = {
    recipient_kind: recipient.kind,
    tenant_id: recipient.kind === "tenant" ? recipient.tenant_id : null,
    human_member_id: recipient.kind === "creator" ? recipient.human_member_id : null,
    order_id: args.order_id,
    kind: clamp(args.kind, 64),
    title,
    body: body.length > 0 ? body : null,
    link_path,
    dedupe_key: args.dedupe_key,
  };

  const sb = creatorInboxClient(
    "creator network inbox: one table addresses tenants and creators, tenant_id is null on the creator half",
  );
  const inserted = await sb.from(TABLE).insert(row).select("id").single();

  if (inserted.error) {
    if (inserted.error.code === "23505") {
      return {
        written: false,
        emailed: false,
        notification_id: null,
        dedupe_key: args.dedupe_key,
        reason: "duplicate",
      };
    }
    throw new Error(`creator notify: inbox insert failed: ${inserted.error.message}`);
  }

  const notification_id = (inserted.data as { id: string } | null)?.id ?? null;

  let addresses: string[] = [];
  try {
    addresses = await resolveAddresses(recipient);
  } catch (e) {
    console.warn(`[creator-notify] recipient lookup failed for ${recipient.kind}: ${(e as Error).message}`);
  }
  if (addresses.length === 0) {
    return {
      written: true,
      emailed: false,
      notification_id,
      dedupe_key: args.dedupe_key,
      reason: "no_recipient_email",
    };
  }

  const forCreator = recipient.kind === "creator";
  const rendered = renderCreatorNotificationEmail({
    title,
    subject: args.subject ? clamp(args.subject, 200) : undefined,
    intro,
    quote: quote || undefined,
    quoteFrom: args.quoteFrom,
    lines,
    ctaText: args.cta,
    ctaUrl: safeEmailCtaUrl(args.email_cta_url) ?? `${webOrigin()}${link_path}`,
    kicker: forCreator ? "Zavi for creators" : "Zavi",
    eyebrow: forCreator ? "Your creator work" : "Your creators",
    footerNote: args.footer,
  });

  let emailed = false;
  for (const to of addresses) {
    try {
      await sgSend(to, rendered.subject, rendered.html, rendered.text);
      emailed = true;
    } catch (e) {
      console.warn(`[creator-notify] send failed for ${args.kind}: ${(e as Error).message}`);
    }
  }

  if (emailed && notification_id) {
    const upd = await sb
      .from(TABLE)
      .update({ emailed_at: new Date().toISOString() })
      .eq("id", notification_id);
    if (upd.error) {
      console.warn(`[creator-notify] emailed_at update failed: ${upd.error.message}`);
    }
  }

  return {
    written: true,
    emailed,
    notification_id,
    dedupe_key: args.dedupe_key,
    ...(emailed ? {} : { reason: "email_failed" as const }),
  };
}

function deadlineAudience(recipient: NotifyRecipient, v: NotifyVars): DeadlineAudience {
  return recipient.kind === "creator"
    ? { side: "creator", other_name: userText(v.business_name) || null }
    : { side: "business", other_name: firstWord(userText(v.creator_name)) };
}

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const v = input.vars ?? {};
  const order_id = input.order_id ?? null;
  const scope_id = input.scope_id ?? null;

  const copy = buildCopy(input.event, input.recipient.kind, v);

  const lines = [...copy.lines];
  if (v.deadline_kind && v.deadline_at) {
    lines.push(deadlineCopy(v.deadline_kind, v.deadline_at, deadlineAudience(input.recipient, v)).line);
  }

  return dispatch({
    recipient: input.recipient,
    kind: input.event,
    title: copy.title,
    intro: copy.intro,
    lines,
    cta: copy.cta,
    subject: copy.subject,
    quote: copy.quote,
    quoteFrom: copy.quoteFrom,
    footer: copy.footer,
    link_path:
      v.link_path ?? defaultLinkPath(input.recipient.kind, input.event, order_id, scope_id),
    order_id,
    email_cta_url: input.email_cta_url ?? null,
    dedupe_key:
      input.dedupe_key ??
      buildDedupeKey({
        scope: order_id ?? scope_id ?? "none",
        event: input.event,
        window: input.dedupe_window ?? "once",
        recipient: input.recipient,
      }),
  });
}

export async function notifyBothSides(args: {
  event: CreatorNotificationEvent;
  tenant_id: string;
  human_member_id: string;
  order_id?: string | null;
  scope_id?: string | null;
  vars?: NotifyVars;
  dedupe_window?: string | null;
}): Promise<{ creator: NotifyResult | null; tenant: NotifyResult | null }> {
  const base = {
    event: args.event,
    order_id: args.order_id,
    scope_id: args.scope_id,
    vars: args.vars,
    dedupe_window: args.dedupe_window,
  };
  const settled = await Promise.allSettled([
    notify({ ...base, recipient: { kind: "creator", human_member_id: args.human_member_id } }),
    notify({ ...base, recipient: { kind: "tenant", tenant_id: args.tenant_id } }),
  ]);
  const [c, t] = settled;
  const out = {
    creator: c.status === "fulfilled" ? c.value : null,
    tenant: t.status === "fulfilled" ? t.value : null,
  };
  const failed = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason;
  return out;
}

export async function sendWindowReminder(args: {
  window: ReminderWindow;
  at_hours: ReminderHour;
  deadline_at: string | Date;
  recipient: NotifyRecipient;
  order_id?: string | null;
  scope_id?: string | null;
  vars?: NotifyVars;
}): Promise<NotifyResult> {
  const v = args.vars ?? {};
  const order_id = args.order_id ?? null;
  const scope_id = args.scope_id ?? null;
  const dl = deadlineCopy(args.window, args.deadline_at, deadlineAudience(args.recipient, v));

  const job = name(userText(v.job_title), "the job");
  const kind = `reminder_${args.window}_${args.at_hours}h`;

  return dispatch({
    recipient: args.recipient,
    kind,
    title: REMINDER_TITLE[args.window],
    intro: `${REMINDER_INTRO[args.window]} This is about ${job}.`,
    lines: [dl.line],
    cta: "Open it now",
    link_path:
      v.link_path ??
      defaultLinkPath(args.recipient.kind, "reminder", order_id, scope_id),
    order_id,
    dedupe_key: buildDedupeKey({
      scope: order_id ?? scope_id ?? "none",
      event: `reminder_${args.window}`,
      window: `${args.at_hours}h:${new Date(args.deadline_at).getTime()}`,
      recipient: args.recipient,
    }),
  });
}

export { deadlineCopy } from "./deadline-copy";
export type { DeadlineKind, DeadlineCopy } from "./deadline-copy";
