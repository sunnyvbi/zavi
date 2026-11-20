import { NATIVE_DESCRIPTOR_TO_COMPOSIO } from "./native-composio-map";

export type Rail = "native" | "composio";
export const RAIL_OVERRIDES: Record<string, Rail> = {
  instagram: "composio",
  reddit: "composio",
  tiktok_ads: "composio",
  reddit_ads: "composio",
  google_analytics: "composio",
  google_search_console: "composio",
};

const HAS_NATIVE = new Set(Object.values(NATIVE_DESCRIPTOR_TO_COMPOSIO).flat());
export function railFor(toolkit: string): Rail {
  const k = toolkit.toLowerCase();
  return Object.hasOwn(RAIL_OVERRIDES, k) ? RAIL_OVERRIDES[k] : HAS_NATIVE.has(k) ? "native" : "composio";
}
