"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { showConnectorError } from "@/components/workspace/settings/connectorErrorDialog";
import { replaceWorkspaceLocation } from "@/components/workspace/navigation/workspaceRoutes";
import { SETUP_CONNECT_STEP, SETUP_STEP_PARAM } from "@/lib/onboardingRoutes";

export const CONNECT_RETURN_KEY = "praxis:connect-return";
export const CONNECTORS_PAGE = "/workspace?tab=brain#integrations";

const URL_BASE = "https://workspace.local";
const WORKSPACE_PAGE_RE = /^\/workspace(?:\/[^/]+)?\/?$/;
const RETURN_PAGE_RE = /^\/workspace(?:\/[A-Za-z0-9-]+)?\/?$/;
const RETURN_MAX = 512;

function workspaceHref(href: string): URL | null {
  try {
    const url = new URL(href, URL_BASE);
    return url.origin === URL_BASE && WORKSPACE_PAGE_RE.test(url.pathname) ? url : null;
  } catch {
    return null;
  }
}

function withParams(url: URL, params: Array<[string, string]>): string {
  for (const [k, v] of params) url.searchParams.set(k, v);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function rememberConnectReturn(
  loc: { pathname: string; search: string; hash?: string } = window.location,
): void {
  if (!WORKSPACE_PAGE_RE.test(loc.pathname)) return;
  if (new URLSearchParams(loc.search).get("tab") === "settings") return;
  try {
    sessionStorage.setItem(CONNECT_RETURN_KEY, loc.pathname + loc.search + (loc.hash ?? ""));
  } catch {
  }
}

export function takeConnectReturn(search: string): string | null {
  const qs = new URLSearchParams(search);
  if (qs.get("tab") !== "settings") {
    if (Array.from(qs.values()).includes("connected")) {
      try {
        sessionStorage.removeItem(CONNECT_RETURN_KEY);
      } catch {
      }
    }
    return null;
  }
  const error = qs.get("composio_error") ?? qs.get("connect_error");
  const connected = Array.from(qs.entries()).find(([, v]) => v === "connected");
  if (!error && !connected) return null;
  let back: string | null = null;
  try {
    back = sessionStorage.getItem(CONNECT_RETURN_KEY);
    sessionStorage.removeItem(CONNECT_RETURN_KEY);
  } catch {
  }
  if (error) {
    const params = Array.from(qs.entries()).filter(([k]) => k !== "tab");
    const saved = back && workspaceHref(back);
    const target = saved && saved.searchParams.get(SETUP_STEP_PARAM) === SETUP_CONNECT_STEP ? saved : new URL(CONNECTORS_PAGE, URL_BASE);
    return withParams(target, params);
  }
  const target = (back && workspaceHref(back)) || new URL(CONNECTORS_PAGE, URL_BASE);
  return withParams(target, [connected!]);
}

export function returnFromConnect(search: string = window.location.search): boolean {
  const back = takeConnectReturn(search);
  if (!back) return false;
  replaceWorkspaceLocation(back);
  return true;
}

export function connectReturnPath(
  loc: { pathname: string; search: string; hash?: string } = window.location,
): string | null {
  const raw = loc.pathname + loc.search + (loc.hash ?? "");
  if (raw.length > RETURN_MAX) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(raw, URL_BASE);
  } catch {
    return null;
  }
  if (url.origin !== URL_BASE || !RETURN_PAGE_RE.test(url.pathname)) return null;
  if (url.searchParams.get("tab") === "settings") return null;
  const normalized = `${url.pathname}${url.search}${url.hash}`;
  return normalized.length > RETURN_MAX ? null : normalized;
}

export const CONNECT_START_FAILED = "Zavi couldn’t open the sign-in page just now, so nothing changed. Try again in a minute.";

function forgetConnectReturn(): void {
  let store: Storage | null = null;
  try {
    store = window.sessionStorage;
  } catch {
    store = null;
  }
  store?.removeItem(CONNECT_RETURN_KEY);
}

export async function startConnectFlow(slug: string, opts?: { returnHere?: boolean }): Promise<void> {
  const back = opts?.returnHere === false ? null : connectReturnPath();
  forgetConnectReturn();
  rememberConnectReturn();
  const query = back ? `?return_to=${encodeURIComponent(back)}` : "";
  const res = await apiFetch(`/api/connectors/${slug}/start${query}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(
      window.location.pathname + window.location.search,
    )}`;
    return;
  }
  const body = (await res.json().catch(() => ({}))) as {
    oauth_url?: string;
    error?: { code?: string; message?: string };
  };
  if (!res.ok || !body.oauth_url) {
    throw new Error(
      body.error?.code === "state_mint_failed" || !body.error?.message
        ? CONNECT_START_FAILED
        : body.error.message,
    );
  }
  window.location.href = body.oauth_url;
}

export function ConnectButton({
  slug,
  connected,
  className,
}: {
  slug: string;
  connected: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      await startConnectFlow(slug);
    } catch (e) {
      showConnectorError({
        title: "Couldn’t open the connection",
        message: (e as Error).message,
      });
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      className={`inline-flex h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-cta border border-[#f0f0f0] bg-white px-4 text-[16px] font-semibold leading-[20px] tracking-[0.01px] text-[#1f1f1f] transition-colors hover:border-[#e0e0e0] hover:bg-[#fafafa] disabled:opacity-50${className ? ` ${className}` : ""}`}
    >
      {busy ? "Opening…" : connected ? "Reconnect" : "Connect"}
    </button>
  );
}
