"use client";

import { useCallback, useEffect, useMemo } from "react";
import type { TabDescriptor } from "@/lib/workspace/types";
import { useLinkedThread } from "./useLinkedThread";
import { useWorkspaceLocation } from "./useWorkspaceLocation";
import {
  pushWorkspaceLocation,
  readWorkspaceLocation,
  replaceWorkspaceLocation,
  resolveWorkspaceTab,
  workspaceTabHref,
  MEMORY_HASHES,
  TOOLKIT_HASHES,
} from "./workspaceRoutes";

export type ActivateTabOptions = {
  push?: boolean;
};

export function useWorkspaceNavigation(storedTabs: TabDescriptor[]) {
  const location = useWorkspaceLocation();
  const linkedThread = useLinkedThread(location, storedTabs);
  const active = useMemo(
    () =>
      resolveWorkspaceTab(
        linkedThread ? [...storedTabs, linkedThread] : storedTabs,
        location,
      ),
    [storedTabs, location, linkedThread],
  );
  useEffect(() => {
    const url = new URL(location, "https://workspace.local");
    if (
      url.searchParams.has("agent") ||
      url.searchParams.has("thread") ||
      url.searchParams.has("tab") ||
      (!TOOLKIT_HASHES.includes(url.hash) && !MEMORY_HASHES.includes(url.hash))
    )
      return;
    if (readWorkspaceLocation() !== location) return;
    replaceWorkspaceLocation(workspaceTabHref(active, location));
  }, [active, location]);
  const tabs = useMemo(
    () =>
      storedTabs.some((tab) => tab.id === active.id)
        ? storedTabs.map((tab) => (tab.id === active.id ? active : tab))
        : [...storedTabs, active],
    [storedTabs, active],
  );
  const activateTab = useCallback(
    (tab: TabDescriptor, opts?: ActivateTabOptions) => {
      const href = workspaceTabHref(tab, readWorkspaceLocation());
      if (opts?.push) pushWorkspaceLocation(href);
      else replaceWorkspaceLocation(href);
    },
    [],
  );
  const setActiveTabId = useCallback(
    (id: string, opts?: ActivateTabOptions) => {
      const tab = tabs.find((candidate) => candidate.id === id);
      if (tab) activateTab(tab, opts);
    },
    [tabs, activateTab],
  );
  return { tabs, activeTabId: active.id, activateTab, setActiveTabId };
}
