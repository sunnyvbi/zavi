"use client";

import { createBrowserSupabase } from "@/lib/supabase";

const clearers = new Set<() => void>();
let subscribed = false;
let lastUserId: string | null = null;

function clearAll(): void {
  for (const clear of clearers) clear();
}

export function registerSessionScopedCache(clear: () => void): void {
  clearers.add(clear);
  if (subscribed || typeof window === "undefined") return;
  try {
    createBrowserSupabase().auth.onAuthStateChange((event, session) => {
      const userId = session?.user?.id ?? null;
      if (
        event === "SIGNED_OUT" ||
        (lastUserId !== null && userId !== null && userId !== lastUserId)
      ) {
        clearAll();
      }
      lastUserId = event === "SIGNED_OUT" ? null : (userId ?? lastUserId);
    });
    subscribed = true;
  } catch {
  }
}
