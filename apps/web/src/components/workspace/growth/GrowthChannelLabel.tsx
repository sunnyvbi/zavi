import { cn } from "@/lib/cn";
import { humanize } from "./growthPresentation";
import { channelMark } from "../channelMark";

export function ChannelMarkIcon({ slug, compact = false }: { slug: string; compact?: boolean }) {
  const mark = channelMark(slug);
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex shrink-0", compact ? "h-5 w-5" : "h-8 w-8")}
    >
      <span
        className={cn(
          "flex h-full w-full items-center justify-center overflow-hidden rounded-full",
          mark.bg,
        )}
      >
        {mark.kind === "glyph" ? (
          <mark.Icon
            className={cn(compact ? "h-3 w-3" : "h-4 w-4", mark.fg)}
            aria-hidden="true"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mark.src}
            alt=""
            className={cn(
              mark.fit === "cover"
                ? "h-full w-full object-cover"
                : compact
                  ? "h-3.5 w-3.5 object-contain"
                  : "h-5 w-5 object-contain",
            )}
          />
        )}
      </span>
    </span>
  );
}

export function GrowthChannelLabel({
  slug,
  name,
  compact = false,
}: {
  slug: string;
  name?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center", compact ? "gap-2" : "gap-2.5")}>
      <ChannelMarkIcon slug={slug} compact={compact} />
      <span>{name ?? humanize(slug)}</span>
    </span>
  );
}
