"use client";

import { Rocket, SquarePen } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatCurrency } from "../../metrics/currency";
import { OnToggle, StatusPill, tableCell as cell, tableEditButton, tableHead as head, tableLeft as left, tableNote, tablePrimaryButton } from "../managed-campaigns/tableParts";
import { AdsTableSkeletonRows } from "../managed-campaigns/AdsLoading";
import type { PaidColumn } from "./columns";
import type { AnalyticsRow, VideoTotals } from "./model";
import type { CampaignState } from "./useCampaignSwitch";

function statusNote(row: AnalyticsRow, state: CampaignState) {
  if (row.note) return row.note;
  if (row.end) return `Ends ${row.end.slice(0, 10)}`;
  if (state === "active") return "Runs until you pause it";
  return state === "paused" && row.impressions === 0 ? "Not launched yet" : "";
}

export function PaidCampaignTable({ campaigns, columns, video, rows, loading = false, currency, canEdit, parent, budget, roas, pending, awaiting, stateOf, editable, onFlip, onEdit, switchNote }: {
  campaigns: boolean;
  columns: readonly PaidColumn[];
  video: VideoTotals | null;
  rows: readonly AnalyticsRow[];
  loading?: boolean;
  currency: string | null;
  canEdit: boolean;
  parent: AnalyticsRow | undefined;
  budget: number | null;
  roas: number | null;
  pending: string | null;
  awaiting?: ReadonlySet<string>;
  stateOf: (row: AnalyticsRow) => CampaignState;
  editable: (row: AnalyticsRow) => boolean;
  onFlip: (row: AnalyticsRow) => void;
  onEdit: (id: string) => void;
  switchNote?: string;
}) {
  return (
    <table className="w-full min-w-[780px] border-collapse">
      <thead className="bg-ca-subtle">
        <tr>
          {campaigns && <th scope="col" className={cn(head, left)}>On</th>}
          <th scope="col" className={cn(head, left)}>{campaigns ? "Campaign" : "Name"}</th>
          {campaigns && <th scope="col" className={cn(head, left)}>Status</th>}
          {campaigns && <th scope="col" className={head}>Daily budget</th>}
          {columns.map((column) => <th key={column.label} scope="col" className={head}>{column.label}</th>)}
          {canEdit && <th scope="col" className={head}><span className="sr-only">Actions</span></th>}
        </tr>
      </thead>
      <tbody>
        {loading && <AdsTableSkeletonRows columns={(campaigns ? 4 : 1) + columns.length + (canEdit ? 1 : 0)} />}
        {rows.map((row) => {
          const state = stateOf(row);
          const target = campaigns ? row : parent;
          const open = !!target && editable(target);
          const note = statusNote(row, state);
          const money = row.currency ?? currency;
          const waiting = awaiting?.has(row.id) === true;
          const fixed = switchNote ?? (!canEdit ? "Only an owner or admin can switch it." : !open ? "It can't be switched from Zavi." : undefined);
          return (
            <tr key={row.id}>
              {campaigns && (
                <td className={cn(cell, left)}>
                  <OnToggle status={state} busy={pending !== null || waiting || !canEdit || !open} label={`${state === "active" ? "Pause" : "Switch on"} ${row.name}`} onChange={() => onFlip(row)} readOnly={fixed ? `${row.name} is ${state === "active" ? "on" : "off"}. ${fixed}` : undefined} />
                </td>
              )}
              <th scope="row" className={cn(cell, left, "font-normal")}>
                <span className="block w-max min-w-[180px] max-w-[280px] whitespace-normal">{row.name}</span>
                {row.subtitle && <span className="block text-ca-action text-ca-secondary">{row.subtitle}</span>}
              </th>
              {campaigns && (
                <td className={cn(cell, left)}>
                  <StatusPill value={pending === row.id ? "updating" : state} />
                  {row.limited && <p className={tableNote}>Limited by budget</p>}
                  {note && <p className={tableNote}>{note}</p>}
                  {waiting && <p className={tableNote}>Waiting for your approval</p>}
                </td>
              )}
              {campaigns && (
                <td className={cell}>
                  {row.budget == null ? "-" : `${formatCurrency(row.budget, money)} a day`}
                  {row.shared && <span className="block text-ca-action text-ca-secondary">Shared budget</span>}
                </td>
              )}
              {columns.map((column) => <td key={column.label} className={cell}>{column.cell(row, money)}</td>)}
              {canEdit && (
                <td className={cell}>
                  {!open && target?.url && (
                    <a href={target.url} target="_blank" rel="noopener noreferrer" className={tableEditButton} aria-label={`Edit campaign for ${row.name} in the ads manager`}><SquarePen className="size-4" aria-hidden />Edit</a>
                  )}
                  {open && (
                    <span className="inline-flex items-center justify-end gap-2">
                      {campaigns && state === "paused" && <button type="button" className={tablePrimaryButton} disabled={pending !== null || waiting} aria-label={`Launch ${row.name}`} onClick={() => onFlip(row)}><Rocket className="size-4" aria-hidden />Launch</button>}
                      <button type="button" className={tableEditButton} aria-label={`Edit campaign for ${row.name}`} onClick={() => onEdit(target!.id)}><SquarePen className="size-4" aria-hidden />Edit</button>
                    </span>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
      {campaigns && rows.length > 0 && (
        <tfoot className="bg-ca-subtle font-semibold">
          <tr>
            <td className={cell} />
            <td className={cn(cell, left)}>{rows.length === 1 ? "1 campaign" : `${rows.length} campaigns`}</td>
            <td className={cn(cell, left, "font-normal text-ca-secondary")}>{roas == null ? "" : `ROAS ${roas.toFixed(2)}×`}</td>
            <td className={cell}>{budget == null ? "-" : `${formatCurrency(budget, currency)} a day`}</td>
            {columns.map((column) => <td key={column.label} className={cell}>{column.foot(rows, currency, video)}</td>)}
            {canEdit && <td className={cell} />}
          </tr>
        </tfoot>
      )}
    </table>
  );
}
