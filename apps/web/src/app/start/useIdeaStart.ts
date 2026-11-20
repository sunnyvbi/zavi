"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { urlAttribution, withUrlAttribution } from "@/lib/marketing/liveFrom";
import {
  clearPendingPlan,
  parsePlanChoice,
  savePendingPlan,
} from "@/lib/workspace/pendingPlan";
import {
  useIdeaAttach,
  useIdeaExamples,
  useWebsiteFraming,
} from "@/lib/workspace/buildFraming";
import {
  unfilledBlanks,
  type PickedTemplate,
} from "@/lib/workspace/siteTemplates";
import { trackEvent } from "@/lib/analytics/events";
import { useStartAnalytics } from "./useStartAnalytics";
import { useIdeaCommit } from "./useIdeaCommit";
import { useIdeaStartAuth } from "./useIdeaStartAuth";
import {
  writeStash,
  BUILD_SIGNUP_NEXT,
  RESUME_BUILD_PARAM,
} from "./ideaStartStorage";
export function useIdeaStart() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const newMode = searchParams.get("new") === "1";
  const attribution = urlAttribution(searchParams);
  const returnedFromBuildSignup =
    searchParams.get(RESUME_BUILD_PARAM) === "build";
  const [idea, setIdea] = useState("");
  const [brainstormOpen, setBrainstormOpen] = useState(false);
  const [ideaImages, setIdeaImages] = useState<string[]>([]);
  const [template, setTemplateState] = useState<PickedTemplate | null>(null);
  const [stashFailed, setStashFailed] = useState(false);
  const ideaRef = useRef<HTMLTextAreaElement | null>(null);
  const templateRef = useRef<PickedTemplate | null>(null);
  const setTemplate = (t: PickedTemplate | null) => {
    templateRef.current = t;
    setTemplateState(t);
  };
  const commit = useIdeaCommit({ newMode, attribution, templateRef, setIdea });
  const { authState, resumeUserIdRef } = useIdeaStartAuth(
    newMode,
    returnedFromBuildSignup,
    { ...commit, setIdea, setIdeaImages, setTemplate },
  );
  const {
    committing,
    commitError,
    setCommitError,
    retryTenantId,
    runCommitFresh,
    retryBuildInWorkspace,
    resumeExistingWorkspaceBuild,
  } = commit;
  const websiteFraming = useWebsiteFraming(true);
  const ideaExamples = useIdeaExamples(true);
  const ideaAttach = useIdeaAttach(true);
  const ideaValid = idea.trim().length >= 8;
  const templateBlanks = unfilledBlanks(idea, template);
  const ideaReady = ideaValid && templateBlanks.length === 0;
  const ideaCtaLabel = stashFailed
    ? "Sign up anyway"
    : authState === "needs_onboarding"
      ? "Build it"
      : "Sign up to build";
  useEffect(() => {
    const choice = parsePlanChoice(
      searchParams.get("plan"),
      searchParams.get("term"),
    );
    if (choice) savePendingPlan(choice);
    else if (searchParams.get("plan") === "free") clearPendingPlan();
  }, [searchParams]);
  useEffect(() => {
    const el = ideaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const atMax = el.scrollHeight > 280;
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
    el.style.overflowY = atMax ? "auto" : "hidden";
    el.style.resize = atMax ? "vertical" : "none";
  }, [idea, authState]);
  const { trackIdeaSubmitted, markBrainstormUsed } = useStartAnalytics({
    authState,
    committing,
    websiteLoading: false,
    step: "idea",
    brainstormOpen,
    websiteStage: "website",
    newMode,
  });
  function submitIdea() {
    if (!ideaReady) return;
    trackIdeaSubmitted();
    if (authState === "out") {
      if (
        !writeStash({
          intent: "fresh",
          idea: idea.trim(),
          ...(ideaImages.length ? { images: ideaImages } : {}),
          ...(template ? { template } : {}),
        }) &&
        !stashFailed
      ) {
        trackEvent("onboarding_stash_failed", { path: "idea" });
        setStashFailed(true);
        return;
      }
      trackEvent("onboarding_signup_prompted", { path: "idea" });
      router.push(
        `/login?signup=1&intent=build&next=${encodeURIComponent(withUrlAttribution(BUILD_SIGNUP_NEXT, attribution))}`,
      );
      return;
    }
    if (authState === "needs_onboarding") {
      if (retryTenantId) {
        void retryBuildInWorkspace(idea.trim(), ideaImages);
        return;
      }
      if (resumeUserIdRef.current) {
        void resumeExistingWorkspaceBuild(
          idea.trim(),
          ideaImages,
          resumeUserIdRef.current,
        );
        return;
      }
      void runCommitFresh(idea.trim(), ideaImages);
    }
  }
  return {
    ...commit,
    authState,
    idea,
    setIdea,
    ideaRef,
    brainstormOpen,
    setBrainstormOpen,
    ideaImages,
    setIdeaImages,
    template,
    setTemplate,
    stashFailed,
    ideaCtaLabel,
    ideaValid,
    ideaReady,
    templateBlanks,
    websiteFraming,
    ideaExamples,
    ideaAttach,
    markBrainstormUsed,
    submitIdea,
  };
}
