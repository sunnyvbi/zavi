"use client";

import { useEffect } from "react";
import { COMPOSIO_DONE_CHANNEL } from "../../composioConnect";

const SLUG_RE = /^[a-z0-9_-]{1,64}$/;

const REASONS: Record<string, string> = {
  connection_not_owned: "Composio could not confirm this account for your workspace.",
  invalid_state: "This connect link expired or was already used. Start the connection again from Zavi.",
  missing_state: "This connect link expired or was already used. Start the connection again from Zavi.",
  missing_params: "The approval was cancelled or did not finish.",
  composio_verify_failed: "We couldn't check the connection with Composio just now. Try again in a minute.",
  state_consume_failed: "We couldn't check the connection with Composio just now. Try again in a minute.",
  mcp_sync_failed: "We couldn't save the connection. Try again in a minute.",
  set_composio_app_connection_failed: "We couldn't save the connection. Try again in a minute.",
  unknown_toolkit: "This app can't be connected right now.",
};

function appName(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function one(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

export function ComposioDone({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const raw = one(searchParams.toolkit).trim().toLowerCase();
  const toolkit = SLUG_RE.test(raw) ? raw : "unknown";
  const connected = one(searchParams.status) === "connected";
  const reason = one(searchParams.reason);
  const name = toolkit === "unknown" ? "The app" : appName(toolkit);
  const back = new URLSearchParams({ tab: "settings" });
  if (connected) back.set(`composio_${toolkit}`, "connected");
  else {
    back.set("composio_error", toolkit);
    if (REASONS[reason]) back.set("code", reason);
  }

  useEffect(() => {
    try {
      const ch = new BroadcastChannel(COMPOSIO_DONE_CHANNEL);
      ch.postMessage({ toolkit, status: connected ? "connected" : "error" });
      ch.close();
    } catch {}
    if (connected) window.close();
  }, [toolkit, connected]);

  return (
    <main className="workspace-shell flex min-h-screen items-center justify-center bg-cream px-4 text-ink">
      <div className="max-w-sm text-center">
        <p className="text-base font-medium">{connected ? `${name} is connected.` : `${name} didn't connect.`}</p>
        <p className="mt-2 text-sm text-inkMuted">
          {connected ? "You can close this tab." : `${REASONS[reason] ?? "Something went wrong. Try again from Zavi."} You can close this tab.`}
        </p>
        <a className="mt-4 inline-block text-sm text-ink underline" href={`/workspace?${back.toString()}`}>
          Back to Zavi
        </a>
      </div>
    </main>
  );
}
