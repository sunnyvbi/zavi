
import { isHighStakesDecision, stakesClassOf } from "@/app/approvals/approvalsHelpers";
import { needsFullCard } from "@/app/approvals/approvalExtras";
import { EMAIL_CARD_CLASSES } from "@/components/email/emailCardClasses";

export const WEB_ONLY_APPROVE_CLASSES: ReadonlySet<string> = new Set([
  "stripe.create_payment",
  "stripe.remit_to_tenant",
  "extension.money_step",
]);

export const UNWIRED_APPROVE_HANDLERS: ReadonlySet<string> = new Set(["stripe.refund"]);

const NEEDS_EXTRAS: ReadonlySet<string> = new Set(["growth.save_business_controls", "social.publish.v2"]);

export type OneClickRow = {
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown> | null | undefined;
  exec_class?: string | null;
  needs_owner_admin?: boolean;
};

export type ViewerRoleLike = "owner" | "admin" | "member" | "viewer" | null | undefined;

export function oneClickApprovable(row: OneClickRow, viewerRole: ViewerRoleLike): boolean {
  const cls = row.decision_class ?? "";
  const body = row.body ?? {};
  if (viewerRole === "viewer") return false;
  if (row.needs_owner_admin === true && viewerRole === "member") return false;
  if (NEEDS_EXTRAS.has(cls) || EMAIL_CARD_CLASSES.has(cls) || WEB_ONLY_APPROVE_CLASSES.has(cls)) return false;
  if (cls.startsWith("composio.") || needsFullCard(row.handler) || body.full_card === true) return false;
  if (row.handler && UNWIRED_APPROVE_HANDLERS.has(row.handler)) return false;
  if (isHighStakesDecision(stakesClassOf(row), row.handler, body)) return false;
  return true;
}
