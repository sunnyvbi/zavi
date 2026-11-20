
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { computeCreatorFees, type CreatorFeeBreakdown } from "./order-fees";
import { assertCreatorPayoutCountry, creatorPayoutCountrySupported } from "./payout-countries";
import { startCreatorCheckout } from "./booking";
import { loadOrderForCheckout } from "./booking-db";
import { applyCreatorOrderTransition } from "./order-transitions";
import { readCreatorHold } from "./orders-money";
import { creatorVisibleBrief } from "./brief-projection";
import { DELIVERY_DAYS_RANGE, quotedRateToCents } from "./briefs";
import { sendAutomaticNos, realAutoNoDeps, type AutoNoDeps, type AutoNoResult } from "./brief-applications";
import {
  claimBriefForHire,
  releaseBriefClaim,
  claimApplicationForHire,
  loadApplicantProfiles,
  loadTenantBrief,
  releaseApplicationHireClaim,
  resolveBusinessName,
  type BriefApplicationRow,
  type TenantBriefRow,
} from "./briefs-db";

export const DEFAULT_DELIVERY_DAYS = 7;

export type BriefOrderPort = {
  startApplicantCheckout(args: {
    tenant_id: string;
    user_id: string | null;
    application_id: string;
    due_at: string;
    large_amount_confirmed?: boolean;
    brief_snapshot: Record<string, unknown>;
    success_url: string;
    cancel_url: string;
  }): Promise<{
    order_id: string;
    checkout_session_id: string;
    checkout_url: string | null;
  }>;
};

export const realBriefOrderPort: BriefOrderPort = {
  async startApplicantCheckout(args) {
    const r = await startCreatorCheckout({
      tenant_id: args.tenant_id,
      user_id: args.user_id,
      target: { source: "applicant", application_id: args.application_id },
      due_at: args.due_at,
      large_amount_confirmed: args.large_amount_confirmed,
      brief_snapshot_override: args.brief_snapshot,
      success_url: args.success_url,
      cancel_url: args.cancel_url,
    });
    if (r.checkout_session_id === null) {
      throw new Error("startApplicantCheckout: no Checkout session was opened");
    }
    return {
      order_id: r.order_id,
      checkout_session_id: r.checkout_session_id,
      checkout_url: r.checkout_url,
    };
  },
};

export type HireRefusal =
  | "brief_not_found"
  | "application_not_found"
  | "application_not_pending"
  | "brief_not_posted"
  | "brief_closed"
  | "no_quote"
  | "payout_country_unsupported"
  | "due_date_invalid";

export type HireApplicantResult =
  | {
      ok: true;
      order_id: string;
      application_id: string;
      due_at: string | null;
      fees: CreatorFeeBreakdown;
      checkout_url: string | null;
      checkout_session_id: string;
    }
  | { ok: false; code: HireRefusal; message: string };

export type HireDeps = {
  loadBrief: typeof loadTenantBrief;
  loadApplication: (args: {
    tenant_id: string;
    application_id: string;
  }) => Promise<BriefApplicationRow | null>;
  claimApplication: typeof claimApplicationForHire;
  releaseClaim: typeof releaseApplicationHireClaim;
  profiles: typeof loadApplicantProfiles;
  businessName: typeof resolveBusinessName;
  orders: BriefOrderPort;
  now: () => Date;
  log: typeof logEvent;
};

export async function hireApplicant(
  args: {
    tenant_id: string;
    brief_id: string;
    application_id: string;
    booked_by_user_id: string | null;
    delivery_days?: number | null;
    large_amount_confirmed?: boolean;
    success_url: string;
    cancel_url: string;
  },
  deps: HireDeps,
): Promise<HireApplicantResult> {
  const now = deps.now();

  const brief = await deps.loadBrief(args.tenant_id, args.brief_id);
  if (!brief) return { ok: false, code: "brief_not_found", message: "That brief does not exist." };
  if (!brief.posted_at) {
    return {
      ok: false,
      code: "brief_not_posted",
      message: "This brief was never posted, so it has no applicants to hire.",
    };
  }
  if (brief.closed_at) {
    return {
      ok: false,
      code: "brief_closed",
      message: "This brief is closed, so nobody else can be hired from it.",
    };
  }

  const application = await deps.loadApplication({
    tenant_id: args.tenant_id,
    application_id: args.application_id,
  });
  if (!application || application.brief_id !== args.brief_id) {
    return {
      ok: false,
      code: "application_not_found",
      message: "That application is not on this brief.",
    };
  }

  let fees: CreatorFeeBreakdown;
  try {
    fees = computeCreatorFees(quotedRateToCents(application.quoted_rate_usd));
  } catch {
    return {
      ok: false,
      code: "no_quote",
      message: "This applicant did not leave a price, so there is nothing to charge.",
    };
  }

  const profiles = await deps.profiles({
    tenant_id: args.tenant_id,
    human_member_ids: [application.human_member_id],
  });
  const country = profiles.get(application.human_member_id)?.country_code ?? "";
  if (!creatorPayoutCountrySupported(country)) {
    return {
      ok: false,
      code: "payout_country_unsupported",
      message:
        "Zavi cannot pay creators in this creator's country yet, so they cannot be hired. Nothing was charged.",
    };
  }
  assertCreatorPayoutCountry(country);

  const days = resolveDeliveryDays(args.delivery_days ?? brief.delivery_days);
  if (days === null) {
    return {
      ok: false,
      code: "due_date_invalid",
      message: `Days to deliver has to be a whole number between ${DELIVERY_DAYS_RANGE.min} and ${DELIVERY_DAYS_RANGE.max}.`,
    };
  }
  const due_at = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  const claimed = await deps.claimApplication({
    tenant_id: args.tenant_id,
    application_id: args.application_id,
  });
  if (!claimed) {
    return {
      ok: false,
      code: "application_not_pending",
      message: "This application has already been answered. Reload the applicant list.",
    };
  }

  try {
    const business_name = await deps.businessName(args.tenant_id);
    const brief_snapshot = creatorVisibleBrief(brief, {
      business_name,
      applicant_count: 0,
      now,
    }) as unknown as Record<string, unknown>;

    const hold = await deps.orders.startApplicantCheckout({
      tenant_id: args.tenant_id,
      user_id: args.booked_by_user_id,
      application_id: args.application_id,
      due_at,
      large_amount_confirmed: args.large_amount_confirmed,
      brief_snapshot,
      success_url: args.success_url,
      cancel_url: args.cancel_url,
    });
    const order_id = hold.order_id;

    return {
      ok: true,
      order_id,
      application_id: args.application_id,
      due_at: brief.product_needed === true ? null : due_at,
      fees,
      checkout_url: hold.checkout_url,
      checkout_session_id: hold.checkout_session_id,
    };
  } catch (e) {
    await deps.releaseClaim({ tenant_id: args.tenant_id, application_id: args.application_id });
    await deps.log({
      level: "error",
      source: "creator.briefs",
      code: "hire_failed",
      message: (e as Error).message,
      tenant_id: args.tenant_id,
      meta: { brief_id: args.brief_id, application_id: args.application_id },
    });
    throw e;
  }
}

function resolveDeliveryDays(requested: number | null | undefined): number | null {
  const n = requested ?? DEFAULT_DELIVERY_DAYS;
  if (!Number.isInteger(n) || n < DELIVERY_DAYS_RANGE.min || n > DELIVERY_DAYS_RANGE.max) {
    return null;
  }
  return n;
}

export const realHireDeps: HireDeps = {
  loadBrief: loadTenantBrief,
  loadApplication: async ({ tenant_id, application_id }) => {
    const { loadBriefApplication } = await import("./briefs-db");
    return loadBriefApplication(tenant_id, application_id);
  },
  claimApplication: claimApplicationForHire,
  releaseClaim: releaseApplicationHireClaim,
  profiles: loadApplicantProfiles,
  businessName: resolveBusinessName,
  orders: realBriefOrderPort,
  now: () => new Date(),
  log: logEvent,
};

export type SettleBriefHireResult =
  | {
      ok: true;
      order_id: string;
      charged: boolean;
      automatic_nos: AutoNoResult | null;
    }
  | { ok: false; code: string; message: string };

export type SettleHireDeps = {
  transition: typeof applyCreatorOrderTransition;
  loadOrder: typeof loadOrderForCheckout;
  autoNo: typeof sendAutomaticNos;
  autoNoDeps: AutoNoDeps;
  claimBrief: typeof claimBriefForHire;
  releaseBrief: typeof releaseBriefClaim;
  readHold: typeof readCreatorHold;
  log: typeof logEvent;
};

export const realSettleHireDeps: SettleHireDeps = {
  transition: applyCreatorOrderTransition,
  loadOrder: loadOrderForCheckout,
  autoNo: sendAutomaticNos,
  autoNoDeps: realAutoNoDeps,
  claimBrief: claimBriefForHire,
  releaseBrief: releaseBriefClaim,
  readHold: readCreatorHold,
  log: logEvent,
};

export async function settleBriefHire(
  args: {
    tenant_id: string;
    order_id: string;
    brief_id: string;
    application_id: string;
    actor_user_id?: string | null;
  },
  deps: SettleHireDeps = realSettleHireDeps,
): Promise<SettleBriefHireResult> {
  const scope = { tenant_id: args.tenant_id, brief_id: args.brief_id };
  const before = await deps.loadOrder(args.tenant_id, args.order_id);
  if (
    !before ||
    before.source !== "applicant" ||
    before.brief_id !== args.brief_id ||
    before.application_id !== args.application_id
  ) {
    return { ok: false, code: "not_this_hire", message: "That order is not a hire for this brief." };
  }
  if (before.status === "cancelled") {
    await deps.releaseBrief({ ...scope, order_id: args.order_id });
    return { ok: false, code: "order_cancelled", message: "This hire was cancelled and nothing was charged." };
  }
  const claim = await deps.claimBrief({ ...scope, order_id: args.order_id });
  if (claim === "taken") {
    return {
      ok: false,
      code: "brief_filled",
      message: "This brief is already filled or closed, so this hire was not charged.",
    };
  }

  const hire = () =>
    deps.transition({
      tenant_id: args.tenant_id,
      order_id: args.order_id,
      trigger: "hire_applicant",
      actor: "business",
      actor_user_id: args.actor_user_id ?? null,
    });
  let res = await hire();

  if (
    !res.ok &&
    res.code === "money_needs_staff" &&
    before.stripe_payment_intent_id &&
    (await deps.readHold(before.stripe_payment_intent_id)).refunded_cents === 0
  ) {
    const retry = await hire();
    if (retry.ok && retry.order.status === "in_progress") res = retry;
  }

  if (!res.ok) {
    if (res.code === "illegal_transition" || res.code === "conflict") {
      const order = await deps.loadOrder(args.tenant_id, args.order_id);
      if (order?.status === "cancelled") await deps.releaseBrief({ ...scope, order_id: args.order_id });
      if (
        order &&
        order.source === "applicant" &&
        order.brief_id === args.brief_id &&
        order.application_id === args.application_id &&
        !["checkout_pending", "awaiting_acceptance", "cancelled"].includes(order.status)
      ) {
        const automatic_nos = await deps.autoNo(
          {
            tenant_id: args.tenant_id,
            brief_id: args.brief_id,
            cause: "hire",
            hired_application_id: args.application_id,
          },
          deps.autoNoDeps,
        );
        return { ok: true, order_id: args.order_id, charged: true, automatic_nos };
      }
    }
    if (claim === "claimed" && res.code !== "money_needs_staff") {
      await deps.releaseBrief({ ...scope, order_id: args.order_id });
    }
    return { ok: false, code: res.code, message: res.message };
  }

  if (res.order.status !== "in_progress") {
    await deps.releaseBrief({ ...scope, order_id: args.order_id });
    await deps.log({
      level: "warn",
      source: "creator.briefs",
      code: "hire_capture_failed",
      message: `hire of application ${args.application_id} did not charge; order is ${res.order.status}`,
      tenant_id: args.tenant_id,
      meta: { brief_id: args.brief_id, creator_order_id: args.order_id },
    });
    return { ok: true, order_id: args.order_id, charged: false, automatic_nos: null };
  }

  const automatic_nos = await deps.autoNo(
    {
      tenant_id: args.tenant_id,
      brief_id: args.brief_id,
      cause: "hire",
      hired_application_id: args.application_id,
    },
    deps.autoNoDeps,
  );

  return { ok: true, order_id: args.order_id, charged: true, automatic_nos };
}

export function hireNotAllowed(): ExpectedToolError {
  return new ExpectedToolError("brief_not_found", "That brief does not exist.");
}

export type { TenantBriefRow };
