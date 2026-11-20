"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { useIsCompact } from "@/lib/responsive";

type HeaderSlot = { el: HTMLElement | null };

const HeaderSlotContext = createContext<HeaderSlot | null>(null);

const PageHeaderSlotContext = createContext<HTMLElement | null>(null);

const PageTitleSlotContext = createContext<HTMLElement | null | undefined>(undefined);

const TitleBadgeSlotContext = createContext<HTMLElement | null | undefined>(undefined);

export function ChannelPageHeaderSlotProvider({
  element,
  titleElement,
  badgeElement,
  children,
}: {
  element: HTMLElement | null;
  titleElement?: HTMLElement | null | undefined;
  badgeElement?: HTMLElement | null | undefined;
  children: ReactNode;
}) {
  return (
    <PageHeaderSlotContext.Provider value={element}>
      <PageTitleSlotContext.Provider value={titleElement}>
        <TitleBadgeSlotContext.Provider value={badgeElement}>{children}</TitleBadgeSlotContext.Provider>
      </PageTitleSlotContext.Provider>
    </PageHeaderSlotContext.Provider>
  );
}

export function ChannelTitleBadgeSlot({ children }: { children: ReactNode }) {
  const badgeEl = useContext(TitleBadgeSlotContext);
  if (badgeEl === undefined) return <>{children}</>;
  return badgeEl ? createPortal(children, badgeEl) : null;
}

export function ChannelTitleSlot({ children }: { children: ReactNode }) {
  const titleEl = useContext(PageTitleSlotContext);
  if (titleEl === undefined) return <>{children}</>;
  return titleEl ? createPortal(children, titleEl) : null;
}

export function ChannelHeaderRow({
  left,
  underline,
  spaced,
  children,
}: {
  left: ReactNode;
  underline: boolean;
  spaced: boolean;
  children: ReactNode;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const slot = useMemo<HeaderSlot>(() => ({ el }), [el]);
  return (
    <HeaderSlotContext.Provider value={slot}>
      <div
        data-testid="channel-header"
        data-underline={underline || undefined}
        className={cn("flex w-full flex-wrap items-center gap-3 compact:gap-2 compact:[&:has(>div:last-child>[data-header-create]:only-child)]:flex-nowrap", spaced && "[&:has(>*:not(:empty))]:mb-3")}
      >
        {left}
        <div ref={setEl} className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 empty:hidden compact:[&:has(>[data-header-create]:only-child)]:shrink-0" />
      </div>
      {children}
    </HeaderSlotContext.Provider>
  );
}

export function ChannelHeaderSlot({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlotContext);
  if (!slot) return <>{children}</>;
  if (!slot.el) return null;
  return createPortal(children, slot.el);
}

export function ChannelControlsSlot({ children }: { children: ReactNode }) {
  const pageEl = useContext(PageHeaderSlotContext);
  const slot = useContext(HeaderSlotContext);
  const compact = useIsCompact();
  if (compact && pageEl) return createPortal(children, pageEl);
  if (!slot) return <>{children}</>;
  if (!slot.el) return null;
  return createPortal(children, slot.el);
}
