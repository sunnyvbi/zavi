"use client";

import { useEffect, useRef } from "react";
import { Download, ExternalLink, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Portal } from "@/components/ui/Portal";
import { cn } from "@/lib/cn";
import { Markdown } from "../Markdown";
import { harden } from "../HtmlPreviewFrame";
import { UiBlockArtifact } from "../UiBlockArtifact";
import { useModalFocusTrap } from "../layout/shared";
import {
  artifactRenderMode,
  isUrlRenderMode,
  parseCsv,
  type ArtifactRenderMode,
} from "./artifactRender";
import { formatArtifactBytes, formatArtifactDate } from "./formatArtifact";
import { useArtifactContent } from "./useArtifactContent";
import { artifactTypeLabel, type Artifact } from "./types";

const CSV_ROW_CAP = 200;

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-8 py-16 text-center text-base text-inkMuted">
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

function CsvTable({ text }: { text: string }) {
  const rows = parseCsv(text, CSV_ROW_CAP + 1);
  if (rows.length === 0) return <Centered>This spreadsheet is empty.</Centered>;
  const [header, ...body] = rows;
  const shown = body.slice(0, CSV_ROW_CAP);
  return (
    <div className="p-4">
      {}
      <div className="max-h-[70vh] overflow-auto" data-testid="csv-table">
        <table className="min-w-full border-separate border-spacing-0 text-left text-[13px]">
          <thead>
            <tr>
              {header.map((cell, i) => (
                <th
                  key={i}
                  title={cell}
                  className={cn(
                    "sticky top-0 z-10 whitespace-nowrap border-b border-rule bg-creamDeep px-3 py-2 font-semibold text-ink",
                    i === 0 && "left-0 z-20 border-r",
                  )}
                >
                  <div className="max-w-[280px] truncate">{cell}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r} className="even:bg-creamDeep/40">
                {header.map((_, c) => (
                  <td
                    key={c}
                    title={row[c] ?? ""}
                    className={cn(
                      "whitespace-nowrap border-b border-rule px-3 py-1.5 align-top text-inkSoft",
                      c === 0 && "sticky left-0 z-[1] border-r bg-cream font-medium text-ink",
                    )}
                  >
                    <div className="max-w-[280px] truncate">{row[c] ?? ""}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {body.length > shown.length && (
        <p className="px-3 py-3 text-xs text-inkLight">
          Showing the first {CSV_ROW_CAP} rows. Download the file for the rest.
        </p>
      )}
    </div>
  );
}

export function ViewerBody({
  artifact,
  mode,
  onDownload,
}: {
  artifact: Artifact;
  mode: ArtifactRenderMode;
  onDownload: () => void;
}) {
  const { url, text, loading, error, tooLarge } = useArtifactContent(artifact);

  if (mode === "ui-block") {
    return (
      <div className="p-6">
        <UiBlockArtifact
          artifact={artifact}
          fallback={<Centered>This dashboard could not be drawn.</Centered>}
          expanded
        />
      </div>
    );
  }

  if (mode === "page") {
    return artifact.preview_url === null ? (
      <Centered>This page is no longer available.</Centered>
    ) : (
      <iframe
        src={artifact.preview_url}
        title={artifact.title}
        sandbox="allow-scripts allow-same-origin allow-popups"
        className="h-full w-full border-0 bg-white"
      />
    );
  }

  if (mode === "unsupported") {
    return (
      <Centered>
        <p className="text-ink">Zavi can’t display a {artifact.filename.split(".").pop()} file yet.</p>
        <Button onClick={onDownload} className="mt-4">
          Download instead
        </Button>
      </Centered>
    );
  }

  if (tooLarge) {
    return (
      <Centered>
        <p className="text-ink">
          This file is {formatArtifactBytes(artifact.bytes)}, too large to open in the browser.
        </p>
        <Button onClick={onDownload} className="mt-4">
          Download instead
        </Button>
      </Centered>
    );
  }

  if (loading) {
    return (
      <div role="status" aria-label={`Loading ${artifact.title}`} className="space-y-3 p-6">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-4 animate-pulse rounded bg-ink/10"
            style={{ width: `${92 - i * 13}%`, animationDelay: `${i * 110}ms` }}
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Centered>
        <p className="text-danger">{error}</p>
        <Button onClick={onDownload} className="mt-4">
          Download instead
        </Button>
      </Centered>
    );
  }

  switch (mode) {
    case "html":
      return text === null ? <Centered>Nothing to show.</Centered> : (
        <div className="flex min-h-0 flex-1 flex-col">
          <iframe
            srcDoc={harden(text)}
            title={`Preview of ${artifact.title}`}
            sandbox=""
            referrerPolicy="no-referrer"
            className="h-full w-full flex-1 bg-[#fff]"
          />
          <p className="border-t border-rule px-4 py-2 text-xs text-inkLight">
            Read-only render. Links and buttons inside the page are inert.
          </p>
        </div>
      );
    case "markdown":
      return text === null ? <Centered>Nothing to show.</Centered> : (
        <div className="p-6">
          <Markdown source={text} disableActionLinks />
        </div>
      );
    case "csv":
      return text === null ? <Centered>Nothing to show.</Centered> : <CsvTable text={text} />;
    case "text":
      return text === null ? <Centered>Nothing to show.</Centered> : (
        <pre className="whitespace-pre-wrap break-words p-6 font-mono text-xs leading-relaxed text-ink">
          {text}
        </pre>
      );
    case "pdf":
      return url === null ? <Centered>Nothing to show.</Centered> : (
        <object
          data={url}
          type="application/pdf"
          aria-label={`Preview of ${artifact.title}`}
          className="min-h-[24rem] w-full flex-1 bg-[#fff]"
        >
          <Centered>
            <p className="text-ink">This browser can’t display a PDF inline.</p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-md border border-rule bg-cream h-10 px-3 text-xs font-medium text-ink hover:bg-creamDeep"
              >
                Open in a new tab
              </a>
              <Button onClick={onDownload}>Download</Button>
            </div>
          </Centered>
        </object>
      );
    case "image":
      return url === null ? <Centered>Nothing to show.</Centered> : (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-creamDeep p-4">
          <img src={url} alt={artifact.title} className="max-h-full max-w-full object-contain" />
        </div>
      );
    case "video":
      return url === null ? <Centered>Nothing to show.</Centered> : (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4">
          <video src={url} controls className="max-h-full max-w-full object-contain" />
        </div>
      );
    default:
      return <Centered>Nothing to show.</Centered>;
  }
}

export function ArtifactViewer({
  artifact,
  onClose,
  onDownload,
}: {
  artifact: Artifact;
  onClose: () => void;
  onDownload: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const mode = artifactRenderMode(artifact.mime, artifact.filename);
  useModalFocusTrap(dialogRef, onClose);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const openableInTab = isUrlRenderMode(mode) ? artifact.preview_url : null;

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-3 backdrop-blur-sm sm:p-6"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={`artifact-viewer-title-${artifact.id}`}
          className="workspace-shell flex h-[88dvh] max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-rule bg-cream shadow-elev focus:outline-none"
        >
          <div className="flex items-start gap-3 border-b border-rule px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2
                id={`artifact-viewer-title-${artifact.id}`}
                className="truncate text-base font-semibold text-ink"
                title={artifact.title}
              >
                {artifact.title}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-inkMuted">
                <Badge>{artifactTypeLabel(artifact.type)}</Badge>
                <span>{formatArtifactDate(artifact.created_at)}</span>
                {artifact.bytes > 0 && <span>{formatArtifactBytes(artifact.bytes)}</span>}
                <span className="truncate">{artifact.filename}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {openableInTab && (
                <a
                  href={openableInTab}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${artifact.title} in a new tab`}
                  title="Open in a new tab"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-inkMuted transition-colors hover:bg-creamDeep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
              )}
              <IconButton
                label={`Download ${artifact.title}`}
                onClick={onDownload}
                className="size-8 border-0 bg-transparent"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
              </IconButton>
              <IconButton
                label="Close preview"
                onClick={onClose}
                className="size-8 border-0 bg-transparent"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-white">
            <ViewerBody artifact={artifact} mode={mode} onDownload={onDownload} />
          </div>
        </div>
      </div>
    </Portal>
  );
}
