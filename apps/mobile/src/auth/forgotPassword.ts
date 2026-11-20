import { apiJson } from "../lib/api";

const WEB_ORIGIN = "https://www.zaviagent.com";

export async function sendPasswordReset(email: string): Promise<void> {
  const redirectTo = `${WEB_ORIGIN}/auth/callback?next=${encodeURIComponent("/reset-password")}`;
  await apiJson("/api/auth/email/send-reset", {
    method: "POST",
    body: JSON.stringify({ email, redirectTo }),
  });
}
