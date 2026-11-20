export function commitErrorMessage(status: number, body: unknown): string {
  const rawMsg =
    (
      body as {
        error?: {
          message?: string;
        };
      } | null
    )?.error?.message ?? "";
  const code =
    (
      body as {
        error?: {
          code?: string;
        };
      } | null
    )?.error?.code ?? "";
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return "You appear to be offline. Reconnect and try again.";
  }
  if (
    code === "insufficient_credits_for_build" ||
    code === "provision_budget_exceeded" ||
    code === "daily_build_limit_reached"
  ) {
    return (
      rawMsg ||
      "This workspace can't start another build right now. Your workspace is ready. Open it and try from there."
    );
  }
  if (code === "multi_workspace_not_enabled" || code === "tenant_limit") {
    return rawMsg || "You can't add another company to this account right now.";
  }
  if (code === "build_not_configured") {
    return (
      rawMsg ||
      "Builds are temporarily unavailable. Nothing was started and nothing was charged. Please try again later."
    );
  }
  if (code === "product_builder_disabled") {
    return "Building new apps is paused right now. Nothing was started and nothing was charged. Please try again a little later.";
  }
  if (code === "product_builder_unavailable") {
    return (
      rawMsg ||
      "Building is paused right now. Nothing was started or charged. Please try again in a minute."
    );
  }
  if (code === "build_start_unrecorded") {
    return (
      rawMsg ||
      "Your workspace is ready, but the build could not be started from here. Press Build again to start it there."
    );
  }
  if (code === "build_setup_failed") {
    return (
      rawMsg ||
      "We couldn't set up this build. Your workspace is ready. Open it and try again in a few minutes."
    );
  }
  if (status >= 500) return "Backend hit an error. Try again in a moment.";
  if (status === 409 || /exists|taken|duplicate/i.test(rawMsg)) {
    return "That value is already taken. Pick a different one and try again.";
  }
  if (status === 422 || status === 400) {
    return "Something in the form didn't save. Please try again.";
  }
  return "Something went wrong. Please try again.";
}
