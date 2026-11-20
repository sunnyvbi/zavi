"use client";

import { useCallback, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  readWorkspaceLocation,
  WORKSPACE_LOCATION_EVENT,
} from "./workspaceRoutes";

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  window.addEventListener(WORKSPACE_LOCATION_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
    window.removeEventListener(WORKSPACE_LOCATION_EVENT, listener);
  };
}

export function useWorkspaceLocation() {
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.toString();
  const getServerSnapshot = useCallback(
    () => `${pathname}${query ? `?${query}` : ""}`,
    [pathname, query],
  );
  return useSyncExternalStore(
    subscribe,
    readWorkspaceLocation,
    getServerSnapshot,
  );
}
