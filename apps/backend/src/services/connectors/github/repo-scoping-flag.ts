
import { serviceClient } from "@/services/supabase";

export const REPO_SCOPING_FLAG_KEY = "repo_scoping_enabled";

export type RepoScopingFlagState = "on" | "off" | "unknown";

export async function getRepoScopingFlagState(): Promise<RepoScopingFlagState> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return "unknown";
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob[REPO_SCOPING_FLAG_KEY] === false ? "off" : "on";
  } catch {
    return "unknown";
  }
}

export async function isRepoScopingEnabled(): Promise<boolean> {
  return (await getRepoScopingFlagState()) === "on";
}
