"use client";

import { Power, RotateCw } from "lucide-react";
import { BuildLottie, Field, WAITING_ICON_CLASS, WaitingCard } from "./WebsiteBuildProgress";

export function PreviewStoppedScreen({
  starting,
  error,
  onRestart,
}: {
  starting: boolean;
  error: string | null;
  onRestart: () => void;
}) {
  return (
    <Field live={starting}>
      <WaitingCard
        testId="preview-stopped-card"
        media={
          starting ? (
            <BuildLottie />
          ) : (
            <span aria-hidden className={`${WAITING_ICON_CLASS} bg-bone text-ink`}>
              <Power className="h-5 w-5" />
            </span>
          )
        }
        title={starting ? "Starting your preview" : "Your preview stopped"}
        notes={[{ id: "error", text: error && !starting ? <span role="alert" className="text-danger">{error}</span> : null }]}
        body={
          starting
            ? "This usually takes a minute or two. Your app opens here as soon as it's ready."
            : "Your app is built and saved. Its preview was switched off after a while without use. Restart it to see your app here."
        }
        actions={
          starting ? null : (
            <button
              type="button"
              onClick={onRestart}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-semibold text-cream transition-colors hover:bg-ink/85"
            >
              <RotateCw className="h-4 w-4" aria-hidden /> Restart preview
            </button>
          )
        }
      />
    </Field>
  );
}
