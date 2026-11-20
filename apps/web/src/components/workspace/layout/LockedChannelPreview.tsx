"use client";

import { useEffect, useState } from "react";
import { listChannelActions } from "@/lib/workspace/channelActionsApi";
import { cx, FOCUS_RING } from "./shared";
import { ChevronRight, Loader2 } from "lucide-react";
import type { ChannelEntry } from "./ChannelsPage";

const MAX_ROWS = 20;

const FILLER_WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(
    " ",
  );

export function fillerLine(i: number): string {
  const words = 5 + ((i * 7 + 3) % 6);
  return Array.from({ length: words }, (_, k) => FILLER_WORDS[(i * 5 + k * 3) % FILLER_WORDS.length]).join(" ");
}

export function LockedChannelPreview({
  entry,
  onUpgrade,
}: {
  entry: Pick<ChannelEntry, "channel" | "waiting">;
  onUpgrade: () => void;
}) {
  const slug = entry.channel.slug;
  const waiting = entry.waiting;
  const [types, setTypes] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    listChannelActions(slug)
      .then((list) => {
        if (!cancelled) setTypes(list.locked_preview?.types ?? []);
      })
      .catch(() => {
        if (!cancelled) setTypes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const rows =
    types === null
      ? []
      : (types.length > 0 ? types : Array.from({ length: waiting }, () => "other")).slice(0, MAX_ROWS);

  return (
    <div data-locked-preview={slug} className="px-4 pb-3.5">
      {}
      <div className="pb-2">
        <span className="text-[14px] font-semibold leading-5 text-ink">
          {`${waiting} ${waiting === 1 ? "action" : "actions"} ready`}
        </span>
      </div>
      {types === null ? (
        <div className="flex items-center gap-2 py-2 text-[13px] text-inkMuted">
          <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" />
          Loading
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule">
          {rows.map((_, i) => (
            <li key={i} data-locked-row>
              <button
                type="button"
                onClick={onUpgrade}
                aria-label="View this action, needs an upgrade"
                className={cx(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-creamDeep motion-reduce:transition-none",
                  FOCUS_RING,
                )}
              >
                <span
                  aria-hidden
                  data-filler
                  className="min-w-0 flex-1 select-none truncate text-[13px] leading-5 text-inkMuted blur-[5px] pointer-events-none"
                >
                  {fillerLine(i)}
                </span>
                <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-inkLight" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {types !== null && (
        <button
          type="button"
          onClick={onUpgrade}
          className={cx(
            "mt-3 rounded-full border border-rule bg-cream px-3.5 py-[6px] text-[13px] font-semibold text-ink transition-colors hover:border-ink motion-reduce:transition-none",
            FOCUS_RING,
          )}
        >
          Upgrade to see them
        </button>
      )}
    </div>
  );
}
