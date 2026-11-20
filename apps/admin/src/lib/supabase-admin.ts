
import { createBrowserClient, createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";

function url(): string {
  const u = process.env.NEXT_PUBLIC_STAFF_SUPABASE_URL;
  if (!u) throw new Error("NEXT_PUBLIC_STAFF_SUPABASE_URL is not set");
  return u;
}

function anonKey(): string {
  const k = process.env.NEXT_PUBLIC_STAFF_SUPABASE_ANON_KEY;
  if (!k) throw new Error("NEXT_PUBLIC_STAFF_SUPABASE_ANON_KEY is not set");
  return k;
}

function _createAdmin() {
  return createBrowserClient(url(), anonKey());
}

let _browserAdminSingleton: ReturnType<typeof _createAdmin> | null = null;

export function createBrowserAdminSupabase() {
  if (typeof window === "undefined") {
    return _createAdmin();
  }
  if (_browserAdminSingleton === null) {
    _browserAdminSingleton = _createAdmin();
  }
  return _browserAdminSingleton;
}

export function createServerStaffSupabase(cookieStore: {
  get: (name: string) => { value: string } | undefined;
  set?: (opts: { name: string; value: string } & CookieOptions) => void;
  remove?: (opts: { name: string } & CookieOptions) => void;
}) {
  return createServerClient(url(), anonKey(), {
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
