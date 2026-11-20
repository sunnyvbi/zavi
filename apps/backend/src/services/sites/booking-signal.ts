const BOOKING_BRIEF_RE =
  /\b(?:bookings?|appointments?|reservations?|book(?:ing)?\s+(?:an?\s+|your\s+|their\s+)?(?:slot|time|table|session|class|lesson|visit|stay|room|appointment|treatment|haircut)s?)\b/gi;
const NEGATED_BEFORE_RE = /\b(?:no|not|without|never|don'?t|doesn'?t|won'?t|walk[- ]?ins?)\b[^,]{0,30}$/i;
const OFFLINE_BEFORE_RE = /\b(?:call|phone|ring|email|text|message|whatsapp)\s+(?:us\s+)?(?:for|to\s+make)\s+(?:an?\s+|your\s+)?$/i;
const BOOKING_PATH_RE = /^\/(?:book|booking|bookings|appointments?|reserve|reservations?)(?:[/?#]|$)/i;
const BOOKING_COLLECTION_RE = /^(?:bookings?|appointments?|reservations?)$/i;

export function isBookingCollection(name: unknown): boolean {
  return typeof name === "string" && BOOKING_COLLECTION_RE.test(name);
}

export const BOOKING_JOURNEY_RE = /^(?:book|booking|reserve|reservation|appointment)(?:-|$)/;

export function briefMentionsBooking(brief: string | null | undefined): boolean {
  if (typeof brief !== "string") return false;
  for (const m of brief.matchAll(BOOKING_BRIEF_RE)) {
    const before = brief.slice(0, m.index).split(/[.;!?\n]/).pop() ?? "";
    if (!NEGATED_BEFORE_RE.test(before) && !OFFLINE_BEFORE_RE.test(before)) return true;
  }
  return false;
}

export function isBookingPath(path: unknown): boolean {
  return typeof path === "string" && BOOKING_PATH_RE.test(path);
}

export function manifestMentionsBooking(doc: unknown): boolean {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  const d = doc as { routes?: unknown; smoke?: { journeys?: unknown }; collections?: unknown };
  const paths: unknown[] = [];
  if (Array.isArray(d.routes)) paths.push(...d.routes);
  const journeys = Array.isArray(d.smoke?.journeys) ? (d.smoke!.journeys as Array<Record<string, unknown> | null>) : [];
  for (const j of journeys) {
    if (!j || typeof j !== "object") continue;
    paths.push(j.path);
    if (Array.isArray(j.steps)) for (const s of j.steps as Array<Record<string, unknown> | null>) paths.push(s?.visit);
  }
  if (paths.some(isBookingPath)) return true;
  const c = d.collections;
  return !!c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).some((k) => BOOKING_COLLECTION_RE.test(k));
}
