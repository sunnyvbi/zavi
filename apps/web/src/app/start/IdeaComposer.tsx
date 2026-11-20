"use client";
import type { RefObject } from "react";
import { ArrowUp, Mic, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Textarea } from "@/components/Input";
import {
  IdeaImageInput,
  IdeaImageThumbs,
  type IdeaImageAttachState,
} from "./IdeaImageAttach";
import { useIdeaDictation } from "./useIdeaDictation";

const IDEA_MAX_LENGTH = 4000;
const TOOL =
  "flex size-8 items-center justify-center rounded-full text-onboarding-ink transition-colors hover:bg-onboarding-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-onboarding-focus/60 disabled:cursor-not-allowed disabled:opacity-50";

export function IdeaComposer({
  idea,
  onIdeaChange,
  ideaRef,
  ready,
  ctaLabel,
  onSubmit,
  attach,
  images,
}: {
  idea: string;
  onIdeaChange: (next: string) => void;
  ideaRef: RefObject<HTMLTextAreaElement | null>;
  ready: boolean;
  ctaLabel: string;
  onSubmit: () => void;
  attach: IdeaImageAttachState | null;
  images: string[];
}) {
  const dictation = useIdeaDictation(idea, onIdeaChange, IDEA_MAX_LENGTH);

  return (
    <div className="rounded-3xl border border-onboarding-rule bg-white shadow-idea-composer transition-shadow focus-within:border-onboarding-light">
      {attach && <IdeaImageThumbs images={images} attach={attach} />}
      <Textarea
        unstyled
        ref={ideaRef}
        autoFocus
        rows={1}
        value={idea}
        onChange={(e) => {
          dictation.cancel();
          onIdeaChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && ready) {
            e.preventDefault();
            dictation.cancel();
            onSubmit();
          }
        }}
        placeholder="Type your idea..."
        aria-label="Your idea"
        maxLength={IDEA_MAX_LENGTH}
        className="block min-h-idea-composer w-full resize-none bg-transparent px-idea-composer pb-2 pt-idea-composer-top text-base font-normal leading-6 text-ink outline-none placeholder:text-onboarding-placeholder"
      />
      <div className="flex items-center justify-between pb-3 pl-4 pr-3">
        <div>
          {attach && (
            <>
              <IdeaImageInput attach={attach} />
              <button
                type="button"
                aria-label="Add images"
                title="Add images (PNG, JPEG or WebP, up to 3, 5 MB each)"
                disabled={attach.full}
                onClick={attach.open}
                className={TOOL}
              >
                <Plus aria-hidden className="size-5" strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {dictation.supported && (
            <button
              type="button"
              aria-label={dictation.listening ? "Stop dictation" : "Dictate your idea"}
              aria-pressed={dictation.listening}
              onClick={dictation.toggle}
              className={cn(
                TOOL,
                dictation.listening && "bg-dangerBg text-danger hover:bg-dangerBg hover:text-danger",
              )}
            >
              <Mic aria-hidden className={cn("size-5", dictation.listening && "animate-pulse")} strokeWidth={1.75} />
            </button>
          )}
          <button
            type="submit"
            aria-label={ctaLabel}
            title={ctaLabel}
            disabled={!ready}
            onClick={dictation.cancel}
            className="flex size-8 items-center justify-center rounded-full bg-onboarding-ink text-white transition-colors hover:bg-onboarding-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-onboarding-focus/60 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-onboarding-send-off disabled:text-onboarding-send-off-ink"
          >
            <ArrowUp aria-hidden className="size-5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}
