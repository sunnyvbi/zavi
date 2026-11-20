
export class AuthStepError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AuthStepError";
  }
}

export function authFailedProps(error: unknown): { reason: string; status?: number } {
  if (error instanceof AuthStepError) return { reason: error.code || "unknown", status: error.status };
  if (error instanceof TypeError) return { reason: "network" };
  return { reason: "unknown" };
}
