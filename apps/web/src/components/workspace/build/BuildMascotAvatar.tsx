"use client";

export const BUILD_MASCOT_SRC = "/mascots/video/zavi-still.webp";

export function BuildMascotAvatar() {
  return (
    <span
      aria-hidden
      title="Zavi"
      data-testid="build-reply-avatar"
      className="flex h-6 w-6 shrink-0 items-center justify-center overflow-visible"
    >
      <img src={BUILD_MASCOT_SRC} alt="" width={40} height={40} className="h-10 w-10 max-w-none object-contain" />
    </span>
  );
}
