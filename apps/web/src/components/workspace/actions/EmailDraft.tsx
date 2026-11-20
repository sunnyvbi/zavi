"use client";

import { Fragment, useId } from "react";
import { Clock, Mail } from "lucide-react";
import { ClampedPane, isLongDeliverable } from "./SplitCard";
import { TabIndicator, useTabIndicator } from "../layout/TabIndicator";
import { cx } from "../layout/shared";
import { findBlanks } from "./blanks";

export type EmailDraftParts = { send: string | null; subject: string; preview: string | null; body: string };

const HEADER = /^\**\s*(email|send|when|subject|preview|preheader|preview text)\s*:\s*\**\s*(.*?)\s*\**$/i;

export function parseEmailDraft(content: string): EmailDraftParts | null {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const found: Record<string, string> = {};
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  for (; i < lines.length; i++) {
    const m = lines[i].trim().match(HEADER);
    if (!m || !m[2]) break;
    const key = m[1].toLowerCase();
    const slot = key === "when" ? "send" : key.startsWith("preview") || key === "preheader" ? "preview" : key;
    if (!found[slot]) found[slot] = m[2];
  }
  if (!found.subject) return null;
  const body = lines.slice(i).join("\n").replace(/^\s*\n/, "").trim();
  if (!body) return null;
  return { send: found.send ?? null, subject: found.subject, preview: found.preview ?? null, body };
}

export function shortTabLabel(label: string): string {
  const m = label.match(/^\s*(email\s*\d+)\b/i);
  return m ? m[1].replace(/\s+/g, " ").replace(/^e/, "E") : label;
}

const SLOT = /(\[[^\[\]]{1,400}\]|\{\{\s*[^{}\n]{1,80}?\s*\}\})/g;

export function emailParagraphs(text: string): string[] {
  const spans = [...text.matchAll(SLOT)].map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
  const paragraphs: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/\n\s*\n/g)) {
    const at = match.index!;
    if (spans.some((span) => at > span.start && at < span.end)) continue;
    paragraphs.push(text.slice(start, at));
    start = at + match[0].length;
  }
  paragraphs.push(text.slice(start));
  return paragraphs;
}

export function WithSlots({ text, values, active, blanks }: { text: string; values?: Readonly<Record<string, string>>; active?: string | null; blanks: ReadonlySet<string> }) {
  const pieces = text.split(SLOT);
  return (
    <>
      {pieces.map((p, i) => {
        if (i % 2 === 0 || !blanks.has(p)) return <Fragment key={i}>{p}</Fragment>;
        const value = values?.[p]?.trim();
        const isActive = active === p;
        if (value) {
          return (
            <mark
              key={`${i}-filled`}
              data-testid="email-slot"
              data-filled="true"
              data-active={isActive ? "true" : undefined}
              className={cx(
                "mx-px animate-pane-fade rounded-md px-1 py-0.5 font-semibold text-ink transition-shadow [box-decoration-break:clone] motion-reduce:animate-none",
                isActive
                  ? "bg-marigold/25 shadow-[0_0_0_1px_rgb(255_201_61/0.55),0_0_16px_rgb(255_201_61/0.35)]"
                  : "bg-marigold/15 shadow-[0_0_0_1px_rgb(255_201_61/0.3)]",
              )}
            >
              {value}
            </mark>
          );
        }
        return (
          <mark
            key={i}
            data-testid="email-slot"
            data-active={isActive ? "true" : undefined}
            className={cx(
              "mx-px rounded-md px-1.5 py-0.5 text-[0.93em] font-medium [box-decoration-break:clone]",
              isActive
                ? "bg-marigold/15 text-ink ring-1 ring-inset ring-marigold/50 shadow-[0_0_14px_rgb(255_201_61/0.3)]"
                : "bg-ink/[0.07] text-inkSoft ring-1 ring-inset ring-ink/[0.08]",
            )}
          >
            <span className="sr-only">{p.startsWith("{{") ? "{{" : "["}</span>
            {p.startsWith("{{") ? p.slice(2, -2) : p.slice(1, -1)}
            <span className="sr-only">{p.startsWith("{{") ? "}}" : "]"}</span>
          </mark>
        );
      })}
    </>
  );
}

function Tabs({ labels, selected, onSelect, panelId }: { labels: string[]; selected: number; onSelect: (i: number) => void; panelId: string }) {
  const { listRef, geometry } = useTabIndicator<HTMLDivElement>(selected);
  return (
    <div ref={listRef} role="tablist" aria-label="Emails" className="relative flex min-w-0 items-stretch self-stretch overflow-x-auto">
      {labels.map((label, i) => (
        <button
          key={i}
          type="button"
          role="tab"
          aria-selected={i === selected}
          aria-controls={panelId}
          title={label}
          onClick={() => onSelect(i)}
          className={`whitespace-nowrap px-3 text-[13px] font-medium transition-colors ${i === selected ? "text-ink" : "text-inkMuted hover:text-ink"}`}
        >
          {shortTabLabel(label)}
        </button>
      ))}
      <TabIndicator geometry={geometry} className="bottom-0" />
    </div>
  );
}

export function EmailDraft({
  content,
  tabs,
  values,
  active,
}: {
  values?: Readonly<Record<string, string>>;
  active?: string | null;
  content: string;
  copyText: string;
  copyDisabled?: boolean;
  tabs?: { labels: string[]; selected: number; onSelect: (i: number) => void } | null;
}) {
  const email = parseEmailDraft(content);
  const blanks = new Set(findBlanks(content));
  const panelId = `${useId()}-email`;
  if (!email) return null;
  return (
    <div data-testid="email-draft" className="overflow-hidden rounded-xl border border-rule bg-cream shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_-6px_rgb(0_0_0/0.08)]">
      <div className="flex h-11 items-center gap-2 border-b border-rule pl-1 pr-1.5">
        {tabs && tabs.labels.length > 1 ? (
          <Tabs labels={tabs.labels} selected={tabs.selected} onSelect={tabs.onSelect} panelId={panelId} />
        ) : (
          <span className="flex items-center gap-2 px-3 text-[13px] font-medium text-inkMuted">
            <Mail className="h-3.5 w-3.5" aria-hidden />
            Email
          </span>
        )}
        {email.send && (
          <span
            data-testid="email-send"
            title={email.send}
            className="ml-auto inline-flex min-w-0 max-w-[55%] shrink items-center gap-1.5 rounded-full bg-ink/[0.06] px-2.5 py-1 text-[12px] font-medium text-inkMuted"
          >
            <Clock className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate first-letter:uppercase">{email.send}</span>
          </span>
        )}
      </div>
      <div id={panelId} role={tabs ? "tabpanel" : undefined} aria-label={tabs ? tabs.labels[tabs.selected] : undefined} key={tabs?.selected} className="animate-pane-fade motion-reduce:animate-none">
        <div className="flex items-start gap-3 border-b border-rule px-4 py-4">
          <span aria-hidden className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-creamDeep text-inkMuted ring-1 ring-inset ring-rule">
            <Mail className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="sr-only">Subject</p>
            <p data-testid="email-subject" className="text-[16px] font-semibold leading-snug tracking-[-0.01em] text-ink [overflow-wrap:anywhere]">
              <WithSlots text={email.subject} values={values} active={active} blanks={blanks} />
            </p>
            {email.preview && (
              <>
                <p className="sr-only">Preview</p>
                <p data-testid="email-preview" className="mt-1 text-[13.5px] leading-snug text-inkMuted [overflow-wrap:anywhere]">
                  <WithSlots text={email.preview} values={values} active={active} blanks={blanks} />
                </p>
              </>
            )}
          </div>
        </div>
        <div className="px-4 pb-4 pt-4 sm:pl-16">
          <ClampedPane long={isLongDeliverable(email.body)} testId="email-body">
            <div className="space-y-3 text-[14px] leading-[1.65] text-ink [overflow-wrap:anywhere]">
              {emailParagraphs(email.body).map((para, i) => (
                <p key={i} className="whitespace-pre-wrap">
                  <WithSlots text={para.trim()} values={values} active={active} blanks={blanks} />
                </p>
              ))}
            </div>
          </ClampedPane>
        </div>
      </div>
    </div>
  );
}
