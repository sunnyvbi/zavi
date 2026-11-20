"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Clapperboard, FilePen, Image as ImageIcon, Megaphone, MessageSquare, Plus, Rocket, Search, Type, Video, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import type { TopActionSpec } from "../platformSpec";
import { cardButton } from "../card/styles";

const ICONS: ReadonlyArray<readonly [RegExp, LucideIcon]> = [
  [/boost/i, Rocket],
  [/campaign/i, Megaphone],
  [/image|pin/i, ImageIcon],
  [/reel|video/i, Video],
  [/comment|reply|thread/i, MessageSquare],
  [/script/i, Clapperboard],
  [/find|scan/i, Search],
  [/bio|rewrite/i, Type],
];

const iconFor = (label: string): LucideIcon => ICONS.find(([re]) => re.test(label))?.[1] ?? FilePen;

const ITEM = "flex min-h-10 w-full items-center gap-3 px-4 py-2.5 text-left text-ca-action font-medium text-ca-dark hover:bg-ca-subtle focus-visible:bg-ca-subtle focus-visible:outline-none";

export function CreateMenu({ label, actions, tag, onPick, direct = false }: {
  label: string;
  actions: readonly TopActionSpec[];
  tag: string | null;
  onPick: (a: TopActionSpec) => void;
  direct?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items.current.filter((b): b is HTMLButtonElement => b !== null);
    const at = list.findIndex((b) => b === document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      list[e.key === "Home" ? 0 : list.length - 1]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  if (direct && actions.length === 1) {
    return (
      <button
        type="button"
        data-testid={`top-action-${actions[0].key}`}
        data-header-create
        onClick={() => onPick(actions[0])}
        className={cn(cardButton.base, cardButton.primary, "pl-3.5 pr-4 compact:whitespace-nowrap compact:px-3 [@media(max-width:399px)]:px-2.5")}
      >
        <Plus className="size-4 shrink-0" aria-hidden />
        <span className="[@media(max-width:399px)]:sr-only">{label}</span>
        {tag && <span className="rounded bg-ca-on-action/20 px-1 text-[11px] font-semibold [@media(max-width:399px)]:hidden">{tag}</span>}
      </button>
    );
  }

  return (
    <div ref={root} className="relative" data-testid="channel-create-menu" data-header-create>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(cardButton.base, cardButton.primary, "pl-3.5 pr-3 compact:whitespace-nowrap compact:px-3 [@media(max-width:399px)]:px-2.5")}
      >
        <Plus className="size-4 shrink-0" aria-hidden />
        <span className="[@media(max-width:399px)]:sr-only">{label}</span>
        {tag && <span className="rounded bg-ca-on-action/20 px-1 text-[11px] font-semibold [@media(max-width:399px)]:hidden">{tag}</span>}
        <ChevronDown className={cn("size-4 shrink-0 transition-transform duration-200 ease-ca-spring compact:hidden", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label="What do you want to make?" onKeyDown={onKey} className="absolute right-0 top-full z-30 mt-2 min-w-[220px] rounded-2xl border border-ca-border bg-ca-bg py-2 shadow-ca-xl">
          {actions.map((a, i) => {
            const Icon = iconFor(a.label);
            return (
              <button
                key={a.key}
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-testid={`top-action-${a.key}`}
                onClick={() => {
                  setOpen(false);
                  onPick(a);
                }}
                className={ITEM}
              >
                <Icon className="size-5 shrink-0 text-ca-icon-light" aria-hidden />
                {a.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
