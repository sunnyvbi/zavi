"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ZaviMascot } from "@/components/ZaviMascot";
import { ERROR_BODY, ERROR_HEADLINE } from "@/lib/errorCopy";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[route-error]", error.digest ?? "", error.message);
  }, [error]);
  return (
    <main id="zavi-main" className="min-h-screen bg-cream text-ink flex items-center justify-center px-6">
      <div className="w-full max-w-[480px] text-center">
        <div className="flex justify-center mb-6">
          <ZaviMascot size={120} />
        </div>
        <h1 className="font-display font-semibold text-[28px] md:text-[34px] tracking-tighter leading-[1.1]">
          {ERROR_HEADLINE}
        </h1>
        <p className="mt-4 text-[16px] leading-[1.6] text-inkMuted">{ERROR_BODY}</p>
        <div className="mt-8 flex flex-col sm:flex-row gap-2.5 justify-center">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex items-center justify-center rounded-full bg-ink text-cream px-4 py-2.5 text-[16px] font-semibold hover:bg-violet transition-colors"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-full border border-ink/20 px-4 py-2.5 text-[16px] font-semibold hover:border-ink transition-colors"
          >
            Go to the home page
          </Link>
        </div>
      </div>
    </main>
  );
}
