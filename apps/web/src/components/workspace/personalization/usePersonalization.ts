"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { errorMessageOf } from "./shared";

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
  const [data, setData] = useState<Personalization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/personalization");
      const body = (await res.json().catch(() => null)) as { personalization?: Personalization } | null;
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      setData(body?.personalization ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load personalization.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (patch: PersonalizationPatch): Promise<Personalization> => {
    const res = await apiFetch("/api/personalization", { method: "PUT", body: JSON.stringify(patch) });
    const body = (await res.json().catch(() => null)) as { personalization?: Personalization } | null;
    if (!res.ok || !body?.personalization) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
    setData(body.personalization);
    return body.personalization;
  }, []);

  return { data, loading, error, reload: load, save };
}
