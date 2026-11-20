"use client";

import { creditRefusalFrom, type CreditRefusal } from "@/lib/workspace/creditRefusal";
import { oldSiteFrozenFrom, OLD_SITE_FROZEN_FALLBACK } from "@/lib/workspace/oldSiteRebuild";
import { OldSiteFrozenNotice } from "@/components/workspace/OldSiteRebuild";
import { CreditRefusalNotice } from "@/components/workspace/CreditRefusalNotice";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";
import {
  useBuildProduct,
  IDEA_MIN_CHARS,
  IDEA_MAX_CHARS,
} from "@/lib/workspace/useBuildProduct";
import { undoFailureCopy, undoSuccessNotice } from "@/lib/workspace/useBuildSession";
import { isBuilderChatRightEnabled } from "@/lib/workspace/builderChatRightFlag";
import { isBuilderClarifyEnabled } from "@/lib/workspace/builderClarifyFlag";
import { BuildClarifyStep, ideaAnswersEverything } from "./BuildClarifyStep";
import { PlanReviewCard } from "../build/PlanReviewCard";
import { combineIdeaAndPlan, fitClarifiedIdea, PLAN_APPROVE_MAX_CHARS } from "@/lib/workspace/buildPreSteps";

export { fitClarifiedIdea };
import { startSiteRefusal } from "@/lib/workspace/buildRoles";
import { useWorkspace } from "../WorkspaceShell";
import { useProductUrlState } from "../useProductUrl";
import { isOwnSite } from "../build/existingProduct";
import TextareaAutosize from "react-textarea-autosize";
import { LiveAppCard } from "./LiveAppCard";
import { BuildStatusPanel } from "./BuildStatusPanel";
import { BuilderThread, type BuilderTurn } from "./BuilderThread";
import { ThemeControls } from "./ThemeControls";
import { composePickerPrefill, type PickedElement } from "./previewPicker";
import type {
  GateEvidenceView,
  DeployStatusView,
} from "./builderThreadFormat";
import type { ChangedFile } from "./refineFiles";

const REFINE_MIN_CHARS = 8;
const REFINE_MAX_CHARS = 1000;
const THREAD_LIMIT = 5;
const POLL_MS = 8000;

type RunRow = { status: string; site_id?: string | null };
type RunsPayload = { runs: RunRow[] };

type RefineRow = {
  id: string;
  message: string;
  status: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  summary: string | null;
  pr_url: string | null;
  files?: ChangedFile[];
  gate_evidence?: GateEvidenceView | null;
  preview_url?: string | null;
  failure_message?: string | null;
  no_ship_reason?: string | null;
};
type RefinesPayload = { refines: RefineRow[] };
type DeployStatusPayload = { deploy: DeployStatusView | null };

type BuildStatusPayload = {
  run: {
    id: string;
    objective: string;
    status: string;
    created_at: string;
  } | null;
};

type BuildChip = { key: string; label: string; prompt: string };
type ChipsPayload = { chips: BuildChip[] };

function anyRunActive(runs: RunRow[]): boolean {
  return runs.some((r) => r.status === "active" || r.status === "provisioning");
}

export type BuilderRetryDecision = "wait" | "ack" | "handle";
export function builderUndoOutcome(
  status: number,
  body: { error?: { code?: string }; republished?: unknown; republish_pending?: unknown; draft_reset?: unknown } | null,
): { error: string | null; notice: string | null } {
  if (status >= 200 && status < 300) return { error: null, notice: undoSuccessNotice(body) };
  return { error: undoFailureCopy(status, body?.error?.code), notice: null };
}

export function decideBuilderRetry(s: {
  nonce: number;
  lastHandled: number;
  loaded: boolean;
  enabled: boolean;
  buildAppIntent: string;
  status: string;
  hasBuildTurn: boolean;
}): BuilderRetryDecision {
  if (!s.nonce || s.nonce === s.lastHandled) return "wait";
  if (!s.loaded) return "wait";
  if (!s.enabled || s.buildAppIntent !== "fresh") return "ack";
  if (s.status !== "failed") return "ack";
  if (!s.hasBuildTurn) return "wait";
  return "handle";
}

export function shouldShowBuilderCard(s: {
  enabled: boolean;
  buildAppIntent: string;
  buildStatus: string;
  productUrl:
    | { status: "loading" }
    | { status: "error" }
    | { status: "ok"; value: { marketing?: string } };
}): boolean {
  if (!s.enabled) return false;
  if (s.buildAppIntent !== "fresh") return false;
  if (s.buildStatus === "building" || s.buildStatus === "live") return true;
  if (s.productUrl.status !== "ok") return false;
  if (!isOwnSite(s.productUrl.value.marketing)) return true;

  return false;
}

export function ownSiteBlocksBuild(p: {
  status: "loading" | "error" | "ok";
  value?: { marketing?: string };
}): boolean {
  if (p.status !== "ok") return true;
  return isOwnSite(p.value?.marketing);
}

function formatStartedAgo(createdAt: string | null | undefined): string {
  if (!createdAt) return "";
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return " (started just now)";
  if (mins === 1) return " (started 1 min ago)";
  if (mins < 60) return ` (started ${mins} min ago)`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? " (started 1 hr ago)" : ` (started ${hrs} hrs ago)`;
}

export const HOME_BUILD_STATUS_PATH = "/api/workspace/autopilot/build-status?app=workspace";

export function workspaceRuns<T extends { site_id?: string | null }>(runs: T[]): T[] {
  return runs.filter((r) => !r.site_id);
}

export function buildChipsPath(sessionId: string | null): string | null {
  const id = sessionId?.trim();
  return id
    ? `/api/workspace/autopilot/chips?session_id=${encodeURIComponent(id)}`
    : null;
}

export function BuilderChatCard() {
  const {
    status,
    url,
    failure,
    starting,
    error: buildError,
    creditRefusal: buildCreditRefusal,
    startBuild,
    loaded,
    enabled,
    buildAppIntent,
    runId,
    stopping,
    cancelRun,
    runPaused,
    continueRun,
    continuing,
    inflightRun,
    cancelBuild,
    canceling,
  } = useBuildProduct();
  const [continueError, setContinueError] = useState<string | null>(null);
  const { tenantName, creditsEnforced, builderRetryNonce, ackBuilderRetry, openBuildTab, role } =
    useWorkspace();
  const startRefusal = startSiteRefusal(role);
  const [roleRefused, setRoleRefused] = useState(false);
  const productUrl = useProductUrlState();

  const isRefineMode = status === "live";
  const [draft, setDraft] = useState("");
  const [composerMode, setComposerMode] = useState<"build" | "plan">("build");
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const modeMenu = useDismissableMenu(modeMenuRef, modeBtnRef);
  const [planPreview, setPlanPreview] = useState<{ markdown: string; planFor: string } | null>(null);
  const [planDraft, setPlanDraft] = useState("");
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const [pendingIdea, setPendingIdea] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refineSuccess, setRefineSuccess] = useState<string | null>(null);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [refineCredit, setRefineCredit] = useState<CreditRefusal | null>(null);
  const [refineFrozen, setRefineFrozen] = useState<string | null>(null);
  const [buildTurn, setBuildTurn] = useState<BuilderTurn | null>(null);
  const [refines, setRefines] = useState<RefineRow[] | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [runActive, setRunActive] = useState(false);
  const [deploy, setDeploy] = useState<DeployStatusView | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [chips, setChips] = useState<BuildChip[]>([]);
  const [dismissedChipKeys, setDismissedChipKeys] = useState<Set<string>>(new Set());

  const mounted = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const refinesLoadedRef = useRef(false);

  const chipsElRef = useRef<HTMLDivElement | null>(null);
  const chipsWheelHandlerRef = useRef<((e: WheelEvent) => void) | null>(null);
  const chipsWheelRef = useCallback((el: HTMLDivElement | null) => {
    if (chipsElRef.current && chipsWheelHandlerRef.current) {
      chipsElRef.current.removeEventListener("wheel", chipsWheelHandlerRef.current);
    }
    chipsElRef.current = el;
    chipsWheelHandlerRef.current = null;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      const atStart = el.scrollLeft <= 0;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    chipsWheelHandlerRef.current = onWheel;
    el.addEventListener("wheel", onWheel, { passive: false });
  }, []);

  const refreshRuns = useCallback(async (): Promise<void> => {
    try {
      const res = await apiFetch("/api/workspace/autopilot/runs?app=workspace");
      if (!mounted.current || !res.ok) return;
      const payload = (await res.json()) as RunsPayload;
      if (!mounted.current) return;
      setRunActive(anyRunActive(workspaceRuns(payload.runs ?? [])));
    } catch {
    }
  }, []);

  const refreshBuildTurn = useCallback(async (): Promise<void> => {
    try {
      const res = await apiFetch(HOME_BUILD_STATUS_PATH);
      if (!mounted.current || !res.ok) return;
      const payload = (await res.json()) as BuildStatusPayload;
      if (!mounted.current) return;
      const run = payload.run;
      if (!run || !run.objective) {
        setBuildTurn(null);
        return;
      }
      const coarse: "building" | "live" | "failed" =
        status === "live" ? "live" : status === "failed" ? "failed" : "building";
      setBuildTurn({
        kind: "build",
        id: run.id,
        message: run.objective,
        status: coarse,
        created_at: run.created_at,
      });
    } catch {
    }
  }, [status]);

  const refreshRefines = useCallback(async (): Promise<void> => {
    try {
      const res = await apiFetch(
        `/api/workspace/autopilot/refines?limit=${THREAD_LIMIT}`,
      );
      if (!mounted.current) return;
      if (!res.ok) {
        if (!refinesLoadedRef.current) setThreadError(`Couldn't load history (HTTP ${res.status}).`);
        return;
      }
      const payload = (await res.json()) as RefinesPayload;
      if (!mounted.current) return;
      setRefines(payload.refines ?? []);
      refinesLoadedRef.current = true;
      setThreadError(null);
    } catch (e) {
      if (!mounted.current) return;
      if (!refinesLoadedRef.current) setThreadError((e as Error).message ?? "Network error");
    }
  }, []);

  const refreshDeploy = useCallback(async (): Promise<void> => {
    try {
      const res = await apiFetch("/api/workspace/autopilot/deploy-status");
      if (!mounted.current || !res.ok) return;
      const payload = (await res.json()) as DeployStatusPayload;
      if (!mounted.current) return;
      setDeploy(payload.deploy ?? null);
    } catch {
    }
  }, []);

  const refreshChips = useCallback(async (): Promise<void> => {
    const chipsPath = buildChipsPath(buildTurn?.id ?? null);
    if (statusRef.current !== "live" || !chipsPath) {
      setChips([]);
      return;
    }
    try {
      const res = await apiFetch(chipsPath);
      if (!mounted.current || !res.ok) return;
      const payload = (await res.json()) as ChipsPayload;
      if (!mounted.current) return;
      setChips(Array.isArray(payload.chips) ? payload.chips : []);
    } catch {
    }
  }, [buildTurn?.id]);

  useEffect(() => {
    mounted.current = true;
    if (!enabled || buildAppIntent !== "fresh") {
      return () => {
        mounted.current = false;
      };
    }
    void refreshRuns();
    void refreshBuildTurn();
    void refreshRefines();
    void refreshDeploy();
    void refreshChips();
    const tick = setInterval(() => {
      void refreshRuns();
      void refreshBuildTurn();
      void refreshRefines();
      void refreshDeploy();
      void refreshChips();
    }, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(tick);
    };
  }, [enabled, buildAppIntent, refreshRuns, refreshBuildTurn, refreshRefines, refreshDeploy, refreshChips]);

  const lastHandledRetry = useRef(0);
  useEffect(() => {
    const decision = decideBuilderRetry({
      nonce: builderRetryNonce,
      lastHandled: lastHandledRetry.current,
      loaded,
      enabled,
      buildAppIntent,
      status,
      hasBuildTurn: !!buildTurn,
    });
    if (decision === "wait") return;
    if (decision === "ack") {
      ackBuilderRetry(builderRetryNonce);
      return;
    }
    lastHandledRetry.current = builderRetryNonce;
    handleRetryBuild();
    ackBuilderRetry(builderRetryNonce);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builderRetryNonce, loaded, enabled, buildAppIntent, status, buildTurn, ackBuilderRetry]);

  if (!shouldShowBuilderCard({ enabled, buildAppIntent, buildStatus: status, productUrl }))
    return null;

  const trimmedLen = draft.trim().length;
  const minChars = isRefineMode ? REFINE_MIN_CHARS : IDEA_MIN_CHARS;
  const draftValid = trimmedLen >= minChars;
  const canSubmit = draftValid && !starting && !submitting && !(isRefineMode && runActive);
  const confirmIdea = (pendingIdea ?? draft).trim();
  const ownSiteTenant = ownSiteBlocksBuild(productUrl);
  const canConfirmBuild =
    confirmIdea.length >= minChars && !starting && !submitting && !ownSiteTenant;
  const sendActiveDisabled =
    !canSubmit || planLoading || (!isRefineMode && (confirming || clarifying));

  const refineTurns: BuilderTurn[] = (refines ?? [])
    .slice(0, THREAD_LIMIT)
    .reverse()
    .map((r) => ({
      kind: "refine" as const,
      id: r.id,
      message: r.message,
      status: r.status,
      created_at: r.created_at,
      summary: r.summary,
      pr_url: r.pr_url,
      files: r.files,
      gate_evidence: r.gate_evidence ?? null,
      preview_url: r.preview_url ?? null,
      failure_message: r.failure_message ?? null,
      no_ship_reason: r.no_ship_reason ?? null,
    }));
  const turns: BuilderTurn[] = buildTurn ? [buildTurn, ...refineTurns] : refineTurns;
  const deployTargetRefineId: string | null = (() => {
    if (!deploy) return null;
    if (deploy.pr_url) {
      return refines?.find((r) => !!r.pr_url && r.pr_url === deploy.pr_url)?.id ?? null;
    }
    return refines?.find((r) => r.status === "done" && !r.pr_url)?.id ?? null;
  })();
  const undoCandidateRefineId =
    deployTargetRefineId ??
    refines?.find((r) => r.status === "done" && !r.pr_url)?.id ??
    null;
  const threadLoading = !loaded || (refines === null && buildTurn === null);

  function requestBuild() {
    if (!canSubmit) return;
    if (startRefusal) {
      setRoleRefused(true);
      return;
    }
    if (isBuilderClarifyEnabled() && !ideaAnswersEverything(draft)) {
      setClarifying(true);
    } else {
      setPendingIdea(draft);
      setConfirming(true);
    }
  }
  function onClarifyComplete(augmentedIdea: string) {
    setPendingIdea(fitClarifiedIdea(draft, augmentedIdea, IDEA_MAX_CHARS));
    setClarifying(false);
    setConfirming(true);
  }
  function onClarifySkip() {
    setPendingIdea(draft);
    setClarifying(false);
    setConfirming(true);
  }
  async function runBuild(idea: string) {
    const runId = await startBuild({ idea, company_name: tenantName });
    if (runId) {
      setDraft("");
      setPendingIdea(null);
      void refreshBuildTurn();
      void refreshRuns();
    }
  }
  async function confirmBuild() {
    if (!canConfirmBuild) return;
    await runBuild(pendingIdea ?? draft);
    setConfirming(false);
  }
  function cancelConfirm() {
    setConfirming(false);
    setPendingIdea(null);
  }

  async function handleStopBuild(): Promise<void> {
    if (!runId || stopping) return;
    const ok = window.confirm(
      "Stop this build? Your AI team will halt work on it. You can start a new build afterward.",
    );
    if (!ok) return;
    await cancelRun();
  }

  function handleRetryBuild(): void {
    const prior = (buildTurn?.message ?? "")
      .replace(/^Build product:\s*/i, "")
      .trim();
    setComposerMode("build");
    setConfirming(false);
    setClarifying(false);
    setPendingIdea(null);
    setPlanPreview(null);
    setPlanError(null);
    if (prior) setDraft(prior);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function handleElementPicked(picked: PickedElement): void {
    setComposerMode("build");
    setDraft(composePickerPrefill(picked));
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function submitRefine(overrideMessage?: string): Promise<void> {
    const message = (overrideMessage ?? draft).trim();
    if (!overrideMessage && !canSubmit) return;
    if (message.length < REFINE_MIN_CHARS) return;
    setSubmitting(true);
    setRefineError(null);
    setRefineCredit(null);
    setRefineFrozen(null);
    setRefineSuccess(null);
    try {
      const res = await apiFetch("/api/workspace/autopilot/refine-product", {
        method: "POST",
        idempotent: true,
        body: JSON.stringify({ message, app: "workspace" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        const frozen = oldSiteFrozenFrom(body);
        if (frozen) {
          if (mounted.current) setRefineFrozen(frozen.message);
          return;
        }
        const code = body?.error?.code ?? "";
        let msg = body?.error?.message ?? `HTTP ${res.status}`;
        if (res.status === 429) {
          msg =
            code === "daily_build_limit_reached"
              ? "Daily refine limit reached. Try again tomorrow."
              : "Too many refines in a short window. Give it a minute and try again.";
        } else if (res.status === 409) {
          msg =
            code === "no_provisioned_repo"
              ? "No app to refine yet. Build one first."
              : "A build or refine is already in progress. Wait for it to finish.";
          if (code !== "no_provisioned_repo") setRunActive(true);
        } else if (res.status === 402) {
          const credit = creditRefusalFrom(body, "change");
          if (credit) {
            if (mounted.current) setRefineCredit(credit);
            return;
          }
          msg = "Refine spend cap exceeded. Increase your cap or wait.";
        }
        if (mounted.current) setRefineError(msg);
        return;
      }
      if (mounted.current) {
        setDraft("");
        setRefineSuccess("Refine started. Your app updates in a few minutes.");
        void refreshRuns();
        void refreshRefines();
      }
    } catch (e) {
      if (mounted.current) setRefineError((e as Error).message ?? "Network error");
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  async function generatePlan(): Promise<void> {
    const idea = draft.trim();
    if (idea.length < minChars) return;
    setPlanLoading(true);
    setPlanError(null);
    setPlanPreview(null);
    try {
      const res = await apiFetch("/api/workspace/autopilot/plan", {
        method: "POST",
        body: JSON.stringify({ idea, mode: isRefineMode ? "refine" : "build" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        if (mounted.current)
          setPlanError(body?.error?.message ?? "Couldn't generate a plan. Try again.");
        return;
      }
      const payload = (await res.json()) as { plan_markdown?: string };
      if (!mounted.current) return;
      if (payload.plan_markdown) {
        setPlanPreview({ markdown: payload.plan_markdown, planFor: idea });
        setPlanDraft(payload.plan_markdown);
      } else {
        setPlanError("Empty plan. Try again.");
      }
    } catch (e) {
      if (mounted.current) setPlanError((e as Error).message ?? "Network error");
    } finally {
      if (mounted.current) setPlanLoading(false);
    }
  }

  function discardPlan() {
    setPlanPreview(null);
    setPlanError(null);
    setPlanDraft("");
  }

  function approvePlan() {
    const p = planPreview;
    if (!p) return;
    const plan = planDraft.trim() || p.markdown;
    const combined = combineIdeaAndPlan(p.planFor, plan, PLAN_APPROVE_MAX_CHARS);
    setPlanPreview(null);
    setPlanDraft("");
    setComposerMode("build");
    if (isRefineMode) {
      void submitRefine(combined);
      setDraft("");
    } else {
      setPendingIdea(combined);
      setConfirming(true);
    }
  }

  function onSend() {
    if (composerMode === "plan") {
      void generatePlan();
      return;
    }
    if (isRefineMode) void submitRefine();
    else requestBuild();
  }

  async function submitUndo(refineId: string): Promise<void> {
    const ok = window.confirm(
      "Undo your last refine? This reverts the change on your live app and your AI team will push a revert commit.",
    );
    if (!ok) return;
    setUndoingId(refineId);
    setUndoError(null);
    setUndoNotice(null);
    try {
      const res = await apiFetch("/api/workspace/autopilot/refine-undo", {
        method: "POST",
        idempotent: true,
        body: JSON.stringify({ conductor_run_id: refineId, app: "workspace" }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string };
        republished?: unknown;
        draft_reset?: unknown;
      } | null;
      const outcome = builderUndoOutcome(res.status, body);
      if (outcome.error) {
        if (mounted.current) setUndoError(outcome.error);
        return;
      }
      if (mounted.current) {
        setUndoNotice(outcome.notice);
        void refreshRefines();
      }
    } catch {
      if (mounted.current) setUndoError("Couldn't undo this change. Try again.");
    } finally {
      if (mounted.current) setUndoingId(null);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  const lengthHint =
    trimmedLen > 0 && !draftValid
      ? `Add a bit more detail (at least ${minChars} characters).`
      : null;

  const visibleChips = isRefineMode
    ? chips.filter((c) => !dismissedChipKeys.has(c.key))
    : [];
  function onChipTap(chip: BuildChip) {
    setDraft(chip.prompt);
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  function dismissChip(key: string) {
    setDismissedChipKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  const composerDisabled = isRefineMode
    ? submitting || runActive
    : starting || confirming || clarifying;

  const sendLabel = isRefineMode
    ? submitting
      ? "Sending…"
      : "Send refine"
    : starting
      ? "Starting…"
      : "Build it";

  const showPreviewRail = loaded && status !== "none";
  const chatRight = showPreviewRail && isBuilderChatRightEnabled();
  const equalHeightSplit = showPreviewRail && status === "live";

  return (
    <div
      className={
        equalHeightSplit
          ?
            "grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-stretch lg:h-[min(680px,calc(100vh-6rem))]"
          : showPreviewRail
            ?
              "grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start"
            : "grid max-w-3xl grid-cols-1 gap-4"
      }
    >
      <section
        className={`rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]${
          chatRight ? " lg:order-2" : ""
        }${equalHeightSplit ? " lg:flex lg:flex-col lg:overflow-hidden" : ""}`}
      >
        <header className="mb-3 lg:shrink-0">
          <h2 className="font-display text-[16px] font-semibold tracking-tight text-ink">
            Build your app
          </h2>
          <p className="mt-1 text-[13px] leading-[1.55] text-inkSoft">
            {isRefineMode
              ? "Keep going in the same conversation. Describe a change; your AI team edits the code, redeploys, and the live preview updates."
              : ownSiteTenant
                ?
                  "The app Zavi is provisioning for you."
                : "Describe the app you want. Your AI team writes it, deploys it, and gives you a live URL. Then keep iterating right here."}
          </p>
        </header>

        {}
        {!planPreview && (
        <div className={equalHeightSplit ? "mb-3 lg:min-h-0 lg:flex-1" : "mb-3 min-h-[96px]"}>
          <BuilderThread
            inviteBuild={!ownSiteTenant || isRefineMode}
            turns={turns}
            loading={threadLoading}
            latestShippedRefineId={undoCandidateRefineId}
            deployTargetRefineId={deployTargetRefineId}
            onUndo={(id) => void submitUndo(id)}
            onRetry={(message) => void submitRefine(message)}
            undoingId={undoingId}
            runActive={runActive}
            deploy={deploy}
            fill={equalHeightSplit}
          />
        </div>
        )}

        {threadError && turns.length === 0 && (
          <p className="mb-2 text-[12px] text-red-700">{threadError}</p>
        )}

        {}
        {isRefineMode && !planPreview && (
          <ThemeControls
            onApply={(message) => void submitRefine(message)}
            disabled={submitting || runActive}
          />
        )}

        {}
        {visibleChips.length > 0 && (
          <div
            ref={chipsWheelRef}
            className="mb-2 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label="Suggested next steps"
          >
            {visibleChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[#e6e6e6] bg-[#f9f9f9] pl-3 pr-1.5 py-1 text-[12px] text-ink transition-colors hover:border-ink/20"
              >
                <button
                  type="button"
                  onClick={() => onChipTap(chip)}
                  className="font-medium hover:text-ink/70"
                >
                  {chip.label}
                </button>
                <button
                  type="button"
                  onClick={() => dismissChip(chip.key)}
                  aria-label={`Dismiss ${chip.label}`}
                  className="grid h-4 w-4 place-items-center rounded-full text-inkSoft hover:bg-ink/10 hover:text-ink"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {}
        {}
        {}
        {ownSiteTenant && !isRefineMode && productUrl.status === "ok" && (
          <p className="text-[13px] leading-[1.5] text-inkMuted">
            You already run your own site, so I don&rsquo;t start new builds
            here.
          </p>
        )}

        {(!ownSiteTenant || isRefineMode) && (
        <div
          className="relative flex flex-col gap-2 rounded-[16px] border border-[#ebecef] bg-white pb-1.5 pl-2 pr-1.5 pt-3 transition-shadow duration-150 focus-within:border-ink/30 focus-within:shadow-[0_1px_3px_rgba(14,15,17,0.06),0_0_0_3px_rgba(25,25,25,0.10)] lg:shrink-0"
          style={{ boxShadow: "0 1px 2px rgba(14,15,17,0.05)" }}
        >
          <TextareaAutosize
            ref={composerRef}
            id="workspace-build-composer"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={composerDisabled}
            minRows={2}
            maxRows={8}
            maxLength={isRefineMode ? REFINE_MAX_CHARS : IDEA_MAX_CHARS}
            aria-label={
              isRefineMode
                ? "Describe the change you want your AI team to make"
                : "Describe the app you want your AI team to build"
            }
            placeholder={
              isRefineMode
                ? "e.g. Add a contact email field to the signup form."
                : "e.g. A waitlist landing page for a coffee subscription, with an email signup form."
            }
            className="block w-full min-w-0 resize-none border-0 bg-transparent px-3 py-1 text-[16px] leading-[1.55] text-ink outline-none placeholder:text-inkMuted disabled:opacity-60"
          />

          {}
          <div className="flex w-full items-center justify-between gap-2">
            <div ref={modeMenuRef} className="relative">
                <button
                  ref={modeBtnRef}
                  type="button"
                  onClick={modeMenu.toggle}
                  aria-haspopup="menu"
                  aria-expanded={modeMenu.open}
                  className="inline-flex items-center gap-1 rounded-full border border-ink/15 bg-white px-3 py-1 text-[13px] font-medium text-ink transition-colors hover:bg-[#f2f2f2]"
                >
                  {composerMode === "plan" ? "Plan" : "Build"}
                  <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 text-inkMuted" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M3 4.5L6 7.5L9 4.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {modeMenu.open && (
                  <>
                    <div
                      role="menu"
                      className="absolute bottom-full left-0 z-20 mb-1.5 w-60 rounded-xl border border-ink/10 bg-white p-1 shadow-[0_8px_24px_rgba(25,25,25,0.12)]"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setComposerMode("build");
                          modeMenu.close();
                        }}
                        className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-[#f2f2f2]"
                      >
                        <span className={`mt-0.5 text-[13px] ${composerMode === "build" ? "text-ink" : "text-transparent"}`}>✓</span>
                        <span>
                          <span className="block text-[13px] font-semibold text-ink">Build</span>
                          <span className="block text-[12px] text-inkSoft">Make changes directly</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setComposerMode("plan");
                          modeMenu.close();
                        }}
                        className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-[#f2f2f2]"
                      >
                        <span className={`mt-0.5 text-[13px] ${composerMode === "plan" ? "text-ink" : "text-transparent"}`}>✓</span>
                        <span>
                          <span className="block text-[13px] font-semibold text-ink">Plan</span>
                          <span className="block text-[12px] text-inkSoft">Discuss before building</span>
                        </span>
                      </button>
                    </div>
                  </>
                )}
            </div>

            <button
              type="button"
              onClick={onSend}
              disabled={sendActiveDisabled}
              aria-label={composerMode === "plan" ? "Draft a plan" : sendLabel}
              title={composerMode === "plan" ? "Draft a plan" : sendLabel}
              className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors ${
                sendActiveDisabled
                  ? "cursor-not-allowed bg-[#d9d9d9] text-white"
                  : "cursor-pointer bg-ink text-cream hover:bg-inkSoft"
              }`}
            >
              <svg aria-hidden viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="currentColor">
                <path d="M1.5 2.106C1.5 1.644 1.998 1.352 2.401 1.578L18.101 9.292C18.2228 9.35195 18.3255 9.4447 18.3976 9.55982C18.4696 9.67493 18.5081 9.80786 18.5087 9.94364C18.5093 10.0794 18.472 10.2127 18.4011 10.3285C18.3301 10.4442 18.2283 10.5379 18.107 10.599L2.501 18.46L2.431 18.477C2.32011 18.5038 2.20459 18.505 2.09313 18.4807C1.98168 18.4564 1.8772 18.4071 1.78757 18.3365C1.69794 18.2659 1.62549 18.1759 1.57568 18.0733C1.52586 17.9707 1.49999 17.8581 1.5 17.744V13.172C1.5 11.952 2.471 10.926 3.713 10.904L10.26 10.734C10.53 10.724 11.01 10.491 11.01 9.937C11.01 9.384 10.51 9.142 10.26 9.142L3.713 8.971C2.47 8.95 1.5 7.924 1.5 6.704V2.106Z" />
              </svg>
            </button>
          </div>
        </div>
        )}

        {}
        {planLoading && (
          <p className="mt-2 text-[12px] text-inkSoft" aria-live="polite">
            Drafting a plan…
          </p>
        )}
        {planError && (
          <p className="mt-2 text-[12px] text-red-700">{planError}</p>
        )}
        {planPreview && (
          <PlanReviewCard
            markdown={planPreview.markdown}
            draft={planDraft}
            onDraftChange={setPlanDraft}
            approveLabel={isRefineMode ? "Approve & apply" : "Approve & build"}
            approveDisabled={submitting || starting}
            onApprove={approvePlan}
            onDiscard={discardPlan}
          />
        )}

        {lengthHint && <p className="mt-2 text-[12px] text-inkSoft">{lengthHint}</p>}

        {}
        {!isRefineMode && clarifying && (
          <BuildClarifyStep
            idea={draft}
            onComplete={onClarifyComplete}
            onSkip={onClarifySkip}
          />
        )}

        {}
        {!isRefineMode && confirming && (
          <div
            role="alertdialog"
            aria-label="Confirm building your app"
            className="mt-3 rounded-lg border border-marigoldDeep/50 bg-marigold/15 p-4"
          >
            <p className="text-[13px] font-semibold text-ink">
              This sets up real, billable infrastructure.
            </p>
            <p className="mt-1 text-[13px] leading-[1.55] text-inkSoft">
              Building your app provisions a code repository, a database, and
              hosting under your account. It may take a few minutes, and the
              infrastructure incurs real costs. Continue?
            </p>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void confirmBuild()}
                disabled={!canConfirmBuild}
                className="shrink-0 rounded-full border border-transparent bg-ink px-4 py-1.5 text-[13px] font-semibold text-cream transition-colors hover:bg-ink/90 disabled:opacity-60"
              >
                {starting ? "Starting…" : "Yes, build it"}
              </button>
              <button
                type="button"
                onClick={cancelConfirm}
                disabled={starting}
                className="shrink-0 rounded-full border border-ink/15 bg-white px-4 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:bg-[#f2f2f2] disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {}
        {isRefineMode && runActive && !refineError && (
          <p className="mt-2 text-[12px] text-inkSoft">
            A build or refine is already running. You can queue another once it
            finishes.
          </p>
        )}

        {refineSuccess && (
          <p role="status" aria-live="polite" className="mt-2 text-[12px] text-emerald-700">
            {refineSuccess}
          </p>
        )}

        {}
        {roleRefused && startRefusal && !isRefineMode && (
          <p role="alert" className="mt-2 text-[12px] text-red-700">{startRefusal}</p>
        )}
        {buildError && !isRefineMode && inflightRun && (
          <div className="mt-2 text-[12px] text-red-700">
            <p>
              A build is already running{formatStartedAgo(inflightRun.created_at)}. Cancel it to
              start a new one.
            </p>
            <button
              type="button"
              onClick={() => void cancelBuild(inflightRun.run_id)}
              disabled={canceling}
              className="mt-1 rounded-cta border border-red-300 px-2 py-1 text-[12px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              {canceling ? "Cancelling…" : "Cancel build"}
            </button>
          </div>
        )}
        {buildError && !isRefineMode && !inflightRun && buildCreditRefusal && (
          <CreditRefusalNotice refusal={buildCreditRefusal} className="mt-2" />
        )}
        {buildError && !isRefineMode && !inflightRun && !buildCreditRefusal && (
          <p className="mt-2 text-[12px] text-red-700">
            Couldn&apos;t start the build: {buildError}
          </p>
        )}
        {refineCredit && <CreditRefusalNotice refusal={refineCredit} className="mt-2" />}
        {refineFrozen && <OldSiteFrozenNotice message={refineFrozen} className="mt-2" />}
        {refineError && (
          <p className="mt-2 text-[12px] text-red-700">
            Couldn&apos;t start the refine: {refineError}
          </p>
        )}
        {undoError && undoError === OLD_SITE_FROZEN_FALLBACK && (
          <OldSiteFrozenNotice message={undoError} className="mt-2" />
        )}
        {undoError && undoError !== OLD_SITE_FROZEN_FALLBACK && (
          <p role="alert" className="mt-2 text-[12px] text-red-700">{undoError}</p>
        )}
        {undoNotice && (
          <p role="status" aria-live="polite" className="mt-2 text-[12px] text-slate-600">{undoNotice}</p>
        )}
      </section>

      {}
      {showPreviewRail && (
        <div
          className={`flex flex-col gap-4${
            equalHeightSplit ? " lg:h-full lg:min-h-0" : ""
          }${chatRight ? " lg:order-1" : ""}`}
        >
          {status === "building" && (
            <BuildStatusPanel
              active
              creditsEnforced={creditsEnforced}
              onOpenBuild={openBuildTab ? (id) => void openBuildTab(id, { push: true }) : undefined}
            />
          )}
          {}
          {status === "building" && runId && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleStopBuild()}
                disabled={stopping}
                className="inline-flex items-center gap-2 rounded-full border border-ink/15 bg-white px-3.5 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:bg-bone disabled:cursor-not-allowed disabled:opacity-60"
              >
                {stopping ? "Stopping…" : "Stop build"}
              </button>
            </div>
          )}
          <LiveAppCard
            status={status}
            url={url}
            failure={failure}
            onElementPicked={handleElementPicked}
          />
          {}
          {}
          {status === "failed" && runPaused && (
            <div className="flex flex-col items-end gap-2">
              <p className="text-[12px] text-inkSoft">Everything built so far is saved.</p>
              <button
                type="button"
                onClick={() => {
                  setContinueError(null);
                  void continueRun().then((err) => setContinueError(err));
                }}
                disabled={continuing}
                className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-cream transition-colors hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-60"
              >
                {continuing ? "Continuing…" : "Continue build"}
              </button>
              {continueError && <p className="text-[12px] text-danger">{continueError}</p>}
            </div>
          )}
          {status === "failed" && !runPaused && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleRetryBuild}
                className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-cream transition-colors hover:bg-inkSoft"
              >
                Retry build
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
