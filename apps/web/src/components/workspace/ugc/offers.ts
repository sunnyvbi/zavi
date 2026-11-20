
import type { CreatorOfferView } from "./types";

export const offerTitleOf = (count: number) => `${count} UGC video${count > 1 ? "s" : ""}`;

export function offerWhat(o: Pick<CreatorOfferView, "kind" | "terms">): string {
  const t = o.terms?.title;
  if (typeof t === "string" && t.trim()) return t.trim();
  return o.kind === "ugc_video" ? "Custom video" : "Custom offer";
}

export function offerDue(o: Pick<CreatorOfferView, "delivery_days" | "terms">): string {
  const d = o.terms?.["due_date"];
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  return `${o.delivery_days} days after it starts`;
}

export function offerWhen(o: Pick<CreatorOfferView, "delivery_days" | "terms">): string {
  const due = offerDue(o);
  return /^\d/.test(due) ? `delivered in ${due}` : `due ${due}`;
}
