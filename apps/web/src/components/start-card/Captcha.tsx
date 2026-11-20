"use client";

import { useState } from "react";
import { TurnstileWidget } from "@/app/launch-video/LaunchVideoForm";
import type { CaptchaConfig } from "./useTurnstileConfig";

export function StartCardCaptcha({
  cfg,
  onToken,
}: {
  cfg: CaptchaConfig | null | undefined;
  onToken: (t: string | null) => void;
}) {
  const [unavailable, setUnavailable] = useState(false);
  if (!cfg?.required) return null;
  if (!cfg.siteKey || unavailable) {
    return (
      <p className="mt-2 text-[13px] text-rose-700">
        We can&apos;t load the verification check right now. Turn off any blocker for this page, or try again in a
        moment.
      </p>
    );
  }
  const size = typeof window !== "undefined" && window.innerWidth < 420 ? "compact" : "normal";
  return (
    <TurnstileWidget siteKey={cfg.siteKey} onToken={onToken} onUnavailable={() => setUnavailable(true)} size={size} />
  );
}

export function captchaReady(cfg: CaptchaConfig | null | undefined, token: string | null): boolean {
  return !cfg?.required || !!token;
}
