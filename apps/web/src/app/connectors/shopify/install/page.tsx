"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { createBrowserSupabase } from "@/lib/supabase";
import { switchToTenantDetailed } from "@/lib/workspace/tenantSwitch";
import { claimShopifyInstall, loadShopifyInstall } from "./startShopifyInstall";

export const dynamic = "force-dynamic";

type Tenant = { tenant_id: string; display_name: string; role: string };
type Screen =
  | { kind: "loading" }
  | { kind: "ready"; shop: string; tenants: Tenant[]; selected: string; linkOnly: boolean }
  | { kind: "connecting"; shop: string; tenants: Tenant[]; selected: string; linkOnly: boolean }
  | { kind: "error"; message: string };

const CALLBACK_ERRORS: Record<string, string> = {
  invalid_signature: "Shopify could not verify this installation. Open Zavi from Shopify and try again.",
  invalid_callback: "Shopify returned an incomplete authorization. Open Zavi from Shopify and try again.",
  invalid_state: "This Shopify authorization has expired or was already used. Open Zavi from Shopify and try again.",
  token_rejected: "Shopify authorization was not completed. Open Zavi from Shopify and approve access again.",
  missing_scope: "The required Shopify permissions were not granted. Open Zavi from Shopify and approve access again.",
};

async function loadTenants(): Promise<Tenant[] | null> {
  try {
    const response = await apiFetch("/api/v1/tenants/mine");
    if (!response.ok) return null;
    const body = (await response.json()) as { tenants?: Tenant[] };
    if (!Array.isArray(body.tenants)) return null;
    return body.tenants.filter((tenant) => tenant.role === "owner" || tenant.role === "admin");
  } catch {
    return null;
  }
}

function Body() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const callbackError = params.get("error") ?? "";
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  useEffect(() => {
    if (callbackError) {
      setScreen({ kind: "error", message: CALLBACK_ERRORS[callbackError] ?? "Could not complete Shopify authorization. Open Zavi from Shopify and try again." });
      return;
    }
    let cancelled = false;
    const here = window.location.pathname + window.location.search;
    void (async () => {
      const outcome = await loadShopifyInstall(token, apiFetch);
      if (cancelled) return;
      if (outcome.kind === "login") {
        window.location.href = `/login?next=${encodeURIComponent(here)}`;
        return;
      }
      if (outcome.kind === "connected") {
        window.location.href = outcome.url;
        return;
      }
      if (outcome.kind === "error") {
        setScreen(outcome);
        return;
      }
      const [owned, active] = await Promise.all([loadTenants(), getActiveTenantId(createBrowserSupabase()).catch(() => null)]);
      if (cancelled) return;
      const linkTenantId = outcome.linkTenantId;
      const tenants = owned && linkTenantId ? owned.filter((tenant) => tenant.tenant_id === linkTenantId) : owned;
      if (tenants === null) {
        setScreen({ kind: "error", message: "Could not load your Zavi workspaces. Reload this page to try again." });
        return;
      }
      if (tenants.length === 0) {
        setScreen({ kind: "error", message: "Only a workspace owner or admin can connect Shopify. Create a Zavi workspace or ask an owner to connect the store." });
        return;
      }
      const selected = tenants.some((tenant) => tenant.tenant_id === active) ? active! : tenants[0].tenant_id;
      setScreen({ kind: "ready", shop: outcome.shop, tenants, selected, linkOnly: Boolean(linkTenantId) });
    })();
    return () => { cancelled = true; };
  }, [callbackError, token]);

  const selectedTenant = useMemo(
    () => screen.kind === "ready" || screen.kind === "connecting"
      ? screen.tenants.find((tenant) => tenant.tenant_id === screen.selected)
      : null,
    [screen],
  );

  async function connect(): Promise<void> {
    if (screen.kind !== "ready") return;
    const current = screen;
    setScreen({ ...current, kind: "connecting" });
    const switched = await switchToTenantDetailed(current.selected).catch(() => "not_converged" as const);
    if (switched !== "ok") {
      setScreen({ kind: "error", message: switched === "refused" ? "You no longer have access to that workspace." : "Could not switch to that workspace. Try again." });
      return;
    }
    const outcome = await claimShopifyInstall(token, apiFetch);
    if (outcome.kind === "login") {
      const here = window.location.pathname + window.location.search;
      window.location.href = `/login?next=${encodeURIComponent(here)}`;
      return;
    }
    if (outcome.kind === "connected") {
      window.location.href = outcome.url;
      return;
    }
    setScreen({ kind: "error", message: outcome.kind === "error" ? outcome.message : "Could not finish the Shopify connection. Try again." });
  }

  const working = screen.kind === "loading" || screen.kind === "connecting";
  const ready = screen.kind === "ready" || screen.kind === "connecting" ? screen : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-6">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-900">
          {screen.kind === "error" ? "We could not connect your store" : ready ? (ready.linkOnly ? "Link your Shopify staff account" : "Connect Shopify to Zavi") : "Loading your Shopify installation"}
        </h1>
        {ready ? (
          <>
            <p className="mt-3 text-sm text-neutral-600">
              {ready.linkOnly ? (
                <><span className="font-medium text-neutral-900">{ready.shop}</span> is already connected to this Zavi workspace. Continue to link your Shopify staff account to it.</>
              ) : (
                <>Shopify approved access for <span className="font-medium text-neutral-900">{ready.shop}</span>. Choose the Zavi workspace that should use this store.</>
              )}
            </p>
            <label className="mt-6 block text-sm font-medium text-neutral-800" htmlFor="shopify-workspace">Workspace</label>
            <select
              id="shopify-workspace"
              value={ready.selected}
              disabled={working}
              onChange={(event) => setScreen({ ...ready, kind: "ready", selected: event.target.value })}
              className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-3 py-3 text-sm text-neutral-900"
            >
              {ready.tenants.map((tenant) => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.display_name}</option>)}
            </select>
            <button
              type="button"
              disabled={working || !selectedTenant}
              onClick={() => void connect()}
              className="mt-6 w-full rounded-lg bg-neutral-900 px-4 py-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {screen.kind === "connecting" ? (ready.linkOnly ? "Linking…" : "Connecting…") : ready.linkOnly ? "Link account" : "Connect Shopify"}
            </button>
            <p className="mt-3 text-center text-xs text-neutral-500">You will manage this connection in Zavi.</p>
          </>
        ) : (
          <p className="mt-3 text-sm text-neutral-600">
            {screen.kind === "error" ? screen.message : "One moment…"}
          </p>
        )}
        {screen.kind === "error" && (
          <a href="/workspace?tab=brain#integration" className="mt-6 inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white">
            Open Zavi
          </a>
        )}
      </div>
    </main>
  );
}

export default function ShopifyInstallPage() {
  return <Suspense fallback={null}><Body /></Suspense>;
}
