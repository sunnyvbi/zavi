"use client";

import { MessageSquare } from "lucide-react";
import { cx, FOCUS_RING } from "../layout/shared";
import { useUgcDrawer } from "./hub";
import { useCreatorUnreadTotal } from "./unread";

export function CreatorMessagesButton() {
  const drawer = useUgcDrawer();
  const unread = useCreatorUnreadTotal();
  const label = unread > 0 ? `Messages, ${unread} unread` : "Messages";
  return (
    <button
      type="button"
      onClick={() => drawer.open("thread")}
      aria-label={label}
      title="Messages from creators"
      className={cx("relative rounded-cta p-1.5 text-ink hover:bg-bone", FOCUS_RING)}
    >
      <MessageSquare className="h-[18px] w-[18px]" aria-hidden />
      {unread > 0 && (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#027bff] px-1 text-[11px] font-bold leading-none text-white ring-2 ring-cream"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}
