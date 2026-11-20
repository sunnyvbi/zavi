"use client";

import { useEffect, useMemo, useState } from "react";
import { createAvatar } from "@dicebear/core";
import { adventurer } from "@dicebear/collection";
import { agentDisplayName } from "@/lib/agentRegistry";

const BACKGROUNDS = [
  "f0f0f0",
  "e6f2ff",
  "f5faf8",
  "fbeccb",
  "fef2f3",
  "ede9fe",
];

const SIZE_MAP = {
  sm: { px: 24, cls: "h-6 w-6" },
  md: { px: 28, cls: "h-7 w-7" },
  lg: { px: 36, cls: "h-9 w-9" },
  xl: { px: 58, cls: "h-[58px] w-[58px]" },
} as const;

type Size = keyof typeof SIZE_MAP;
type Shape = "circle" | "squircle" | "tile";

const uriCache = new Map<string, string>();

function avatarUri(slug: string, radius: number): string {
  const key = `${slug}:${radius}`;
  const cached = uriCache.get(key);
  if (cached) return cached;
  const uri = createAvatar(adventurer, {
    seed: slug,
    radius,
    backgroundColor: BACKGROUNDS,
    backgroundType: ["solid"],
  }).toDataUri();
  uriCache.set(key, uri);
  return uri;
}

const FIGMA_AVATAR_SLUGS = new Set([
  "operator",
  "chief-of-staff",
  "pm",
  "engineer",
  "content-design",
  "qa",
  "growth-lead",
  "performance-marketer",
  "advisor",
  "research",
  "support-lead",
  "dispute-response",
]);

function figmaAvatarFor(slug: string): string | null {
  if (FIGMA_AVATAR_SLUGS.has(slug)) return slug;
  if (slug === "content-seo") return "content-design";
  return null;
}

export function AgentAvatar({
  slug,
  size = "md",
  shape = "circle",
}: {
  slug: string;
  size?: Size;
  shape?: Shape;
}) {
  const dims = SIZE_MAP[size];
  const squircle = shape === "squircle";
  const tile = shape === "tile";
  const radius = squircle ? 33 : tile ? 20 : 50;
  const uri = useMemo(() => avatarUri(slug, radius), [slug, radius]);
  const name = agentDisplayName(slug);
  const shapeCls = squircle
    ? "rounded-[19.333px] border-[2.417px] border-solid border-[#f0f0f0]"
    : tile
      ? "rounded-[6px] border-[0.5px] border-solid border-[#f0f0f0]"
      : "rounded-full border-[0.5px] border-[#f0f0f0]";

  const figSlug = figmaAvatarFor(slug);
  const src = figSlug ? `/agent-avatars/${figSlug}.png` : uri;

  if (slug === "operator") {
    return (
      <span
        aria-hidden
        title={name}
        className={`flex shrink-0 items-center justify-center overflow-hidden ${dims.cls} ${shapeCls}`}
        style={{
          background:
            "radial-gradient(135% 110% at 50% 118%, #3f8cff 0%, #1e6bff 34%, #0b2a7a 62%, rgba(6,7,11,0) 82%), #06070b",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/zavi-white.svg" alt="" className="w-[68%]" />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden
      title={name}
      width={dims.px}
      height={dims.px}
      className={`shrink-0 bg-white object-cover ${dims.cls} ${shapeCls}`}
    />
  );
}

export function PersonAvatar({
  seed,
  photoUrl,
  size = "lg",
}: {
  seed: string;
  photoUrl?: string | null;
  size?: Size;
}) {
  const dims = SIZE_MAP[size];
  const fallback = useMemo(() => avatarUri(seed, 50), [seed]);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photoUrl, seed]);
  const src = photoUrl && !failed ? photoUrl : fallback;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden
      width={dims.px}
      height={dims.px}
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-full border-[0.5px] border-[#f0f0f0] bg-white object-cover ${dims.cls}`}
    />
  );
}
