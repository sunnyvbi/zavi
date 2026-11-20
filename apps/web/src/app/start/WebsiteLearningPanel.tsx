import { ChartNoAxesCombined, CircleAlert, Globe, Rocket, Users } from "lucide-react";
import { ZaviMascot } from "@/components/ZaviMascot";
import { Card } from "@/components/ui/Card";
import { ZaviWordmark } from "@/components/marketing/ZaviWordmark";
import { cn } from "@/lib/cn";
import { BusinessGraphic, CompetitorsGraphic, ConstraintGraphic, GrowthGraphic } from "./WebsiteLearningGraphics";

const learningItems = [
  { label: "Your business", Icon: Rocket, Graphic: BusinessGraphic, animation: "motion-safe:animate-website-business" },
  { label: "Competitors", Icon: Users, Graphic: CompetitorsGraphic, animation: "motion-safe:animate-website-competitors" },
  { label: "What's holding you back", Icon: CircleAlert, Graphic: ConstraintGraphic, animation: "motion-safe:animate-website-constraint" },
  { label: "Where to grow", Icon: ChartNoAxesCombined, Graphic: GrowthGraphic, animation: "motion-safe:animate-website-growth" },
];

export function WebsiteLearningPanel({ status }: { status?: string | null } = {}) {
  return (
    <aside aria-label="Why Zavi needs your website" className="sticky top-0 hidden h-dvh w-onboarding-panel max-w-onboarding-panel shrink-0 p-3 lg:block">
      <div className="relative flex h-full flex-col overflow-y-auto rounded-onboarding-panel border border-black/5 bg-onboarding-panel bg-cover bg-center p-8">
        <ZaviWordmark markless size="lg" className="shrink-0 self-start rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-onboarding-focus" />
        <div className="flex flex-1 flex-col items-center justify-center py-6">
          <Card className="w-full max-w-onboarding-learning !rounded-3xl !border-onboarding-rule !bg-white p-6 !shadow-onboarding-card">
            <div className="mx-auto mb-3 flex size-24 items-center justify-center">
              <ZaviMascot size={96} />
            </div>
            <h2 className="text-center text-xl font-semibold leading-7 tracking-tight text-onboarding-ink">One link. Zavi learns:</h2>
            <div className="relative mx-auto mt-5 flex h-11 w-fit max-w-full items-center gap-2 overflow-hidden rounded-full border border-onboarding-border bg-white px-4">
              <Globe aria-hidden="true" className="size-onboarding-icon text-onboarding-secondary" strokeWidth={1.5} />
              <span className="truncate text-ad-body font-semibold text-onboarding-ink">Your website</span>
              <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-onboarding-focus/20 to-transparent motion-safe:animate-website-shine motion-reduce:hidden" />
            </div>
            <div aria-hidden="true" className="mx-auto h-5 w-px bg-onboarding-border" />
            <ul className="grid grid-cols-2 gap-3">
              {learningItems.map(({ label, Icon, Graphic, animation }) => (
                <li key={label} className={cn("rounded-2xl border border-onboarding-rule bg-white p-3 shadow-onboarding-tile motion-reduce:opacity-100", animation)}>
                  <div className="flex h-14 items-center justify-center"><Graphic /></div>
                  <p className="mt-2 flex items-center gap-1.5 text-detail font-semibold leading-4 text-onboarding-ink">
                    <Icon aria-hidden="true" className="size-3.5 shrink-0 text-onboarding-secondary" strokeWidth={1.5} />
                    {label}
                  </p>
                </li>
              ))}
            </ul>
            {status && (
              <p role="status" aria-live="polite" className="mt-4 truncate text-center text-ad-body font-semibold text-onboarding-secondary">
                {status}
              </p>
            )}
          </Card>
        </div>
      </div>
    </aside>
  );
}
