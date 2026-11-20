"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useWebsiteSignupResume } from "./useWebsiteSignupResume";

export const OPENING_WORKSPACE = "Opening your workspace…";
const SKIP_FAILED = "Couldn't open your workspace. Please try again.";

export function WebsiteSignupResume() {
  const flow = useWebsiteSignupResume();
  const [skipError, setSkipError] = useState<string | null>(null);
  const started = useRef(false);
  const skip = () => {
    setSkipError(null);
    flow.finish("skipped").catch((error: unknown) => {
      setSkipError(error instanceof Error && error.message ? error.message : SKIP_FAILED);
    });
  };
  useEffect(() => {
    if (!flow.ready || started.current) return;
    started.current = true;
    skip();
  });
  const error = flow.error ?? skipError;
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-white px-6 text-center" data-testid="website-signup-resume">
      {error ? (
        <>
          <p role="alert" className="text-base text-onboarding-secondary">{error}</p>
          <Button
            type="button"
            onClick={() => {
              if (flow.error) flow.retry();
              else skip();
            }}
            className="rounded-full"
          >
            Try again
          </Button>
        </>
      ) : (
        <p role="status" className="flex items-center gap-2 text-base text-onboarding-secondary">
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          {OPENING_WORKSPACE}
        </p>
      )}
    </div>
  );
}
