"use client";

import type { ReactNode } from "react";
import { openPreferences } from "@/lib/consent";

export function CookiePrefsButton({
  className,
  children = "Cookie preferences",
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button type="button" onClick={openPreferences} className={className}>
      {children}
    </button>
  );
}
