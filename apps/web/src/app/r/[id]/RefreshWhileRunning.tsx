"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function RefreshWhileRunning({ everyMs = 5000, giveUpMs = 8 * 60_000 }: { everyMs?: number; giveUpMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    const stop = setTimeout(() => clearInterval(t), giveUpMs);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [router, everyMs, giveUpMs]);
  return null;
}
