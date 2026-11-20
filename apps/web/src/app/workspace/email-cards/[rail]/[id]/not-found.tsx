"use client";

import Link from "next/link";
import { useEffect } from "react";
import { readStored } from "@/components/workspace/layout/workspacePrefs";
import { applyThemeColor, resolveDark, THEME_KEY } from "@/lib/themeColor";

function prefersDark(): boolean {
  return resolveDark(
    readStored(THEME_KEY),
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
}

export default function EmailCardNotFound() {
  useEffect(() => {
    const dark = prefersDark();
    document.documentElement.classList.toggle("dark", dark);
    const restoreThemeColor = applyThemeColor(dark);
    return () => {
      restoreThemeColor();
      document.documentElement.classList.remove("dark");
    };
  }, []);

  return (
    <div className="workspace-shell min-h-screen bg-cream text-ink">
      <div className="mx-auto max-w-5xl px-4 py-8 mt-[var(--service-banner-h,0px)] md:px-6">
        <Link href="/workspace?tab=channels&channel=email_marketing" className="text-[14px] text-inkMuted hover:text-ink">
          Back to Email campaigns
        </Link>
        <h1 className="mt-3 font-display text-[22px] font-semibold text-ink">Email campaign</h1>
        <p className="mt-4 text-[16px] leading-[1.6] text-inkMuted">
          That email link is not right. Open Email campaigns to find your emails.
        </p>
      </div>
    </div>
  );
}
