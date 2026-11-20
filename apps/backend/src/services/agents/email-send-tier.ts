import { checkAgentTier, planUpgradeErrorBody, type TierDecision } from "@/services/agents/entitlement";
import { PLAN_UPGRADE_REQUIRED, TIER_DISPLAY_NAME, TIER_PRICE_USD, type Tier } from "@/services/billing/tiers";

export const EMAIL_SEND_TIER_SLUG = "email_marketing";

const EMAIL_SEND_SERVERS: ReadonlySet<string> = new Set(["email", "outbound", "email_campaign"]);
const EMAIL_SEND_TOOLS: ReadonlySet<string> = new Set(["plan_send", "send_campaign", "schedule_campaign"]);

export function isEmailSendTool(server_id: string, tool_name: string): boolean {
  if (!EMAIL_SEND_SERVERS.has(server_id)) return false;
  return tool_name.startsWith("propose") || EMAIL_SEND_TOOLS.has(tool_name);
}

export type EmailSendTierRefusal = { error: string; required_tier?: Tier; message: string };

export const EMAIL_SEND_TIER_UNVERIFIED_MESSAGE =
  "Zavi could not confirm this workspace's plan, so no email was proposed. Try again in a minute.";

export async function emailSendTierRefusal(
  tenant_id: string,
  decide: (tenant_id: string, slug: string) => Promise<TierDecision> = checkAgentTier,
): Promise<EmailSendTierRefusal | null> {
  let d: TierDecision;
  try {
    d = await decide(tenant_id, EMAIL_SEND_TIER_SLUG);
  } catch {
    return { error: "plan_unverified", message: EMAIL_SEND_TIER_UNVERIFIED_MESSAGE };
  }
  if (d.unverified) return { error: "plan_unverified", message: EMAIL_SEND_TIER_UNVERIFIED_MESSAGE };
  if (d.allowed) return null;
  return {
    error: PLAN_UPGRADE_REQUIRED,
    required_tier: d.required_tier,
    message: `${emailSendPlanMessage(d.required_tier)} Tell the user they can upgrade on the Billing page.`,
  };
}

export function emailSendPlanMessage(required_tier: Tier): string {
  const name = TIER_DISPLAY_NAME[required_tier];
  return required_tier === "free"
    ? `Sending email needs the ${name} plan.`
    : `Sending email needs the ${name} plan ($${TIER_PRICE_USD[required_tier]}/mo).`;
}

export type EmailSendHttpRefusal = { status: number; body: { error: { code: string; message: string; required_tier?: Tier } } };

const PLAN_UNREADABLE: EmailSendHttpRefusal = {
  status: 503,
  body: { error: { code: "plan_unreadable", message: "Zavi could not check your plan just now, so nothing was sent. Try again in a minute." } },
};

export async function emailSendHttpRefusal(
  tenant_id: string,
  decide: (tenant_id: string, slug: string) => Promise<TierDecision> = checkAgentTier,
): Promise<EmailSendHttpRefusal | null> {
  let d: TierDecision;
  try {
    d = await decide(tenant_id, EMAIL_SEND_TIER_SLUG);
  } catch {
    return PLAN_UNREADABLE;
  }
  if (d.unverified) return PLAN_UNREADABLE;
  if (d.allowed) return null;
  return { status: 403, body: planUpgradeErrorBody(EMAIL_SEND_TIER_SLUG, d.required_tier) };
}
