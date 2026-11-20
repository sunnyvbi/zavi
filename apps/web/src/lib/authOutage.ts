
export const AUTH_OUTAGE_MESSAGE =
  "Zavi is having trouble right now. Your account is fine. Please try again in a few minutes.";

const OUTAGE_RE =
  /timed out|timeout|fetch failed|failed to fetch|networkerror|network request failed|load failed|aborted|service unavailable|bad gateway|gateway time|upstream|\b50[0-4]\b|\b52[0-4]\b/i;

export function isAuthOutage(message: string): boolean {
  return OUTAGE_RE.test(message);
}

export function authFailureMessage(message: string, status?: number | null): string {
  if ((status ?? 0) >= 500 || isAuthOutage(message)) return AUTH_OUTAGE_MESSAGE;
  return message;
}
