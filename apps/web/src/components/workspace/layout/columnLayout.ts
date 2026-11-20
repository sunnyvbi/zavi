"use client";

import { useCallback, useEffect, useState } from "react";

export const COLUMN_IDS = ["context", "chat", "analytics", "channels"] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];

export const COLUMN_LABEL: Record<ColumnId, string> = {
  context: "Context",
  chat: "Chat",
  analytics: "Analytics",
  channels: "Growth Channels",
};

export const COLUMN_WIDTH_STORAGE_KEY = "zavi:column-width-weights";

export const COMPACT_VIEWPORT_MAX_PX = 639;

export type CollapseState = Record<Exclude<ColumnId, "chat">, boolean>;

export function effectiveCollapse(input: {
  compact: boolean;
  context: boolean;
  channels: boolean;
  analytics: boolean;
  contextEscapeOpen?: boolean;
}): CollapseState {
  if (input.compact)
    return {
      context: input.context || !input.contextEscapeOpen,
      channels: true,
      analytics: true,
    };
  return {
    context: input.context,
    channels: input.channels,
    analytics: input.analytics,
  };
}

export function columnsRowMinWidth(
  columns: { id: ColumnId; collapsed: boolean; railPx: number }[],
  geometry: { gapPx: number; rowPaddingPx: number },
): number {
  if (columns.length === 0) return geometry.rowPaddingPx;
  const content = columns.reduce(
    (total, column) =>
      total +
      (column.collapsed ? column.railPx : COLUMN_MIN_WIDTH_PX[column.id]),
    0,
  );
  return (
    content + geometry.gapPx * (columns.length - 1) + geometry.rowPaddingPx
  );
}

export const COLUMN_MIN_WIDTH_PX: Record<ColumnId, number> = {
  context: 220,
  chat: 320,
  analytics: 320,
  channels: 320,
};

export const DEFAULT_COLUMN_WIDTH_WEIGHTS: Record<ColumnId, number> = {
  context: 280,
  chat: 430,
  analytics: 430,
  channels: 430,
};

export type ColumnWidthWeights = Record<ColumnId, number>;

export function parseColumnWidthWeights(
  raw: string | null,
): ColumnWidthWeights | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result = {} as ColumnWidthWeights;
    for (const id of COLUMN_IDS) {
      const value = parsed?.[id];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return null;
      }
      result[id] = value;
    }
    return result;
  } catch {
    return null;
  }
}

export function distributeColumnWidths(
  ids: ColumnId[],
  availableWidth: number,
  weights: ColumnWidthWeights,
): Partial<Record<ColumnId, number>> {
  const widths: Partial<Record<ColumnId, number>> = {};
  if (ids.length === 0) return widths;

  const minimumTotal = ids.reduce(
    (total, id) => total + COLUMN_MIN_WIDTH_PX[id],
    0,
  );
  if (availableWidth <= minimumTotal) {
    for (const id of ids) widths[id] = COLUMN_MIN_WIDTH_PX[id];
    return widths;
  }

  let remainingWidth = availableWidth;
  let pending = [...ids];

  while (pending.length > 0) {
    const totalWeight = pending.reduce(
      (total, id) => total + Math.max(0.001, weights[id]),
      0,
    );
    const belowMinimum = pending.filter(
      (id) =>
        (remainingWidth * Math.max(0.001, weights[id])) / totalWeight <
        COLUMN_MIN_WIDTH_PX[id],
    );

    if (belowMinimum.length === 0) {
      for (const id of pending) {
        widths[id] =
          (remainingWidth * Math.max(0.001, weights[id])) / totalWeight;
      }
      break;
    }

    const frozen = new Set(belowMinimum);
    for (const id of belowMinimum) {
      widths[id] = COLUMN_MIN_WIDTH_PX[id];
      remainingWidth -= COLUMN_MIN_WIDTH_PX[id];
    }
    pending = pending.filter((id) => !frozen.has(id));
  }

  return widths;
}

export function resizeColumnsAcrossDivider(
  widths: ColumnWidthWeights,
  orderedIds: ColumnId[],
  leftId: ColumnId,
  rightId: ColumnId,
  deltaPx: number,
): ColumnWidthWeights {
  const leftIndex = orderedIds.indexOf(leftId);
  const rightIndex = orderedIds.indexOf(rightId);
  if (
    !Number.isFinite(deltaPx) ||
    deltaPx === 0 ||
    leftIndex < 0 ||
    rightIndex !== leftIndex + 1
  ) {
    return { ...widths };
  }

  const next = { ...widths };
  const growingId = deltaPx > 0 ? leftId : rightId;
  const shrinkingIds =
    deltaPx > 0
      ? orderedIds.slice(rightIndex)
      : orderedIds.slice(0, leftIndex + 1).reverse();
  let remaining = Math.abs(deltaPx);

  for (const id of shrinkingIds) {
    const available = Math.max(0, next[id] - COLUMN_MIN_WIDTH_PX[id]);
    const consumed = Math.min(remaining, available);
    next[id] -= consumed;
    remaining -= consumed;
    if (remaining === 0) break;
  }

  next[growingId] += Math.abs(deltaPx) - remaining;
  return next;
}

const KEY = "zavi:column-order";

function parseOrder(raw: string | null): ColumnId[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const ids = parsed
      .map((v) => (v === "feed" ? "channels" : v))
      .filter((v): v is ColumnId => COLUMN_IDS.includes(v as ColumnId));
    if (ids.length !== COLUMN_IDS.length) return null;
    if (new Set(ids).size !== COLUMN_IDS.length) return null;
    return ids;
  } catch {
    return null;
  }
}

export function useColumnOrder() {
  const [order, setOrder] = useState<ColumnId[]>([...COLUMN_IDS]);

  useEffect(() => {
    try {
      const stored = parseOrder(window.localStorage.getItem(KEY));
      if (stored) setOrder(stored);
    } catch {}
  }, []);

  const commit = useCallback((next: ColumnId[]) => {
    setOrder(next);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {}
  }, []);

  const move = useCallback(
    (id: ColumnId, toIndex: number) => {
      setOrder((prev) => {
        const from = prev.indexOf(id);
        if (from === -1) return prev;
        const clamped = Math.max(0, Math.min(prev.length - 1, toIndex));
        if (from === clamped) return prev;
        const next = [...prev];
        next.splice(from, 1);
        next.splice(clamped, 0, id);
        try {
          window.localStorage.setItem(KEY, JSON.stringify(next));
        } catch {}
        return next;
      });
    },
    [],
  );

  const nudge = useCallback(
    (id: ColumnId, delta: -1 | 1) => {
      setOrder((prev) => {
        const from = prev.indexOf(id);
        if (from === -1) return prev;
        const to = from + delta;
        if (to < 0 || to >= prev.length) return prev;
        const next = [...prev];
        next.splice(from, 1);
        next.splice(to, 0, id);
        try {
          window.localStorage.setItem(KEY, JSON.stringify(next));
        } catch {}
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => commit([...COLUMN_IDS]), [commit]);

  return { order, move, nudge, reset };
}
