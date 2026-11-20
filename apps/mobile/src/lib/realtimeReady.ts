import { supabase } from "./supabase";

const RETRY_DELAYS_MS = [250, 1_000, 2_000, 4_000];
let ready: Promise<void> | null = null;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function realtimeReady(): Promise<void> {
  if (ready) return ready;
  const self: { promise: Promise<void> | null } = { promise: null };
  self.promise = (async () => {
    for (let i = 0; ; i++) {
      try {
        await supabase.realtime.setAuth();
        return;
      } catch {
        if (i >= RETRY_DELAYS_MS.length) {
          if (ready === self.promise) ready = null;
          return;
        }
        await wait(RETRY_DELAYS_MS[i]);
      }
    }
  })();
  ready = self.promise;
  return self.promise;
}
