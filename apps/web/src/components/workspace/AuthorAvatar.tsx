"use client";

import { useEffect, useState } from "react";

const SIZE: Record<"md" | "ml", { box: string; text: string }> = {
  md: { box: "h-7 w-7", text: "text-[12px]" },
  ml: { box: "h-8 w-8", text: "text-[13px]" },
};

export function AuthorAvatar({
  label,
  photoUrl,
  size = "md",
}: {
  label: string;
  photoUrl?: string | null;
  size?: "md" | "ml";
}) {
  const dims = SIZE[size];
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photoUrl]);

  if (photoUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoUrl}
        alt=""
        aria-hidden
        onError={() => setFailed(true)}
        className={`shrink-0 rounded-full border-[0.5px] border-[#f0f0f0] bg-white object-cover ${dims.box}`}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full border-[0.5px] border-[#f0f0f0] bg-ink font-medium text-white ${dims.box} ${dims.text}`}
    >
      {initial}
    </span>
  );
}
