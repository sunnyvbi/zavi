"use client";

import { useState, type ReactNode } from "react";
import { FOCUS_RING } from "../layout/shared";
import { categoryRank } from "./connectorCategories";

export const INTEGRATION_GRID =
  "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";

export const CATEGORY_PREVIEW = 6;

export type CatalogItem = {
  key: string;
  category: string;
  node: ReactNode;
};

export function CategorySection({
  title,
  items,
  preview = CATEGORY_PREVIEW,
}: {
  title: string;
  items: { key: string; node: ReactNode }[];
  preview?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, preview);
  return (
    <section className="flex flex-col gap-[13px]">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-[20px] font-semibold leading-[25px] tracking-tight text-ink">
          {title}
        </h3>
        {items.length > preview && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className={`shrink-0 rounded-cta text-[16px] font-medium text-inkMuted transition-colors hover:text-ink motion-reduce:transition-none ${FOCUS_RING}`}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
      <div className={INTEGRATION_GRID}>
        {shown.map((it) => (
          <ItemSlot key={it.key}>{it.node}</ItemSlot>
        ))}
      </div>
    </section>
  );
}

function ItemSlot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function CategorySections({ items }: { items: CatalogItem[] }) {
  const groups = new Map<string, CatalogItem[]>();
  for (const it of items) {
    const list = groups.get(it.category) ?? [];
    list.push(it);
    groups.set(it.category, list);
  }
  const ordered = [...groups.keys()].sort(
    (a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b),
  );
  return (
    <>
      {ordered.map((cat) => (
        <CategorySection key={cat} title={cat} items={groups.get(cat)!} />
      ))}
    </>
  );
}
