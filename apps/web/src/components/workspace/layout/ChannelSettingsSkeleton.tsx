"use client";

import type { ReactNode } from "react";

import { Skeleton } from "../Skeleton";
import type { SettingsField } from "../actions/types";

const CARD = "rounded-2xl border border-rule bg-white p-4";
const ROW = "flex items-center gap-2.5 border-b border-bone py-2 last:border-b-0";
const CONTROL = "rounded-[10px]";
const LIST_ROW_WIDTHS = ["w-[46%]", "w-[62%]", "w-[38%]"];

function FieldBody({ field, delayMs }: { field: SettingsField; delayMs: number }) {
  if (field.kind === "list") {
    return (
      <div className="mt-3">
        <div className="flex gap-2">
          <Skeleton className="h-10 min-w-0 flex-1" rounded={CONTROL} delayMs={delayMs} />
          <Skeleton className="h-9 w-[68px] shrink-0" rounded={CONTROL} delayMs={delayMs} />
        </div>
        <ul className="mt-2.5 flex flex-col">
          {LIST_ROW_WIDTHS.map((w, i) => (
            <li key={w} className={ROW}>
              <Skeleton className={`h-3.5 ${w}`} delayMs={delayMs + i * 60} />
              <div className="ml-auto flex shrink-0 items-center gap-2.5">
                <Skeleton className="h-5 w-16" delayMs={delayMs + i * 60} />
                <Skeleton className="h-8 w-[74px]" rounded={CONTROL} delayMs={delayMs + i * 60} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (field.kind === "number") {
    return (
      <div className="mt-3">
        <Skeleton className="h-10 w-[150px]" rounded={CONTROL} delayMs={delayMs} />
      </div>
    );
  }

  if (field.kind === "choice") {
    return (
      <div className="mt-3 flex flex-wrap gap-2">
        {field.options.map((o) => (
          <Skeleton key={o.value} className="h-9 w-[104px]" rounded={CONTROL} delayMs={delayMs} />
        ))}
      </div>
    );
  }

  if (field.kind === "mapping") {
    return (
      <ul className="mt-3 flex flex-col rounded-xl border border-bone px-3">
        {field.rows.map((r, i) => (
          <li key={r.key} className={ROW}>
            <Skeleton className={`h-3.5 ${LIST_ROW_WIDTHS[i % LIST_ROW_WIDTHS.length]}`} delayMs={delayMs + i * 60} />
            <Skeleton className="ml-auto h-9 w-[11rem] shrink-0 sm:w-[16rem]" rounded={CONTROL} delayMs={delayMs + i * 60} />
          </li>
        ))}
      </ul>
    );
  }

  if (field.kind === "toggle") {
    return (
      <div className="mt-3 flex items-center gap-3">
        <Skeleton className="h-6 w-11 shrink-0" rounded="rounded-full" delayMs={delayMs} />
        <Skeleton className="h-3.5 w-16" delayMs={delayMs} />
      </div>
    );
  }

  return (
    <div className="mt-3">
      <Skeleton className="h-10 w-full" rounded={CONTROL} delayMs={delayMs} />
    </div>
  );
}

export function ChannelSettingsSkeleton({
  fields,
  lead,
}: {
  fields: readonly SettingsField[];
  lead: ReactNode;
}) {
  const lists = fields.filter((f) => f.kind === "list");
  const rest = fields.filter((f) => f.kind !== "list");
  const ordered = [...lists, ...rest];

  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-testid="channel-settings-skeleton"
      className="mt-5 flex flex-col gap-5"
    >
      {lead}

      {ordered.map((field, i) => (
        <section key={field.id} className={CARD}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-[38%] min-w-[120px] max-w-[200px]" delayMs={i * 80} />
              {field.help && (
                <Skeleton className="mt-2 h-3 w-[72%] max-w-[360px]" delayMs={i * 80 + 40} />
              )}
            </div>
            {field.kind === "list" && field.suggest && (
              <Skeleton className="h-9 w-[84px] shrink-0" rounded={CONTROL} delayMs={i * 80} />
            )}
          </div>
          <FieldBody field={field} delayMs={i * 80} />
        </section>
      ))}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Skeleton className="h-10 w-[148px]" rounded={CONTROL} delayMs={ordered.length * 80} />
        <Skeleton className="h-3 w-[min(320px,60%)]" delayMs={ordered.length * 80 + 40} />
      </div>

      <span className="sr-only">Reading your settings…</span>
    </div>
  );
}
