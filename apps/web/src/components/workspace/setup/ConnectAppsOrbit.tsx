import { ZaviMascot } from "@/components/ZaviMascot";
import { ConnectAppLogo } from "./ConnectAppLogo";
import { cn } from "@/lib/cn";

const APPS = [
  ["stripe", "rotate-connect-north", "-rotate-connect-north"],
  ["google_analytics", "rotate-connect-north-east", "-rotate-connect-north-east"],
  ["meta_ads", "rotate-connect-east-north", "-rotate-connect-east-north"],
  ["google_ads", "rotate-connect-east", "-rotate-connect-east"],
  ["instagram_social", "rotate-connect-east-south", "-rotate-connect-east-south"],
  ["linkedin_social", "rotate-connect-south-east", "-rotate-connect-south-east"],
  ["tiktok", "rotate-connect-south", "-rotate-connect-south"],
  ["composio.youtube", "rotate-connect-south-west", "-rotate-connect-south-west"],
  ["slack", "rotate-connect-west-south", "-rotate-connect-west-south"],
  ["whatsapp", "rotate-connect-west", "-rotate-connect-west"],
  ["composio.hubspot", "rotate-connect-west-north", "-rotate-connect-west-north"],
  ["composio.shopify", "rotate-connect-north-west", "-rotate-connect-north-west"],
] as const;

export function ConnectAppsOrbit() {
  return <div aria-hidden="true" className="relative mx-auto h-onboarding-orbit w-onboarding-orbit shrink-0">
    <div className="absolute inset-0 motion-safe:animate-connect-orbit">
      {APPS.map(([slug, rotation, counter]) => <div key={slug} className={cn("absolute left-1/2 top-1/2 h-px w-onboarding-orbit-radius origin-left", rotation)}>
        <span className="absolute inset-0 bg-connect-flow bg-connect-dash opacity-60 motion-safe:animate-connect-flow" />
        <span className="absolute left-full top-0 -translate-x-1/2 -translate-y-1/2">
          <span className={cn("block", counter)}>
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-onboarding-rule bg-white shadow-onboarding-card motion-safe:animate-connect-unorbit"><ConnectAppLogo slug={slug} small /></span>
          </span>
        </span>
      </div>)}
    </div>
    <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
      <span className="flex h-24 w-24 items-center justify-center rounded-full border border-onboarding-rule bg-white shadow-onboarding-demo motion-safe:animate-connect-pulse"><ZaviMascot size={112} /></span>
    </span>
  </div>;
}
