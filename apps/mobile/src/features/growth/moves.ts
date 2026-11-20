
export type MoveAction = "approve" | "reject";

export const MOVE_ERROR: Record<MoveAction, string> = {
  approve: "Could not approve that. Try again.",
  reject: "Could not save that. Try again.",
};

export const SHIP_RED_CONFIRM =
  "This change broke a test that was passing on the base branch.\n\n" +
  "Approving opens the PR anyway, with the test still broken.\n\n" +
  "Open the PR anyway?";

export function isShipRedRefusal(e: { status?: number; code?: string } | null | undefined): boolean {
  return e?.status === 409 && e?.code === "requires_ship_red_override";
}

export function moveRequest(id: string, action: MoveAction, shipAnyway: boolean): { path: string; body?: string } {
  const path = `/api/approvals/${encodeURIComponent(id)}/${action}`;
  return action === "approve" && shipAnyway ? { path, body: JSON.stringify({ ship_anyway: true }) } : { path };
}
