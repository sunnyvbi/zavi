"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { PhoneSurfaceSlug } from "@/app/connectors/phoneSurfaces";

export type PhoneHandset = {
  id: string;
  name: string | null;
  number: string;
};

function toHandset(v: unknown): PhoneHandset | null {
  if (!v || typeof v !== "object") return null;
  const h = v as Record<string, unknown>;
  if (typeof h.id !== "string" || typeof h.number !== "string") return null;
  return { id: h.id, number: h.number, name: typeof h.name === "string" ? h.name : null };
}

export function usePhoneHandsets(
  slug: PhoneSurfaceSlug | null,
  enabled: boolean,
): {
  handsets: PhoneHandset[];
  reload: () => void;
} {
  const [handsets, setHandsets] = useState<PhoneHandset[]>([]);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled || !slug) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/connectors/${slug}/status`);
        if (cancelled || !res.ok) return;
        const json = (await res.json()) as { handsets?: unknown };
        if (cancelled || !Array.isArray(json.handsets)) return;
        setHandsets(json.handsets.map(toHandset).filter((h): h is PhoneHandset => h !== null));
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, enabled, tick]);

  return { handsets, reload };
}

export function handsetLabel(h: PhoneHandset): string {
  return h.name ?? h.number;
}

export function handsetsLabel(handsets: PhoneHandset[]): string {
  if (handsets.length === 0) return "";
  const labels = handsets.map(handsetLabel);
  if (labels.length <= 2) return labels.join(" · ");
  return `${labels[0]} +${labels.length - 1} more`;
}
