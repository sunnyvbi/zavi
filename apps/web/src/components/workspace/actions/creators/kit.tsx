"use client";

import { useState, type ReactNode } from "react";

export const BTN =
  "inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-cta px-4 text-[14px] font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_PRIMARY = `${BTN} bg-ink text-cream hover:bg-ink/85`;
export const BTN_SECONDARY = `${BTN} border border-rule bg-cream text-ink hover:bg-bone`;
export const CARD = "rounded-2xl border border-rule bg-cream p-4";
export const FIELD =
  "w-full rounded-lg border border-rule bg-cream px-3 py-2 text-[14px] text-ink placeholder:text-inkLight focus:border-inkMuted focus:outline-none";

const CHIP_TONE = {
  zinc: "bg-ink/[0.06] text-inkSoft",
  green: "bg-emerald-500/10 text-emerald-600",
  amber: "bg-amber-500/10 text-amber-600",
  red: "bg-red-500/10 text-red-600",
  blue: "bg-[#027bff]/10 text-[#3b82f6]",
} as const;
export type Tone = keyof typeof CHIP_TONE;

export function Chip({ tone = "zinc", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[13px] font-semibold ${CHIP_TONE[tone]}`}>
      {children}
    </span>
  );
}

export function Avatar({ name, size = "size-10", photoUrl = null }: { name: string; size?: string; photoUrl?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (photoUrl && failed !== photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a signed storage URL, not a static asset
      <img
        src={photoUrl}
        alt={`${name}'s photo`}
        onError={() => setFailed(photoUrl)}
        className={`${size} shrink-0 rounded-full object-cover`}
      />
    );
  }
  return (
    <span
      className={`creator-avatar flex ${size} shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-200 to-amber-100 text-[14px] font-bold text-inkSoft`}
    >
      {name.charAt(0)}
    </span>
  );
}

