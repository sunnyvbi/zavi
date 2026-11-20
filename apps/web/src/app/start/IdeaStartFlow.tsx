"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Lightbulb } from "lucide-react";
import {
  CreditRefusalNotice,
  BILLING_URL,
} from "@/components/workspace/CreditRefusalNotice";
import {
  IDEA_TOO_SHORT_HINT,
  WEBSITE_COMMIT_BODY,
  WEBSITE_COMMIT_TITLE,
} from "@/lib/workspace/buildFraming";
import {
  TemplateChip,
  TemplateGallery,
} from "@/components/workspace/build/TemplateGallery";
import { cn } from "@/lib/cn";
import { NextChevron } from "@/components/ui/NextChevron";
import { trackEvent } from "@/lib/analytics/events";
import { BrainstormPanel } from "./BrainstormPanel";
import { IdeaComposer } from "./IdeaComposer";
import {
  IDEA_CHIP,
  IdeaExampleChips,
  TEMPLATE_CHIP_ICON,
} from "./IdeaExampleChips";
import { IdeaImageError, useIdeaImageAttach } from "./IdeaImageAttach";
import { ideaBackHref } from "./ideaBackHref";
import { useIdeaStart } from "./useIdeaStart";
import { goToWorkspaceWithFreshClaim } from "./workspaceHandoff";
import {
  BuildStartLayout,
  SplashShell,
  CenteredLoader,
  StashWarning,
  CommitErrorBanner,
} from "./StartFeedback";
export function IdeaStartFlow() {
  const {
    authState,
    committing,
    idea,
    setIdea,
    ideaRef,
    ideaImages,
    setIdeaImages,
    template,
    setTemplate,
    brainstormOpen,
    setBrainstormOpen,
    ideaValid,
    ideaReady,
    ideaExamples,
    ideaAttach,
    templateBlanks,
    stashFailed,
    commitError,
    setCommitError,
    commitCredit,
    retryTenantId,
    ideaCtaLabel,
    markBrainstormUsed,
    submitIdea,
  } = useIdeaStart();
  const backHref = ideaBackHref(useSearchParams().toString());
  const imageAttach = useIdeaImageAttach(ideaImages, setIdeaImages);
  const changeIdea = (next: string) => {
    setIdea(next);
    if (commitError) setCommitError(null);
  };
  if (authState === "loading")
    return (
      <SplashShell>
        <CenteredLoader title="One sec…" body="Checking your session." />
      </SplashShell>
    );
  if (authState === "onboarded")
    return (
      <SplashShell>
        <CenteredLoader title="Taking you in…" body="Opening your workspace." />
      </SplashShell>
    );
  if (authState === "error")
    return (
      <SplashShell>
        <div role="alert">
          <h1>We could not open your account</h1>
          <p>
            Something went wrong reading your account. Try again in a moment.
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </SplashShell>
    );
  if (committing)
    return <BuildStartLayout idea={idea} title={WEBSITE_COMMIT_TITLE} body={WEBSITE_COMMIT_BODY} />;
  return (
    <SplashShell>
      <div className="w-full max-w-idea-column pt-2">
        <div
          className={cn(
            "transition-transform duration-idea ease-idea",
            brainstormOpen && "lg:-translate-x-idea-brainstorm",
          )}
        >
          <Link
            href={backHref}
            prefetch={false}
            aria-label="Back"
            className="flex size-8 items-center justify-center rounded-full bg-onboarding-back text-onboarding-secondary transition-colors hover:bg-onboarding-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-onboarding-focus/60"
          >
            <ArrowLeft aria-hidden className="size-5" strokeWidth={2} />
          </Link>
          <h1 className="mt-8 text-center font-display text-idea-title font-bold tracking-tight text-ink md:text-idea-hero md:tracking-normal">
            What&apos;s your idea?
          </h1>
          <p className="mx-auto mt-5 max-w-idea-intro text-center text-sm leading-5 text-onboarding-muted">
            Zavi thinks, builds, and markets your project autonomously. It
            plans, codes, deploys it, and gives you a live URL. Refine it by
            chat after.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitIdea();
            }}
            className="mt-8"
          >
            {template && (
              <TemplateChip
                template={template}
                blanks={templateBlanks}
                onClear={() => setTemplate(null)}
              />
            )}
            <IdeaComposer
              idea={idea}
              onIdeaChange={changeIdea}
              ideaRef={ideaRef}
              ready={ideaReady}
              ctaLabel={ideaCtaLabel}
              onSubmit={submitIdea}
              attach={ideaAttach === true ? imageAttach : null}
              images={ideaImages}
            />
            {ideaExamples === true && idea.trim().length > 0 && !ideaValid && (
              <p role="status" className="mt-2 text-center text-sm text-onboarding-secondary">
                {IDEA_TOO_SHORT_HINT}
              </p>
            )}
            {ideaAttach === true && <IdeaImageError attach={imageAttach} />}
            {stashFailed && <StashWarning />}
            {commitError &&
              (commitCredit && commitError === commitCredit.headline ? (
                <CreditRefusalNotice
                  refusal={commitCredit}
                  className="mt-4"
                  onOpenBilling={() => {
                    trackEvent("onboarding_billing_opened");
                    const tab = window.open("", "_blank");
                    if (tab) tab.opener = null;
                    void goToWorkspaceWithFreshClaim(
                      retryTenantId ?? undefined,
                      BILLING_URL,
                      tab,
                    );
                  }}
                />
              ) : (
                <CommitErrorBanner message={commitError} />
              ))}
          </form>
          <IdeaExampleChips
            showExamples={ideaExamples === true && idea.trim().length === 0}
            onPick={(next) => {
              changeIdea(next);
              ideaRef.current?.focus();
            }}
            templateTrigger={
              <TemplateGallery
                selectedId={template?.id ?? null}
                triggerClassName={IDEA_CHIP}
                triggerIcon={TEMPLATE_CHIP_ICON}
                onUse={({ template: picked, idea: filled }) => {
                  trackEvent("onboarding_template_picked", {
                    template: picked.id,
                  });
                  setTemplate(picked);
                  changeIdea(filled);
                  requestAnimationFrame(() => {
                    const box = ideaRef.current;
                    if (!box) return;
                    box.focus();
                    box.setSelectionRange(filled.length, filled.length);
                  });
                }}
              />
            }
          />
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => {
                trackEvent("onboarding_brainstorm_opened");
                setBrainstormOpen(true);
              }}
              className="group inline-flex items-center gap-1.5 text-sm text-ink/80 transition-colors hover:text-ink"
            >
              <Lightbulb aria-hidden className="size-4" strokeWidth={1.75} />
              Not sure yet?{" "}
              <span className="font-semibold text-ink underline-offset-2 group-hover:underline">
                Brainstorm it
              </span>
              <NextChevron className="text-onboarding-secondary transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
          <BrainstormPanel
            open={brainstormOpen}
            onClose={() => setBrainstormOpen(false)}
            seedIdea={idea}
            onUseIdea={(brief) => {
              markBrainstormUsed();
              setIdea(brief);
            }}
          />
        </div>
      </div>
    </SplashShell>
  );
}
