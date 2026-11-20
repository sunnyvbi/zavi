"use client";

import { Fragment, createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Mail, MoreHorizontal, Pencil } from "lucide-react";
import { cn } from "@/lib/cn";
import { cardButton } from "../actions/card/styles";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import { gotoEmailSettings } from "./emailSettingsNav";
import type { BlankFills } from "../actions/BlanksFill";
import { blankGroup, blankLabel, blankName, blankSource, isFooterBlank } from "../actions/blanks";

export const EW = {
  card: "relative flex min-w-0 scroll-mt-28 flex-col gap-3 rounded-2xl border border-ca-strong bg-ca-bg p-5",
  cardIn: "flex min-w-0 flex-col gap-3",
  meta: "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 pr-10 text-ca-eyebrow text-ca-secondary",
  title: "pr-8 break-words text-ca-title font-semibold tracking-tight text-ca-xdark",
  why: "break-words text-ca-body text-ca-xdark",
  box: "min-w-0 overflow-hidden rounded-xl border border-ca-border bg-ca-bg",
  acts: "mt-1 flex min-w-0 flex-wrap items-center justify-end gap-1.5 border-t border-ca-border pt-3",
  primary: `${cardButton.base} ${cardButton.primary} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`,
  secondary: `${cardButton.base} ${cardButton.secondary}`,
  quiet: `${cardButton.base} ${cardButton.secondary}`,
  endRow: "flex shrink-0 items-center gap-1",
  end: `${cardButton.base} ${cardButton.ghost}`,
  outline: `${cardButton.base} ${cardButton.secondary}`,
  small: `${cardButton.base} ${cardButton.secondary} min-h-8 px-3`,
  link: "cursor-pointer border-0 bg-transparent p-0 font-semibold text-ca-primary underline underline-offset-4 hover:no-underline",
  groupHead: "flex min-w-0 items-center gap-2 text-ca-section font-semibold tracking-tight text-ca-xdark",
  count: "inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-ca-subtle px-2 text-ca-eyebrow font-semibold tabular-nums text-ca-dark",
  list: "flex min-w-0 flex-col gap-3",
} as const;

export type ChipTone = "reach" | "block" | "improve" | "wait" | "muted" | "done";

const TONE: Record<ChipTone, string> = {
  reach: "bg-ca-success-bg text-ca-success",
  block: "bg-ca-danger/10 text-ca-danger",
  improve: "bg-ca-subtle text-ca-secondary ring-1 ring-inset ring-ca-border",
  wait: "bg-ca-subtle text-ca-dark",
  muted: "bg-ca-subtle text-ca-secondary",
  done: "bg-ca-success-bg text-ca-success",
};

export function Chip({ tone, children, live }: { tone: ChipTone; children: ReactNode; live?: boolean }) {
  return (
    <span data-testid="email-chip" data-tone={tone} className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-medium leading-5", live && "inline-flex items-center gap-1.5", TONE[tone])}>
      {live && <span aria-hidden data-testid="email-chip-live-dot" className="h-1.5 w-1.5 rounded-full bg-ca-secondary motion-safe:animate-pulse" />}
      {children}
    </span>
  );
}

export function MetaRow({ chip, meta, end, corner }: { chip: ReactNode; meta: Array<string | null | undefined>; end?: ReactNode; corner?: ReactNode }) {
  const parts = meta.filter((m): m is string => !!m && !!m.trim());
  return (
    <div data-testid="email-card-meta" className={cn(EW.meta, !!corner && "[@container(min-width:640px)]:flex-nowrap [@container(min-width:640px)]:items-start")}>
      {chip}
      {parts.length > 0 && <span data-testid="email-card-meta-text" className={cn("min-w-0 break-words", !!corner && "order-2 basis-full [@container(min-width:640px)]:order-1 [@container(min-width:640px)]:flex-1 [@container(min-width:640px)]:py-0.5")}>{parts.join(" · ")}</span>}
      {end && <div className="ml-auto flex shrink-0 items-center">{end}</div>}
      {corner && <div data-testid="email-card-corner" className="order-1 ml-auto flex max-w-full shrink-0 items-center [@container(min-width:640px)]:order-2">{corner}</div>}
    </div>
  );
}

export type BoxEmail = { tab?: { title: string; when: string | null } | null; subject: ReactNode; preview: ReactNode | null; paragraphs: ReactNode[] };

const MERGE = /(\{\{\s*[a-zA-Z_][\w.]*\s*\}\}|\*\|[A-Z_]+\|\*)/g;

export function withMergeChips(text: string): ReactNode {
  const pieces = text.split(MERGE);
  if (pieces.length === 1) return text;
  return pieces.map((p, i) => (i % 2 === 1 ? (
    <span key={i} data-testid="merge-field" className="mx-0.5 inline-block rounded-[5px] bg-ca-subtle px-1.5 align-baseline text-[12.5px] leading-5 text-ca-secondary">
      {p.startsWith("{{") ? p.slice(2, -2).trim() : p.slice(2, -2).toLowerCase()}
    </span>
  ) : <Fragment key={i}>{p}</Fragment>));
}

export function EmailBox({
  emails,
  selected,
  onSelect,
  onEdit,
  editLabel = "Edit",
  blanks,
  footer,
  footerMissing = false,
}: {
  emails: BoxEmail[];
  selected: number;
  onSelect?: (i: number) => void;
  onEdit?: () => void;
  editLabel?: string;
  blanks?: ReactNode;
  footer?: ReactNode;
  footerMissing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const base = useId();
  const i = Math.min(Math.max(selected, 0), emails.length - 1);
  const email = emails[i];
  if (!email) return null;
  const tabs = emails.length > 1 && onSelect;
  const long = email.paragraphs.length > 2;
  const clamp = long && !open;
  return (
    <div data-testid="email-box" className={EW.box}>
      {tabs && (
        <BoxTabs
          label="Emails"
          base={base}
          selected={i}
          onSelect={(n) => {
            setOpen(false);
            onSelect(n);
          }}
          itemClassName="gap-1.5"
          items={emails.map((e, n) => (
            <Fragment key={n}>
              {e.tab?.title ?? `Email ${n + 1}`}
              {e.tab?.when && <small className="text-[12px] font-normal text-ca-secondary">{e.tab.when}</small>}
            </Fragment>
          ))}
        />
      )}
      <div id={`${base}-panel`} role={tabs ? "tabpanel" : undefined} aria-labelledby={tabs ? `${base}-tab-${i}` : undefined}>
        <div className="flex min-w-0 items-start gap-3.5 border-b border-ca-border px-4 py-3.5">
          <span aria-hidden className="mt-0.5 grid size-[30px] shrink-0 place-items-center rounded-full border border-ca-border text-ca-secondary">
            <Mail className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p data-testid="email-box-subject" className="break-words text-[16px] font-semibold leading-[1.35] text-ca-xdark">{email.subject}</p>
            {email.preview && <p data-testid="email-box-preview" className="mt-0.5 break-words text-[14px] leading-5 text-ca-secondary">{email.preview}</p>}
          </div>
          {onEdit && (
            <button type="button" onClick={onEdit} className={EW.small}>
              <Pencil className="size-3.5" aria-hidden />
              {editLabel}
            </button>
          )}
        </div>
        <div data-testid="email-box-body" data-clamped={clamp ? "true" : "false"} className={cn("relative px-4 pb-1 pt-4 text-[15px] leading-[1.6] text-ca-xdark sm:pl-[60px]", clamp && "max-h-[12.4em] overflow-hidden")}>
          <div className="flex flex-col gap-4">
            {email.paragraphs.map((p, n) => (
              <p key={n} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{p}</p>
            ))}
          </div>
          {clamp && <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[3.6em] bg-gradient-to-b from-ca-bg/0 to-ca-bg" />}
        </div>
        {footer}
        {blanks}
        <div className="flex min-w-0 flex-wrap items-center gap-2.5 px-4 pb-3.5 pt-2 sm:pl-[60px]">
          {long && (
            <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex min-h-[44px] cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[13px] font-medium text-ca-secondary hover:text-ca-xdark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ca-focus">
              {open ? "Show less" : "Read more"}
              <ChevronDown className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
            </button>
          )}
          {!footerMissing && (
            <span className="ml-auto text-[13px] text-ca-secondary">
              Footer from{" "}
              <button type="button" onClick={() => gotoEmailSettings("footer")} className={cn(EW.link, "text-[13px]")}>
                Settings
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const GHOST_PARAGRAPHS = [["w-full", "w-11/12", "w-3/5"], ["w-5/6", "w-2/5"]];

function GhostLine({ className, step }: { className: string; step: number }) {
  return (
    <span data-testid="email-ghost-line" className={cn("relative block overflow-hidden rounded-full bg-ca-subtle", className)}>
      <span style={{ animationDelay: `${step * 120}ms` }} className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-ca-xdark/[0.08] to-transparent motion-safe:animate-shimmer motion-reduce:hidden" />
    </span>
  );
}

export function EmailBoxGhost() {
  return (
    <div aria-hidden data-testid="email-box-ghost" className={EW.box}>
      <div className="flex min-w-0 items-start gap-3.5 border-b border-ca-border px-4 py-3.5">
        <span className="mt-0.5 grid size-[30px] shrink-0 place-items-center rounded-full border border-ca-border text-ca-secondary">
          <Mail className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
          <GhostLine className="h-3.5 w-3/5" step={0} />
          <GhostLine className="h-2.5 w-2/5" step={1} />
        </div>
      </div>
      <div className="flex flex-col gap-4 px-4 pb-5 pt-4 sm:pl-[60px]">
        {GHOST_PARAGRAPHS.map((lines, p) => (
          <div key={p} className="flex flex-col gap-2.5">
            {lines.map((width, n) => (
              <GhostLine key={width} className={cn("h-2", width)} step={2 + p * 3 + n} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const BLANK_INPUT =
  "mt-1 h-9 w-full min-w-0 rounded-[10px] border bg-ca-bg px-3 text-[16px] leading-5 text-ca-xdark outline-none transition-[border-color,box-shadow] placeholder:text-ca-secondary focus:border-marigold/60 focus:shadow-[0_0_0_4px_rgb(255_201_61/0.14)] motion-reduce:transition-none";

function InlineBlankField({ fills, blank, index }: { fills: BlankFills; blank: string; index: number }) {
  const { title, hint } = blankLabel(blank);
  const known = fills.typed[blank] === undefined ? fills.known[blank] : undefined;
  const empty = !fills.values[blank]?.trim();
  const helpId = useId();
  const { setActive } = fills;
  useEffect(() => () => setActive?.((current) => (current === blank ? null : current)), [blank, setActive]);
  return (
    <label data-testid="blank-field" data-state={known ? "auto" : empty ? "empty" : "typed"} className="block min-w-0">
      <span className="flex items-center gap-1 text-[12px] leading-4 text-ca-secondary">
        <span className="truncate">{title}</span>
        {!empty && <Check data-testid="blank-done" className="size-3 shrink-0 text-ca-success" aria-hidden />}
      </span>
      <input
        type="text"
        name={`zavi-blank-${index}`}
        autoComplete="off"
        data-1p-ignore=""
        data-lpignore="true"
        data-form-type="other"
        value={fills.typed[blank] ?? fills.values[blank] ?? ""}
        placeholder={hint ?? undefined}
        onChange={(e) => fills.set(blank, e.target.value)}
        onFocus={() => fills.setActive?.(blank)}
        onBlur={() => fills.setActive?.(null)}
        aria-label={blankName(blank)}
        aria-invalid={fills.problem?.[blank] ? true : undefined}
        aria-describedby={fills.problem?.[blank] ? helpId : known?.from ? helpId : undefined}
        className={cn(BLANK_INPUT, empty ? "border-ca-border" : "border-success/35")}
      />
      {fills.problem?.[blank] ? (
        <span id={helpId} role="alert" data-testid="blank-problem" className="mt-1 block text-[11.5px] leading-4 text-ca-xdark [overflow-wrap:anywhere]">
          {fills.problem[blank]}
        </span>
      ) : known?.from ? (
        <span id={helpId} data-testid="blank-from" className="mt-1 block text-[11.5px] leading-4 text-ca-secondary [overflow-wrap:anywhere]">
          {known.from}
        </span>
      ) : null}
    </label>
  );
}

export function InlineBlanks({ fills }: { fills: BlankFills }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const reopen = useRef(false);
  const pressed = useRef(false);
  const released = useRef(-Infinity);
  const waiting = useRef<(() => void) | null>(null);
  const fields = fills.blanks.filter((b) => !isFooterBlank(b));
  const unread = fills.ready !== false && fills.blanks.some((b) => isFooterBlank(b) && !fills.values[b]?.trim() && fills.footerUnread?.includes(blankSource(b) as "postal_address" | "unsubscribe"));
  const typedLeft = fields.filter((b) => !fills.values[b]?.trim()).length;
  const slotted = fills.ready === false ? 0 : fills.blanks.filter((b) => isFooterBlank(b) && !fills.values[b]?.trim() && !fills.footerUnread?.includes(blankSource(b) as "postal_address" | "unsubscribe")).length;
  const collapsed = fields.length > 0 && fills.left === 0 && !open;
  useEffect(() => {
    if (!open || !reopen.current) return;
    reopen.current = false;
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [open]);
  useEffect(() => {
    const down = () => {
      pressed.current = true;
    };
    const up = () => {
      pressed.current = false;
      released.current = performance.now();
    };
    const reset = () => {
      pressed.current = false;
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("contextmenu", reset, true);
    window.addEventListener("blur", reset);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("contextmenu", reset, true);
      window.removeEventListener("blur", reset);
      waiting.current?.();
      waiting.current = null;
    };
  }, []);
  if (!fills.blanks.length || (!fields.length && !unread)) return null;
  const index = new Map(fills.blanks.map((b, i) => [b, i]));
  const ordered = [...fields.filter((b) => blankGroup(b) === "recipient"), ...fields.filter((b) => blankGroup(b) !== "recipient")];
  const left = Math.max(fills.left - slotted, 0);
  return (
    <div
      ref={ref}
      data-testid="blanks-fill"
      data-state={collapsed ? "filled" : "open"}
      onFocus={(e) => {
        if (e.target instanceof HTMLInputElement) setOpen(true);
      }}
      onBlur={(e) => {
        if (!(e.target instanceof HTMLInputElement) || ref.current?.contains(e.relatedTarget as Node | null)) return;
        const wait = (events: string[], ms?: number) => {
          waiting.current?.();
          let timer: number | undefined;
          const stop = () => {
            for (const name of events) window.removeEventListener(name, later, true);
            window.removeEventListener("blur", later);
            window.clearTimeout(timer);
          };
          const later = () => {
            stop();
            timer = window.setTimeout(() => {
              if (waiting.current === stop) waiting.current = null;
              if (!ref.current?.contains(document.activeElement)) setOpen(false);
            }, 0);
          };
          for (const name of events) window.addEventListener(name, later, true);
          window.addEventListener("blur", later);
          if (ms !== undefined) timer = window.setTimeout(later, ms);
          waiting.current = stop;
        };
        if (pressed.current) {
          wait(["pointerup", "pointercancel", "contextmenu"]);
          return;
        }
        if (performance.now() - released.current < 500) {
          wait(["click"], 500);
          return;
        }
        waiting.current?.();
        waiting.current = null;
        setOpen(false);
      }}
      className="min-w-0 border-t border-ca-border px-4 py-3 sm:pl-[60px]"
    >
      {collapsed ? (
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-ca-secondary">
          <Check className="size-3.5 shrink-0 text-ca-success" aria-hidden />
          <span data-testid="blanks-left">Blanks filled</span>
          <button
            type="button"
            onClick={() => {
              reopen.current = true;
              setOpen(true);
            }}
            className={cn(EW.link, "ml-1 text-[13px]")}
          >
            Change
          </button>
        </p>
      ) : (
        <>
          {fields.length > 0 && (
            <p data-testid="blanks-left" className="text-[13px] leading-5 text-ca-secondary">
              {left ? `${left} ${left === 1 ? "blank" : "blanks"} to fill` : "Blanks filled"}
            </p>
          )}
          {ordered.length > 0 && (
            <div className="mt-2 grid grid-cols-1 items-start gap-x-3 gap-y-2.5 sm:grid-cols-2">
              {ordered.map((b) => (
                <InlineBlankField key={b} fills={fills} blank={b} index={index.get(b) ?? 0} />
              ))}
            </div>
          )}
          {unread ? (
            <p data-testid="blank-footer-unread" role="status" className="mt-2 text-[13px] leading-5 text-ca-xdark">
              Could not read your footer settings. Trying again.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function BoxTabs({
  label,
  base,
  selected,
  onSelect,
  items,
  itemClassName,
}: {
  label: string;
  base: string;
  selected: number | undefined;
  onSelect: (i: number) => void;
  items: ReactNode[];
  itemClassName?: string;
}) {
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(selected);
  return (
    <div ref={listRef} role="tablist" aria-label={label} className="relative flex min-w-0 gap-0.5 overflow-x-auto border-b border-ca-border px-2.5 pt-2">
      <SlidingIndicator box={box} className="border-b-2 border-ca-action" />
      {items.map((item, n) => (
        <button
          key={n}
          type="button"
          role="tab"
          id={`${base}-tab-${n}`}
          aria-selected={n === selected}
          aria-controls={`${base}-panel`}
          onClick={() => onSelect(n)}
          className={cn(
            "relative -mb-px flex shrink-0 cursor-pointer items-center whitespace-nowrap border-b-2 border-transparent bg-transparent px-3 py-2.5 text-[14px] transition-colors duration-300",
            itemClassName,
            n === selected ? "font-medium text-ca-xdark" : "text-ca-secondary hover:text-ca-xdark",
          )}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

export function CodeBox({
  label,
  content,
  mono = true,
  blanks,
  tabs,
  selected = 0,
  onSelect,
}: {
  label: string | null;
  content: string;
  mono?: boolean;
  blanks?: ReactNode;
  tabs?: string[];
  selected?: number;
  onSelect?: (i: number) => void;
}) {
  const base = useId();
  const tabbed = !!tabs && tabs.length > 1 && !!onSelect;
  return (
    <div data-testid="email-code-box" className={EW.box}>
      {tabbed ? (
        <BoxTabs label="Parts" base={base} selected={selected} onSelect={onSelect} items={tabs} />
      ) : (
        label && <div className="border-b border-ca-border px-4 py-2.5 text-[11.5px] uppercase tracking-[0.07em] text-ca-secondary">{label}</div>
      )}
      <pre id={tabbed ? `${base}-panel` : undefined} role={tabbed ? "tabpanel" : undefined} aria-labelledby={tabbed ? `${base}-tab-${selected}` : undefined} className={cn("m-0 whitespace-pre-wrap break-words px-4 py-3.5 leading-[1.6] text-ca-xdark [overflow-wrap:anywhere]", mono ? "font-mono text-[13px]" : "font-sans text-[15px]")}>{content}</pre>
      {blanks}
    </div>
  );
}

export function GroupHead({ icon, title, count, testId }: { icon: ReactNode; title: string; count?: number; testId?: string }) {
  return (
    <h3 data-testid={testId} className={EW.groupHead}>
      {icon}
      {title}
      {count !== undefined && count > 0 && <span className={EW.count}>{count}</span>}
    </h3>
  );
}

export type EmailPlanBridgeValue = { setPlannedCards: (ids: string[]) => void; setClosedCards?: (ids: string[]) => void; sentInDone?: boolean; ask?: (cardId: string) => void };

export const EmailPlanBridge = createContext<EmailPlanBridgeValue | null>(null);

export function useEmailPlanBridge(): EmailPlanBridgeValue | null {
  return useContext(EmailPlanBridge);
}

export function MoreMenu({ items }: { items: Array<{ label: string; onSelect: () => void; disabled?: boolean; expanded?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)} className="grid size-8 cursor-pointer place-items-center rounded-[8px] border border-ca-border bg-ca-bg text-ca-secondary transition-colors hover:border-ca-strong hover:bg-ca-subtle hover:text-ca-xdark">
        <MoreHorizontal className="size-4" aria-hidden />
      </button>
      {open && (
        <div id={id} role="menu" className="absolute bottom-full right-0 z-20 mb-1.5 min-w-40 rounded-[12px] border border-ca-border bg-ca-bg p-1 shadow-[0_12px_32px_rgb(0_0_0/0.25)]">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              aria-expanded={it.expanded}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className="flex w-full cursor-pointer items-center rounded-[8px] bg-transparent px-3 py-2 text-left text-[14px] text-ca-xdark transition-colors hover:bg-ca-subtle disabled:cursor-not-allowed disabled:opacity-40"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CtaPill({ label, href, color }: { label: string; href?: string | null; color?: string | null }) {
  const hex = color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null;
  return (
    <a
      href={href ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="email-cta"
      style={hex ? { backgroundColor: hex } : undefined}
      className={cn("inline-flex max-w-full items-center gap-1 rounded-full px-3.5 py-1.5 text-[13px] font-semibold no-underline", hex ? "text-white" : "bg-ca-action text-ca-on-action")}
    >
      <span className="truncate">{label}</span>
      <ChevronRight className="size-3.5 shrink-0" aria-hidden />
    </a>
  );
}

const FOOTER_WORDS: Record<"postal_address" | "unsubscribe", string> = { unsubscribe: "Unsubscribe link", postal_address: "Postal address" };

export function FooterSlot({ missing, lines, onEdit }: { missing: Array<"postal_address" | "unsubscribe">; lines: string[]; onEdit: () => void }) {
  if (missing.length > 0) {
    const names = missing.map((s) => FOOTER_WORDS[s]);
    const title = `${names[0]}${names[1] ? ` and ${names[1].toLowerCase()}` : ""} missing`;
    return (
      <div className="px-4 pb-4 sm:pl-[60px]">
        <div data-testid="footer-slot" data-state="missing" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-dashed border-ca-strong px-3.5 py-3">
          <div className="min-w-0 flex-1 basis-[200px]">
            <p className="break-words text-[14px] font-medium leading-5 text-ca-xdark">{title}</p>
            <p className="break-words text-[13px] leading-5 text-ca-secondary">{missing.length > 1 ? "Emails need these before they can go out." : "Emails need this before they can go out."}</p>
          </div>
        </div>
      </div>
    );
  }
  if (!lines.length) return null;
  return (
    <div className="px-4 pb-4 sm:pl-[60px]">
      <div data-testid="footer-slot" data-state="filled" className="flex min-w-0 items-start gap-3 border-t border-ca-border pt-3">
        <div className="min-w-0 flex-1 text-[13px] leading-5 text-ca-secondary">
          {lines.map((l, n) => (
            <p key={n} className="whitespace-pre-line break-words [overflow-wrap:anywhere]">{l}</p>
          ))}
        </div>
        <button type="button" onClick={onEdit} className={cn(EW.link, "inline-flex min-h-[44px] shrink-0 items-center text-[13px]")}>
          Edit
        </button>
      </div>
    </div>
  );
}
