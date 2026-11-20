"use client";

import { useEffect, useState } from "react";
import { fetchStartCardConfig } from "@/lib/start-card/api";

export type CaptchaConfig = { required: boolean; siteKey: string | null };

export function useStartCardCaptcha(): CaptchaConfig | null | undefined {
  const [cfg, setCfg] = useState<CaptchaConfig | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    fetchStartCardConfig()
      .then((c) => {
        if (!cancelled) setCfg({ required: c?.captcha?.required === true, siteKey: c?.captcha?.site_key ?? null });
      })
      .catch(() => {
        if (!cancelled) setCfg(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return cfg;
}
