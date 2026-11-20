"use client";

import { Search, Users } from "lucide-react";
import type { PlatformSpec } from "../actions/types";
import { useUgcDrawer } from "../ugc/hub";
import { UgcNotificationBell } from "../ugc/NotificationBell";
import { ChannelControlsSlot } from "./ChannelHeaderRow";

export function ChannelHeaderAction({ action }: { action: NonNullable<PlatformSpec["headerAction"]> }) {
  const drawer = useUgcDrawer();
  return (
    <ChannelControlsSlot>
      {}
      <span className="order-first inline-flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-testid="channel-header-action"
          onClick={() => drawer.open(action.drawer)}
          className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-transparent bg-ink px-3.5 py-1.5 text-[14px] font-semibold text-cream hover:opacity-90 compact:px-3 compact:text-[13px]"
        >
          <Search className="h-3.5 w-3.5" aria-hidden />
          {action.label}
        </button>
        {}
        <button
          type="button"
          onClick={() => drawer.open("inbox")}
          className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-rule bg-cream px-3.5 py-1.5 text-[14px] font-semibold text-ink hover:bg-bone compact:px-3 compact:text-[13px]"
        >
          <Users className="h-3.5 w-3.5" aria-hidden />
          Creators
        </button>
        <UgcNotificationBell />
      </span>
    </ChannelControlsSlot>
  );
}
