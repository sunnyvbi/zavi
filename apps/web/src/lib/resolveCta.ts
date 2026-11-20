import { cookies } from "next/headers";
import { createServerSupabase } from "@/lib/supabase";
import { apiUrl } from "@/lib/api";

export type Cta = { href: string; label: string; shortLabel?: string };

export type MarketingSession = {
  cta: Cta;
  email: string | null;
};

export async function resolveCta(): Promise<Cta> {
  return (await resolveMarketingSession()).cta;
}

export const MARKETING_SESSION_DEADLINE_MS = 1_500;
const SIGNED_OUT_FALLBACK: MarketingSession = {
  cta: { href: "/start", label: "Get Started" },
  email: null,
};

export async function resolveMarketingSession(): Promise<MarketingSession> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<MarketingSession>((resolve) => {
    timer = setTimeout(() => resolve(SIGNED_OUT_FALLBACK), MARKETING_SESSION_DEADLINE_MS);
  });
  try {
    return await Promise.race([lookupMarketingSession(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function lookupMarketingSession(): Promise<MarketingSession> {
  try {
    const sb = createServerSupabase(await cookies());
    const { data: userData } = await sb.auth.getUser();
    if (!userData?.user) {
      return SIGNED_OUT_FALLBACK;
    }

    const email = userData.user.email ?? null;
    const { data: profile } = await sb
      .from("profiles")
      .select("active_tenant_id, beta_invited_at")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (profile?.active_tenant_id) {
      return { cta: { href: "/workspace", label: "Open Zavi" }, email };
    }
    return { cta: { href: "/start", label: "Continue onboarding", shortLabel: "Continue" }, email };
  } catch {
    return SIGNED_OUT_FALLBACK;
  }
}

export async function resolveCreatorsPageSession(): Promise<MarketingSession> {
  const session = await resolveMarketingSession();
  if (!session.email || session.cta.href !== "/start") return session;
  try {
    const sb = createServerSupabase(await cookies());
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return session;
    const r = await fetch(apiUrl("/api/creator/me"), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    return r.ok ? { ...session, cta: CREATOR_AREA_CTA } : session;
  } catch {
    return session;
  }
}

export const CREATOR_AREA_CTA: Cta = { href: "/creator", label: "Open your creator area", shortLabel: "Creator area" };
