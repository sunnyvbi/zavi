"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const CompactHeaderSlotContext = createContext<HTMLElement | null>(null);

export function createCompactHeaderSlot(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  const element = document.createElement("div");
  element.className = "flex items-center justify-end gap-1";
  return element;
}

export function CompactHeaderSlotProvider({
  element,
  children,
}: {
  element: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <CompactHeaderSlotContext.Provider value={element}>
      {children}
    </CompactHeaderSlotContext.Provider>
  );
}

export function useCompactHeaderSlot(): HTMLElement | null {
  return useContext(CompactHeaderSlotContext);
}

export function CompactHeaderActions({ children }: { children: ReactNode }) {
  const element = useContext(CompactHeaderSlotContext);
  if (!element) return null;
  return createPortal(children, element);
}
