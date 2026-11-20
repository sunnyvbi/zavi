
import { logEvent } from "@/services/logging/logEvent";
import {
  creatorOrderTriggersFrom,
  type CreatorOrderSource,
  type CreatorOrderStatus,
  type CreatorOrderTrigger,
} from "./order-state";
import { canAskZaviAfterAutoAccept } from "./deadlines";
import {
  applyCreatorOrderTransition,
  type ApplyCreatorOrderTransitionResult,
} from "./order-transitions";
import { realCreatorLibraryPort, realCreatorThreadPort } from "./s7-ports";

export type BusinessAction =
  | "approve"
  | "request_change"
  | "request_cancellation"
  | "revoke_cancellation"
  | "withdraw"
  | "approve_extension"
  | "decline_extension"
  | "ask_zavi"
  | "ask_zavi_in_buffer";

export const BUSINESS_ACTION_TRIGGER: Record<BusinessAction, CreatorOrderTrigger> = {
  approve: "approve",
  request_change: "request_revision",
  request_cancellation: "request_cancellation",
  revoke_cancellation: "cancel_revoked",
  withdraw: "business_withdraw",
  approve_extension: "approve_extension",
  decline_extension: "decline_extension",
  ask_zavi: "open_dispute",
  ask_zavi_in_buffer: "open_dispute_in_buffer",
};

export const TRIGGER_BUSINESS_ACTION: Partial<Record<CreatorOrderTrigger, BusinessAction>> =
  Object.fromEntries(
    (Object.keys(BUSINESS_ACTION_TRIGGER) as BusinessAction[]).map((a) => [
      BUSINESS_ACTION_TRIGGER[a],
      a,
    ]),
  ) as Partial<Record<CreatorOrderTrigger, BusinessAction>>;

export const BUSINESS_ACTION_LABEL: Record<BusinessAction, string> = {
  approve: "Approve and pay",
  request_change: "Request a change",
  request_cancellation: "Request cancellation",
  revoke_cancellation: "Take the request back",
  withdraw: "Cancel this booking",
  approve_extension: "Approve the new date",
  decline_extension: "Keep the agreed date",
  ask_zavi: "Ask Zavi to step in",
  ask_zavi_in_buffer: "Ask Zavi to step in",
};

export const BUSINESS_ACTION_CONSEQUENCE: Record<BusinessAction, string> = {
  approve:
    "The job closes and the creator's payout is released straight away. If their Stripe setup is not finished yet, Zavi holds it until it is. This cannot be undone.",
  request_change:
    "The creator gets your notes and sends a new version. Changes have to stay inside what the order asked for.",
  request_cancellation:
    "The creator has 72 hours to agree. If they agree, or say nothing, your card is refunded in full including the 10% Zavi fee. If they decline, the job carries on.",
  revoke_cancellation:
    "The cancellation request disappears and the job carries on exactly where it was. Nothing is charged or refunded.",
  withdraw:
    "The creator has not accepted yet, so the hold on your card is released and nothing is charged.",
  approve_extension: "The delivery date moves to the date the creator asked for.",
  decline_extension: "The agreed delivery date stays exactly where it is.",
  ask_zavi:
    "Zavi staff read the order, the thread and everything submitted, then decide: pay in full, pay part, or refund. The money waits until they do.",
  ask_zavi_in_buffer:
    "Zavi staff read the order, the thread and everything submitted, then decide: pay in full, pay part, or refund. The creator's payout is held until Zavi decides.",
};

export function businessActionsFor(
  status: CreatorOrderStatus,
  source: CreatorOrderSource,
  extension_state?: "requested" | "approved" | "declined" | null,
  closed?: { closed_reason: string | null; closed_at: string | null; payout_status: string; now: Date },
): BusinessAction[] {
  const pendingExtension = extension_state === "requested";
  return creatorOrderTriggersFrom(status, source, "business")
    .map((t) => TRIGGER_BUSINESS_ACTION[t])
    .filter((a): a is BusinessAction => a !== undefined)
    .filter((a) => {
      if (a !== "approve_extension" && a !== "decline_extension") return true;
      return extension_state === undefined ? true : pendingExtension;
    })
    .filter((a) => a !== "ask_zavi_in_buffer" || (closed !== undefined && canAskZaviAfterAutoAccept({ status, ...closed }, closed.now)))
    .sort();
}

export type RunBusinessActionArgs = {
  tenant_id: string;
  order_id: string;
  action: BusinessAction;
  user_id: string | null;
  note?: string | null;
  requested_due_at?: never;
};

export type RunBusinessActionDeps = {
  transition: typeof applyCreatorOrderTransition;
  library: typeof realCreatorLibraryPort;
  thread: typeof realCreatorThreadPort;
  log: typeof logEvent;
};

export const realBusinessActionDeps: RunBusinessActionDeps = {
  transition: applyCreatorOrderTransition,
  library: realCreatorLibraryPort,
  thread: realCreatorThreadPort,
  log: logEvent,
};

export type RunBusinessActionResult = ApplyCreatorOrderTransitionResult & {
  library_asset_created?: boolean;
};

export async function runBusinessAction(
  args: RunBusinessActionArgs,
  deps: RunBusinessActionDeps = realBusinessActionDeps,
): Promise<RunBusinessActionResult> {
  const trigger = BUSINESS_ACTION_TRIGGER[args.action];
  const forZaviOnly = trigger === "open_dispute" || trigger === "open_dispute_in_buffer";

  const result = await deps.transition({
    tenant_id: args.tenant_id,
    order_id: args.order_id,
    trigger,
    actor: "business",
    actor_user_id: args.user_id,
    note: forZaviOnly ? null : (args.note ?? null),
    ...(forZaviOnly
      ? {
          dispute: {
            kind: "step_in" as const,
            opened_by: "tenant" as const,
            opened_by_user_id: args.user_id,
            reason: (args.note ?? "").trim() || "The business asked Zavi to step in.",
          },
        }
      : {}),
  });

  if (!result.ok) return result;

  const poster = args.user_id;
  if (poster && !forZaviOnly && args.note && args.note.trim().length > 0) {
    await best(deps, () =>
      deps.thread.postMessage({
        auth_user_id: poster,
        tenant_id: args.tenant_id,
        order_id: args.order_id,
        thread_id: null,
        body: args.note as string,
      }),
    );
  }

  if (args.action !== "approve") return result;

  let library_asset_created = false;
  await best(deps, async () => {
    const r = await deps.library.createLibraryAssetOnApproval(args.tenant_id, args.order_id);
    library_asset_created = r.created;
  });
  return { ...result, library_asset_created };
}

async function best(deps: RunBusinessActionDeps, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    await deps
      .log({
        level: "warn",
        source: "creator.order",
        code: "business_action_side_effect_failed",
        message: (e as Error).message.slice(0, 300),
      })
      .catch(() => {});
  }
}
