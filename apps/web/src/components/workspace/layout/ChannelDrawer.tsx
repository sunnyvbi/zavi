"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cx, FAB_CLEARANCE, FOCUS_RING } from "./shared";
import { ChannelPanel } from "./ChannelPanel";
import { ChannelPageHeaderSlotProvider } from "./ChannelHeaderRow";
import { SideDrawerHostContext } from "./SideDrawer";
import { ChannelSurface } from "../actions/ChannelSurface";
import { platformFor } from "../actions/platforms";
import { CreatorMessagesButton } from "../ugc/CreatorMessagesButton";
import type { ChannelDetail } from "./channelDetail";
import type { PriorRows } from "../actions/ChannelActionsLane";
import { useChannelPlanLock } from "../actions/channelPlanLock";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";

export { probeSummary, probeWindow } from "./channelDetail";
export type { ChannelDetail, ProbeVerdict } from "./channelDetail";

type ChannelDetailProps = {
  detail: ChannelDetail;
  actionCount: number;
  error: string | null;
  onClose: () => void;
  onOpenConnectors: () => void;
  onExtraCount?: (slug: string, n: number) => void;
  children?: React.ReactNode;
  prior?: PriorRows;
  chatStaged?: PriorRows;
};

export function ChannelDrawer({
  detail,
  ...props
}: Omit<ChannelDetailProps, "detail"> & { detail: ChannelDetail | null }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { onClose } = props;

  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [detail, onClose]);

  if (!detail) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={detail.channel.name}
      onClick={onClose}
      className="fixed inset-0 z-50 flex justify-end bg-black/35"
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-[min(760px,92vw)] flex-col border-l border-rule bg-cream shadow-elev"
      >
        <ChannelDetailBody detail={detail} {...props} />
      </div>
    </div>
  );
}

export function ChannelDetailPage({
  leading,
  ...props
}: ChannelDetailProps & { leading?: React.ReactNode }) {
  return (
    <section
      aria-label={props.detail.channel.name}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-cream"
    >
      <ChannelDetailBody {...props} variant="page" leading={leading} />
    </section>
  );
}

function ChannelDetailBody({
  detail,
  actionCount,
  error,
  onClose,
  onOpenConnectors,
  onExtraCount,
  children,
  prior,
  chatStaged,
  variant = "drawer",
  leading,
}: ChannelDetailProps & {
  variant?: "drawer" | "page";
  leading?: React.ReactNode;
}) {
  const isPage = variant === "page";
  const { channel } = detail;
  const platform = platformFor(channel.slug);
  const [controlsSlot, setControlsSlot] = useState<HTMLElement | null>(null);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const [badgeSlot, setBadgeSlot] = useState<HTMLElement | null>(null);
  const [bodyHost, setBodyHost] = useState<HTMLElement | null>(null);
  const planLock = useChannelPlanLock();

  return (
    <ChannelPageHeaderSlotProvider element={isPage ? controlsSlot : null} titleElement={titleSlot} badgeElement={badgeSlot}>
      <div
        className={cx(
          "flex shrink-0 items-center gap-2 border-b border-rule",
          isPage ? "h-14 gap-3 px-6 compact:gap-2 compact:px-4" : "h-12 px-3",
        )}
      >
        {leading}
        <div className="flex min-w-0 flex-1 items-center gap-2 compact:max-w-[9rem] compact:flex-none">
          <h2
            className={cx(
              "min-w-0 truncate font-semibold text-ink",
              isPage ? "text-[20px] tracking-tight compact:text-[18px]" : "text-[14px]",
            )}
          >
            {channel.name}
          </h2>
          <span ref={setBadgeSlot} data-testid="channel-title-badge" className="flex shrink-0 items-center empty:hidden" />
          {}
        </div>
        {isPage && (
          <div
            ref={setControlsSlot}
            className="hidden min-w-0 shrink items-center justify-end gap-1 compact:ml-auto compact:flex compact:empty:hidden"
          />
        )}
        <div ref={setTitleSlot} data-testid="channel-title-tools" className="flex min-w-0 shrink-0 items-center gap-2 empty:hidden compact:ml-auto" />
        {CREATOR_MARKETPLACE_ENABLED && platform.creatorMessages && <CreatorMessagesButton />}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={cx(
            "rounded-cta p-1.5 text-ink hover:bg-bone",
            isPage && "compact:hidden",
            FOCUS_RING,
          )}
        >
          <X className="h-[18px] w-[18px]" aria-hidden />
        </button>
      </div>

      {planLock?.tierName && (
        <p
          data-testid="plan-lock-line"
          className={cx(
            "shrink-0 border-b border-rule bg-creamDeep py-2 text-[13px] leading-5 text-ink",
            isPage ? "px-6 compact:px-4" : "px-4",
          )}
        >
          {`These drafts are yours to read and use. Zavi posting for you is on ${planLock.tierName}. `}
          <button
            type="button"
            onClick={() => planLock.upgrade(null, { clicked: true })}
            className={cx("font-semibold underline underline-offset-2", FOCUS_RING)}
          >
            {`See ${planLock.tierName}`}
          </button>
        </p>
      )}

      <div ref={setBodyHost} className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={cx(
            "ws-scroll min-h-0 flex-1",
            isPage ? cx("px-6 pb-6 pt-3 compact:px-4 compact:pt-3", FAB_CLEARANCE) : "px-4 py-3.5",
          )}
        >
          <div
            className={cx(
              isPage && "mx-auto w-full [container-type:inline-size]",
              isPage && "max-w-ca-content",
            )}
          >
            {(
              <SideDrawerHostContext.Provider value={bodyHost}><ChannelSurface slug={channel.slug}>
                <ChannelPanel
                  key={detail.channel.slug}
                  detail={detail}
                  actionCount={actionCount}
                  onOpenConnectors={onOpenConnectors}
                  onExtraCount={onExtraCount}
                  prior={prior}
                  chatStaged={chatStaged}
                >
                  {children}
                </ChannelPanel>
              </ChannelSurface></SideDrawerHostContext.Provider>
            )}
          </div>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mx-3 mb-2 rounded-xl bg-dangerBg px-3 py-2.5 text-[12px] font-medium text-danger"
        >
          {error}
        </p>
      )}
    </ChannelPageHeaderSlotProvider>
  );
}
