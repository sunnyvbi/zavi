"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { AdminGate } from "@/components/admin/AdminGate";
import { Sidebar } from "@/components/admin/Sidebar";
import { CommandPalette } from "@/components/admin/CommandPalette";
import { OverviewProvider, useOverview } from "@/components/admin/OverviewProvider";
import { navBadges } from "@/lib/overview";

const COLLAPSED_KEY = "praxis.staff.sidebarCollapsed";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const isSuggestionsWorkspace = pathname === "/suggestions";

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(COLLAPSED_KEY);
      if (v === "1") setCollapsed(true);
    } catch {}
    setMounted(true);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMobileOpen(false);
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const opener = document.activeElement as HTMLElement | null;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    const focusables = () =>
      Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [],
      );
    (focusables()[0] ?? drawerRef.current)?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const els = focusables();
      if (els.length === 0) {
        e.preventDefault();
        drawerRef.current?.focus();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      if (!drawerRef.current?.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    const desktop = window.matchMedia("(min-width: 768px)");
    function onDesktop() {
      if (desktop.matches) setMobileOpen(false);
    }
    onDesktop();
    desktop.addEventListener("change", onDesktop);
    return () => {
      document.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onDesktop);
      body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, [mobileOpen]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!isSuggestionsWorkspace) return;

    const root = document.documentElement;
    const body = document.body;
    const previous = {
      rootHeight: root.style.height,
      rootOverflow: root.style.overflow,
      rootOverscroll: root.style.overscrollBehavior,
      bodyHeight: body.style.height,
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
    };

    root.style.height = "100%";
    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    body.style.height = "100%";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    window.scrollTo(0, 0);
    mainRef.current?.scrollTo(0, 0);

    return () => {
      root.style.height = previous.rootHeight;
      root.style.overflow = previous.rootOverflow;
      root.style.overscrollBehavior = previous.rootOverscroll;
      body.style.height = previous.bodyHeight;
      body.style.overflow = previous.bodyOverflow;
      body.style.overscrollBehavior = previous.bodyOverscroll;
    };
  }, [isSuggestionsWorkspace]);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }

  return (
    <AdminGate>
      <OverviewProvider>
        <div className={isSuggestionsWorkspace ? "flex h-dvh min-h-0 overflow-hidden" : "flex min-h-screen"}>
          {mounted && (
            <>
              {}
              <div className="sticky top-0 hidden h-screen shrink-0 md:block">
                <ShellSidebar collapsed={collapsed} onToggle={toggle} onOpenPalette={() => setPaletteOpen(true)} />
              </div>
              {}
              {mobileOpen && (
                <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Admin menu">
                  <div className="absolute inset-0 bg-slate-900/35" onClick={() => setMobileOpen(false)} aria-hidden />
                  <div ref={drawerRef} tabIndex={-1} className="absolute inset-y-0 left-0 max-w-[85vw] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400">
                    <ShellSidebar
                      collapsed={false}
                      onToggle={toggle}
                      onOpenPalette={() => {
                        setMobileOpen(false);
                        setPaletteOpen(true);
                      }}
                      mobile
                      onClose={() => setMobileOpen(false)}
                    />
                  </div>
                </div>
              )}
            </>
          )}
          <main
            ref={mainRef}
            className={
              "admin-main " +
              (isSuggestionsWorkspace
                ? "h-full min-h-0 min-w-0 flex-1 overflow-hidden"
                : "min-w-0 flex-1 overflow-x-hidden")
            }
          >
            {isSuggestionsWorkspace && (
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="fixed bottom-4 left-4 z-30 inline-flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-800 shadow-lg md:hidden"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" strokeWidth={1.9} />
              </button>
            )}
            {!isSuggestionsWorkspace && <div className="h-14 md:hidden" aria-hidden />}
            {!isSuggestionsWorkspace && (
              <div className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-2.5 border-b border-slate-200 bg-white/90 px-4 backdrop-blur-xl md:hidden">
                <button
                  type="button"
                  onClick={() => setMobileOpen(true)}
                  className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg text-slate-800 hover:bg-slate-100"
                  aria-label="Open menu"
                >
                  <Menu className="h-5 w-5" strokeWidth={1.9} />
                </button>
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-slate-900 text-sm font-bold text-white">
                  Z
                </span>
                <span className="text-[15px] font-semibold text-slate-800">
                  Zavi <span className="font-medium text-slate-600">Admin</span>
                </span>
              </div>
            )}
            {children}
          </main>
        </div>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </OverviewProvider>
    </AdminGate>
  );
}

function ShellSidebar(props: Omit<React.ComponentProps<typeof Sidebar>, "badges">) {
  const { data, error } = useOverview();
  return <Sidebar {...props} badges={navBadges(error ? null : data)} />;
}
