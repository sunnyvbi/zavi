
export class EmailNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailNotSentError";
  }
}

export function isDefiniteSendRejection(e: unknown): boolean {
  if (e instanceof EmailNotSentError) return true;
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: unknown; response?: unknown };
  return typeof err.code === "number" && err.code >= 400 && err.response != null && typeof err.response === "object";
}
