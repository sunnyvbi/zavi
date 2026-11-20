import { outcomeAppName, outcomeUnknownRows } from "./approvalsHelpers";
import { tiktokAdsRaisesSpend } from "./tiktokAdsDecision";
export const OWNER_OR_ADMIN_APPROVE_REASON = "Only an owner or admin can approve this";
export const VIEWER_APPROVE_REASON = "View-only access. Ask an admin to make you a member.";

const MAY_HAVE_SENT = /may or may not have gone out/i;

export type ComposioCardPhase =
  | "pending"
  | "running"
  | "outcome_unknown"
  | "done"
  | "rejected"
  | "failed"
  | "closed";

export function composioChatCardState(
  d: {
    decision_class: string;
    status: string;
    body: Record<string, unknown> | null;
    dispatched_at?: string | null;
    dispatch_error?: string | null;
  },
  viewerRole: "owner" | "admin" | "member" | "viewer" | null,
  now: number = Date.now(),
): { phase: ComposioCardPhase; appName: string; approveBlockedReason: string | null } {
  const body = d.body ?? {};
  const appName = outcomeAppName(d.decision_class, body);
  const labels = Array.isArray(body.labels) ? body.labels : [];
  const elevatedApproval =
    d.decision_class === "composio.moves_money" ||
    d.decision_class === "composio.deletes_data" ||
    d.decision_class === "composio.shopify_write" ||
    labels.includes("moves_money") ||
    labels.includes("deletes_data");
  const moneyCard = d.decision_class === "stripe.create_payment" || d.decision_class === "stripe.remit_to_tenant" || tiktokAdsRaisesSpend(d.decision_class, body);
  const approveBlockedReason =
    viewerRole === "viewer"
      ? VIEWER_APPROVE_REASON
      : (elevatedApproval || moneyCard) && viewerRole === "member"
        ? OWNER_OR_ADMIN_APPROVE_REASON
        : null;
  let phase: ComposioCardPhase;
  switch (d.status) {
    case "proposed":
      phase = "pending";
      break;
    case "approved":
      phase = "running";
      break;
    case "dispatching":
      phase =
        outcomeUnknownRows(
          [{ handler: "composio.execute_tool", status: d.status, dispatched_at: d.dispatched_at ?? null }],
          now,
        ).length > 0
          ? "outcome_unknown"
          : "running";
      break;
    case "acted":
      phase = "done";
      break;
    case "rejected":
      phase = "rejected";
      break;
    case "failed":
    case "dispatch_failed":
      phase = d.decision_class === "outbound.send" && MAY_HAVE_SENT.test(d.dispatch_error ?? "") ? "outcome_unknown" : "failed";
      break;
    default:
      phase = "closed";
  }
  return { phase, appName, approveBlockedReason };
}
