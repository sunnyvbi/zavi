import { CGO_AD_CHANNELS } from "./cgo-ads";
import { CGO_ORGANIC_TARGETS } from "./goal-owner";

export function channelAutoCapable(slug: string): boolean {
  return CGO_AD_CHANNELS.has(slug) || CGO_ORGANIC_TARGETS.has(slug);
}
