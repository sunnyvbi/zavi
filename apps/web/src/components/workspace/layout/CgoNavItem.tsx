"use client";

import { useNeedsYouSignal } from "../growth/needsYou";
import { CGO_LABEL, FOCUS_RING, cx } from "./shared";

const MASCOT_SRC = "/mascots/video/zavi-still.webp";

function Avatar({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center overflow-hidden"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a 20px static still; next/image adds nothing here */}
      <img src={MASCOT_SRC} alt="" width={size} height={size} className="h-full w-full object-cover" />
    </span>
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "h-2 w-2 shrink-0 rounded-full",
        "bg-[#0F766E] [html.dark_&]:bg-[#5EEAD4]",
        className,
      )}
    >
      <span className="sr-only">Something needs attention</span>
    </span>
  );
}

export function CgoNavItem({ active, onClick, tenantId }: { active: boolean; onClick: () => void; tenantId?: string | null }) {
  const needs = useNeedsYouSignal(tenantId) === "yes";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative flex w-full items-center gap-2.5 rounded-cta px-2.5 py-[7px] text-left text-[14px] font-medium transition-colors duration-150 motion-reduce:transition-none",
        "text-[#0F766E] [html.dark_&]:text-[#5EEAD4]",
        active ? "bg-ink/10 before:absolute before:-left-2 before:top-1/2 before:h-5 before:w-1 before:-translate-y-1/2 before:rounded-r-full before:bg-ink" : "hover:bg-ink/[0.04]",
        FOCUS_RING,
      )}
    >
      <Avatar size={20} />
      <span className="min-w-0 flex-1 truncate">{CGO_LABEL}</span>
      {needs && <Dot />}
    </button>
  );
}

export function CgoRailItem({ active, onClick, tenantId }: { active: boolean; onClick: () => void; tenantId?: string | null }) {
  const needs = useNeedsYouSignal(tenantId) === "yes";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={CGO_LABEL}
      title={CGO_LABEL}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative flex h-10 w-10 items-center justify-center rounded-cta transition-colors duration-150 motion-reduce:transition-none",
        active ? "bg-ink/10" : "hover:bg-ink/[0.04]",
        FOCUS_RING,
      )}
    >
      <Avatar size={22} />
      {needs && <Dot className="absolute right-1.5 top-1.5 ring-2 ring-cream" />}
    </button>
  );
}
