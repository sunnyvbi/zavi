"use client";

import {
  BUILD_SLOW_NOTE,
  hasFailedStage,
  hasTimedStage,
  progressHoldKey,
  progressPct,
  slowRunningStage,
  useHeldProgress,
  useProgressClock,
} from "../home/BuildStatusPanel";
import type { BuildFailure, BuildStageRow } from "@/lib/workspace/useBuildPreview";
import buildLoaderAnimation from "@/assets/build-loader.json";
import type { AnimationItem } from "lottie-web";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { retryingStepLabel } from "@/lib/workspace/buildRetry";
import { buildEstimateText } from "@/lib/workspace/buildEstimate";
import { BUILD_PROGRESS_BODY_ON_REQUEST, BUILD_SLOW_BODY_ON_REQUEST } from "@/lib/workspace/buildFraming";
import { BUILD_INTERNAL_FAILURE, buildFailureLine } from "@/lib/workspace/buildFailureCopy";

const HEADLINE_LINES = ["Have a coffee, or", "take a break"] as const;
export const PICK_LOOK_HEADLINE = "Pick a website";
const DONE_STATUSES: ReadonlySet<string> = new Set(["done", "success", "succeeded"]);
export const BUILD_PROGRESS_BODY =
  "Your preview shows up here once your site is fully built. Publishing it to your live address comes after, and we'll let " +
  "you know the moment it's live.";
export const BUILD_SLOW_BODY =
  "This build is taking longer than usual. " +
  "You can leave this page, and we'll let you know the moment it's live.";
export function buildProgressBody(estimate: string | null, publishOnRequest = false): string {
  const body = publishOnRequest ? BUILD_PROGRESS_BODY_ON_REQUEST : BUILD_PROGRESS_BODY;
  return estimate ? `${estimate}. ${body}` : body;
}
export { BUILD_SLOW_NOTE, STAGE_SLOW_FACTOR, slowRunningStage } from "../home/BuildStatusPanel";
export const PUBLISHING_BODY =
  "Your app is built. We're publishing it to your address now, and this page " +
  "updates the moment it's live.";
export const PUBLISH_FAILED_RETRY_BODY =
  "Your app is built. Use Retry publish to try putting it on your address again.";
export const PUBLISH_FAILED_BODY =
  "Your app is built, but publishing it to your address didn't finish. Start a new build to try again.";

const STAGE_LABEL: Record<string, string> = {
  provision: "Provisioning infrastructure",
  spec: "Writing the product spec",
  scaffold: "Scaffolding the codebase",
  build: "Building your site",
  qa: "Checking the build",
};

type LottieLib = typeof import("lottie-web").default;
type LottieHost = { el: HTMLDivElement; anim: AnimationItem | null; owner: HTMLElement | null; release: ReturnType<typeof setTimeout> | null };

export const LOTTIE_RELEASE_MS = 1500;
let lottieLib: LottieLib | null = null;
let lottieLoad: Promise<LottieLib | null> | null = null;
let lottieHost: LottieHost | null = null;

export function loadLottie(): Promise<LottieLib | null> {
  if (!lottieLoad) {
    lottieLoad = import("lottie-web")
      .then((m) => (lottieLib = m.default))
      .catch(() => null);
  }
  return lottieLoad;
}

if (typeof window !== "undefined") void loadLottie();

function startLottie(host: LottieHost): void {
  if (host.anim || !lottieLib) return;
  host.anim = lottieLib.loadAnimation({
    container: host.el,
    renderer: "svg",
    loop: true,
    autoplay: true,
    animationData: buildLoaderAnimation,
    rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
  });
}

function attachLottie(container: HTMLElement): () => void {
  let host = lottieHost;
  if (!host) {
    const el = document.createElement("div");
    el.className = "h-full w-full";
    host = lottieHost = { el, anim: null, owner: null, release: null };
  }
  const h = host;
  if (h.release) {
    clearTimeout(h.release);
    h.release = null;
  }
  container.appendChild(h.el);
  h.owner = container;
  if (lottieLib) startLottie(h);
  else void loadLottie().then(() => {
    if (lottieHost === h) startLottie(h);
  });
  return () => {
    if (h.owner !== container) return;
    h.owner = null;
    if (h.el.parentNode === container) container.removeChild(h.el);
    h.release = setTimeout(() => {
      if (h.owner) return;
      h.anim?.destroy();
      h.anim = null;
      if (lottieHost === h) lottieHost = null;
    }, LOTTIE_RELEASE_MS);
  };
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function BuildLottie() {
  const containerRef = useRef<HTMLDivElement>(null);
  useIsoLayoutEffect(() => {
    if (!containerRef.current) return;
    return attachLottie(containerRef.current);
  }, []);
  return (
    <div
      ref={containerRef}
      data-testid="build-lottie"
      className="aspect-[462/532] h-32 shrink-0 overflow-hidden"
      aria-hidden="true"
    />
  );
}

export const WAITING_CARD_CLASS =
  "flex w-full max-w-[560px] flex-col items-center rounded-[28px] border border-rule bg-cream/90 px-7 py-8 text-center shadow-[0_18px_55px_-38px_rgba(14,15,17,0.5)] sm:px-10";
export const WAITING_MEDIA_CLASS = "mb-4 flex w-full shrink-0 items-center justify-center";
export const WAITING_TITLE_CLASS = "text-balance font-display text-[clamp(22px,2.8vw,30px)] font-bold leading-[1.18] tracking-tighter text-ink";
export const WAITING_METER_CLASS = "mt-4 flex w-full items-center justify-center";
export const WAITING_NOTES_CLASS = "mt-3 flex w-full flex-col items-center gap-1";
export const WAITING_BODY_CLASS = "mt-3 w-full max-w-[400px] text-balance text-[14px] leading-[1.6] text-inkMuted";
export const WAITING_BODY_LINES = 3;
const WAITING_CARD_PAD_Y = 32;
export const WAITING_ACTIONS_CLASS = "mt-5 flex shrink-0 items-center justify-center gap-2";
export const WAITING_ICON_CLASS = "inline-flex h-11 w-11 items-center justify-center rounded-full";

export const WAITING_BAR_WIDTH_CLASS = "w-full max-w-[400px]";

export function WaitingMeter({ label }: { label: string }) {
  return (
    <div
      data-testid="waiting-meter"
      role="progressbar"
      aria-label={label}
      className={`h-2 ${WAITING_BAR_WIDTH_CLASS} overflow-hidden rounded-full bg-ink/10`}
    >
      <div className="h-full w-1/3 rounded-full bg-ink/55 motion-safe:animate-indeterminate-bar motion-reduce:w-full motion-reduce:opacity-40" />
    </div>
  );
}

export type WaitingNote = { id: string; testId?: string; text: ReactNode | null; status?: boolean };

export function WaitingCard({
  testId,
  media,
  title,
  titleTestId,
  meter = null,
  notes = [],
  body,
  actions = null,
}: {
  testId?: string;
  media: ReactNode;
  title: ReactNode;
  titleTestId?: string;
  meter?: ReactNode;
  notes?: WaitingNote[];
  body: ReactNode;
  actions?: ReactNode;
}) {
  const shownNotes = notes.filter((n) => n.text !== null && n.text !== false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<{ lines: number; lh: number }>({ lines: WAITING_BODY_LINES, lh: 0 });
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      const h = el.getBoundingClientRect().height;
      if (!Number.isFinite(lh) || lh <= 0 || h <= 0) return;
      const n = Math.min(WAITING_BODY_LINES, Math.max(1, Math.round(h / lh)));
      setFit((prev) => (prev.lines === n && prev.lh === lh ? prev : { lines: n, lh }));
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [body]);
  const spare = ((WAITING_BODY_LINES - fit.lines) * fit.lh) / 2;
  const pad = spare > 0 ? `${WAITING_CARD_PAD_Y + spare}px` : undefined;
  return (
    <div
      data-testid={testId}
      data-waiting-card=""
      data-body-lines={fit.lines}
      className={WAITING_CARD_CLASS}
      style={pad ? { paddingTop: pad, paddingBottom: pad } : undefined}
    >
      <div data-waiting-slot="media" className={WAITING_MEDIA_CLASS}>
        {media}
      </div>
      <div data-waiting-slot="headline" className="flex w-full items-center justify-center">
        <h2 data-testid={titleTestId} className={WAITING_TITLE_CLASS}>
          {title}
        </h2>
      </div>
      {meter && (
        <div data-waiting-slot="meter" className={WAITING_METER_CLASS}>
          {meter}
        </div>
      )}
      {shownNotes.length > 0 && (
        <div data-waiting-slot="notes" className={WAITING_NOTES_CLASS}>
          {shownNotes.map((n) => (
            <p
              key={n.id}
              data-waiting-note={n.id}
              data-testid={n.testId}
              role={n.status ? "status" : undefined}
              className="text-balance text-[13.5px] font-medium leading-5 text-inkMuted"
            >
              {n.text}
            </p>
          ))}
        </div>
      )}
      <div ref={bodyRef} data-waiting-slot="body" className={WAITING_BODY_CLASS}>
        {body}
      </div>
      {actions && (
        <div data-waiting-slot="actions" className={WAITING_ACTIONS_CLASS}>
          {actions}
        </div>
      )}
    </div>
  );
}

export function PreviewLoadingScreen() {
  return (
    <Field live>
      <WaitingCard
        testId="preview-pending-card"
        media={<BuildLottie />}
        title="Loading preview"
        meter={<WaitingMeter label="Loading preview" />}
        body="Your preview opens here in a moment."
      />
    </Field>
  );
}

export function LookPickerSkeleton() {
  return (
    <div data-testid="look-picker-skeleton" aria-hidden className="mt-2.5">
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[300px] animate-pulse rounded-2xl bg-bone motion-reduce:animate-none" />
        ))}
      </div>
      <div className="mt-2.5 h-10 w-40 animate-pulse rounded-full bg-bone motion-reduce:animate-none" />
    </div>
  );
}

export const PICKER_SLOT_CLASS = "mt-8 min-h-[360px] w-full text-left";

export function WebsiteBuildProgress({
  stages,
  failure,
  failed,
  publish = null,
  runId = null,
  publishOnRequest = false,
  awaitingPick = false,
  picker = null,
}: {
  stages: BuildStageRow[];
  failure: BuildFailure | null;
  failed: boolean;
  publish?: "publishing" | "failed" | "failed-retry" | null;
  publishOnRequest?: boolean;
  runId?: string | null;
  awaitingPick?: boolean;
  picker?: ReactNode;
}) {
  const waiting = awaitingPick && !failed && publish === null;
  const nowMs = useProgressClock(!waiting && !failed && publish === null && hasTimedStage(stages));
  const pct = useHeldProgress(progressPct(stages, nowMs), runId ?? progressHoldKey(stages), runId, failed || hasFailedStage(stages));
  const retrying = retryingStepLabel(stages);
  const slow = !waiting && !failed && publish === null && slowRunningStage(stages, nowMs);
  const estimate = slow ? null : buildEstimateText(stages, nowMs);

  if (waiting) {
    return (
      <Field live>
        <div key="pick" className="flex w-full flex-col items-center">
          <h2
            data-testid="build-progress-pick-look"
            className="font-display text-[clamp(26px,3.8vw,40px)] font-bold leading-[1.16] tracking-tighter text-[#0e0f11]"
          >
            {PICK_LOOK_HEADLINE}
          </h2>
          <div data-testid="look-picker-slot-frame" className={PICKER_SLOT_CLASS}>
            {picker ?? <LookPickerSkeleton />}
          </div>
        </div>
      </Field>
    );
  }

  let card: ReactNode;
  if (publish === "publishing") {
    card = (
      <WaitingCard
        testId="build-progress-card"
        media={
          <Loader2
            data-testid="build-publishing-spinner"
            className="h-10 w-10 animate-spin text-ink motion-reduce:animate-none"
            aria-hidden
          />
        }
        title="Publishing"
        body={PUBLISHING_BODY}
      />
    );
  } else if (publish === "failed" || publish === "failed-retry") {
    card = (
      <WaitingCard
        testId="build-progress-card"
        media={
          <span aria-hidden className={`${WAITING_ICON_CLASS} bg-red-100 text-[16px] font-semibold text-red-700`}>
            !
          </span>
        }
        title={<>Publishing didn&apos;t finish</>}
        body={publish === "failed-retry" ? PUBLISH_FAILED_RETRY_BODY : PUBLISH_FAILED_BODY}
      />
    );
  } else if (failed) {
    const stage = failure?.stage ? STAGE_LABEL[failure.stage] ?? failure.stage : null;
    card = (
      <WaitingCard
        testId="build-progress-card"
        media={
          <span aria-hidden className={`${WAITING_ICON_CLASS} bg-red-100 text-[16px] font-semibold text-red-700`}>
            ✕
          </span>
        }
        title="The build stopped before your site was ready"
        notes={[{ id: "stage", text: stage ? `Stopped at: ${stage}` : null }]}
        body={
          <>
            <span className="block">
              {buildFailureLine(failure, { startedWork: stages.some((s) => DONE_STATUSES.has(s.status)) }) ??
                BUILD_INTERNAL_FAILURE}
            </span>
            <span className="mt-2 block">Tell your team what to try in the chat and they&apos;ll pick it back up.</span>
          </>
        }
      />
    );
  } else {
    card = (
      <WaitingCard
        testId="build-progress-card"
        media={<BuildLottie />}
        title={
          <>
            {HEADLINE_LINES[0]}
            <br />
            {HEADLINE_LINES[1]}
          </>
        }
        meter={
          <div className={`flex ${WAITING_BAR_WIDTH_CLASS} items-center gap-3`}>
            <div
              className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-ink/10"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label="Website build progress"
            >
              <div className="h-full rounded-full bg-ink" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-[3ch] shrink-0 text-right text-[14px] font-medium tabular-nums text-inkMuted">
              {pct}%
            </span>
          </div>
        }
        notes={[
          { id: "retry", testId: "build-progress-retry", text: retrying || null },
          { id: "slow", testId: "build-progress-slow", text: slow ? BUILD_SLOW_NOTE : null, status: true },
        ]}
        body={
          slow
            ? publishOnRequest
              ? BUILD_SLOW_BODY_ON_REQUEST
              : BUILD_SLOW_BODY
            : buildProgressBody(estimate, publishOnRequest)
        }
      />
    );
  }

  return (
    <Field live={publish === "publishing" || (!failed && publish === null)}>
      <div key="card" className="flex w-full justify-center">
        {card}
      </div>
    </Field>
  );
}

export function Field({ children, live = false }: { children: React.ReactNode; live?: boolean; wide?: boolean }) {
  return (
    <div
      role="status"
      {...(live ? { "aria-live": "polite" as const } : {})}
      className="flex h-full justify-center overflow-y-auto rounded-2xl bg-creamDeep/45 px-6 py-10"
    >
      <div data-testid="waiting-field" className="my-auto flex w-full max-w-[1040px] flex-col items-center text-center">
        {children}
      </div>
    </div>
  );
}
