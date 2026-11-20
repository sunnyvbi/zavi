import { signupAttribution, type UrlAttribution } from "@/lib/marketing/liveFrom";
import { firstTouchForSignup } from "@/lib/analytics/first-touch";
import { withAffiliateClick } from "@/lib/analytics/affiliate";
import { browserTimeZone } from "@/lib/timezones";
import { inferCompanyName } from "./enrichment-rank";
import { websitePost } from "./websiteRequest";

function setupError(status: number, body: unknown): Error {
  const error = (body as { error?: { code?: string; message?: string } } | null)
    ?.error;
  if (
    error?.code === "multi_workspace_not_enabled" ||
    error?.code === "tenant_limit"
  )
    return new Error(
      error.message ||
        "You can't add another company to this account right now.",
    );
  if (status === 403)
    return new Error(
      "Your account can't create a workspace yet. Check your access and try again.",
    );
  if (status === 429 && error?.code === "workspace_limit")
    return new Error(error.message || "Too many workspaces were created from this network. Please try again later.");
  return new Error(
    "Couldn't set up your workspace. Your website is saved in this link. Please try again.",
  );
}

export async function provisionWebsite(
  host: string,
  additional: boolean,
  attribution: UrlAttribution,
  beforeActivate?: () => string | void,
  scanId: string | null = null,
): Promise<string> {
  const orgName = inferCompanyName(host) || host;
  const slug =
    orgName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "company";
  const activation = {
    slug,
    display_name: orgName,
    rar_weekly: 3500,
    memory: {},
    background_memory: true,
    ...(scanId ? { scan_id: scanId } : {}),
    onboarding_meta: { wizard: { orgName, website: host } },
    additional,
    timezone: browserTimeZone(),
    attribution: signupAttribution(firstTouchForSignup(), attribution),
    ...withAffiliateClick({}),
  };
  const requestKey = beforeActivate?.();
  const activate = () =>
    websitePost("/api/onboarding/activate", activation, undefined, requestKey ? { "Idempotency-Key": requestKey } : undefined);
  let response = await activate();
  if (response.status >= 500) response = await activate();
  const body = (await response.json().catch(() => null)) as {
    tenant_id?: string;
  } | null;
  if (!response.ok && response.status !== 409)
    throw setupError(response.status, body);
  if (!body?.tenant_id)
    throw new Error("Your workspace could not be opened. Please try again.");
  return body.tenant_id;
}
