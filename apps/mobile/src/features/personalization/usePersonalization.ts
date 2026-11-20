import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";

export const BASE_TONES = ["default", "concise", "friendly", "professional", "direct"] as const;
export type BaseTone = (typeof BASE_TONES)[number];

export type Personalization = {
  base_tone: BaseTone;
  warm: boolean;
  enthusiastic: boolean;
  headers_lists: boolean;
  emoji: boolean;
  custom_instructions: string;
  brand_voice: string;
  response_rules: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
};

export const CUSTOM_INSTRUCTIONS_MAX = 4000;

export type PersonalizationPatch = Partial<
  Pick<
    Personalization,
    | "base_tone"
    | "warm"
    | "enthusiastic"
    | "headers_lists"
    | "emoji"
    | "custom_instructions"
    | "brand_voice"
    | "response_rules"
  >
>;

export function usePersonalization() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["personalization", tenant],
    enabled: tenant !== "none",
    queryFn: async () =>
      (await apiJson<{ personalization: Personalization }>("/api/personalization", { timeoutMs: 20_000 })).personalization,
  });
}

export function useSavePersonalization() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useMutation({
    mutationFn: async (patch: PersonalizationPatch) =>
      (
        await apiJson<{ personalization: Personalization }>("/api/personalization", {
          method: "PUT",
          body: JSON.stringify(patch),
        })
      ).personalization,
    onSuccess: (saved) => {
      qc.setQueryData(["personalization", tenant], saved);
      void qc.invalidateQueries({ queryKey: ["personalization-summary", tenant] });
    },
  });
}

export function updatedLabel(at: string | null | undefined): string {
  if (!at) return "Not saved yet";
  const then = new Date(at).getTime();
  if (!Number.isFinite(then)) return "Not saved yet";
  const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (sec < 300) return "Updated just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `Updated ${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Updated ${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `Updated ${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 8) return `Updated ${wk}w ago`;
  return `Updated ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
