"use client";

import { useEffect, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import TextareaAutosize, {
  type TextareaAutosizeProps,
} from "react-textarea-autosize";
import { ArrowUp, Loader2 } from "lucide-react";
import { cx, FOCUS_RING } from "./layout/shared";

export function ComposerIconButton({
  onClick,
  ariaLabel,
  title,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      className={cx(
        "relative grid h-8 w-8 place-items-center rounded-full text-inkLight after:absolute compact:after:-inset-2 after:content-[''] hover:bg-bone hover:text-ink compact:h-10 compact:w-10",
        FOCUS_RING,
      )}
    >
      {children}
    </button>
  );
}

export function SendCircle({
  onClick,
  disabled,
  busy,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  ariaLabel: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      className={cx(
        "relative grid h-8 w-8 place-items-center rounded-full transition-colors after:absolute compact:after:-inset-2 after:content-[''] compact:h-10 compact:w-10",
        disabled && !busy
          ? "cursor-not-allowed bg-ink/15 text-cream"
          : "bg-ink text-cream hover:bg-inkSoft",
        FOCUS_RING,
      )}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin compact:h-5 compact:w-5" aria-hidden />
      ) : (
        (children ?? <ArrowUp className="h-4 w-4 compact:h-5 compact:w-5" strokeWidth={2.5} aria-hidden />)
      )}
    </button>
  );
}

const HINT_INTERVAL_MS = 4000;

function RotatingPlaceholder({ hints }: { hints: string[] }) {
  const [{ index, previous }, setCycle] = useState<{ index: number; previous: number | null }>({
    index: 0,
    previous: null,
  });

  useEffect(() => {
    if (hints.length < 2) return;
    const id = window.setInterval(() => {
      setCycle((current) => ({
        index: (current.index + 1) % hints.length,
        previous: current.index,
      }));
    }, HINT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [hints.length]);

  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-3 inset-y-2 overflow-hidden text-composer text-inkLight"
    >
      {previous !== null && previous !== index && (
        <span
          key={`out-${previous}-${index}`}
          className="absolute inset-x-0 top-0 truncate animate-hint-out motion-reduce:hidden"
        >
          {hints[previous]}
        </span>
      )}
      <span
        key={`in-${index}`}
        className={cx(
          "absolute inset-x-0 top-0 truncate motion-reduce:animate-none",
          previous !== null && "animate-hint-in",
        )}
      >
        {hints[index]}
      </span>
    </span>
  );
}

export function ModeComposer({
  value,
  onChange,
  onKeyDown,
  onPaste,
  placeholder,
  placeholderHints,
  ariaLabel,
  minRows = 2,
  maxRows = 7,
  maxLength,
  disabled,
  textareaRef,
  textareaProps,
  leading,
  trailing,
  editor,
  overlay,
  header,
  dragOver,
  borderless = false,
}: {
  value: string;
  onChange: (value: string, caret: number) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  placeholderHints?: string[];
  ariaLabel: string;
  minRows?: number;
  maxRows?: number;
  maxLength?: number;
  disabled?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  textareaProps?: TextareaAutosizeProps;
  leading?: ReactNode;
  trailing: ReactNode;
  editor?: ReactNode;
  overlay?: ReactNode;
  header?: ReactNode;
  dragOver?: boolean;
  borderless?: boolean;
}) {
  const showHints = !!placeholderHints?.length && !value && !disabled;
  return (
    <div
      className={cx(
        "composer-surface relative rounded-[16px] bg-cream p-1.5 shadow-composer transition-shadow duration-200 focus-within:shadow-composerFocus",
        borderless ? "border-0" : "border border-rule focus-within:border-ink/25",
        dragOver && "ring-2 ring-ink/30",
      )}
    >
      {overlay}
      {header}
      {editor ?? (
        <div className="relative">
          <TextareaAutosize
            {...textareaProps}
            ref={textareaRef}
            value={value}
            onChange={(event) =>
              onChange(event.target.value, event.target.selectionStart)
            }
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            minRows={minRows}
            maxRows={maxRows}
            maxLength={maxLength}
            disabled={disabled}
            aria-label={ariaLabel}
            placeholder={showHints ? "" : placeholder}
            className="block w-full resize-none border-0 bg-transparent px-3 pb-2 pt-2 text-composer text-ink outline-none placeholder:text-inkLight disabled:opacity-55"
          />
          {showHints && <RotatingPlaceholder hints={placeholderHints!} />}
        </div>
      )}
      <div className="mt-2 flex min-w-0 items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 compact:gap-2">
          {leading}
        </div>
        <div className="flex shrink-0 items-center gap-1">{trailing}</div>
      </div>
    </div>
  );
}
