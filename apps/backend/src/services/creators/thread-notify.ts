
import { businessJobLink, businessThreadLink, UGC_HUB_PATH } from "./hub-links";
import { asTenantId, globalClient, tenantClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { resolveBusinessName } from "./briefs-db";
import { computeCreatorFees } from "./order-fees";
import {
  notify,
  threadDedupeKey,
  type CreatorNotificationEvent,
  type NotifyRecipient,
  type NotifyVars,
} from "./notify";

export type ThreadNotifyDeps = {
  notify: typeof notify;
  businessName: (tenant_id: string) => Promise<string | null>;
  creatorName: (human_member_id: string) => Promise<string | null>;
  openJobTitle: (pair: { tenant_id: string; human_member_id: string }) => Promise<string | null>;
  now: () => Date;
  log: typeof logEvent;
};

async function loadCreatorDisplayName(human_member_id: string): Promise<string | null> {
  const { data, error } = await globalClient()
    .from("human_members")
    .select("display_name")
    .eq("id", human_member_id)
    .maybeSingle();
  if (error) throw new Error(`creator name lookup failed: ${error.message}`);
  const n = (data as { display_name?: string } | null)?.display_name ?? "";
  return n.trim() || null;
}

async function loadOpenJobTitle(pair: { tenant_id: string; human_member_id: string }): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(pair.tenant_id))
    .from("creator_orders")
    .select("package_snapshot")
    .eq("human_member_id", pair.human_member_id)
    .not("status", "in", "(completed,cancelled)")
    .limit(2);
  if (error) throw new Error(`open job lookup failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ package_snapshot?: Record<string, unknown> }>;
  if (rows.length !== 1) return null;
  const t = rows[0].package_snapshot?.["title"];
  return typeof t === "string" && t.trim().length > 0 ? t.trim() : null;
}

export const realThreadNotifyDeps: ThreadNotifyDeps = {
  notify,
  businessName: resolveBusinessName,
  creatorName: loadCreatorDisplayName,
  openJobTitle: loadOpenJobTitle,
  now: () => new Date(),
  log: logEvent,
};

type Side = "tenant" | "creator";

export { UGC_HUB_PATH, businessJobLink, businessThreadLink, businessApplicantsLink } from "./hub-links";

function otherSide(
  from: Side,
  pair: { tenant_id: string; human_member_id: string },
): NotifyRecipient {
  return from === "tenant"
    ? { kind: "creator", human_member_id: pair.human_member_id }
    : { kind: "tenant", tenant_id: pair.tenant_id };
}

async function names(
  pair: { tenant_id: string; human_member_id: string },
  deps: ThreadNotifyDeps,
): Promise<Pick<NotifyVars, "business_name" | "creator_name">> {
  const [business_name, creator_name] = await Promise.all([
    deps.businessName(pair.tenant_id).catch(() => null),
    deps.creatorName(pair.human_member_id).catch(() => null),
  ]);
  return { business_name, creator_name };
}

async function send(
  deps: ThreadNotifyDeps,
  tenant_id: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    await deps
      .log({
        level: "warn",
        source: "creator.thread",
        code: "thread_notify_failed",
        message: (e as Error).message.slice(0, 300),
        tenant_id,
      })
      .catch(() => undefined);
  }
}

async function sendThrottled(
  args: {
    event: CreatorNotificationEvent;
    from: Side;
    tenant_id: string;
    human_member_id: string;
    thread_id: string;
    vars: NotifyVars;
  },
  deps: ThreadNotifyDeps,
): Promise<void> {
  const recipient = otherSide(args.from, args);
  await send(deps, args.tenant_id, async () => {
    const who = await names(args, deps);
    await deps.notify({
      recipient,
      event: args.event,
      scope_id: args.thread_id,
      dedupe_key: threadDedupeKey({
        thread_id: args.thread_id,
        event: args.event,
        recipient,
        now: deps.now(),
      }),
      vars: {
        ...who,
        ...args.vars,
        link_path:
          recipient.kind === "tenant"
            ? businessThreadLink(args.human_member_id)
            : `/creator?thread=${encodeURIComponent(args.thread_id)}`,
      },
    });
  });
}

export async function notifyThreadMessage(
  args: { tenant_id: string; human_member_id: string; thread_id: string; from: Side; body: string },
  deps: ThreadNotifyDeps = realThreadNotifyDeps,
): Promise<void> {
  const { body, ...rest } = args;
  const job_title = await deps.openJobTitle(rest).catch(() => null);
  await sendThrottled({ ...rest, event: "thread_message", vars: { message_body: body, job_title } }, deps);
}

export async function notifyCustomOfferReceived(
  args: {
    tenant_id: string;
    human_member_id: string;
    thread_id: string;
    offer_id: string;
    from: Side;
    job_title: string;
    price_cents: number;
  },
  deps: ThreadNotifyDeps = realThreadNotifyDeps,
): Promise<void> {
  const fees = computeCreatorFees(args.price_cents);
  const recipient = otherSide(args.from, args);
  await send(deps, args.tenant_id, async () => {
    const who = await names(args, deps);
    await deps.notify({
      recipient,
      event: "custom_offer_received",
      scope_id: args.offer_id,
      vars: {
        ...who,
        job_title: args.job_title,
        price_cents: fees.price_cents,
        payout_cents: fees.creator_payout_cents,
        business_total_cents: fees.business_total_cents,
        link_path:
          recipient.kind === "tenant"
            ? `${UGC_HUB_PATH}&drawer=hire&offer=${encodeURIComponent(args.offer_id)}`
            : "/creator",
      },
    });
  });
}

export async function notifyCustomOfferAccepted(
  args: {
    tenant_id: string;
    human_member_id: string;
    order_id: string;
    job_title: string;
    price_cents: number;
    checkout_url: string | null;
  },
  deps: ThreadNotifyDeps = realThreadNotifyDeps,
): Promise<void> {
  const fees = computeCreatorFees(args.price_cents);
  await send(deps, args.tenant_id, async () => {
    const who = await names(args, deps);
    await deps.notify({
      recipient: { kind: "tenant", tenant_id: args.tenant_id },
      event: "custom_offer_accepted",
      order_id: args.order_id,
      email_cta_url: args.checkout_url,
      vars: {
        ...who,
        job_title: args.job_title,
        price_cents: fees.price_cents,
        business_total_cents: fees.business_total_cents,
        link_path: businessJobLink(args.order_id),
      },
    });
  });
}
