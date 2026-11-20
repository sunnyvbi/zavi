import type { ReactNode } from "react";
import { ZaviMascot } from "@/components/ZaviMascot";
import { ZaviWordmark } from "@/components/marketing/ZaviWordmark";
import { cn } from "@/lib/cn";
export function SplashShell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-white p-3 text-ink md:p-4">
      <div className="relative flex min-h-dvh w-full flex-col overflow-hidden rounded-onboarding-panel border border-rule bg-white bg-onboarding-panel bg-cover bg-center">
        <header className="flex justify-center pt-8">
          <ZaviWordmark size="lg" markless />
        </header>
        <div className="relative flex flex-1 justify-center overflow-y-auto px-6 pb-16 pt-12 md:px-12">
          {children}
        </div>
      </div>
    </main>
  );
}
export function CenteredLoader({
  title,
  body,
  bodyPending = false,
}: {
  title: string;
  body: string;
  bodyPending?: boolean;
}) {
  return (
    <div className="my-auto flex w-full max-w-onboarding-form flex-col items-center gap-4 text-center">
      <ZaviMascot size={88} />
      <h1 className="text-3xl font-bold">{title}</h1>
      <p
        className={cn(
          "text-base leading-relaxed text-inkMuted",
          bodyPending && "invisible",
        )}
      >
        {body}
      </p>
    </div>
  );
}
export function BuildStartLayout({ idea, title, body }: { idea: string; title: string; body: string }) {
  const shown = idea.trim().slice(0, 400);
  return (
    <main data-testid="build-start-layout" className="flex min-h-dvh bg-white text-ink">
      <section aria-label="Chat" className="flex w-full flex-col border-rule p-4 lg:w-[420px] lg:shrink-0 lg:border-r">
        {shown && (
          <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-creamDeep px-3.5 py-2.5 text-[14px] leading-5">{shown}</p>
        )}
        <div role="status" className="mt-4 flex items-start gap-2.5">
          <ZaviMascot size={24} />
          <div>
            <p className="text-[14px] font-semibold leading-5">{title}</p>
            <p className="mt-0.5 text-[13px] leading-5 text-inkMuted">{body}</p>
          </div>
        </div>
      </section>
      <section aria-label="Preview" className="hidden flex-1 p-4 lg:flex">
        <div aria-hidden className="flex w-full flex-col gap-3 rounded-2xl border border-rule p-6 motion-safe:animate-pulse">
          <div className="h-6 w-1/3 rounded bg-creamDeep" />
          <div className="h-40 w-full rounded-xl bg-creamDeep" />
          <div className="grid grid-cols-3 gap-3">
            <div className="h-24 rounded-xl bg-creamDeep" />
            <div className="h-24 rounded-xl bg-creamDeep" />
            <div className="h-24 rounded-xl bg-creamDeep" />
          </div>
        </div>
      </section>
    </main>
  );
}
export function StashWarning() {
  return (
    <p
      role="status"
      className="mt-4 rounded-xl border border-warn/20 bg-warn/5 px-4 py-3 text-sm leading-relaxed text-warn"
    >
      This browser will not let us hold your answers while you sign up, so they
      will be gone when you come back. Copy anything you want to keep, then
      continue.
    </p>
  );
}
export function CommitErrorBanner({ message }: { message: string }) {
  return (
    <div className="mt-4 rounded-lg border border-warn/20 bg-warn/5 px-3 py-2 text-sm text-warn">
      {message}
    </div>
  );
}
