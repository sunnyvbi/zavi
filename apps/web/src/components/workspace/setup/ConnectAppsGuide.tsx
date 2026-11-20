import { ChartNoAxesCombined, Megaphone, MessageSquareText } from "lucide-react";
import { CONNECT_APPS_BENEFITS, CONNECT_APPS_HEADING, CONNECT_APPS_INTRO, CONNECT_APPS_NOTE, connectedAppCount } from "./connectAppsCopy";
import { ConnectAppsOrbit } from "./ConnectAppsOrbit";

const ICONS = [ChartNoAxesCombined, Megaphone, MessageSquareText];
export function ConnectAppsGuide({ count }: { count: number }) {
  return <div className="mx-auto w-full max-w-onboarding-connect-card shrink-0 animate-past-work-enter rounded-3xl border border-onboarding-rule bg-white p-6 shadow-onboarding-card motion-reduce:animate-none">
    <ConnectAppsOrbit />
    <h2 className="mt-6 text-xl font-semibold leading-7 tracking-tight">{CONNECT_APPS_HEADING}</h2>
    <p className="mt-2 text-base leading-6 text-onboarding-secondary">{CONNECT_APPS_INTRO}</p>
    <ul className="mt-6 space-y-4">
      {CONNECT_APPS_BENEFITS.map((benefit, index) => {
        const Icon = ICONS[index];
        return <li key={benefit.title} className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-onboarding-subtle"><Icon className="h-5 w-5" aria-hidden /></span>
          <div><h3 className="text-base font-semibold leading-6">{benefit.title}</h3><p className="text-sm leading-5 text-onboarding-secondary">{benefit.detail}</p></div>
        </li>;
      })}
    </ul>
    <p className="mt-6 text-sm leading-5 text-onboarding-muted" role="status">{count ? connectedAppCount(count) : CONNECT_APPS_NOTE}</p>
  </div>;
}
