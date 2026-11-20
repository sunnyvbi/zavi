
import { createBrowserAdminSupabase } from "./supabase-admin";
import { apiUrl } from "./api";

export type AdminApiOptions = RequestInit;

export async function adminApiFetch(path: string, opts: AdminApiOptions = {}): Promise<Response> {
  const { headers: hdrs, ...rest } = opts;
  const supabase = createBrowserAdminSupabase();
  const headers = new Headers(hdrs);

  if (!headers.has("Content-Type") && rest.body && typeof rest.body === "string") {
    headers.set("Content-Type", "application/json");
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) headers.set("Authorization", `Bearer ${token}`);

  return fetch(apiUrl(path), { ...rest, headers });
}
