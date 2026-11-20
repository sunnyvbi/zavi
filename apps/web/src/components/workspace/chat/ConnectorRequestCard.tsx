"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  connectInfoFor,
  connectorSettingsPath,
  type ConnectorRequest,
} from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { detectInAppBrowser, externalBrowserLink, watchOpenAttempt } from "@/lib/inAppBrowser";
import { urlTabKindFromParam } from "@/lib/workspace/tabUrl";
import { WORKSPACE_AGENT_SLUG_RE, WORKSPACE_UUID_RE } from "../deepLinkSeed";
import { threadIdFromWorkspacePath, workspaceThreadPath } from "../navigation/workspaceRoutes";
import {
  isRequestSatisfied,
  launchConnect,
  type ConnectorListRow,
} from "@/app/connectors/connectStrategies";

const DISMISS_KEY_PREFIX = "zavi:connector-request-dismissed:";

function readDismissed(requestId: string): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY_PREFIX + requestId) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(requestId: string): void {
  try {
    window.localStorage.setItem(DISMISS_KEY_PREFIX + requestId, "1");
  } catch {
  }
}

type Phase = "pending" | "connected" | "working";

function browserReturnUrl(href: string, companyId?: string, threadId?: string | null): string {
  const current = new URL(href);
  const renderedThread = threadId && WORKSPACE_UUID_RE.test(threadId) ? threadId : null;
  const pathThread = renderedThread ?? threadIdFromWorkspacePath(current.pathname);
  const clean = new URL(pathThread ? workspaceThreadPath(pathThread) : "/workspace", current.origin);
  const company = companyId && WORKSPACE_UUID_RE.test(companyId) ? companyId : current.searchParams.get("company");
  if (company && WORKSPACE_UUID_RE.test(company)) clean.searchParams.set("company", company);
  if (renderedThread) return clean.toString();
  for (const key of ["thread", "chat", "buildThread"]) {
    const value = current.searchParams.get(key);
    if (value && WORKSPACE_UUID_RE.test(value)) clean.searchParams.set(key, value);
  }
  for (const key of ["agent", "channel"]) {
    const value = current.searchParams.get(key);
    if (value && WORKSPACE_AGENT_SLUG_RE.test(value)) clean.searchParams.set(key, value);
  }
  const tab = current.searchParams.get("tab");
  if (urlTabKindFromParam(tab)) clean.searchParams.set("tab", tab!);
  return clean.toString();
}

function ConnectBrowserHelp({companyId, threadId}: {companyId?: string; threadId?: string | null}) {
  const [browser, setBrowser] = useState<{app: string | null; url: string; link: ReturnType<typeof externalBrowserLink>} | null>(null);
  const [manual, setManual] = useState(false);
  const [copied, setCopied] = useState(false);
  const stopWatch = useRef<(() => void) | null>(null);
  useEffect(() => {
    const ua = window.navigator.userAgent;
    const inApp = detectInAppBrowser(ua);
    if (inApp) {
      const url = browserReturnUrl(window.location.href, companyId, threadId);
      setBrowser({app: inApp.app, url, link: externalBrowserLink(url, ua)});
    }
    return () => stopWatch.current?.();
  }, [companyId, threadId]);
  if (!browser) return null;
  return (
    <div className="mt-3 rounded-lg bg-bone p-3 text-[13px] leading-[1.55] text-inkMuted">
      <p>Connections may not open inside {browser.app ? `the ${browser.app} app` : "this app"}. Open this chat in Safari or Chrome, sign in if needed, then connect and press Continue.</p>
      <div className="flex flex-wrap items-center gap-x-4">
        {browser.link && <a href={browser.link.href} className="inline-flex min-h-11 items-center font-medium text-ink underline" onClick={() => {
          setManual(false);
          stopWatch.current?.();
          stopWatch.current = watchOpenAttempt(() => { stopWatch.current = null; setManual(true); });
        }}>{browser.link.label}</a>}
        <button type="button" className="min-h-11 font-medium text-ink underline" onClick={async () => {
          try { await navigator.clipboard.writeText(browser.url); setCopied(true); }
          catch { setManual(true); }
        }}>{copied ? "Link copied" : "Copy link"}</button>
      </div>
      {manual && <p role="status">Copy this link and paste it into Safari or Chrome: <span className="select-all break-all">{browser.url}</span></p>}
    </div>
  );
}

export function continueErrorMessage(code: string | undefined, status: number): string {
  if (code === "plan_upgrade_required") return "Your plan doesn't include this agent.";
  if (code === "viewer_read_only") return "Your role is read-only. Ask a workspace admin to continue.";
  if (code === "not_found" || code === "no_connector_request" || code === "not_continuable") {
    return "This request can't be continued. Ask again in the chat.";
  }
  return `Something went wrong (${code ?? `HTTP ${status}`}). Try again.`;
}

export function ConnectorRequestCard({
  request,
  companyId,
  threadId,
  followedByAssistantRow = false,
}: {
  request: ConnectorRequest;
  companyId?: string;
  threadId?: string | null;
  followedByAssistantRow?: boolean;
}) {
  const info = connectInfoFor(request.slug, request.label) ?? {
    connect: request.connect,
    label: request.label,
    settingsAnchor: null,
  };
  const label = request.label;
  const verb = request.mode === "reconnect" ? "Reconnect" : "Connect";

  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<Phase>("pending");
  const [opening, setOpening] = useState(false);
  const [continueClicked, setContinueClicked] = useState(false);
  const [notYet, setNotYet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outOfCredits, setOutOfCredits] = useState(false);

  useEffect(() => {
    setDismissed(readDismissed(request.request_id));
  }, [request.request_id]);

  const { slug, mode, created_at: createdAt } = request;
  const check = useCallback(async () => {
    try {
      const res = await apiFetch("/api/connectors");
      if (!res.ok) return;
      const body = (await res.json()) as { connectors?: ConnectorListRow[] };
      if (isRequestSatisfied(body.connectors ?? [], { slug, mode, created_at: createdAt })) {
        setPhase((p) => (p === "pending" ? "connected" : p));
      }
    } catch {
    }
  }, [slug, mode, createdAt]);

  useEffect(() => {
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [check]);

  const connect = async () => {
    setOpening(true);
    setError(null);
    setNotYet(false);
    try {
      await launchConnect(request.slug, info);
    } catch (e) {
      setError(`Couldn't open the connection: ${(e as Error).message}`);
    } finally {
      setOpening(false);
    }
  };

  const continueRun = async () => {
    if (continueClicked) return;
    setContinueClicked(true);
    setError(null);
    setOutOfCredits(false);
    setNotYet(false);
    try {
      const res = await apiFetch(
        `/api/chat/connector-requests/${encodeURIComponent(request.run_id)}/continue`,
        { method: "POST" },
      );
      if (res.ok) {
        setPhase("working");
        return;
      }
      const code = await res
        .json()
        .then((b: { error?: unknown }) => {
          const e = b?.error as string | { code?: unknown } | undefined;
          if (typeof e === "string") return e;
          return typeof e?.code === "string" ? e.code : undefined;
        })
        .catch(() => undefined);
      if (res.status === 409 && (code === undefined || code === "not_connected_yet")) {
        setNotYet(true);
        setPhase("pending");
        setContinueClicked(false);
        return;
      }
      setContinueClicked(false);
      if (res.status === 402) {
        setOutOfCredits(true);
        return;
      }
      setError(continueErrorMessage(code, res.status));
    } catch {
      setContinueClicked(false);
      setError("Something went wrong.");
    }
  };

  if (dismissed) return null;

  if (followedByAssistantRow && phase === "working") {
    return (
      <div className="mt-2 text-[13px] text-inkMuted">Connected {label}</div>
    );
  }

  return (
    <div
      data-testid="connector-request-card"
      className="mt-2 rounded-xl border border-ink/10 bg-white p-4 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold text-ink">
            {verb} {label}
          </div>
          {request.reason ? (
            <p className="mt-1 text-[13px] leading-[1.55] text-inkMuted">
              {request.reason}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            writeDismissed(request.request_id);
            setDismissed(true);
          }}
          className="shrink-0 rounded-cta p-1 text-inkMuted transition-colors hover:bg-bone hover:text-ink"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {phase === "pending" && (
          <button
            type="button"
            onClick={() => void connect()}
            disabled={opening}
            className="rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            {opening ? "Opening…" : `${verb} ${label}`}
          </button>
        )}
        {phase === "connected" && (
          <>
            <span className="text-[13px] font-medium text-ink">Connected</span>
            <button
              type="button"
              onClick={() => void continueRun()}
              disabled={continueClicked}
              className="rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
            >
              Continue
            </button>
          </>
        )}
        {phase === "working" && (
          <span role="status" className="text-[13px] text-inkMuted">
            Working on it
          </span>
        )}
        {notYet && (
          <span role="status" className="text-[13px] text-inkMuted">
            Not connected yet
          </span>
        )}
      </div>

      {phase === "pending" && (info.connect === "oauth" || info.connect === "composio") && <ConnectBrowserHelp companyId={companyId} threadId={threadId} />}

      {outOfCredits ? (
        <p role="alert" className="mt-2 text-[12px] text-red-700">
          You&apos;re out of credits.{" "}
          <a href="/workspace?tab=settings#billing" className="underline">
            Top up
          </a>
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-red-700">
          {error}{" "}
          <a href={connectorSettingsPath(info)} className="underline">
            Open Settings
          </a>
        </p>
      ) : null}
    </div>
  );
}
