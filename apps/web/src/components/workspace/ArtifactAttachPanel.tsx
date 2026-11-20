"use client";

import { useEffect, useMemo } from "react";
import { FileText, Image as ImageIcon } from "lucide-react";
import { useArtifacts } from "./artifacts/useArtifacts";
import { artifactRenderMode } from "./artifacts/artifactRender";
import { formatArtifactBytes } from "./artifacts/formatArtifact";
import type { Artifact } from "./artifacts/types";

const ATTACHABLE_EXTS = new Set(["pdf", "txt", "docx", "csv", "md", "markdown"]);

export function isAttachableArtifact(a: Artifact): boolean {
  if (/^tab-task-.+\.jpg$/i.test(a.filename)) return false;
  if (a.mime.startsWith("image/")) return true;
  const lower = a.filename.toLocaleLowerCase("en-US");
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return ATTACHABLE_EXTS.has(ext) || a.mime === "text/markdown";
}

export function ArtifactAttachPanel({
  onPick,
  busy,
}: {
  onPick: (artifact: Artifact) => void;
  busy: string | null;
}) {
  const { artifacts, loading, error, reload } = useArtifacts();

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const items = useMemo(
    () => artifacts.filter(isAttachableArtifact).slice(0, 12),
    [artifacts],
  );

  if (loading && items.length === 0) {
    return <div className="px-3.5 py-3 text-[13px] text-inkMuted">Loading your files…</div>;
  }
  if (error) {
    return <div className="px-3.5 py-3 text-[13px] text-inkMuted">Couldn’t load your files.</div>;
  }
  if (items.length === 0) {
    return (
      <div className="px-3.5 py-3 text-[13px] text-inkMuted">
        No files yet. Anything Zavi makes for you shows up here.
      </div>
    );
  }

  return (
    <div className="max-h-[260px] overflow-y-auto py-1">
      {items.map((a) => {
        const isImage = artifactRenderMode(a.mime, a.filename) === "image";
        const Icon = isImage ? ImageIcon : FileText;
        const isBusy = busy === a.filename;
        return (
          <button
            key={a.id}
            type="button"
            role="menuitem"
            disabled={isBusy}
            onClick={() => onPick(a)}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-normal leading-[18px] text-ink hover:bg-creamDeep/60 disabled:opacity-60"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-inkMuted" aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={a.filename}>
              {a.title || a.filename}
            </span>
            <span className="shrink-0 text-[12px] text-inkMuted">
              {isBusy ? "Attaching…" : formatArtifactBytes(a.bytes)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
