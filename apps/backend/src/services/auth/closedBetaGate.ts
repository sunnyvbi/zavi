
import { serviceClient } from "@/services/supabase";

export type BetaGateResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

export async function requireClosedBetaGrant(userId: string): Promise<BetaGateResult> {
  if (process.env.CLOSED_BETA_ENABLED !== "true") return { ok: true };

  const { data: profile, error } = await serviceClient()
    .from("profiles")
    .select("beta_invited_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.warn(
      `[closedBetaGate] profile-read error for ${userId}: ${error.message} — failing open`,
    );
    return { ok: true };
  }
  if (profile?.beta_invited_at) return { ok: true };
  return {
    ok: false,
    status: 403,
    code: "closed_beta_required",
    message:
      "Praxis is in closed beta. Book a call at https://cal.com/ravi-ramadasu-wgh4xi/30min",
  };
}
