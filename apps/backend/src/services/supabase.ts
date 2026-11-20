
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { dbFetchTimeoutMs, fetchWithTimeout, LONG_DB_FETCH_TIMEOUT_MS } from "./db-fetch-timeout";

const g = globalThis as unknown as { WebSocket?: unknown };
if (typeof g.WebSocket === "undefined") {
  g.WebSocket = WebSocket;
}

let _serviceClient: SupabaseClient | null = null;

function url(): string {
  const u = process.env.SUPABASE_URL;
  if (!u) {
    throw new Error(
      "SUPABASE_URL env var is missing. Set it in apps/backend/.env (local: " +
        "http://127.0.0.1:54321, prod: https://<project>.supabase.co).",
    );
  }
  return u;
}

function anonKey(): string {
  const k = process.env.SUPABASE_ANON_KEY;
  if (!k) {
    throw new Error(
      "SUPABASE_ANON_KEY env var is missing. Get it from `supabase status` " +
        "locally or the dashboard for hosted projects.",
    );
  }
  return k;
}

function serviceRoleKey(): string {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY env var is missing. Get it from `supabase " +
        "status`. NEVER set this in apps/web/.env*.",
    );
  }
  return k;
}

export function serverClientFromBearer(accessToken: string): SupabaseClient {
  return createClient(url(), anonKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
      fetch: fetchWithTimeout(dbFetchTimeoutMs()),
    },
  });
}

export function serviceClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient;
  _serviceClient = createClient(url(), serviceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchWithTimeout(dbFetchTimeoutMs()) },
  });
  return _serviceClient;
}

let _serviceClientLong: SupabaseClient | null = null;
export function serviceClientLong(): SupabaseClient {
  if (_serviceClientLong) return _serviceClientLong;
  _serviceClientLong = createClient(url(), serviceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchWithTimeout(LONG_DB_FETCH_TIMEOUT_MS) },
  });
  return _serviceClientLong;
}

export function anonClient(): SupabaseClient {
  return createClient(url(), anonKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchWithTimeout(dbFetchTimeoutMs()) },
  });
}

export function _resetServiceClientForTests(): void {
  _serviceClient = null;
  _serviceClientLong = null;
}
