
export type ShipPrApprovalRow = {
  decision_class?: string | null;
  status?: string | null;
  approved_by?: string | null;
};

export function shouldRefuseUnapprovedShipPr(
  row: ShipPrApprovalRow | null | undefined,
): boolean {
  return (
    !!row &&
    row.decision_class === "engineer.ship-pr" &&
    row.approved_by == null
  );
}

export const APPROVED_ROW_ONLY_CLASSES: ReadonlySet<string> = new Set([
  "stripe.create_payment",
  "stripe.remit_to_tenant",
  "dispute-response.final-submit-evidence",
  "github.open_pr_direct",
  "github.merge_pr_direct",
  "x_ads.set_status",
  "x_ads.update_campaign",
  "x_ads.create_campaign",
  "x_ads.manage_objects",
  "tiktok_ads.set_status",
  "tiktok_ads.update_budget",
  "bulk_outbound.send",
]);

export function shouldRefuseUnapprovedExactActionCard(
  row: { decision_class?: string | null; status?: string | null } | null | undefined,
): boolean {
  if (!row || typeof row.decision_class !== "string") return false;
  return APPROVED_ROW_ONLY_CLASSES.has(row.decision_class) && row.status !== "approved";
}

export function shouldRefuseUnapprovedBulkEmail(
  row: { decision_class?: string | null; status?: string | null; approved_by?: string | null } | null | undefined,
): boolean {
  if (!row || row.decision_class !== "bulk_outbound.send") return false;
  return row.status !== "approved" || row.approved_by == null;
}

export function shouldRefuseUnapprovedComposioWrite(
  row: { handler?: string | null; decision_class?: string | null; status?: string | null } | null | undefined,
): boolean {
  if (!row) return false;
  const composio =
    row.handler === "composio.execute_tool" ||
    (typeof row.decision_class === "string" && row.decision_class.startsWith("composio."));
  return composio && row.status !== "approved";
}

export function shouldHoldInteractiveShipPr(args: {
  hasRunId: boolean;
  readOk: boolean;
  trigger: string | null | undefined;
  pushToMain?: boolean;
}): boolean {
  if (!args.hasRunId || !args.readOk) return true;
  if (args.trigger === "chat") return true;
  if (
    args.pushToMain === true &&
    (args.trigger === "chat" ||
      args.trigger === "slack" ||
      args.trigger === "handoff")
  ) {
    return true;
  }
  return false;
}
