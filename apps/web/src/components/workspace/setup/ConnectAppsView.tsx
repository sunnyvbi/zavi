"use client";

import { ArrowLeft, ArrowRight, ChevronDown, ChevronsRight, Loader2, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { ZaviWordmark } from "@/components/marketing/ZaviWordmark";
import { onboardingDisplay } from "@/fonts/onboarding";
import { cn } from "@/lib/cn";
import { ConnectorErrorHost } from "../settings/connectorErrorDialog";
import { ConnectAppRow } from "./ConnectAppRow";
import { ConnectAppsGuide } from "./ConnectAppsGuide";
import type { useConnectApps } from "./useConnectApps";
import type { SetupApp } from "./connectAppsModel";
import { CONNECT_APPS_SEARCH, CONNECT_APPS_SUBTITLE, CONNECT_APPS_TITLE, SEE_LESS, SEE_MORE, startGrowingLabel } from "./connectAppsCopy";

export type ConnectAppsViewProps = {
  apps: ReturnType<typeof useConnectApps>;
  panel?: ReactNode;
  onContinue: (names: string[]) => void | Promise<unknown>;
  onSkip: () => void | Promise<unknown>;
  onBack: () => void;
  busy?: boolean;
  error?: string | null;
};

export function ConnectAppsView({ apps, panel, onContinue, onSkip, onBack, busy = false, error }: ConnectAppsViewProps) {
  const locked = busy || apps.busy !== null;
  const [pressed, setPressed] = useState<"skip" | "continue" | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const skipping = busy && pressed !== "continue";
  const continuing = busy && pressed === "continue";
  const row = (app: SetupApp) => <ConnectAppRow key={app.slug} app={app} connected={apps.isConnected(app.slug)} needsMore={apps.needsMore(app.slug)}
    busy={apps.busy === app.slug} disabled={locked || apps.loading || apps.readOnly} open={apps.open === app.slug} availability={apps.availability(app)}
    onConnect={(trigger) => void apps.connect(app, trigger)} onRequest={() => void apps.request(app)} />;
  return <div aria-busy={locked || undefined} className={cn(onboardingDisplay.variable, "flex h-full min-h-0 w-full bg-white font-onboarding text-onboarding-ink selection:bg-onboarding-ink selection:text-white")}>
    <ConnectorErrorHost />
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between px-4 pt-6 sm:px-8">
        <IconButton type="button" label="Back" onClick={onBack} disabled={locked} className="h-11 w-11 rounded-full border-onboarding-border bg-white p-0 text-onboarding-ink transition duration-onboarding-control ease-onboarding-control hover:bg-onboarding-subtle active:scale-95 motion-reduce:transform-none motion-reduce:transition-none"><ArrowLeft className="h-5 w-5" aria-hidden /></IconButton>
        <span className="lg:hidden"><ZaviWordmark size="lg" markless /></span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <main className="mx-auto w-full max-w-onboarding-form animate-past-work-enter px-4 pb-8 pt-10 sm:px-0 sm:pt-14 motion-reduce:animate-none">
          <h1 className="text-onboarding-title-mobile font-semibold tracking-tight sm:text-onboarding-title">{CONNECT_APPS_TITLE}</h1>
          <p className="mt-3 text-lg leading-7 text-onboarding-secondary">{CONNECT_APPS_SUBTITLE}</p>
          <div className="relative mb-4 mt-10">
            <label htmlFor="setup-app-search" className="sr-only">{CONNECT_APPS_SEARCH}</label>
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-onboarding-secondary" aria-hidden />
            <Input id="setup-app-search" type="search" autoComplete="off" value={apps.query} onChange={(event) => apps.setQuery(event.target.value)} placeholder={CONNECT_APPS_SEARCH} disabled={busy}
              className="h-onboarding-input border-onboarding-border bg-white pl-11 pr-5 text-onboarding-ink placeholder:text-onboarding-muted focus:border-onboarding-ink focus:ring-onboarding-ink/5" />
          </div>
          {apps.readOnly && <p className="mb-4 text-sm text-onboarding-muted">Ask an owner or admin to connect your business tools.</p>}
          {apps.returnError && <p role="alert" className="mb-4 text-sm leading-6 text-warn">The app wasn't connected. Choose Connect to try again, or skip for now.</p>}
          {apps.error && <div role="alert" className="mb-4 rounded-2xl border border-onboarding-rule p-4 text-sm"><p>{apps.error}</p><Button type="button" className="mt-2 bg-white" onClick={() => void apps.refresh()}>Retry loading apps</Button></div>}
          <p role="status" aria-live="polite" className="sr-only">{skipping ? "Skipping app setup…" : continuing ? "Preparing your workspace…" : ""}</p>
          <p role="status" className="sr-only">{apps.loading ? "Loading your connected apps" : `${apps.names.length} app${apps.names.length === 1 ? "" : "s"} connected`}</p>
          {apps.groups?.length ? <div className="space-y-8">
            {apps.groups.map((group, i) => <section key={group.title} aria-labelledby={`setup-apps-group-${i}`}>
              <h2 id={`setup-apps-group-${i}`} className="mb-3 text-sm font-semibold uppercase tracking-wide text-onboarding-muted">{group.title}</h2>
              <ul id={`setup-apps-list-${i}`} aria-label={group.title} className="space-y-2">{[...group.apps, ...(expanded.has(group.title) ? group.more : [])].map(row)}</ul>
              {group.more.length > 0 && <button type="button" disabled={locked} aria-expanded={expanded.has(group.title)} aria-controls={`setup-apps-list-${i}`}
                onClick={() => setExpanded((prev) => { const next = new Set(prev); if (next.has(group.title)) next.delete(group.title); else next.add(group.title); return next; })}
                className="mt-3 inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm font-semibold text-onboarding-secondary transition duration-onboarding-control ease-onboarding-control hover:bg-onboarding-subtle hover:text-onboarding-ink disabled:opacity-40 motion-reduce:transition-none">
                {expanded.has(group.title) ? SEE_LESS : `${SEE_MORE} (${group.more.length})`}
                <ChevronDown className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", expanded.has(group.title) && "rotate-180")} aria-hidden />
              </button>}
            </section>)}
          </div> : apps.apps.length ? <ul aria-label="Business apps" className="space-y-2">
            {apps.apps.map(row)}
          </ul> : <p className="rounded-3xl border border-onboarding-rule px-4 py-6 text-base text-onboarding-muted">No app matches “{apps.query.trim()}”.</p>}
          {apps.hasMore && <Button type="button" disabled={locked} onClick={apps.showMore} className="mt-4 rounded-full bg-white px-5">Show more</Button>}
          {panel}
          {error && <p role="alert" className="mt-4 text-sm leading-6 text-warn">{error}</p>}
        </main>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-onboarding-rule bg-white px-4 py-4 sm:px-8">
        <Button type="button" disabled={locked} onClick={() => { setPressed("skip"); void onSkip(); }} className="h-12 rounded-full border-onboarding-border bg-white px-5 text-base font-semibold text-onboarding-ink transition duration-onboarding-control ease-onboarding-control hover:bg-onboarding-subtle active:scale-95 motion-reduce:transform-none motion-reduce:transition-none">{skipping ? "Skipping…" : "Skip"}{skipping ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <ChevronsRight className="h-4 w-4" aria-hidden />}</Button>
        {apps.names.length > 0 && <Button type="button" disabled={locked || apps.loading} onClick={() => { setPressed("continue"); void onContinue(apps.names); }} className="h-12 rounded-full border-onboarding-ink bg-onboarding-ink px-5 text-base font-semibold text-white transition duration-onboarding-control ease-onboarding-control hover:bg-onboarding-secondary active:scale-95 motion-reduce:transform-none motion-reduce:transition-none">
          {continuing ? <><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />Preparing…</> : <>{startGrowingLabel(apps.names.length)}<ArrowRight className="h-4 w-4" aria-hidden /></>}
        </Button>}
      </footer>
    </div>
    <aside aria-label="Why connect" className="hidden h-full w-onboarding-panel max-w-onboarding-panel shrink-0 p-3 lg:block">
      <div className="relative flex h-full flex-col overflow-y-auto rounded-onboarding-panel border border-onboarding-rule bg-white bg-onboarding-panel bg-cover bg-center p-8">
        <div className="shrink-0"><ZaviWordmark size="lg" markless /></div>
        <div className="flex flex-1 flex-col justify-center py-6"><ConnectAppsGuide count={apps.names.length} /></div>
      </div>
    </aside>
  </div>;
}
