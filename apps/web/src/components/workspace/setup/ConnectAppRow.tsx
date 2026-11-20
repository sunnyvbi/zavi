import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { connectorPanelId } from "./connectPanelId";
import { ConnectAppLogo } from "./ConnectAppLogo";
import type { SetupApp } from "./connectAppsModel";

export type AppAvailability = "ready" | "loading" | "unavailable" | "unchecked" | "requestable" | "requested";
export function ConnectAppRow({ app, connected, needsMore, busy, disabled, open, availability, onConnect, onRequest }: {
  app: SetupApp;
  connected: boolean;
  needsMore: boolean;
  busy: boolean;
  disabled: boolean;
  open: boolean;
  availability: AppAvailability;
  onConnect: (trigger: HTMLButtonElement) => void;
  onRequest: () => void;
}) {
  const panel = app.via !== "launch";
  const requesting = availability === "requestable";
  const unavailable = availability === "unavailable" || availability === "requested" || availability === "unchecked";
  const loading = availability === "loading";
  const label = connected ? `${app.name} connected` : loading ? `Loading ${app.name}` : availability === "requested" ? "Requested" : availability === "unavailable" || availability === "unchecked" ? `${app.name} unavailable` : requesting ? `I need ${app.name}` : open ? `Close ${app.name}` : `Connect ${app.name}`;
  return <li data-testid={`connector-tile-${app.slug}`} className="flex min-w-0 items-center gap-3 rounded-3xl border border-onboarding-rule bg-white p-4 transition-shadow duration-onboarding-control hover:shadow-onboarding-tile motion-reduce:transition-none">
    <ConnectAppLogo slug={app.slug} logo={app.logo} />
    <div className="min-w-0 flex-1">
      <p className="text-base font-semibold leading-6">{app.name}</p>
      <p className="text-sm leading-5 text-onboarding-muted">{needsMore ? "Needs more permissions for campaigns" : app.what}</p>
      {(requesting || unavailable) && !connected && <p className="mt-1 text-xs text-onboarding-muted">{availability === "unchecked" ? "Couldn't check right now. Reload to try again." : "Coming soon"}</p>}
    </div>
    <Button type="button" aria-label={label}
      aria-controls={panel && open ? connectorPanelId(app.slug) : undefined}
      aria-expanded={panel && !connected ? open : undefined}
      disabled={disabled || connected || busy || unavailable || loading}
      onClick={(event) => requesting ? onRequest() : onConnect(event.currentTarget)}
      className={cn("min-h-12 shrink-0 rounded-full border-onboarding-border bg-white px-4 text-sm font-semibold text-onboarding-ink transition duration-onboarding-control ease-onboarding-control hover:bg-onboarding-subtle active:scale-95 focus-visible:ring-onboarding-focus disabled:opacity-60 sm:px-5 sm:text-base motion-reduce:transform-none motion-reduce:transition-none", connected && "border-onboarding-rule bg-onboarding-subtle disabled:opacity-100")}
    >
      {busy ? <><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />Connecting…</> : connected ? <><Check className="h-4 w-4" aria-hidden />Connected</> : loading ? "Loading" : availability === "requested" ? "Requested" : availability === "unavailable" || availability === "unchecked" ? "Unavailable" : requesting ? "I need it" : open ? "Close" : needsMore ? "Update key" : "Connect"}
    </Button>
  </li>;
}
