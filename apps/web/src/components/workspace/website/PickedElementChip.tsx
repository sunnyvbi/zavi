"use client";

import { useState } from "react";
import { Image as ImageIcon, SquareDashedMousePointer, X } from "lucide-react";

export type PickedElementView = {
  tag: string;
  text?: string | null;
  path?: string | null;
  thumb?: string | null;
};

const TAG_NAMES: Record<string, string> = {
  img: "Image",
  picture: "Image",
  svg: "Graphic",
  video: "Video",
  a: "Link",
  button: "Button",
  h1: "Heading",
  h2: "Heading",
  h3: "Heading",
  h4: "Heading",
  h5: "Heading",
  h6: "Heading",
  p: "Paragraph",
  section: "Section",
  header: "Header",
  footer: "Footer",
  nav: "Menu",
  form: "Form",
  input: "Field",
  textarea: "Field",
  select: "Field",
  ul: "List",
  ol: "List",
  li: "List item",
  span: "Text",
  label: "Label",
};

const MAX_LABEL = 40;

export function pickedElementLabel(pick: Pick<PickedElementView, "tag" | "text">): string {
  const text = (pick.text ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1).trimEnd()}…` : text;
  return TAG_NAMES[pick.tag] ?? `<${pick.tag}>`;
}

function safeThumb(src: string | null | undefined): string | null {
  if (!src) return null;
  try {
    const url = new URL(src);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function PickedElementChip({
  pick,
  onRemove,
  className = "",
}: {
  pick: PickedElementView;
  onRemove?: () => void;
  className?: string;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = thumbFailed ? null : safeThumb(pick.thumb);
  const label = pickedElementLabel(pick);
  const kind = TAG_NAMES[pick.tag] ?? `<${pick.tag}>`;
  const where = pick.path && pick.path !== "/" ? pick.path : null;
  return (
    <span
      data-testid="picked-element-chip"
      title={`${kind}${pick.text ? `: ${pick.text}` : ""}${pick.path ? ` on ${pick.path}` : ""}`}
      className={`inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-rule bg-white pl-1 text-[13px] font-medium text-ink ${
        onRemove ? "pr-1" : "pr-3"
      } ${className}`}
    >
      <span
        aria-hidden
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-bone text-inkSoft"
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setThumbFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : pick.tag === "img" || pick.tag === "picture" ? (
          <ImageIcon className="h-3.5 w-3.5" />
        ) : (
          <SquareDashedMousePointer className="h-3.5 w-3.5" />
        )}
      </span>
      <span className="sr-only">Selected {kind}: </span>
      <span className="min-w-0 truncate">{label}</span>
      {where && <span className="shrink-0 text-inkMuted">· {where}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove selected ${kind.toLowerCase()}`}
          className="ml-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </span>
  );
}
