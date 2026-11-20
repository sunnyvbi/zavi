
import type { DecideAction } from "./decide-service";

const ALREADY: Record<"approve" | "reject", ReadonlySet<string>> = {
  approve: new Set(["approved", "dispatching", "acted", "dispatch_failed"]),
  reject: new Set(["rejected"]),
};

export function decisionClosedElsewhere(action: DecideAction, r: { changed: boolean; status: string | null }): string | null {
  if (r.changed || !r.status || ALREADY[action].has(r.status)) return null;
  const verb = action === "approve" ? "Not approved" : "Not rejected";
  switch (r.status) {
    case "proposed":
      return `${verb}: something else was updating this proposal at that moment. Nothing changed; try again.`;
    case "superseded":
      return `${verb}: this proposal was closed just before your click because it was out of date (for a budget, the amount had already changed). Zavi proposes again from the current numbers.`;
    case "expired":
      return `${verb}: this proposal had expired.`;
    case "rejected":
      return `${verb}: it was already rejected.`;
    case "approved":
    case "dispatching":
    case "acted":
    case "dispatch_failed":
      return `${verb}: it was already approved.`;
    default:
      return `${verb}: this proposal is already closed (${r.status}).`;
  }
}
