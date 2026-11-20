
import { track } from "@/lib/analytics/mixpanel";
import { captureEvent } from "@/lib/analytics/posthog";
import { gaEvent } from "@/lib/analytics/google";

export type EventProps = Record<string, string | number | boolean | null | undefined>;

export function trackEvent(event: string, props?: EventProps): void {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v !== undefined) clean[k] = v;
  }
  for (const send of [track, captureEvent, gaEvent]) {
    try {
      send(event, clean);
    } catch {}
  }
}

export function trackEventDeferred(event: string, props?: EventProps): () => void {
  const timer = setTimeout(() => trackEvent(event, props), 0);
  return () => clearTimeout(timer);
}
