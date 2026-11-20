import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/cn";
import { SectionCard } from "./ui";

export const TH = "whitespace-nowrap bg-creamDeep px-4 py-2.5 align-middle text-base font-semibold text-inkMuted";
export const TD = "px-4 py-3 align-top";
export const TIGHT = "w-px whitespace-nowrap";
export const THREAD = "w-full min-w-reddit-thread max-w-0";
export const TAIL = "w-px whitespace-nowrap";
const POST_COL = "w-full min-w-80 max-w-0";
const SPREAD = TIGHT;
export const ACTION_SLOT = "flex h-8 items-center justify-end";
const OUTLINE_BTN =
  "inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-cta border border-rule bg-cream px-3 text-base font-medium text-ink hover:bg-bone disabled:opacity-50";

export function RedditTable({ title, sub, empty, children }: { title: string; sub: string; empty: string | null; children: ReactNode }) {
  return (
    <SectionCard title={title} sub={sub}>
      {empty ? (
        <p className="rounded-xl border border-dashed border-rule px-4 py-6 text-center text-base text-inkMuted">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-rule">
          <table className="w-full min-w-table text-left">{children}</table>
        </div>
      )}
    </SectionCard>
  );
}

export function ThreadCell({ url, title, meta, width = THREAD }: { url: string; title: string; meta: string; width?: string }) {
  return (
    <td className={cn(TD, width)}>
      <a href={url} target="_blank" rel="noreferrer" title={title} className="group flex items-center gap-2">
        <span className="min-w-0 truncate text-base font-semibold leading-5 text-ink group-hover:underline">{title}</span>
        <ExternalLink className="h-3 w-3 shrink-0 text-inkMuted" aria-hidden />
      </a>
      <p className="mt-0.5 truncate text-detail text-inkMuted">{meta}</p>
    </td>
  );
}


export const sumRedditMetrics = (values: Array<number | null | undefined>) =>
  values.reduce<number>((total, value) => total + (typeof value === "number" ? value : 0), 0);

const TFOOT_TD = "border-t border-rule bg-creamDeep px-4 py-3 text-base font-semibold text-ink";

export function RedditTotals({
  label,
  span,
  cells,
  rows,
}: {
  label: string;
  span: number;
  cells: Array<{ key: string; value: ReactNode; align?: "right" }>;
  rows: number;
}) {
  if (rows < 2) return null;
  return (
    <tfoot>
      <tr>
        <th scope="row" colSpan={span} className={cn(TFOOT_TD, "text-left")}>
          {label}
        </th>
        {cells.map((c) => (
          <td key={c.key} className={cn(TFOOT_TD, "tabular-nums", c.align === "right" && "text-right")}>
            {c.value}
          </td>
        ))}
      </tr>
    </tfoot>
  );
}

