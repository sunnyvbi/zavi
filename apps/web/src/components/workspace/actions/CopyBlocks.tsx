"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Check, PanelTop } from "lucide-react";
import { Markdown } from "@/components/workspace/Markdown";
import type { ExactChangeRow } from "@/lib/workspace/channelActionsApi";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function chipNames(texts: string[], rows: ExactChangeRow[], known: string[]): string[] {
  const text = texts.join("\n");
  const lower = text.toLowerCase();
  const named = known.filter((c) => c.length > 3 && lower.includes(c.toLowerCase()));
  const quoted = Array.from(text.matchAll(/["“]([^"”\n]{2,80})["”]/g), (m) => m[1]).filter((q) =>
    known.some((c) => q.toLowerCase().startsWith(c.toLowerCase())),
  );
  const items = rows.map((r) => r.item).filter((item) => text.includes(item));
  return Array.from(new Set([...quoted, ...named, ...items])).sort((x, y) => y.length - x.length);
}

export const ChipHref = createContext<(name: string) => string | null>(() => null);

function Chip({ children }: { children: string }) {
  const href = useContext(ChipHref)(children);
  const cls =
    "mx-0.5 inline-flex items-center gap-2 rounded-lg border border-rule bg-creamDeep px-2 py-0.5 align-middle text-[14px] font-medium text-ink";
  const body = (
    <>
      <PanelTop className="h-3.5 w-3.5 text-inkMuted" aria-hidden />
      {children}
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${cls} hover:border-inkMuted hover:bg-bone`}>
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

export function Chipped({ text, names }: { text: string; names: string[] }): ReactNode {
  if (!names.length) return <>{text}</>;
  const parts = text.split(new RegExp(`["“]?(${names.map(escapeRe).join("|")})["”]?`, "gi"));
  return <>{parts.map((p, i) => (i % 2 ? <Chip key={i}>{p}</Chip> : p))}</>;
}

const MARKDOWN_SYNTAX = new RegExp(
  [
    "\\*\\*[^*\\n]+\\*\\*",
    "\\*[^*\\s][^*\\n]*\\*",
    "(?:^|[\\s(])_[^_\\n]+_(?=$|[\\s.,;:!?)])",
    "`[^`\\n]+`",
    "\\[[^\\]\\n]+\\]\\([^)\\s]+\\)",
    "(?:^|\\n)[ \\t]*(?:[-*+]|\\d+[.)])[ \\t]+\\S",
    "(?:^|\\n)#{1,6}[ \\t]+\\S",
    "(?:^|\\n)>[ \\t]+\\S",
  ].join("|"),
);

const CARD_PROSE =
  "[overflow-wrap:anywhere] [&_p]:text-[14px] [&_li]:text-[14px] [&_p]:leading-relaxed [&_li]:leading-relaxed [&_code]:text-[13px]";

const MUTED_PROSE =
  "[--tw-prose-body:rgb(var(--c-ink-muted))] [--tw-prose-bold:rgb(var(--c-ink-muted))]";

export function RichText({
  text,
  names,
  preWrap = false,
  muted = false,
}: {
  text: string;
  names: string[];
  preWrap?: boolean;
  muted?: boolean;
}): ReactNode {
  if (!MARKDOWN_SYNTAX.test(text)) {
    const chipped = <Chipped text={text} names={names} />;
    return preWrap ? <span className="whitespace-pre-wrap">{chipped}</span> : chipped;
  }
  return (
    <Markdown
      source={text}
      breaks
      disableActionLinks
      className={`${CARD_PROSE}${muted ? ` ${MUTED_PROSE}` : ""}`}
    />
  );
}

export type StepState = "pending" | "running" | "done";

export const STEP_STATE: Partial<Record<string, StepState>> = {
  queued: "pending",
  dispatching: "running",
  executed: "done",
};

function StepMark({ state, quiet }: { state?: StepState; quiet?: boolean }) {
  if (state === "running") {
    return (
      <span
        className="mt-1.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-rule border-t-ink motion-reduce:animate-none"
        aria-hidden
      />
    );
  }
  if (state === "done") return <Check className="mt-1 h-4 w-4 shrink-0 text-emerald-500" aria-hidden />;
  if (state === "pending") return <span className="mt-1.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-rule" aria-hidden />;
  return <span className={`mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full ${quiet ? "bg-inkLight" : "bg-ink"}`} aria-hidden />;
}

export function Bullets({
  title,
  lines,
  names,
  state,
  more = 0,
  quiet,
}: {
  title?: string;
  lines: string[];
  names: string[];
  state?: StepState;
  more?: number;
  quiet?: boolean;
}) {
  if (!lines.length) return null;
  const muted = state === "done" || state === "pending";
  const tone = muted ? "text-inkMuted" : quiet ? "text-inkSoft" : "text-ink";
  return (
    <div data-testid={quiet ? "action-why-bullets" : undefined}>
      {title && <p className="mb-1.5 text-[14px] font-semibold text-ink">{title}</p>}
      <ul className={`${quiet ? "space-y-1" : "space-y-2"} text-[14px] leading-relaxed text-ink`} data-step-state={state}>
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <StepMark state={state} quiet={quiet} />
            <div className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${tone}`}>
              <RichText text={l} names={names} muted={muted} />
            </div>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="mt-2 pl-4 text-[14px] text-inkMuted">and {more} more</p>}
    </div>
  );
}
