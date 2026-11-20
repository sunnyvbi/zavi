
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { plainNext } from "@/lib/safe-next";
import { fetchWithTimeout, WEB_SERVER_DB_TIMEOUT_MS } from "@/lib/fetch-timeout";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = plainNext(url.searchParams.get("next")) ?? "/start";
  const errorParam = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || url.origin;

  if (errorParam) {
    const back = new URL("/login", origin);
    back.searchParams.set(
      "error",
      errorDescription || errorParam,
    );
    back.searchParams.set("next", next);
    return NextResponse.redirect(back);
  }

  if (!code) {
    const back = new URL("/login", origin);
    back.searchParams.set("error", "No auth code returned from provider.");
    back.searchParams.set("next", next);
    return NextResponse.redirect(back);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnon) {
    const back = new URL("/login", origin);
    back.searchParams.set("error", "Supabase env not configured.");
    return NextResponse.redirect(back);
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(supabaseUrl, supabaseAnon, {
    global: { fetch: fetchWithTimeout(WEB_SERVER_DB_TIMEOUT_MS) },
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        cookieStore.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        cookieStore.set({ name, value: "", ...options });
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const back = new URL("/login", origin);
    back.searchParams.set("error", error.message);
    back.searchParams.set("next", next);
    return NextResponse.redirect(back);
  }

  const dest = new URL(next, origin);
  return NextResponse.redirect(dest);
}
