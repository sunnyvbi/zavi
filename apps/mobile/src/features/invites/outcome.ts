export type InviteFailure = "already" | "revoked" | "notfound" | "wrong" | "signedout" | "failed";

export function inviteFailure(e: unknown): InviteFailure {
  const { status, code } = (e ?? {}) as { status?: number; code?: string };
  if (code === "already_accepted" || status === 409) return "already";
  if (code === "invite_revoked" || status === 410) return "revoked";
  if (code === "email_mismatch" || status === 403) return "wrong";
  if (code === "unauthenticated" || status === 401) return "signedout";
  if (status === 404 || status === 400) return "notfound";
  return "failed";
}
