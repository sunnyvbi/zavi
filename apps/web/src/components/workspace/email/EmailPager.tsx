"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";
const PAGER_BTN = `inline-flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center gap-1 rounded-cta border border-rule bg-white px-3 text-[13px] font-medium text-ink cursor-pointer transition-colors hover:border-inkLight hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 sm:min-h-0 sm:min-w-0 sm:pl-2 sm:pr-2.5 ${FOCUS}`;
const PAGER_BTN_NEXT = `${PAGER_BTN} sm:pl-2.5 sm:pr-2`;

const count = (v: number) => v.toLocaleString("en-US");

export function pageRange(first: number, last: number, total: number): string {
  return first >= last ? `${count(last)} of ${count(total)}` : `${count(first)}–${count(last)} of ${count(total)}`;
}

export function EmailPager({
  label,
  range,
  canPrev,
  canNext,
  onPrev,
  onNext,
  testId,
  rangeTestId,
}: {
  label: string;
  range: string;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  testId?: string;
  rangeTestId?: string;
}) {
  return (
    <nav aria-label={label} data-testid={testId} className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
      <span data-testid={rangeTestId} aria-live="polite" className="min-w-0 text-[13px] tabular-nums text-inkMuted">
        {range}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <button type="button" disabled={!canPrev} onClick={onPrev} className={PAGER_BTN}>
          <ChevronLeft aria-hidden="true" className="h-4 w-4" />
          Previous
        </button>
        <button type="button" disabled={!canNext} onClick={onNext} className={PAGER_BTN_NEXT}>
          Next
          <ChevronRight aria-hidden="true" className="h-4 w-4" />
        </button>
      </span>
    </nav>
  );
}

export function useSteadyHeight(resetKey: string, paging: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [floor, setFloor] = useState({ key: resetKey, height: 0 });
  const live = paging && floor.key === resetKey;
  useLayoutEffect(() => {
    if (!paging) {
      setFloor((f) => (f.height === 0 && f.key === resetKey ? f : { key: resetKey, height: 0 }));
      return;
    }
    const height = ref.current?.offsetHeight ?? 0;
    setFloor((f) => (f.key !== resetKey ? { key: resetKey, height } : height > f.height ? { key: resetKey, height } : f));
  });
  return { ref, minHeight: live && floor.height > 0 ? floor.height : undefined };
}
