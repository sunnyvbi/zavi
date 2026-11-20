
import { platformStripeClient } from "./_platform-client";

export type CreateOnboardingLinkDeps = {
  createLink: (args: {
    account: string;
    type: "account_onboarding";
    refresh_url: string;
    return_url: string;
  }) => Promise<{ url: string }>;
  returnBase: () => string;
};

const realDeps: CreateOnboardingLinkDeps = {
  createLink: (args) => platformStripeClient().accountLinks.create(args),
  returnBase: () => process.env.PRAXIS_PUBLIC_BASE ?? "https://www.zaviagent.com",
};

export async function createOnboardingLink(
  acctId: string,
  deps: CreateOnboardingLinkDeps = realDeps,
): Promise<string> {
  const base = deps.returnBase();
  const link = await deps.createLink({
    account: acctId,
    type: "account_onboarding",
    refresh_url: `${base}/autopilot/stripe/refresh`,
    return_url: `${base}/autopilot/stripe/return`,
  });
  return link.url;
}
