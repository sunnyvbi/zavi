
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  AUTH_STORAGE_KEY,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from "../shared/config";
import { chromeLocalStorageAdapter } from "../shared/storage";

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (client) return client;
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: chromeLocalStorageAdapter(),
      storageKey: AUTH_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  });
  return client;
}

export async function accessToken(): Promise<string | null> {
  const { data } = await supabase().auth.getSession();
  return data.session?.access_token ?? null;
}
