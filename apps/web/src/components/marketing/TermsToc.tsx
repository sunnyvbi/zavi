"use client";

import { useEffect, useState } from "react";

export type TocItem = { id: string; label: string };

export function TermsToc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");

  useEffect(() => {
    const sections = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => Boolean(el));
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-120px 0px -70% 0px", threshold: 0 },
    );

    sections.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [items]);

  return (
    <nav aria-label="On this page" className="flex w-[256px] flex-col px-2">
      {items.map((item) => {
        const isActive = active === item.id;
        return (
          <a
            key={item.id}
            href={`#${item.id}`}
            className={`flex items-center rounded-[10px] py-2.5 pl-4 pr-3 text-[16px] font-medium tracking-[0.14px] transition-colors ${
              isActive
                ? "bg-[#e6f2ff] text-[#2563eb]"
                : "text-[#595959] hover:bg-[#f0f0f0] hover:text-[#0e0f11]"
            }`}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
