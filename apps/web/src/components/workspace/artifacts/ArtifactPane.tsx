"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import type { ReportModel } from "@zavi/shared";
import { useResizablePane } from "@/hooks/useResizablePane";
import { artifactRenderMode } from "./artifactRender";
import { ViewerBody } from "./ArtifactViewer";
import { DownloadMenu, type DownloadOption } from "./DownloadMenu";
import { formatArtifactBytes } from "./formatArtifact";
import { PREVIEW_PANE_ICON_BUTTON } from "./previewPaneStyles";
import {
  THREAD_PANE_COLLAPSED_FRACTION,
  THREAD_PANE_DEFAULT_PX,
  THREAD_PANE_MAX_PX,
  THREAD_PANE_MIN_PX,
} from "../sidePaneSize";
import { AnalysisReport } from "../analysis/AnalysisReport";
import { downloadReportCsv, downloadReportMarkdown } from "../analysis/reportDownloads";
import type { Artifact } from "./types";

export const ARTIFACT_PANE_MIN_PX = THREAD_PANE_MIN_PX;
export const ARTIFACT_PANE_DEFAULT_PX = THREAD_PANE_DEFAULT_PX;
export const ARTIFACT_PANE_MAX_PX = THREAD_PANE_MAX_PX;

export const PANE_MAXIMIZE_MS = 320;

function isInHiddenTab(el: HTMLElement | null): boolean {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (typeof window !== "undefined" && window.getComputedStyle(n).display === "none") return true;
  }
  return false;
}

export function ArtifactPane({
  artifact,
  onClose,
  onDownload,
  report,
  resizable = true,
  autoOpened = false,
  containerRef,
}: {
  artifact: Artifact;
  onClose: () => void;
  onDownload: () => void;
  report?: { summary: string; sources: string | null; createdAt: string; threadId?: string | null };
  resizable?: boolean;
  autoOpened?: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const mode = artifactRenderMode(artifact.mime, artifact.filename);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [floating, setFloating] = useState(false);
  const [entering, setEntering] = useState(true);
  const [reportModel, setReportModel] = useState<ReportModel | null>(null);
  const [leftPx, setLeftPx] = useState(0);
  const paneRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const paneTitle = artifact.title?.trim() || artifact.filename || (report ? "Report" : "Document");

  const { sizePx, dragging, separatorProps } = useResizablePane({
    containerRef,
    min: ARTIFACT_PANE_MIN_PX,
    maxFn: (vw) =>
      Math.max(
        ARTIFACT_PANE_MIN_PX,
        Math.min(ARTIFACT_PANE_MAX_PX, vw - ARTIFACT_PANE_MIN_PX),
      ),
    round: "result",
    defaultPx: ARTIFACT_PANE_DEFAULT_PX,
    resetTo: () => ARTIFACT_PANE_DEFAULT_PX,
    storageKey: "zavi.sidePane.widthPx",
    keyboard: true,
    ariaLabel: "Resize document preview",
  });

  useEffect(() => {
    if (typeof document !== "undefined") {
      const active = document.activeElement;
      openerRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
    }
    if (!autoOpened) headingRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeAndRestore = useCallback(() => {
    const target = openerRef.current;
    onClose();
    if (target) requestAnimationFrame(() => target.focus());
  }, [onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isInHiddenTab(headingRef.current)) return;
      if (paneRef.current?.querySelector('[data-menu-open="true"]')) return;
      event.stopPropagation();
      closeAndRestore();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeAndRestore]);

  const fileExt = artifact.filename.includes(".") ? artifact.filename.split(".").pop() ?? "" : "";
  const downloadOptions: DownloadOption[] =
    mode === "ui-block"
      ? report && reportModel
        ? [
            {
              key: "csv",
              format: "csv",
              label: "Data as CSV",
              meta: `${reportModel.rows.length} ${reportModel.rows.length === 1 ? "row" : "rows"} · opens in Excel or Sheets`,
              onSelect: () => downloadReportCsv(reportModel),
            },
            {
              key: "md",
              format: "md",
              label: "Report as Markdown",
              meta: "Summary, numbers and table",
              onSelect: () => downloadReportMarkdown(reportModel, report.summary),
            },
          ]
        : []
      : mode === "page"
        ? [
            { key: "page", format: "page", label: "Open page in a new tab", meta: artifact.title, onSelect: onDownload },
          ]
        : [
          {
            key: "file",
            format: fileExt.slice(0, 4) || "file",
            label: artifact.filename,
            meta: artifact.bytes > 0 ? `${formatArtifactBytes(artifact.bytes)} · original file` : "Original file",
            onSelect: onDownload,
          },
        ];

  const dockedWidth = !resizable
    ? `${THREAD_PANE_COLLAPSED_FRACTION * 100}%`
    : sizePx === null
      ? `${ARTIFACT_PANE_DEFAULT_PX}px`
      : `${sizePx}px`;

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const toggleMaximized = () => {
    const pane = paneRef.current;
    const row = containerRef.current;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setEntering(false);
    if (!maximized) {
      const start = pane && row ? pane.getBoundingClientRect().left - row.getBoundingClientRect().left : 0;
      setLeftPx(Math.max(0, start));
      setFloating(true);
      setMaximized(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setLeftPx(0)));
      return;
    }
    const rowWidth = row?.getBoundingClientRect().width ?? 0;
    const docked = !resizable
      ? rowWidth * THREAD_PANE_COLLAPSED_FRACTION
      : (sizePx ?? ARTIFACT_PANE_DEFAULT_PX);
    setLeftPx(Math.max(0, rowWidth - docked));
    setMaximized(false);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setFloating(false);
    }, PANE_MAXIMIZE_MS);
  };

  return (
    <>
      {floating && <div aria-hidden className="h-full shrink-0" style={{ width: dockedWidth }} />}
      <aside
        ref={paneRef}
        role="complementary"
        aria-label="Document preview"
        style={
          floating
            ? { left: `${leftPx}px`, transition: `left ${PANE_MAXIMIZE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` }
            : { width: dockedWidth, transition: dragging ? "none" : undefined }
        }
        className={`flex min-h-0 min-w-0 max-w-full flex-row bg-white ${
          floating
            ? "absolute inset-y-0 right-0 z-30 border-l border-[#ececec] motion-reduce:!transition-none"
            : `relative z-0 h-full shrink-0 border-l border-[#ececec] ${entering ? "animate-slide-in-right motion-reduce:animate-none" : ""}`
        }`}
        data-testid="artifact-pane"
        data-maximized={maximized ? "true" : undefined}
      >
        {resizable && !floating && (
          <div
            {...separatorProps}
            className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize bg-transparent transition-colors hover:bg-ink/10 focus:bg-ink/20 focus:outline-none"
            data-testid="artifact-pane-resizer"
          />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-[60px] shrink-0 items-center justify-between gap-3 border-b border-[#ececec] pl-6 pr-4">
            <h2
              ref={headingRef}
              tabIndex={-1}
              title={paneTitle}
              className="min-w-0 truncate text-[22px] font-medium leading-7 tracking-[-0.01em] text-ink focus:outline-none"
            >
              {paneTitle}
            </h2>
            <div className="flex shrink-0 items-center gap-1">
              {(mode !== "ui-block" || report) && (
                <DownloadMenu options={downloadOptions} disabled={downloadOptions.length === 0} />
              )}
              <button
                type="button"
                onClick={toggleMaximized}
                aria-label={maximized ? "Minimize preview" : "Maximize preview"}
                aria-pressed={maximized}
                title={maximized ? "Minimize" : "Maximize"}
                className={PREVIEW_PANE_ICON_BUTTON}
              >
                {maximized ? (
                  <Minimize2 className="size-5" strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Maximize2 className="size-5" strokeWidth={1.75} aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                onClick={closeAndRestore}
                aria-label="Close document preview"
                title="Close"
                className={PREVIEW_PANE_ICON_BUTTON}
              >
                <X className="size-5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {mode === "ui-block" && report ? (
              <AnalysisReport
                artifactId={artifact.id}
                previewUrl={artifact.preview_url}
                summary={report.summary}
                sources={report.sources}
                createdAt={report.createdAt}
                onModel={setReportModel}
              />
            ) : (
              <ViewerBody artifact={artifact} mode={mode} onDownload={onDownload} />
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
