import { writeStoredTenant } from "@/lib/browser-tenant";
import { decodeActiveTenantClaim } from "@/lib/ensure-tenant-claim";
import { createBrowserSupabase } from "@/lib/supabase";
import { oauthConsentNext } from "@/lib/safe-next";
import { HOME_AGENT_SLUG, workspaceAgentHref } from "@/lib/workspace/tabUrl";
import { markSetupExpected } from "@/components/workspace/setup/setupState";

const WORKSPACE_DEST = workspaceAgentHref(HOME_AGENT_SLUG);

export async function goToWorkspaceWithFreshClaim(
  newTenantId?: string,
  dest: string = WORKSPACE_DEST,
  tab?: Window | null,
) {
  const supabase = createBrowserSupabase();
  try {
    const current = await supabase.auth.getSession();
    const session = current.data.session;
    const currentClaim = session?.access_token
      ? decodeActiveTenantClaim(session.access_token)
      : null;
    const { data } = currentClaim === newTenantId && newTenantId
      ? current
      : await supabase.auth.refreshSession();
    const claim = data?.session?.access_token
      ? decodeActiveTenantClaim(data.session.access_token)
      : null;
    const chosen = newTenantId ?? claim;
    if (chosen) await writeStoredTenant(supabase, chosen);
  } catch {}
  if (dest === WORKSPACE_DEST) markSetupExpected();
  const consent = tab ? null : oauthConsentNext(new URLSearchParams(window.location.search).get("next"));
  if (tab) tab.location.href = dest;
  else window.location.replace(consent ?? dest);
}
