"use client";

import { startSiteRefusal } from "@/lib/workspace/buildRoles";
import { PickedElementChip } from "@/components/workspace/website/PickedElementChip";
import { TemplateChip, TemplateGallery } from "./TemplateGallery";
import { unfilledBlanks, type PickedTemplate } from "@/lib/workspace/siteTemplates";
import { splitFileRefs } from "@/lib/workspace/fileRefs";
import { shouldShowTimeStamp } from "@/lib/workspace/dayLabels";
import { DayDivider } from "../DayDivider";
import { FileRefChips } from "../FileRefChips";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ExternalLink,
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Globe2,
  ImagePlus,
  ListChecks,
  Loader2,
  Plus,
  RotateCcw,
  RotateCw,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { apiFetch } from "@/lib/api";
import { toast } from "@/components/ui/toast";
import { REPLACED_BUILD_LABEL, buildSessionTitle, siteBadge, siteHref, siteName, type BuildSessionMeta } from "@/lib/workspace/buildHistory";
import { MicButton } from "@/components/voice/MicButton";
import { appendDictatedText } from "@/lib/voice/useDictation";
import {
  IDEA_MAX_CHARS,
  IDEA_MIN_CHARS,
  type BuildStatus,
} from "@/lib/workspace/useBuildProduct";
import type {
  BuildPreviewKind,
  BuildStageRow,
} from "@/lib/workspace/useBuildPreview";
import { NO_PUBLISH, buildPublishesOnRequest, type BuildPublish } from "@/lib/workspace/buildPublish";
import {
  NEW_SESSION_KEY,
  startBuildSession,
  startBuildRefine,
  undoBuildRefine,
  useBuildSession,
  isHeldChange,
  refineRetryMessage,
  previewRevisionOf,
  isPlainUndoNotice,
  isRefineBusy,
  refineSubmittingFor,
  BUILD_REFINE_STARTED_EVENT,
  BUILD_REFINE_SUBMITTING_EVENT,
  latestBusyRefine,
  type BuildPhotosMissing,
  type BuildRefine,
  type RefinePickedElement,
  type BuildSessionSeed,
} from "@/lib/workspace/useBuildSession";
import {
  readBuildSessions,
  refreshBuildSessions,
  useBuildSessions,
} from "@/lib/workspace/useBuildSessions";
import {
  buildFailureLine,
  changeFailureCopy,
  isOutOfCreditsBuild,
  type BuildFailureLike,
} from "@/lib/workspace/buildFailureCopy";
import { useAppReadiness } from "@/lib/workspace/useAppReadiness";
import {
  BUILD_PAUSED_REFUSAL,
  BUILD_STOPPED_REFUSAL,
  type CreditRefusal,
} from "@/lib/workspace/creditRefusal";
import { CreditRefusalNotice } from "@/components/workspace/CreditRefusalNotice";
import { OldSiteFrozenNotice } from "@/components/workspace/OldSiteRebuild";
import { isOldSiteFrozen, OLD_SITE_FROZEN_FALLBACK, type OldSiteFrozenRefusal } from "@/lib/workspace/oldSiteRebuild";
import { useWorkspace, useWorkspaceOptional } from "../WorkspaceShell";
import { BuildComposerMenu } from "./BuildComposerMenu";
import { PlanReviewCard } from "./PlanReviewCard";
import { BuildClarifyStep, ideaAnswersEverything } from "../home/BuildClarifyStep";
import { isBuilderClarifyEnabled } from "@/lib/workspace/builderClarifyFlag";
import { askedText, combineIdeaAndPlan, fitClarifiedIdea, PLAN_APPROVE_MAX_CHARS } from "@/lib/workspace/buildPreSteps";
import { claimStartAgain, settleStartAgain, startAgainEntry, useStartAgainEntry } from "./startAgainGuard";
import { useOpenStatic } from "../layout/shared";
import { ChannelTags } from "../ChannelPicker";
import { ComposerIconButton, ModeComposer, SendCircle } from "../ModeComposer";
import { BUILD_IMAGE_MAX, imageFilesFrom, useBuildImageAttachments } from "@/lib/workspace/useBuildImageAttachments";
import { Skeleton } from "../Skeleton";
import { WorkspaceModeWelcome } from "../ZaviWelcome";
import { CopyMessageButton } from "../CopyMessageButton";
import { RunMetaMenu } from "../RunCostMeta";
import { BuildMascotAvatar } from "./BuildMascotAvatar";
import { RunPanel } from "../RunPanel";
import { BUILD_STOPPED_BY_YOU_RESTART, SITE_DATABASE_WAITING, buildRunPanel, type RunPanel as RunPanelModel } from "@zavi/shared";
import { cx, FOCUS_RING, MESSAGE_ACTION_BUTTON, MESSAGE_ACTION_ICON } from "../layout/shared";
import { retryingStepLabel } from "@/lib/workspace/buildRetry";
import { buildEstimateText, designAwaitsPick } from "@/lib/workspace/buildEstimate";
import { useSharedSiteDesign } from "@/lib/workspace/useSiteDesign";
import { useProgressClock } from "../home/BuildStatusPanel";
import {
  BUILD_EXPECTED_DURATION_ON_REQUEST,
  BUILD_READY_UNPUBLISHED,
  BUILD_START_AGAIN,
  BUILD_STOPPED_PREVIEW,
  BUILD_STOPPED_TITLE,
  PUBLISH_CHECK_FIXING,
  PUBLISH_TRY_AGAIN_HINT,
  publishCheckLine,
  UNDO_PREVIEW_ONLY_CONFIRM,
  REFINE_STRIP_ON_REQUEST,
  SITE_LIST_NEW,
  SITE_LIST_TITLE,
  useSiteListFirst,
} from "@/lib/workspace/buildFraming";
import { BUILD_READY_PREVIEW_STOPPED } from "@/lib/workspace/buildPreviewRestart";
import { SiteDesignCard } from "./SiteDesignCard";
import { BuildRating } from "./BuildRating";
import { buildLinkedOnLoad } from "@/lib/workspace/buildLinkOnLoad";
import type {
  BuildPreviewProgress,
  BuildPreviewTarget,
} from "./BuildPreviewPanel";
import { NextChevron } from "@/components/ui/NextChevron";

type StepState = "pending" | "active" | "done" | "failed";
type BuildStep = { key: string; label: string; state: StepState };

export const STEP_LABELS = [
  ["workspace", "Setting up your workspace"],
  ["understanding", "Understanding your request"],
  ["structure", "Creating the app structure"],
  ["interface", "Building the interface"],
  ["checks", "Checking your app"],
  ["deploy", "Publishing to your address"],
] as const;

export const STAGE_TO_STEP_KEY: Record<string, string> = {
  provision: "workspace",
  spec: "understanding",
  scaffold: "structure",
  build: "interface",
  qa: "checks",
  deploy: "deploy",
};

const ALWAYS_STEP_KEYS: ReadonlySet<string> = new Set(["workspace", "interface", "deploy"]);
const ON_REQUEST_STEP_KEYS: ReadonlySet<string> = new Set(["workspace", "interface"]);

function stepLabelsFor(stages: BuildStageRow[], onRequest = false) {
  const keys = new Set(stages.map((stage) => STAGE_TO_STEP_KEY[stage.stage]).filter(Boolean));
  const always = onRequest ? ON_REQUEST_STEP_KEYS : ALWAYS_STEP_KEYS;
  return STEP_LABELS.filter(([key]) => always.has(key) || keys.has(key));
}

export const BUILD_EXPECTED_DURATION = "Publishing to your address continues in the background";
export function buildActivityNote(estimate: string | null, publishOnRequest = false): string {
  const body = publishOnRequest ? BUILD_EXPECTED_DURATION_ON_REQUEST : BUILD_EXPECTED_DURATION;
  return `${estimate ? `${estimate}. ` : ""}${body}. You can leave this page and come back.`;
}
export const PUBLISH_START_AGAIN =
  "This one can't be retried. Start a new build below to try again.";
export const BACKGROUND_PUBLISH_PLACEHOLDER = "You can ask for changes once publishing finishes…";
export const BUILDING_CHANGE_PLACEHOLDER = "Tell Zavi a change. It's made as soon as the build finishes…";
export const PUBLISH_CHANGES_BLOCKED =
  "You can ask for changes once your app is published.";

const DONE_STAGE = new Set(["done", "success", "succeeded", "skipped"]);
const ACTIVE_STAGE = new Set([
  "active",
  "building",
  "dispatched",
  "in_progress",
  "provisioning",
  "queued",
  "running",
]);
const FAILED_STAGE = new Set(["failed", "halted", "cancelled", "canceled"]);
export const RETRY_FALLBACK_CODES: ReadonlySet<string> = new Set(["not_paused", "not_resumable", "expired", "budget_spent", "not_found"]);

export type BuildRunView = {
  readyEarly: boolean;
  paused: boolean;
  failed: boolean;
  rootDone: boolean;
  building: boolean;
  publishBlocksChanges: boolean;
  publishFailed: boolean;
  activityStatus: "building" | "ready" | "failed";
};

export function deriveBuildRunView(
  hasRun: boolean,
  runStatus: string | null,
  appReady: boolean | undefined,
  publishStatus: string | undefined = "none",
): BuildRunView {
  const readyEarly = appReady === true && hasRun;
  const paused = runStatus === "paused" && !readyEarly;
  const failed = (FAILED_STAGE.has(runStatus ?? "") || runStatus === "paused") && !readyEarly;
  const rootDone = runStatus === "done";
  const building = hasRun && !failed && !rootDone;
  return {
    readyEarly,
    paused,
    failed,
    rootDone,
    building,
    publishBlocksChanges: readyEarly && !rootDone && publishStatus === "publishing",
    publishFailed: readyEarly && !rootDone && publishStatus === "failed",
    activityStatus: failed ? "failed" : rootDone || readyEarly ? "ready" : "building",
  };
}

export function builtAtEnd(
  stages: BuildStageRow[],
  appReadyAt: string | null | undefined,
  updatedAt: string | null,
  rootDone: boolean,
): string | null {
  const finished = stages.find((stage) => stage.stage === "build")?.finished_at;
  if (typeof finished === "string" && Number.isFinite(Date.parse(finished))) return finished;
  if (rootDone) return updatedAt;
  return appReadyAt ?? updatedAt;
}

export function deriveBuildSteps(
  stages: BuildStageRow[],
  runStatus: string | null,
  status: BuildStatus,
  publishOnRequest = false,
): BuildStep[] {
  const onRequest = buildPublishesOnRequest(stages, publishOnRequest);
  const labels = stepLabelsFor(stages, onRequest);
  if (status === "live" || runStatus === "done") {
    return labels.map(([key, label]) => ({ key, label, state: "done" }));
  }

  const failedRun = FAILED_STAGE.has(runStatus ?? "") || runStatus === "paused" || status === "failed";
  const failedStage = stages.find((stage) => FAILED_STAGE.has(stage.status));
  const activeStage = stages.find((stage) => ACTIVE_STAGE.has(stage.status));
  const unfinishedStage = stages.find((stage) => !DONE_STAGE.has(stage.status));
  const source = failedStage ?? activeStage ?? unfinishedStage;
  let current = source
    ? Math.max(
        0,
        labels.findIndex(([key]) => key === STAGE_TO_STEP_KEY[source.stage]),
      )
    : 0;

  if (
    !source &&
    stages.length > 0 &&
    stages.every((stage) => DONE_STAGE.has(stage.status))
  ) {
    if (onRequest && !failedRun && !labels.some(([key]) => key === "deploy")) {
      return labels.map(([key, label]) => ({ key, label, state: "done" }));
    }
    current = labels.length - 1;
  }

  const retrying = failedRun ? null : retryingStepLabel(stages);
  return labels.map(([key, label], index) => {
    let state: StepState = "pending";
    if (index < current) state = "done";
    if (index === current) state = failedRun ? "failed" : "active";
    return { key, label: state === "active" && retrying ? retrying : label, state };
  });
}

export function activityFooter(
  status: "building" | "ready" | "failed",
  paused: boolean,
  elapsed: number,
  crashed = false,
): string {
  const time = formatElapsed(elapsed);
  if (status === "ready") return `Built in ${time}`;
  if (status === "building") return `Working for ${time}`;
  if (paused) return `Paused after ${time}`;
  return crashed ? `Ran ${time} before failing` : `Ran ${time} before stopping`;
}

const STOPPED_FAILURE_CLASSES: ReadonlySet<string> = new Set(["user_cancelled", "stale_reaped"]);

export function isCrashedRun(status: string | null | undefined, failureClass: string | null | undefined): boolean {
  return status === "failed" && !STOPPED_FAILURE_CLASSES.has(failureClass ?? "");
}

export function canStopBuild(session: {
  loaded: boolean;
  isCurrent: boolean;
  retired: boolean;
  appReady?: boolean;
  run: { status: string } | null;
}): boolean {
  const run = session.run;
  if (!session.loaded || !run || !session.isCurrent || session.retired) return false;
  const view = deriveBuildRunView(true, run.status, session.appReady);
  return view.building && !view.readyEarly;
}

const RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const OBJECTIVE_STORED_MAX = 500;

const UNRETRYABLE_FAILURE_CLASSES: ReadonlySet<string> = new Set(["provision_failed", "coach_precedence"]);

export function canRetryFailedBuild(session: {
  loaded: boolean;
  isCurrent: boolean;
  retired: boolean;
  appReady?: boolean;
  run: {
    status: string;
    updatedAt?: string | null;
    failure: { class?: string | null; message?: string | null; stage?: string | null } | null;
  } | null;
}, now: number = Date.now()): boolean {
  const run = session.run;
  if (!session.loaded || !run || !session.isCurrent || session.retired) return false;
  if (session.appReady === true) return false;
  if (run.status !== "paused" && !isCrashedRun(run.status, run.failure?.class)) return false;
  if (UNRETRYABLE_FAILURE_CLASSES.has(run.failure?.class ?? "")) return false;
  if (run.failure?.stage === "provision") return false;
  if (run.status === "failed") {
    const failedAt = run.updatedAt ? Date.parse(run.updatedAt) : NaN;
    if (!Number.isFinite(failedAt) || now - failedAt > RETRY_WINDOW_MS) return false;
  }
  return !isOutOfCreditsBuild(run.failure);
}

export function stoppedByFounder(
  run: { status?: string | null; failure?: { class?: string | null } | null } | null | undefined,
): boolean {
  return run?.status === "failed" && run.failure?.class === "user_cancelled";
}

export function restartBrief(objective: string | null | undefined): string | null {
  if (!objective || objective.length >= OBJECTIVE_STORED_MAX) return null;
  return cleanObjective(objective);
}

export function canStartAgain(session: {
  loaded: boolean;
  isCurrent?: boolean;
  retired?: boolean;
  appReady?: boolean;
  liveUrl?: string | null;
  run: { status: string; failure: { class?: string | null } | null } | null;
}): boolean {
  return (
    session.loaded &&
    session.isCurrent !== false &&
    session.retired !== true &&
    session.appReady !== true &&
    !session.liveUrl &&
    stoppedByFounder(session.run)
  );
}

export function stoppedBuildLine(
  run: { status?: string | null; objective?: string | null; failure?: BuildFailureLike | null } | null | undefined,
  startAgainShown: boolean,
  opts: { startedWork?: boolean } = {},
): string | null {
  if (startAgainShown && stoppedByFounder(run) && restartBrief(run?.objective) !== null) return BUILD_STOPPED_BY_YOU_RESTART;
  return buildFailureLine(run?.failure, opts);
}

export function cleanObjective(value: string | null): string | null {
  if (!value) return null;
  let clean = value.trim();
  if (/^build product:/i.test(clean)) {
    clean = clean
      .replace(/^build product:\s*/i, "")
      .replace(/^[^—]{1,120}?\s*—\s*/, "");
  }
  clean = clean
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .trim();
  return clean || null;
}

export function buildProjectName(
  objective: string | null,
  tenantName: string | undefined,
): string {
  const source = cleanObjective(objective) ?? `${tenantName ?? "my"} app`;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 46)
    .replace(/-+$/g, "");
  return slug || "my-app";
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function buildLoadErrorCopy(message: string | null | undefined): string {
  const text = (message ?? "").trim();
  if (!text || /^(failed to fetch|network error)$/i.test(text)) {
    return "We couldn't load this build. Check your connection, then try again.";
  }
  return text;
}

export const TYPICAL_CHANGE_SAMPLES = 5;

export function typicalChangeSeconds(refines: readonly BuildRefine[]): number | null {
  const durations = refines
    .filter((r) => (r.kind ?? "change") === "change" && DONE_STAGE.has(r.status) && r.finished_at)
    .map((r) => (Date.parse(r.finished_at as string) - Date.parse(r.created_at)) / 1000)
    .filter((d) => Number.isFinite(d) && d > 0)
    .slice(-TYPICAL_CHANGE_SAMPLES)
    .sort((a, b) => a - b);
  if (durations.length < 2) return null;
  const mid = Math.floor(durations.length / 2);
  const median = durations.length % 2 ? durations[mid]! : (durations[mid - 1]! + durations[mid]!) / 2;
  return Math.round(median);
}

function roughDuration(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
}

export function changeProgressDetail(elapsed: number, typicalSeconds: number | null = null): string {
  const shown = `${formatElapsed(elapsed)} elapsed`;
  if (typicalSeconds === null) return shown;
  if (elapsed > typicalSeconds * 1.5 && elapsed - typicalSeconds >= 30) return `${shown} · Taking longer than your recent changes`;
  return `${shown} · Your recent changes took ${roughDuration(typicalSeconds)}`;
}

export function builtSiteUrl(session: { previewUrl: string | null; liveUrl: string | null; sitePublished?: boolean | null }): string | null {
  return safePreviewHref(session.sitePublished === false ? session.previewUrl : (session.liveUrl ?? session.previewUrl));
}

export function safePreviewHref(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function zaviAdminHref(
  value: string | null | undefined,
): string | null {
  const href = safePreviewHref(value);
  if (!href) return null;
  const url = new URL(href);
  url.searchParams.set("from", "zavi");
  return url.toString();
}

export function refinePreviewHref(
  refine: BuildRefine,
  sessionPreviewUrl: string | null,
  liveUrl: string | null,
): string | null {
  if (refine.awaiting_review === true) {
    return safePreviewHref(refine.preview_url);
  }
  return (
    safePreviewHref(liveUrl) ??
    safePreviewHref(sessionPreviewUrl) ??
    safePreviewHref(refine.preview_url)
  );
}

function useElapsed(
  createdAt: string | null,
  updatedAt: string | null,
  running: boolean,
): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const start = createdAt ? Date.parse(createdAt) : now;
  const parsedEnd = updatedAt ? Date.parse(updatedAt) : now;
  const end = running ? now : parsedEnd;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

function StepIcon({ state, breathing = false }: { state: StepState; breathing?: boolean }) {
  if (state === "done") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center">
        <Check className="size-4 text-ca-success motion-safe:animate-ca-rise" strokeWidth={2.5} aria-hidden />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center text-ca-danger">
        <AlertCircle className="size-4" strokeWidth={2.5} aria-hidden />
      </span>
    );
  }
  return (
    <span className="relative grid h-5 w-5 shrink-0 place-items-center">
      {state === "active" ? (
        <>
          {breathing && (
            <span data-breathing="halo" className="zavi-breathe-halo absolute inset-0 rounded-full bg-ca-action/25" aria-hidden />
          )}
          <span className="relative size-4 animate-spin rounded-full border-2 border-ca-border border-t-ca-action motion-reduce:animate-none" aria-hidden />
        </>
      ) : (
        <span className="size-1.5 rounded-full bg-ca-strong" aria-hidden />
      )}
    </span>
  );
}

const BUBBLE_FOLD_CHARS = 280;

function TurnDivider({
  prev,
  at,
  spacing,
}: {
  prev: string | null;
  at: string | null;
  spacing?: string;
}) {
  if (!at || !shouldShowTimeStamp(prev ?? undefined, at)) return null;
  return <DayDivider iso={at} withTime spacing={spacing} />;
}

export { START_SITE_ROLE_ERROR, START_SITE_VIEWER_ERROR, canStartNewSite } from "@/lib/workspace/buildRoles";

function UserBubble({ text, picked = null }: { text: string; picked?: RefinePickedElement | null }) {
  const { body, files } = splitFileRefs(text);
  const [expanded, setExpanded] = useState(false);
  const long = body.length > BUBBLE_FOLD_CHARS;
  const shown =
    long && !expanded ? `${body.slice(0, BUBBLE_FOLD_CHARS).trimEnd()}…` : body;
  const hasCopy = text.trim().length > 0;
  return (
    <div
      data-testid="build-user-bubble"
      className="flex flex-col items-end gap-2"
    >
      <FileRefChips
        files={files}
        align="end"
        variant="thumb"
        className="max-w-[82%]"
      />
      {picked && <PickedElementChip pick={picked} className="max-w-[82%]" />}
      {body && (
        <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-[20px] bg-bone px-4 py-[9px] text-[16px] font-medium leading-[25px] text-ink">
          {shown}
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className={cx(
                "ml-1.5 inline text-[13px] font-medium text-inkMuted underline-offset-2 hover:text-ink hover:underline",
                FOCUS_RING,
              )}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
      {hasCopy && (
        <div className="-mt-0.5 flex items-center justify-end gap-0.5">
          <CopyMessageButton text={text} />
        </div>
      )}
    </div>
  );
}

function PausedNotice({
  stepLabel,
  outOfCredits,
  continuing,
  onContinue,
  error,
}: {
  stepLabel: string | null;
  outOfCredits: boolean;
  continuing: boolean;
  onContinue: () => void;
  error: string | null;
}) {
  return (
    <div className="rounded-[16px] border border-rule bg-creamDeep/55 px-4 py-3.5">
      {outOfCredits ? (
        <CreditRefusalNotice refusal={BUILD_PAUSED_REFUSAL} />
      ) : (
        <p className="text-[13px] leading-5 text-ink">
          {stepLabel
            ? `Your build paused at ${stepLabel}.`
            : "Your build paused."}{" "}
          Everything before it is saved. Continue to try this step again.
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onContinue}
          disabled={continuing}
          className={cx(
            "rounded-cta bg-ink px-3 py-1.5 text-[12px] font-semibold text-cream hover:bg-ink/90 disabled:opacity-50",
            FOCUS_RING,
          )}
        >
          {continuing ? "Continuing…" : "Continue build"}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-[12px] leading-5 text-danger">{error}</p>
      )}
    </div>
  );
}

function BuildActivity({
  steps,
  stages = [],
  status,
  error,
  elapsed,
  stopping,
  canStop,
  onStop,
  paused = false,
  crashed = false,
  replaced = false,
  retired = false,
  publishRow = null,
  className,
  publishOnRequest = false,
  publishStopped = false,
  designRunId = null,
}: {
  designRunId?: string | null;
  publishStopped?: boolean;
  steps: BuildStep[];
  stages?: BuildStageRow[];
  publishRow?: ReactNode;
  publishOnRequest?: boolean;
  status: "building" | "ready" | "failed";
  paused?: boolean;
  crashed?: boolean;
  replaced?: boolean;
  retired?: boolean;
  error: string | null;
  elapsed: number;
  stopping: boolean;
  canStop: boolean;
  onStop: () => void;
  className?: string;
}) {
  const pickDesign = useSharedSiteDesign(designRunId);
  const awaitingPick = designAwaitsPick(pickDesign) && status === "building";
  const nowMs = useProgressClock(status === "building");
  const estimate = status === "building"
    ? buildEstimateText(stages, nowMs, { awaitingPick })
    : null;
  const shownSteps = awaitingPick ? steps.map((step) => (step.state === "active" ? { ...step, state: "pending" as const } : step)) : steps;
  const breathing = status === "building" && !paused && !crashed;
  const doneCount = shownSteps.filter((step) => step.state === "done").length;
  const progress = shownSteps.length === 0 ? 0 : Math.round(4 + 92 * (doneCount + (breathing && !awaitingPick ? 0.5 : 0)) / shownSteps.length);
  const badge = status === "ready"
    ? { label: publishStopped ? "Publish stopped" : "Ready", dot: publishStopped ? "bg-ca-danger" : "bg-ca-success", pulse: false }
    : status === "failed"
      ? { label: paused ? "Paused" : crashed ? "Failed" : "Stopped", dot: crashed && !paused ? "bg-ca-danger" : "bg-ca-strong", pulse: false }
      : awaitingPick
        ? { label: "Waiting for you", dot: "bg-khaki", pulse: false }
        : { label: "Building", dot: "bg-ca-success", pulse: true };
  return (
    <div
      data-testid="build-card"
      className={cx(
        "rounded-2xl border border-ca-border bg-ca-bg px-4 py-4 shadow-ca-sm sm:px-5",
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <span data-testid="build-card-title" className="min-w-0 text-ca-label font-semibold tracking-tight text-ca-xdark">
          {status === "failed"
            ? paused
              ? "Build paused"
              : crashed
                ? "Build failed"
                : "Build stopped"
            : status === "ready"
              ? "Your app is ready"
              : "Building your app"}
        </span>
        <span
          data-testid="build-card-badge"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ca-subtle px-2.5 py-0.5 text-[12px] font-medium leading-5 text-ca-xdark"
        >
          {status === "ready" && !publishStopped ? (
            <Check className="size-3 text-ca-success" strokeWidth={3} aria-hidden />
          ) : status === "failed" && crashed && !paused ? (
            <XCircle className="size-3 text-ca-danger" strokeWidth={2.5} aria-hidden />
          ) : status === "failed" ? (
            <Square className="size-2 fill-current text-ca-secondary" aria-hidden />
          ) : (
            <span aria-hidden className={cx("size-1.5 rounded-full", badge.dot, badge.pulse && "motion-safe:animate-pulse")} />
          )}
          {badge.label}
        </span>
        <span className="flex-1" />
        {replaced && (
          <span className="rounded-full bg-ca-subtle px-2 py-0.5 text-[12px] font-medium text-ca-secondary">
            {retired ? "Retired" : "Replaced"}
          </span>
        )}
        {canStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className={cx(
              "inline-flex h-8 items-center rounded-cta border border-ca-border bg-ca-bg px-3 text-[13px] font-medium text-ca-xdark transition-colors hover:bg-ca-subtle disabled:opacity-50",
              FOCUS_RING,
            )}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>
      {status === "building" && (
        <p className="mt-1 text-[13px] leading-5 text-ca-secondary">
          {buildActivityNote(estimate, publishOnRequest)}
        </p>
      )}
      {status === "building" && !paused && (
        <div
          data-testid="build-card-progress"
          aria-hidden
          className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-ca-subtle"
        >
          <div
            className="h-full rounded-full bg-ca-action transition-[width] duration-700 ease-ca-standard motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      <div className="mt-3.5 flex flex-col gap-2.5">
        {shownSteps.map((step) => (
          <div key={step.key} data-step={step.state} className="flex items-center gap-3">
            <StepIcon state={step.state} breathing={breathing} />
            <span
              data-breathing={step.state === "active" && breathing ? "label" : undefined}
              className={cx(
                "text-[14px] leading-5 transition-colors duration-300",
                step.state === "pending" && "text-ca-secondary/60",
                step.state === "active" && "font-semibold text-ca-xdark",
                step.state === "active" && breathing && "zavi-breathe",
                step.state === "done" && "text-ca-secondary",
                step.state === "failed" && "font-medium text-ca-danger",
              )}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>
      {publishRow}
      {error && (
        <div className="mt-3 rounded-xl border border-danger/20 bg-dangerBg px-3 py-2 text-[13px] leading-5 text-danger">
          {error}
        </div>
      )}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-ca-border pt-3 text-[12px] leading-4 text-ca-secondary">
        <span>{activityFooter(status, paused, elapsed, crashed)}</span>
      </div>
    </div>
  );
}

function PublishRow({
  publish,
  onRetry,
  retrying,
  error,
  retryHint = PUBLISH_START_AGAIN,
  adminUrl = null,
  adminSetupEmail = null,
  sessionId = null,
  previewReady = true,
}: {
  previewReady?: boolean;
  publish: BuildPublish;
  onRetry?: () => void;
  retrying: boolean;
  error: string | null;
  retryHint?: string;
  adminUrl?: string | null;
  adminSetupEmail?: string | null;
  sessionId?: string | null;
}) {
  const publishing = publish.status === "publishing";
  const elapsed = useElapsed(publish.startedAt, null, publishing);
  const liveHref = safePreviewHref(publish.url);
  const adminHref = liveHref ? zaviAdminHref(adminUrl) : null;
  const checkLine = publishCheckLine(publish);
  if (publishing) {
    return (
      <div
        data-testid="build-publish-row"
        role="status"
        className="mt-3 flex items-start gap-2.5 rounded-xl border border-ca-border bg-ca-subtle px-3 py-2.5 text-[13px] leading-5 text-ca-xdark"
      >
        <Loader2
          className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-ink motion-reduce:animate-none"
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          {publish.fixing
            ? PUBLISH_CHECK_FIXING
            : publish.waiting
              ? publish.reason ?? SITE_DATABASE_WAITING
              : "Publishing to your address…"}
          {previewReady && " You can use the preview now."}
          {publish.startedAt && (
            <span className="ml-1.5 tabular-nums text-inkMuted">
              {formatElapsed(elapsed)}
            </span>
          )}
          {publish.fixing && publish.reason && (
            <span data-testid="build-publish-reason" className="mt-0.5 block text-[13px] text-inkMuted">
              {publish.reason}
            </span>
          )}
        </span>
      </div>
    );
  }
  if (publish.status === "live" && liveHref) {
    return (
      <div
        data-testid="build-publish-row"
        className="mt-3 rounded-xl border border-ca-border bg-ca-subtle px-3 py-2.5 text-[13px] leading-5 text-ca-xdark"
      >
        <div className="flex items-center gap-2.5">
          <Globe2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            Live at{" "}
            <a
              href={liveHref}
              target="_blank"
              rel="noopener noreferrer"
              className={cx("font-medium text-ink underline underline-offset-2 hover:text-inkSoft", FOCUS_RING)}
            >
              {publish.url}
            </a>
          </span>
        </div>
        {adminHref && (
          <div className="mt-2 pl-6">
            <OpenAdminLink href={adminHref} />
            <AdminLoginHint adminHref={adminHref} adminSetupEmail={adminSetupEmail} sessionId={sessionId} />
          </div>
        )}
      </div>
    );
  }
  if (publish.status === "failed") {
    return (
      <div
        data-testid="build-publish-row"
        className="mt-3 rounded-xl border border-danger/20 bg-dangerBg px-3 py-2.5"
      >
        <div className="flex items-center gap-2.5">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />
          <span className="flex-1 text-[13px] font-medium leading-5 text-danger">
            {checkLine ?? "Publishing didn't finish"}
          </span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className={cx(
                "inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-rule bg-cream px-3 text-[13px] font-medium text-ink transition-colors hover:bg-bone disabled:opacity-60",
                FOCUS_RING,
              )}
            >
              {retrying ? (
                <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <RotateCw className="h-3 w-3" aria-hidden />
              )}
              Retry publish
            </button>
          )}
        </div>
        {publish.reason && (
          <p data-testid="build-publish-reason" className="mt-1 pl-6 text-[13px] leading-5 text-inkMuted">
            {publish.reason}
          </p>
        )}
        {!onRetry && (
          <p className="mt-1 pl-6 text-[13px] leading-5 text-inkMuted">
            {retryHint}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-1 pl-6 text-[13px] leading-5 text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }
  return null;
}

function PreviewCard({
  target,
  onOpen,
}: {
  target: BuildPreviewTarget;
  onOpen: () => void;
}) {
  const readiness = useAppReadiness(target.url);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <div className="group w-full overflow-hidden rounded-2xl border border-rule bg-cream p-1.5 transition-colors hover:border-ink/25">
      <div className="flex h-9 items-center gap-2 px-2">
        <Globe2 className="h-3.5 w-3.5 shrink-0 text-inkLight" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {target.appName}
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className={cx(
            "inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold text-inkSoft transition-colors hover:bg-bone hover:text-ink",
            FOCUS_RING,
          )}
        >
          Open
          <ExternalLink className="h-3 w-3" aria-hidden />
        </button>
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={onKeyDown}
        aria-label={`Open ${target.appName} preview`}
        className={cx(
          "relative h-[230px] overflow-hidden rounded-xl border border-rule bg-cream",
          FOCUS_RING,
        )}
      >
        {readiness.state === "ready" ? (
          <iframe
            src={target.url}
            title={`${target.appName} thumbnail`}
            tabIndex={-1}
            className="pointer-events-none h-full w-full border-0 bg-cream"
            sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <Skeleton className="h-full w-full" rounded="rounded-none" />
        )}
        <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-ink/[0.03]" />
      </div>
    </div>
  );
}

function refineState(status: string): "building" | "ready" | "failed" {
  if (DONE_STAGE.has(status)) return "ready";
  if (FAILED_STAGE.has(status)) return "failed";
  return "building";
}

const FAILURE_FALLBACK =
  "Something went wrong while making this change. Nothing on your app was affected.";

export function friendlyFailure(message: string | null | undefined): string {
  const text = (message ?? "").trim();
  if (!text || text.length > 180 || /[#`*\n]|\]\(|https?:\/\//.test(text))
    return FAILURE_FALLBACK;
  return text;
}

export const CHANGE_TITLE = "Changing your site";

export const CHANGE_TIP_MS = 6000;

export function changeWaitTips(previewOnly: boolean): readonly string[] {
  return [
    previewOnly
      ? "Nothing changes at your site's address until you press Publish."
      : "It goes live on its own once it's ready.",
    "Your preview refreshes by itself when the change is ready.",
    "Bigger changes, like a new page, can take a few minutes.",
    "You can keep looking around the preview while you wait.",
    "Tip: one change per message gets the fastest result.",
  ];
}

function ChangeWait({ tips }: { tips: readonly string[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % tips.length), CHANGE_TIP_MS);
    return () => window.clearInterval(timer);
  }, [tips.length]);
  const tip = tips[index % tips.length];
  return (
    <div className="mt-2.5">
      <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-ink/10">
        <span
          data-testid="change-working"
          className="block h-full w-1/3 rounded-full bg-ink/55 motion-safe:animate-indeterminate-bar motion-reduce:w-full motion-reduce:opacity-40"
        />
      </span>
      <p
        key={tip}
        data-testid="change-tip"
        className="mt-2 text-[12px] leading-4 text-ink/55 animate-pane-fade motion-reduce:animate-none"
      >
        {tip}
      </p>
    </div>
  );
}

export function builtButNeverPublished(
  publishOnRequest: boolean,
  runStatus: string | null,
  liveUrl: string | null,
  publishStatus: string | undefined,
): boolean {
  return publishOnRequest && runStatus === "done" && !liveUrl && publishStatus !== "live";
}

function useRefineUndo(sessionId: string | null, previewOnly = false) {
  const busyRef = useRef(false);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undone, setUndone] = useState<ReadonlySet<string>>(() => new Set());
  const [undoError, setUndoError] = useState<{ id: string; message: string } | null>(null);
  const [undoNotice, setUndoNotice] = useState<{ id: string; message: string } | null>(null);
  const undo = async (refine: BuildRefine) => {
    if (busyRef.current || !sessionId) return;
    busyRef.current = true;
    try {
      const confirmed = await confirmAction({
        title: "Undo this change?",
        description: previewOnly
          ? UNDO_PREVIEW_ONLY_CONFIRM
          : "Your site goes back to how it was before this change, and the live site updates in a minute or two.",
        confirmLabel: "Undo change",
        cancelLabel: "Keep it",
      });
      if (!confirmed) return;
      setUndoing(refine.id);
      setUndoError(null);
      setUndoNotice(null);
      const outcome = await undoBuildRefine(sessionId, refine.id);
      if (outcome.error) setUndoError({ id: refine.id, message: outcome.error });
      else {
        setUndone((prev) => new Set(prev).add(refine.id));
        if (outcome.notice) setUndoNotice({ id: refine.id, message: outcome.notice });
      }
    } finally {
      busyRef.current = false;
      setUndoing(null);
    }
  };
  const propsFor = (refine: BuildRefine) => {
    const notice = undoNotice?.id === refine.id ? { undoNotice: undoNotice.message } : {};
    return refine.undoable === true && !undone.has(refine.id)
      ? {
          onUndo: () => void undo(refine),
          undoing: undoing === refine.id,
          undoError: undoError?.id === refine.id ? undoError.message : null,
          ...notice,
        }
      : notice;
  };
  return propsFor;
}

const LIVE_ANNOUNCED_KEY_PREFIX = "zavi.build.liveAnnounced.";

function liveAnnouncedInBrowser(buildId: string): boolean {
  try {
    return window.localStorage.getItem(`${LIVE_ANNOUNCED_KEY_PREFIX}${buildId}`) === "1";
  } catch {
    return false;
  }
}

function markLiveAnnouncedInBrowser(buildId: string): void {
  try {
    window.localStorage.setItem(`${LIVE_ANNOUNCED_KEY_PREFIX}${buildId}`, "1");
  } catch {
    return;
  }
}

export const NO_CHANGE_DETAIL = "That already says what you asked for, nothing to change.";
export const NEEDS_INPUT_TITLE = "A question for you";
export const NEEDS_INPUT_FALLBACK = "I need a bit more detail to make this change.";
export const NEEDS_INPUT_HINT = "Reply in the chat and I'll make the change.";
export const REFUSED_TITLE = "This change didn't happen";
export const REFUSED_FALLBACK = "Nothing on your site was changed.";

export const SAVING_EDITS_TEXT = "Updating your site…";
export const SAVED_EDITS_TEXT = "Ready in your preview";
export const SAVE_FAILED_TEXT = "This change didn't finish";

function SavingEditsTurn({ refine, className }: { refine: BuildRefine; className?: string }) {
  const failed = refine.status === "failed";
  const saved = refine.status === "saved";
  return (
    <div data-testid="saving-edits" data-state={failed ? "failed" : saved ? "saved" : "saving"} className={cx("space-y-3", className)}>
      <UserBubble text={askedText(refine.message)} picked={refine.selected_element ?? null} />
      <div data-testid="saving-edits-reply" className="flex items-start gap-2.5">
        <div className="mt-2 shrink-0">
          <BuildMascotAvatar />
        </div>
        <div
          role={failed ? "alert" : "status"}
          className={cx("min-w-0 flex-1 rounded-2xl px-3.5 py-2.5", failed ? "bg-dangerBg" : "bg-creamDeep/50")}
        >
          <div className="flex items-center gap-2.5">
            {failed || saved ? (
              <StepIcon state={failed ? "failed" : "done"} />
            ) : (
              <span className="grid h-[18px] w-[18px] shrink-0 place-items-center text-inkMuted">
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              </span>
            )}
            <span className="flex-1 text-[14px] font-medium leading-5 text-ink">
              {failed ? SAVE_FAILED_TEXT : saved ? SAVED_EDITS_TEXT : SAVING_EDITS_TEXT}
            </span>
          </div>
          {failed && refine.failure_message && (
            <p className="mt-1 pl-[28px] text-[13px] leading-5 text-inkMuted">{refine.failure_message}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function RefineTurn({
  refine,
  previewOnly = false,
  previewUrl = null,
  onRetry,
  retrying = false,
  retryError = null,
  onUndo,
  undoing = false,
  undoError = null,
  undoNotice = null,
  stopsAtPreview = false,
  siteNeverPublished = false,
  typicalSeconds = null,
  askShownInThread = false,
  className,
}: {
  refine: BuildRefine;
  typicalSeconds?: number | null;
  askShownInThread?: boolean;
  previewOnly?: boolean;
  previewUrl?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  retryError?: string | null;
  onUndo?: () => void;
  undoing?: boolean;
  undoError?: string | null;
  undoNotice?: string | null;
  stopsAtPreview?: boolean;
  siteNeverPublished?: boolean;
  className?: string;
}) {
  const state = refineState(refine.status);
  const declared = state === "ready" ? (refine.declared_outcome ?? (refine.no_change === true ? "no_change" : null)) : null;
  const answered = declared !== null;
  const declaredMessage = refine.declared_message?.trim() || null;
  const parked = state === "ready" && !answered && refine.awaiting_review === true;
  const discarded = state === "ready" && refine.discarded === true;
  const inDraft = state === "ready" && !answered && !parked && !discarded && (refine.draft === true || siteNeverPublished);
  const answerHint = declared === "needs_input" ? NEEDS_INPUT_HINT : null;
  const title = declared === "no_change"
    ? "Nothing to change"
    : declared === "needs_input"
    ? NEEDS_INPUT_TITLE
    : declared === "refused"
    ? REFUSED_TITLE
    : discarded
    ? "Discarded"
    : parked
    ? "Saved, not live yet"
    : inDraft
      ? "Ready in your preview"
    : state === "ready"
      ? "Live on your app"
      : state === "failed"
        ? "This change didn't finish"
        : "Update in progress";
  const pendingHint = parked
    ? "Your change is built and saved. It isn't on the live preview yet."
    : inDraft
      ? siteNeverPublished
        ? "Press Publish to put your site on its address."
        : "Press Publish to put it on your live app."
      : null;
  const pendingSummary = pendingHint && refine.summary?.trim() ? refine.summary : null;
  const changeSummary = state === "ready" && !answered && !discarded && refine.summary?.trim() ? refine.summary.trim() : null;
  const detail = declared === "no_change"
    ? NO_CHANGE_DETAIL
    : declared === "needs_input"
    ? (declaredMessage ?? NEEDS_INPUT_FALLBACK)
    : declared === "refused"
    ? (declaredMessage ?? REFUSED_FALLBACK)
    : discarded
    ? "This draft change was discarded and is not live."
    : pendingHint
      ? pendingHint
    : state === "failed"
      ? (changeFailureCopy(refine.failure_message) ?? friendlyFailure(refine.failure_message))
      : changeSummary
      ? null
      : (refine.summary ?? null);
  const copyText =
    state === "building"
      ? null
      : state === "ready" && !answered && !parked && !inDraft && !discarded && refine.summary?.trim()
        ? refine.summary
        : [title, pendingSummary ?? detail, pendingSummary ? pendingHint : null, answerHint]
            .filter((part): part is string => !!part && part.trim().length > 0)
            .join("\n");
  const elapsed = useElapsed(
    refine.created_at,
    state === "building"
      ? null
      : (refine.finished_at ?? refine.updated_at ?? refine.created_at),
    state === "building",
  );
  const livePanel = refine.panel ?? buildRunPanel([], { state: "running" });
  return (
    <div className={cx("space-y-3", className)}>
      {!askShownInThread && <UserBubble text={askedText(refine.message)} picked={refine.selected_element ?? null} />}
      <div data-testid="build-reply">
        <div className="flex items-start gap-2.5">
          <div className="mt-2 shrink-0">
            <BuildMascotAvatar />
          </div>
          {state === "building" ? (
            <div className="min-w-0 flex-1">
              <div
                data-testid="change-progress"
                className="my-1.5 rounded-2xl border border-rule bg-creamDeep/35 px-3.5 py-3 animate-mode-switch motion-reduce:animate-none"
              >
                <p className="text-[14px] font-semibold leading-5 text-ink">{CHANGE_TITLE}</p>
                <p className="text-[12px] leading-4 text-ink/45">{changeProgressDetail(elapsed, typicalSeconds)}</p>
                <ChangeWait tips={changeWaitTips(previewOnly || stopsAtPreview)} />
                <div className="mt-2 border-t border-rule/70 pt-1">
                  <RunPanel
                    model={{ ...livePanel, state: "running" }}
                    agentSlug="operator"
                    workingAriaLabel="Update in progress"
                  />
                </div>
              </div>
              {detail && (
                <p className="text-[13px] leading-5 text-inkMuted">
                  {detail}
                </p>
              )}
              {retryError && (
                <p role="alert" className="text-[13px] leading-5 text-danger">
                  {retryError}
                </p>
              )}
            </div>
          ) : (
            <div
              className={cx(
                "min-w-0 flex-1 rounded-2xl px-3.5 py-2.5",
                state === "failed" ? "bg-dangerBg" : "bg-creamDeep/50",
              )}
            >
              <div className="flex items-center gap-2.5">
                {parked ? (
                  <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-bone text-inkMuted">
                    <Clock className="h-3 w-3" strokeWidth={2.5} aria-hidden />
                  </span>
                ) : (
                  <StepIcon state={state === "ready" ? "done" : "failed"} />
                )}
                <span className="flex-1 text-[14px] font-medium leading-5 text-ink">
                  {title}
                </span>
                {state === "failed" && onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    disabled={retrying}
                    className={cx(
                      "inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-rule bg-cream px-3 text-[13px] font-medium text-ink transition-colors hover:bg-bone disabled:opacity-60",
                      FOCUS_RING,
                    )}
                  >
                    {retrying ? (
                      <Loader2
                        className="h-3 w-3 animate-spin motion-reduce:animate-none"
                        aria-hidden
                      />
                    ) : (
                      <RotateCw className="h-3 w-3" aria-hidden />
                    )}
                    {retrying ? "Retrying…" : "Try again"}
                  </button>
                )}
              </div>
              {detail && (
                <p className="mt-1 pl-[28px] text-[13px] leading-5 text-inkMuted">
                  {detail}
                </p>
              )}
              {answerHint && (
                <p data-testid="change-reply-hint" className="pl-[28px] text-[13px] leading-5 text-inkMuted">
                  {answerHint}
                </p>
              )}
              {changeSummary && (
                <details data-testid="change-summary" className="group mt-1 pl-[28px]">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-[12px] font-medium text-inkMuted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
                    What changed
                    <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden />
                  </summary>
                  <p className="mt-1 text-[13px] leading-5 text-inkMuted">{changeSummary}</p>
                </details>
              )}
              {retryError && (
                <p
                  role="alert"
                  className="mt-1 pl-[28px] text-[13px] leading-5 text-danger"
                >
                  {retryError}
                </p>
              )}
            </div>
          )}
        </div>
        {copyText !== null && (
          <div className="mt-1 flex flex-wrap items-center gap-0.5 pl-[34px]">
            <CopyMessageButton text={copyText} />
            <RunMetaMenu
              runIds={[refine.id]}
              elapsedSeconds={elapsed}
              previewHref={
                state === "ready" ? safePreviewHref(previewUrl) : null
              }
            />
            {state === "ready" && !parked && onUndo && (
              <button
                type="button"
                onClick={onUndo}
                disabled={undoing}
                data-testid="refine-undo"
                aria-label={undoing ? "Undoing…" : "Undo this change"}
                title={undoing ? "Undoing…" : "Undo this change"}
                className={cx(MESSAGE_ACTION_BUTTON, "text-inkMuted disabled:opacity-60", FOCUS_RING)}
              >
                {undoing ? (
                  <Loader2 {...MESSAGE_ACTION_ICON} className="animate-spin motion-reduce:animate-none" aria-hidden />
                ) : (
                  <RotateCcw {...MESSAGE_ACTION_ICON} aria-hidden />
                )}
              </button>
            )}
            {(state === "ready" || state === "failed") && refine.kind !== "undo" && refine.kind !== "restore" && (
              <BuildRating runId={refine.id} label="change" />
            )}
          </div>
        )}
        {undoError && undoError === OLD_SITE_FROZEN_FALLBACK ? (
          <OldSiteFrozenNotice message={undoError} className="mt-1" />
        ) : undoError ? (
          <p role="alert" className="mt-1 pl-[34px] text-[13px] leading-5 text-danger">
            {undoError}
          </p>
        ) : null}
        {undoNotice && isPlainUndoNotice(undoNotice) ? (
          <p role="status" data-testid="refine-undo-notice" className="mt-1 pl-[34px] text-[13px] leading-5 text-inkMuted">
            {undoNotice}
          </p>
        ) : undoNotice ? (
          <p role="alert" data-testid="refine-undo-notice" className="mt-1 pl-[34px] text-[13px] leading-5 text-danger">
            {undoNotice}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function BuildReplyRow({
  children,
  footer,
  className,
}: {
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div data-testid="build-root-reply" className={className}>
      <div className="flex items-start gap-2.5">
        <div className="mt-2 shrink-0">
          <BuildMascotAvatar />
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {footer && (
        <div className="mt-1 flex flex-wrap items-center gap-0.5 pl-[34px]">{footer}</div>
      )}
    </div>
  );
}

type AdminLinkState = "idle" | "sending" | "sent" | "too_soon" | "failed";

function OpenAdminLink({ href }: { href: string }) {
  return (
    <a
      data-testid="build-open-admin"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cx(
        "inline-flex items-center gap-2 rounded-lg border border-rule bg-cream px-2.5 py-1 text-[13px] font-medium text-ink hover:bg-creamDeep",
        FOCUS_RING,
      )}
    >
      <ExternalLink className="h-3 w-3" aria-hidden />
      Open admin
    </a>
  );
}

function AdminLoginHint({
  adminHref,
  adminSetupEmail,
  sessionId,
}: {
  adminHref: string;
  adminSetupEmail: string | null;
  sessionId: string | null;
}) {
  return (
    <div className="mt-2.5 border-t border-rule/70 pt-2">
      <p data-testid="build-admin-login" className="text-[12px] leading-4 text-ink/55">
        Log in to your admin at <span className="break-all font-medium text-ink">{adminHref}</span>.
        {adminSetupEmail ? ` We emailed a one-click login link to ${adminSetupEmail}.` : ""}
        {" Your Zavi password does not work there. Sign in with an email link first."}
      </p>
      {adminSetupEmail && <AdminLinkResend email={adminSetupEmail} sessionId={sessionId} />}
    </div>
  );
}

function AdminLinkResend({ email, sessionId = null }: { email: string; sessionId?: string | null }) {
  const [state, setState] = useState<AdminLinkState>("idle");
  const send = async () => {
    setState("sending");
    try {
      const res = await apiFetch("/api/workspace/autopilot/build-admin-link", {
        method: "POST",
        body: sessionId ? JSON.stringify({ conductor_run_id: sessionId }) : "{}",
        retryOnNetworkError: false,
      });
      setState(res.ok ? "sent" : res.status === 429 ? "too_soon" : "failed");
    } catch {
      setState("failed");
    }
  };
  return (
    <div data-testid="build-admin-link-resend" className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] leading-5">
      <button
        type="button"
        onClick={send}
        disabled={state === "sending"}
        className={cx(
          "inline-flex items-center rounded-cta border border-rule bg-cream px-2.5 py-1 font-medium text-ink hover:bg-creamDeep disabled:opacity-60",
          FOCUS_RING,
        )}
      >
        {state === "sending" ? "Sending..." : "Email me a new login link"}
      </button>
      <span role="status" aria-live="polite" className={state === "failed" ? "text-danger" : "text-inkMuted"}>
        {state === "sent"
          ? `Sent. Check ${email} for a new one-click login link.`
          : state === "too_soon"
            ? "A link was sent in the last few minutes. Check your inbox."
            : state === "failed"
              ? "Couldn't send a new link. Try again in a few minutes."
              : ""}
      </span>
    </div>
  );
}

export const PHOTOS_RETRY_FREE = "Retry";
export const PHOTOS_RETRY_PAID = "Retry (uses credits)";

export const PHOTOS_RETRY_WAIT = "Wait for your current change to finish.";

function PhotosMissingNotice({
  photos,
  disabled,
  onRetry,
  waitNote = false,
}: {
  photos: BuildPhotosMissing;
  disabled: boolean;
  onRetry: () => Promise<unknown>;
  waitNote?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      data-testid="build-photos-missing"
      role="status"
      className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-cream px-3 py-2 text-[13px] leading-5 text-ink"
    >
      <span className="min-w-0 flex-1">{photos.reason}</span>
      <button
        type="button"
        data-testid="build-photos-retry"
        disabled={disabled || busy}
        onClick={() => {
          setBusy(true);
          void onRetry().finally(() => setBusy(false));
        }}
        className={cx(
          "inline-flex shrink-0 items-center gap-1.5 rounded-cta border border-rule bg-white px-2.5 py-1 text-[13px] font-medium text-ink hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-60",
          FOCUS_RING,
        )}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RotateCw className="h-3 w-3" aria-hidden />}
        {photos.retry === "paid" ? PHOTOS_RETRY_PAID : PHOTOS_RETRY_FREE}
      </button>
      {waitNote && (
        <span data-testid="build-photos-retry-wait" className="basis-full text-[12px] leading-4 text-inkMuted">
          {PHOTOS_RETRY_WAIT}
        </span>
      )}
    </div>
  );
}

function BuildDoneSummary({
  steps,
  adminUrl = null,
  adminSetupEmail = null,
  siteOffline = false,
  liveUrl = null,
  sessionId = null,
  publish = null,
  publishOnRequest = false,
}: {
  steps: BuildStep[];
  publishOnRequest?: boolean;
  adminUrl?: string | null;
  adminSetupEmail?: string | null;
  siteOffline?: boolean;
  liveUrl?: string | null;
  sessionId?: string | null;
  publish?: BuildPublish | null;
}) {
  const [open, setOpen] = useState(false);
  const adminHref = zaviAdminHref(adminUrl);
  const liveHref = safePreviewHref(liveUrl);
  const checkLine = publishCheckLine(publish);
  const publishFailed = !liveHref && publish?.status === "failed";
  const publishing = !liveHref && !publishFailed && publish?.status === "publishing";
  return (
    <div data-testid="build-done-card" className="rounded-2xl border border-ca-border bg-ca-bg px-4 py-3.5 shadow-ca-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cx(
          "flex w-full items-center gap-2.5 text-left",
          FOCUS_RING,
        )}
      >
        <span
          data-testid="build-done-icon"
          data-state={publishFailed ? "stopped" : "done"}
          className={cx(
            "grid h-5 w-5 shrink-0 place-items-center rounded-full",
            publishFailed ? "bg-ca-subtle text-ca-danger" : "bg-ca-success-bg text-ca-success",
          )}
        >
          {publishFailed ? (
            <AlertCircle className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
          ) : (
            <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
          )}
        </span>
        <span className="min-w-0 text-ca-label font-semibold tracking-tight text-ca-xdark">
          {liveHref ? "Your site is live" : "Your app is ready"}
        </span>
        <span
          data-testid="build-done-badge"
          data-state={liveHref ? "live" : publishFailed ? "stopped" : publishing ? "publishing" : "ready"}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ca-subtle px-2.5 py-0.5 text-[12px] font-medium leading-5 text-ca-xdark"
        >
          {publishing ? (
            <Loader2 className="size-3 animate-spin text-ca-action motion-reduce:animate-none" strokeWidth={2.5} aria-hidden />
          ) : (
            <span
              aria-hidden
              className={cx(
                "size-1.5 rounded-full",
                publishFailed ? "bg-ca-danger" : "bg-ca-success",
                liveHref && "ring-[3px] ring-ca-success/25",
              )}
            />
          )}
          {liveHref ? "Live" : publishFailed ? "Publish stopped" : publishing ? "Publishing" : "Ready"}
        </span>
        <span className="flex-1" />
        <ChevronDown
          className={cx(
            "h-4 w-4 shrink-0 text-ca-secondary transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {siteOffline && (
        <p
          data-testid="build-site-offline"
          className="mt-2 pl-[30px] text-[13px] leading-5 text-danger"
        >
          Your site is offline. Its hosting is suspended, so visitors see an error page.
        </p>
      )}
      {publishOnRequest && !liveHref && publish?.status === "none" && (
        <p data-testid="build-publish-on-request" className="mt-2 pl-[30px] text-[13px] leading-5 text-ca-secondary">
          {BUILD_READY_UNPUBLISHED}
        </p>
      )}
      {!liveHref &&
        publish &&
        (publish.status === "failed" || publish.fixing || publish.waiting || (publishOnRequest && publish.status === "publishing")) && (
        <p
          data-testid="build-publish-state"
          role={publish.status === "failed" ? "alert" : "status"}
          className={cx(
            "mt-2 pl-[30px] text-[13px] leading-5",
            publish.status === "failed" ? "text-danger" : "text-inkMuted",
          )}
        >
          {checkLine ??
            (publish.status === "failed"
              ? "Publishing to your address didn't finish."
              : publish.waiting
                ? (publish.reason ?? SITE_DATABASE_WAITING)
                : "Publishing to your address…")}
          {publish.reason && !publish.waiting ? ` ${publish.reason}` : ""}
          {publishOnRequest && publish.status === "failed" ? ` ${PUBLISH_TRY_AGAIN_HINT}` : ""}
        </p>
      )}
      {liveHref && (
        <div data-testid="build-live-announce" className="mt-1 pl-[30px]">
          {}
          <p className="text-[13px] leading-5 text-ca-secondary">
            {adminHref
              ? "Try it as a visitor, then open your admin to see what comes in."
              : "Try it as a visitor."}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <a
              data-testid="build-open-site"
              href={liveHref}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(
                "inline-flex h-8 items-center gap-2 rounded-cta border border-ca-border bg-ca-bg px-3 text-[13px] font-medium text-ca-xdark transition-colors hover:bg-ca-subtle",
                FOCUS_RING,
              )}
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              Open site
            </a>
            {adminHref && <OpenAdminLink href={adminHref} />}
          </div>
          {adminHref && (
            <AdminLoginHint adminHref={adminHref} adminSetupEmail={adminSetupEmail} sessionId={sessionId} />
          )}
        </div>
      )}
      {adminHref && !liveHref && (
        <p
          data-testid="build-admin-login"
          className="mt-2 pl-[30px] text-[13px] leading-5 text-ca-secondary"
        >
          Log in to your admin at{" "}
          <a
            href={adminHref}
            target="_blank"
            rel="noopener noreferrer"
            className={cx(
              "break-all font-medium text-ink underline underline-offset-2",
              FOCUS_RING,
            )}
          >
            {adminHref}
          </a>
          {adminSetupEmail ? `. We emailed a one-click login link to ${adminSetupEmail}.` : "."}
          {" Your Zavi password does not work there. Sign in with an email link first."}
        </p>
      )}
      {adminHref && !liveHref && adminSetupEmail && (
        <div className="mt-2 pl-[30px]">
          <AdminLinkResend email={adminSetupEmail} sessionId={sessionId} />
        </div>
      )}
      {open && (
        <ul className="mt-3 flex flex-col gap-2.5 border-t border-ca-border pt-3 animate-pane-fade motion-reduce:animate-none">
          {steps.map((step) => (
            <li key={step.key} className="flex items-center gap-3">
              <StepIcon state={step.state} />
              <span className={cx("text-[13px] leading-5", step.state === "failed" ? "text-ca-danger" : "text-ca-secondary")}>
                {step.label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BuildSessionSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="mx-auto w-full max-w-[850px] space-y-6"
    >
      <div className="flex justify-end">
        <Skeleton className="h-[42px] w-[62%]" rounded="rounded-[18px]" />
      </div>
      <div className="rounded-[16px] border border-rule bg-creamDeep/55 px-4 py-3.5">
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="h-5 w-5" rounded="rounded-md" />
          <Skeleton className="h-3.5 w-36" />
        </div>
        <div className="space-y-2.5">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex items-center gap-2.5">
              <Skeleton className="h-3.5 w-3.5" rounded="rounded-full" />
              <Skeleton className="h-3 w-44" />
            </div>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-[16px] border border-rule bg-creamDeep/65 p-1.5">
        <div className="flex h-9 items-center gap-2 px-2">
          <Skeleton className="h-3.5 w-3.5" rounded="rounded-full" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-[230px] w-full" rounded="rounded-xl" />
      </div>
      <span className="sr-only">Loading build…</span>
    </div>
  );
}

const primaryButton = () =>
  cx(
    "inline-flex h-9 items-center gap-2 rounded-cta bg-ink px-3.5 text-[14px] font-semibold text-cream transition-opacity hover:opacity-85 disabled:opacity-50",
    FOCUS_RING,
  );
const noticeAction = () =>
  cx(
    "inline-flex h-6 items-center gap-1 rounded-md border border-rule bg-cream px-2 text-[11px] font-medium text-ink transition-colors hover:bg-bone",
    FOCUS_RING,
  );
const secondaryButton = () =>
  cx(
    "inline-flex h-9 items-center gap-2 rounded-cta border border-rule bg-cream px-3 text-[12px] font-medium text-ink transition-colors hover:bg-bone disabled:opacity-50",
    FOCUS_RING,
  );

type SessionViewProps = {
  sessionId: string | null;
  seed: BuildSessionSeed | null;
  active: boolean;
  initialDraft: string;
  onDraftChange: (draft: string) => void;
  previewOpen: boolean;
  focusNonce: number;
  onOpenPreview: (target: BuildPreviewTarget, intent?: "user") => void;
  onPreviewUnavailable: () => void;
  onPreviewWanted?: () => void;
  onPreviewProgress: (progress: BuildPreviewProgress | null) => void;
  onSessionStarted: (seed: BuildSessionSeed, activate: boolean) => void;
  onOpenSession: (sessionId: string) => void;
  onNewBuild: () => void;
  startComposing: boolean;
};

function BuildSessionView({
  sessionId,
  seed,
  active,
  initialDraft,
  onDraftChange,
  previewOpen,
  focusNonce,
  onOpenPreview,
  onPreviewUnavailable,
  onPreviewWanted,
  onPreviewProgress,
  onSessionStarted,
  onOpenSession,
  onNewBuild,
  startComposing,
}: SessionViewProps) {
  const { tenantName, role } = useWorkspace();
  const startRefusal = startSiteRefusal(role);
  const [buildChannels, setBuildChannels] = useState<string[]>([]);
  const openStatic = useOpenStatic();
  const openConnectors = () => openStatic("brain");
  const toggleBuildChannel = (slug: string) =>
    setBuildChannels((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
  const session = useBuildSession(sessionId, seed);
  const {
    currentSessionId,
    sessions = [],
    loaded: sessionsLoaded = true,
    failed: sessionsFailed = false,
    flags: siteFlags,
    uiFlags,
  } = useBuildSessions();
  const publishOnRequestSetting = uiFlags?.publishOnRequest === true;
  const openSiteName = siteFlags?.siteNames
    ? siteName(sessions.find((row) => row.id === sessionId)?.site)
    : null;
  const oldPipeline = sessions.find((row) => row.id === sessionId)?.old_pipeline === true;
  const [draft, setDraftState] = useState(initialDraft);
  const [starting, setStarting] = useState(false);
  const [template, setTemplate] = useState<PickedTemplate | null>(null);
  const [pendingObjective, setPendingObjective] = useState<string | null>(null);
  const siteListFirst = useSiteListFirst();
  const [composing, setComposing] = useState(
    startComposing || initialDraft.length > 0,
  );
  const [freshRestartFailed, setFreshRestartFailed] = useState(false);
  const [startError, setStartError] = useState<string | CreditRefusal | null>(
    null,
  );
  const [refineError, setRefineError] = useState<string | CreditRefusal | OldSiteFrozenRefusal | null>(
    null,
  );
  const [heldNote, setHeldNote] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [changeStopError, setChangeStopError] = useState<string | null>(null);
  const [continueError, setContinueError] = useState<string | null>(null);
  const [publishRetryError, setPublishRetryError] = useState<string | null>(null);
  const [dictationActive, setDictationActive] = useState(false);
  const [clarify, setClarify] = useState<{ idea: string } | null>(null);
  const clarifyIdea = clarify?.idea ?? null;
  const [planMode, setPlanMode] = useState(false);
  const [plan, setPlan] = useState<{ markdown: string; planFor: string; typed: string; refine: boolean } | null>(null);
  const answeredRef = useRef<{ typed: string; idea: string } | null>(null);
  const [planDraft, setPlanDraft] = useState("");
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const draftRef = useRef(initialDraft);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachments = useBuildImageAttachments(setRefineError);

  const setDraft = useCallback(
    (value: string) => {
      draftRef.current = value;
      setDraftState(value);
      onDraftChange(value);
    },
    [onDraftChange],
  );

  const preStepsFor = useRef(sessionId);
  useEffect(() => {
    if (preStepsFor.current === sessionId) return;
    preStepsFor.current = sessionId;
    setClarify(null);
    setPlan(null);
    setPlanDraft("");
    setPlanError(null);
    setPlanLoading(false);
    setHeldNote(null);
    answeredRef.current = null;
  }, [sessionId]);

  const run = session.run;
  const startAgainShared = useStartAgainEntry(stoppedByFounder(run) ? run?.id : null);
  const publishOnRequest = buildPublishesOnRequest(run?.stages ?? [], publishOnRequestSetting);
  const ranOutOfCredits =
    !stopError &&
    isOutOfCreditsBuild(run?.failure);
  const runStatus = run?.status ?? null;
  const objective = cleanObjective(run?.objective ?? null);
  const publish = session.publish ?? NO_PUBLISH;
  const {
    readyEarly,
    paused,
    failed,
    rootDone,
    building,
    publishBlocksChanges: buildPublishBlocksChanges,
    publishFailed,
    activityStatus,
  } = deriveBuildRunView(!!run, runStatus, session.appReady, publish.status);
  const publishBlocksChanges =
    buildPublishBlocksChanges || (publishOnRequest && rootDone && publish.status === "publishing");
  const neverPublished = builtButNeverPublished(publishOnRequest, runStatus, session.liveUrl, publish.status);
  const undoPropsFor = useRefineUndo(sessionId, neverPublished || publishOnRequestSetting);
  const constructing = building && !readyEarly;
  const superseded = session.loaded && !!run && !session.isCurrent;
  const hasEarlierReadyBuild = sessions.some(
    (s) => s.id !== sessionId && (s.state === "ready" || s.run_status === "done"),
  );
  useEffect(() => {
    if (publish.status !== "failed") setPublishRetryError(null);
  }, [publish.status]);
  const isLive = !!session.liveUrl || session.previewKind === "final";
  const status: BuildStatus = session.liveUrl && !publishBlocksChanges
    ? "live"
    : failed
      ? "failed"
      : building
        ? "building"
        : "none";
  const previewUrl = session.previewUrl ?? session.liveUrl;
  const previewKind: BuildPreviewKind =
    session.previewKind === "none" && session.liveUrl
      ? "final"
      : session.previewKind;
  const appName = useMemo(
    () => openSiteName ?? buildProjectName(run?.objective ?? null, tenantName),
    [openSiteName, run?.objective, tenantName],
  );
  const previewRevision = previewRevisionOf(session.refines);
  const target = useMemo<BuildPreviewTarget | null>(
    () =>
      previewUrl && sessionId
        ? {
            url: previewUrl,
            appName,
            kind: previewKind,
            status,
            objective,
            repoUrl: session.repoUrl,
            revision: previewRevision,
          }
        : null,
    [
      appName,
      objective,
      previewKind,
      previewRevision,
      previewUrl,
      session.repoUrl,
      sessionId,
      status,
    ],
  );
  const stepStatus: BuildStatus =
    readyEarly && publish.status === "failed" ? "failed" : status;
  const steps = useMemo(
    () => deriveBuildSteps(run?.stages ?? [], runStatus, stepStatus, publishOnRequest),
    [run?.stages, runStatus, stepStatus, publishOnRequest],
  );
  const elapsed = useElapsed(
    run?.createdAt ?? null,
    readyEarly || rootDone
      ? builtAtEnd(run?.stages ?? [], session.appReadyAt, run?.updatedAt ?? null, rootDone)
      : (run?.updatedAt ?? null),
    activityStatus === "building",
  );
  const refineBusy = session.refineSubmitting;
  const runBusy = starting || refineBusy;
  const canRefine =
    !!sessionId &&
    !!run &&
    (rootDone || isLive) &&
    !superseded &&
    !publishBlocksChanges &&
    !publishFailed;
  const canQueue =
    !canRefine &&
    !!sessionId &&
    !!run &&
    building &&
    !superseded &&
    !publishBlocksChanges &&
    !publishFailed;
  const canChange = canRefine || canQueue;
  useEffect(() => {
    if (!building) setHeldNote(null);
  }, [building]);
  const unresolved = session.loaded && !run;
  const startsNewBuild =
    !sessionId || unresolved || (session.loaded && (failed || publishFailed));
  const minimum = canChange ? (attachments.paths.length > 0 ? 2 : 8) : IDEA_MIN_CHARS;
  const maximum = canChange ? 1000 : IDEA_MAX_CHARS;
  const backgroundPublishBusy =
    rootDone &&
    !superseded &&
    !isRefineBusy(session.refines) &&
    sessions.some((row) => row.id === sessionId && (row.state === "building" || row.state === "publishing"));
  const composerLocked =
    runBusy ||
    planLoading ||
    session.authExpired ||
    (publishBlocksChanges && !superseded) ||
    backgroundPublishBusy ||
    (!canChange && !startsNewBuild);
  const templateBlanks = startsNewBuild && !canChange ? unfilledBlanks(draft, template) : [];
  const canSend =
    draft.trim().length >= minimum && !composerLocked && templateBlanks.length === 0 && !attachments.uploading;

  const listRetriedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!session.notFound || session.authExpired) return;
    if (!sessionsLoaded) {
      if (listRetriedFor.current === sessionId) return;
      listRetriedFor.current = sessionId;
      void refreshBuildSessions().then(() => {
        if (!readBuildSessions().loaded) return refreshBuildSessions();
      });
      return;
    }
    if (buildLinkedOnLoad(sessionId)) return;
    if (currentSessionId && currentSessionId !== sessionId)
      onOpenSession(currentSessionId);
  }, [
    session.notFound,
    session.authExpired,
    sessionsLoaded,
    currentSessionId,
    sessionId,
    onOpenSession,
  ]);

  const previewGone = !superseded && !!session.previewState;
  const builtAwaitingPublish =
    !superseded && session.appReady && !session.liveUrl && (publish.status === "publishing" || publish.status === "failed");
  useEffect(() => {
    if (target) {
      onOpenPreview(target);
      return;
    }
    if ((previewGone || builtAwaitingPublish) && onPreviewWanted) {
      onPreviewWanted();
      return;
    }
    if (previewOpen && session.loaded && !building) onPreviewUnavailable();
  }, [
    building,
    onOpenPreview,
    onPreviewUnavailable,
    onPreviewWanted,
    previewGone,
    builtAwaitingPublish,
    previewOpen,
    session.loaded,
    target,
  ]);

  useEffect(() => {
    if (!run || !constructing) {
      onPreviewProgress(null);
      return;
    }
    onPreviewProgress({ stages: run.stages, failure: run.failure, failed });
  }, [constructing, failed, onPreviewProgress, run]);

  useEffect(() => {
    if (focusNonce > 0) composerRef.current?.focus();
  }, [focusNonce]);

  const latestRefine = session.refines[session.refines.length - 1];
  useEffect(() => {
    if (!run) return;
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, [activityStatus, previewUrl, run, session.refines.length, latestRefine?.id, latestRefine?.status]);

  const sendRefine = async (message: string): Promise<boolean> => {
    setRefineError(null);
    setHeldNote(null);
    const imagePaths = attachments.paths;
    const error = imagePaths.length > 0
      ? await session.sendRefine(message, { imagePaths })
      : await session.sendRefine(message);
    if (isHeldChange(error)) {
      setHeldNote(error.message);
      setDraft("");
      attachments.clear();
      return true;
    }
    if (error) {
      setRefineError(error);
      return false;
    }
    setDraft("");
    attachments.clear();
    return true;
  };

  const retryPhotos = async (): Promise<boolean> => {
    setRefineError(null);
    const error = await session.sendRefine("Add photos to the site", { photoRetry: true });
    if (error && !isHeldChange(error)) {
      setRefineError(error);
      return false;
    }
    return true;
  };

  const startBuild = async (
    message: string,
    opts: { fromComposer?: boolean } = {},
  ): Promise<string | null> => {
    if (starting) return null;
    if (startRefusal) {
      setStartError(startRefusal);
      return null;
    }
    const typed = draftRef.current;
    const fromComposer = opts.fromComposer ?? typed.trim() === message.trim();
    const activateWhenStarted = active;
    setStarting(true);
    setStartError(null);
    setPendingObjective(message);
    if (fromComposer) setDraft("");
    const result = await startBuildSession({
      idea: message,
      companyName: tenantName,
      ...(template ? { template: template.id } : {}),
    });
    setStarting(false);
    setPendingObjective(null);
    if ("error" in result) {
      if (fromComposer) setDraft(typed);
      setStartError(result.credit ?? result.error);
      requestAnimationFrame(() => composerRef.current?.focus());
      return null;
    }
    if (fromComposer) setDraft("");
    setTemplate(null);
    onSessionStarted({
      id: result.id,
      objective: message,
      startedAt: Date.now(),
    }, activateWhenStarted);
    return result.id;
  };

  const onSend = () => {
    const message = draft.trim();
    if (!canSend) return;
    if (canChange) {
      if (planMode && canRefine) void draftPlan(message);
      else void sendRefine(message);
      return;
    }
    if (startRefusal) {
      setStartError(startRefusal);
      return;
    }
    const answered = answeredRef.current;
    if (answered && answered.typed === message) {
      void startAnswered(answered.idea, message);
      return;
    }
    if (isBuilderClarifyEnabled() && !ideaAnswersEverything(message)) {
      setStartError(null);
      setPlanError(null);
      setClarify({ idea: message });
      return;
    }
    void startBuild(message);
  };

  const startAnswered = async (idea: string, typed: string) => {
    answeredRef.current = { typed, idea };
    const id = await startBuild(idea, { fromComposer: true });
    if (id) answeredRef.current = null;
  };

  const afterClarify = (idea: string) => {
    const typed = clarify?.idea ?? idea;
    setClarify(null);
    answeredRef.current = { typed, idea };
    void startAnswered(idea, typed);
  };

  const onClarifyComplete = (augmented: string) => {
    if (clarifyIdea === null) return;
    afterClarify(fitClarifiedIdea(clarifyIdea, augmented, IDEA_MAX_CHARS));
  };

  const onClarifySkip = () => {
    if (clarifyIdea !== null) afterClarify(clarifyIdea);
  };

  const closeClarify = () => {
    setClarify(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const draftPlan = async (message: string, typed: string = message) => {
    const forSession = sessionId;
    const refine = canRefine;
    setPlanLoading(true);
    setPlanError(null);
    setPlan(null);
    try {
      const res = await apiFetch("/api/workspace/autopilot/plan", {
        method: "POST",
        body: JSON.stringify({
          idea: message,
          mode: refine ? "refine" : "build",
          ...(refine && forSession ? { build_session_id: forSession } : {}),
        }),
      });
      if (preStepsFor.current !== forSession) return;
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setPlanError(body?.error?.message ?? "Couldn't draft a plan. Try again.");
        return;
      }
      const payload = (await res.json()) as { plan_markdown?: string };
      if (preStepsFor.current !== forSession) return;
      const markdown = (payload.plan_markdown ?? "").trim();
      if (!markdown) {
        setPlanError("The plan came back empty. Try again.");
        return;
      }
      setPlan({ markdown, planFor: message, typed, refine });
      setPlanDraft(markdown);
    } catch {
      if (preStepsFor.current === forSession) setPlanError("Couldn't reach Zavi to draft a plan. Try again.");
    } finally {
      if (preStepsFor.current === forSession) setPlanLoading(false);
    }
  };

  const discardPlan = () => {
    setPlan(null);
    setPlanDraft("");
    setPlanError(null);
  };

  const approvePlan = async () => {
    if (!plan) return;
    const approved = plan;
    const edited = planDraft;
    const combined = combineIdeaAndPlan(approved.planFor, edited.trim() || approved.markdown, PLAN_APPROVE_MAX_CHARS);
    if (approved.refine && !canRefine) {
      setPlanError("This app can't take changes right now. Try again once it is ready.");
      return;
    }
    setPlan(null);
    setPlanDraft("");
    setPlanMode(false);
    const ok = approved.refine ? await sendRefine(combined) : !!(await startBuild(combined, { fromComposer: true }));
    if (ok) {
      answeredRef.current = null;
      return;
    }
    if (preStepsFor.current !== sessionId) return;
    setPlan(approved);
    setPlanDraft(edited);
    setPlanMode(true);
  };

  useEffect(() => {
    if (plan && draft.trim() !== plan.typed) {
      setPlan(null);
      setPlanDraft("");
    }
  }, [draft, plan]);

  const applyDictation = useCallback(
    (transcript: string) => {
      setDraft(appendDictatedText(draftRef.current, transcript));
      requestAnimationFrame(() => composerRef.current?.focus());
    },
    [setDraft],
  );

  const continueBuild = async () => {
    setContinueError(null);
    const error = await session.continueRun();
    if (error) setContinueError(error.message);
  };

  const canRestartFresh =
    run?.failure?.stage === "provision" &&
    !freshRestartFailed &&
    !session.appReady &&
    sessionsLoaded &&
    !hasEarlierReadyBuild &&
    (objective ?? "").length > 0 &&
    (run?.objective ?? "").length < OBJECTIVE_STORED_MAX;

  const retryFailedBuild = async () => {
    setContinueError(null);
    if (stoppedByFounder(run)) {
      const brief = restartBrief(run?.objective ?? null);
      const stoppedId = run?.id ?? null;
      const shared = startAgainEntry(stoppedId);
      if (shared?.status === "started") {
        onOpenSession(shared.id);
        return;
      }
      if (shared) return;
      if (brief && stoppedId) {
        if (!claimStartAgain(stoppedId)) return;
        let newId: string | null = null;
        try {
          newId = await startBuild(brief);
        } finally {
          settleStartAgain(stoppedId, newId);
        }
        return;
      }
      setDraft(objective ?? "");
      composerRef.current?.focus();
      return;
    }
    if (runStatus === "failed") {
      const error = await session.continueRun();
      if (!error) return;
      if (!RETRY_FALLBACK_CODES.has(error.code)) {
        setContinueError(error.message);
        return;
      }
    }
    if (objective && canRestartFresh) {
      const started = await startBuild(objective);
      if (!started) {
        setFreshRestartFailed(true);
        void refreshBuildSessions();
      }
      return;
    }
    setDraft(objective ?? "");
    composerRef.current?.focus();
  };

  const retryPublish = async () => {
    if (session.continuing) return;
    setPublishRetryError(null);
    const error = await session.continueRun();
    if (error) setPublishRetryError(error.message);
  };

  const stopBuild = async () => {
    if (session.stopping) return;
    const confirmed = await confirmAction({
      title: "Stop this build?",
      description:
        "Finished steps are kept. You can start a new build afterward.",
      confirmLabel: "Stop build",
      cancelLabel: "Keep building",
      tone: "danger",
    });
    if (!confirmed) return;
    setStopError(null);
    const error = await session.cancelRun();
    if (error) setStopError(error);
  };

  const runningChange = building ? null : latestBusyRefine(session.refines);
  const showStop =
    !dictationActive && (constructing || (!!runningChange && !draft.trim()));
  const showRetry =
    !dictationActive &&
    !showStop &&
    !draft.trim() &&
    ((failed && !paused) || (publishFailed && !publish.retryable)) &&
    !superseded &&
    !isOutOfCreditsBuild(run?.failure);

  const stopChange = async (refineId: string) => {
    if (session.stopping) return;
    const confirmed = await confirmAction({
      title: "Stop this change?",
      description:
        "Your app stays as it was before this change. You can ask again afterward.",
      confirmLabel: "Stop change",
      cancelLabel: "Keep going",
      tone: "danger",
    });
    if (!confirmed) return;
    setChangeStopError(null);
    const error = await session.cancelRun(refineId);
    if (error) setChangeStopError(error);
  };

  const composer = (
    <div className="w-full">
      {changeStopError && runningChange && (
        <p role="alert" className="mb-2 w-full pl-1 text-[12px] text-danger">
          {changeStopError}
        </p>
      )}
      {buildChannels.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 pl-1">
          <ChannelTags selected={buildChannels} onRemove={toggleBuildChannel} />
        </div>
      )}
      {planLoading && (
        <p className="mb-2 pl-1 text-[12px] text-inkSoft" aria-live="polite">
          Drafting a plan…
        </p>
      )}
      {planError && (
        <p role="alert" className="mb-2 pl-1 text-[12px] text-danger">
          {planError}
        </p>
      )}
      {plan && (
        <PlanReviewCard
          className="mb-3"
          markdown={plan.markdown}
          draft={planDraft}
          onDraftChange={setPlanDraft}
          approveLabel={plan.refine ? "Approve & apply" : "Approve & build"}
          approveDisabled={runBusy || composerLocked}
          onApprove={() => void approvePlan()}
          onDiscard={discardPlan}
        />
      )}
      {template && startsNewBuild && !canRefine && <TemplateChip template={template} blanks={templateBlanks} onClear={() => setTemplate(null)} />}
      {clarifyIdea !== null ? (
        <div data-testid="build-clarify">
          <div className="flex items-center justify-between gap-2 pl-1">
            <p className="min-w-0 truncate text-[13px] text-inkMuted" title={clarifyIdea}>
              A few quick questions to shape your site
            </p>
            <button
              type="button"
              onClick={closeClarify}
              className={cx("shrink-0 rounded-cta px-2 py-1 text-[13px] text-inkMuted hover:text-ink", FOCUS_RING)}
            >
              Edit my idea
            </button>
          </div>
          <BuildClarifyStep idea={clarifyIdea} onComplete={onClarifyComplete} onSkip={onClarifySkip} />
        </div>
      ) : (
      <ModeComposer
        borderless
        textareaRef={composerRef}
        value={draft}
        onChange={setDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!planLoading) onSend();
          }
        }}
        maxLength={maximum}
        disabled={composerLocked || dictationActive}
        onPaste={(event) => {
          if (!canRefine) return;
          const files = imageFilesFrom(event.clipboardData);
          if (files.length === 0) return;
          event.preventDefault();
          attachments.add(files);
        }}
        header={
          canRefine && attachments.images.length > 0 ? (
            <ul aria-label="Attached images" className="flex flex-wrap gap-2 px-2 pb-1 pt-1">
              {attachments.images.map((img) => (
                <li key={img.id} className="relative h-14 w-14 overflow-hidden rounded-lg border border-rule bg-bone">
                  {img.previewUrl ? (
                    <span
                      role="img"
                      aria-label={img.name}
                      className="block h-full w-full bg-cover bg-center"
                      style={{ backgroundImage: `url("${img.previewUrl}")` }}
                    />
                  ) : null}
                  {img.status === "uploading" && (
                    <span className="absolute inset-0 grid place-items-center bg-cream/60">
                      <Loader2 className="h-4 w-4 animate-spin text-ink" aria-label="Uploading" />
                    </span>
                  )}
                  {img.status === "error" && (
                    <span className="absolute inset-0 grid place-items-center bg-danger/20 text-[10px] font-medium text-danger">
                      Failed
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => attachments.remove(img.id)}
                    aria-label={`Remove ${img.name}`}
                    className={cx("absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center rounded-full bg-ink/70 text-cream", FOCUS_RING)}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null
        }
        ariaLabel={
          canChange
            ? "Describe an update to your app"
            : "Describe the app to build"
        }
        placeholder={
          planMode && canRefine && !composerLocked
            ? "Describe the change. Zavi drafts a plan first…"
            : startsNewBuild
            ? failed || publishFailed
              ? "Describe what to build next…"
              : "Describe what you want to build…"
            : publishBlocksChanges
              ? "You can ask for changes once your app is published…"
              : backgroundPublishBusy
                ? BACKGROUND_PUBLISH_PLACEHOLDER
                : building
                  ? BUILDING_CHANGE_PLACEHOLDER
                  : "Describe the change you want to make…"
        }
        leading={
          !dictationActive ? (
            <BuildComposerMenu
              selectedChannels={buildChannels}
              onToggleChannel={toggleBuildChannel}
              role={role}
              onManageConnectors={openConnectors}
              sessionId={sessionId}
            />
          ) : null
        }
        trailing={
          <>
            {canRefine && !dictationActive && (
              <>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  hidden
                  data-testid="build-image-input"
                  onChange={(event) => {
                    attachments.add(imageFilesFrom({ files: event.currentTarget.files }));
                    event.currentTarget.value = "";
                  }}
                />
                <ComposerIconButton
                  onClick={() => imageInputRef.current?.click()}
                  ariaLabel="Attach a screenshot or image"
                  title={`Attach up to ${BUILD_IMAGE_MAX} screenshots or images`}
                >
                  <ImagePlus className="h-4 w-4" aria-hidden />
                </ComposerIconButton>
              </>
            )}
            {}
            {canRefine && !dictationActive && (
              <button
                type="button"
                onClick={() => {
                  setPlanMode((on) => !on);
                  setPlanError(null);
                }}
                aria-pressed={planMode}
                title={planMode ? "Plan mode is on: Send drafts a plan to review first" : "Plan first: review a plan before anything is built"}
                className={cx(
                  "inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium transition-colors",
                  planMode ? "bg-ink text-cream hover:bg-ink/90" : "text-inkMuted hover:bg-bone hover:text-ink",
                  FOCUS_RING,
                )}
              >
                <ListChecks className="h-3.5 w-3.5" aria-hidden />
                Plan
              </button>
            )}
            <MicButton
              onTranscript={applyDictation}
              onActiveChange={setDictationActive}
              compact
            />
            {showStop ? (
              <SendCircle
                onClick={() =>
                  void (runningChange
                    ? stopChange(runningChange.id)
                    : stopBuild())
                }
                disabled={session.stopping}
                busy={session.stopping}
                ariaLabel={runningChange ? "Stop change" : "Stop build"}
              >
                <Square
                  className="h-3 w-3 fill-current compact:h-3.5 compact:w-3.5"
                  aria-hidden
                />
              </SendCircle>
            ) : showRetry ? (
              <SendCircle
                onClick={() => void retryFailedBuild()}
                busy={starting || (runStatus === "failed" && session.continuing)}
                ariaLabel="Retry build"
              >
                <RotateCw className="h-4 w-4 compact:h-5 compact:w-5" strokeWidth={2.5} aria-hidden />
              </SendCircle>
            ) : (
              !dictationActive && (
                <SendCircle
                  onClick={onSend}
                  disabled={!canSend || planLoading}
                  busy={runBusy || planLoading}
                  ariaLabel={planMode && canRefine ? "Draft a plan" : canChange ? "Send update" : "Build app"}
                />
              )
            )}
          </>
        }
      />
      )}
    </div>
  );

  const startErrorLine = !startError ? null : typeof startError === "string" ? (
    <p role="alert" className="mb-2 w-full text-[12px] text-danger">
      {startError}
    </p>
  ) : (
    <CreditRefusalNotice refusal={startError} className="mb-2" />
  );

  if (!sessionId && pendingObjective !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="build-starting">
        <div className="ws-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4">
          <div className="mx-auto w-full max-w-[850px]">
            <UserBubble text={askedText(pendingObjective)} />
            <BuildReplyRow className="mt-4">
              <div role="status" className="py-2 text-[14px] text-inkMuted">
                Setting up your build…
              </div>
            </BuildReplyRow>
          </div>
        </div>
        <div className="shrink-0 px-4 pb-4 pt-2">
          <div className="mx-auto w-full max-w-[850px]">{composer}</div>
        </div>
      </div>
    );
  }

  if (
    !sessionId &&
    siteListFirst !== false &&
    !composing &&
    draft.length === 0 &&
    (sessionsLoaded ? siteListFirst === null && sessions.length > 0 : !sessionsFailed)
  ) {
    return <div className="flex h-full min-h-0 flex-col" data-testid="build-site-list-pending" aria-busy="true" />;
  }

  if (
    !sessionId &&
    siteListFirst === true &&
    !composing &&
    draft.length === 0 &&
    sessionsLoaded &&
    sessions.length > 0
  ) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="build-site-list">
        <div className="ws-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-2">
          <div className="mx-auto w-full max-w-[850px]">
            <RecentBuilds
              label={SITE_LIST_TITLE}
              limit={SITE_LIST_LIMIT}
              sessions={sessions}
              currentSessionId={currentSessionId}
              onOpen={onOpenSession}
              siteNames={siteFlags?.siteListDetails === true}
              action={
                <button
                  type="button"
                  onClick={() => {
                    setComposing(true);
                    if (startRefusal) setStartError(startRefusal);
                    requestAnimationFrame(() => composerRef.current?.focus());
                  }}
                  className={primaryButton()}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  {SITE_LIST_NEW}
                </button>
              }
            />
          </div>
        </div>
      </div>
    );
  }

  if (!sessionId) {
    return (
      <WorkspaceModeWelcome
        mode="build"
        foldConnect
        composer={composer}
        beforeComposer={startErrorLine}
        afterSuggestions={
          sessions.length > 0 ? (
            <RecentBuilds
              label={siteListFirst === true ? SITE_LIST_TITLE : undefined}
              sessions={sessions}
              currentSessionId={currentSessionId}
              onOpen={onOpenSession}
              siteNames={siteFlags?.siteListDetails === true}
            />
          ) : undefined
        }
        afterComposer={
          <div className="mt-3 flex w-full justify-center">
            <TemplateGallery
              selectedId={template?.id ?? null}
              onUse={({ template: picked, idea }) => {
                setTemplate(picked);
                setDraft(idea);
                requestAnimationFrame(() => {
                  const box = composerRef.current;
                  if (!box) return;
                  box.focus();
                  box.setSelectionRange(idea.length, idea.length);
                });
              }}
            />
          </div>
        }
        onPickSuggestion={(suggestion) => {
          setDraft(suggestion);
          composerRef.current?.focus();
        }}
      />
    );
  }

  if (!session.loaded) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="ws-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4">
          <BuildSessionSkeleton />
        </div>
        <div className="shrink-0 px-4 pb-4 pt-2">
          <div className="mx-auto w-full max-w-[850px]">{composer}</div>
        </div>
      </div>
    );
  }

  if (!run) {
    const notice = session.authExpired
      ? {
          text: "Your session expired. Sign in again to pick that build back up.",
          action: (
            <button
              type="button"
              onClick={() => {
                window.location.href = `/login?next=${encodeURIComponent(
                  window.location.pathname + window.location.search,
                )}`;
              }}
              className={noticeAction()}
            >
              Sign in
            </button>
          ),
        }
      : session.notFound
        ? {
            text: "That build isn't in this workspace. Start a new one below.",
            action: null,
          }
        : {
            text: buildLoadErrorCopy(session.loadError),
            action: (
              <button
                type="button"
                onClick={session.retry}
                className={noticeAction()}
              >
                <RotateCw className="h-3 w-3" aria-hidden />
                Try again
              </button>
            ),
          };

    return (
      <WorkspaceModeWelcome
        mode="build"
        foldConnect
        composer={composer}
        beforeComposer={
          <>
            {startErrorLine}
            <div
              role="status"
              className="mb-3 flex w-full flex-wrap items-center justify-center gap-2 text-[12px] text-inkMuted"
            >
              <span>{notice.text}</span>
              {notice.action}
            </div>
          </>
        }
        onPickSuggestion={(suggestion) => {
          setDraft(suggestion);
          composerRef.current?.focus();
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={feedRef} className="ws-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-4">
        <div className="mx-auto w-full max-w-[850px] space-y-6">
          {objective && (
            <div className="space-y-3">
              <TurnDivider prev={null} at={run?.createdAt ?? null} />
              <UserBubble text={askedText(objective)} />
            </div>
          )}

          <BuildReplyRow
            footer={
              !superseded && (activityStatus === "ready" || activityStatus === "failed") ? (
                <BuildRating runId={run.id} label="build" />
              ) : undefined
            }
          >
            <BuildActivity
              steps={steps}
              stages={run.stages}
              status={activityStatus}
              error={
                stopError ??
                (ranOutOfCredits || paused || readyEarly
                  ? null
                  : stoppedBuildLine(run, failed && !paused && !superseded, {
                      startedWork: steps.some((step) => step.state === "done"),
                    })) ??
                null
              }
              paused={paused}
              crashed={isCrashedRun(runStatus, run?.failure?.class)}
              replaced={superseded}
              retired={superseded && session.retired}
              elapsed={elapsed}
              stopping={session.stopping}
              canStop={activityStatus === "building"}
              onStop={() => void stopBuild()}
              designRunId={superseded ? null : run.id}
              publishOnRequest={publishOnRequest}
              publishStopped={!superseded && publish.status === "failed"}
              publishRow={
                superseded ? null : neverPublished ? (
                  publish.status === "none" ? (
                    <p
                      data-testid="build-publish-on-request"
                      className="mt-3 rounded-xl border border-ca-border bg-ca-subtle px-3 py-2.5 text-[13px] leading-5 text-ca-xdark"
                    >
                      {session.previewState === "stopped" ? BUILD_READY_PREVIEW_STOPPED : BUILD_READY_UNPUBLISHED}
                    </p>
                  ) : (
                    <PublishRow publish={publish} retrying={false} error={null} retryHint={PUBLISH_TRY_AGAIN_HINT} previewReady={!!previewUrl} />
                  )
                ) : readyEarly || (rootDone && publish.status === "live") ? (
                  <PublishRow
                    publish={publish}
                    onRetry={publish.retryable ? () => void retryPublish() : undefined}
                    retrying={session.continuing}
                    error={publishRetryError}
                    adminUrl={session.adminUrl ?? null}
                    adminSetupEmail={session.adminSetupEmail ?? null}
                    sessionId={sessionId}
                    previewReady={!!previewUrl}
                  />
                ) : null
              }
            />
            {!superseded && activityStatus === "ready" && session.photos && (
              <PhotosMissingNotice
                photos={session.photos}
                disabled={runBusy || isRefineBusy(session.refines)}
                onRetry={retryPhotos}
              />
            )}
          </BuildReplyRow>

          {!superseded && <SiteDesignCard runId={run.id} buildActive={activityStatus === "building"} inReplyGutter />}

          {((failed && !paused) || (publishFailed && !publish.retryable)) &&
            !superseded &&
            !ranOutOfCredits && (
            <FailedActions
              onRetry={() => void retryFailedBuild()}
              retrying={starting || startAgainShared?.status === "starting" || (runStatus === "failed" && session.continuing)}
              error={continueError}
              onNewBuild={onNewBuild}
              stopped={stoppedByFounder(run)}
              startedAgain={startAgainShared?.status === "started"}
            />
          )}

          {paused && !superseded ? (
            <PausedNotice
              stepLabel={
                steps.find((step) => step.state === "failed")?.label ?? null
              }
              outOfCredits={ranOutOfCredits}
              continuing={session.continuing}
              onContinue={() => void continueBuild()}
              error={continueError}
            />
          ) : (
            ranOutOfCredits && (
              <CreditRefusalNotice refusal={BUILD_STOPPED_REFUSAL} />
            )
          )}

          {session.refines.map((refine) => (
            <Fragment key={refine.id}>
              <TurnDivider prev={null} at={refine.created_at} />
              <RefineTurn
                refine={refine}
                previewOnly={publishOnRequestSetting}
                previewUrl={refinePreviewHref(
                  refine,
                  session.previewUrl,
                  session.liveUrl,
                )}
                {...undoPropsFor(refine)}
                stopsAtPreview={neverPublished || publishOnRequestSetting}
                siteNeverPublished={neverPublished}
                typicalSeconds={typicalChangeSeconds(session.refines)}
              />
            </Fragment>
          ))}
          {(session.savingEdits ?? []).map((refine) => (
            <SavingEditsTurn key={refine.id} refine={refine} />
          ))}

          {target && !superseded && (
            <PreviewCard
              target={target}
              onOpen={() => onOpenPreview(target, "user")}
            />
          )}
        </div>
      </div>

      <div className="shrink-0 px-4 pb-4 pt-2">
        <div className="mx-auto w-full max-w-[850px]">
          {oldPipeline && !session.retired ? (
            <OldSiteFrozenNotice />
          ) : superseded ? (
            <div className="rounded-[16px] border border-rule bg-creamDeep/55 px-4 py-3.5">
              {session.retired ? (
                <>
                  <p className="text-[13px] font-semibold text-ink">
                    We retired this build
                  </p>
                  <p className="mt-1 text-[12px] leading-5 text-inkMuted">
                    Builds from our early beta were shut down when we upgraded
                    the builder, so this app is no longer online. Your idea is
                    still here. Start a new build and it gets a fresh app and
                    database.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[13px] font-semibold text-ink">
                    A newer build replaced this app
                  </p>
                  <p className="mt-1 text-[12px] leading-5 text-inkMuted">
                    Your workspace hosts one app at a time, so changes now apply
                    to your latest build.
                  </p>
                </>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {currentSessionId && currentSessionId !== sessionId && (
                  <button
                    type="button"
                    onClick={() => onOpenSession(currentSessionId)}
                    className={primaryButton()}
                  >
                    Open latest build
                    <NextChevron />
                  </button>
                )}
                <button
                  type="button"
                  onClick={onNewBuild}
                  className={
                    session.retired ? primaryButton() : secondaryButton()
                  }
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Start a new build
                </button>
              </div>
            </div>
          ) : (
            <>
              {canRefine && (
                <RefineStrip appName={appName} onNewBuild={onNewBuild} waitsForPublish={publishOnRequestSetting} />
              )}
              {startErrorLine}
              {publishBlocksChanges && (
                <p
                  role="status"
                  data-testid="build-publish-blocks-changes"
                  className="mb-2 px-1 text-[12px] leading-5 text-inkMuted"
                >
                  {PUBLISH_CHANGES_BLOCKED}
                </p>
              )}
              {heldNote && !refineError && (
                <p role="status" data-testid="build-change-held" className="mb-2 px-1 text-[12px] leading-5 text-inkMuted">
                  {heldNote}
                </p>
              )}
              {refineError &&
                (typeof refineError === "string" ? (
                  <p className="mb-2 text-[12px] text-danger">
                    {refineError}
                  </p>
                ) : isOldSiteFrozen(refineError) ? (
                  <OldSiteFrozenNotice message={refineError.message} className="mb-2" />
                ) : (
                  <CreditRefusalNotice refusal={refineError} className="mb-2" />
                ))}
              {composer}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function visibleRefines(refines: BuildRefine[]): BuildRefine[] {
  const retried = new Set(
    refines.map((r) => r.retry_of).filter((id): id is string => !!id),
  );
  return refines.filter((r) => !retried.has(r.id));
}

export function lastBuildActivity(
  run: { createdAt: string | null; updatedAt: string | null } | null,
  refines: BuildRefine[],
): string | null {
  const stamps = [
    run?.updatedAt,
    run?.createdAt,
    ...refines.map((r) => r.created_at),
  ].filter(
    (v): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)),
  );
  if (stamps.length === 0) return null;
  return stamps.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

const SKELETON_BAR = "animate-pulse bg-bone motion-reduce:animate-none";

function BuildTranscriptSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading conversation"
      data-testid="build-transcript-skeleton"
      className="flex flex-col animate-code-fade motion-reduce:animate-none"
    >
      <div className="space-y-3">
        <div className="flex justify-center">
          <span className={cx(SKELETON_BAR, "h-6 w-28 rounded-full")} />
        </div>
        <div className="flex justify-end">
          <span className={cx(SKELETON_BAR, "h-[72px] w-[78%] rounded-3xl")} />
        </div>
      </div>
      <div className="mt-4 space-y-3 rounded-2xl border border-rule p-4">
        <span className={cx(SKELETON_BAR, "block h-4 w-2/5 rounded-full")} />
        <span className={cx(SKELETON_BAR, "block h-3 w-3/5 rounded-full")} />
        <span className={cx(SKELETON_BAR, "block h-3 w-1/2 rounded-full")} />
      </div>
    </div>
  );
}

export function BuildTranscript({
  sessionId,
  onLastActivity,
  publishOnRequest = false,
}: {
  sessionId: string;
  onLastActivity?: (iso: string | null) => void;
  publishOnRequest?: boolean;
}) {
  const session = useBuildSession(sessionId, null);
  return (
    <BuildTranscriptContent
      sessionId={sessionId}
      session={session}
      onLastActivity={onLastActivity}
      publishOnRequest={publishOnRequest}
    />
  );
}

export type BuildTimelineItem = { id: string; at: string; node: ReactNode; repliesToTurn?: boolean };

function changesPreviewOnly(
  session: ReturnType<typeof useBuildSession>,
  publishOnRequest: boolean,
): boolean {
  const runStatus = session.run?.status ?? null;
  return (
    session.isCurrent !== false &&
    builtButNeverPublished(
      buildPublishesOnRequest(session.run?.stages ?? [], publishOnRequest),
      runStatus,
      session.liveUrl,
      session.publish?.status,
    )
  );
}

function askedIn(refine: BuildRefine, chatThreadId: string | null): boolean {
  return !!chatThreadId && refine.chat_thread_id === chatThreadId;
}

function useRefineTurns(
  sessionId: string | null,
  session: ReturnType<typeof useBuildSession>,
  publishOnRequest: boolean,
  chatThreadId: string | null = null,
) {
  const [retrying, setRetrying] = useState<string | null>(null);
  const retryingRef = useRef<string | null>(null);
  const [retryError, setRetryError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  useEffect(() => {
    const id = retryingRef.current;
    if (!id) return;
    const original = session.refines.find((r) => r.id === id);
    const replaced = session.refines.some((r) => r.retry_of === id);
    if (!replaced && original && FAILED_STAGE.has(original.status)) return;
    retryingRef.current = null;
    setRetrying(null);
  }, [session.refines]);
  const undoPropsFor = useRefineUndo(sessionId, changesPreviewOnly(session, publishOnRequest) || publishOnRequest);
  const retry = async (refine: BuildRefine) => {
    if (retryingRef.current || !sessionId) return;
    retryingRef.current = refine.id;
    setRetrying(refine.id);
    setRetryError(null);
    const error = await startBuildRefine(sessionId, refine.message, {
      retryOf: refine.id,
    });
    if (error) {
      retryingRef.current = null;
      setRetrying(null);
      setRetryError({
        id: refine.id,
        message: refineRetryMessage(error),
      });
    }
  };
  const previewOnly = publishOnRequest;
  const neverPublished = changesPreviewOnly(session, publishOnRequest);
  const renderTurn = (refine: BuildRefine, className?: string) => refine.saving ? (
    <SavingEditsTurn refine={refine} className={className} />
  ) : (
    <RefineTurn
      refine={refine}
      previewOnly={previewOnly}
      stopsAtPreview={neverPublished || publishOnRequest}
      siteNeverPublished={neverPublished}
      typicalSeconds={typicalChangeSeconds(session.refines)}
      askShownInThread={askedIn(refine, chatThreadId)}
      previewUrl={refinePreviewHref(
        refine,
        session.previewUrl,
        session.liveUrl,
      )}
      onRetry={() => void retry(refine)}
      retrying={retrying === refine.id}
      retryError={
        retryError?.id === refine.id ? retryError.message : null
      }
      {...undoPropsFor(refine)}
      className={className}
    />
  );
  return { shown: [...visibleRefines(session.refines), ...(session.savingEdits ?? [])], renderTurn };
}

export function useBuildTimelineItems(
  sessionId: string | null,
  session: ReturnType<typeof useBuildSession>,
  publishOnRequest = false,
  chatThreadId: string | null = null,
): BuildTimelineItem[] {
  const { shown, renderTurn } = useRefineTurns(sessionId, session, publishOnRequest, chatThreadId);
  if (!sessionId || !session.run) return [];
  return shown.map((refine) => ({
    id: `refine:${refine.id}`,
    at: refine.created_at,
    node: renderTurn(refine),
    ...(askedIn(refine, chatThreadId) ? { repliesToTurn: true } : {}),
  }));
}

export function BuildTranscriptContent({
  sessionId,
  session,
  onLastActivity,
  publishOnRequest = false,
  changesInThread = false,
}: {
  sessionId: string;
  session: ReturnType<typeof useBuildSession>;
  onLastActivity?: (iso: string | null) => void;
  publishOnRequest?: boolean;
  changesInThread?: boolean;
}) {
  const lastAt = lastBuildActivity(session.run, session.refines);
  useEffect(() => {
    onLastActivity?.(lastAt);
  }, [lastAt, onLastActivity]);
  const { shown, renderTurn } = useRefineTurns(sessionId, session, publishOnRequest);
  const [photoRetryError, setPhotoRetryError] = useState<string | null>(null);
  const [changeSending, setChangeSending] = useState(() => refineSubmittingFor(sessionId));
  const [awaitingRow, setAwaitingRow] = useState(false);
  useEffect(() => {
    setChangeSending(refineSubmittingFor(sessionId));
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ sessionId?: string; submitting?: boolean }>).detail;
      if (d?.sessionId === sessionId) setChangeSending(d.submitting === true);
    };
    const started = (e: Event) => {
      if ((e as CustomEvent<{ sessionId?: string }>).detail?.sessionId === sessionId) setAwaitingRow(true);
    };
    window.addEventListener(BUILD_REFINE_SUBMITTING_EVENT, on);
    window.addEventListener(BUILD_REFINE_STARTED_EVENT, started);
    return () => {
      window.removeEventListener(BUILD_REFINE_SUBMITTING_EVENT, on);
      window.removeEventListener(BUILD_REFINE_STARTED_EVENT, started);
    };
  }, [sessionId]);
  const changeRunning = isRefineBusy(session.refines);
  useEffect(() => {
    if (!awaitingRow) return;
    if (changeRunning) {
      setAwaitingRow(false);
      return;
    }
    const t = window.setTimeout(() => setAwaitingRow(false), 15_000);
    return () => window.clearTimeout(t);
  }, [awaitingRow, changeRunning]);
  const retryHeld = changeSending || awaitingRow || changeRunning;
  const retryPhotos = async (): Promise<boolean> => {
    setPhotoRetryError(null);
    const error = await session.sendRefine("Add photos to the site", { photoRetry: true });
    if (!error) return true;
    const e = error as { message?: string; headline?: string; detail?: string };
    setPhotoRetryError(
      typeof error === "string" ? error : e.headline ? [e.headline, e.detail].filter(Boolean).join(" ") : (e.message ?? "That change could not start."),
    );
    return false;
  };
  const run = session.run;
  const runStatus = run?.status ?? null;
  const { readyEarly, paused, failed, rootDone, building, activityStatus } =
    deriveBuildRunView(!!run, runStatus, session.appReady);
  const onRequestBuild = buildPublishesOnRequest(run?.stages ?? [], publishOnRequest);
  const neverPublished = changesPreviewOnly(session, publishOnRequest);
  const status: BuildStatus = session.liveUrl
    ? "live"
    : failed
      ? "failed"
      : building
        ? "building"
        : "none";
  const steps = useMemo(
    () => deriveBuildSteps(run?.stages ?? [], runStatus, status, publishOnRequest),
    [run?.stages, runStatus, status, publishOnRequest],
  );
  const announcedHref = session.liveAnnounce
    ? safePreviewHref(session.liveAnnounceUrl ?? session.liveUrl)
    : null;
  const liveSeenRef = useRef<{ id: string; href: string | null } | null>(null);
  useEffect(() => {
    if (!session.loaded || !run || run.id !== sessionId) return;
    const prev = liveSeenRef.current;
    liveSeenRef.current = { id: sessionId, href: announcedHref };
    if (!announcedHref) return;
    const alreadyAnnounced = liveAnnouncedInBrowser(sessionId);
    markLiveAnnouncedInBrowser(sessionId);
    if (alreadyAnnounced || !prev || prev.id !== sessionId || prev.href) return;
    toast.add({
      type: "success",
      position: "top-right",
      title: "Your site is live",
      description: announcedHref,
      actionProps: {
        children: "Open site",
        onClick: () => window.open(announcedHref, "_blank", "noopener,noreferrer"),
      },
    });
  }, [announcedHref, run, session.loaded, sessionId]);
  const elapsed = useElapsed(
    run?.createdAt ?? null,
    readyEarly || rootDone
      ? builtAtEnd(run?.stages ?? [], session.appReadyAt, run?.updatedAt ?? null, rootDone)
      : (run?.updatedAt ?? null),
    activityStatus === "building",
  );
  if (!run) return session.loaded ? null : <BuildTranscriptSkeleton />;
  const objective = cleanObjective(run.objective ?? null);
  return (
    <div className="flex flex-col" data-testid="build-transcript">
      {objective && (
        <div className="space-y-3">
          <TurnDivider prev={null} at={run.createdAt} />
          <UserBubble text={askedText(objective)} />
        </div>
      )}
      <BuildReplyRow
        className="mt-4 first:mt-0"
        footer={
          activityStatus === "ready" ? (
            <>
              <CopyMessageButton text={announcedHref ? `Your site is live: ${announcedHref}` : "Your app is ready"} />
              <RunMetaMenu
                runIds={[run.id]}
                elapsedSeconds={elapsed}
                previewHref={safePreviewHref(session.liveUrl ?? session.previewUrl)}
              />
              <BuildRating runId={run.id} label="build" />
            </>
          ) : activityStatus === "failed" ? (
            <BuildRating runId={run.id} label="build" />
          ) : null
        }
      >
        {activityStatus === "ready" ? (
          <>
            <BuildDoneSummary
              steps={steps}
              adminUrl={session.adminUrl}
              adminSetupEmail={session.adminSetupEmail}
              siteOffline={session.siteOffline}
              liveUrl={announcedHref}
              sessionId={sessionId}
              publish={session.publish}
              publishOnRequest={neverPublished}
            />
          </>
        ) : (
          <BuildActivity
            steps={steps}
            stages={run.stages}
            status={activityStatus}
            error={
              paused
                ? null
                : (stoppedBuildLine(run, canStartAgain(session), {
                    startedWork: steps.some((step) => step.state === "done"),
                  }) ?? null)
            }
            paused={paused}
            crashed={isCrashedRun(run.status, run.failure?.class)}
            elapsed={elapsed}
            stopping={false}
            canStop={false}
            onStop={() => {}}
            designRunId={run.id}
            publishOnRequest={onRequestBuild}
          />
        )}
        {activityStatus !== "ready" && canStartAgain(session) && <StartAgainActions runId={run.id} objective={run.objective} />}
        {activityStatus === "ready" && session.photos && (
          <PhotosMissingNotice
            photos={session.photos}
            disabled={retryHeld}
            waitNote={retryHeld}
            onRetry={retryPhotos}
          />
        )}
        {photoRetryError && (
          <p role="alert" data-testid="build-photos-retry-error" className="mt-2 text-[13px] leading-5 text-danger">
            {photoRetryError}
          </p>
        )}
      </BuildReplyRow>
      <SiteDesignCard runId={run.id} buildActive={activityStatus === "building"} inReplyGutter />
      {!changesInThread &&
        shown.map((refine) => (
          <Fragment key={refine.id}>
            <TurnDivider prev={null} at={refine.created_at} spacing="mt-5 mb-1" />
            {renderTurn(refine, "mt-4")}
          </Fragment>
        ))}
    </div>
  );
}

export function BuildModePane({
  sessionId,
  active = true,
  previewOpen,
  focusNonce,
  resetNonce,
  onOpenPreview,
  onPreviewUnavailable,
  onPreviewWanted,
  onPreviewProgress,
  onOpenSession,
  onNewBuild,
}: {
  sessionId: string | null;
  active?: boolean;
  previewOpen: boolean;
  focusNonce: number;
  resetNonce: number;
  onOpenPreview: (target: BuildPreviewTarget, intent?: "user") => void;
  onPreviewUnavailable: () => void;
  onPreviewWanted?: () => void;
  onPreviewProgress: (progress: BuildPreviewProgress | null) => void;
  onOpenSession: (sessionId: string, activate?: boolean) => void;
  onNewBuild: () => void;
}) {
  const draftsRef = useRef<Map<string, string>>(new Map());
  const [seed, setSeed] = useState<BuildSessionSeed | null>(null);
  const [localFocusNonce, setLocalFocusNonce] = useState(0);
  const [seenReset, setSeenReset] = useState(resetNonce);
  const [composeReset, setComposeReset] = useState<number | null>(null);
  if (seenReset !== resetNonce) {
    setSeenReset(resetNonce);
    setComposeReset(resetNonce);
  } else if (sessionId !== null && composeReset !== null) {
    setComposeReset(null);
  }
  const key = sessionId ?? NEW_SESSION_KEY;

  useEffect(() => {
    if (resetNonce === 0) return;
    draftsRef.current.delete(NEW_SESSION_KEY);
    setLocalFocusNonce((value) => value + 1);
  }, [resetNonce]);

  const onDraftChange = useCallback(
    (draft: string) => {
      if (draft) draftsRef.current.set(key, draft);
      else draftsRef.current.delete(key);
    },
    [key],
  );

  const onSessionStarted = useCallback(
    (started: BuildSessionSeed, activate: boolean) => {
      draftsRef.current.delete(NEW_SESSION_KEY);
      setSeed(started);
      onOpenSession(started.id, activate);
    },
    [onOpenSession],
  );

  return (
    <BuildSessionView
      key={`${key}:${resetNonce}`}
      sessionId={sessionId}
      seed={seed}
      active={active}
      initialDraft={draftsRef.current.get(key) ?? ""}
      onDraftChange={onDraftChange}
      previewOpen={previewOpen}
      focusNonce={focusNonce + localFocusNonce}
      onOpenPreview={onOpenPreview}
      onPreviewUnavailable={onPreviewUnavailable}
      onPreviewWanted={onPreviewWanted}
      onPreviewProgress={onPreviewProgress}
      onSessionStarted={onSessionStarted}
      onOpenSession={onOpenSession}
      onNewBuild={onNewBuild}
      startComposing={composeReset === resetNonce}
    />
  );
}

function useStartAgain(runId: string | null | undefined, objective: string | null | undefined) {
  const workspace = useWorkspaceOptional();
  const entry = useStartAgainEntry(runId);
  const [error, setError] = useState<string | null>(null);
  const brief = restartBrief(objective);
  const startAgain = useCallback(async () => {
    const current = startAgainEntry(runId);
    if (current?.status === "started") {
      workspace?.openBuildTab(current.id);
      return;
    }
    if (current) return;
    if (!brief || !runId) {
      workspace?.openBuildTab(null);
      return;
    }
    const refusal = startSiteRefusal(workspace?.role);
    if (refusal) {
      setError(refusal);
      return;
    }
    if (!claimStartAgain(runId)) return;
    setError(null);
    let newId: string | null = null;
    try {
      const result = await startBuildSession({ idea: brief, companyName: workspace?.tenantName, figma: null });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      newId = result.id;
    } finally {
      settleStartAgain(runId, newId);
    }
    workspace?.openBuildTab(newId);
  }, [brief, runId, workspace]);
  return { startAgain, starting: entry?.status === "starting", started: entry?.status === "started", error, sameBrief: brief !== null };
}

function StartAgainActions({
  runId,
  objective,
  align = "end",
}: {
  runId: string | null | undefined;
  objective: string | null | undefined;
  align?: "end" | "center";
}) {
  const { startAgain, starting, started, error, sameBrief } = useStartAgain(runId, objective);
  return (
    <div data-testid="build-start-again" className={cx("mt-3 flex flex-col gap-2", align === "end" ? "items-end" : "items-center")}>
      <button type="button" onClick={() => void startAgain()} disabled={starting} className={primaryButton()}>
        {starting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        ) : started ? (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        ) : sameBrief ? (
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Plus className="h-3.5 w-3.5" aria-hidden />
        )}
        {starting ? "Starting again…" : started ? "Open the new build" : sameBrief ? BUILD_START_AGAIN : "Start a new build"}
      </button>
      {error && (
        <p role="alert" className="text-[12px] leading-5 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function BuildStoppedPane({ runId, objective }: { runId: string | null | undefined; objective: string | null | undefined }) {
  return (
    <div data-testid="build-stopped-pane" className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-bone">
        <Square className="h-5 w-5 text-inkMuted" strokeWidth={1.75} aria-hidden />
      </span>
      <p className="text-sm font-semibold text-ink">{BUILD_STOPPED_TITLE}</p>
      <p className="max-w-sm text-[13px] leading-5 text-inkMuted">{BUILD_STOPPED_PREVIEW}</p>
      <StartAgainActions runId={runId} objective={objective} align="center" />
    </div>
  );
}

function FailedActions({
  onRetry,
  retrying,
  error,
  onNewBuild,
  stopped = false,
  startedAgain = false,
}: {
  onRetry: () => void;
  retrying: boolean;
  error: string | null;
  onNewBuild: () => void;
  stopped?: boolean;
  startedAgain?: boolean;
}) {
  return (
    <div>
      <div
        data-testid="build-failed-actions"
        className="flex flex-wrap items-center justify-end gap-2"
      >
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className={primaryButton()}
        >
          {stopped && startedAgain ? <ChevronRight className="h-3.5 w-3.5" aria-hidden /> : <RotateCw className="h-3.5 w-3.5" aria-hidden />}
          {stopped && startedAgain
            ? "Open the new build"
            : retrying
              ? (stopped ? "Starting again…" : "Trying again…")
              : stopped
                ? BUILD_START_AGAIN
                : "Try again with the same idea"}
        </button>
        <button type="button" onClick={onNewBuild} className={secondaryButton()}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Start a new build
        </button>
      </div>
      {error && <p className="mt-2 text-right text-[12px] leading-5 text-danger">{error}</p>}
    </div>
  );
}

function RefineStrip({
  appName,
  onNewBuild,
  waitsForPublish = false,
}: {
  appName: string;
  onNewBuild: () => void;
  waitsForPublish?: boolean;
}) {
  return (
    <div className="mb-2 flex items-center gap-2 px-1 text-[12px] text-inkMuted">
      <Globe2 className="h-3.5 w-3.5 shrink-0 text-inkLight" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        Editing <span className="font-medium text-ink">{appName}</span>.{" "}
        {waitsForPublish ? REFINE_STRIP_ON_REQUEST : "Each change goes to your live app."}
      </span>
      <button
        type="button"
        onClick={onNewBuild}
        className={cx(
          "shrink-0 rounded-full px-2 py-0.5 font-medium text-inkMuted hover:bg-bone hover:text-ink",
          FOCUS_RING,
        )}
      >
        Build something else
      </button>
    </div>
  );
}

export const RECENT_BUILDS_LIMIT = 5;

export const SITE_LIST_LIMIT = 50;

export function buildSessionStateLabel(state: BuildSessionMeta["state"]): string {
  if (state === "ready") return "Ready";
  if (state === "replaced") return REPLACED_BUILD_LABEL;
  if (state === "failed") return "Stopped";
  if (state === "publishing") return "Publishing";
  if (state === "publish_failed") return "Publishing didn't finish";
  return "Building";
}

function relativeDay(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function BuildStateBadge({ state }: { state: BuildSessionMeta["state"] }) {
  if (state === "replaced") {
    return (
      <span
        data-build-state="replaced"
        className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-ink/[0.06] text-inkLight"
      >
        <Check className="h-3 w-3" strokeWidth={2} aria-hidden />
      </span>
    );
  }
  if (state === "ready") {
    return (
      <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-success/15 text-success">
        <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  if (state === "publish_failed") {
    return (
      <AlertCircle
        className="h-[18px] w-[18px] shrink-0 text-danger/80"
        aria-hidden
      />
    );
  }
  if (state === "failed") {
    return (
      <XCircle
        className="h-[18px] w-[18px] shrink-0 text-danger/80"
        aria-hidden
      />
    );
  }
  return (
    <Loader2
      className="h-4 w-4 shrink-0 animate-spin text-ink motion-reduce:animate-none"
      aria-hidden
    />
  );
}

export function siteRowAsk(request: string | null | undefined, title: string): string | null {
  const asked = askedText(request ?? "").replace(/\s+/g, " ").trim();
  if (!asked || asked === title) return null;
  return asked.length > SITE_ROW_ASK_CHARS ? `${asked.slice(0, SITE_ROW_ASK_CHARS).trimEnd()}…` : asked;
}

const SITE_ROW_ASK_CHARS = 70;

export function RecentBuilds({
  sessions,
  currentSessionId,
  onOpen,
  label = "Your builds",
  limit = RECENT_BUILDS_LIMIT,
  action,
  siteNames = false,
}: {
  sessions: BuildSessionMeta[];
  currentSessionId: string | null;
  onOpen: (sessionId: string) => void;
  label?: string;
  limit?: number;
  action?: ReactNode;
  siteNames?: boolean;
}) {
  const rows = sessions.slice(0, limit);
  if (rows.length === 0) return null;
  const titleOf = (row: BuildSessionMeta) => (siteNames ? buildSessionTitle(row, true) : row.title || row.request);
  const titleUses = new Map<string, number>();
  for (const row of rows) titleUses.set(titleOf(row), (titleUses.get(titleOf(row)) ?? 0) + 1);
  const heading = (
    <h3 className="text-[14px] font-semibold uppercase tracking-[0.06em] text-inkMuted">
      {label}
    </h3>
  );
  const count = (
    <span className="text-[14px] tabular-nums text-inkLight">
      {sessions.length}
    </span>
  );
  return (
    <section aria-label={label} className="mt-6 w-full">
      <div
        className={cx(
          "mb-2 flex justify-between px-1",
          action ? "items-center" : "items-baseline",
        )}
      >
        {action ? (
          <>
            <div className="flex items-baseline gap-2">
              {heading}
              {count}
            </div>
            {action}
          </>
        ) : (
          <>
            {heading}
            {count}
          </>
        )}
      </div>
      <ol className="overflow-hidden rounded-2xl border border-rule bg-white">
        {rows.map((row) => {
          const current = row.id === currentSessionId;
          const label = buildSessionStateLabel(row.state);
          const badge = siteBadge(row.site, row.state);
          const href = row.site?.status === "live" ? siteHref(row.site) : null;
          const title = titleOf(row);
          const ask = (titleUses.get(title) ?? 0) > 1 ? siteRowAsk(row.request, title) : null;
          return (
            <li
              key={row.id}
              aria-current={current ? "true" : undefined}
              className={cx(
                "group/site relative flex items-center gap-3 border-b border-rule px-3 py-3 transition-colors last:border-b-0 hover:bg-creamDeep/60",
                current && "bg-creamDeep/40",
              )}
            >
              <BuildStateBadge state={row.state} />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpen(row.id)}
                    className="min-w-0 cursor-pointer truncate text-left text-[14px] font-medium text-ink after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ink/30"
                  >
                    {title}
                    <span className="sr-only">
                      {ask ? `, ${ask}` : ""}
                      {`, ${label}`}
                      {current ? ", current" : ""}
                    </span>
                  </button>
                  {row.site && badge ? (
                    <span
                      data-site-badge={badge.label}
                      className={cx(
                        "shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium",
                        badge.tone === "success" && "bg-success/15 text-success",
                        badge.tone === "progress" && "bg-ink/[0.06] text-ink",
                        badge.tone === "muted" && "bg-ink/[0.04] text-inkMuted",
                        badge.tone === "danger" && "bg-danger/10 text-danger",
                      )}
                    >
                      {badge.label}
                    </span>
                  ) : null}
                </span>
                {ask ? (
                  <span data-testid="site-row-ask" className="mt-0.5 block truncate text-[12px] text-inkMuted">
                    {ask}
                  </span>
                ) : null}
                {row.site ? (
                  <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-inkMuted">
                    <span className="truncate">{row.site.hostname}</span>
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${title} in a new tab`}
                        onClick={(event) => event.stopPropagation()}
                        className={cx(
                          "relative z-10 -my-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-inkLight transition-colors hover:bg-ink/[0.06] hover:text-ink",
                          FOCUS_RING,
                        )}
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                      </a>
                    ) : null}
                  </span>
                ) : null}
              </span>
              <time
                dateTime={row.last_activity_at}
                className="shrink-0 text-[12px] tabular-nums text-inkMuted"
              >
                {relativeDay(row.last_activity_at)}
              </time>
              <NextChevron
                data-testid="site-row-chevron"
                className="text-inkMuted transition-[color,transform] duration-200 group-hover/site:translate-x-0.5 group-hover/site:text-ink motion-reduce:transition-none"
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
