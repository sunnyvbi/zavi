
"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { firstTouchForSignup } from "@/lib/analytics/first-touch";
import { signupAttribution, urlAttribution } from "@/lib/marketing/liveFrom";

type State = "claiming" | "done" | "error";

function ClaimingSpinner() {
  return (
    <div className="min-h-screen bg-white text-[#171717]">
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
        <div aria-live="polite">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800" />
          <p className="text-lg font-medium">Setting up your workspace...</p>
        </div>
      </main>
    </div>
  );
}

export default function LaunchVideoClaimPage() {
  return (
    <Suspense fallback={<ClaimingSpinner />}>
      <LaunchVideoClaimInner />
    </Suspense>
  );
}

function LaunchVideoClaimInner() {
  const params = useSearchParams();
  const jobId = params.get("job") ?? "";
  const [state, setState] = useState<State>("claiming");
  const [hdUrl, setHdUrl] = useState<string | null>(null);
  const [existingWorkspace, setExistingWorkspace] = useState(false);

  useEffect(() => {
    if (!jobId) {
      setState("error");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/launch-video/claim", {
          method: "POST",
          body: JSON.stringify({ job_id: jobId, attribution: signupAttribution(firstTouchForSignup(), urlAttribution(params)) }),
        });
        if (cancelled) return;
        if (!res.ok) {
          setState("error");
          return;
        }
        const data = (await res.json()) as { hd_url: string | null; status?: string };
        setHdUrl(data.hd_url);
        setExistingWorkspace(data.status === "user_has_tenant");
        setState("done");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  return (
    <div className="min-h-screen bg-white text-[#171717]">
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 text-center">
        {state === "claiming" && (
          <div aria-live="polite">
            <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800" />
            <p className="text-lg font-medium">Setting up your workspace...</p>
          </div>
        )}

        {state === "done" && (
          <div aria-live="polite" className="space-y-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                {existingWorkspace ? "Here's your video" : "You're all set"}
              </h1>
              <p className="mt-2 text-neutral-600">
                {existingWorkspace
                  ? "Download it below. Your existing workspace is unchanged."
                  : "Your launch video is ready in your Zavi workspace."}
              </p>
            </div>
            <div className="flex flex-col items-center gap-3">
              {hdUrl && (
                <a
                  href={hdUrl}
                  className="rounded-lg bg-[#171717] px-4 py-3 text-base font-semibold text-white transition hover:bg-black"
                  download
                >
                  Download HD video
                </a>
              )}
              <Link href="/workspace" className="text-base font-medium text-neutral-600 hover:text-neutral-900">
                Go to your workspace
              </Link>
            </div>
          </div>
        )}

        {state === "error" && (
          <div className="space-y-4">
            <p className="text-lg font-medium">We couldn't finish setting this up.</p>
            <Link
              href="/workspace"
              className="inline-block rounded-lg border border-neutral-300 px-4 py-2.5 text-base font-semibold hover:bg-neutral-50"
            >
              Go to your workspace
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
