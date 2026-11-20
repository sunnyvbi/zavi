"use client";

import { useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CONNECT_APP_PARAM, CONNECT_ERROR_PARAM, CONNECT_SEARCH_PARAM, PAST_WORK_MODE_PARAM, SETUP_BUSINESS_STEP, SETUP_CONNECT_STEP, SETUP_CONNECTORS_PARAM, SETUP_PAST_WORK_STEP, SETUP_STEP_PARAM, setupNavigationHref } from "@/lib/onboardingRoutes";
import { readWorkspaceLocation, replaceWorkspaceLocation, WORKSPACE_LOCATION_EVENT } from "../navigation/workspaceRoutes";

const subscribe = (listener: () => void) => {
  window.addEventListener(WORKSPACE_LOCATION_EVENT, listener);
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);
  return () => {
    window.removeEventListener(WORKSPACE_LOCATION_EVENT, listener);
    window.removeEventListener("popstate", listener);
    window.removeEventListener("hashchange", listener);
  };
};

export function useSetupNavigation() {
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search.toString();
  const location = useSyncExternalStore(subscribe, readWorkspaceLocation, () => `${pathname}${query ? `?${query}` : ""}`);
  const params = new URL(location, "https://workspace.local").searchParams;
  const update = (changes: Parameters<typeof setupNavigationHref>[2]) => {
    const live = new URL(window.location.href);
    replaceWorkspaceLocation(setupNavigationHref(live.pathname, live.searchParams, changes, live.hash));
  };
  return {
    pastWork: params.get(SETUP_STEP_PARAM) === SETUP_PAST_WORK_STEP,
    questionsFor: params.get(SETUP_STEP_PARAM) === SETUP_BUSINESS_STEP ? (params.get(SETUP_CONNECTORS_PARAM) === "done" ? "done" as const : "skipped" as const) : null,
    openQuestions: (outcome: "done" | "skipped") => update({ [SETUP_STEP_PARAM]: SETUP_BUSINESS_STEP, [SETUP_CONNECTORS_PARAM]: outcome, [CONNECT_APP_PARAM]: null }),
    closeQuestions: () => update({ [SETUP_STEP_PARAM]: SETUP_CONNECT_STEP, [SETUP_CONNECTORS_PARAM]: null }),
    query: params.get(CONNECT_SEARCH_PARAM) ?? "",
    open: params.get(CONNECT_APP_PARAM),
    returnError: params.get(CONNECT_ERROR_PARAM) ?? params.get("connect_error"),
    beginConnect: () => update({ [CONNECT_ERROR_PARAM]: null, connect_error: null, provider: null, [SETUP_STEP_PARAM]: SETUP_CONNECT_STEP }),
    setQuery: (query: string) => update({ [CONNECT_SEARCH_PARAM]: query || null }),
    setOpen: (slug: string | null) => update({ [CONNECT_APP_PARAM]: slug }),
    back: () => update({ [SETUP_STEP_PARAM]: SETUP_PAST_WORK_STEP, [CONNECT_APP_PARAM]: null, [SETUP_CONNECTORS_PARAM]: null }),
    next: () => update({ [SETUP_STEP_PARAM]: null, [CONNECT_APP_PARAM]: null }),
    finish: () => update({ [SETUP_STEP_PARAM]: null, [CONNECT_APP_PARAM]: null, [CONNECT_SEARCH_PARAM]: null, [PAST_WORK_MODE_PARAM]: null, [CONNECT_ERROR_PARAM]: null, connect_error: null, provider: null, [SETUP_CONNECTORS_PARAM]: null }),
  };
}
