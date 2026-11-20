"use client";

import type { Channel } from "@zavi/shared";
import { channelBrandGlyph } from "../channelBrandGlyph";
import { channelMark } from "../channelMark";
import { cx } from "./shared";

export function SourceIcon({
  channel,
  size = "md",
}: {
  channel: Channel;
  size?: "md" | "sm";
}) {
  const glyph = size === "md" ? channelBrandGlyph(channel.slug) : null;
  if (glyph) {
    return (
      <span
        aria-hidden
        data-channel-glyph={channel.slug}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#d9d9d9] bg-white"
      >
        <span className="flex scale-[1.2] items-center justify-center">{glyph}</span>
      </span>
    );
  }
  const mark = channelMark(channel.slug);
  return (
    <span className={cx("relative flex shrink-0", size === "sm" ? "h-5 w-5" : "h-9 w-9")}>
      <span
        className={cx(
          "flex h-full w-full items-center justify-center overflow-hidden rounded-full",
          mark.bg,
        )}
      >
        {mark.kind === "glyph" ? (
          <mark.Icon
            className={cx(size === "sm" ? "h-3 w-3" : "h-[18px] w-[18px]", mark.fg)}
            aria-hidden
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mark.src}
            alt=""
            className={
              mark.fit === "cover"
                ? "h-full w-full object-cover"
                : size === "sm"
                  ? "h-3.5 w-3.5 object-contain"
                  : "h-[22px] w-[22px] object-contain"
            }
          />
        )}
      </span>
    </span>
  );
}
