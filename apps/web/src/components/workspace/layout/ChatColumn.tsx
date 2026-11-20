"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Monitor,
  Plus,
} from "lucide-react";
import { MobileBackIcon } from "@/components/mobile";
import {
  CompactHeaderSlotProvider,
  createCompactHeaderSlot,
} from "./compactHeaderSlot";
import { useOpenChannelSlug } from "./ChannelsPage";
import { useWorkspace } from "../WorkspaceShell";
import { useBuildSessions } from "@/lib/workspace/useBuildSessions";
import { WorkspacePane } from "../WorkspacePane";
import { cx, FOCUS_RING } from "./shared";
import type { ColumnChrome } from "./columnChrome";
import { agentDisplayName } from "@/lib/agentRegistry";
import type { WorkspaceMode } from "../ZaviWelcome";
import { BuildModePane } from "../build/BuildModePane";
import { BuildSetupFrame } from "../setup/BuildSetupPanel";
import { ExistingProductPane } from "../build/ExistingProductPane";
import { isOwnSite } from "../build/existingProduct";
import { retryProductUrl, useProductUrlState } from "../useProductUrl";
import type { BuildPreviewProgress, BuildPreviewTarget } from "../build/BuildPreviewPanel";
import { guardLeave } from "@/lib/workspace/unappliedEdits";

const ZAVI = "operator";

export function ChatColumn({
  chrome,
  compactLeading,
  compactTrailing,
  fullPage,
  onExitFullPage,
  showExitFullPage = true,
  displayTabId,
  workspaceMode,
  previewOpen,
  buildFocusNonce,
  buildResetNonce,
  onResetBuild,
  onOpenBuildPreview,
  onCloseBuildPreview,
  onBuildPreviewUnavailable,
  onBuildPreviewWanted,
  onBuildPreviewProgress,
  onShowBuildApp,
}: {
  chrome: ColumnChrome;
  compactLeading?: ReactNode;
  compactTrailing?: ReactNode;
  fullPage: boolean;
  onExitFullPage: () => void;
  showExitFullPage?: boolean;
  chatFocus: boolean;
  displayTabId?: string;
  workspaceMode: WorkspaceMode;
  previewOpen: boolean;
  buildFocusNonce: number;
  buildResetNonce: number;
  onResetBuild: () => void;
  onOpenBuildPreview: (target: BuildPreviewTarget, intent?: "user") => void;
  onCloseBuildPreview: () => void;
  onBuildPreviewUnavailable: () => void;
  onBuildPreviewWanted?: () => void;
  onBuildPreviewProgress: (progress: BuildPreviewProgress | null) => void;
  onShowBuildApp?: () => void;
}) {
  const inChannel = useOpenChannelSlug() !== null;
  const [compactHeaderSlot] = useState(createCompactHeaderSlot);
  const attachCompactHeaderSlot = useCallback(
    (host: HTMLDivElement | null) => {
      if (!host || !compactHeaderSlot || host.contains(compactHeaderSlot)) return;
      host.append(compactHeaderSlot);
    },
    [compactHeaderSlot],
  );
  const {
    tabs,
    activeTabId: workspaceActiveTabId,
    openBuildTab,
    buildSessionId,
  } = useWorkspace();
  const activeTabId = displayTabId ?? workspaceActiveTabId;
  const active = tabs.find((t) => t.id === activeTabId);
  const activeSlug =
    active?.kind === "agent" ? (active.payload as { slug: string }).slug : null;
  const isBuild = active?.kind === "build";
  const hoverSurface = isBuild
    ? "build-chat-hover hover:bg-cream"
    : "hover:bg-bone";
  const builderEligible =
    active?.kind === "home" || activeSlug === ZAVI || isBuild;
  const buildEligibleSurface = !fullPage && builderEligible;

  const { sessions: buildSessions = [], loaded: buildSessionsLoaded, failed: buildSessionsFailed } = useBuildSessions();
  const buildState = buildSessionId
    ? (buildSessions.find((s) => s.id === buildSessionId)?.state ?? null)
    : null;
  const buildStateLabel =
    buildState === "ready"
      ? "Ready"
      : buildState === "failed"
        ? "Stopped"
        : buildState === "building"
          ? "Building"
          : null;
  const productUrl = useProductUrlState();
  const ownProduct = buildSessionId
    ? false
    : productUrl.status !== "ok"
      ? null
      : !isOwnSite(productUrl.value.marketing)
        ? false
        : buildSessionsLoaded || buildSessionsFailed
          ? buildSessions.length === 0
          : null;

  const lastChatTabId = useRef<string | null>(null);
  if (active && (active.kind === "home" || active.kind === "agent")) {
    lastChatTabId.current = active.id;
  }
  const homeTabId = tabs.find((t) => t.kind === "home")?.id;
  const growTabId = isBuild
    ? (tabs.some((t) => t.id === lastChatTabId.current)
        ? lastChatTabId.current
        : homeTabId) ?? undefined
    : displayTabId;

  useEffect(() => {
    if (!builderEligible && previewOpen) onCloseBuildPreview();
  }, [builderEligible, onCloseBuildPreview, previewOpen]);

  const title = isBuild
    ? "Build"
    : activeSlug !== null
      ? agentDisplayName(activeSlug)
      : active?.kind === "home"
        ? agentDisplayName(ZAVI)
        : (active?.title ?? "Chat");

  return (
    <section
      id="zavi-main"
      aria-label={fullPage ? title : isBuild ? "Build" : "Chat"}
      className={cx(
        "flex min-h-0 flex-col overflow-hidden shadow-elev compact:rounded-none compact:shadow-none",
        isBuild
          ? "build-chat-card rounded-2xl bg-[#f9f9f9]"
          : "rounded-2xl bg-cream",
        fullPage ? "absolute inset-0 z-20 min-w-0" : "min-w-0 flex-1",
      )}
    >
      <div
        {...(fullPage ? {} : chrome.dropProps)}
        className={cx(
          fullPage
            ? cx(
                "absolute left-2 top-2 z-10 flex h-8 items-center compact:static compact:h-14 compact:px-1.5 compact:pt-2",
                inChannel && "compact:hidden",
              )
            :
              isBuild
                ? "grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 pt-1 [container-type:inline-size] compact:h-14 compact:px-1.5 compact:pt-2"
                :                 "relative h-6 shrink-0 compact:flex compact:h-14 compact:items-center compact:px-1.5 compact:pt-2",
        )}
      >
        <div className="min-w-0 compact:flex compact:items-center compact:gap-0.5">
          {fullPage ? (
            <>
            {compactLeading}
            {showExitFullPage && (
            <button
              type="button"
              onClick={onExitFullPage}
              aria-label="Back to chat"
              title="Back to chat"
              className={cx(
                `inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-inkLight ${hoverSurface} hover:text-ink compact:h-12 compact:w-12`,
                FOCUS_RING,
              )}
            >
              <ArrowLeft className="h-4 w-4 compact:hidden" aria-hidden />
              <MobileBackIcon className="hidden h-[22px] w-[22px] compact:block" />
            </button>
            )}
            </>
          ) : (
            <div className="flex items-center gap-0.5">
              {compactLeading}
            </div>
          )}
        </div>
        {fullPage ? (
          <h2 className="hidden min-w-0 flex-1 truncate px-2 text-center text-[20px] font-bold tracking-[-0.01em] text-ink compact:block">
            {title}
          </h2>
        ) : null}
        <div
          ref={attachCompactHeaderSlot}
          className={cx(
            "hidden flex-none items-center justify-end gap-1",
            fullPage && "compact:flex",
          )}
          style={fullPage ? { minWidth: showExitFullPage ? 88 : 44 } : undefined}
        />
        {!fullPage && !isBuild && compactTrailing ? (
          <div className="ml-auto flex items-center">{compactTrailing}</div>
        ) : null}
        {}
        {!fullPage && isBuild && (
          <h2 className="invisible flex min-w-0 items-center justify-center gap-2 truncate text-center text-[14px] font-semibold text-ink compact:visible">
            <span>Build</span>
            {buildStateLabel && (
              <span
                className={cx(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium compact:hidden",
                  buildState === "ready" && "bg-success/15 text-success",
                  buildState === "failed" && "bg-danger/10 text-danger",
                  buildState === "building" && "bg-ink/10 text-ink",
                )}
              >
                {buildStateLabel}
              </span>
            )}
          </h2>
        )}
        {!fullPage && isBuild && ownProduct === false && buildSessionId && (
          <div className="flex items-center justify-self-end gap-1 compact:gap-2">
          {!previewOpen && onShowBuildApp && (
            <button
              type="button"
              aria-label="Show the app"
              title="Show the app"
              onClick={onShowBuildApp}
              className={cx(
                `inline-flex h-8 w-8 items-center justify-center rounded-cta text-inkMuted ${hoverSurface} hover:text-ink lg:hidden compact:h-10 compact:w-10 compact:rounded-full compact:border compact:border-rule compact:text-ink relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']`,
                FOCUS_RING,
              )}
            >
              <Monitor className="h-4 w-4 compact:h-[18px] compact:w-[18px]" aria-hidden />
            </button>
          )}
          <button
            type="button"
            aria-label="New build"
            title="New build"
            onClick={() => guardLeave(onResetBuild)}
            className={cx(
              `inline-flex h-8 items-center justify-self-end gap-2 whitespace-nowrap rounded-cta px-2.5 text-[13px] font-medium text-inkMuted ${hoverSurface} hover:text-ink`,
              builderEligible && "[@container(max-width:340px)]:px-2",
              "compact:h-10 compact:w-10 compact:justify-center compact:gap-0 compact:rounded-full compact:border compact:border-rule compact:px-0 compact:text-ink relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']",
              FOCUS_RING,
            )}
          >
            <Plus className="h-4 w-4 compact:h-[18px] compact:w-[18px]" aria-hidden />
            <span
              className={cx(
                builderEligible && "[@container(max-width:340px)]:hidden",
                "compact:hidden",
              )}
            >
              New build
            </span>
          </button>
          </div>
        )}
      </div>
      <CompactHeaderSlotProvider element={compactHeaderSlot}>
      <div className="min-h-0 flex-1">
        {!fullPage && builderEligible ? (
          <>
            <div
              className={cx(
                "h-full min-h-0 animate-mode-switch motion-reduce:animate-none",
                !isBuild && "hidden",
              )}
              aria-hidden={!isBuild}
            >
              {productUrl.status === "error" && !buildSessionId ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-inkMuted">
                  <p>Could not load your product details.</p>
                  <button
                    type="button"
                    onClick={() => void retryProductUrl()}
                    className={cx("rounded-cta border border-rule px-3 py-1.5 font-medium text-ink", hoverSurface, FOCUS_RING)}
                  >
                    Try again
                  </button>
                </div>
              ) : ownProduct === null ? null : ownProduct ? (
                <ExistingProductPane />
              ) : (
                <BuildSetupFrame>
                  <BuildModePane
                    sessionId={buildSessionId}
                    active={isBuild}
                    previewOpen={previewOpen}
                    focusNonce={buildFocusNonce}
                    resetNonce={buildResetNonce}
                    onOpenPreview={onOpenBuildPreview}
                    onPreviewUnavailable={onBuildPreviewUnavailable}
                    onPreviewWanted={onBuildPreviewWanted}
                    onPreviewProgress={onBuildPreviewProgress}
                    onOpenSession={(id, activate = isBuild) =>
                      guardLeave(() => openBuildTab(id, { activate }))
                    }
                    onNewBuild={() => guardLeave(onResetBuild)}
                  />
                </BuildSetupFrame>
              )}
            </div>
            <div
              className={cx(
                "h-full min-h-0 animate-mode-switch motion-reduce:animate-none",
                isBuild && "hidden",
              )}
              aria-hidden={isBuild}
            >
              <WorkspacePane
                chatOnly
                homeAgentSlug={ZAVI}
                activeTabIdOverride={growTabId}
                workspaceMode="grow"
              />
            </div>
          </>
        ) : (
          <WorkspacePane
            chatOnly
            homeAgentSlug={ZAVI}
            activeTabIdOverride={buildEligibleSurface ? growTabId : displayTabId}
            workspaceMode={buildEligibleSurface ? "grow" : workspaceMode}
          />
        </div>
      </div>
      </CompactHeaderSlotProvider>
    </section>
  );
}
