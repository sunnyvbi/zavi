
export const AD_LOCATION_SLUGS: ReadonlySet<string> = new Set(["google_ads", "youtube_ads", "meta_ads"]);

export const MAX_PLACES = 50;

export type AdPlace = {
  id: string;
  name: string;
  kind: "City" | "State" | "Country" | "Region";
  source?: "orders" | "address";
  reason?: string;
};
export type Country = { code: string; name: string };

export type LocationStatus =
  | { state: "none" }
  | {
      state: "needs_you" | "saved" | "unsupported";
      channel: string;
      campaign: { id: string; name: string | null };
      country: Country | null;
      places: AdPlace[];
      targeting: "single" | "mixed" | "unsupported";
      ad_groups: number;
      pending: boolean;
      last_error: string | null;
      order_cities: string[];
      fingerprint: string;
    };

export type ActiveStatus = Extract<LocationStatus, { campaign: unknown }>;

export type Suggestions = {
  orders: "confirmed" | "not_set_up" | "no_db";
  country: Country | null;
  places: AdPlace[];
  picked: string[];
};

export const SOURCE_LABEL: Record<"orders" | "address", string> = { orders: "Your orders", address: "Your address" };

export function countryArticle(name: string): string {
  return /^(United |Netherlands$|Philippines$|Czech Republic$|Bahamas$|Gambia$)/.test(name) ? "the " : "";
}

export function joinAnd(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export function countryText(country: Country | null): string {
  return country ? `${countryArticle(country.name)}${country.name}` : "your country";
}

export function manageWhere(slug: string): string {
  return slug === "meta_ads" ? "Meta Ads Manager" : "Google Ads";
}

export function unsupportedLine(channelName: string, slug: string): string {
  return `Zavi can't change where this ${channelName} campaign shows. Change it in ${manageWhere(slug)}.`;
}

export function needsYouLine(s: ActiveStatus, channelName: string): string {
  return `Zavi started your new ${channelName} campaign across ${countryText(s.country)} so it can learn today. If you don't pick places, it stays on the whole country.`;
}

export function ordersHint(cities: readonly string[]): string | null {
  if (!cities.length) return null;
  return `Most of your orders come from ${joinAnd(cities)}. Narrowing to ${cities.length === 1 ? "it" : "them"} usually spends less for the same orders.`;
}

export function savedLine(s: ActiveStatus): string {
  return `${s.places.map((p) => p.name).join(", ")}. ${s.pending ? "Zavi is updating your campaign now." : "Zavi tells you if orders start coming from somewhere new."}`;
}

export function pickedSubtitle(places: readonly AdPlace[], loaded: boolean): string {
  if (!loaded) return "Loading suggestions…";
  const orders = places.some((p) => p.source === "orders");
  const address = places.some((p) => p.source === "address");
  if (orders) return address ? "Zavi suggested these from your orders and address." : "Zavi suggested these from your orders.";
  return address ? "Zavi suggested these from your address." : "Search for the places your customers are in.";
}

export function saveLabel(n: number, busy: boolean): string {
  if (busy) return "Saving…";
  return n ? `Save ${n} place${n === 1 ? "" : "s"}` : "Save whole country";
}

export function messageOf(body: unknown, fallback: string): string {
  const m = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === "string" && m.trim() ? m : fallback;
}

export function initialPicked(status: ActiveStatus, sugg: Suggestions): AdPlace[] {
  const countryWide = status.places.length === 1 && status.places[0].kind === "Country";
  return countryWide ? sugg.places.filter((p) => sugg.picked.includes(p.id)) : status.places;
}

export function togglePlace(cur: readonly AdPlace[], p: AdPlace): AdPlace[] {
  if (cur.some((x) => x.id === p.id)) return cur.filter((x) => x.id !== p.id);
  return cur.length >= MAX_PLACES ? [...cur] : [...cur, p];
}
