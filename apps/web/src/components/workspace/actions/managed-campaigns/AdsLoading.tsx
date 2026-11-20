import { cn } from "@/lib/cn";
import { tableCell, tableLeft } from "./tableParts";

export function SkeletonBar({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-bone motion-reduce:animate-none", className)} />;
}

export function AdsFormSkeleton({ label, fields = 4, className }: { label: string; fields?: number; className?: string }) {
  return (
    <div role="status" data-testid="ads-form-skeleton" className={cn("space-y-6", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-2">
          <SkeletonBar className="h-3.5 w-28" />
          <SkeletonBar className="h-11 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}

export function AdsRowsSkeleton({ label, rows = 3, className }: { label: string; rows?: number; className?: string }) {
  return (
    <div role="status" data-testid="ads-rows-skeleton" className={cn("divide-y divide-ca-border", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-6 px-5 py-4">
          <SkeletonBar className="h-4 w-2/5" />
          <SkeletonBar className="ml-auto h-4 w-16" />
          <SkeletonBar className="h-4 w-16" />
          <SkeletonBar className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function AdsTableSkeletonRows({ columns, rows = 3 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden="true" data-testid="ads-table-skeleton-row">
          {Array.from({ length: columns }, (_, c) => (
            <td key={c} className={cn(tableCell, c === 0 && tableLeft)}>
              <SkeletonBar className={cn("h-4", c === 0 ? "w-48 max-w-full" : "ml-auto w-14")} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

const CHIP_WIDTHS = ["w-24", "w-32", "w-20", "w-28", "w-36", "w-24"];

function Chips({ chips }: { chips: number }) {
  return <>{Array.from({ length: chips }, (_, i) => <SkeletonBar key={i} className={cn("h-8 rounded-2xl", CHIP_WIDTHS[i % CHIP_WIDTHS.length])} />)}</>;
}

export function AdsChipsSkeleton({ label, chips = 6 }: { label: string; chips?: number }) {
  return (
    <div role="status" data-testid="ads-chips-skeleton" className="flex flex-wrap gap-2 pt-2">
      <span className="sr-only">{label}</span>
      <Chips chips={chips} />
    </div>
  );
}

function PostRow() {
  return (
    <div aria-hidden="true" data-testid="ads-post-row-skeleton" className="flex items-center gap-4 rounded-2xl border border-rule p-4">
      <SkeletonBar className="size-24 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1 space-y-2">
        <SkeletonBar className="h-3 w-32" />
        <SkeletonBar className="h-3.5 w-full" />
        <SkeletonBar className="h-3.5 w-2/3" />
      </div>
      <SkeletonBar className="size-6 shrink-0 rounded-full" />
    </div>
  );
}

export function AdsPostRowsSkeleton({ label, rows = 3, testId = "ads-post-rows-skeleton" }: { label: string; rows?: number; testId?: string }) {
  return (
    <div aria-live="polite" aria-busy="true" data-testid={testId} className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => <PostRow key={i} />)}
    </div>
  );
}

function Field() {
  return (
    <div className="space-y-2">
      <SkeletonBar className="h-3.5 w-28" />
      <SkeletonBar className="h-11 w-full rounded-lg" />
    </div>
  );
}

export function AdsReviewSkeleton({ label }: { label: string }) {
  const section = "space-y-4 border-t border-rule pt-6";
  return (
    <div role="status" data-testid="ads-review-skeleton" className="space-y-6">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-2">
        <SkeletonBar className="h-5 w-48 max-w-full" />
        <SkeletonBar className="h-4 w-3/4" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} aria-hidden="true" data-testid="ads-review-skeleton-fields" className={section}>
          <SkeletonBar className="h-3 w-20" />
          <div className="grid items-start gap-4 md:grid-cols-2"><Field /><Field /></div>
        </div>
      ))}
      <div aria-hidden="true" data-testid="ads-review-skeleton-audience" className={section}>
        <SkeletonBar className="h-3 w-20" />
        <Field />
        <div className="space-y-2">
          <SkeletonBar className="h-3.5 w-28" />
          <div className="flex flex-wrap gap-2"><Chips chips={6} /></div>
        </div>
      </div>
      <div aria-hidden="true" data-testid="ads-review-skeleton-post" className={section}>
        <SkeletonBar className="h-3 w-20" />
        <div className="flex flex-col gap-2"><PostRow /><PostRow /></div>
      </div>
    </div>
  );
}
