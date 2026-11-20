
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { CONNECT_RETURN_KEY, CONNECTORS_PAGE, connectReturnPath, rememberConnectReturn, takeConnectReturn } from "./ConnectButton";
import { askConnectField, type ConnectField } from "./connectFieldPrompt";

type ConnectResponse = { oauth_url?: string; connected_account_id?: string; error?: { code?: string; message?: string; field?: ConnectField } };

export const COMPOSIO_CONNECT_LINE = "You'll approve access through Composio, our secure connection partner.";

export const COMPOSIO_CONNECT_FAILED = "Could not start the connection. Try again.";

const GOOGLE_BOX_LINE: Record<string, string> = {
  google_analytics: "On Google’s screen, tick the Google Analytics box, or Zavi can’t read your data.",
  google_search_console: "On Google’s screen, tick the Search Console box, or Zavi can’t read your data.",
};

export function composioConnectLine(toolkit: string): string {
  const box = GOOGLE_BOX_LINE[toolkit];
  return box ? `${COMPOSIO_CONNECT_LINE} ${box}` : COMPOSIO_CONNECT_LINE;
}

export async function startComposioConnect(toolkit: string): Promise<void> {
  const ok = await confirmAction({
    title: "Connect through Composio",
    description: composioConnectLine(toolkit),
    confirmLabel: "Continue",
  });
  if (!ok) return;
  const path = `/api/connectors/composio/${encodeURIComponent(toolkit)}/connect`;
  const back = connectReturnPath();
  const tab = SAME_TAB_TOOLKITS.has(toolkit) ? null : window.open("", "_blank");
  if (tab) tab.opener = null;
  const post = async (extra: Record<string, unknown> = {}) => {
    const payload = { ...(back ? { return_to: back } : {}), ...(tab ? { popup: true } : {}), ...extra };
    try {
      return await apiFetch(path, Object.keys(payload).length ? { method: "POST", body: JSON.stringify(payload) } : { method: "POST" });
    } catch (e) {
      tab?.close();
      throw e;
    }
  };
  let res = await post();
  if (res.status === 401) {
    tab?.close();
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    return;
  }
  let body = (await res.json().catch(() => ({}))) as ConnectResponse;
  if (res.status === 400 && body.error?.code === "connection_data_required" && body.error.field) {
    const field = body.error.field;
    const value = await askConnectField(toolkit.charAt(0).toUpperCase() + toolkit.slice(1), field);
    if (!value) {
      tab?.close();
      return;
    }
    res = await post({ connection_data: { [field.key]: value } });
    body = (await res.json().catch(() => ({}))) as ConnectResponse;
  }
  if (!res.ok || body.error || !body.oauth_url) {
    tab?.close();
    throw new Error(body.error?.message?.trim() || COMPOSIO_CONNECT_FAILED);
  }
  rememberStart();
  if (!tab || !body.connected_account_id) {
    tab?.close();
    window.location.href = body.oauth_url;
    return;
  }
  tab.location.href = body.oauth_url;
  void watchComposioConnect(toolkit, body.connected_account_id, tab);
}

const SAME_TAB_TOOLKITS = new Set(["google_analytics", "google_search_console"]);
export const COMPOSIO_WATCH_MS = 2_000;
export const COMPOSIO_WATCH_LIMIT_MS = 600_000;
export const COMPOSIO_DONE_CHANNEL = "zavi-composio-connect";

async function storedAccount(toolkit: string): Promise<string | null> {
  try {
    const sb = createBrowserSupabase();
    const tenantId = await getActiveTenantId(sb);
    if (!tenantId) return null;
    const { data } = await sb
      .from("connector_metadata")
      .select("team_id")
      .eq("tenant_id", tenantId)
      .eq("slug", `composio.${toolkit}`)
      .maybeSingle();
    return (data as { team_id?: string | null } | null)?.team_id ?? null;
  } catch {
    return null;
  }
}

export function watchComposioConnect(toolkit: string, accountId: string, tab: Window): Promise<boolean> {
  const until = Date.now() + COMPOSIO_WATCH_LIMIT_MS;
  return new Promise((resolve) => {
    let checking = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const done = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(COMPOSIO_DONE_CHANNEL);
    const stop = (connected: boolean) => {
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", check);
      done?.close();
      resolve(connected);
    };
    if (done) {
      done.onmessage = (e: MessageEvent) => {
        const msg = e.data as { toolkit?: unknown; status?: unknown } | null;
        if (msg?.toolkit !== toolkit) return;
        if (msg.status === "error") stop(false);
        else if (msg.status === "connected") void check();
      };
    }
    async function check() {
      if (checking) return;
      if (Date.now() > until) return stop(false);
      checking = true;
      const stored = await storedAccount(toolkit);
      checking = false;
      if (stored !== accountId) return;
      if (!tab.closed) tab.close();
      stop(true);
      window.location.replace(takeConnectReturn(`?tab=settings&composio_${toolkit}=connected`) ?? CONNECTORS_PAGE);
    }
    timer = setInterval(check, COMPOSIO_WATCH_MS);
    window.addEventListener("focus", check);
  });
}

function rememberStart(): void {
  const loc = window.location;
  try {
    sessionStorage.removeItem(CONNECT_RETURN_KEY);
    if (new URLSearchParams(loc.search).get("tab") === "settings") {
      sessionStorage.setItem(CONNECT_RETURN_KEY, loc.pathname + loc.search + loc.hash);
    }
  } catch {
    return;
  }
  rememberConnectReturn();
}
