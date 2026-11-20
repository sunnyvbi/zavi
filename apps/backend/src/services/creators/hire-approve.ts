
import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { platformWriteEnabled } from "@/services/channels/exec-kill-switch";
import {
  reserveCreatorHire,
  settleCreatorHire,
  type CreatorHireRefusal,
} from "@/services/decisions/creator-hire-budget";
import { loadOrderForCheckout } from "./booking-db";
import { attachCreatorOrderPaymentIntent } from "./db";
import {
  createCreatorSavedCardHold,
  releaseOrphanCreatorHold,
  type CreatorSavedCardWallet,
} from "./orders-money";
import { fulfilCreatorCheckout } from "./checkout-fulfil";
import { resumeOrderCheckout } from "./checkout-resume";

export const CREATOR_HIRE_CLASS = "creator.hire";

export type CreatorHireRow = {
  id: string;
  tenant_id: string;
  body: Record<string, unknown>;
  approved_by?: string | null;
  approved_by_source?: string | null;
  exec_source?: string;
  claim_id?: string | null;
};

export type CreatorHireResult = {
  ok: boolean;
  error?: string;
  notice?: string;
  code?: string;
  checkout_url?: string | null;
};

export type CreatorHireDeps = {
  roleFor: typeof loadTenantRoleFor;
  writeEnabled: typeof platformWriteEnabled;
  loadOrder: typeof loadOrderForCheckout;
  reserve: typeof reserveCreatorHire;
  settle: typeof settleCreatorHire;
  loadWallet: (tenant_id: string) => Promise<CreatorSavedCardWallet | null>;
  hold: typeof createCreatorSavedCardHold;
  attach: typeof attachCreatorOrderPaymentIntent;
  releaseOrphan: typeof releaseOrphanCreatorHold;
  fulfil: typeof fulfilCreatorCheckout;
  resumeCheckout: typeof resumeOrderCheckout;
  now: () => Date;
};

async function loadSavedCard(tenant_id: string): Promise<CreatorSavedCardWallet | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("ads_wallets")
    .select("stripe_customer_id, payment_method_id, creator_consent_at")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`ads wallet read failed: ${error.message}`);
  return (data as CreatorSavedCardWallet | null) ?? null;
}

const DEFAULT_DEPS: CreatorHireDeps = {
  roleFor: loadTenantRoleFor,
  writeEnabled: platformWriteEnabled,
  loadOrder: loadOrderForCheckout,
  reserve: reserveCreatorHire,
  settle: settleCreatorHire,
  loadWallet: loadSavedCard,
  hold: (a, w) => createCreatorSavedCardHold(a, w),
  attach: attachCreatorOrderPaymentIntent,
  releaseOrphan: (a) => releaseOrphanCreatorHold(a),
  fulfil: (a) => fulfilCreatorCheckout(a),
  resumeCheckout: (a) => resumeOrderCheckout(a),
  now: () => new Date(),
};

const payloadSchema = z.object({ order_id: z.guid(), caps_id: z.guid() });

export const FOUNDER_ONLY =
  "Only a workspace owner or admin can approve a creator hire. Nothing was charged.";

const REFUSAL_COPY: Record<CreatorHireRefusal, string> = {
  no_budget: "There is no active monthly ad budget, so nothing was charged for this hire.",
  no_caps: "Autopilot has no creator caps for this hire, so nothing was charged.",
  over_hire_cap: "This hire costs more than Autopilot's per-hire cap, so nothing was charged.",
  over_week_cap: "This hire would pass Autopilot's weekly creator cap, so nothing was charged.",
  over_budget: "This hire would pass what is left of this month's ad budget, so nothing was charged.",
};

const refuse = (error: string, code: string): CreatorHireResult => ({ ok: false, error, code });

export async function approveCreatorHire(
  row: CreatorHireRow,
  deps: Partial<CreatorHireDeps> = {},
): Promise<CreatorHireResult> {
  const d = { ...DEFAULT_DEPS, ...deps };

  if (row.exec_source !== "channel_actions" || !row.claim_id) {
    return refuse("This hire can only be approved from its card. Nothing was charged.", "creator_hire_wrong_rail");
  }
  if (row.approved_by_source != null || !row.approved_by) return refuse(FOUNDER_ONLY, "creator_hire_founder_only");
  const approver: string = row.approved_by;
  let role: string | null;
  try {
    role = await d.roleFor(row.approved_by, row.tenant_id);
  } catch {
    return refuse("Zavi could not check who approved this hire, so nothing was charged. Try again.", "creator_hire_role_unavailable");
  }
  if (role !== "owner" && role !== "admin") return refuse(FOUNDER_ONLY, "creator_hire_founder_only");

  if (!(await d.writeEnabled(CREATOR_HIRE_CLASS))) {
    return refuse("Creator hires are switched off right now, so nothing was charged.", "kill_switch");
  }

  const payload = payloadSchema.safeParse(row.body ?? {});
  if (!payload.success) return refuse("This hire card could not be read, so nothing was charged.", "creator_hire_bad_payload");
  const { order_id, caps_id } = payload.data;
  const tenant_id = row.tenant_id;
  const order = await d.loadOrder(tenant_id, order_id);
  if (!order) return refuse("That creator order is not in this workspace. Nothing was charged.", "creator_order_not_found");
  if (order.status !== "checkout_pending") {
    if (order.status !== "cancelled" && order.stripe_payment_intent_id) {
      return { ok: true, notice: "This creator is already hired." };
    }
    return refuse("This hire is no longer waiting for payment, so nothing was charged.", "creator_order_not_awaiting_checkout");
  }
  const deadline = order.next_deadline_at ? Date.parse(order.next_deadline_at) : Number.NaN;
  if (!order.stripe_payment_intent_id && Number.isFinite(deadline) && deadline <= d.now().getTime()) {
    return refuse(
      "This hire waited too long for approval and has closed, so nothing was charged. Ask Autopilot to propose it again if you still want it.",
      "creator_hire_expired",
    );
  }
  if (order.stripe_checkout_session_id) return checkoutFallback(d, tenant_id, order_id, null);

  const reserved = await d.reserve(tenant_id, {
    order_id,
    amount_usd: order.business_total_cents / 100,
    caps_id,
    channel_action_id: row.id,
    approved_by_user_id: approver,
  });
  if (reserved.status === "unavailable") {
    return refuse("Zavi could not check the ad budget, so nothing was charged. Try again.", "creator_hire_budget_unavailable");
  }
  if (reserved.status === "already_held" && reserved.state !== "held") {
    return { ok: true, notice: "This creator is already hired." };
  }
  if (reserved.status !== "reserved" && reserved.status !== "already_held") {
    return refuse(REFUSAL_COPY[reserved.status], reserved.status);
  }

  if (order.stripe_payment_intent_id) return finish(d, tenant_id, order_id, approver);

  let hold: Awaited<ReturnType<CreatorHireDeps["hold"]>>;
  try {
    const wallet = await d.loadWallet(tenant_id);
    const country = order.package_snapshot?.["creator_country_code"];
    const holdArgs = { tenant_id, order_id, creator_country: typeof country === "string" ? country : "", action_id: row.id };
    const card = wallet ?? { stripe_customer_id: null, payment_method_id: null, creator_consent_at: null };
    hold = await d.hold(holdArgs, card);
    if (hold.kind === "unknown") hold = await d.hold(holdArgs, card);
  } catch (e) {
    await release(d, tenant_id, order_id);
    const why = e instanceof ExpectedToolError ? e.message : "Zavi could not start this payment.";
    return refuse(`${why} Nothing was charged.`, e instanceof ExpectedToolError ? e.code : "creator_hire_refused");
  }
  if (hold.kind === "unknown") {
    return {
      ok: false,
      code: "exec_outcome_unknown",
      error: "Zavi could not confirm whether your card was held for this hire. Do not pay for it again; Zavi finishes the hire if the hold went through.",
    };
  }
  if (hold.kind === "needs_founder") {
    return checkoutFallback(d, tenant_id, order_id, hold.reason);
  }

  let attached: boolean;
  try {
    attached = await d.attach({ tenant_id, order_id, payment_intent_id: hold.payment_intent_id, hold_expires_at: hold.hold_expires_at });
  } catch {
    attached = false;
  }
  if (!attached) {
    const fresh = await d.loadOrder(tenant_id, order_id).catch(() => null);
    if (fresh?.stripe_payment_intent_id !== hold.payment_intent_id) {
      let orphan: Awaited<ReturnType<CreatorHireDeps["releaseOrphan"]>> | null;
      try {
        orphan = await d.releaseOrphan({ payment_intent_id: hold.payment_intent_id, order_livemode: order.livemode });
      } catch {
        orphan = null;
      }
      if (orphan === "released" || orphan === "not_held") {
        await release(d, tenant_id, order_id);
        return refuse(
          "This order changed while it was being paid, so Zavi released the hold on your card. Nothing was charged.",
          "creator_hire_order_changed",
        );
      }
      if (orphan === "captured") await d.settle(tenant_id, order_id, "spent");
      console.error(`[creator-hire] order ${order_id}: saved-card hold ${hold.payment_intent_id} lost the attach and is ${orphan ?? "unknown"}; needs staff`);
      return {
        ok: false,
        code: "exec_outcome_unknown",
        error: "Zavi could not confirm whether your card was charged for this hire. Do not pay for it again; Zavi staff will check it.",
      };
    }
  }

  return finish(d, tenant_id, order_id, approver);
}

async function finish(d: CreatorHireDeps, tenant_id: string, order_id: string, approver: string): Promise<CreatorHireResult> {
  let f: Awaited<ReturnType<CreatorHireDeps["fulfil"]>>;
  try {
    f = await d.fulfil({ tenant_id, order_id, hold_actor_user_id: approver });
  } catch {
    return {
      ok: false,
      code: "exec_outcome_unknown",
      error: "Your card is held for this hire and Zavi is still finishing it. Do not approve it again.",
    };
  }
  if (f.state === "fulfilled" && f.status === "awaiting_acceptance") {
    return { ok: true, notice: "Booked. Your card is held until the creator accepts; nothing is charged if they pass." };
  }
  if (f.state === "fulfilled" || (f.state === "already_done" && f.status !== "cancelled")) {
    return { ok: true, notice: "Hired. Your card was charged for this hire." };
  }
  if (f.state === "pending") {
    return { ok: true, notice: "Your card is held for this hire and Zavi is finishing it." };
  }
  if (f.state === "already_done" || f.state === "cancelled") {
    return refuse("This hire was cancelled before it started. The hold on your card was released.", "creator_hire_cancelled");
  }
  return refuse(f.message, "creator_hire_needs_staff");
}

async function release(d: CreatorHireDeps, tenant_id: string, order_id: string): Promise<void> {
  const r = await d.settle(tenant_id, order_id, "released");
  if (r.status === "unavailable") {
    console.error(`[creator-hire] reservation for order ${order_id} could not be released: ${r.error}`);
    throw new ExpectedToolError(
      "creator_hire_release_pending",
      "Nothing was charged, but Zavi could not finish releasing this hire's budget hold. Approve again in a minute.",
    );
  }
}

const FALLBACK_WHY: Record<string, string> = {
  no_saved_card: "There is no card saved for creator hires",
  stripe_account_mismatch: "Your saved card cannot be used for creator hires",
  requires_action: "Your bank wants to confirm this payment",
  card_declined: "Your saved card was declined",
};

async function checkoutFallback(
  d: CreatorHireDeps,
  tenant_id: string,
  order_id: string,
  reason: string | null,
): Promise<CreatorHireResult> {
  const why = reason ? `${FALLBACK_WHY[reason] ?? "Your saved card could not be used"}, so nothing was charged.` : "Nothing was charged yet.";
  try {
    const r = await d.resumeCheckout({ tenant_id, order_id });
    return { ok: false, code: "creator_hire_checkout", error: `${why} Pay with the link on this card to hire the creator.`, checkout_url: r.checkout_url };
  } catch {
    return { ok: false, code: "creator_hire_checkout_unavailable", error: `${why} The payment link could not be opened. Try again.` };
  }
}
