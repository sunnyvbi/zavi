"use client";

import Link from "next/link";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";

export type HumanSectionTab = { href: string; label: string };

const MARKETPLACE_TABS: HumanSectionTab[] = [
  { href: "/humans", label: "Briefs" },
  { href: "/humans/jobs", label: "Jobs" },
  { href: "/humans/creators", label: "Find creators" },
  { href: "/humans/library", label: "Library" },
];

export const HUMAN_SECTION_TABS: HumanSectionTab[] = CREATOR_MARKETPLACE_ENABLED
  ? MARKETPLACE_TABS
  : MARKETPLACE_TABS.filter((tab) => ["/humans/jobs", "/humans/library"].includes(tab.href));

export function HumanSectionTabs({ active }: { active: string }) {
  return (
    <nav
      aria-label="Human section"
      className="-mx-1 mb-6 flex flex-wrap items-center gap-1 overflow-x-auto"
    >
      {HUMAN_SECTION_TABS.map((t) => {
        const on = t.href === active;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={on ? "page" : undefined}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              on ? "bg-ink text-cream" : "border border-ink/15 text-ink hover:bg-ink/[0.04]"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
