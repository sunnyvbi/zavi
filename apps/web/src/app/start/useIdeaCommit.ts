"use client";
import {
  useState,
  type Dispatch,
  type SetStateAction,
  type RefObject,
} from "react";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { fetchActiveTenant } from "@/lib/tenant";
import { switchToTenantDetailed } from "@/lib/workspace/tenantSwitch";
import {
  buildStartBody,
  buildStartKey,
  clearBuildStartKey,
  keepsBuildStartKey,
} from "@/lib/workspace/buildStartKey";
import {
  creditRefusalFrom,
  type CreditRefusal,
} from "@/lib/workspace/creditRefusal";
import {
  clearOptimisticBuildStart,
  markOptimisticBuildStart,
} from "@/lib/workspace/optimisticBuildStart";
import type { PickedTemplate } from "@/lib/workspace/siteTemplates";
import { firstTouchForSignup } from "@/lib/analytics/first-touch";
import { withAffiliateClick } from "@/lib/analytics/affiliate";
import {
  signupAttribution,
  withUrlAttribution,
  type UrlAttribution,
} from "@/lib/marketing/liveFrom";
import { trackEvent } from "@/lib/analytics/events";
import { failureReason } from "./useStartAnalytics";
import { commitErrorMessage } from "./commitErrorMessage";
import {
  clearStash,
  markStashDispatched,
  BUILD_SIGNUP_NEXT,
} from "./ideaStartStorage";
import { buildDestFor } from "./buildDest";
import { goToWorkspaceWithFreshClaim } from "./workspaceHandoff";
import { browserTimeZone } from "@/lib/timezones";
function tenantIdOf(body: unknown): string | undefined {
  const t = (
    body as {
      tenant_id?: unknown;
    } | null
  )?.tenant_id;
  return typeof t === "string" ? t : undefined;
}
export function useIdeaCommit({
  newMode,
  attribution,
  templateRef,
  setIdea,
}: {
  newMode: boolean;
  attribution: UrlAttribution;
  templateRef: RefObject<PickedTemplate | null>;
  setIdea: Dispatch<SetStateAction<string>>;
}) {
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitCredit, setCommitCredit] = useState<CreditRefusal | null>(null);
  const [retryTenantId, setRetryTenantId] = useState<string | null>(null);
  const [retryCompanyName, setRetryCompanyName] = useState<string | null>(null);
  function creditErrorOrMessage(status: number, body: unknown): string {
    const credit = creditRefusalFrom(body, "build");
    setCommitCredit(credit);
    return credit ? credit.headline : commitErrorMessage(status, body);
  }
  async function runCommitFresh(ideaText: string, images: string[]) {
    setCommitError(null);
    setCommitting(true);
    markOptimisticBuildStart();
    markStashDispatched();
    trackEvent("onboarding_commit_started", {
      path: "idea",
      add_company: newMode,
    });
    let refusedForCredits = false;
    const templateId = templateRef.current?.id ?? null;
    const startKey = buildStartKey(
      `build-start:${JSON.stringify({ idea: ideaText.trim(), additional: newMode, images, ...(templateId ? { template: templateId } : {}) })}`,
    );
    try {
      const res = await apiFetch("/api/onboarding/build-start", {
        method: "POST",
        retryOnNetworkError: false,
        headers: { "Idempotency-Key": startKey },
        body: JSON.stringify({
          idea: ideaText.trim(),
          additional: newMode,
          attribution: signupAttribution(firstTouchForSignup(), attribution),
          ...withAffiliateClick({}),
          ...(images.length ? { reference_images: images } : {}),
          ...(templateId ? { template: templateId } : {}),
          await_look_pick: true,
          timezone: browserTimeZone(),
        }),
      });
      if (res.status === 401) {
        clearOptimisticBuildStart();
        window.location.href = `/login?next=${encodeURIComponent(withUrlAttribution(`${BUILD_SIGNUP_NEXT}${newMode ? "&new=1" : ""}`, attribution))}`;
        return;
      }
      const body = await res.json().catch(() => ({}));
      const startCode = (
        body as {
          error?: {
            code?: unknown;
          };
        } | null
      )?.error?.code;
      if (!keepsBuildStartKey(typeof startCode === "string" ? startCode : null))
        clearBuildStartKey(startKey);
      if (startCode === "idempotency_in_progress") {
        clearOptimisticBuildStart();
        setIdea(ideaText);
        throw new Error(
          "Your build is still being set up. Give it a moment, then press Build again.",
        );
      }
      if (startCode === "build_start_incomplete") {
        clearOptimisticBuildStart();
        const createdTenantId = tenantIdOf(body);
        if (createdTenantId) setRetryTenantId(createdTenantId);
        const committed = (body as { company_name?: unknown } | null)?.company_name;
        if (typeof committed === "string" && committed.trim()) setRetryCompanyName(committed.trim());
        setIdea(ideaText);
        throw new Error("Your workspace is ready, but the build did not start. Press Build again to retry in that workspace.");
      }
      if (res.status === 409) {
        clearOptimisticBuildStart();
        clearStash();
        trackEvent("onboarding_completed", {
          path: "idea",
          outcome: "already_exists",
        });
        await goToWorkspaceWithFreshClaim(tenantIdOf(body), buildDestFor(body));
        return;
      }
      const buildNotConfigured =
        (
          body as {
            error?: {
              code?: string;
            };
          } | null
        )?.error?.code === "build_not_configured";
      if (!res.ok) {
        const createdTenantId = tenantIdOf(body);
        if (createdTenantId) {
          setRetryTenantId(createdTenantId);
          const committed = (
            body as {
              company_name?: unknown;
            } | null
          )?.company_name;
          if (typeof committed === "string" && committed.trim()) {
            setRetryCompanyName(committed.trim());
          }
        }
      }
      if (res.status === 402 || buildNotConfigured) {
        clearOptimisticBuildStart();
        setIdea(ideaText);
        refusedForCredits = res.status === 402;
        throw new Error(creditErrorOrMessage(res.status, body));
      }
      if (!res.ok) throw new Error(commitErrorMessage(res.status, body));
      clearStash();
      trackEvent("onboarding_completed", {
        path: "idea",
        outcome: "created",
        add_company: newMode,
      });
      await goToWorkspaceWithFreshClaim(tenantIdOf(body), buildDestFor(body));
    } catch (e) {
      trackEvent("onboarding_commit_failed", {
        path: "idea",
        reason: refusedForCredits ? "credits" : failureReason(e),
      });
      clearOptimisticBuildStart();
      setCommitError((e as Error).message);
      setCommitting(false);
    }
  }
  async function resumeExistingWorkspaceBuild(
    ideaText: string,
    images: string[],
    userId: string,
  ) {
    setCommitError(null);
    setCommitting(true);
    const activeTenant = await fetchActiveTenant(
      createBrowserSupabase(),
      userId,
    );
    if (!activeTenant) {
      setCommitting(false);
      setCommitError(
        "We could not open your workspace. Your website idea is still here. Try again.",
      );
      return;
    }
    setRetryTenantId(activeTenant.id);
    setRetryCompanyName(activeTenant.displayName);
    await retryBuildInWorkspace(ideaText, images, activeTenant);
  }
  async function retryBuildInWorkspace(
    ideaText: string,
    images: string[],
    target?: {
      id: string;
      displayName: string;
    },
  ) {
    setCommitError(null);
    setCommitting(true);
    markOptimisticBuildStart();
    markStashDispatched();
    const targetTenantId = target?.id ?? retryTenantId;
    const targetCompanyName = target?.displayName ?? retryCompanyName;
    trackEvent("onboarding_commit_started", { path: "idea_retry" });
    let retryFailedStatus = 0;
    try {
      if (
        !target &&
        retryTenantId &&
        (await switchToTenantDetailed(retryTenantId)) !== "ok"
      ) {
        clearOptimisticBuildStart();
        setCommitError(
          "We could not open your new workspace. Your website idea is still here. Try again.",
        );
        setCommitting(false);
        return;
      }
      const buildBody = buildStartBody({
        idea: ideaText,
        company_name:
          targetCompanyName ??
          (ideaText.split(/\s+/).slice(0, 4).join(" ").slice(0, 60) ||
            "My App"),
        reference_images: images,
        template: templateRef.current?.id ?? null,
      });
      const buildKey = buildStartKey(buildBody);
      const res = await apiFetch("/api/workspace/autopilot/build-product", {
        method: "POST",
        idempotent: true,
        headers: { "Idempotency-Key": buildKey },
        body: buildBody,
      });
      if (res.status === 401) {
        clearOptimisticBuildStart();
        window.location.href = `/login?next=${encodeURIComponent(withUrlAttribution(`${BUILD_SIGNUP_NEXT}${newMode ? "&new=1" : ""}`, attribution))}`;
        return;
      }
      const body = await res.json().catch(() => ({}));
      const answerCode = (
        body as {
          error?: {
            code?: unknown;
          };
        } | null
      )?.error?.code;
      if (
        !keepsBuildStartKey(typeof answerCode === "string" ? answerCode : null)
      )
        clearBuildStartKey(buildKey);
      if (res.status === 409) {
        clearStash();
        trackEvent("onboarding_completed", {
          path: "idea_retry",
          outcome: "already_running",
        });
        await goToWorkspaceWithFreshClaim(
          targetTenantId ?? undefined,
          buildDestFor(body),
        );
        return;
      }
      if (!res.ok) {
        retryFailedStatus = res.status;
        throw new Error(creditErrorOrMessage(res.status, body));
      }
      clearStash();
      trackEvent("onboarding_completed", {
        path: "idea_retry",
        outcome: "created",
      });
      await goToWorkspaceWithFreshClaim(
        targetTenantId ?? undefined,
        buildDestFor(body),
      );
    } catch (e) {
      trackEvent("onboarding_commit_failed", {
        path: "idea_retry",
        reason: retryFailedStatus === 402 ? "credits" : failureReason(e),
      });
      clearOptimisticBuildStart();
      setIdea(ideaText);
      setCommitError((e as Error).message);
      setCommitting(false);
    }
  }
  return {
    committing,
    setCommitting,
    commitError,
    setCommitError,
    commitCredit,
    retryTenantId,
    setRetryTenantId,
    setRetryCompanyName,
    runCommitFresh,
    retryBuildInWorkspace,
    resumeExistingWorkspaceBuild,
  };
}
