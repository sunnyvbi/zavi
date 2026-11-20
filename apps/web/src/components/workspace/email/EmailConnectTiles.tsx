"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";
import { startComposioConnect } from "@/app/connectors/composioConnect";
import { getEmailTestLists, readFailureMessage, SENDGRID_CONNECTED_EVENT, type EmailTestListsView } from "@/lib/workspace/emailCampaignSettingsApi";
import { SendgridKeyForm } from "../settings/SendgridKeyForm";
import { ActionModal } from "../actions/topActions/ActionModal";
import { EmailSendBlockers } from "./EmailSendBlockers";
import { CHANNEL_SETTINGS_CHANGED_EVENT } from "@/lib/workspace/onTabReturn";
import { useRereadWhileFailed } from "./useRereadWhileFailed";

type ToolId = "mailchimp" | "klaviyo" | "gmail" | "sendgrid";
export type ToolState = "connected" | "attention" | "off";

export const EMAIL_TOOLS: ReadonlyArray<{ id: ToolId; name: string; logo: string; tile: string }> = [
  { id: "mailchimp", name: "Mailchimp", logo: "/logos/mailchimp-icon.svg", tile: "bg-[#ffe01b]" },
  { id: "klaviyo", name: "Klaviyo", logo: "/logos/klaviyo-icon.svg", tile: "bg-[#232426] ring-1 ring-inset ring-[#3a3a3c]" },
  { id: "gmail", name: "Gmail", logo: "/logos/gmail-icon.svg", tile: "" },
  { id: "sendgrid", name: "SendGrid", logo: "/logos/sendgrid-icon.svg", tile: "" },
];

export function toolStates(view: Partial<EmailTestListsView> | null | undefined): Map<ToolId, ToolState> {
  const out = new Map<ToolId, ToolState>();
  const raw = view?.routes;
  const routes = Array.isArray(raw) ? raw : [];
  for (const r of routes) {
    if (r.route === "zavi_list") continue;
    out.set(r.route, r.status === "complete" || r.status === "partial" ? "connected" : r.status === "unreadable" || r.status === "needs_permissions" ? "attention" : "off");
  }
  const gmail = view?.gmail?.status;
  out.set("gmail", gmail === "connected" ? "connected" : gmail === "unreadable" ? "attention" : "off");
  return out;
}

export type ToolIssue = "rejected" | "unreadable" | "permissions";

export function toolIssues(view: Partial<EmailTestListsView> | null | undefined): Map<ToolId, ToolIssue> {
  const out = new Map<ToolId, ToolIssue>();
  const raw = view?.routes;
  const routes = Array.isArray(raw) ? raw : [];
  for (const r of routes) {
    if (r.route === "zavi_list") continue;
    if (r.status === "needs_permissions") out.set(r.route, "permissions");
    if (r.status !== "unreadable") continue;
    out.set(r.route, r.error && /rejected the key/i.test(r.error) ? "rejected" : "unreadable");
  }
  if (view?.gmail?.status === "unreadable") out.set("gmail", "unreadable");
  return out;
}

type Known = { states: Map<ToolId, ToolState>; issues: Map<ToolId, ToolIssue> };

let lastKnown: Known | null = null;
export const forgetConnected = () => {
  lastKnown = null;
};

const ISSUE_TEXT: Record<ToolIssue, string> = { rejected: "Key rejected", unreadable: "Can't reach", permissions: "Needs permissions" };

function label(name: string, id: ToolId, state: ToolState | null, issue: ToolIssue | null, checking: boolean, unknown: boolean): string {
  if (checking) return `${name}, checking connection`;
  if (unknown) return `${name}, connection status unknown`;
  if (state === "connected") return `${name}, connected. Reconnect ${name}`;
  if (state === "attention") {
    if (issue === "rejected") return `${name} needs attention: key rejected. Reconnect ${name}`;
    if (issue === "permissions") return `${name} needs permissions: the saved key is missing campaign permissions. Reconnect ${name}`;
    return `${name} needs attention: couldn't reach it. Reconnect ${name}`;
  }
  return `Connect ${name}`;
}


export function EmailConnectTiles({ withBlockers = false }: { withBlockers?: boolean }) {
  return (
    <>
      {withBlockers && <EmailSendBlockers />}
      <ConnectTiles />
    </>
  );
}

function ConnectTiles() {
  const [known, setKnown] = useState<Known | null>(lastKnown);
  const [cold] = useState(lastKnown === null);
  const [readError, setReadError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [sendgrid, setSendgrid] = useState(false);
  const [tryN, setTryN] = useState(0);
  const fresh = useRef(false);
  const quiet = useRef(false);

  const read = useCallback(() => setTryN((n) => n + 1), []);
  const reread = useCallback(() => {
    fresh.current = true;
    setTryN((n) => n + 1);
  }, []);
  useRereadWhileFailed(readError !== null, () => {
    quiet.current = true;
    setTryN((n) => n + 1);
  });

  useEffect(() => {
    let live = true;
    if (!quiet.current) setReadError(null);
    quiet.current = false;
    const forced = fresh.current;
    fresh.current = false;
    getEmailTestLists({ fresh: forced })
      .then((r) => {
        if (!live) return;
        const next = { states: toolStates(r), issues: toolIssues(r) };
        lastKnown = next;
        registerSessionScopedCache(forgetConnected);
        setKnown(next);
        setReadError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        forgetConnected();
        setKnown(null);
        setReadError(readFailureMessage(e, "Could not check which tools are connected."));
      });
    return () => {
      live = false;
    };
  }, [tryN]);

  useEffect(() => {
    window.addEventListener(SENDGRID_CONNECTED_EVENT, read);
    window.addEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, read);
    return () => {
      window.removeEventListener(SENDGRID_CONNECTED_EVENT, read);
      window.removeEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, read);
    };
  }, [read]);

  const states = known?.states ?? null;
  const issueOf = (id: ToolId): ToolIssue | null => (states?.get(id) === "attention" ? (known?.issues.get(id) ?? "unreadable") : null);

  const anyConnected = states !== null && Array.from(states.values()).includes("connected");

  const open = (id: ToolId) => {
    setConnectError(null);
    if (id === "sendgrid") {
      setSendgrid(true);
      return;
    }
    startComposioConnect(id).catch((e: Error) => setConnectError(e.message || "Could not start the connection. Try again."));
  };

  const errors = (
    <>
      {readError && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
          {readError}
          <button type="button" className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-rule bg-white px-2.5 text-[12px] font-medium text-ink transition-colors hover:border-inkLight hover:bg-creamDeep" onClick={reread}>
            Try again
          </button>
        </p>
      )}
      {connectError && (
        <p role="alert" className="text-[13px] text-danger">
          {connectError}
        </p>
      )}
    </>
  );

  return (
    <section aria-labelledby="email-connect-title" data-testid="email-connect" data-mode="tiles" className="mt-10 flex flex-col gap-3">
      <h2 id="email-connect-title" className="text-[18px] font-semibold leading-6 tracking-tight text-ink">
        {anyConnected ? "Your email tools" : "Connect your email tool"}
      </h2>
      <div className="grid grid-cols-2 gap-3 [@container(max-width:400px)]:grid-cols-1 [@container(min-width:720px)]:grid-cols-4">
        {EMAIL_TOOLS.map((t) => {
          const isKnown = states !== null;
          const state = states?.get(t.id) ?? (isKnown ? "off" : null);
          const issue = issueOf(t.id);
          const checking = !isKnown && !readError;
          const unknown = !isKnown && !!readError;
          return (
            <button
              key={t.id}
              type="button"
              data-testid={`email-connect-${t.id}`}
              data-state={state ?? undefined}
              data-issue={issue ?? undefined}
              aria-label={label(t.name, t.id, state, issue, checking, unknown)}
              aria-busy={checking}
              disabled={unknown}
              onClick={() => open(t.id)}
              className="relative flex min-h-[56px] items-center gap-2.5 cursor-pointer rounded-2xl border border-rule bg-white py-3 pl-3 pr-8 text-left transition-colors hover:border-inkLight hover:bg-creamDeep disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", t.tile)}>
                <img src={t.logo} alt="" className={t.tile ? "h-[19px] w-[19px]" : "h-6 w-6"} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold leading-tight text-ink">{t.name}</span>
                {checking ? (
                  <span aria-hidden data-testid={`email-connect-${t.id}-checking`} className="mt-1 block h-3 w-16 animate-pulse rounded-md bg-creamDeep motion-reduce:animate-none" />
                ) : unknown ? null : (
                  <span
                    data-testid={`email-connect-${t.id}-state`}
                    className={cn(
                      "flex items-center gap-1 whitespace-nowrap text-[11px] leading-4",
                      state === "connected" ? "text-success" : state === "attention" ? "text-danger" : "text-inkMuted",
                      cold && "animate-fade-in motion-reduce:animate-none",
                    )}
                  >
                    {state === "connected" && <Check aria-hidden className="h-3 w-3 shrink-0" />}
                    {state === "attention" && <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" />}
                    {state === "connected" ? "Connected" : issue ? ISSUE_TEXT[issue] : "Connect"}
                  </span>
                )}
                {t.id === "gmail" && !checking && !unknown && <span data-testid="email-connect-gmail-scope" title="One-to-one emails only" className="block truncate text-[11px] leading-4 text-inkMuted">One-to-one emails only</span>}
              </span>
              {isKnown && <ArrowUpRight aria-hidden className={cn("absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-inkMuted", cold && "animate-fade-in motion-reduce:animate-none")} />}
            </button>
          );
        })}
      </div>
      {errors}
      {sendgrid && (
        <ActionModal eyebrow="Email campaigns" title="Connect SendGrid" sub="Paste a SendGrid API key. Zavi sends to your SendGrid lists only after you approve each email." onClose={() => setSendgrid(false)} size="md" hideClose>
          <SendgridKeyForm
            onClose={() => setSendgrid(false)}
            onConnected={reread}
          />
        </ActionModal>
      )}
    </section>
  );
}
