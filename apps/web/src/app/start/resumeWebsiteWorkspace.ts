import { createBrowserSupabase } from "@/lib/supabase";
import { creatorApi } from "@/lib/creator/api";
import { checkCanAddCompany } from "@/lib/gatekeeper";
import { decodeActiveTenantClaim, refreshSessionUntilClaim } from "@/lib/ensure-tenant-claim";
import { urlAttribution } from "@/lib/marketing/liveFrom";
import { onboardingLoginHref, START_ROUTE, websiteSignupNext, WORKSPACE_ROUTE } from "@/lib/onboardingRoutes";
import { websiteHost } from "./websiteHost";
import { provisionWebsite } from "./provisionWebsite";
import { clearWebsiteActivationIntent, hasWebsiteActivationIntent, readWebsiteWorkspace, saveWebsiteActivationIntent, saveWebsiteWorkspace } from "./websiteWorkspaceStorage";
import { emailStartCard } from "./startCardEmail";
import { WebsiteSessionExpired } from "./websiteRequest";
import { SCAN_PARAM } from "./websiteScan";

const inFlight = new Map<string, Promise<string>>();
export type WebsiteWorkspace = { tenantId: string; userId: string; host: string; additional: boolean };

export async function claimWebsiteWorkspace(tenantId: string) {
  const supabase = createBrowserSupabase();
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new WebsiteSessionExpired();
  if (decodeActiveTenantClaim(data.session.access_token) === tenantId) return;
  if (!(await refreshSessionUntilClaim(supabase, tenantId))) {
    throw new Error("Couldn't switch your session to the new workspace. Please try again.");
  }
}

export async function resumeWebsiteWorkspace(query: string, replace: (href: string) => void): Promise<WebsiteWorkspace | null> {
  const params = new URLSearchParams(query);
  const host = websiteHost(params.get("website") ?? "");
  if (!host) { replace(START_ROUTE); return null; }
  const additional = params.get("new") === "1";
  const { data } = await createBrowserSupabase().auth.getSession();
  if (!data.session) {
    replace(onboardingLoginHref(websiteSignupNext(host, params)));
    return null;
  }
  const userId = data.session.user.id;
  const key = `${userId}:${host}:${additional}`;
  const saved = readWebsiteWorkspace(userId, host, additional);
  let tenantId = saved;
  if (!tenantId) {
    let request = inFlight.get(key);
    if (!request) {
      request = (async () => {
        const home = await creatorApi.home();
        const recoveringActivation = hasWebsiteActivationIntent(userId, host, additional);
        if (!recoveringActivation && home.has_company && (!additional || !(await checkCanAddCompany()))) {
          return "";
        }
        const id = await provisionWebsite(host, additional, urlAttribution(params), () =>
          saveWebsiteActivationIntent(userId, host, additional), params.get(SCAN_PARAM));
        saveWebsiteWorkspace(userId, host, additional, id);
        clearWebsiteActivationIntent(userId, host, additional);
        void emailStartCard({ startCardId: params.get("card"), startCardSite: host });
        return id;
      })();
      inFlight.set(key, request);
      void request.finally(() => inFlight.delete(key)).catch(() => undefined);
    }
    tenantId = await request;
  }
  if (!tenantId) { replace(WORKSPACE_ROUTE); return null; }
  await claimWebsiteWorkspace(tenantId);
  return { tenantId, userId, host, additional };
}
