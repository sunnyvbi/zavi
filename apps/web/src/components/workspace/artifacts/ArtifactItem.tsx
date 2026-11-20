"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Download, Eye, MoreHorizontal, Pencil, Play, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { ArtifactPreview, ArtifactTypeIcon } from "./ArtifactPreview";
import { artifactRenderMode } from "./artifactRender";
import { formatArtifactBytes, formatArtifactDate, formatArtifactDateShort } from "./formatArtifact";
import { artifactTypeLabel, type Artifact, type ArtifactView } from "./types";

export function artifactIconTone(artifact: Pick<Artifact, "type" | "mime" | "filename">): string {
  const mime = artifact.mime.toLowerCase();
  const name = artifact.filename.toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "text-[#e5484d]";
  if (artifact.type === "spreadsheet") return "text-[#1f9d55]";
  if (artifact.type === "presentation") return "text-[#e07b2c]";
  if (artifact.type === "dashboard") return "text-[#7c5cff]";
  if (artifact.type === "website") return "text-[#2f7cf6]";
  return "text-inkMuted";
}

export function ArtifactItem({
  artifact,
  accessibilityName,
  view,
  busy,
  onOpen,
  onRename,
  onDownload,
  onDelete,
}: {
  artifact: Artifact;
  accessibilityName?: string;
  view: ArtifactView;
  busy: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDownload: () => void;
  onDelete: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const actionName = accessibilityName ?? artifact.title;

  const beginRename = () => {
    setDraft(artifact.title);
    setEditing(true);
  };

  const saveRename = async () => {
    const title = draft.trim();
    if (!title || title === artifact.title) {
      setEditing(false);
      return;
    }
    if (await onRename(title)) setEditing(false);
  };

  const requestDelete = async () => {
    const confirmed = window.confirm(
      `Delete “${artifact.title}”? The source ${artifact.source.kind} will stay intact.`,
    );
    if (confirmed) await onDelete();
  };

  const actions = (
    <div className="flex items-center gap-1">
      <IconButton
        label={`Open ${actionName}`}
        onClick={onOpen}
        className="border-0 bg-transparent compact:h-10 compact:w-10"
      >
        <Eye className="h-4 w-4" aria-hidden="true" />
      </IconButton>
      <IconButton
        label={`Rename ${actionName}`}
        onClick={beginRename}
        disabled={busy}
        className="border-0 bg-transparent compact:h-10 compact:w-10"
      >
        <Pencil className="h-4 w-4" aria-hidden="true" />
      </IconButton>
      <IconButton
        label={`Download ${actionName}`}
        onClick={onDownload}
        disabled={busy}
        className="border-0 bg-transparent compact:h-10 compact:w-10"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
      </IconButton>
      <IconButton
        label={`Delete ${actionName}`}
        onClick={() => void requestDelete()}
        disabled={busy}
        className="border-0 bg-transparent text-danger hover:text-danger compact:h-10 compact:w-10"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </IconButton>
    </div>
  );

  const title = editing ? (
    <form
      className="flex min-w-0 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void saveRename();
      }}
    >
      <label htmlFor={`artifact-title-${artifact.id}`} className="sr-only">
        Artifact title
      </label>
      <Input
        id={`artifact-title-${artifact.id}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={160}
        autoFocus
        className="h-8 rounded-md px-2"
      />
      <IconButton label="Save title" type="submit" disabled={busy || !draft.trim()}>
        <Check className="h-4 w-4" aria-hidden="true" />
      </IconButton>
      <IconButton label="Cancel rename" onClick={() => setEditing(false)} disabled={busy}>
        <X className="h-4 w-4" aria-hidden="true" />
      </IconButton>
    </form>
  ) : (
    <h2 className="truncate text-base font-semibold text-ink" title={artifact.title}>
      {artifact.title}
    </h2>
  );

  if (view === "list") {
    return (
      <Card className="flex items-center gap-4 p-3">
        <div className="relative shrink-0">
          <ArtifactPreview artifact={artifact} compact />
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${actionName} preview`}
            className="absolute inset-0 rounded-cta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
          />
        </div>
        <div className="min-w-0 flex-1">
          {title}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-inkMuted">
            <Badge>{artifactTypeLabel(artifact.type)}</Badge>
            <span>{formatArtifactDate(artifact.created_at)}</span>
            <span>{formatArtifactBytes(artifact.bytes)}</span>
            {artifact.source.href ? (
              <Link href={artifact.source.href} className="truncate hover:text-ink hover:underline">
                From {artifact.source.title}
              </Link>
            ) : (
              <span className="truncate">From {artifact.source.title}</span>
            )}
          </div>
        </div>
        {actions}
      </Card>
    );
  }

  const media = artifact.type === "image" || artifact.type === "video";
  const website = artifact.type === "website";
  const csv = artifactRenderMode(artifact.mime, artifact.filename) === "csv";
  const menu = (
    <TileMenu
      title={actionName}
      busy={busy}
      onOpen={onOpen}
      onRename={beginRename}
      onDownload={onDownload}
      onDelete={() => void requestDelete()}
    />
  );
  const gridCaption = (
    <div className="mt-2 min-w-0 px-0.5">
      {editing ? (
        title
      ) : (
        <h2 className="truncate text-[13px] font-medium leading-4 text-ink" title={artifact.title}>
          {artifact.title}
        </h2>
      )}
      {!editing && (
        <p className="mt-0.5 truncate text-[11px] leading-4 text-inkLight">
          {artifactTypeLabel(artifact.type)} · {formatArtifactDateShort(artifact.created_at)}
        </p>
      )}
    </div>
  );

  if (media) {
    return (
      <div data-tile={artifact.type} className={cn("group relative", busy && "opacity-70")}>
        <div className="relative overflow-hidden rounded-xl bg-creamDeep">
          <ArtifactPreview artifact={artifact} fit="natural" />
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${actionName} preview`}
            className="absolute inset-0 rounded-cta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/30"
          />
          {artifact.type === "video" && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm"
            >
              <Play className="ml-0.5 h-4 w-4 fill-current" />
            </span>
          )}
        </div>
        {menu}
        {gridCaption}
      </div>
    );
  }

  if (website) {
    return (
      <div data-tile="website" className={cn("group relative", busy && "opacity-70")}>
        <div className="relative aspect-square overflow-hidden rounded-xl bg-creamDeep">
          <ArtifactPreview artifact={artifact} fit="natural" />
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${actionName} preview`}
            className="absolute inset-0 rounded-cta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/30"
          />
        </div>
        {menu}
        {gridCaption}
      </div>
    );
  }

  return (
    <div
      data-tile="file"
      className={cn(
        "group relative flex aspect-[5/4] flex-col rounded-xl bg-creamDeep p-3",
        busy && "opacity-70",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${actionName} preview`}
        className="absolute inset-0 rounded-cta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/30"
      />
      <div className="relative pr-7">
        {editing ? (
          title
        ) : (
          <h2 className="line-clamp-3 text-[12px] font-medium leading-4 text-ink" title={artifact.title}>
            {artifact.title}
          </h2>
        )}
      </div>
      <div className="pointer-events-none relative flex min-h-0 flex-1 items-center justify-center py-2">
        {csv ? (
          <div className="h-full min-h-14 w-full">
            <ArtifactPreview artifact={artifact} fill />
          </div>
        ) : (
          <span
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-lg border border-rule bg-cream",
              artifactIconTone(artifact),
            )}
          >
            <ArtifactTypeIcon artifact={artifact} className="h-5 w-5" />
          </span>
        )}
      </div>
      <span className="relative text-[11px] text-inkMuted">{formatArtifactDateShort(artifact.created_at)}</span>
      {menu}
    </div>
  );
}

function TileMenu({
  title: name,
  busy,
  onOpen,
  onRename,
  onDownload,
  onDelete,
}: {
  title: string;
  busy: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const [el, setEl] = useState<HTMLDetailsElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const onDocumentClick = (event: MouseEvent) => {
      if (el.open && !el.contains(event.target as Node)) el.removeAttribute("open");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && el.open) el.removeAttribute("open");
    };
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [el]);
  const run = (action: () => void) => () => {
    el?.removeAttribute("open");
    action();
  };
  const item =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink hover:bg-creamDeep disabled:opacity-50";
  return (
    <details ref={setEl} className="absolute right-2 top-2 z-10 [&[open]>summary]:opacity-100">
      <summary
        aria-label={`More actions for ${name}`}
        title="More actions"
        className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-full bg-ink/70 text-cream opacity-100 shadow-sm backdrop-blur transition-opacity hover:bg-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cream sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 [&::-webkit-details-marker]:hidden"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </summary>
      <div
        role="menu"
        aria-label={`Actions for ${name}`}
        className="absolute right-0 mt-1 w-40 overflow-hidden rounded-xl border border-rule bg-cream py-1 shadow-pop"
      >
        <button type="button" role="menuitem" aria-label={`Open ${name}`} onClick={run(onOpen)} className={item}>
          <Eye className="h-4 w-4 text-inkMuted" aria-hidden="true" /> Open
        </button>
        <button type="button" role="menuitem" aria-label={`Rename ${name}`} disabled={busy} onClick={run(onRename)} className={item}>
          <Pencil className="h-4 w-4 text-inkMuted" aria-hidden="true" /> Rename
        </button>
        <button type="button" role="menuitem" aria-label={`Download ${name}`} disabled={busy} onClick={run(onDownload)} className={item}>
          <Download className="h-4 w-4 text-inkMuted" aria-hidden="true" /> Download
        </button>
        <button type="button" role="menuitem" aria-label={`Delete ${name}`} disabled={busy} onClick={run(onDelete)} className={cn(item, "text-danger hover:text-danger")}>
          <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete
        </button>
      </div>
    </details>
  );
}
