import { cx } from "../layout/shared";

const SIZES = {
  sm: "h-5 w-5 rounded-md text-[11px]",
  lg: "h-16 w-16 rounded-2xl text-[28px]",
} as const;

export function appInitial(name: string | null | undefined): string {
  return (name ?? "").trim().slice(0, 1).toUpperCase();
}

export function AppInitialTile({
  name,
  size = "sm",
  className,
}: {
  name: string | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-testid="app-initial-tile"
      className={cx(
        "inline-flex shrink-0 items-center justify-center bg-[#0e0f11] font-semibold leading-none text-white",
        SIZES[size],
        className,
      )}
    >
      {appInitial(name)}
    </span>
  );
}
