"use client";

import { useEffect, useRef, useState } from "react";
import { CHANNEL_SETTINGS_CHANGED_EVENT } from "@/lib/workspace/onTabReturn";
import { useRereadWhileFailed } from "./useRereadWhileFailed";
import { cn } from "@/lib/cn";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { getEmailTestLists, EMAIL_FOOTER_SAVED_EVENT, SENDGRID_CONNECTED_EVENT, type EmailTestListsView, type TestListRouteView } from "@/lib/workspace/emailCampaignSettingsApi";
import { getSendingDomain, type SendingDomainState } from "@/lib/workspace/emailBulkApi";
import { loadFooterPostal, postalAddressProblem } from "./postalAddress";
import { gotoEmailSettings, type EmailSettingsSection } from "./emailSettingsNav";

export type SendBlocker = { id: string; text: string; fix: string; section: EmailSettingsSection };

const ROUTE_NAME: Record<string, string> = { sendgrid: "SendGrid", mailchimp: "Mailchimp", klaviyo: "Klaviyo" };

export type BlockerInputs = {
  postal: string | null;
  domain: SendingDomainState | null;
  tools: EmailTestListsView | null;
};

const canSend = (r: TestListRouteView) => r.status === "complete" || r.status === "partial";
const couldNotRead = (r: TestListRouteView) => r.route !== "zavi_list" && r.status === "unreadable" && !/rejected the key/i.test(r.error ?? "");

const domainReadsAnswered = ({ domain, tools }: Pick<BlockerInputs, "domain" | "tools">) => !!domain && !!tools && Array.isArray(tools.routes) && domain.domain !== undefined;

export function domainCheckOpen({ domain, tools }: Pick<BlockerInputs, "domain" | "tools">): boolean {
  if (!domainReadsAnswered({ domain, tools })) return true;
  if (domain?.domain?.status === "verified") return false;
  const routes = tools?.routes ?? [];
  if (routes.some((r) => r.route === "klaviyo" && canSend(r))) return routes.some((r) => r.route === "sendgrid" && couldNotRead(r));
  return !routes.some((r) => r.route !== "zavi_list" && canSend(r)) && routes.some(couldNotRead);
}

export function sendBlockers({ postal, domain, tools }: BlockerInputs): SendBlocker[] {
  const out: SendBlocker[] = [];
  if (postal !== null) {
    const problem = postalAddressProblem(postal);
    if (problem === "missing") out.push({ id: "postal", text: "Your email footer has no postal address", fix: "Add it in Footer", section: "footer" });
    if (problem === "placeholder") out.push({ id: "postal", text: "Your postal address is still a placeholder", fix: "Replace it in Footer", section: "footer" });
  }
  const routes = Array.isArray(tools?.routes) ? tools.routes : [];
  const connected = (route: string) => routes.some((r) => r.route === route && canSend(r));
  for (const r of routes) {
    if (r.route === "zavi_list") continue;
    const name = ROUTE_NAME[r.route] ?? r.label;
    if (r.status === "needs_permissions") {
      if (connected("klaviyo") || connected("mailchimp")) continue;
      out.push({ id: `key:${r.route}`, text: `${name}'s saved key is missing permissions campaigns need`, fix: "Reconnect in Sending", section: "sending" });
      continue;
    }
    if (r.status !== "unreadable" || !r.error || !/rejected the key/i.test(r.error)) continue;
    out.push({ id: `key:${r.route}`, text: `${name} rejected the key Zavi has saved`, fix: "Reconnect in Sending", section: "sending" });
  }
  if (!domainReadsAnswered({ domain, tools })) return out;
  const open = domainCheckOpen({ domain, tools });
  const d = domain?.domain ?? null;
  const suggested = domain?.suggested_domain ?? null;
  const klaviyoNeedsDomain = connected("klaviyo") && !connected("sendgrid");
  const domainOptional = routes.some((r) => r.route !== "zavi_list" && r.route !== "klaviyo" && canSend(r));
  if (d && d.status !== "verified" && (!domainOptional || klaviyoNeedsDomain || connected("zavi_list"))) {
    out.push({
      id: "domain",
      text: d.status === "failed" ? `${d.domain} failed its DNS check` : `${d.domain} is not verified yet`,
      fix: "Verify it in Sending",
      section: "sending",
    });
  } else if (!d && !open && !routes.some((r) => r.route !== "zavi_list" && canSend(r))) {
    if (suggested) out.push({ id: "domain", text: `${suggested} is saved but not verified yet`, fix: "See it in Sending", section: "sending" });
    else out.push({ id: "domain", text: "No sending domain yet, so Zavi can't send to your lists", fix: "Add one in Sending", section: "sending" });
  }
  if (klaviyoNeedsDomain && !open && d?.status !== "verified" && !out.some((b) => b.id === "domain")) {
    out.push({
      id: "klaviyo-domain",
      text: "Klaviyo test emails need a verified sending domain or SendGrid",
      fix: "Verify it in Sending",
      section: "sending",
    });
  }
  return out;
}

const orNull = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

let blockersSeen = false;
export const forgetBlockersSeen = () => {
  blockersSeen = false;
};

export function EmailSendBlockers() {
  const [items, setItems] = useState<SendBlocker[]>([]);
  const [unchecked, setUnchecked] = useState(false);
  const [tryN, setTryN] = useState(0);
  const [cold] = useState(!blockersSeen);
  const reading = useRef(false);

  useEffect(() => {
    let live = true;
    reading.current = true;
    Promise.all([loadFooterPostal(), orNull(getSendingDomain()), orNull(getEmailTestLists({ fresh: tryN > 0 }))]).then(([postal, domain, tools]) => {
      if (!live) return;
      reading.current = false;
      setUnchecked(postal === null || domainCheckOpen({ domain, tools }));
      setItems(sendBlockers({ postal, domain, tools }));
    });
    return () => {
      live = false;
    };
  }, [tryN]);

  useEffect(() => {
    const again = () => setTryN((v) => v + 1);
    window.addEventListener(EMAIL_FOOTER_SAVED_EVENT, again);
    window.addEventListener(SENDGRID_CONNECTED_EVENT, again);
    window.addEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, again);
    return () => {
      window.removeEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, again);
      window.removeEventListener(EMAIL_FOOTER_SAVED_EVENT, again);
      window.removeEventListener(SENDGRID_CONNECTED_EVENT, again);
    };
  }, []);

  useRereadWhileFailed(unchecked, () => {
    if (!reading.current) setTryN((v) => v + 1);
  });

  useEffect(() => {
    if (items.length > 0) blockersSeen = true;
  }, [items.length]);

  if (items.length === 0 && !unchecked) return null;
  return (
    <section aria-labelledby="email-send-blockers-title" data-testid="email-send-blockers" className={cn("mt-8 overflow-hidden rounded-2xl border border-rule bg-white", cold && "animate-fade-in motion-reduce:animate-none")}>
      <h2 id="email-send-blockers-title" className="flex items-center gap-2 border-b border-rule px-4 py-3 text-[14px] font-semibold leading-5 text-ink">
        <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-danger" />
        Before you send
      </h2>
      <ul className="divide-y divide-rule">
        {items.map((b) => (
          <li key={b.id} data-testid="email-send-blocker" data-blocker={b.id}>
            <button
              type="button"
              onClick={() => gotoEmailSettings(b.section)}
              className="flex min-h-[48px] w-full cursor-pointer flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 py-2.5 text-left text-[13.5px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/30"
            >
              <span className="flex min-w-0 items-center gap-2.5 text-ink">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
                {b.text}
              </span>
              <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-inkMuted">
                {b.fix}
                <ChevronRight aria-hidden className="h-3.5 w-3.5" />
              </span>
            </button>
          </li>
        ))}
        {unchecked && (
          <li data-testid="email-send-blockers-unchecked" className="flex min-h-[48px] flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 py-2.5 text-[13.5px] leading-5">
            <span role="alert" className="flex min-w-0 items-center gap-2.5 text-ink">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
              Zavi could not check everything that can stop a send
            </span>
            <button type="button" onClick={() => setTryN((v) => v + 1)} className="inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg border border-rule bg-white px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:border-inkLight hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30">
              Try again
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}
