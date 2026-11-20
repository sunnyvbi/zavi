"use client";

import Link from "next/link";
import { ArrowUp } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { WebsiteFavicon } from "./WebsiteFavicon";
import { websiteHost } from "./websiteHost";
import { withUrlAttribution, type UrlAttribution } from "@/lib/marketing/liveFrom";

export type GrowthStartIntakeProps = {
  website: string;
  onWebsiteChange: (value: string) => void;
  error: string | null;
  onContinue: () => void;
  addCompany?: boolean;
  signedIn?: boolean;
  consentNext?: string | null;
  attribution?: UrlAttribution;
};

const LINK = "font-semibold text-onboarding-ink underline underline-offset-4 hover:text-onboarding-secondary";

export function GrowthStartIntake({ website, onWebsiteChange, error, onContinue, addCompany = false, signedIn = false, consentNext = null, attribution = {} }: GrowthStartIntakeProps) {
  const canContinue = websiteHost(website) !== null;
  const showHint = website.trim() !== "" && !canContinue;
  const describedBy = [showHint && "start-website-hint", "start-website-help", error && "start-website-error"].filter(Boolean).join(" ");
  const ideaHref = withUrlAttribution(`${addCompany ? "/start?step=idea&new=1" : "/start?step=idea"}${consentNext ? `&next=${encodeURIComponent(consentNext)}` : ""}`, attribution);

  return (
    <div className="w-full animate-website-enter motion-reduce:animate-none">
      <h1 className="text-onboarding-title-mobile font-semibold tracking-tight text-onboarding-ink sm:text-onboarding-title">
        Let&apos;s get started
      </h1>
      <p className="mt-3 text-lg leading-7 text-onboarding-secondary">
        Do 10× more. Zavi builds, grows, and runs your business for you.
      </p>
      <form
        className="mt-9"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canContinue) onContinue();
        }}
      >
        <label htmlFor="start-website" className="mb-2 block text-sm font-semibold text-onboarding-ink">
          Website URL
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-onboarding-secondary">
            <WebsiteFavicon value={website} />
          </span>
          <Input
            id="start-website"
            type="text"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            value={website}
            onChange={(event) => onWebsiteChange(event.target.value)}
            placeholder="Enter a website like acme.com"
            maxLength={200}
            aria-describedby={describedBy}
            aria-invalid={Boolean(error)}
            className="h-onboarding-input border-onboarding-border bg-white pl-11 pr-14 text-base text-onboarding-ink transition-shadow duration-200 placeholder:text-onboarding-muted focus:border-onboarding-ink focus:ring-onboarding-focus/75 focus:ring-offset-2 motion-reduce:transition-none"
          />
          <IconButton
            type="submit"
            label="Start"
            disabled={!canContinue}
            className="absolute right-1.5 top-1.5 size-10 !rounded-full !border-0 !bg-onboarding-ink !p-0 text-white transition duration-200 hover:!bg-onboarding-secondary active:scale-95 disabled:!bg-onboarding-subtle disabled:!text-onboarding-light disabled:!opacity-100 motion-reduce:transform-none motion-reduce:transition-none"
          >
            <ArrowUp aria-hidden="true" className="size-5" strokeWidth={1.5} />
          </IconButton>
        </div>
        {showHint && (
          <p id="start-website-hint" className="mt-2 text-sm font-medium leading-5 text-onboarding-ink">
            Enter a website like acme.com
          </p>
        )}
        <p id="start-website-help" className="mt-3 text-sm leading-5 text-onboarding-muted">
          Zavi reads your site, your market and your competitors, so your plan starts from what&apos;s really there.
        </p>
        {error && (
          <p id="start-website-error" role="alert" className="mt-3 text-sm leading-5 text-danger">
            {error}
          </p>
        )}
      </form>
      {}
      <div className="mt-6 space-y-2 text-sm leading-5 text-onboarding-secondary">
        <p>
          No website?{" "}
          <Link href={ideaHref} prefetch={false} className={LINK}>
            Start from an idea
          </Link>
        </p>
        {!addCompany && !signedIn && (
          <p>
            Already have an account?{" "}
            <Link href="/login" prefetch={false} className={LINK}>
              Sign in
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
