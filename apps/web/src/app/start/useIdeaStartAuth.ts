"use client";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import { creatorApi } from "@/lib/creator/api";
import { checkCanAddCompany } from "@/lib/gatekeeper";
import { createBrowserSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import type { PickedTemplate } from "@/lib/workspace/siteTemplates";
import type { AuthState } from "./useStartAnalytics";
import type { useIdeaCommit } from "./useIdeaCommit";
import {
  readStash,
  stashedImages,
  stashedTemplate,
  mayAutoResume,
} from "./ideaStartStorage";
type Callbacks = Pick<
  ReturnType<typeof useIdeaCommit>,
  | "setCommitting"
  | "setCommitError"
  | "setRetryTenantId"
  | "setRetryCompanyName"
  | "retryBuildInWorkspace"
  | "runCommitFresh"
> & {
  setIdea: Dispatch<SetStateAction<string>>;
  setIdeaImages: Dispatch<SetStateAction<string[]>>;
  setTemplate: (value: PickedTemplate | null) => void;
};
export function useIdeaStartAuth(
  newMode: boolean,
  returnedFromBuildSignup: boolean,
  handlers: Callbacks,
) {
  const { push, replace } = useRouter();
  const [authState, setAuthState] = useState<AuthState>("loading");
  const callbacks = useRef(handlers);
  useEffect(() => {
    callbacks.current = handlers;
  }, [handlers]);
  const resumedRef = useRef(false);
  const resumeUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const {
      setIdea,
      setIdeaImages,
      setTemplate,
      setCommitting,
      setCommitError,
      setRetryTenantId,
      setRetryCompanyName,
      retryBuildInWorkspace,
      runCommitFresh,
    } = callbacks.current;
    const supabase = createBrowserSupabase();
    let cancelled = false;
    (async () => {
      const { data: sess } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!sess.session) {
        const pending = readStash();
        if (
          pending?.intent === "fresh" &&
          typeof pending.idea === "string" &&
          pending.idea.trim().length >= 8
        ) {
          setIdea(pending.idea);
          setIdeaImages(stashedImages(pending));
          setTemplate(stashedTemplate(pending));
        }
        setAuthState("out");
        return;
      }
      let home: {
        has_company: boolean;
        is_creator: boolean;
        home: string;
      };
      try {
        home = await creatorApi.home();
      } catch {
        if (cancelled) return;
        setAuthState("error");
        return;
      }
      if (cancelled) return;
      const pending = readStash();
      if (home.has_company && !newMode) {
        if (
          pending?.intent === "fresh" &&
          typeof pending.idea === "string" &&
          pending.idea.trim().length >= 8
        ) {
          if (resumedRef.current) return;
          resumedRef.current = true;
          resumeUserIdRef.current = sess.session.user.id;
          setIdea(pending.idea);
          setIdeaImages(stashedImages(pending));
          setTemplate(stashedTemplate(pending));
          setAuthState("needs_onboarding");
          if (
            !returnedFromBuildSignup ||
            !mayAutoResume(pending, sess.session.user.last_sign_in_at)
          )
            return;
          setCommitting(true);
          const activeTenant = await fetchActiveTenant(
            supabase,
            sess.session.user.id,
          );
          if (cancelled) return;
          if (!activeTenant) {
            setCommitting(false);
            setCommitError(
              "We could not open your workspace. Your website idea is still here. Try again.",
            );
            return;
          }
          setRetryTenantId(activeTenant.id);
          setRetryCompanyName(activeTenant.displayName);
          void retryBuildInWorkspace(
            pending.idea,
            stashedImages(pending),
            activeTenant,
          );
          return;
        }
        setAuthState("onboarded");
        replace("/workspace");
        return;
      }
      if (home.has_company && newMode && !(await checkCanAddCompany())) {
        if (cancelled) return;
        setAuthState("onboarded");
        replace("/workspace");
        return;
      }
      if (home.has_company && newMode) {
        setAuthState("needs_onboarding");
        return;
      }
      if (home.home === "/creator" && !newMode && !readStash()) {
        replace("/creator");
        return;
      }
      if (cancelled) return;
      setAuthState("needs_onboarding");
      if (resumedRef.current) return;
      if (!pending) return;
      resumedRef.current = true;
      if (
        pending.intent === "fresh" &&
        typeof pending.idea === "string" &&
        pending.idea.trim().length >= 8
      ) {
        setIdea(pending.idea);
        setIdeaImages(stashedImages(pending));
        setTemplate(stashedTemplate(pending));
        if (
          !returnedFromBuildSignup ||
          !mayAutoResume(pending, sess.session.user.last_sign_in_at)
        )
          return;
        void runCommitFresh(pending.idea, stashedImages(pending));
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [newMode, returnedFromBuildSignup, replace]);
  return { authState, resumeUserIdRef };
}
