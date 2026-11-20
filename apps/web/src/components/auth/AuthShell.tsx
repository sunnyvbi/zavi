"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { inter } from "@/fonts";
import { AuthMarketingPanel } from "@/components/auth/AuthMarketingPanel";
import { ZaviWordmark } from "@/components/marketing/ZaviWordmark";

export function AuthShell({
  children,
  panel = true,
  panelVariant,
  aside,
  backHref,
}: {
  children: ReactNode;
  panel?: boolean;
  panelVariant?: "build" | "live";
  aside?: ReactNode;
  backHref?: string;
}) {
  return (
    <main
      className={`${inter.variable} relative min-h-screen bg-white font-[family-name:var(--font-inter)] text-[#171717] selection:bg-[#171717] selection:text-white`}
    >
      {backHref && (
        <Link
          href={backHref}
          prefetch={false}
          aria-label="Back"
          className="absolute left-4 top-4 z-20 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[#f5f5f5] text-[#171717] transition-colors hover:bg-[#ebebeb]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Link>
      )}
      <div className={`pointer-events-none absolute inset-x-0 top-8 z-10 flex justify-center compact:static compact:mb-1 compact:pt-7${backHref ? " lg:hidden" : ""}`}>
        <ZaviWordmark size="lg" markless className="pointer-events-auto" />
      </div>

      <div className="flex min-h-screen w-full flex-col compact:min-h-0 lg:flex-row">
        <section className="flex min-h-screen flex-1 flex-col bg-white compact:min-h-0">
          <div className="flex flex-1 items-center justify-center px-6 py-10 compact:py-4 md:px-10">
            <div className="w-full max-w-[420px]">{children}</div>
          </div>
        </section>

        {panel && (aside ?? <AuthMarketingPanel variant={panelVariant} />)}
      </div>
    </main>
  );
}
