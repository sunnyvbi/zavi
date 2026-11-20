"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function HumanSectionShell({
  title,
  lede,
  breadcrumb,
  actions,
  children,
}: {
  title: string;
  lede: string;
  breadcrumb?: { label: string; href?: string }[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-cream font-body text-ink antialiased">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
        <nav
          aria-label="Breadcrumb"
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-inkMuted"
        >
          <Link href="/workspace" className="hover:text-ink hover:underline">
            Workspace
          </Link>
          <span aria-hidden>/</span>
          {breadcrumb && breadcrumb.length > 0 ? (
            <Link href="/humans" className="hover:text-ink hover:underline">
              Human
            </Link>
          ) : (
            <span className="font-medium text-ink">Human</span>
          )}
          {(breadcrumb ?? []).map((c, i, all) => (
            <span key={`${c.label}-${i}`} className="flex items-center gap-2">
              <span aria-hidden>/</span>
              {c.href && i < all.length - 1 ? (
                <Link href={c.href} className="hover:text-ink hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span className="font-medium text-ink">{c.label}</span>
              )}
            </span>
          ))}
        </nav>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-[26px] font-semibold leading-[1.15] tracking-tight text-ink sm:text-[30px]">
              {title}
            </h1>
            <p className="mt-2.5 max-w-[62ch] text-[16px] leading-[1.55] text-inkMuted">
              {lede}
            </p>
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>

        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}

export function HumanViewTabs({
  tabs,
  active,
}: {
  tabs: { href: string; label: string; count?: number | null }[];
  active: string;
}) {
  return (
    <nav
      aria-label="Brief views"
      className="-mx-1 flex flex-wrap items-center gap-1 overflow-x-auto"
    >
      {tabs.map((t) => {
        const on = t.href === active;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={on ? "page" : undefined}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              on
                ? "bg-ink text-cream"
                : "border border-ink/15 text-ink hover:bg-ink/[0.04]"
            }`}
          >
            {t.label}
            {typeof t.count === "number" ? (
              <span className={on ? "text-cream/70" : "text-inkMuted"}>
                {" "}
                {t.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
