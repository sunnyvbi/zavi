const SIGN_IN_NAMES: Record<string, string> = { linkedin_ads: "LinkedIn sign-in" };
const FOUNDER_WORDED = new Set(["state_session_mismatch", "connector_exchange_failed", "set_connector_connection_failed"]);

export function finishErrorMessage(slug: string, error?: { code?: string; message?: string }): string {
  if (error?.code && FOUNDER_WORDED.has(error.code) && error.message) return error.message;
  if (error?.code === "invalid_state")
    return `The ${SIGN_IN_NAMES[slug] ?? "sign-in"} took too long or was already used, so nothing was connected. Go back to your workspace and press Connect to try again.`;
  return "The connection could not be finished, so nothing was connected. Go back to your workspace and press Connect to try again.";
}
