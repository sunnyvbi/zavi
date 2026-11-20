
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { slackFetch } from "@/services/tools/slack/_client";
import { enqueueSlackOutbox } from "@/services/slack/outbox";
import { loadTierGateConfig, resolveTenantTier } from "@/services/agents/entitlement";
import { isAgentSchedulable } from "@/services/agents/visibility";
import { tierAllows } from "@/services/billing/tiers";

export const WELCOME_TEAMMATES: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: "engineer", label: "engineer" },
  { slug: "performance-marketer", label: "performance-marketer" },
  { slug: "support-lead", label: "support-lead" },
  { slug: "growth-lead", label: "growth-lead" },
  { slug: "operator", label: "ops" },
  { slug: "pm", label: "pm" },
  { slug: "qa", label: "qa" },
  { slug: "research", label: "research" },
];

export async function welcomeTeammates(
  tenant_id: string,
  deps: {
    loadConfig: typeof loadTierGateConfig;
    resolveTier: typeof resolveTenantTier;
    visible: typeof isAgentSchedulable;
  } = { loadConfig: loadTierGateConfig, resolveTier: resolveTenantTier, visible: isAgentSchedulable },
): Promise<string[]> {
  try {
    const cfg = await deps.loadConfig();
    if (cfg.deferred) return [];
    const tier = await deps.resolveTier(tenant_id, cfg);
    const allowed = WELCOME_TEAMMATES.filter((t) => tierAllows(tier, t.slug, cfg.agentMin, cfg.alwaysPro));
    const shown = await Promise.all(allowed.map(async (t) => ((await deps.visible(tenant_id, t.slug)) ? t.label : null)));
    return shown.filter((l): l is string => l !== null);
  } catch {
    return [];
  }
}

export function installerDmText(teamName?: string, teammates: readonly string[] = []): string {
  const where = teamName ? ` to *${teamName}*` : "";
  const team = teammates.length ? ` (${teammates.join(", ")} and more)` : "";
  return [
    `Hi :wave: I'm *Zavi*, an AI growth agent for your business. You just connected me${where}.`,
    ``,
    `I work with a team of AI teammates${team} shaped by real operating data, not a synthetic demo.`,
    ``,
    `*How to put me to work:*`,
    `• @-mention me in any channel I'm in, like \`@Zavi summarize this thread\` or \`@Zavi draft a reply to this customer\`.`,
    `• Or just DM me here with what you need. I'll route it to the right teammate.`,
    `• *Invite me to a channel with \`/invite @Zavi\`* and I'll introduce myself to the team there.`,
    `• Manage connectors and see what I'm doing in your workspace dashboard: https://www.zaviagent.com/workspace`,
    ``,
    `Try me with something small first, like asking me to summarize a busy channel. :rocket:`,
  ].join("\n");
}

export function welcomeDmIdempotencyKey(tenant_id: string, team_id: string): string {
  return `${tenant_id}:${team_id}:welcome_dm`;
}

export async function sendInstallerDm(
  tenant_id: string,
  team_id: string,
  installerUserId: string,
  teamName?: string,
  teammates: readonly string[] = [],
): Promise<boolean> {
  const open = await slackFetch<{ channel?: { id?: string } }>(
    tenant_id,
    "conversations.open",
    { users: installerUserId },
    team_id,
  );
  const dmChannel = open.channel?.id;
  if (!dmChannel) return false;
  const seq = await enqueueSlackOutbox({
    tenant_id,
    channel_id: dmChannel,
    kind: "welcome_dm",
    body: installerDmText(teamName, teammates),
    team_id,
    idempotency_key: welcomeDmIdempotencyKey(tenant_id, team_id),
  });
  return seq != null;
}

export const slackWelcomeFn = inngest.createFunction(
  { id: "slack-welcome", concurrency: 4, retries: 2 },
  { event: "slack.workspace.intro" },
  async ({ event, step, logger }) => {
    const claimedTenantId = event.data.tenant_id as string;
    const claimedTeamId = event.data.team_id as string;
    const installerUserId =
      (event.data.installer_slack_user_id as string | null) || null;
    const sb = serviceClient();

    const row = await step.run("C8-reverified-load-welcome", async () => {
      const { data, error } = await sb
        .from("slack_workspaces")
        .select("tenant_id, team_id, team_name")
        .eq("tenant_id", claimedTenantId)
        .eq("team_id", claimedTeamId)
        .is("welcome_sent_at", null)
        .maybeSingle();
      if (error) throw new Error(`welcome load: ${error.message}`);
      return (
        (data as {
          tenant_id: string;
          team_id: string;
          team_name: string | null;
        } | null) ?? null
      );
    });
    if (!row) {
      logger.info(
        `slack-welcome: already sent (or no row) for ${claimedTenantId}/${claimedTeamId}; skipping`,
      );
      return { outcome: "already_sent_or_no_row" };
    }
    if (!installerUserId) {
      return { outcome: "no_installer" };
    }
    const tenant_id = row.tenant_id;
    const team_id = row.team_id;
    const teamName = row.team_name ?? undefined;

    await step.run("dm-installer", async () => {
      const teammates = await welcomeTeammates(tenant_id);
      const ok = await sendInstallerDm(tenant_id, team_id, installerUserId, teamName, teammates);
      if (!ok) throw new Error("slack-welcome: installer DM not queued (no DM channel or outbox enqueue failed)");
      return true;
    });

    await step.run("mark-welcome-sent", async () => {
      const { error } = await sb
        .from("slack_workspaces")
        .update({ welcome_sent_at: new Date().toISOString() })
        .eq("tenant_id", tenant_id)
        .eq("team_id", team_id)
        .is("welcome_sent_at", null);
      if (error) throw new Error(`welcome mark: ${error.message}`);
    });

    await step.run("audit-welcome", async () => {
      await sb.from("staff_audit_log").insert({
        actor_user_id: "00000000-0000-0000-0000-000000000000",
        actor_email: "system@zavi",
        action: "slack_welcome_sent",
        target_table: "slack_workspaces",
        target_id: null,
        tenant_id,
        meta: { dm_queued: true, had_installer: true },
      });
    });

    return { outcome: "ok", tenant_id, dm_queued: true };
  },
);
