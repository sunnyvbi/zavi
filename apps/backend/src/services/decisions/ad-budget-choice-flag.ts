import { globalClient } from "@/services/tenant-client";

export const AD_BUDGET_CHOICE_KEY = "ad_budget_choice_enabled";

export function adBudgetChoiceFromBlob(blob: unknown): boolean {
  if (!blob || typeof blob !== "object") return false;
  return (blob as Record<string, unknown>)[AD_BUDGET_CHOICE_KEY] !== false;
}

export async function adBudgetChoiceEnabled(): Promise<boolean> {
  try {
    const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle();
    return error ? false : adBudgetChoiceFromBlob(data?.blob ?? {});
  } catch {
    return false;
  }
}

export async function adBudgetChoiceState(): Promise<"on" | "off" | "unreadable"> {
  try {
    const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle();
    if (error) return "unreadable";
    const blob = data?.blob ?? {};
    if (!blob || typeof blob !== "object") return "unreadable";
    return adBudgetChoiceFromBlob(blob) ? "on" : "off";
  } catch {
    return "unreadable";
  }
}
