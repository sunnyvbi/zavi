import type { ReactNode } from "react";
import { ZaviWordmark } from "@/components/marketing/ZaviWordmark";
import { onboardingDisplay } from "@/fonts/onboarding";
import { cn } from "@/lib/cn";
import { GrowthStartIntake, type GrowthStartIntakeProps } from "./GrowthStartIntake";
import { WebsiteLearningPanel } from "./WebsiteLearningPanel";

export function StartWebsiteStep({ children, ...intake }: GrowthStartIntakeProps & { children?: ReactNode }) {
  return (
    <div className={cn(onboardingDisplay.variable, "flex min-h-dvh bg-white font-onboarding text-onboarding-ink selection:bg-onboarding-ink selection:text-white")}>
      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 justify-center pt-7 lg:hidden">
          <ZaviWordmark size="lg" markless />
        </header>
        <main className="mx-auto flex w-full max-w-onboarding-form flex-1 flex-col justify-center px-4 pb-onboarding-form-bottom pt-8 sm:px-0">
          <div className="relative w-full">
            <GrowthStartIntake {...intake} />
            <div className="absolute inset-x-0 top-full">{children}</div>
          </div>
        </main>
      </div>
      <WebsiteLearningPanel />
    </div>
  );
}
