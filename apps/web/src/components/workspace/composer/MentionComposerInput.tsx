"use client";

import type { Channel } from "@zavi/shared";
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { SourceIcon } from "../layout/SourceIcon";
import { splitComposerAtMention } from "../composerMention";
import { pastedImageFiles } from "./paste";

const ZERO_WIDTH_SPACE = "\u200b";

export type MentionComposerInputHandle = {
  focus: (caret?: number) => void;
};

type MentionComposerInputProps = {
  value: string;
  position: number;
  channel?: Channel;
  label?: string;
  icon?: ReactNode;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: string, position: number) => void;
  onRemove: (value: string, caret: number) => void;
  onSubmit: () => void;
  onPasteFiles: (files: File[]) => void;
};

function readableText(element: HTMLElement | null): string {
  if (!element) return "";
  return (element.innerText || element.textContent || "").replaceAll(
    ZERO_WIDTH_SPACE,
    "",
  );
}

function containsPoint(container: Node, point: Node | null): point is Node {
  return point === container || (point !== null && container.contains(point));
}

function isAtEdge(
  container: HTMLElement,
  point: Node | null,
  offset: number,
  edge: "start" | "end",
): boolean {
  if (!containsPoint(container, point)) return false;
  const range = document.createRange();
  range.selectNodeContents(container);
  if (edge === "start") range.setEnd(point, offset);
  else range.setStart(point, offset);
  return range.toString().replaceAll(ZERO_WIDTH_SPACE, "").length === 0;
}

function placeCaret(container: HTMLElement, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    const length = text.replaceAll(ZERO_WIDTH_SPACE, "").length;
    if (remaining <= length) {
      let rawOffset = 0;
      let visibleOffset = 0;
      while (rawOffset < text.length && visibleOffset < remaining) {
        if (text[rawOffset] !== ZERO_WIDTH_SPACE) visibleOffset += 1;
        rawOffset += 1;
      }
      while (text[rawOffset] === ZERO_WIDTH_SPACE) rawOffset += 1;
      const range = document.createRange();
      range.setStart(node, rawOffset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
    node = walker.nextNode();
  }
  const range = document.createRange();
  range.selectNodeContents(container);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export const MentionComposerInput = forwardRef<
  MentionComposerInputHandle,
  MentionComposerInputProps
>(function MentionComposerInput(
  {
    value,
    position,
    channel,
    label,
    icon,
    ariaLabel,
    disabled,
    onChange,
    onRemove,
    onSubmit,
    onPasteFiles,
  },
  forwardedRef,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const beforeRef = useRef<HTMLSpanElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const afterRef = useRef<HTMLSpanElement | null>(null);
  const parts = splitComposerAtMention(value, position);
  const chipName = label ?? channel?.name ?? "";

  const readValue = () => {
    const before = readableText(beforeRef.current);
    const after = readableText(afterRef.current);
    return { value: before + after, position: before.length };
  };

  const removeMention = () => {
    const current = readValue();
    onRemove(current.value, current.position);
  };

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus(caret = position) {
        const root = rootRef.current;
        const before = beforeRef.current;
        const after = afterRef.current;
        if (!root || !before || !after) return;
        root.focus();
        if (caret < position) placeCaret(before, caret);
        else placeCaret(after, caret - position);
      },
    }),
    [position],
  );

  useLayoutEffect(() => {
    const before = beforeRef.current;
    const after = afterRef.current;
    if (!before || !after) return;
    const current = readValue();
    if (current.value === value && current.position === position) return;
    before.textContent = `${parts.before}${ZERO_WIDTH_SPACE}`;
    after.textContent = `${ZERO_WIDTH_SPACE}${parts.after}`;
  }, [parts.after, parts.before, position, value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
      return;
    }
    const selection = window.getSelection();
    if (!selection?.isCollapsed) return;
    if (
      event.key === "Backspace" &&
      afterRef.current &&
      isAtEdge(
        afterRef.current,
        selection.anchorNode,
        selection.anchorOffset,
        "start",
      )
    ) {
      event.preventDefault();
      removeMention();
      return;
    }
    if (
      event.key === "Delete" &&
      beforeRef.current &&
      isAtEdge(
        beforeRef.current,
        selection.anchorNode,
        selection.anchorOffset,
        "end",
      )
    ) {
      event.preventDefault();
      removeMention();
    }
  };

  const insertPlainText = (text: string) => {
    const before = beforeRef.current;
    const after = afterRef.current;
    const selection = window.getSelection();
    if (!before || !after || !selection) return;
    let range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const inOneSpan =
      range !== null &&
      [before, after].some(
        (span) =>
          span.contains(range!.startContainer) &&
          span.contains(range!.endContainer),
      );
    if (!range || !inOneSpan) {
      range = document.createRange();
      range.selectNodeContents(after);
      range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    const current = readValue();
    onChange(current.value, current.position);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = pastedImageFiles(event.clipboardData);
    if (files.length > 0) onPasteFiles(files);
    const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (text) insertPlainText(text);
  };

  return (
    <div
      ref={rootRef}
      role="textbox"
      aria-label={ariaLabel}
      aria-multiline="true"
      aria-disabled={disabled || undefined}
      contentEditable={!disabled}
      suppressContentEditableWarning
      data-composer-input=""
      onInput={() => {
        if (!chipRef.current?.isConnected) {
          const text = readableText(rootRef.current);
          onRemove(text, text.length);
          return;
        }
        const current = readValue();
        onChange(current.value, current.position);
      }}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      className={cn(
        "block min-h-composerInput max-h-44 w-full overflow-y-auto whitespace-pre-wrap break-words border-0 bg-transparent px-3 pb-2 pt-2 text-composer text-ink outline-none",
        disabled && "opacity-55",
      )}
    >
      <span ref={beforeRef} />
      <button
        ref={chipRef}
        type="button"
        contentEditable={false}
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onClick={removeMention}
        aria-label={`Remove ${chipName}`}
        title={`Remove ${chipName}`}
        className="mx-1 inline-flex h-6 items-center gap-2 rounded-full bg-ink/10 pl-0.5 pr-2.5 align-middle text-xs font-normal leading-5 text-ink transition-colors hover:bg-ink/15 [&>span]:ring-0"
      >
        {icon ?? (channel ? <SourceIcon channel={channel} size="sm" /> : null)}
        {chipName}
      </button>
      <span ref={afterRef} />
    </div>
  );
});
