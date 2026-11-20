
import { decisionHome } from "@zavi/shared";

const LOCAL_DEFAULT = "http://localhost:3000";

export function withHttps(raw: string): string {
  const value = raw.trim();
  return value && !value.includes("://") ? `https://${value}` : value;
}

export function webBaseUrl(): string {
  const configured = withHttps(process.env.WEB_BASE_URL ?? "").replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") {
    let origin = "";
    try {
      origin = new URL(configured).origin;
    } catch {}
    if (!origin.startsWith("https://") || origin !== configured) {
      throw new Error(
        `WEB_BASE_URL must be set to an https origin in production (got "${configured}"), e.g. https://www.zaviagent.com`,
      );
    }
    return configured;
  }
  if (configured) return configured;
  if (!warnedLocalDefault) {
    warnedLocalDefault = true;
    console.warn(`[web-base] WEB_BASE_URL is unset outside production; app links in emails and notifications will point at ${LOCAL_DEFAULT}`);
  }
  return LOCAL_DEFAULT;
}

let warnedLocalDefault = false;

export function resetWebBaseWarningForTests(): void {
  warnedLocalDefault = false;
}

export function linksToOwnApp(text: string): boolean {
  let host = "";
  try {
    host = new URL(webBaseUrl()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  if (!host) return false;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`https?://(?:[a-z0-9-]+\\.)*${escaped}(?=[:/?#|>\\s)"']|$)`, "i").test(text);
}

const company = (t?: string | null): string => (t ? `&company=${encodeURIComponent(t)}` : "");

export function growthUrl(tenantId?: string | null): string {
  return `${webBaseUrl()}/workspace?tab=growth-strategy${company(tenantId)}`;
}

export function websiteUrl(tenantId?: string | null): string {
  return `${webBaseUrl()}/workspace?tab=website${company(tenantId)}`;
}

export function needsYouUrl(tenantId?: string | null): string {
  return `${webBaseUrl()}/workspace?tab=needs-you${company(tenantId)}`;
}

export function approvalsUrl(tenantId?: string | null): string {
  return needsYouUrl(tenantId);
}

export function decisionHomeUrl(
  d: { id: string; decision_class: string | null; home_channel?: string | null },
  tenantId?: string | null,
): string {
  const h = decisionHome({ decision_class: d.decision_class ?? "", channel_slug: d.home_channel ?? null });
  if (h.kind === "channel") return channelActionUrl(h.slug, d.id, tenantId);
  return `${h.kind === "growth" ? growthUrl(tenantId) : needsYouUrl(tenantId)}&decision=${encodeURIComponent(d.id)}`;
}

export function channelUrl(slug: string): string {
  return `${webBaseUrl()}/workspace?tab=channels&channel=${encodeURIComponent(slug)}`;
}

export function channelActionUrl(slug: string, actionId: string, tenantId?: string | null): string {
  const company = tenantId ? `&company=${encodeURIComponent(tenantId)}` : "";
  return `${channelUrl(slug)}&action=${encodeURIComponent(actionId)}${company}`;
}

export function channelPageUrl(slug: string, tenantId?: string | null): string {
  const company = tenantId ? `&company=${encodeURIComponent(tenantId)}` : "";
  return `${channelUrl(slug)}${company}`;
}

export function channelLocationsUrl(slug: string, tenantId?: string | null): string {
  const company = tenantId ? `&company=${encodeURIComponent(tenantId)}` : "";
  return `${channelUrl(slug)}&locations=1${company}`;
}

export function buildUrl(runId: string): string {
  return `${webBaseUrl()}/workspace?tab=build&build=${encodeURIComponent(runId)}`;
}

export function settingsUrl(tenantId?: string | null): string {
  const company = tenantId ? `&company=${encodeURIComponent(tenantId)}` : "";
  return `${webBaseUrl()}/workspace?tab=settings${company}`;
}

export function billingUrl(tenantId?: string | null): string {
  return `${settingsUrl(tenantId)}#billing`;
}

export function growthNeedsYouUrl(tenantId?: string | null): string {
  const company = tenantId ? `&company=${encodeURIComponent(tenantId)}` : "";
  return `${webBaseUrl()}/workspace?tab=growth-strategy${company}#growth-needs`;
}

export function plansUrl(): string {
  return `${webBaseUrl()}/pricing`;
}

export function meetUrl(tenantId?: string | null): string {
  return `${webBaseUrl()}/workspace?tab=meet${company(tenantId)}`;
}

export function workspaceUrl(): string {
  return `${webBaseUrl()}/workspace`;
}

export function adBudgetUrl(tenantId: string): string {
  return `${webBaseUrl()}/workspace?tab=growth-strategy&company=${encodeURIComponent(tenantId)}#ad-budget`;
}

export function growthPlanUrl(tenantId: string): string {
  return `${webBaseUrl()}/workspace?tab=growth-strategy&company=${encodeURIComponent(tenantId)}`;
}
