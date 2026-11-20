
import { readHandles, readPii, type HumanMemberRow } from "@/services/humans/store";

export type PublicMemberView = {
  human_member_id: string;
  display_name: string;
  discipline: string;
  skills: string[];
  rate_usd: number | null;
  rate_unit: string | null;
  vetting_state: string;
  rejected_reason: string | null;
  handle_verified_at: string | null;
  created_at: string;
  updated_at: string | null;
  handles: Array<{ platform: string; handle: string }>;
  portfolio_urls: string[];
  screenshots: string[];
  legal_name: string | null;
  email: string | null;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function publicMemberView(member: HumanMemberRow): Promise<PublicMemberView> {
  const [handles, pii] = await Promise.all([readHandles(member.id), readPii(member.id)]);
  const profile = (member.profile ?? {}) as Record<string, unknown>;
  return {
    human_member_id: member.id,
    display_name: member.display_name,
    discipline: member.discipline,
    skills: stringArray(member.skills),
    rate_usd: member.rate_usd,
    rate_unit: member.rate_unit,
    vetting_state: member.vetting_state,
    rejected_reason: member.rejected_reason,
    handle_verified_at: member.handle_verified_at,
    created_at: member.created_at,
    updated_at: member.updated_at,
    handles: handles.map((h) => ({ platform: h.platform, handle: h.handle })),
    portfolio_urls: stringArray(profile.portfolio_urls),
    screenshots: stringArray(profile.screenshots),
    legal_name: pii?.legal_name ?? null,
    email: pii?.email ?? null,
  };
}
