"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { ChevronDown, LogOut, Menu, Search, Star, X } from "lucide-react";
import { createBrowserAdminSupabase } from "@/lib/supabase-admin";
import { GROUPS, PANIC_STOP, TONE_CLASSES, activeHref, groupOf, isGroupOpen, itemOf } from "@/lib/admin-nav";
import type { NavItem, Section, Tone } from "@/lib/admin-nav";
import { openOnlyNavGroup, setNavGroupOpen, toggleNavPin, useNavPrefs } from "@/lib/nav-prefs";
import type { NavBadges } from "@/lib/overview";

export function Sidebar({
  collapsed,
  onToggle,
  onOpenPalette,
  badges,
  mobile = false,
  onClose,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onOpenPalette: () => void;
  badges: NavBadges;
  mobile?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { pins, openGroups: stored } = useNavPrefs();

  const current = activeHref(pathname);
  const currentPinned = current !== null && pins.includes(current);
  const activeGroup = currentPinned ? null : groupOf(current);
  const rail = collapsed && !mobile;

  function toggleGroup(key: string) {
    setNavGroupOpen(key, !isGroupOpen(key, stored, activeGroup));
  }

  async function signOut() {
    setBusy(true);
    const sb = createBrowserAdminSupabase();
    await sb.auth.signOut({ scope: "local" });
    router.replace("/login");
  }

  function renderRow(s: Section, tone: Tone, opts: { pinnable: boolean; keyPrefix: string; inGroup?: boolean }) {
    const Icon = s.icon;
    const t = TONE_CLASSES[tone];
    const badge = badges[s.href];
    const pinned = pins.includes(s.href);
    const isActive = s.href === current && !(opts.inGroup && pinned);
    return (
      <div key={opts.keyPrefix + s.href} className="group/row relative mx-2 my-px">
        <Link
          href={s.href}
          onClick={mobile ? onClose : undefined}
          title={rail ? s.label + (badge ? ` (${badge.count})` : "") : undefined}
          aria-label={rail ? s.label + (badge ? `, ${badge.count}` : "") : undefined}
          aria-current={isActive ? "page" : undefined}
          className={
            "relative flex h-10 items-center gap-3 rounded-[9px] text-[14.5px] font-medium transition-colors " +
            (rail ? "justify-center" : "px-3" + (opts.pinnable ? " pr-9" : "")) +
            " " +
            (isActive ? t.activeRow + " font-semibold" : "text-slate-800 hover:bg-slate-100")
          }
        >
          {isActive && <span className={"absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r " + t.activeBar} />}
          <Icon className={"h-[18px] w-[18px] shrink-0 " + t.icon} strokeWidth={2} />
          {!rail && <span className="truncate">{s.label}</span>}
          {badge && !rail && (
            <span
              className={
                "ml-auto rounded-full px-[7px] py-px text-xs font-semibold tabular-nums " +
                (badge.tone === "red" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700")
              }
            >
              {badge.count}
            </span>
          )}
          {badge && rail && (
            <span
              aria-hidden
              className={
                "absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-white " +
                (badge.tone === "red" ? "bg-rose-600" : "bg-amber-500")
              }
            />
          )}
        </Link>
        {opts.pinnable && !rail && (
          <button
            type="button"
            onClick={(e) => {
              const btn = e.currentTarget;
              const nav = btn.closest("nav");
              toggleNavPin(s.href);
              requestAnimationFrame(() => {
                if (btn.isConnected || !nav) return;
                const twin = nav.querySelector<HTMLElement>(`[data-pin-href="${s.href}"]`);
                (twin ?? nav).focus();
              });
            }}
            data-pin-href={s.href}
            aria-pressed={pinned}
            aria-label={(pinned ? "Unpin " : "Pin ") + s.label}
            title={pinned ? "Unpin" : "Pin to top"}
            className={
              "absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md transition-opacity hover:bg-white focus-visible:opacity-100 " +
              (pinned
                ? "text-amber-500"
                : "text-slate-400 opacity-0 hover:text-amber-500 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100")
            }
          >
            <Star className="h-3.5 w-3.5" strokeWidth={2} fill={pinned ? "currentColor" : "none"} />
          </button>
        )}
      </div>
    );
  }

  const topGroup = GROUPS[0];
  const titled = GROUPS.filter((g) => g.title !== null);
  const pinnedItems = pins.map(itemOf).filter((i): i is NavItem => i !== null);

  return (
    <aside
      className={
        "flex h-full flex-col border-r border-slate-200 bg-white/85 backdrop-blur-xl transition-[width] duration-200 " +
        (rail ? "w-16" : "w-[264px]")
      }
    >
      <div className={"flex h-[60px] shrink-0 items-center gap-2.5 border-b border-slate-200 " + (rail ? "justify-center" : "px-3.5")}>
        {mobile ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg text-slate-800 hover:bg-slate-100"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" strokeWidth={1.9} />
          </button>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg text-slate-800 hover:bg-slate-100"
            aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
            title={rail ? "Expand" : "Collapse"}
          >
            <Menu className="h-5 w-5" strokeWidth={1.9} />
          </button>
        )}
        {!rail && (
          <Link href="/" className="flex items-center gap-2.5">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-slate-900 text-sm font-bold text-white">
              Z
            </span>
            <span className="text-[15px] font-semibold tracking-[0.01em] text-slate-800">
              Zavi <span className="font-medium text-slate-600">Admin</span>
            </span>
          </Link>
        )}
      </div>

      <button
        type="button"
        onClick={onOpenPalette}
        title={rail ? "Jump to page (⌘K)" : undefined}
        aria-label="Jump to page"
        className={
          "mx-3 mb-1 mt-3 flex h-[38px] shrink-0 items-center gap-2 rounded-[9px] border border-slate-200 text-left text-[14px] text-slate-600 hover:bg-slate-100 " +
          (rail ? "justify-center" : "px-2.5")
        }
      >
        <Search className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        {!rail && (
          <>
            <span>Jump to page</span>
            <kbd className="ml-auto rounded-[5px] border border-slate-200 px-1.5 py-px font-body text-[11px] text-slate-600">⌘K</kbd>
          </>
        )}
      </button>

      <nav tabIndex={-1} className="flex-1 overflow-y-auto pb-3 pt-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400" aria-label="Admin pages">
        {topGroup.items.map((s) => renderRow(s, topGroup.tone, { pinnable: false, keyPrefix: "top:" }))}

        {pinnedItems.length === 0 && !rail && (
          <p className="mx-4 mt-2 text-[12px] leading-snug text-slate-500">
            Click the star next to any page to pin it here.
          </p>
        )}
        {pinnedItems.length > 0 && (
          <div className="mt-2">
            {!rail && (
              <div className="mx-2 flex items-center gap-2 px-2.5 pb-1 pt-1.5 text-[12px] font-bold uppercase tracking-[0.07em] text-amber-700">
                <Star className="h-3 w-3" fill="currentColor" strokeWidth={2} />
                Pinned
              </div>
            )}
            {pinnedItems.map((i) => renderRow(i, i.tone, { pinnable: true, keyPrefix: "pin:" }))}
          </div>
        )}

        <div className={"my-2 border-t border-dashed border-slate-200 " + (rail ? "mx-3" : "mx-4")} />

        {titled.map((group) => {
          const title = group.title!;
          const t = TONE_CLASSES[group.tone];
          const open = isGroupOpen(group.key, stored, activeGroup);
          const groupBadges = group.items.map((i) => badges[i.href]).filter((b) => b !== undefined);
          const hasBadge = groupBadges.length > 0;
          const badgeDot = groupBadges.some((b) => b.tone === "red") ? "bg-rose-600" : "bg-amber-500";
          const containsActive = current !== null && group.items.some((i) => i.href === current);
          const GroupIcon = group.icon;

          if (rail) {
            return (
              <button
                key={group.key}
                type="button"
                onClick={() => {
                  openOnlyNavGroup(group.key);
                  onToggle();
                }}
                title={title}
                aria-label={`Open ${title}` + (hasBadge ? ", has pages needing attention" : "")}
                className="relative mx-auto my-0.5 flex h-10 w-10 items-center justify-center rounded-[10px]"
              >
                <span
                  className={
                    "flex h-9 w-9 items-center justify-center rounded-[9px] " +
                    t.railTile +
                    (containsActive && !currentPinned ? " ring-2 ring-offset-1 ring-slate-300" : "")
                  }
                >
                  <GroupIcon className="h-[18px] w-[18px]" strokeWidth={2} />
                </span>
                {hasBadge && <span aria-hidden className={"absolute right-0.5 top-0.5 h-2 w-2 rounded-full ring-2 ring-white " + badgeDot} />}
              </button>
            );
          }

          return (
            <div key={group.key} className="mt-0.5">
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                aria-expanded={open}
                className={
                  "mx-2 flex w-[calc(100%-16px)] items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.07em] hover:bg-slate-50 " +
                  t.text
                }
              >
                <span aria-hidden className={"h-2 w-2 shrink-0 rounded-full " + t.dot} />
                {title}
                {!open && (
                  <span className="text-[11px] font-medium normal-case tracking-normal text-slate-500">{group.items.length}</span>
                )}
                {!open && hasBadge && (
                  <>
                    <span aria-hidden className={"h-1.5 w-1.5 rounded-full " + badgeDot} />
                    <span className="sr-only">, has pages needing attention</span>
                  </>
                )}
                <ChevronDown
                  className={"ml-auto h-3.5 w-3.5 text-slate-400 transition-transform " + (open ? "" : "-rotate-90")}
                  strokeWidth={2}
                />
              </button>
              {open && group.items.map((s) => renderRow(s, group.tone, { pinnable: true, keyPrefix: "", inGroup: true }))}
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 space-y-1 border-t border-slate-200 py-2">
        <Link
          href={PANIC_STOP.href}
          onClick={mobile ? onClose : undefined}
          title={rail ? "Panic-stop: halts every agent" : undefined}
          aria-current={current === PANIC_STOP.href ? "page" : undefined}
          className={
            "mx-2 flex h-10 items-center gap-3 rounded-[9px] border text-[14px] font-semibold transition-colors " +
            (rail ? "justify-center" : "px-3") +
            " " +
            (current === PANIC_STOP.href
              ? "border-rose-600 bg-rose-600 text-white"
              : "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100")
          }
        >
          <PANIC_STOP.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={2} />
          {!rail && (
            <>
              <span>{PANIC_STOP.label}</span>
              <span className={"ml-auto text-[11px] font-medium " + (current === PANIC_STOP.href ? "text-rose-100" : "text-rose-500")}>
                halts every agent
              </span>
            </>
          )}
        </Link>
        <button
          type="button"
          disabled={busy}
          onClick={signOut}
          title={rail ? "Sign out" : undefined}
          className={
            "mx-2 flex h-10 w-[calc(100%-16px)] items-center gap-3 rounded-[9px] text-[14.5px] font-medium text-slate-800 transition-colors hover:bg-slate-100 " +
            (rail ? "justify-center" : "px-3")
          }
        >
          <LogOut className="h-5 w-5 shrink-0" strokeWidth={1.9} />
          {!rail && <span>{busy ? "Signing out…" : "Sign out"}</span>}
        </button>
      </div>
    </aside>
  );
}
