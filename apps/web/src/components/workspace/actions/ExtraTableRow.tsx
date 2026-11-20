"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/cn";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { SideDrawer } from "../layout/SideDrawer";
import { RowAction } from "./ExtraTableRowAction";
import { CellText, cellClass } from "./ExtraTableCells";
import { ROW_ACTION } from "./extraTableStyles";
import type { ExtraRow, ExtraColumn, ExtraRowDetail } from "./extraTableTypes";

function DetailBody({ detail }: { detail: ExtraRowDetail }) {
  if (detail.content) return <>{detail.content}</>;
  return (
    <div className="flex flex-col gap-3" data-testid="extra-row-drawer">
      {detail.title && <p className="text-detail font-medium text-inkMuted">{detail.title}</p>}
      <p className="whitespace-pre-wrap text-base leading-6 text-ink">{detail.text}</p>
      {detail.actions?.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {detail.actions.map((a) => (
            <RowAction key={a.label} action={a} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ExtraTableRow({
  row,
  columns,
  hasActions,
  drawer,
}: {
  row: ExtraRow;
  columns: ExtraColumn[];
  hasActions: boolean;

  drawer?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const detail = row.detail;
  const rowName = row.cells[0]?.text ?? detail?.openLabel ?? "";
  return (
    <>
      <tr className="border-b border-rule last:border-b-0 compact:grid compact:grid-cols-2 compact:gap-x-3 compact:gap-y-2 compact:px-4 compact:py-3">
        {row.cells.map((cell, i) => (
          <td
            key={i}
            data-tone={cell.tone}
            data-label={i > 0 ? columns[i]?.label : undefined}
            className={cn(
              cellClass(columns[i], i, cell),
              "compact:p-0 compact:text-left",
              i === 0
                ? "compact:col-span-2"
                : "compact:before:mb-0.5 compact:before:block compact:before:text-[12px] compact:before:font-medium compact:before:text-inkMuted compact:before:content-[attr(data-label)]",
            )}
          >
            <CellText cell={cell} />
          </td>
        ))}
        {hasActions && (
          <td className="w-px whitespace-nowrap px-4 py-3 text-right compact:col-span-2 compact:w-auto compact:p-0 compact:text-left" data-testid="extra-row-actions">
            <div className="flex min-h-8 flex-wrap items-center justify-end gap-2 compact:justify-start">
              {(row.actions ?? []).map((a) => (
                <RowAction key={a.label} action={a} />
              ))}
              {detail && drawer && (
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-label={`${detail.openLabel}: ${rowName}`}
                  onClick={() => setOpen(true)}
                  className={ROW_ACTION}
                >
                  {detail.openLabel}
                  <ChevronRight className="h-3 w-3" aria-hidden />
                </button>
              )}
              {detail && !drawer && (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={open ? detailId : undefined}
                  onClick={() => setOpen((v) => !v)}
                  className={ROW_ACTION}
                >
                  {open ? (
                    <ChevronUp className="h-3 w-3" aria-hidden />
                  ) : (
                    <ChevronDown className="h-3 w-3" aria-hidden />
                  )}
                  {open ? detail.closeLabel : detail.openLabel}
                </button>
              )}
              {detail && drawer && open && (
                <SideDrawer title={rowName} onClose={() => setOpen(false)}>
                  <DetailBody detail={detail} />
                </SideDrawer>
              )}
            </div>
          </td>
        )}
      </tr>
      {detail && open && !drawer && (
        <tr className="border-b border-rule last:border-b-0 compact:block" data-testid="extra-row-detail">
          <td colSpan={columns.length + (hasActions ? 1 : 0)} className="px-4 pb-4 pt-0 compact:block">
            {detail.content ? <div id={detailId} role="region" aria-label={detail.title ?? detail.openLabel} className="whitespace-normal text-left">{detail.content}</div> : (
            <div
              id={detailId}
              role="region"
              aria-label={detail.title ?? detail.openLabel}
              className="rounded-xl border border-rule bg-bone/60 px-4 py-3"
            >
              {detail.title && <p className="text-detail font-medium text-inkMuted">{detail.title}</p>}
              <p className="mt-1 whitespace-pre-wrap border-l-2 border-rule pl-3 text-left text-base leading-5 text-ink">
                {detail.text}
              </p>
              {detail.actions?.length ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {detail.actions.map((a) => (
                    <RowAction key={a.label} action={a} />
                  ))}
                </div>
              ) : null}
            </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

