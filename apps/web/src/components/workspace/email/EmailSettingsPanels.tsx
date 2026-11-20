"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { useRereadWhileFailed } from "./useRereadWhileFailed";
import { Skeleton } from "../Skeleton";
import { PostedPinsBlock } from "../pinterest/PostedPinsBlock";
import type { OverviewPanelId, SettingsBadgeId, SettingsPanelId } from "../actions/types";
import { getLearnings, LEARNINGS_SEEN_EVENT, unseenCount } from "@/lib/workspace/emailLearningsApi";
import { SentEmailsBlock } from "./SentEmailsBlock";
import { EmailComingUpBlock } from "./EmailComingUpBlock";
import { EmailContactsSection } from "./EmailContactsSection";
import { EmailFooterSection } from "./EmailFooterSection";
import { EmailConnectTiles, EMAIL_TOOLS } from "./EmailConnectTiles";
import { askedEmailSettingsSection, clearAskedEmailSettingsSection, EMAIL_SETTINGS_GOTO_EVENT, emailSettingsAnchor, type EmailSettingsSection } from "./emailSettingsNav";
import { SendingDomainBlock } from "./SendingDomainBlock";
import { getSendingDomain } from "@/lib/workspace/emailBulkApi";
import { connectToolHref, EmailAutoSendBlock, EmailSendgridBlock, EmailTemplateBlock } from "./EmailCampaignSettingsBlocks";
import { getEmailTestLists, readFailureMessage, SENDGRID_CONNECTED_EVENT, type TestListRouteView } from "@/lib/workspace/emailCampaignSettingsApi";
import { EmailTestListsBlock, TEST_LIST_COPY, toolProblemLine } from "./EmailTestListsBlock";
import { EmailLearningsBlock } from "./EmailLearningsBlock";
import { WriteBriefBlock } from "../ugc/WriteBriefBlock";
import { CONNECTORS_PAGE } from "@/app/connectors/ConnectButton";

type RouteId = TestListRouteView["route"];
const PROVIDERS: readonly RouteId[] = ["sendgrid", "mailchimp", "klaviyo"];
const PROVIDER_NAME: Record<string, string> = { sendgrid: "SendGrid", mailchimp: "Mailchimp", klaviyo: "Klaviyo" };
const ROUTE_PANELS: readonly SettingsPanelId[] = ["email_sendgrid", "email_sending_domain", "email_contact_lists"];

function useEmailRoutes(wanted: boolean): {
  routes: TestListRouteView[] | null;
  error: string | null;
  retry: () => void;
} {
  const [routes, setRoutes] = useState<TestListRouteView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const read = (fresh: boolean) => {
      getEmailTestLists({ fresh })
        .then((r) => {
          if (!live) return;
          setError(null);
          setRoutes(Array.isArray(r?.routes) ? r.routes : []);
        })
        .catch((readError: unknown) => {
          if (!live) return;
          setRoutes(null);
          setError(readFailureMessage(readError, SENDING_COPY.readFailed));
        });
    };
    read(attempt > 0);
    const again = () => read(false);
    window.addEventListener(SENDGRID_CONNECTED_EVENT, again);
    return () => {
      live = false;
      window.removeEventListener(SENDGRID_CONNECTED_EVENT, again);
    };
  }, [attempt, wanted]);
  useRereadWhileFailed(error !== null, retry);
  return { routes, error, retry };
}

const ROW = "grid gap-2 p-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-6";
const ROW_LABEL = "text-[13px] font-medium leading-5 text-ink sm:pt-1.5";
const TEXT_BTN =
  "inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg border border-rule bg-white px-2.5 text-[12px] font-medium text-ink transition-colors hover:border-inkLight hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30";

export const SENDING_COPY = {
  label: "Email tool",
  working: "Sends your campaigns",
  zavi: "Sends to the lists in Contacts",
  unreadable: "Can't reach it right now",
  keyRejected: "Its key stopped working",
  keyPermissions: "Its key is missing permissions campaigns need",
  retry: "Try again",
  readFailed: "Could not check which email tool sends your campaigns.",
  reconnect: "Reconnect",
  connectLead: "Already use Mailchimp, Klaviyo or SendGrid?",
  connect: "Connect it",
  domainLabel: "Sending domain",
  domainOptional: "Only needed when Zavi sends for you.",
  domainSetUp: "Set up",
} as const;

type ToolProblem = { name: string; kind: "unreadable" | "key" | "permissions" };
type ToolRow = { name: string; status: string; dot: string; problem?: ToolProblem["kind"] };

function RouteLogo({ name }: { name: string }) {
  const tool = EMAIL_TOOLS.find((t) => t.name === name);
  return (
    <span aria-hidden className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", tool?.tile)}>
      <img src={tool?.logo ?? "/zavi-icon.svg"} alt="" className={tool?.tile ? "h-[17px] w-[17px]" : "h-[22px] w-[22px]"} />
    </span>
  );
}

function RouteBlock({
  providers,
  zavi,
  loading,
  error,
  problems,
  onRetry,
}: {
  providers: RouteId[];
  zavi: boolean;
  loading: boolean;
  error: string | null;
  problems: ToolProblem[];
  onRetry: () => void;
}) {
  const names = providers.map((p) => PROVIDER_NAME[p] ?? p);
  const noTool = names.length === 0 && problems.length === 0;
  const rows: ToolRow[] = [
    ...names.map((name) => ({ name, status: SENDING_COPY.working, dot: "bg-mintDeep" })),
    ...(zavi || noTool ? [{ name: "Zavi", status: SENDING_COPY.zavi, dot: zavi ? "bg-mintDeep" : "bg-inkLight" }] : []),
    ...problems.map((p) => ({
      name: p.name,
      status: p.kind === "key" ? SENDING_COPY.keyRejected : p.kind === "permissions" ? SENDING_COPY.keyPermissions : SENDING_COPY.unreadable,
      dot: "bg-danger",
      problem: p.kind,
    })),
  ];
  return (
    <section aria-labelledby="email-route-title" data-testid="email-route" className={ROW}>
      <h3 id="email-route-title" className={ROW_LABEL}>
        {SENDING_COPY.label}
      </h3>
      <div className="min-w-0">
        {error ? (
          <p role="alert" className="flex min-h-[40px] flex-wrap items-center gap-x-3 text-[13px] text-danger">
            <span className="min-w-0">{error}</span>
            <button type="button" onClick={onRetry} className={TEXT_BTN}>
              {SENDING_COPY.retry}
            </button>
          </p>
        ) : loading ? (
          <div className="flex min-h-[40px] items-center">
            <Skeleton className="h-5 w-[60%]" />
          </div>
        ) : (
          <>
            <ul className="grid gap-2 sm:grid-cols-2">
              {rows.map((row) => (
                <li
                  key={row.name}
                  data-testid={row.problem ? "email-route-problem" : "email-route-tool"}
                  className={cn("flex min-h-[48px] min-w-0 items-center gap-2.5 rounded-xl border border-rule bg-white px-2.5 py-2", row.problem && "sm:col-span-2")}
                >
                  <RouteLogo name={row.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold leading-tight text-ink">{row.name}</span>
                    <span
                      data-testid="email-route-status"
                      className={cn("flex min-w-0 items-center gap-1 text-[11px] leading-4", row.problem ? "text-danger" : row.dot === "bg-mintDeep" ? "text-success" : "text-inkMuted")}
                    >
                      {row.problem ? <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" /> : row.dot === "bg-mintDeep" ? <Check aria-hidden className="h-3 w-3 shrink-0" /> : null}
                      <span className="min-w-0 break-words sm:truncate">{row.status}</span>
                    </span>
                  </span>
                  {row.problem === "unreadable" && (
                    <button type="button" onClick={onRetry} className={`ml-auto ${TEXT_BTN}`}>
                      {SENDING_COPY.retry}
                    </button>
                  )}
                  {(row.problem === "key" || row.problem === "permissions") && (
                    <a href={connectToolHref(row.name)} className={`ml-auto ${TEXT_BTN}`}>
                      {SENDING_COPY.reconnect}
                    </a>
                  )}
                </li>
              ))}
            </ul>
            {noTool && (
              <p className="mt-2 text-[13px] text-inkMuted">
                {SENDING_COPY.connectLead}{" "}
                <a href={CONNECTORS_PAGE} className="font-medium text-ink underline underline-offset-2">
                  {SENDING_COPY.connect}
                </a>
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function OptionalDomain({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (open) return <>{children}</>;
  return (
    <section aria-labelledby="email-domain-optional-title" className={ROW}>
      <h3 id="email-domain-optional-title" className={ROW_LABEL}>
        {SENDING_COPY.domainLabel}
      </h3>
      <div className="flex min-h-[32px] min-w-0 flex-wrap items-center gap-x-3 text-[13px] text-inkMuted">
        <span className="min-w-0">{SENDING_COPY.domainOptional}</span>
        <button type="button" aria-expanded={open} onClick={() => setOpen(true)} className={TEXT_BTN}>
          {SENDING_COPY.domainSetUp}
        </button>
      </div>
    </section>
  );
}

function panel(id: SettingsPanelId) {
  return id === "email_sending_domain" ? (
    <SendingDomainBlock key={id} />
  ) : id === "email_contact_lists" ? (
    <EmailContactsSection key={id} />
  ) : id === "email_sendgrid" ? (
    <EmailSendgridBlock key={id} />
  ) : id === "email_template" ? (
    <EmailTemplateBlock key={id} />
  ) : id === "email_auto_send" ? (
    <EmailAutoSendBlock key={id} />
  ) : id === "email_test_lists" ? (
    <EmailTestListsBlock key={id} />
  ) : id === "email_learnings" ? (
    <EmailLearningsBlock key={id} />
  ) : id === "email_footer" ? (
    <EmailFooterSection key={id} />
  ) : id === "ugc_write_brief" ? (
    <WriteBriefBlock key={id} />
  ) : null;
}

type Section = { key: EmailSettingsSection; label: string; titled: boolean; ownsAnchor?: boolean; body: React.ReactNode };

function SettingsBox({ section }: { section: Section }) {
  const titleId = `${emailSettingsAnchor(section.key)}-title`;
  if (!section.titled) {
    return (
      <section data-settings-section={section.key} className={section.ownsAnchor ? "min-w-0 scroll-mt-6" : "min-w-0 scroll-mt-6 rounded-2xl border border-ca-border bg-ca-bg p-4"}>
        {!section.ownsAnchor && <span id={emailSettingsAnchor(section.key)} className="block scroll-mt-6" aria-hidden />}
        {section.body}
      </section>
    );
  }
  return (
    <section
      id={emailSettingsAnchor(section.key)}
      aria-labelledby={titleId}
      data-settings-section={section.key}
      className="min-w-0 scroll-mt-6 overflow-hidden rounded-2xl border border-ca-border bg-ca-bg"
    >
      <h2 id={titleId} className="px-4 pt-4 text-ca-title font-semibold text-ca-xdark">{section.label}</h2>
      <div className="divide-y divide-ca-border [&>*]:!px-4">{section.body}</div>
    </section>
  );
}

export type EmailConnectionView = { known: boolean; connected: boolean; account: string | null; tool: boolean };

export function ChannelSettingsPanels({ panels, extra = null, below = null, lead = null }: {
  panels: readonly SettingsPanelId[];
  extra?: React.ReactNode;
  below?: React.ReactNode;
  lead?: ((connection: EmailConnectionView) => React.ReactNode) | null;
}) {
  const has = (id: SettingsPanelId) => panels.includes(id);
  const routed = panels.some((id) => ROUTE_PANELS.includes(id));
  const routeState = useEmailRoutes(routed);
  const hostRef = useRef<HTMLDivElement>(null);
  const routes = routeState.routes;
  const hasExtra = extra !== null && extra !== undefined && extra !== false;
  const domain = useVerifiedDomain(routed);

  const providers = PROVIDERS.filter((p) => routes?.some((r) => r.route === p && (r.status === "complete" || r.status === "partial")));
  const routeProblems = (routes ?? [])
    .filter((route) => PROVIDERS.includes(route.route) && ((route.status === "unreadable" && route.error) || route.status === "needs_permissions"))
    .map((route): ToolProblem => ({
      name: PROVIDER_NAME[route.route] ?? route.label,
      kind: route.status === "needs_permissions" ? "permissions" : toolProblemLine(route.status, route.error) === TEST_LIST_COPY.keyRejected ? "key" : "unreadable",
    }));
  const zaviLists = routes?.find((r) => r.route === "zavi_list")?.lists.length ?? 0;
  const providerReadComplete = PROVIDERS.every((provider) => routes?.some((route) => route.route === provider && route.status !== "unreadable" && route.status !== "needs_permissions"));
  const zavi = zaviLists > 0 || (providerReadComplete && providers.length === 0);
  const zaviSetup = zaviLists > 0 || providers.length === 0 || providers.includes("klaviyo");
  const known = routes !== null && routeState.error === null;
  const toolNames = providers.map((p) => PROVIDER_NAME[p] ?? p);
  const connection: EmailConnectionView = {
    known: known && domain !== undefined,
    connected: toolNames.length > 0 || Boolean(domain),
    account: domain ?? (toolNames.length > 0 ? toolNames.join(", ") : null),
    tool: toolNames.length > 0,
  };

  const sections: Section[] = [];
  if (has("email_contact_lists")) sections.push({ key: "contacts", label: "Contacts", titled: false, body: panel("email_contact_lists") });
  const domainPanel = <SendingDomainBlock key="email_sending_domain" toolsPending={!known} />;
  const sending = (
    <>
      {routed && (
        <RouteBlock
          providers={providers}
          zavi={zavi}
          loading={!known && routeState.error === null}
          error={routeState.error}
          problems={routeProblems}
          onRetry={routeState.retry}
        />
      )}
      {known && has("email_sendgrid") && providers.includes("sendgrid") && panel("email_sendgrid")}
      {routeState.error === null && has("email_sending_domain") && (known && !zaviSetup ? <OptionalDomain>{domainPanel}</OptionalDomain> : domainPanel)}
    </>
  );
  if (routed) sections.push({ key: "sending", label: "Sending", titled: true, body: sending });
  if (has("email_footer")) sections.push({ key: "footer", label: "Footer", titled: false, ownsAnchor: true, body: panel("email_footer") });
  const autopilot = [has("email_auto_send") && panel("email_auto_send"), has("email_test_lists") && routeState.error === null && panel("email_test_lists")].filter(Boolean);
  if (autopilot.length > 0) sections.push({ key: "autopilot", label: has("email_auto_send") ? "Autopilot" : "Test lists", titled: true, body: <>{autopilot}</> });
  if (has("email_template")) sections.push({ key: "brand", label: "Brand", titled: true, body: panel("email_template") });
  if (has("ugc_write_brief")) sections.push({ key: "brief", label: "Brief", titled: false, body: panel("ugc_write_brief") });
  if (hasExtra || has("email_learnings")) {
    sections.push({
      key: "notes",
      label: "Zavi's notes",
      titled: true,
      body: (
        <>
          {hasExtra && (
            <div data-testid="email-who-you-email" className="min-w-0 p-5">
              {extra}
            </div>
          )}
          {has("email_learnings") && panel("email_learnings")}
        </>
      ),
    });
  }

  useEffect(() => {
    const go = (section: EmailSettingsSection | null) => {
      if (!section) return;
      requestAnimationFrame(() => document.getElementById(emailSettingsAnchor(section))?.scrollIntoView?.({ block: "start", behavior: "smooth" }));
    };
    go(askedEmailSettingsSection());
    clearAskedEmailSettingsSection();
    const onGoto = (e: Event) => {
      go((e as CustomEvent<{ section?: EmailSettingsSection }>).detail?.section ?? null);
      clearAskedEmailSettingsSection();
    };
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, onGoto);
    return () => window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, onGoto);
  }, []);
  if (panels.length === 0 && !hasExtra && !lead) return null;

  return (
    <div ref={hostRef} data-testid="email-settings" className="flex min-w-0 flex-col gap-6">
      {lead?.(connection)}
      {sections.map((sec) => (
        <SettingsBox key={sec.key} section={sec} />
      ))}
      {below}
    </div>
  );
}

function useVerifiedDomain(wanted: boolean): string | null | undefined {
  const [domain, setDomain] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    getSendingDomain()
      .then((s) => live && setDomain(s?.domain?.status === "verified" ? s.domain.domain : null))
      .catch(() => live && setDomain(null));
    return () => {
      live = false;
    };
  }, [wanted]);
  return domain;
}

export function ChannelOverviewPanels({ panels }: { panels: readonly OverviewPanelId[] }) {
  if (panels.length === 0) return null;
  return (
    <>
      {panels.map((id) =>
        id === "email_connect" ? (
          <EmailConnectTiles key={id} withBlockers />
        ) : id === "email_sent_emails" ? (
          <SentEmailsBlock key={id} />
        ) : id === "email_coming_up" ? (
          <EmailComingUpBlock key={id} />
        ) : id === "pinterest_posted_pins" ? (
          <PostedPinsBlock key={id} />
        ) : null,
      )}
    </>
  );
}

export function useSettingsBadge(id: SettingsBadgeId | undefined): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (id !== "email_learnings_new") return;
    let live = true;
    const read = () =>
      getLearnings()
        .then((v) => live && setN(unseenCount(v)))
        .catch(() => live && setN(0));
    void read();
    window.addEventListener(LEARNINGS_SEEN_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener(LEARNINGS_SEEN_EVENT, read);
    };
  }, [id]);
  return n;
}
