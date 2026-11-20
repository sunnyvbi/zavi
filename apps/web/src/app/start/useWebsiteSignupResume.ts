"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { onboardingLoginHref, PAST_WORK_MODE_PARAM, WEBSITE_PAST_WORK_ROUTE, WORKSPACE_CONNECT_APPS_ROUTE } from "@/lib/onboardingRoutes";
import { trackEvent } from "@/lib/analytics/events";
import { markSetupExpected } from "@/components/workspace/setup/setupState";
import { websitePost, WebsiteSessionExpired } from "./websiteRequest";
import { claimWebsiteWorkspace, resumeWebsiteWorkspace, type WebsiteWorkspace } from "./resumeWebsiteWorkspace";
import { clearWebsiteWorkspace } from "./websiteWorkspaceStorage";
import { SCAN_PARAM, useScanCompletedEvent } from "./websiteScan";
import { hasAnalyticsConsent } from "@/lib/consent";
import { goToWorkspaceWithFreshClaim } from "./workspaceHandoff";
import { createBrowserSupabase } from "@/lib/supabase";
import { websiteHost } from "./websiteHost";

type State = { ready: boolean; error: string | null; recoveryKey: string | null };

function pastWorkRecoveryKey(userId: string, host: string, additional: boolean) {
  return `zavi.website-past-work-recovery.v2:${userId}:${host}:${additional ? "new" : "first"}`;
}

function currentLoginHref() {
  const query = new URLSearchParams(window.location.search).toString();
  return onboardingLoginHref(`${WEBSITE_PAST_WORK_ROUTE}${query ? `?${query}` : ""}`);
}

export function useWebsiteSignupResume() {
  const { replace } = useRouter();
  const search = useSearchParams();
  useScanCompletedEvent(hasAnalyticsConsent() ? search.get(SCAN_PARAM) : null);
  const resumeParams = new URLSearchParams(search);
  resumeParams.delete(PAST_WORK_MODE_PARAM);
  const resumeQuery = resumeParams.toString();
  const [attempt, retry] = useReducer((value) => value + 1, 0);
  const [state, setState] = useState<State>({ ready: false, error: null, recoveryKey: null });
  const pending = useRef<Promise<WebsiteWorkspace | null> | null>(null);
  const draftIdentity = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(resumeQuery);
    const host = websiteHost(params.get("website") ?? "");
    const additional = params.get("new") === "1";
    const identity = `${host ?? ""}:${additional ? "new" : "first"}`;
    const sameIdentity = draftIdentity.current === identity;
    draftIdentity.current = identity;
    setState((current) => ({ ready: false, error: null, recoveryKey: sameIdentity ? current.recoveryKey : null }));
    if (host) {
      void createBrowserSupabase().auth.getSession().then(({ data }) => {
        const userId = data.session?.user.id;
        if (!cancelled && userId) {
          const key = pastWorkRecoveryKey(userId, host, additional);
          setState((current) => current.recoveryKey === key ? current : { ...current, recoveryKey: key });
        }
      }).catch(() => undefined);
    }
    const request = resumeWebsiteWorkspace(resumeQuery, (href) => { if (!cancelled) replace(href); });
    pending.current = request;
    void request.then((workspace) => {
      if (!cancelled) setState((current) => ({
        ready: !!workspace,
        error: null,
        recoveryKey: workspace ? pastWorkRecoveryKey(workspace.userId, workspace.host, workspace.additional) : current.recoveryKey,
      }));
    }).catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof WebsiteSessionExpired) {
        replace(currentLoginHref());
        return;
      }
      setState((current) => ({ ready: false, error: error instanceof Error ? error.message : "Couldn't save your workspace. Please try again.", recoveryKey: current.recoveryKey }));
    });
    return () => { cancelled = true; };
  }, [resumeQuery, attempt, replace]);
  const prepare = async () => {
    try {
      const workspace = await pending.current;
      if (!workspace) throw new Error("Sign in to save your past work.");
      await claimWebsiteWorkspace(workspace.tenantId);
      return workspace;
    } catch (error) {
      if (error instanceof WebsiteSessionExpired) replace(currentLoginHref());
      throw error;
    }
  };
  const finish = async (outcome: "done" | "skipped") => {
    const workspace = await prepare();
    let response: Response;
    try {
      response = await websitePost("/api/workspace/setup/progress", { step: "docs", outcome });
    } catch (error) {
      if (error instanceof WebsiteSessionExpired) replace(currentLoginHref());
      throw error;
    }
    const setupOff = response.status === 409 &&
      ((await response.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code === "setup_off";
    if (!response.ok && !setupOff) throw new Error("Couldn't save that step. Please try again.");
    trackEvent("onboarding_completed", { path: "website", add_company: workspace.additional });
    if (setupOff) await goToWorkspaceWithFreshClaim(workspace.tenantId);
    else {
      markSetupExpected();
      await goToWorkspaceWithFreshClaim(workspace.tenantId, WORKSPACE_CONNECT_APPS_ROUTE);
    }
    clearWebsiteWorkspace(workspace.userId, workspace.host, workspace.additional);
  };
  return { ...state, retry, prepare, finish };
}
