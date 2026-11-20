"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import { creatorApi } from "@/lib/creator/api";
import { checkCanAddCompany } from "@/lib/gatekeeper";
import {
  clearPendingPlan,
  parsePlanChoice,
  savePendingPlan,
} from "@/lib/workspace/pendingPlan";
import { liveFromParam } from "@/lib/marketing/liveFrom";
import { oauthConsentNext } from "@/lib/safe-next";
import {
  onboardingLoginHref,
  websiteSignupNext,
  websiteResearchHref,
  WORKSPACE_ROUTE,
} from "@/lib/onboardingRoutes";
import { trackEvent, trackEventDeferred } from "@/lib/analytics/events";
import { WebsiteSessionExpired } from "./websiteRequest";
import { SCAN_PARAM, startWebsiteScan } from "./websiteScan";
import { websiteHost } from "./websiteHost";
type Phase = "checking" | "ready" | "error" | "redirecting";

async function withScan(host: string, params: URLSearchParams, typedHere: boolean): Promise<URLSearchParams> {
  const next = new URLSearchParams(params);
  if (next.get(SCAN_PARAM)) return next;
  trackEvent("onboarding_website_submitted", { prefilled_from_home: !typedHere });
  const scanId = await startWebsiteScan(host);
  if (scanId) next.set(SCAN_PARAM, scanId);
  else {
    next.delete(SCAN_PARAM);
    trackEvent("onboarding_scan_completed", { status: "failed", reason: "start_failed" });
  }
  return next;
}
type State = { phase: Phase; error: string | null };

export function useWebsiteOnboarding() {
  const { push, replace } = useRouter();
  const search = useSearchParams();
  const query = search.toString();
  const websiteParam = search.get("website") ?? "";
  const [website, setWebsite] = useState(websiteParam);
  const [attempt, retry] = useReducer((n) => n + 1, 0);
  const [state, setState] = useState<State>({ phase: "ready", error: null });
  const [signedIn, setSignedIn] = useState(false);
  const typedHere = useRef(false);
  useEffect(() => {
    let live = true;
    void createBrowserSupabase()
      .auth.getSession()
      .then(({ data }) => {
        if (live) setSignedIn(!!data.session);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (state.phase !== "ready") return;
    return trackEventDeferred("onboarding_step_viewed", {
      step: "website_intake",
      add_company: new URLSearchParams(query).get("new") === "1",
    });
  }, [state.phase, query]);
  useEffect(() => {
    const params = new URLSearchParams(query);
    const choice = parsePlanChoice(params.get("plan"), params.get("term"));
    if (choice) savePendingPlan(choice);
    else if (params.get("plan") === "free") clearPendingPlan();
  }, [query]);
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(query);
    const host = websiteHost(params.get("website") ?? "");
    const additional = params.get("new") === "1";
    const submitted = !!host;
    const next = host ? websiteSignupNext(host, params) : null;
    if (!submitted) {
      setState({ phase: "ready", error: websiteParam ? "Enter a valid website to continue." : null });
      return;
    }
    setState({ phase: "checking", error: null });
    void (async () => {
      try {
        const { data } = await createBrowserSupabase().auth.getSession();
        if (cancelled) return;
        if (!data.session) {
          if (submitted && next && host) {
            const scanned = await withScan(host, params, typedHere.current);
            if (cancelled) return;
            setState({ phase: "redirecting", error: null });
            trackEvent("onboarding_signup_prompted", { path: "website" });
            replace(onboardingLoginHref(websiteSignupNext(host, scanned)));
          } else setState({ phase: "ready", error: null });
          return;
        }
        const home = await creatorApi.home();
        if (cancelled) return;
        if (home.has_company && !additional) {
          setState({ phase: "redirecting", error: null });
          replace(oauthConsentNext(params.get("next")) ?? WORKSPACE_ROUTE);
          return;
        }
        if (home.has_company && additional && !(await checkCanAddCompany())) {
          if (!cancelled) replace(WORKSPACE_ROUTE);
          return;
        }
        if (cancelled) return;
        if (home.home === "/creator" && !additional && !submitted) {
          replace(home.home);
          return;
        }
        if (!submitted || !host) {
          setState({
            phase: "ready",
            error:
              websiteParam && !host
                ? "Enter a valid website to continue."
                : null,
          });
          return;
        }
        const scanned = await withScan(host, params, typedHere.current);
        if (cancelled) return;
        setState({ phase: "redirecting", error: null });
        replace(websiteSignupNext(host, scanned));
      } catch (error) {
        if (cancelled) return;
        if (error instanceof WebsiteSessionExpired && next) {
          replace(onboardingLoginHref(next));
          return;
        }
        setState({
          phase: "error",
          error:
            error instanceof Error &&
            !(error instanceof TypeError) &&
            error.name !== "AbortError"
              ? error.message
              : "Couldn't reach Zavi. Check your connection and try again.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, websiteParam, attempt, replace]);
  const submit = () => {
    if (state.phase !== "ready") return;
    const host = websiteHost(website);
    if (!host) {
      setState({
        phase: "ready",
        error: "Enter a valid website, like acme.com.",
      });
      return;
    }
    typedHere.current = true;
    push(websiteResearchHref(host, new URLSearchParams(query)));
  };
  return {
    ...state,
    website,
    email: search.get("card_email"),
    remove: search.get("card_remove"),
    from: liveFromParam(search.get("from")),
    addCompany: search.get("new") === "1",
    signedIn,
    submit,
    retry,
    changeWebsite: (value: string) => {
      setWebsite(value);
      setState({ phase: "ready", error: null });
    },
  };
}
