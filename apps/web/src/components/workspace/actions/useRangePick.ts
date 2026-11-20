"use client";

import { useMemo, useState } from "react";
import { DEFAULT_RANGES, type GadsRange } from "../agent/google-ads/types";
import { CUSTOM_RANGE_ID, fromYmd, spanLabel, type CustomSpan, type PickedRange } from "./dateRange";

const DAY = 86_400_000;

export function useRangePick(ranges: readonly GadsRange[] = DEFAULT_RANGES) {
  const last = ranges[ranges.length - 1];
  const [picked, setPicked] = useState<PickedRange>({ id: last.id, days: last.days });
  const custom: CustomSpan | null = useMemo(() => (picked.since && picked.until ? { since: picked.since, until: picked.until } : null), [picked.since, picked.until]);
  const range: GadsRange = custom ? { id: CUSTOM_RANGE_ID, label: spanLabel(custom), days: picked.days } : ranges.find((r) => r.id === picked.id) ?? last;
  const params = useMemo(
    (): Record<string, string> => (custom ? { days: String(picked.days), since: custom.since, until: custom.until } : { days: String(picked.days) }),
    [custom, picked.days],
  );
  return {
    range,
    custom,
    params,
    phrase: custom ? `period ${range.label}` : range.label.toLowerCase(),
    windowKey: custom ? "custom" : String(range.days),
    endMs: custom ? fromYmd(custom.until).getTime() + DAY : null,
    onPick: setPicked,
  };
}
