"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import { rememberConnectReturn } from "./ConnectButton";

export async function startMetaAdsConnect(): Promise<void> {
  const popup = window.open(
    "about:blank",
    "meta_oauth",
    "noopener=no,popup=yes,width=600,height=750",
  );
  if (!popup) {
    showConnectorError({
      title: "Popup blocked",
      message: "Allow popups for this site and try again.",
    });
    return;
  }
  try {
    const res = await apiFetch("/api/connectors/meta-ads/start", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const body = (await res.json().catch(() => ({}))) as {
      oauth_url?: string;
      error?: { code?: string; message?: string };
    };
    if (res.status === 401) {
      popup.close();
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    if (!res.ok || !body.oauth_url) {
      popup.close();
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    rememberConnectReturn();
    popup.location.href = body.oauth_url;
  } catch (e) {
    try {
      popup.close();
    } catch (_) {
    }
    showConnectorError({
      title: "Couldn’t connect Meta Ads",
      message: (e as Error).message,
    });
  }
}

export function MetaAdsConnectButton({ connected }: { connected: boolean }) {
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    await startMetaAdsConnect();
    setBusy(false);
  }

  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      className="inline-flex h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold leading-[20px] tracking-[0.01px] text-[#1f1f1f] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa] disabled:opacity-50"
    >
      {busy ? "Opening…" : connected ? "Reconnect" : "Connect"}
    </button>
  );
}
