import posthog from "posthog-js";

export type IdentifyProps = {
  email?: string;
  tenant_id?: string | null;
  tenant_name?: string | null;
  role?: string | null;
};

function loaded(): boolean {
  return (
    typeof window !== "undefined" &&
    (posthog as unknown as { __loaded?: boolean }).__loaded === true
  );
}

export function identifyUser(userId: string, props: IdentifyProps = {}): void {
  if (!loaded()) return;
  if (!userId || userId === "undefined" || userId === "null") {
    console.warn("[PostHog] identifyUser called with invalid userId:", userId);
    return;
  }

  const clean: Record<string, unknown> = {};
  (Object.keys(props) as (keyof IdentifyProps)[]).forEach((key) => {
    if (props[key] !== undefined) clean[key] = props[key];
  });

  if (
    posthog.get_property("$user_state") === "identified" &&
    posthog.get_distinct_id() !== userId
  ) {
    resetKeepingConsent();
  }
  posthog.identify(userId, clean);
}

export function captureEvent(event: string, props?: Record<string, unknown>): void {
  if (!loaded()) return;
  posthog.capture(event, props);
}

function resetKeepingConsent(): void {
  const optedIn = posthog.has_opted_in_capturing();
  posthog.reset();
  if (optedIn) posthog.opt_in_capturing();
}

export function resetAnalytics(): void {
  if (!loaded()) return;
  resetKeepingConsent();
}

