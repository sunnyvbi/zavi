
import { globalClient } from "@/services/tenant-client";

export type HumanMember = {
  id: string;
  display_name: string;
  discipline: string;
  vetting_state: string;
};

export async function loadHumanMemberByAuthUser(
  user_id: string,
): Promise<HumanMember | null> {
  const { data, error } = await globalClient()
    .from("human_members")
    .select("id, display_name, discipline, vetting_state")
    .eq("auth_user_id", user_id)
    .maybeSingle();
  if (error) throw new Error(`human_members read failed: ${error.message}`);
  return (data as HumanMember | null) ?? null;
}

export function isApprovedHumanMember(m: HumanMember | null): m is HumanMember {
  return m !== null && m.vetting_state === "approved";
}
