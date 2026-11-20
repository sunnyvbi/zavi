"use client";

import { useEffect, useState } from "react";
import { ZAVI_APP_URL, confirmShopifyConnection, decideAppHomeApproval, fixtureFromSearch, loadAppHome, previewShopifyConnection, startShopifyBilling, startShopifyConnection } from "@/lib/shopify-app-home/client";
import type { AppHomeState, ShopifyConnectionConfirmation } from "@/lib/shopify-app-home/types";
import { ApprovalsCard } from "./ApprovalsCard";
import { AppHomeSkeleton } from "./AppHomeSkeleton";
import { FreePlanBanner } from "./FreePlanBanner";
import { MetricsCard } from "./MetricsCard";
import { PlanCard } from "./PlanCard";
import { SetupCard } from "./SetupCard";
import { StatusCard } from "./StatusCard";
import { TitleBar } from "./TitleBar";

export function AppHome() {
  const [state, setState] = useState<AppHomeState>({ kind: "loading" });
  const [connecting, setConnecting] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<{ token: string; preview: ShopifyConnectionConfirmation } | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fixture = fixtureFromSearch(window.location.search);
    const params = new URLSearchParams(window.location.search);
    const confirmation = fixture ? null : params.get("zavi_confirmation");
    if (confirmation) {
      params.delete("zavi_confirmation");
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
    (confirmation
      ? previewShopifyConnection(confirmation).then((preview) => {
          if (!cancelled) setPendingConfirmation({ token: confirmation, preview });
          return null;
        })
      : loadAppHome(fixture))
      .then((result) => { if (!cancelled && result) setState(result); })
      .catch((error) => { if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "Could not load your Zavi workspace. Reload this page to try again." }); });
    return () => { cancelled = true; };
  }, []);

  async function connect(): Promise<void> {
    if (connecting) return;
    setConnecting(true);
    setSetupError(null);
    try {
      await startShopifyConnection();
    } catch (error) {
      setConnecting(false);
      setSetupError(error instanceof Error ? error.message : "Could not prepare this Shopify connection. Try again.");
    }
  }

  async function confirmConnection(): Promise<void> {
    if (!pendingConfirmation || confirmationBusy) return;
    setConfirmationBusy(true);
    setConfirmationError(null);
    try {
      await confirmShopifyConnection(pendingConfirmation.token);
    } catch (error) {
      setConfirmationError(error instanceof Error ? error.message : "Could not connect this store. Try again.");
      setConfirmationBusy(false);
      return;
    }
    try {
      setState(await loadAppHome(null));
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Could not load your Zavi workspace. Reload this page to try again." });
    }
    setPendingConfirmation(null);
    setConfirmationBusy(false);
  }

  const linkOnly = pendingConfirmation?.preview.link_only === true;

  return (
    <main className="mx-auto w-full max-w-[1048px] pb-8 text-neutral-900 sm:px-4">
      <TitleBar openUrl={ZAVI_APP_URL} />
      {pendingConfirmation && (
        <section className="border-y border-neutral-200 bg-white px-5 py-8 sm:rounded-xl sm:border sm:px-8" aria-labelledby="shopify-confirm-title">
          <div className="max-w-xl">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-neutral-500">{linkOnly ? "Confirm link" : "Confirm connection"}</p>
            <h1 id="shopify-confirm-title" className="mt-3 text-2xl font-semibold tracking-[-0.025em] text-neutral-950">
              {linkOnly ? "Link your Shopify staff account?" : `Connect ${pendingConfirmation.preview.shop}?`}
            </h1>
            <p className="mt-3 text-[14px] leading-6 text-neutral-600">
              {linkOnly ? `This links your Shopify staff account on ${pendingConfirmation.preview.shop} to ` : "This connects the Shopify store to "}<strong className="font-semibold text-neutral-900">{pendingConfirmation.preview.workspace.display_name}</strong>
              {pendingConfirmation.preview.workspace.account_email ? <> using <strong className="font-semibold text-neutral-900">{pendingConfirmation.preview.workspace.account_email}</strong></> : null}.
            </p>
            <p className="mt-2 text-[13px] leading-5 text-neutral-500">Nothing is {linkOnly ? "linked" : "connected"} until you select the button below.</p>
            {confirmationError && <div role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-800">{confirmationError}</div>}
            <button
              type="button"
              disabled={confirmationBusy}
              onClick={() => void confirmConnection()}
              className="mt-6 rounded-lg bg-neutral-950 px-5 py-3 text-[14px] font-medium text-white transition hover:bg-neutral-800 disabled:cursor-wait disabled:opacity-60"
            >
              {confirmationBusy ? (linkOnly ? "Linking…" : "Connecting…") : linkOnly ? "Link account" : "Connect store"}
            </button>
          </div>
        </section>
      )}
      {!pendingConfirmation && state.kind === "loading" && <AppHomeSkeleton />}
      {!pendingConfirmation && (state.kind === "setup" || state.kind === "link") && (
        <SetupCard connecting={connecting} error={setupError} onConnect={() => void connect()} linkOnly={state.kind === "link"} />
      )}
      {!pendingConfirmation && state.kind === "unavailable" && (
        <div className="border-y border-neutral-200 bg-white px-4 py-6 text-[13px] text-neutral-700 sm:rounded-xl sm:border">
          Zavi inside Shopify is not available yet. Open Zavi to see your workspace.
        </div>
      )}
      {!pendingConfirmation && state.kind === "error" && (
        <div role="alert" className="border-y border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-800 sm:rounded-xl sm:border">{state.message}</div>
      )}
      {!pendingConfirmation && state.kind === "ready" && (
        <div className="grid gap-4 md:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            {state.data.workspace.viewer_role === "viewer" && (
              <div className="border-y border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900 sm:rounded-xl sm:border">
                You can view this workspace, but approvals and plan changes need a Shopify email linked to a Zavi owner, admin or member.
              </div>
            )}
            {state.data.billing.tier === "free" && <FreePlanBanner pricing={state.data.pricing} plansUrl={state.data.billing.manage_url} onPlans={() => document.getElementById("shopify-plan-card")?.scrollIntoView({ behavior: "smooth", block: "start" })} />}
            <StatusCard data={state.data} />
            <MetricsCard data={state.data} />
            <ApprovalsCard
              rows={state.data.approvals.rows}
              allApprovalsUrl={`${ZAVI_APP_URL}/approvals`}
              onDecide={(row, decision) => decideAppHomeApproval(row.id, decision)}
            />
          </div>
          <div className="space-y-4">
            <PlanCard data={state.data} onSubscribe={startShopifyBilling} />
          </div>
        </div>
      )}
    </main>
  );
}
