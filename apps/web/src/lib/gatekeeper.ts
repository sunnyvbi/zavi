"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export async function checkCanAddCompany(): Promise<boolean> {
  try {
    const res = await apiFetch("/api/onboarding/can-add-company");
    if (!res.ok) return false;
    const body = (await res.json()) as { allowed?: unknown };
    return body.allowed === true;
  } catch {
    return false;
  }
}

export function useCanAddCompany(): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void checkCanAddCompany().then((v) => {
      if (!cancelled) setAllowed(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return allowed;
}

export async function checkFeature(name: string, fallback = false): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/gatekeeper/check/${encodeURIComponent(name)}`);
    if (!res.ok) return fallback;
    const body = (await res.json()) as { enabled?: unknown };
    return body.enabled === true;
  } catch {
    return fallback;
  }
}

export function useFeature(name: string, fallback = false): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setEnabled(null);
    void checkFeature(name, fallback).then((v) => {
      if (!cancelled) setEnabled(v);
    });
    return () => {
      cancelled = true;
    };
  }, [name, fallback]);
  return enabled;
}
