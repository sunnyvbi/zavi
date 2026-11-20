
import { createClient } from "@supabase/supabase-js";

if (typeof globalThis.WebSocket === "undefined") {
  try {
    const { default: WS } = await import("ws");
    globalThis.WebSocket = WS;
  } catch {
  }
}

const SCRIPT_TIMEOUT_MS = Number(process.env.SUPABASE_FETCH_TIMEOUT_MS ?? 30_000);
const boundedFetch =
  SCRIPT_TIMEOUT_MS > 0
    ? (input, init = {}) =>
        fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(SCRIPT_TIMEOUT_MS) })
    : fetch;

export function createScriptClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Run from apps/backend with: node --env-file=.env scripts/<script>.mjs",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: boundedFetch },
  });
}
