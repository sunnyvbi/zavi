"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const RETRY_DELAYS_MS = [2000, 4000, 8000];

export function WorkspaceBackendDown() {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (attempt >= RETRY_DELAYS_MS.length) return;
    setRetrying(true);
    timerRef.current = setTimeout(() => {
      router.refresh();
      setAttempt((a) => a + 1);
      setRetrying(false);
    }, RETRY_DELAYS_MS[attempt]);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [attempt, router]);

  const exhausted = attempt >= RETRY_DELAYS_MS.length && !retrying;

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-cream px-6 text-ink">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 inline-flex h-12 w-12 items-center justify-center rounded-full bg-ink/5">
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6 text-inkMuted"
          >
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold">Can&apos;t reach Zavi</h1>
        <p className="mt-2 text-base text-inkMuted">
          {exhausted
            ? "The backend still isn't responding. This is a connection problem. Your data is safe."
            : "The backend isn't responding right now. Reconnecting… Your data is safe."}
        </p>
        <button
          type="button"
          onClick={() => {
            if (timerRef.current) clearTimeout(timerRef.current);
            setRetrying(true);
            router.refresh();
            setAttempt(0);
          }}
          aria-busy={retrying}
          className="mt-6 inline-flex items-center justify-center rounded-full bg-ink px-4 py-2 text-base font-medium text-cream transition-colors hover:bg-ink/90 disabled:opacity-60"
          disabled={retrying}
        >
          {retrying ? "Reconnecting…" : "Try again"}
        </button>
      </div>
    </div>
  );
}
