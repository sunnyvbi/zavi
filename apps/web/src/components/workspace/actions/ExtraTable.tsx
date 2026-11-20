"use client";

import { cn } from "@/lib/cn";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";

import { useState, type ReactNode } from "react";
import { TailToggle } from "./TableParts";
import { EmailPager, pageRange } from "../email/EmailPager";
import { CellText } from "./ExtraTableCells";
import { ExtraTableRow } from "./ExtraTableRow";
import { TONE, isLeft } from "./extraTableStyles";
import type { ExtraTableData } from "./extraTableTypes";
export type * from "./extraTableTypes";
export { ROW_ACTION } from "./extraTableStyles";

export function ExtraTable({ data }: { data: ExtraTableData }) {
  const views = data.views && data.views.length > 1 ? data.views : null;
  const empty = data.rows.length === 0 && (views ?? []).every((v) => (v.data?.rows ?? data.rows).length === 0);
  if (empty && (views || !data.keepWhenEmpty)) return null;
  if (views) return <ExtraTableViews data={data} views={views} />;
  return <ExtraTableBody data={data} />;
}

function ExtraTableViews({ data, views }: { data: ExtraTableData; views: NonNullable<ExtraTableData["views"]> }) {
  const [activeId, setActiveId] = useState(views[0].id);
  const active = views.find((v) => v.id === activeId) ?? views[0];
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(active.id);
  const switcher = (
    <div ref={listRef} role="tablist" aria-label={`${data.title} view`} className="relative ml-auto flex shrink-0 gap-0.5 rounded-xl border border-rule bg-creamDeep p-0.5">
      <SlidingIndicator box={box} className="rounded-lg bg-cream shadow-sm" />
      {views.map((v) => {
        const selected = v.id === active.id;
        return (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => setActiveId(v.id)}
            className={cn(
              "relative h-8 rounded-lg px-3 text-sm transition-colors duration-300",
              selected ? "font-semibold text-ink" : "font-medium text-inkMuted hover:text-ink",
            )}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
  return (
    <section aria-label={data.title} data-testid="extra-table">
      <Heading data={data} switcher={switcher} />
      {views.map((v) => (
        <div key={v.id} hidden={v.id !== active.id} data-view={v.id}>
          <ExtraTableBody data={{ ...data, ...v.data, views: undefined }} bare />
        </div>
      ))}
    </section>
  );
}

function Heading({ data, switcher }: { data: ExtraTableData; switcher?: ReactNode }) {
  const Icon = data.icon;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <h2 className="flex items-center gap-2.5 text-ca-heading font-semibold tracking-tight text-ca-xdark">
        {Icon ? <Icon className="size-6 shrink-0 text-ca-icon" aria-hidden /> : null}
        {data.title}
      </h2>
      {switcher}
    </div>
  );
}

function ExtraTableBody({ data, bare = false }: { data: ExtraTableData; bare?: boolean }) {
  const Wrap = bare ? "div" : "section";
  const [showTail, setShowTail] = useState(false);
  const hasActions = data.rows.some((r) => r.actions?.length || r.detail);
  const tailWords = data.tailToggle;
  const hidden = tailWords ? data.rows.filter((r) => r.tail).length : 0;
  const [page, setPage] = useState(1);
  const rows = tailWords && !showTail ? data.rows.filter((r) => !r.tail) : data.rows;
  const size = data.pageSize && data.pageSize > 0 ? data.pageSize : 0;
  const pages = size ? Math.max(1, Math.ceil(rows.length / size)) : 1;
  const current = Math.min(page, pages);
  const shown = pages > 1 ? rows.slice((current - 1) * size, current * size) : rows;
  const pager =
    pages > 1 ? (
      <div className="mt-3">
        <EmailPager
          label={`${data.title} pages`}
          testId="extra-table-pager"
          rangeTestId="extra-table-pager-range"
          range={pageRange((current - 1) * size + 1, (current - 1) * size + shown.length, rows.length)}
          canPrev={current > 1}
          canNext={current < pages}
          onPrev={() => setPage(current - 1)}
          onNext={() => setPage(current + 1)}
        />
      </div>
    ) : null;
  const tailButton =
    tailWords && hidden > 0 ? (
      <TailToggle open={showTail} hidden={hidden} words={tailWords} onToggle={() => setShowTail((v) => !v)} />
    ) : null;
  if (data.rows.length > 0 && rows.length === 0 && tailWords) {
    return (
      <Wrap {...(bare ? {} : { "aria-label": data.title, "data-testid": "extra-table" })}>
        {bare ? null : <Heading data={data} />}
        <p
          className="rounded-2xl border border-ca-border bg-ca-bg px-5 py-4 text-ca-facts text-ca-dark shadow-ca-sm"
          data-testid="extra-table-tail-only"
        >
          {tailWords.noneAbove}
        </p>
        {tailButton}
        {data.caption ? <p className="mt-3 text-ca-action text-ca-muted">{data.caption}</p> : null}
      </Wrap>
    );
  }
  return (
    <Wrap {...(bare ? {} : { "aria-label": data.title, "data-testid": "extra-table" })}>
      {bare ? null : <Heading data={data} />}
      {data.rows.length === 0 ? (
        <p className="rounded-2xl border border-ca-border bg-ca-bg px-5 py-4 text-ca-facts text-ca-dark shadow-ca-sm" data-testid="extra-table-empty">
          {data.empty}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-ca-border bg-ca-bg shadow-ca-sm">
          <table className={cn("w-full", data.narrow ? "min-w-table-narrow" : "min-w-table", "text-sm compact:block compact:min-w-0")}>
            <thead className="compact:hidden">
              <tr className="border-b border-ca-border bg-ca-subtle text-ca-action text-ca-muted">
                {data.columns.map((c, i) => (
                  <th
                    key={c.label}
                    scope="col"
                    className={cn(isLeft(c) && i > 0 ? "px-2" : "px-4", "py-2.5", isLeft(c) ? "text-left" : "text-right", "whitespace-nowrap font-semibold")}
                  >
                    {c.label}
                  </th>
                ))}
                {hasActions && (
                  <th scope="col" className="w-px whitespace-nowrap px-4 py-2.5 text-right font-semibold">
                    <span className="sr-only">{data.actionsLabel ?? "Actions"}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="compact:block">
              {shown.map((r) => (
                <ExtraTableRow key={r.id} row={r} columns={data.columns} hasActions={hasActions} drawer={data.detailInDrawer} />
              ))}
            </tbody>
            {data.footer && (
              <tfoot className="compact:hidden">
                <tr className="border-t border-rule bg-creamDeep font-semibold text-ink" data-testid="totals-row">
                  {data.footer.map((cell, i) => {
                    const col = data.columns[i];
                    const left = isLeft(col);
                    const pad = left && i > 0 ? "px-2" : "px-4";
                    const align = left ? "text-left" : "text-right tabular-nums";
                    const colour = cell.tone ? cn("font-normal", TONE[cell.tone]) : "";
                    return (
                      <td key={i} data-tone={cell.tone} className={cn(pad, "py-3", align, colour)}>
                        <CellText cell={cell} />
                      </td>
                    );
                  })}
                  {hasActions && <td className="w-px px-4 py-3" />}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {pager}
      {tailButton}
      {data.caption ? <p className="mt-3 text-ca-action text-ca-muted">{data.caption}</p> : null}
    </Wrap>
  );
}
