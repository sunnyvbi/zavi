"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronLeft, Eye, LayoutTemplate, X } from "lucide-react";
import { AdsDialog } from "@/components/ui/AdsDialog";
import { LookPreview } from "./LookPreview";
import { readWireframeTokens, templateWireframeCss, type WireframeTokens } from "./templateWireframe";
import {
  ANSWER_MAX,
  blankLabel,
  blankQuestion,
  blanksHint,
  cleanAnswer,
  fillTemplateIdea,
  ideaParts,
  templateBlanks,
  useSiteTemplates,
  type PickedTemplate,
  type SiteTemplateCard,
} from "@/lib/workspace/siteTemplates";
import { NextChevron } from "@/components/ui/NextChevron";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";

export const TEMPLATES_OPEN = "Start from a template";
export const TEMPLATES_NOTE = "Each template sets the layout and sections. Colors, fonts and words are made for your business.";
export const TEMPLATES_FAILED = "Templates could not load. You can still describe your idea above.";
export const TEMPLATES_USE = "Use this template";
export const TEMPLATES_BACK_TO_LIST = "All templates";
export const TEMPLATES_PREVIEW = "Preview";
export const TEMPLATES_PREVIEW_BACK = "Back to templates";

export type UsedTemplate = { template: PickedTemplate; idea: string };

type Step = { kind: "list" } | { kind: "preview"; template: SiteTemplateCard } | { kind: "ask"; at: number } | { kind: "confirm" };

const DIALOG_CHROME = "raised-surface rounded-[16px] border border-rule bg-cream text-ink shadow-2xl";
const GHOST_BUTTON = cx("inline-flex h-9 items-center rounded-full px-3 text-[13px] text-inkMuted transition-colors hover:bg-ink/[0.05] hover:text-ink", FOCUS_RING);
const BACK_BUTTON = cx("inline-flex h-9 items-center rounded-full px-3.5 text-[13px] text-ink transition-colors hover:bg-ink/[0.05] relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']", FOCUS_RING);
const PRIMARY_BUTTON = cx(
  "inline-flex h-9 items-center rounded-full bg-ink px-4 text-[13px] font-medium text-cream transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-inkLight relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']",
  FOCUS_RING,
);

const PREVIEW_CHIP = cx(
  "absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full border border-rule bg-cream/95 px-2.5 py-1 text-[12px] font-medium leading-4 text-ink shadow-sm transition-opacity hover:bg-bone",
  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
  FOCUS_RING,
);

function TemplateCard({
  template,
  selected,
  wireframeCss,
  onPick,
  onPreview,
}: {
  template: SiteTemplateCard;
  selected: boolean;
  wireframeCss: string;
  onPick: () => void;
  onPreview: () => void;
}) {
  return (
    <div className="group relative flex min-w-0">
      <button
        type="button"
        onClick={onPick}
        aria-pressed={selected}
        data-testid={`template-${template.id}`}
        className={cx(
          "flex w-full min-w-0 flex-col overflow-hidden rounded-[12px] border bg-cream text-left transition-[border-color,box-shadow,transform] duration-150 motion-safe:hover:-translate-y-0.5 hover:shadow-[0_6px_18px_-10px_rgb(var(--c-ink)/0.35)]",
          selected ? "border-ink ring-1 ring-ink" : "border-rule hover:border-inkMuted",
          FOCUS_RING,
        )}
      >
        <div className="overflow-hidden">
          <LookPreview label={template.label} themeCss={template.theme_css + wireframeCss} preview={template.preview} layout={template.layout} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col border-t border-rule px-4 pb-4 pt-3">
          <p className="flex items-center gap-1.5 text-[15px] font-semibold leading-5 text-ink">
            <span className="truncate">{template.label}</span>
            {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
          </p>
          {template.blurb && <p className="mt-1 line-clamp-2 text-[13px] leading-[18px] text-inkMuted">{template.blurb}</p>}
          {template.good_for && <p className="mt-auto truncate pt-2 text-[12px] leading-4 text-inkLight">{template.good_for}</p>}
        </div>
      </button>
      <button
        type="button"
        onClick={onPreview}
        aria-label={`${TEMPLATES_PREVIEW} ${template.label}`}
        data-testid={`template-preview-${template.id}`}
        className={PREVIEW_CHIP}
      >
        <Eye className="h-3.5 w-3.5" aria-hidden />
        {TEMPLATES_PREVIEW}
      </button>
    </div>
  );
}

function TemplatePreview({
  template,
  wireframeCss,
  primaryRef,
  onUse,
  onBack,
}: {
  template: SiteTemplateCard;
  wireframeCss: string;
  primaryRef: RefObject<HTMLButtonElement | null>;
  onUse: () => void;
  onBack: () => void;
}) {
  const sections = template.preview.sections.map((s) => s.title).filter(Boolean);
  return (
    <div data-testid="template-preview-panel" className="px-6 pb-5 pt-4 compact:px-4">
      <div className="overflow-hidden rounded-xl border border-rule bg-creamDeep shadow-[0_18px_40px_-24px_rgb(0_0_0/0.55)]">
        <div className="flex h-9 items-center gap-3 border-b border-rule px-3.5">
          <span aria-hidden className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-ink/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-ink/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-ink/15" />
          </span>
          <span className="min-w-0 flex-1 truncate text-center text-[12px] font-medium text-inkMuted">
            {template.preview.name || template.label}
          </span>
          <span aria-hidden className="w-[42px]" />
        </div>
        <LookPreview label={template.label} themeCss={template.theme_css + wireframeCss} preview={template.preview} layout={template.layout} />
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          {template.blurb && <p className="text-[15px] font-medium leading-[1.45] text-ink">{template.blurb}</p>}
          {template.good_for && (
            <p className="mt-1 text-[13px] leading-5 text-inkMuted">
              <span className="text-inkLight">Good for </span>
              {template.good_for}
            </p>
          )}
        </div>
        {sections.length > 0 && (
          <div className="min-w-0 sm:max-w-[320px]">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-inkLight sm:text-right">Sections</p>
            <ul aria-label="Sections" className="flex flex-wrap gap-1.5 sm:justify-end">
              {sections.map((title, i) => (
                <li key={`${title}-${i}`} className="rounded-full border border-rule px-2.5 py-1 text-[12px] font-medium leading-4 text-inkSoft">
                  {title}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="-mx-6 mt-5 flex items-center gap-2 border-t border-rule px-6 pt-4 compact:-mx-4 compact:px-4">
        <button type="button" onClick={onBack} className={cx(BACK_BUTTON, "gap-1 pl-2.5")}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
          {TEMPLATES_PREVIEW_BACK}
        </button>
        <div className="flex-1" />
        <button ref={primaryRef} type="button" onClick={onUse} className={cx(PRIMARY_BUTTON, "gap-1")}>
          {TEMPLATES_USE}
          <NextChevron />
        </button>
      </div>
    </div>
  );
}

function IdeaPreview({ idea, answers, current }: { idea: string; answers: Readonly<Record<string, string>>; current: string | null }) {
  return (
    <p data-testid="template-idea-preview" className="mt-2 text-[14px] leading-[1.7] text-inkMuted">
      {ideaParts(idea).map((part, i) => {
        if (!part.blank) return <span key={i}>{part.text}</span>;
        const answer = cleanAnswer(answers[part.text] ?? "");
        const here = part.text === current;
        return (
          <span
            key={answer ? `${i}-${answer}` : i}
            data-idea-blank={answer ? "filled" : "empty"}
            data-current={here ? "true" : undefined}
            className={cx(
              "mx-px rounded-md px-1 py-0.5 [box-decoration-break:clone]",
              answer && "animate-pane-fade font-semibold text-ink motion-reduce:animate-none",
              answer && !here && "bg-marigold/15 shadow-[0_0_0_1px_rgb(255_201_61/0.3)]",
              here && "bg-marigold/20 font-semibold text-ink shadow-[0_0_0_1px_rgb(255_201_61/0.55),0_0_16px_rgb(255_201_61/0.3)]",
              !answer && !here && "bg-ink/[0.06] text-inkSoft",
            )}
          >
            {answer || part.text}
          </span>
        );
      })}
    </p>
  );
}

export function TemplateGallery({
  selectedId,
  onUse,
  triggerClassName,
  triggerIcon,
}: {
  selectedId: string | null;
  onUse: (used: UsedTemplate) => void;
  triggerClassName?: string;
  triggerIcon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    trigger.current?.focus();
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid="templates-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cx(triggerClassName ?? "inline-flex items-center gap-2 rounded-full border border-rule px-3 py-1.5 text-[14px] text-ink transition-colors hover:bg-bone", FOCUS_RING)}
      >
        {triggerIcon ?? <LayoutTemplate className="h-4 w-4 text-inkMuted" aria-hidden />}
        {TEMPLATES_OPEN}
      </button>
      {open && (
        <TemplateDialog
          selectedId={selectedId}
          onClose={() => setOpen(false)}
          onUse={(used) => {
            setOpen(false);
            onUse(used);
          }}
        />
      )}
    </>
  );
}

function TemplateDialog({ selectedId, onClose, onUse }: { selectedId: string | null; onClose: () => void; onUse: (used: UsedTemplate) => void }) {
  const { templates, failed, retry } = useSiteTemplates(true);
  const [picked, setPicked] = useState<SiteTemplateCard | null>(null);
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const titleId = useId();
  const inputId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previewUseRef = useRef<HTMLButtonElement>(null);
  const returnToPreview = useRef<string | null>(null);
  const [tokens] = useState<WireframeTokens | null>(() => readWireframeTokens());

  const blanks = picked ? templateBlanks(picked.idea) : [];
  const at = step.kind === "ask" ? Math.min(step.at, blanks.length - 1) : -1;
  const blank = at >= 0 ? blanks[at]! : null;
  const ready = blank ? cleanAnswer(answers[blank] ?? "").length > 0 : false;

  useEffect(() => {
    let target: HTMLElement | null = null;
    if (step.kind === "list") {
      const want = picked?.id ?? selectedId;
      const grid = gridRef.current;
      const back = returnToPreview.current;
      target =
        (back && grid?.querySelector<HTMLElement>(`[data-testid="template-preview-${back}"]`)) ||
        (want && grid?.querySelector<HTMLElement>(`[data-testid="template-${want}"]`)) ||
        grid?.querySelector<HTMLElement>("button") ||
        closeRef.current;
      if (target && grid?.contains(target)) returnToPreview.current = null;
    } else if (step.kind === "preview") {
      target = previewUseRef.current;
    } else if (step.kind === "ask") {
      target = inputRef.current;
    } else {
      target = confirmRef.current;
    }
    target?.focus();
  }, [step, templates, picked, selectedId]);

  const pick = (t: SiteTemplateCard) => {
    setPicked(t);
    setAnswers({});
    setStep(templateBlanks(t.idea).length > 0 ? { kind: "ask", at: 0 } : { kind: "confirm" });
  };
  const next = () => {
    if (!ready) return;
    setStep(at + 1 < blanks.length ? { kind: "ask", at: at + 1 } : { kind: "confirm" });
  };
  const toList = () => setStep({ kind: "list" });
  const openPreview = (t: SiteTemplateCard) => setStep({ kind: "preview", template: t });
  const closePreview = () => {
    if (step.kind === "preview") returnToPreview.current = step.template.id;
    toList();
  };
  const use = () => {
    if (!picked) return;
    const idea = fillTemplateIdea(picked.idea, answers);
    if (templateBlanks(idea).length > 0) return;
    onUse({ template: { id: picked.id, label: picked.label, idea: picked.idea }, idea });
  };

  const title = step.kind === "preview" ? step.template.label : step.kind === "list" || !picked ? TEMPLATES_OPEN : picked.label;

  return (
    <AdsDialog
      labelledBy={titleId}
      onClose={onClose}
      onEscape={() => {
        if (step.kind !== "preview") return false;
        closePreview();
        return true;
      }}
      closeOnBackdrop
      size="lg"
      chrome={DIALOG_CHROME}
    >
      <div className="sticky top-0 z-10 flex shrink-0 items-start justify-between gap-3 bg-cream px-6 pb-3 pt-5">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[16px] font-semibold leading-6 text-ink">
            {title}
          </h2>
          {step.kind === "list" && <p className="mt-0.5 text-[13px] leading-[18px] text-inkMuted">{TEMPLATES_NOTE}</p>}
        </div>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close templates"
          onClick={onClose}
          className={cx("shrink-0 rounded-full p-1 text-inkMuted hover:bg-ink/[0.05] hover:text-ink", FOCUS_RING)}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {step.kind === "preview" ? (
        <TemplatePreview
          template={step.template}
          wireframeCss={templateWireframeCss(step.template.id, tokens)}
          primaryRef={previewUseRef}
          onUse={() => pick(step.template)}
          onBack={closePreview}
        />
      ) : step.kind === "list" || !picked ? (
        <div className="shrink-0 px-6 pb-6 pt-2 [container-type:inline-size]">
          {failed ? (
            <p role="alert" className="text-[13px] leading-5 text-inkMuted">
              {TEMPLATES_FAILED}{" "}
              <button type="button" onClick={retry} className={cx("font-medium text-ink underline underline-offset-2", FOCUS_RING)}>
                Try again
              </button>
            </p>
          ) : !templates ? (
            <div role="status" aria-label="Loading templates" className="grid grid-cols-1 gap-4 [@container(min-width:440px)]:grid-cols-2 [@container(min-width:680px)]:grid-cols-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="aspect-[16/12] animate-pulse rounded-[12px] border border-rule bg-bone" />
              ))}
            </div>
          ) : (
            <div ref={gridRef} className="grid grid-cols-1 gap-4 [@container(min-width:440px)]:grid-cols-2 [@container(min-width:680px)]:grid-cols-3">
              {templates.map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  selected={t.id === selectedId}
                  wireframeCss={templateWireframeCss(t.id, tokens)}
                  onPick={() => pick(t)}
                  onPreview={() => openPreview(t)}
                />
              ))}
            </div>
          )}
        </div>
      ) : step.kind === "ask" && blank ? (
        <div className="px-6 pb-6 pt-2">
          <div className="flex items-center gap-3">
            <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-[0.08em] text-inkMuted">{blankLabel(blank)}</span>
            <div className="flex flex-1 items-center gap-1" aria-hidden="true">
              {blanks.map((b, i) => (
                <span key={b} className={cx("h-1 flex-1 rounded-full transition-colors", i <= at ? "bg-ink/70" : "bg-ink/10")} />
              ))}
            </div>
            <span data-testid="template-step-progress" className="shrink-0 text-[11px] tabular-nums text-inkMuted" aria-live="polite">
              {at + 1} of {blanks.length}
            </span>
          </div>
          <label htmlFor={inputId} className="mt-5 block text-[16px] font-semibold leading-[1.4] text-ink">
            {blankQuestion(blank)}
          </label>
          <IdeaPreview idea={picked.idea} answers={answers} current={blank} />
          <div className="mt-5 overflow-hidden rounded-[12px] border border-rule transition-[border-color,box-shadow] focus-within:border-marigold/60 focus-within:shadow-[0_0_0_4px_rgb(255_201_61/0.14),0_0_18px_-4px_rgb(255_201_61/0.35)] motion-reduce:transition-none">
            <input
              key={blank}
              id={inputId}
              ref={inputRef}
              type="text"
              autoComplete="off"
              maxLength={ANSWER_MAX}
              value={answers[blank] ?? ""}
              placeholder={blankLabel(blank)}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [blank]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                e.preventDefault();
                e.stopPropagation();
                next();
              }}
              className="w-full border-0 bg-transparent px-4 py-3 text-[15px] leading-[22px] text-ink outline-none placeholder:text-inkLight"
            />
          </div>
          <div className="mt-6 flex items-center gap-2">
            <button type="button" onClick={toList} className={GHOST_BUTTON}>
              {TEMPLATES_BACK_TO_LIST}
            </button>
            <div className="flex-1" />
            {at > 0 && (
              <button type="button" onClick={() => setStep({ kind: "ask", at: at - 1 })} className={BACK_BUTTON}>
                Back
              </button>
            )}
            <button type="button" onClick={next} disabled={!ready} className={PRIMARY_BUTTON}>
              <span className="inline-flex items-center gap-0.5">Next<NextChevron /></span>
            </button>
          </div>
        </div>
      ) : (
        <div className="px-6 pb-6 pt-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-inkMuted">Your idea</p>
          <p className="mt-2 text-[13px] leading-[1.5] text-inkMuted">
            {blanks.length > 0 ? "This goes in the idea box. You can still edit it there." : "This template needs nothing filled in. Its idea goes in the idea box, where you can edit it."}
          </p>
          <div className="mt-3 rounded-[12px] border border-rule px-3.5 py-3">
            <p data-testid="template-filled-idea" className="text-[14px] leading-[1.5] text-ink">
              {fillTemplateIdea(picked.idea, answers)}
            </p>
          </div>
          <div className="mt-6 flex items-center gap-2">
            <button type="button" onClick={toList} className={GHOST_BUTTON}>
              {TEMPLATES_BACK_TO_LIST}
            </button>
            <div className="flex-1" />
            {blanks.length > 0 && (
              <button type="button" onClick={() => setStep({ kind: "ask", at: blanks.length - 1 })} className={BACK_BUTTON}>
                Back
              </button>
            )}
            <button ref={confirmRef} type="button" onClick={use} className={PRIMARY_BUTTON}>
              {TEMPLATES_USE}
            </button>
          </div>
        </div>
      )}
    </AdsDialog>
  );
}

export function TemplateChip({ template, blanks, onClear }: { template: PickedTemplate; blanks: readonly string[]; onClear: () => void }) {
  return (
    <div data-testid="template-chip" className="mb-2 w-full">
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-bone px-2.5 py-1 text-[12px] leading-4 text-ink">
        <LayoutTemplate className="h-3.5 w-3.5 shrink-0 text-inkMuted" aria-hidden />
        <span className="truncate">Template: {template.label}</span>
        <button
          type="button"
          aria-label={`Remove the ${template.label} template`}
          onClick={onClear}
          className={cx("shrink-0 rounded-full text-inkMuted hover:text-ink", FOCUS_RING)}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
      {blanks.length > 0 && (
        <p role="status" className="mt-1 text-[12px] leading-4 text-inkMuted">
          {blanksHint(blanks)}
        </p>
      )}
    </div>
  );
}
