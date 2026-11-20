/* eslint-disable @next/next/no-img-element */
import Link from "next/link";

const CHIP = {
  sm: { box: "size-7", mark: "size-3.5", radius: "rounded-[9px]" },
  md: { box: "size-8", mark: "size-4", radius: "rounded-[10px]" },
  lg: { box: "size-10", mark: "size-5", radius: "rounded-[12px]" },
} as const;

const WORDMARK = {
  sm: "h-4 w-auto",
  md: "h-5 w-auto",
  lg: "h-[26px] w-auto",
} as const;

type Size = keyof typeof CHIP;

export function ZaviMark({
  className = "",
  size = "md",
}: {
  className?: string;
  size?: Size;
}) {
  const chip = CHIP[size];
  return (
    <span
      className={`flex ${chip.box} items-center justify-center ${chip.radius} bg-[#171717] ${className}`}
    >
      <img src="/zavi-mark.svg" alt="" className={chip.mark} />
    </span>
  );
}

export function ZaviWordmark({
  size = "md",
  href = "/",
  className = "",
  markless = false,
}: {
  size?: Size;
  href?: string;
  className?: string;
  markless?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label="Zavi home"
      className={`group flex items-center gap-2 shrink-0 ${className}`}
    >
      {!markless && <ZaviMark size={size} />}
      <img
        src="/zavi-black.svg"
        alt="Zavi"
        className={WORDMARK[size]}
      />
    </Link>
  );
}
