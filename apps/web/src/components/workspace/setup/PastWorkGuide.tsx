"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { AiProviderIcon } from "@/components/icons/AiProviderIcon";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import {
  AI_LINKS,
  PAST_WORK_COPY_HEADING,
  PAST_WORK_PASTE_HEADING,
  PAST_WORK_PROMPT,
  PAST_WORK_UPLOAD_HEADING,
  type PastWorkMode,
} from "./pastWorkCopy";

export function PastWorkGuide({
  mode,
  children,
}: {
  mode: PastWorkMode;
  children?: ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(PAST_WORK_PROMPT);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };
  return (
    <ol className="space-y-4">
      <li className="grid grid-cols-onboarding-step gap-3">
        <div className="flex flex-col items-center gap-2" aria-hidden="true">
          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-onboarding-border text-sm">
            1
          </span>
          <span className="w-px flex-1 bg-onboarding-border" />
        </div>
        <div className="min-w-0 pb-1">
          <h3 className="mb-2 text-base font-semibold">
            <span className="sr-only">Step 1: </span>
            {mode === "paste" ? PAST_WORK_COPY_HEADING : "Copy the prompt"}
          </h3>
          <div
            className={cn(
              "rounded-3xl bg-white",
              mode === "paste" && "border border-onboarding-border p-1.5",
            )}
          >
            <pre
              tabIndex={0}
              aria-label="Prompt to copy"
              className={cn(
                "whitespace-pre-wrap rounded-2xl bg-onboarding-subtle/50 px-3 py-2 font-onboarding text-sm leading-relaxed text-onboarding-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-onboarding-focus",
                mode === "paste"
                  ? "max-h-onboarding-prompt overflow-y-auto"
                  : "p-4",
              )}
            >
              {PAST_WORK_PROMPT}
            </pre>
            <div
              className={cn(
                "mt-1 flex",
                mode === "paste" ? "justify-end" : "mt-3",
              )}
            >
              <Button
                type="button"
                variant={mode === "paste" ? "primary" : "secondary"}
                onClick={() => void copy()}
                className={cn(
                  "h-12 rounded-full px-5 text-base font-semibold",
                  mode !== "paste" && "border-onboarding-border bg-white text-onboarding-ink hover:bg-onboarding-subtle",
                )}
              >
                {copyState === "copied" ? (
                  <Check className="h-4 w-4" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
                {copyState === "copied" ? "Copied" : "Copy prompt"}
              </Button>
            </div>
          </div>
          <p
            role="status"
            className={cn(
              "text-sm",
              copyState === "error" ? "mt-2 text-warn" : "sr-only",
            )}
          >
            {copyState === "error"
              ? "Couldn't copy. Select the prompt above and copy it manually."
              : copyState === "copied"
                ? "Prompt copied. Paste it into a new chat in your AI."
                : ""}
          </p>
        </div>
      </li>
      <li className="grid grid-cols-onboarding-step gap-3">
        <div className="flex flex-col items-center gap-2" aria-hidden="true">
          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-onboarding-border text-sm">
            2
          </span>
          <span className="w-px flex-1 bg-onboarding-border" />
        </div>
        <div className="min-w-0 pb-1">
          <h3 className="mb-2 text-base font-semibold">
            <span className="sr-only">Step 2: </span>
            {mode === "paste"
              ? "Paste it into a new chat in your AI"
              : "Paste it into your AI"}
          </h3>
          <ul className="flex flex-wrap gap-2">
            {AI_LINKS.map(({ name, href, domain }) => (
              <li key={name}>
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${name} (opens in a new tab)`}
                  className="inline-flex min-h-10 items-center gap-2 rounded-full border border-onboarding-border bg-white px-3 text-sm font-semibold transition-colors hover:bg-onboarding-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-onboarding-focus motion-reduce:transition-none"
                >
                  <AiProviderIcon domain={domain} />
                  {name}
                  <ArrowUpRight
                    className="h-3 w-3 text-onboarding-muted"
                    aria-hidden
                  />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </li>
      <li className="grid grid-cols-onboarding-step gap-3">
        <span
          aria-hidden="true"
          className="flex h-6 w-6 items-center justify-center rounded-full border border-onboarding-border text-sm"
        >
          3
        </span>
        <div className="min-w-0">
          <h3 className="mb-2 text-base font-semibold">
            <span className="sr-only">Step 3: </span>
            {children ? PAST_WORK_UPLOAD_HEADING : mode === "paste" ? PAST_WORK_PASTE_HEADING : "Upload the file"}
          </h3>
          {children ? (
            children
          ) : (
            <p className="text-sm leading-relaxed text-onboarding-secondary">
              Save the .md file your AI gives you and drop it in the box above.
            </p>
          )}
        </div>
      </li>
    </ol>
  );
}
