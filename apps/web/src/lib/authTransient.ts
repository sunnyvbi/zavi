const TRANSIENT_AUTH_ERROR_NAMES = new Set(["AuthRetryableFetchError", "AuthUnknownError"]);

export function isTransientAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, status } = error as { name?: unknown; status?: unknown };
  if (typeof name === "string" && TRANSIENT_AUTH_ERROR_NAMES.has(name)) return true;
  return typeof status === "number" && status >= 500;
}
