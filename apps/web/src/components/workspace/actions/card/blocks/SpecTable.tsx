import { cn } from "@/lib/cn";

export type SpecRow = { label: string; value: string; muted?: boolean };

export function SpecTable({ rows, footnote, valueTestId }: { rows: SpecRow[]; footnote?: string | null; valueTestId?: string }) {
  if (!rows.length) return null;
  return (
    <div>
      <dl className="flex flex-col gap-1 text-ca-row">
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between gap-4">
            <dt className="shrink-0 text-ca-secondary">{r.label}</dt>
            <dd data-testid={valueTestId} className={cn("text-right [overflow-wrap:anywhere]", r.muted ? "text-ca-secondary" : "font-medium text-ca-xdark")}>{r.value}</dd>
          </div>
        ))}
      </dl>
      {footnote && <p className="mt-2 text-ca-action text-ca-secondary">{footnote}</p>}
    </div>
  );
}
