"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ActionItem } from "../types";

type Kept = { keep: (a: ActionItem) => void; release: (id: string) => void };

const KeptCardsContext = createContext<Kept | null>(null);

export function useKeptCards(): Kept | null {
  return useContext(KeptCardsContext);
}

export function useKeptCardList() {
  const [list, setList] = useState<ActionItem[]>([]);
  const keep = useCallback((a: ActionItem) => setList((cur) => (cur.some((k) => k.id === a.id) ? cur : [...cur, a])), []);
  const release = useCallback((id: string) => setList((cur) => cur.filter((k) => k.id !== id)), []);
  const value = useMemo(() => ({ keep, release }), [keep, release]);
  return { kept: list, value };
}

export function KeptCardsProvider({ value, children }: { value: Kept; children: ReactNode }) {
  return <KeptCardsContext.Provider value={value}>{children}</KeptCardsContext.Provider>;
}
