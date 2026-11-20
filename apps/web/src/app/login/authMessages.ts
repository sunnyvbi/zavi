
import { AUTH_OUTAGE_MESSAGE, isAuthOutage } from "@/lib/authOutage";

export const GENERIC_AUTH_ERROR = "Something went wrong. Please try again.";

export const DIFFERENT_BROWSER_MESSAGE =
  "This link opened in a different browser. Sign in again here, or open the link in the browser you signed up in.";

export const LINK_EXPIRED_MESSAGE = "Sign-in did not complete. Request a new link to try again.";

export const SIGN_IN_CANCELLED_MESSAGE = "Sign-in was cancelled.";

const DIFFERENT_BROWSER_RE = /code verifier|pkce|flow state/i;
const CANCELLED_RE = /access_denied|cancel|denied/i;
const EXPIRED_RE = /expired|invalid|request a new link/i;

export function humanAuthMessage(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  const trimmed = text.trim();
  if (!trimmed) return GENERIC_AUTH_ERROR;
  if (trimmed === "[object Object]") return GENERIC_AUTH_ERROR;
  if (/^[[{].*[\]}]$/s.test(trimmed)) return GENERIC_AUTH_ERROR;
  if (isAuthOutage(trimmed)) return AUTH_OUTAGE_MESSAGE;
  return trimmed;
}

export function loginErrorParamMessage(raw: string | null): string | null {
  if (raw === null || !raw.trim()) return null;
  if (DIFFERENT_BROWSER_RE.test(raw)) return DIFFERENT_BROWSER_MESSAGE;
  if (CANCELLED_RE.test(raw)) return SIGN_IN_CANCELLED_MESSAGE;
  return GENERIC_AUTH_ERROR;
}

export type CallbackFailure = { message: string; action: "Sign in" | "Try again" };

export function callbackFailure(raw: unknown): CallbackFailure {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  if (DIFFERENT_BROWSER_RE.test(text)) return { message: DIFFERENT_BROWSER_MESSAGE, action: "Sign in" };
  if (isAuthOutage(text)) return { message: AUTH_OUTAGE_MESSAGE, action: "Try again" };
  if (EXPIRED_RE.test(text)) return { message: LINK_EXPIRED_MESSAGE, action: "Try again" };
  return { message: GENERIC_AUTH_ERROR, action: "Try again" };
}
