
export type CreditWallKind = "credits" | "plan" | "budget";

export type CreditWall = { kind: CreditWallKind; message: string };

export const BILLING_URL = "https://www.zaviagent.com/pricing";

export function creditWallFromError(err: unknown): CreditWall | null {
  if (!err || typeof err !== "object") return null;
  const { status, code, message } = err as { status?: unknown; code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message.trim() : "";
  if (status === 402 && code === "insufficient_credits") {
    return {
      kind: "credits",
      message: text || "You're out of credits. Top up in Billing to keep your agents running.",
    };
  }
  if (status === 403 && code === "plan_upgrade_required") {
    return { kind: "plan", message: text || "Your plan doesn't include this. Upgrade to use it." };
  }
  if (status === 429 && code === "channel_budget_exhausted") {
    return { kind: "budget", message: text || "This channel has used its budget for now." };
  }
  return null;
}

export function creditWallView(
  wall: CreditWall,
  who: { canManageBilling: boolean },
): { text: string; action: string | null } {
  if (wall.kind === "budget") return { text: wall.message, action: null };
  if (!who.canManageBilling) {
    return {
      text:
        wall.message +
        (wall.kind === "plan"
          ? " Ask your workspace owner to upgrade the plan."
          : " Ask your workspace owner to add credits."),
      action: null,
    };
  }
  return { text: wall.message, action: wall.kind === "plan" ? "See plans" : "Buy credits" };
}
