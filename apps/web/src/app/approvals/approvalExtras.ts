import type { ApproveExtras } from "@/lib/approvals/approveDecision";

const FULL_CARD_HANDLERS = new Set(["composio.execute_tool", "stripe.create_payment", "stripe.remit_to_tenant"]);

export function needsFullCard(handler: string | null | undefined): boolean {
  return !!handler && FULL_CARD_HANDLERS.has(handler);
}

export function approveExtrasFor(d: {
  decision_class?: string;
  post_revision?: string;
  handler: string | null;
  body: Record<string, unknown> | null | undefined;
}): ApproveExtras {
  const fingerprint = d.body?.fingerprint;
  return {
    ...(needsFullCard(d.handler) && typeof fingerprint === "string" ? { expected_fingerprint: fingerprint } : {}),
    ...(d.decision_class === "social.publish.v2" && d.post_revision ? { expected_post_revision: d.post_revision } : {}),
  };
}
