import { EMAIL_TOOL_LABEL, type EmailTool } from "@/services/connectors/email-campaign/providers";

export type DeliveryState = "unconfirmed" | "reached" | "nobody";

export type Delivery = { state: DeliveryState; people: number | null; skipped?: number };

export const NOBODY_REACHED_REASON =
  "SendGrid accepted this send but reports that nobody received it. The usual reason is that everyone on the list is unsubscribed or suppressed in SendGrid. Check Suppressions in SendGrid.";

const positive = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const peopleWord = (n: number): string => (n === 1 ? "person" : "people");
const isTool = (route: string | null): route is EmailTool => route === "sendgrid" || route === "mailchimp" || route === "klaviyo";

function reachedIn(stage: Record<string, unknown>): number | null {
  return positive(stage.recipients) ?? positive(stage.delivered);
}

function eventsIn(stage: Record<string, unknown>): { received: number; skipped: number } | null {
  if (typeof stage.received !== "number" && typeof stage.skipped !== "number") return null;
  return { received: positive(stage.received) ?? 0, skipped: positive(stage.skipped) ?? 0 };
}

export function deliveryOf(route: string | null, h1: Record<string, unknown> | null | undefined, d7: Record<string, unknown> | null | undefined): Delivery | null {
  if (!isTool(route)) return null;
  const late = d7 ?? {};
  const early = h1 ?? {};
  const events = eventsIn(late) ?? eventsIn(early);
  if (events && events.received > 0) return { state: "reached", people: events.received, skipped: events.skipped };
  if (events && events.skipped > 0) return { state: "nobody", people: 0, skipped: events.skipped };
  const people = reachedIn(late) ?? reachedIn(early);
  if (people !== null) return { state: "reached", people };
  if (route === "sendgrid" && (late.reported_empty === true || early.reported_empty === true)) return { state: "nobody", people: 0 };
  return { state: "unconfirmed", people: null };
}

export function deliveryReason(route: string | null, d: Delivery | null): string | null {
  if (!d || !isTool(route)) return null;
  const tool = EMAIL_TOOL_LABEL[route];
  if (d.state === "nobody") {
    if (!d.skipped) return NOBODY_REACHED_REASON;
    return `${tool} accepted this send but skipped all ${d.skipped.toLocaleString("en-US")} ${peopleWord(d.skipped)} on the list, so nobody received it. Check those addresses in ${tool}.`;
  }
  if (d.state === "reached" && d.skipped && d.people) {
    const all = d.people + d.skipped;
    return `${tool} skipped ${d.skipped.toLocaleString("en-US")} of ${all.toLocaleString("en-US")} people, so ${d.people.toLocaleString("en-US")} ${d.people === 1 ? "person" : "people"} received it. Check the skipped addresses in ${tool}.`;
  }
  return null;
}
