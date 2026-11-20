"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, Menu, X } from "lucide-react";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import type { Cta } from "@/lib/resolveCta";
import { UserMenu } from "@/components/UserMenu";
import { CtaLabel } from "@/components/marketing/CtaLabel";
import { ZaviWordmark } from "./ZaviWordmark";
import { NAV_MENUS, NAV_LINKS, type NavMenu, type NavMenuKey } from "./growthNavData";
import { UseCasesMenuPanel } from "./UseCasesMenuPanel";
import { prefetchLiveStats } from "@/lib/marketing/liveStats";

const CREATORS_PATH = "/creators";

const EASE = "transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]";
const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e0f11] focus-visible:shadow-none";

export function GrowthHeader({
  cta,
  email,
  alwaysGlass = false,
  loginHref = "/login",
}: {
  cta: Cta;
  loginHref?: string;
  email?: string | null;
  alwaysGlass?: boolean;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [openMenu, setOpenMenu] = useState<NavMenuKey | null>(null);
  const [hoveredUseCase, setHoveredUseCase] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const panelId = useId();
  const mobilePanelId = useId();

  useEffect(() => {
    prefetchLiveStats();
  }, []);

  const startLink = (href: string) => (href === "/start" && cta.href.split(/[?#]/)[0] === "/start" ? cta.href : href);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!openMenu && !mobileOpen) return;
    const closeAll = () => {
      setOpenMenu(null);
      setMobileOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) closeAll();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu, mobileOpen]);

  useEffect(() => setHoveredUseCase(null), [openMenu]);

  const menu: NavMenu | null = openMenu ? NAV_MENUS[openMenu] : null;
  const customPanel = menu?.panel ?? null;
  const itemHover = (id: string) =>
    customPanel === "useCases"
      ? { onMouseEnter: () => setHoveredUseCase(id), onFocus: () => setHoveredUseCase(id) }
      : {};
  const glass = alwaysGlass || scrolled || openMenu !== null;

  const navItem = `inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full text-[15px] font-medium whitespace-nowrap text-[#0e0f11] transition-[color,padding] duration-300 hover:text-[#595959] ${FOCUS} focus-visible:rounded-full ${
    scrolled ? "px-2" : "px-2.5 lg:px-3"
  }`;
  const primaryBtn = `inline-flex items-center justify-center rounded-full bg-[#0e0f11] text-[15px] font-medium whitespace-nowrap text-white transition-opacity duration-200 hover:opacity-90 ${FOCUS} focus-visible:rounded-full phone:px-3 ${
    scrolled ? "min-h-10 px-4" : "min-h-11 px-6"
  }`;

  return (
    <header ref={headerRef} className="fixed inset-x-0 top-0 z-50 px-3 sm:px-4">
      <div
        className={`relative mx-auto flex items-center justify-between gap-4 phone:gap-2 rounded-full border lg:grid lg:grid-cols-[1fr_auto_1fr] ${EASE} ${
          scrolled
            ? "mt-2.5 h-14 max-w-[940px] px-3 sm:h-[60px] sm:px-4"
            : "mt-3 h-16 max-w-[1340px] px-4 sm:h-[72px] sm:px-6"
        } ${glass ? "liquid-glass" : "border-transparent bg-transparent shadow-none"}`}
      >
        {}
        <div className="flex min-w-0 items-center gap-1 md:gap-2 lg:contents">
          <button
            type="button"
            onClick={() => {
              setOpenMenu(null);
              setMobileOpen((v) => !v);
            }}
            aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
            aria-haspopup="true"
            aria-expanded={mobileOpen}
            aria-controls={mobileOpen ? mobilePanelId : undefined}
            className={`inline-flex size-12 phone:size-11 shrink-0 items-center justify-center rounded-full text-[#0e0f11] transition-colors hover:bg-[#0e0f11]/[0.05] md:hidden ${FOCUS} focus-visible:rounded-full`}
          >
            {mobileOpen ? (
              <X className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Menu className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
          <Link
            href="/"
            aria-label="Zavi home"
            className={`inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 phone:px-1 lg:col-start-2 lg:row-start-1 lg:justify-self-center lg:px-3 ${FOCUS} focus-visible:rounded-lg`}
          >
            <ZaviWordmark
              className={`w-auto text-[#0e0f11] ${EASE} ${scrolled ? "h-[19px]" : "h-[22px]"}`}
            />
          </Link>

          <nav
            aria-label="Primary"
            className={`hidden items-center md:flex lg:col-start-1 lg:row-start-1 ${scrolled ? "gap-0.5" : "gap-0.5 lg:gap-2"}`}
          >
            {(Object.keys(NAV_MENUS) as NavMenuKey[])
              .filter((key) => key !== "integration")
              .map((key) => {
                const isOpen = openMenu === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-haspopup="true"
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? panelId : undefined}
                    onClick={() => {
                      setMobileOpen(false);
                      setOpenMenu(isOpen ? null : key);
                    }}
                    className={`${navItem} ${isOpen ? "bg-[#0e0f11]/[0.05]" : ""}`}
                  >
                    {NAV_MENUS[key].label}
                    <ChevronDown
                      aria-hidden="true"
                      className={`h-4 w-4 text-[#595959] transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                );
              })}
            {NAV_LINKS.filter((l) => l.href !== "/pricing").map((l) => (
              <Link key={l.label} href={l.href} className={navItem}>
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-2 phone:gap-1.5 sm:gap-3 lg:col-start-3 lg:row-start-1 lg:justify-self-end">
          <Link href="/pricing" prefetch={false} className={`${navItem} hidden md:inline-flex`}>
            Pricing
          </Link>
          {email ? (
            <>
              <Link href={cta.href} prefetch={false} className={primaryBtn}>
                <CtaLabel cta={cta} />
              </Link>
              <UserMenu email={email} variant="marketing" compact />
            </>
          ) : (
            <>
              {CREATOR_MARKETPLACE_ENABLED && (
                <Link href={CREATORS_PATH} prefetch={false} className={`${navItem} hidden xl:inline-flex`}>
                  For Creators
                </Link>
              )}
              {}
              <Link href={loginHref} prefetch={false} className={`${navItem} phone:hidden`}>
                Sign in
              </Link>
              <Link href={cta.href} prefetch={false} className={primaryBtn}>
                <CtaLabel cta={cta} />
              </Link>
            </>
          )}
        </div>
      </div>

      {mobileOpen && (
        <div
          id={mobilePanelId}
          className="mx-auto mt-2 max-h-[calc(100dvh-7.5rem)] max-w-[1340px] overflow-y-auto overscroll-contain rounded-block border border-black/[0.08] bg-white p-4 shadow-[0_24px_70px_-26px_rgba(16,18,20,0.40)] md:hidden"
        >
          <nav aria-label="Menu" className="flex flex-col gap-1">
            {(Object.keys(NAV_MENUS) as NavMenuKey[])
              .filter((key) => key !== "integration")
              .map((key) => {
                const m: NavMenu = NAV_MENUS[key];
                return (
                  <details key={key} className="group">
                    <summary
                      className={`flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg px-2 text-[14px] font-semibold text-[#0e0f11] [&::-webkit-details-marker]:hidden ${FOCUS} focus-visible:rounded-lg`}
                    >
                      {m.label}
                      <ChevronDown
                        aria-hidden="true"
                        className="h-4 w-4 text-[#595959] transition-transform duration-200 group-open:rotate-180"
                      />
                    </summary>
                    <ul className="mt-1 pl-2">
                      {m.items.map((item) => (
                        <li key={item.id}>
                          <Link
                            href={startLink(item.href)}
                            prefetch={false}
                            onClick={() => setMobileOpen(false)}
                            className={`flex min-h-11 items-center gap-2 rounded-lg px-2 text-[14px] font-medium text-[#0e0f11] ${FOCUS} focus-visible:rounded-lg`}
                          >
                            {item.name}
                            {item.tag && (
                              <span className="rounded-full bg-[#0e0f11]/[0.07] px-1.5 py-0.5 text-[12px] font-semibold leading-none text-[#595959]">
                                {item.tag}
                              </span>
                            )}
                          </Link>
                        </li>
                      ))}
                      {m.more && (
                        <li>
                          <Link
                            href={startLink(m.more.href)}
                            prefetch={false}
                            onClick={() => setMobileOpen(false)}
                            className={`flex min-h-11 items-center gap-2 rounded-lg px-2 text-[14px] font-semibold text-[#027bff] ${FOCUS} focus-visible:rounded-lg`}
                          >
                            {m.more.label}
                            <ArrowRight className="h-4 w-4" aria-hidden="true" />
                          </Link>
                        </li>
                      )}
                    </ul>
                  </details>
                );
              })}
            <ul className="border-t border-black/[0.08] pt-2">
              {NAV_LINKS.map((l) => (
                <li key={l.label}>
                  <Link
                    href={l.href}
                    prefetch={false}
                    onClick={() => setMobileOpen(false)}
                    className={`flex min-h-11 items-center rounded-lg px-2 text-[14px] font-medium text-[#0e0f11] ${FOCUS} focus-visible:rounded-lg`}
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
              {CREATOR_MARKETPLACE_ENABLED && (
                <li>
                  <Link
                    href={CREATORS_PATH}
                    prefetch={false}
                    onClick={() => setMobileOpen(false)}
                    className={`flex min-h-11 items-center rounded-lg px-2 text-[14px] font-medium text-[#0e0f11] ${FOCUS} focus-visible:rounded-lg`}
                  >
                    For Creators
                  </Link>
                </li>
              )}
              {!email && (
                <li className="hidden phone:block">
                  <Link
                    href={loginHref}
                    prefetch={false}
                    onClick={() => setMobileOpen(false)}
                    className={`flex min-h-11 items-center rounded-lg px-2 text-[14px] font-medium text-[#0e0f11] ${FOCUS} focus-visible:rounded-lg`}
                  >
                    Sign in
                  </Link>
                </li>
              )}
            </ul>
          </nav>
        </div>
      )}

      {menu && (
        <div
          id={panelId}
          role="region"
          aria-label={`${menu.label} menu`}
          onMouseLeave={() => setHoveredUseCase(null)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHoveredUseCase(null);
          }}
          className="mx-auto mt-2 hidden max-w-marketing-menu rounded-[28px] border border-white/60 bg-white/90 p-3 shadow-[0_24px_64px_-16px_rgba(16,18,20,0.22)] backdrop-blur-xl backdrop-saturate-150 md:block"
        >
          <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex min-w-0 flex-col">
              {menu.groups ? (
                <div className="grid min-w-0 gap-4 p-2 sm:grid-cols-2 lg:grid-cols-3">
                  {menu.groups.map((g) => (
                    <div key={g.label} className="min-w-0">
                      <p className="px-3 pb-1 pt-1 text-[12px] font-semibold uppercase tracking-[0.12em] text-[#8a8a84]">
                        {g.label}
                      </p>
                      <ul className="grid min-w-0 gap-1">
                        {g.ids
                          .map((id) => menu.items.find((i) => i.id === id))
                          .filter((i): i is NonNullable<typeof i> => Boolean(i))
                          .map((item) => (
                            <li key={item.id} className="min-w-0">
                              <Link
                                href={startLink(item.href)}
                                onClick={() => setOpenMenu(null)}
                                {...itemHover(item.id)}
                                className={`flex min-h-11 min-w-0 items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors duration-200 hover:bg-[#0e0f11]/[0.04] ${
                                  customPanel === "useCases" && hoveredUseCase === item.id ? "bg-[#0e0f11]/[0.04]" : ""
                                } ${FOCUS} focus-visible:rounded-2xl`}
                              >
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(16,18,20,0.06)]">
                                  {item.icon}
                                </span>
                                <span className="min-w-0">
                                  <span className="flex items-center gap-2 text-[14px] font-semibold text-[#0e0f11]">
                                    <span className="truncate">{item.name}</span>
                                    {(item.tag ?? (item.soon ? "Soon" : null)) && (
                                      <span className="rounded-full bg-[#0e0f11]/[0.07] px-1.5 py-0.5 text-[12px] font-semibold leading-none text-[#595959]">
                                        {item.tag ?? "Soon"}
                                      </span>
                                    )}
                                  </span>
                                  <span className="block truncate text-[14px] text-[#595959]">
                                    {item.blurb}
                                  </span>
                                </span>
                              </Link>
                            </li>
                          ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : (
              <ul className="grid gap-1 p-2 sm:grid-cols-2 lg:grid-cols-3">
                {menu.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={startLink(item.href)}
                      onClick={() => setOpenMenu(null)}
                      {...itemHover(item.id)}
                      className={`flex min-h-11 items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors duration-200 hover:bg-[#0e0f11]/[0.04] ${FOCUS} focus-visible:rounded-2xl`}
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(16,18,20,0.06)]">
                        {item.icon}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 text-[14px] font-semibold text-[#0e0f11]">
                          <span className="truncate">{item.name}</span>
                          {(item.tag ?? (item.soon ? "Soon" : null)) && (
                            <span className="rounded-full bg-[#0e0f11]/[0.07] px-1.5 py-0.5 text-[12px] font-semibold leading-none text-[#595959]">
                              {item.tag ?? "Soon"}
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[14px] text-[#595959]">
                          {item.blurb}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              )}
              {menu.more && (
                <Link
                  href={startLink(menu.more.href)}
                  onClick={() => setOpenMenu(null)}
                  className={`mx-2 mb-2 mt-1 inline-flex min-h-11 w-fit items-center gap-2 rounded-full px-3 text-[14px] font-semibold text-[#0e0f11] transition-colors duration-200 hover:bg-[#0e0f11]/[0.04] ${FOCUS} focus-visible:rounded-full`}
                >
                  {menu.more.label}
                  <ArrowRight aria-hidden="true" className="h-4 w-4" />
                </Link>
              )}
            </div>

            {customPanel === "useCases" ? (
              <UseCasesMenuPanel startHref={cta.href.split(/[?#]/)[0] === "/start" ? cta.href : "/start"} hoveredSlug={hoveredUseCase} onNavigate={() => setOpenMenu(null)} />
            ) : menu.aside ? (
            <aside className="flex flex-col justify-between rounded-[20px] bg-[#f0f0f0] p-6 text-[#0e0f11]">
              <div>
                <p className="text-[14px] font-semibold uppercase tracking-[0.12em] text-[#595959]">
                  {menu.label} · {menu.items.length}
                </p>
                <p className="mt-3 text-[22px] font-bold leading-snug">
                  {menu.aside.title}
                </p>
                <p className="mt-3 text-[14px] leading-relaxed text-[#595959]">
                  {menu.aside.body}
                </p>
              </div>
              <Link
                href={startLink(menu.aside.href)}
                onClick={() => setOpenMenu(null)}
                className={`mt-6 inline-flex min-h-11 w-fit items-center gap-2 rounded-full bg-[#0e0f11] px-4 text-[14px] font-semibold text-white transition-opacity duration-200 hover:opacity-90 ${FOCUS} focus-visible:rounded-full`}
              >
                {menu.aside.cta}
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Link>
              {menu.aside.link && (
                <Link
                  href={startLink(menu.aside.link.href)}
                  onClick={() => setOpenMenu(null)}
                  className={`mt-3 inline-flex min-h-11 w-fit items-center gap-1 text-[14px] font-semibold text-[#0e0f11] underline-offset-4 hover:underline ${FOCUS} focus-visible:rounded-lg`}
                >
                  {menu.aside.link.label}
                </Link>
              )}
            </aside>
            ) : null}
          </div>
        </div>
      )}
    </header>
  );
}
