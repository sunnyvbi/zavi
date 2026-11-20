
export type ShipPrDecisionRow = {
  status: string;
  autonomy_at_emit?: string | null;
  approved_by?: string | null;
  dispatch_error?: string | null;
};

export type ProjectSurface = "slack" | "web";

export type ShipPrStatusCtx = {
  trigger: string | null | undefined;
  surface: ProjectSurface;
};

const COPY = {
  held: "✅ Change ready. Approve to open the PR — tap *Approve* below or open Needs you in Zavi. I'll post the link here the moment it opens.",
  opening: "Opening the PR now — I'll post the link here when it's ready.",
  failed: "The PR didn't open. Nothing shipped. Reply to retry, or open Needs you in Zavi.",
} as const;

function isInteractive(trigger: string | null | undefined): boolean {
  return trigger === "slack" || trigger === "chat";
}

export function projectShipPrStatus(
  decision: ShipPrDecisionRow,
  ctx: ShipPrStatusCtx,
): string | null {
  const status = decision.status;

  const hasDispatchError =
    typeof decision.dispatch_error === "string" &&
    decision.dispatch_error.trim().length > 0;
  const terminalFailed =
    status === "rejected" || status === "expired" || status === "stale";

  if (hasDispatchError || terminalFailed) return COPY.failed;

  if (status === "acted" || status === "dispatched") return null;

  const approved =
    typeof decision.approved_by === "string" &&
    decision.approved_by.trim().length > 0;

  if (
    status === "proposed" &&
    isInteractive(ctx.trigger) &&
    !approved &&
    decision.autonomy_at_emit === "approval"
  ) {
    return COPY.held;
  }

  if (status === "dispatching" || status === "approved" || status === "proposed") {
    return COPY.opening;
  }

  return null;
}
