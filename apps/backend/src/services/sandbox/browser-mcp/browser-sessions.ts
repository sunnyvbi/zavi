
import { serviceClient } from "@/services/supabase";
import type { BrowserEngine } from "./engine-policy";

export interface OpenBrowserSessionArgs {
  tenant_id: string;
  run_id: string | null;
  engine: BrowserEngine;
  origin?: string;
  anchor_profile_id?: string;
}

export async function openBrowserSession(
  args: OpenBrowserSessionArgs,
): Promise<string> {
  const { data, error } = await serviceClient().rpc("open_browser_session", {
    p_tenant_id: args.tenant_id,
    p_run_id: args.run_id ?? null,
    p_engine: args.engine,
    p_origin: args.origin ?? null,
    p_anchor_profile_id: args.anchor_profile_id ?? null,
  });
  if (error) {
    throw new Error(`open_browser_session failed: ${error.message}`);
  }
  return data as string;
}

export interface SetProviderSessionIdArgs {
  session_id: string;
  provider_session_id: string;
}

export async function setBrowserSessionProviderId(
  args: SetProviderSessionIdArgs,
): Promise<void> {
  const { error } = await serviceClient().rpc("set_browser_session_provider_id", {
    p_session_id: args.session_id,
    p_provider_session_id: args.provider_session_id,
  });
  if (error) {
    throw new Error(`set_browser_session_provider_id failed: ${error.message}`);
  }
}

export interface CloseBrowserSessionArgs {
  session_id: string;
  browser_seconds?: number;
  proxy_bytes?: number;
  reason?: string;
}

export async function closeBrowserSession(
  args: CloseBrowserSessionArgs,
): Promise<void> {
  const { error } = await serviceClient().rpc("close_browser_session", {
    p_session_id: args.session_id,
    p_browser_seconds: args.browser_seconds ?? 0,
    p_proxy_bytes: args.proxy_bytes ?? 0,
    p_reason: args.reason ?? null,
  });
  if (error) {
    throw new Error(`close_browser_session failed: ${error.message}`);
  }
}
