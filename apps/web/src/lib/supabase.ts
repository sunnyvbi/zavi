
import { createBrowserClient, createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";
import { fetchWithTimeout, WEB_BROWSER_DB_TIMEOUT_MS, WEB_SERVER_DB_TIMEOUT_MS } from "./fetch-timeout";

function url(): string {
  const u = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!u) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  return u;
}

function anonKey(): string {
  const k = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!k) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  return k;
}

export function keepSessionOnBusyRefresh(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    if (res.status !== 408 && res.status !== 429) return res;
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/auth\/v1\/token\b/.test(target) && /grant_type=refresh_token/.test(target)) throw new TypeError("Failed to fetch");
    return res;
  };
}

function freshBrowserSupabase() {
  return createBrowserClient(url(), anonKey(), {
    global: { fetch: keepSessionOnBusyRefresh(fetchWithTimeout(WEB_BROWSER_DB_TIMEOUT_MS)) },
  });
}

let _browserClient: ReturnType<typeof freshBrowserSupabase> | null = null;

export function createBrowserSupabase() {
  if (typeof window === "undefined") {
    return freshBrowserSupabase();
  }
  return (_browserClient ??= freshBrowserSupabase());
}

export function createServerSupabase(cookieStore: {
  get: (name: string) => { value: string } | undefined;
  set?: (opts: { name: string; value: string } & CookieOptions) => void;
  remove?: (opts: { name: string } & CookieOptions) => void;
}) {
  return createServerClient(url(), anonKey(), {
    global: { fetch: fetchWithTimeout(WEB_SERVER_DB_TIMEOUT_MS) },
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set?.({ name, value, ...options });
        } catch {
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.remove?.({ name, ...options });
        } catch {
        }
      },
    },
  });
}
