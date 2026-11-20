
import type { Session } from "@supabase/supabase-js";
import type { AuthLaunchRequest, AuthLaunchResponse } from "../shared/messages";
import { API_BASE, CONNECT_URL } from "../shared/config";
import { supabase } from "./supabase";

export class AuthError extends Error {}

export const EXPIRED_MESSAGE = "That sign-in link expired. Try again.";
export const GENERIC_MESSAGE = "Sign-in didn't complete. Try again.";
export const CANCELLED_MESSAGE = "Sign-in cancelled";

export class AuthCancelledError extends AuthError {
  constructor() {
    super(CANCELLED_MESSAGE);
  }
}

export async function signInWithZavi(): Promise<Session> {
  const request: AuthLaunchRequest = { type: "zavi:auth:launch", url: CONNECT_URL };
  const response = (await chrome.runtime.sendMessage(
    request,
  )) as AuthLaunchResponse | undefined;

  if (!response) throw new AuthError(GENERIC_MESSAGE);
  if (!response.ok) throw new AuthCancelledError();

  const code = extractConnectCode(response.redirectUrl);
  if (!code) throw new AuthError(GENERIC_MESSAGE);

  const res = await fetch(`${API_BASE}/api/extension/connect/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  if (!res.ok) {
    throw new AuthError(res.status === 400 ? EXPIRED_MESSAGE : GENERIC_MESSAGE);
  }

  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; refresh_token?: string }
    | null;
  if (!body?.access_token || !body.refresh_token) throw new AuthError(GENERIC_MESSAGE);

  const { data, error } = await supabase().auth.setSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
  });
  if (error || !data.session) throw new AuthError(GENERIC_MESSAGE);
  return data.session;
}

export async function signOut(): Promise<void> {
  await supabase().auth.signOut({ scope: "local" });
}

export function extractConnectCode(redirectUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(redirectUrl);
  } catch {
    return null;
  }
  if (u.searchParams.get("error")) throw new AuthCancelledError();
  return u.searchParams.get("code");
}
