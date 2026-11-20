"use client";

import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { ZaviMascot } from "@/components/ZaviMascot";
import { onboardingDisplay } from "@/fonts/onboarding";
import { cn } from "@/lib/cn";
import { WEBSITE_RESUME_PARAM, websiteSignupNext } from "@/lib/onboardingRoutes";
import { oauthConsentNext } from "@/lib/safe-next";
import { StartWebsiteStep } from "./StartWebsiteStep";
import { WebsiteLearningPanel } from "./WebsiteLearningPanel";
import { WebsiteEntryNotices } from "./WebsiteEntryNotices";
import { useWebsiteOnboarding } from "./useWebsiteOnboarding";
import { urlAttribution } from "@/lib/marketing/liveFrom";

export function WebsiteStartFlow() {
  const search = useSearchParams();
  return search.get(WEBSITE_RESUME_PARAM) === "website"
    ? <LegacyWebsiteReturn />
    : <WebsiteEntryFlow />;
}

function LegacyWebsiteReturn() {
  const { replace } = useRouter();
  const search = useSearchParams();
  const query = search.toString();
  useEffect(() => {
    const params = new URLSearchParams(query);
    replace(websiteSignupNext(params.get("website") ?? "", params));
  }, [query, replace]);
  return null;
}

function WebsiteEntryFlow() {
  const flow = useWebsiteOnboarding();
  const search = useSearchParams();
  const consentNext = oauthConsentNext(search.get("next"));
  if (flow.phase === "ready")
    return (
      <StartWebsiteStep
        website={flow.website}
        onWebsiteChange={flow.changeWebsite}
        onContinue={flow.submit}
        error={flow.error}
        addCompany={flow.addCompany}
        signedIn={flow.signedIn}
        consentNext={consentNext}
        attribution={urlAttribution(search)}
      >
        <WebsiteEntryNotices
          email={flow.email}
          remove={flow.remove}
          from={flow.from}
          website={flow.website}
        />
      </StartWebsiteStep>
    );
  return (
    <div
      className={cn(
        onboardingDisplay.variable,
        "flex min-h-dvh bg-white font-onboarding text-onboarding-ink",
      )}
    >
      <main
        className="flex min-h-dvh min-w-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
        aria-busy={flow.phase !== "error"}
      >
        <ZaviMascot size={96} />
        {flow.phase === "error" ? (
          <>
            <h1 className="text-2xl font-semibold">Let's try that again</h1>
            <p
              role="alert"
              className="max-w-onboarding-form text-base leading-relaxed text-onboarding-secondary"
            >
              {flow.error}
            </p>
            <Button
              type="button"
              onClick={flow.retry}
              className="h-12 rounded-full border-onboarding-ink bg-onboarding-ink px-6 text-base text-white hover:bg-onboarding-secondary"
            >
              Try again
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">
              {flow.phase === "redirecting" ? "Continuing…" : "One sec…"}
            </h1>
            <p
              role="status"
              className="flex max-w-onboarding-form items-center gap-2 text-base leading-relaxed text-onboarding-secondary"
            >
              <Loader2
                className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
              {flow.phase === "redirecting"
                ? "Taking you to the next step."
                : "Checking your session."}
            </p>
          </>
        )}
      </main>
      <WebsiteLearningPanel />
    </div>
  );
}
