
import { createBrowserSupabase } from "@/lib/supabase";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getBrowserSupabaseSingleton(): any {
  return createBrowserSupabase();
}

export const AUTH_RETRY_DELAYS_MS = [250, 1_000, 2_000, 4_000];
let authReady: Promise<void> | null = null;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function realtimeAuthReady(): Promise<void> {
  if (authReady) return authReady;
  const sb = getBrowserSupabaseSingleton();
  const self: { promise: Promise<void> | null } = { promise: null };
  self.promise = (async () => {
    for (let i = 0; ; i++) {
      try {
        await sb.realtime.setAuth();
        return;
      } catch {
        if (i >= AUTH_RETRY_DELAYS_MS.length) {
          if (authReady === self.promise) authReady = null;
          return;
        }
        await wait(AUTH_RETRY_DELAYS_MS[i]);
      }
    }
  })();
  authReady = self.promise;
  return self.promise;
}

export function resetRealtimeAuthReadyForTests(): void {
  authReady = null;
}

export function syncRealtimeAuth(): () => void {
  const sb = getBrowserSupabaseSingleton();
  void realtimeAuthReady();
  const { data: sub } = sb.auth.onAuthStateChange(() => {
    void Promise.resolve(sb.realtime.setAuth()).catch(() => {});
  });
  return () => sub.subscription.unsubscribe();
}
