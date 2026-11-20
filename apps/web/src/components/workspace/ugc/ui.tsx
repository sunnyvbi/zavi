"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUp } from "lucide-react";

export * from "../actions/creators/kit";
export * from "../actions/creators/CreatorCard";

export { SideDrawer } from "../layout/SideDrawer";

export function DrawerNote({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-rule px-4 py-6 text-center text-[14px] text-inkMuted">{children}</p>;
}

export function Bone({ className }: { className: string }) {
  return <span aria-hidden="true" className={`block animate-pulse bg-bone motion-reduce:animate-none ${className}`} />;
}

export function ThreadSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading messages.</span>
      <div aria-hidden="true" className="space-y-3">
        <Bone className="h-10 w-1/2 rounded-2xl" />
        <Bone className="ml-auto h-10 w-1/3 rounded-2xl" />
        <Bone className="h-14 w-3/5 rounded-2xl" />
      </div>
    </div>
  );
}

export function ProductQuestion({
  value,
  onChange,
  creator = "the creator",
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  creator?: string;
}) {
  const opt = (on: boolean) =>
    `inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3.5 text-[14px] font-medium transition-colors ${
      on ? "border-ink bg-ink text-cream" : "border-rule bg-cream text-ink hover:bg-bone"
    }`;
  return (
    <div>
      <p className="text-[14px] font-semibold text-ink">Do you need to send {creator} a product?</p>
      <div className="mt-1.5 flex gap-2" role="radiogroup" aria-label="Do you need to send a product?">
        <button type="button" role="radio" aria-checked={!value} onClick={() => onChange(false)} className={opt(!value)}>
          No
        </button>
        <button type="button" role="radio" aria-checked={value} onClick={() => onChange(true)} className={opt(value)}>
          Yes
        </button>
      </div>
      {value && (
        <p className="mt-2 rounded-lg bg-creamDeep px-3 py-2 text-[13px] leading-snug text-inkSoft">
          Share the delivery address in the job chat after hire. The due date starts when the creator marks Product received.
        </p>
      )}
    </div>
  );
}

export type ThreadItem =
  | { kind: "msg"; key: string; from: "me" | "them"; text: string; at: string }
  | { kind: "card"; key: string; node: ReactNode };

export function scrollDrawerToEnd(el: Element | null, behavior: ScrollBehavior = "smooth"): void {
  const root = el?.closest("[data-scroll-root]") as HTMLElement | null;
  root?.scrollTo?.({ top: root.scrollHeight, behavior });
}

export function Thread({
  them,
  items,
  placeholder,
  onSend,
  readOnly = false,
  clearOnSend = false,
  composerAction,
  beforeComposer,
  stickyComposer = false,
  pending = false,
}: {
  them: string;
  items: ThreadItem[];
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
  readOnly?: boolean;
  clearOnSend?: boolean;
  composerAction?: ReactNode;
  beforeComposer?: ReactNode;
  stickyComposer?: boolean;
  pending?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const seen = useRef(0);
  useEffect(() => {
    if (!stickyComposer || items.length === seen.current) return;
    scrollDrawerToEnd(root.current, seen.current === 0 ? "auto" : "smooth");
    seen.current = items.length;
  }, [stickyComposer, items.length]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || pending) return;
    setBusy(true);
    if (clearOnSend) setDraft("");
    const ok = await onSend(text);
    setBusy(false);
    if (ok) setDraft("");
    else if (clearOnSend) setDraft((d) => d || text);
  }

  return (
    <div ref={root} className={stickyComposer ? "flex min-h-0 flex-1 flex-col" : "flex min-h-0 flex-col"}>
      <div className={stickyComposer ? "flex-1 space-y-4" : "space-y-4"}>
        {items.map((it) =>
          it.kind === "card" ? (
            <div key={it.key}>{it.node}</div>
          ) : it.from === "me" ? (
            <div key={it.key} className="flex flex-col items-end">
              <div className="max-w-[85%] rounded-3xl bg-bone px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-ink">
                {it.text}
              </div>
              <span className="mt-1 text-[12px] text-inkLight">{it.at}</span>
            </div>
          ) : (
            <div key={it.key} className="max-w-[85%]">
              <p className="text-[13px] font-semibold text-inkMuted">
                {them} <span className="font-normal text-inkLight">· {it.at}</span>
              </p>
              <p className="mt-0.5 text-[14px] leading-relaxed whitespace-pre-wrap text-ink">{it.text}</p>
            </div>
          ),
        )}
      </div>
      {beforeComposer}
      {!readOnly && (
      <div
        data-testid="thread-composer"
        className={
          stickyComposer
            ? "sticky bottom-0 z-10 mt-8 -mb-3.5 bg-cream pb-3.5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-5 before:h-5 before:bg-gradient-to-t before:from-cream before:to-transparent"
            : "mt-4"
        }
      >
      <form onSubmit={send} className="rounded-3xl border border-rule bg-cream p-3 shadow-sm">
        <label className="sr-only" htmlFor="thread-input">
          {placeholder}
        </label>
        <textarea
          id="thread-input"
          rows={2}
          value={draft}
          disabled={pending}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className="w-full resize-none bg-transparent px-1 text-[14px] leading-relaxed text-ink placeholder:text-inkMuted focus:outline-none"
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="min-w-0">{composerAction}</div>
          <button
            type="submit"
            aria-label="Send"
            disabled={!draft.trim() || busy || pending}
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-ink text-cream transition-colors hover:bg-ink/85 disabled:cursor-not-allowed disabled:bg-ink/25"
          >
            <ArrowUp className="h-5 w-5" />
          </button>
        </div>
      </form>
      </div>
      )}
    </div>
  );
}

export function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
