
import { ExpectedToolError } from "@/services/tools/types";
import { computeCreatorFees, type CreatorFeeBreakdown } from "./order-fees";
import { creatorPayoutCountrySupported, CREATOR_PAYOUT_COUNTRIES } from "./payout-countries";
import { creatorStripeClient, platformKeyLivemode } from "./client";
import { createCreatorCheckoutHold, resumeCreatorCheckout } from "./orders-money";
import { applyCreatorOrderTransition } from "./order-transitions";
import { deadlineCopy, dueAfterAcceptText, type DeadlineAudience, type DeadlineCopy } from "./deadline-copy";
import { ACCEPT_WINDOW_HOURS, agentHirePendingDeadline, agreedDueAt, checkoutPendingDeadline, firstWord, offerPayableUntil, type CreatorOrderDeadline } from "./deadlines";
import { armCreatorDeadlineTimer } from "./arm-timers";
import { scrubContact } from "./contact-scrub";
import { adRightsDays } from "./brief-projection";
import {
  attachCheckoutSession,
  findPendingBooking,
  insertCreatorOrder,
  loadBookableCreator,
  loadBookableOffer,
  loadBookablePackage,
  loadBriefForHire,
  loadHireableApplication,
  loadOrderForCheckout,
  markOfferAccepted,
  offerTitle,
  refreshPendingBooking,
  type BookableCreator,
} from "./booking-db";
import type { CreatorOrderStateRow } from "./orders-db";

export const LARGE_AMOUNT_CONFIRM_CENTS = 50_000;

export function needsLargeAmountConfirm(business_total_cents: number): boolean {
  return business_total_cents > LARGE_AMOUNT_CONFIRM_CENTS;
}

export type BookingTarget =
  | { source: "booking"; package_id: string }
  | { source: "offer"; offer_id: string }
  | { source: "applicant"; application_id: string };

type Resolved = {
  source: "booking" | "offer" | "applicant";
  creator: BookableCreator;
  price_cents: number;
  delivery_days: number | null;
  title: string;
  kind: "ugc_video";
  package_id: string | null;
  offer_id: string | null;
  application_id: string | null;
  brief_id: string | null;
  thread_id: string | null;
  package_snapshot: Record<string, unknown>;
  brief_snapshot: Record<string, unknown> | null;
  brief_prefill: BookingBriefPrefill | null;
  product_needed: boolean;
  blocked: BookingBlock | null;
  offer_expires_at?: string;
  offer_agent_run_id?: string | null;
};

export type BookingBlock = { code: string; message: string };

export type BookingBriefPrefill = {
  brief_id: string;
  title: string;
  angle: string;
  hook: string;
  format: string;
  deliverables: number | null;
};

export type CreatorBookingQuote = {
  source: "booking" | "offer" | "applicant";
  creator: {
    human_member_id: string;
    display_name: string;
    slug: string | null;
    city: string | null;
    country_code: string | null;
    payout_supported: boolean;
  };
  job: {
    title: string;
    kind: "ugc_video";
    delivery_days: number | null;
    package_id: string | null;
    offer_id: string | null;
    application_id: string | null;
    brief_id: string | null;
  };
  brief_prefill: BookingBriefPrefill | null;
  money: {
    currency: "usd";
    price_cents: number;
    business_fee_cents: number;
    business_total_cents: number;
    business_fee_label: string;
  };
  due_at: string | null;
  due_deadline: DeadlineCopy | null;
  due_after_accept: string | null;
  product_needed: boolean;
  accept_window: { hours: number; consequence_text: string } | null;
  charge_now_text: string | null;
  needs_large_amount_confirm: boolean;
  large_amount_confirm_cents: number;
  blocked: BookingBlock | null;
};

const FEE_LABEL = "10%";

export type BookingDeps = {
  loadCreator: typeof loadBookableCreator;
  loadPackage: typeof loadBookablePackage;
  loadOffer: typeof loadBookableOffer;
  loadApplication: typeof loadHireableApplication;
  loadBrief: typeof loadBriefForHire;
  insertOrder: typeof insertCreatorOrder;
  attachSession: typeof attachCheckoutSession;
  markOfferAccepted: typeof markOfferAccepted;
  openCheckout: typeof createCreatorCheckoutHold;
  livemode: () => boolean;
  now: () => Date;
  armDeadline?: typeof armCreatorDeadlineTimer;
  findPendingBooking?: typeof findPendingBooking;
  refreshPendingBooking?: typeof refreshPendingBooking;
  supersedePendingBooking?: (tenant_id: string, order_id: string) => Promise<void>;
  resumeCheckout?: typeof resumeCreatorCheckout;
  loadCheckoutOrder?: typeof loadOrderForCheckout;
};

async function supersedePendingBooking(tenant_id: string, order_id: string): Promise<void> {
  const order = await loadOrderForCheckout(tenant_id, order_id);
  if (!order || order.status === "cancelled") return;
  if (order.status !== "checkout_pending") throw alreadyPaid();
  if (order.stripe_checkout_session_id) {
    const stripe = creatorStripeClient();
    const session = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);
    if (session.status === "complete") throw alreadyPaid();
    if (session.status === "open") {
      try {
        await stripe.checkout.sessions.expire(session.id);
      } catch (e) {
        const again = await stripe.checkout.sessions.retrieve(session.id).catch(() => null);
        if (again?.status === "complete") throw alreadyPaid();
        throw e;
      }
    }
  }
  await applyCreatorOrderTransition({
    tenant_id,
    order_id,
    trigger: "checkout_abandoned",
    actor: "system",
  });
  const after = await loadOrderForCheckout(tenant_id, order_id);
  if (after && after.status !== "cancelled") throw alreadyPaid();
}

function alreadyPaid(): ExpectedToolError {
  return new ExpectedToolError(
    "already_booked",
    "You already paid for this package with this creator. Open it from Jobs.",
  );
}

export const realBookingDeps: BookingDeps = {
  loadCreator: loadBookableCreator,
  loadPackage: loadBookablePackage,
  loadOffer: loadBookableOffer,
  loadApplication: loadHireableApplication,
  loadBrief: loadBriefForHire,
  insertOrder: insertCreatorOrder,
  attachSession: attachCheckoutSession,
  markOfferAccepted,
  openCheckout: createCreatorCheckoutHold,
  livemode: () => platformKeyLivemode(),
  now: () => new Date(),
  armDeadline: armCreatorDeadlineTimer,
  findPendingBooking,
  refreshPendingBooking,
  supersedePendingBooking,
  resumeCheckout: resumeCreatorCheckout,
  loadCheckoutOrder: loadOrderForCheckout,
};

export const AGENT_HIRE_AWAITING_APPROVAL_CODE = "creator_hire_awaiting_approval";
export const AGENT_HIRE_AWAITING_APPROVAL_MESSAGE = "This hire is waiting for the founder's approval on its hire card.";

export function agentHireAwaitingApproval(): ExpectedToolError {
  return new ExpectedToolError(AGENT_HIRE_AWAITING_APPROVAL_CODE, AGENT_HIRE_AWAITING_APPROVAL_MESSAGE);
}

export async function refuseAgentHireCheckout(
  tenant_id: string,
  order_id: string,
  load: typeof loadOrderForCheckout = loadOrderForCheckout,
): Promise<void> {
  const order = await load(tenant_id, order_id);
  if (order?.agent_run_id) throw agentHireAwaitingApproval();
}

export function agentHireDeadline(now: Date, offer_expires_at?: string | null): CreatorOrderDeadline {
  const hold = agentHirePendingDeadline(now);
  const offerEnd = offer_expires_at ? Date.parse(offer_expires_at) : Number.NaN;
  if (!Number.isFinite(offerEnd) || offerEnd >= Date.parse(hold.deadline_at)) return hold;
  return { kind: hold.kind, deadline_at: new Date(offerEnd).toISOString() };
}

const DAY_MS = 86_400_000;

export function quotedRateToCents(quoted_rate_usd: number | null): number | null {
  if (quoted_rate_usd == null) return null;
  const n = Number(quoted_rate_usd);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return Number.isInteger(cents) && cents > 0 ? cents : null;
}

function creatorBlock(creator: BookableCreator | null): BookingBlock | null {
  if (!creator) {
    return { code: "creator_not_found", message: "That creator is no longer on Zavi." };
  }
  if (creator.vetting_state !== "approved") {
    return {
      code: "creator_not_available",
      message: "This creator is not taking new work on Zavi right now.",
    };
  }
  if (!creator.country_code || !creatorPayoutCountrySupported(creator.country_code)) {
    return {
      code: "creator_payout_country_unsupported",
      message: `Zavi cannot pay creators in this country yet, so this creator cannot be booked. Payouts currently reach ${CREATOR_PAYOUT_COUNTRIES.size} countries (the US, Canada, the UK, the EEA and Switzerland).`,
    };
  }
  return null;
}

async function resolveBookingBrief(
  tenant_id: string,
  brief_id: string | null | undefined,
  deps: BookingDeps,
): Promise<BookingBriefPrefill | null> {
  if (!brief_id) return null;
  try {
    const brief = await deps.loadBrief(tenant_id, brief_id);
    if (!brief) return null;
    return {
      brief_id: brief.id,
      title: brief.title ?? "",
      angle: brief.angle ?? "",
      hook: brief.hook ?? "",
      format: brief.format ?? "",
      deliverables: brief.deliverables ?? null,
    };
  } catch {
    return null;
  }
}

async function resolveTarget(
  tenant_id: string,
  target: BookingTarget,
  deps: BookingDeps,
  opts: { offer_already_claimed?: boolean; brief_id?: string | null; product_needed?: boolean } = {},
): Promise<Resolved> {
  if (target.source === "booking") {
    const pkg = await deps.loadPackage(target.package_id);
    if (!pkg) {
      throw new ExpectedToolError("package_not_found", "That package is no longer offered.");
    }
    const creator = await deps.loadCreator(pkg.human_member_id);
    const blocked =
      creatorBlock(creator) ??
      (pkg.active && pkg.kind === "ugc_video"
        ? null
        : { code: "package_inactive", message: "This package is not being offered right now." });
    const brief_prefill = await resolveBookingBrief(tenant_id, opts.brief_id, deps);
    return {
      source: "booking",
      creator: creator ?? missingCreator(pkg.human_member_id),
      price_cents: pkg.price_cents,
      delivery_days: pkg.delivery_days,
      title: pkg.title,
      kind: "ugc_video",
      package_id: pkg.id,
      offer_id: null,
      application_id: null,
      brief_id: brief_prefill?.brief_id ?? null,
      thread_id: null,
      package_snapshot: {
        title: pkg.title,
        kind: "ugc_video",
        description: pkg.description,
        delivery_days: pkg.delivery_days,
        video_count: pkg.video_count,
        video_length_seconds: pkg.video_length_seconds,
        ad_rights_days: pkg.ad_rights_days,
        addons: pkg.addons,
        creator_country_code: creator?.country_code ?? null,
        creator_display_name: creator?.display_name ?? null,
        creator_slug: creator?.slug ?? null,
        booked_from: "package",
      },
      brief_snapshot: null,
      brief_prefill,
      product_needed: opts.product_needed === true,
      blocked,
    };
  }

  if (target.source === "offer") {
    const offer = await deps.loadOffer(tenant_id, target.offer_id);
    if (!offer) {
      throw new ExpectedToolError("offer_not_found", "That offer is not in this workspace.");
    }
    const creator = await deps.loadCreator(offer.human_member_id);
    const payableUntil = offerPayableUntil(offer.expires_at, offer.terms);
    const expired = Date.parse(payableUntil) <= deps.now().getTime();
    const offerGate = opts.offer_already_claimed
      ? offer.status !== "accepted"
        ? { code: "offer_not_open", message: `This offer was already ${offer.status}.` }
        : null
      : offer.status !== "open"
        ? { code: "offer_not_open", message: `This offer was already ${offer.status}.` }
        : expired
          ? {
              code: "offer_expired",
              message: "This offer has expired. Ask the creator to send a new one.",
            }
          : offer.proposed_by !== "creator"
            ?
              {
                code: "offer_not_agreed",
                message: "The creator has not accepted this offer yet. You can pay once they accept it.",
              }
            : null;
    const kindGate =
      offer.kind === "ugc_video"
        ? null
        : { code: "offer_not_open", message: "This offer is no longer open." };
    const blocked = creatorBlock(creator) ?? kindGate ?? offerGate;
    return {
      offer_expires_at: payableUntil,
      offer_agent_run_id: offer.agent_run_id ?? null,
      source: "offer",
      creator: creator ?? missingCreator(offer.human_member_id),
      price_cents: offer.price_cents,
      delivery_days: offer.delivery_days,
      title: offerTitle(offer),
      kind: "ugc_video",
      package_id: null,
      offer_id: offer.id,
      application_id: null,
      brief_id: null,
      thread_id: offer.thread_id,
      package_snapshot: {
        title: offerTitle(offer),
        kind: "ugc_video",
        description: offer.note,
        delivery_days: offer.delivery_days,
        terms: offer.terms,
        proposed_by: offer.proposed_by,
        creator_country_code: creator?.country_code ?? null,
        creator_display_name: creator?.display_name ?? null,
        creator_slug: creator?.slug ?? null,
        booked_from: "custom_offer",
      },
      brief_snapshot: null,
      brief_prefill: null,
      product_needed: offer.product_needed === true,
      blocked,
    };
  }

  const application = await deps.loadApplication(tenant_id, target.application_id);
  if (!application) {
    throw new ExpectedToolError(
      "application_not_found",
      "That application is not in this workspace.",
    );
  }
  const brief = await deps.loadBrief(tenant_id, application.brief_id);
  const creator = await deps.loadCreator(application.human_member_id);
  const price_cents = quotedRateToCents(application.quoted_rate_usd);
  const blocked =
    creatorBlock(creator) ??
    (price_cents == null
      ? {
          code: "applicant_has_no_price",
          message: "This applicant did not quote a price, so there is nothing to charge.",
        }
      : brief?.lane != null && brief.lane !== "ugc_video"
        ? { code: "application_closed", message: "This brief is no longer open." }
        : application.status === "hired" || application.status === "accepted"
          ? { code: "already_hired", message: "This applicant has already been hired." }
          : application.status === "withdrawn" || application.status === "declined"
            ? {
                code: "application_closed",
                message: `This application was already ${application.status}.`,
              }
            : null);
  return {
    source: "applicant",
    creator: creator ?? missingCreator(application.human_member_id),
    price_cents: price_cents ?? 0,
    delivery_days: brief?.delivery_days ?? null,
    title: brief?.title ?? "Brief job",
    kind: "ugc_video",
    package_id: null,
    offer_id: null,
    application_id: application.id,
    brief_id: application.brief_id,
    thread_id: null,
    package_snapshot: {
      title: brief?.title ?? "Brief job",
      kind: "ugc_video",
      description: application.pitch,
      delivery_days: brief?.delivery_days ?? null,
      ad_rights_days: adRightsDays(brief?.ad_rights_days),
      creator_country_code: creator?.country_code ?? null,
      creator_display_name: creator?.display_name ?? null,
      creator_slug: creator?.slug ?? null,
      booked_from: "brief_applicant",
    },
    brief_snapshot: brief
      ? {
          id: brief.id,
          title: brief.title,
          lane: brief.lane,
          delivery_days: brief.delivery_days,
          deliverables: brief.deliverables,
          utm_campaign: brief.utm_campaign,
        }
      : null,
    brief_prefill: null,
    product_needed: brief?.product_needed === true,
    blocked,
  };
}

function missingCreator(id: string): BookableCreator {
  return {
    id,
    display_name: "",
    slug: null,
    city: null,
    country_code: null,
    vetting_state: "rejected",
  };
}

export function defaultDueAt(now: Date, delivery_days: number | null): string {
  const days = delivery_days && delivery_days > 0 ? delivery_days : 7;
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

function orderDueAt(
  r: { source: string; product_needed: boolean; delivery_days: number | null; package_snapshot: Record<string, unknown> },
  requested: string | null | undefined,
  now: Date,
): string | null {
  if (r.product_needed || r.source === "booking") return null;
  if (r.source === "offer") return agreedDueAt(r.package_snapshot["terms"]) ?? defaultDueAt(now, r.delivery_days);
  if (requested) return validateDueAt(requested, now);
  return defaultDueAt(now, r.delivery_days);
}

export function validateDueAt(due_at: string, now: Date): string {
  const t = new Date(due_at).getTime();
  if (Number.isNaN(t)) {
    throw new ExpectedToolError("invalid_due_date", "That delivery date is not a real date.");
  }
  if (t <= now.getTime()) {
    throw new ExpectedToolError(
      "invalid_due_date",
      "The delivery date has to be in the future.",
    );
  }
  if (t > now.getTime() + 365 * DAY_MS) {
    throw new ExpectedToolError(
      "invalid_due_date",
      "The delivery date cannot be more than a year out.",
    );
  }
  return new Date(t).toISOString();
}

export function chargeNowText(source: CreatorBookingQuote["source"]): string | null {
  if (source === "offer") {
    return "Paying charges your card now and starts the job, because the offer is already agreed. Zavi holds the money until you approve the work.";
  }
  if (source === "applicant") {
    return "Paying charges your card now and hires this applicant. The job starts straight away, and Zavi holds the money until you approve the work.";
  }
  return null;
}

export async function quoteCreatorBooking(
  args: {
    tenant_id: string;
    target: BookingTarget;
    due_at?: string;
    brief_id?: string | null;
    product_needed?: boolean;
  },
  deps: BookingDeps = realBookingDeps,
): Promise<CreatorBookingQuote> {
  const now = deps.now();
  const r = await resolveTarget(args.tenant_id, args.target, deps, {
    brief_id: args.brief_id,
    product_needed: args.product_needed,
  });

  const fees: CreatorFeeBreakdown =
    r.price_cents > 0
      ? computeCreatorFees(r.price_cents)
      : {
          price_cents: 0,
          business_fee_cents: 0,
          business_total_cents: 0,
          creator_fee_cents: 0,
          creator_payout_cents: 0,
          zavi_gross_cents: 0,
          currency: "usd",
        };

  const due_at = orderDueAt(r, args.due_at, now);
  const audience: DeadlineAudience = { side: "business", other_name: firstWord(r.creator.display_name) };

  return {
    source: r.source,
    creator: {
      human_member_id: r.creator.id,
      display_name: r.creator.display_name,
      slug: r.creator.slug,
      city: r.creator.city,
      country_code: r.creator.country_code,
      payout_supported: creatorPayoutCountrySupported(r.creator.country_code ?? ""),
    },
    job: {
      title: r.title,
      kind: r.kind,
      delivery_days: r.delivery_days,
      package_id: r.package_id,
      offer_id: r.offer_id,
      application_id: r.application_id,
      brief_id: r.brief_id,
    },
    brief_prefill: r.brief_prefill,
    money: {
      currency: "usd",
      price_cents: fees.price_cents,
      business_fee_cents: fees.business_fee_cents,
      business_total_cents: fees.business_total_cents,
      business_fee_label: FEE_LABEL,
    },
    due_at,
    due_deadline: due_at ? deadlineCopy("due", due_at, audience) : null,
    due_after_accept:
      r.source === "booking" && !r.product_needed
        ? dueAfterAcceptText(r.delivery_days && r.delivery_days > 0 ? r.delivery_days : 7, audience)
        : null,
    product_needed: r.product_needed,
    accept_window:
      r.source === "applicant" || r.source === "offer"
        ?
          null
        : {
            hours: ACCEPT_WINDOW_HOURS,
            consequence_text: deadlineCopy("accept", now, audience).consequence_text,
          },
    charge_now_text: r.blocked ? null : chargeNowText(r.source),
    needs_large_amount_confirm: needsLargeAmountConfirm(fees.business_total_cents),
    large_amount_confirm_cents: LARGE_AMOUNT_CONFIRM_CENTS,
    blocked: r.blocked,
  };
}

export type StartCheckoutArgs = {
  tenant_id: string;
  user_id: string | null;
  user_email?: string | null;
  target: BookingTarget;
  due_at?: string;
  product_needed?: boolean;
  large_amount_confirmed?: boolean;
  success_url?: string;
  cancel_url?: string;
  initiator?: "agent";
  agent_run_id?: string | null;
  brief_snapshot_override?: Record<string, unknown> | null;
  offer_already_claimed?: boolean;
  brief_id?: string | null;
};

export const BOOKING_BRIEF_TITLE_MAX = 200;
export const BOOKING_BRIEF_BODY_MAX = 4000;

export function bookingBriefSnapshot(input: {
  title?: string | null;
  brief?: string | null;
}): Record<string, unknown> | null {
  const title = scrubContact((input.title ?? "").trim().slice(0, BOOKING_BRIEF_TITLE_MAX)).body;
  const brief = scrubContact((input.brief ?? "").trim().slice(0, BOOKING_BRIEF_BODY_MAX)).body;
  if (!title && !brief) return null;
  return { ...(title ? { title } : {}), ...(brief ? { brief } : {}) };
}

export type StartCheckoutResult = {
  order_id: string;
  checkout_url: string | null;
  checkout_session_id: string | null;
  quote: CreatorBookingQuote;
  reused_existing: boolean;
};

export async function startCreatorCheckout(
  args: StartCheckoutArgs,
  deps: BookingDeps = realBookingDeps,
): Promise<StartCheckoutResult> {
  const now = deps.now();
  const agent = args.initiator === "agent";
  const agentRunId = typeof args.agent_run_id === "string" && args.agent_run_id ? args.agent_run_id : null;
  if (agent && !agentRunId) {
    throw new Error("startCreatorCheckout: an agent hire needs the agent_run_id that proposed it");
  }
  if (!agent && agentRunId) {
    throw new Error("startCreatorCheckout: agent_run_id is only for an agent hire");
  }
  if (!agent && (typeof args.success_url !== "string" || typeof args.cancel_url !== "string")) {
    throw new Error("startCreatorCheckout: success_url and cancel_url are required");
  }
  const r = await resolveTarget(args.tenant_id, args.target, deps, {
    offer_already_claimed: args.offer_already_claimed === true,
    brief_id: args.brief_id,
    product_needed: args.product_needed,
  });
  if (r.offer_agent_run_id && !agent) throw agentHireAwaitingApproval();
  if (agent && r.offer_agent_run_id && r.offer_agent_run_id !== agentRunId) {
    throw new Error("startCreatorCheckout: this offer belongs to a different agent run");
  }
  if (r.blocked) {
    throw new ExpectedToolError(r.blocked.code, r.blocked.message);
  }

  const fees = computeCreatorFees(r.price_cents);

  if (!agent && needsLargeAmountConfirm(fees.business_total_cents) && args.large_amount_confirmed !== true) {
    throw new ExpectedToolError(
      "large_amount_confirm_required",
      `This job comes to $${(fees.business_total_cents / 100).toFixed(2)}, which is over $${LARGE_AMOUNT_CONFIRM_CENTS / 100}. Confirm the amount before Zavi holds it on the card.`,
    );
  }

  const due_at = orderDueAt(r, args.due_at, now);

  const checkoutDeadline = agent
    ? agentHireDeadline(now, r.source === "offer" ? r.offer_expires_at : null)
    : checkoutPendingDeadline({ source: r.source, now, offer_expires_at: r.offer_expires_at });
  const insertRow = {
    tenant_id: args.tenant_id,
    human_member_id: r.creator.id,
    source: r.source,
    package_id: r.package_id,
    offer_id: r.offer_id,
    application_id: r.application_id,
    brief_id: r.brief_id,
    thread_id: r.thread_id,
    booked_by_user_id: args.user_id,
    package_snapshot: r.package_snapshot,
    brief_snapshot:
      (r.source === "applicant" || r.source === "booking") &&
      args.brief_snapshot_override !== undefined
        ? args.brief_snapshot_override
        : r.brief_snapshot,
    price_cents: fees.price_cents,
    business_fee_cents: fees.business_fee_cents,
    creator_fee_cents: fees.creator_fee_cents,
    due_at,
    product_needed: r.product_needed,
    livemode: deps.livemode(),
    checkout_deadline: checkoutDeadline,
    agent_run_id: agentRunId,
  };

  const briefId = r.brief_id ?? null;
  const sameTerms = (o: CreatorOrderStateRow & { brief_id?: string | null }) =>
    o.price_cents === fees.price_cents &&
    o.business_total_cents === fees.business_total_cents &&
    (o.product_needed === true) === (r.product_needed === true) &&
    (o.brief_id ?? null) === briefId;
  const reuseOrSupersede = async (
    o: CreatorOrderStateRow & { brief_id?: string | null },
  ): Promise<CreatorOrderStateRow | null> => {
    if (sameTerms(o)) {
      const refreshed = deps.refreshPendingBooking
        ? await deps.refreshPendingBooking({
            tenant_id: args.tenant_id,
            order_id: o.id,
            brief_snapshot: insertRow.brief_snapshot,
            due_at: due_at,
          })
        : null;
      return refreshed ?? o;
    }
    if (!deps.supersedePendingBooking) return o;
    await deps.supersedePendingBooking(args.tenant_id, o.id);
    return null;
  };
  const isDirectBooking = r.source === "booking" && !!r.package_id;

  let order: CreatorOrderStateRow | null = null;
  let reused = false;
  if (isDirectBooking && deps.findPendingBooking) {
    const pending = await deps.findPendingBooking({
      tenant_id: args.tenant_id,
      human_member_id: r.creator.id,
      package_id: r.package_id as string,
      booked_by_user_id: args.user_id,
    });
    if (pending) {
      order = await reuseOrSupersede(pending);
      reused = order !== null;
    }
  }

  for (let attempt = 0; !order && attempt < 2; attempt++) {
    const inserted = await deps.insertOrder(insertRow);
    if (inserted.ok) {
      order = inserted.order;
      break;
    }
    if (!inserted.existing) {
      throw new ExpectedToolError(
        "already_booked",
        "This has already been booked. Open it from Jobs.",
      );
    }
    if (inserted.existing.status !== "checkout_pending") {
      throw new ExpectedToolError(
        "already_booked",
        "This has already been booked and paid for. Open it from Jobs.",
      );
    }
    order = isDirectBooking ? await reuseOrSupersede(inserted.existing) : inserted.existing;
    reused = order !== null;
  }
  if (!order) {
    throw new ExpectedToolError("already_booked", "This booking changed while you were booking it. Open it from Jobs.");
  }

  if (r.source === "offer" && r.offer_id && !reused) {
    await deps.markOfferAccepted(args.tenant_id, r.offer_id);
  }

  if (agent) {
    if (!reused && deps.armDeadline) {
      await deps
        .armDeadline({ order_id: order.id, tenant_id: args.tenant_id, deadline: checkoutDeadline })
        .catch(() => {});
    }
    return {
      order_id: order.id,
      checkout_url: null,
      checkout_session_id: null,
      quote: await quoteCreatorBooking(
        {
          tenant_id: args.tenant_id,
          target: args.target,
          due_at: due_at ?? undefined,
          brief_id: args.brief_id,
          product_needed: args.product_needed,
        },
        deps,
      ),
      reused_existing: reused,
    };
  }

  if (reused && deps.loadCheckoutOrder) {
    await refuseAgentHireCheckout(args.tenant_id, order.id, deps.loadCheckoutOrder);
  }

  const success_url = (args.success_url as string).replace("{ORDER_ID}", encodeURIComponent(order.id));
  const cancel_url = (args.cancel_url as string).replace("{ORDER_ID}", encodeURIComponent(order.id));
  let hold: { checkout_session_id: string; url: string | null; amount_cents: number };
  if (reused && deps.resumeCheckout) {
    const resumed = await deps.resumeCheckout({
      tenant_id: args.tenant_id,
      order_id: order.id,
      creator_country: r.creator.country_code ?? "",
      success_url,
      cancel_url,
      product_name: r.title,
      customer_email: args.user_email ?? null,
    });
    hold = resumed;
    if (!resumed.reused_session) {
      await deps.attachSession({
        tenant_id: args.tenant_id,
        order_id: order.id,
        checkout_session_id: resumed.checkout_session_id,
      });
    }
  } else {
    hold = await deps.openCheckout({
      tenant_id: args.tenant_id,
      order_id: order.id,
      creator_country: r.creator.country_code ?? "",
      success_url,
      cancel_url,
      product_name: r.title,
      customer_email: args.user_email ?? null,
    });
    await deps.attachSession({
      tenant_id: args.tenant_id,
      order_id: order.id,
      checkout_session_id: hold.checkout_session_id,
    });
  }

  if (!reused && deps.armDeadline) {
    await deps
      .armDeadline({ order_id: order.id, tenant_id: args.tenant_id, deadline: checkoutDeadline })
      .catch(() => {});
  }

  if (hold.amount_cents !== fees.business_total_cents) {
    throw new ExpectedToolError(
      "checkout_amount_mismatch",
      "The amount at checkout does not match the amount quoted. Nothing was charged.",
    );
  }

  return {
    order_id: order.id,
    checkout_url: hold.url,
    checkout_session_id: hold.checkout_session_id,
    quote: await quoteCreatorBooking(
      {
        tenant_id: args.tenant_id,
        target: args.target,
        due_at: due_at ?? undefined,
        brief_id: args.brief_id,
        product_needed: args.product_needed,
      },
      deps,
    ),
    reused_existing: reused,
  };
}
