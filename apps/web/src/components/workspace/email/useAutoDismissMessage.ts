"use client";

import { useCallback, useEffect, useState } from "react";

export const MESSAGE_SHOWN_MS = 2_800;

export function useAutoDismissMessage(ms: number = MESSAGE_SHOWN_MS) {
  const [shown, setShown] = useState<{ text: string; key: number } | null>(null);

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), ms);
    return () => clearTimeout(timer);
  }, [shown, ms]);

  const show = useCallback((text: string) => setShown((prev) => ({ text, key: (prev?.key ?? 0) + 1 })), []);
  const clear = useCallback(() => setShown(null), []);
  return { message: shown?.text ?? null, show, clear };
}
