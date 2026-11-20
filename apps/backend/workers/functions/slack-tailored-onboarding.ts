
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { slackFetch } from "@/services/tools/slack/_client";
import { enqueueAgentRun } from "@/services/agents/runner";
import { resolveDomain } from "@/services/onboarding/enrichment/domain-match";
import { readConnectorList } from "@/services/connectors/metadata";
import { getVisibleAgentSlugs } from "@/services/agents/visibility";
import { evaluateIdentity } from "@/services/slack-onboarding/identity";
import {
  buildPitches,
  renderTailoredIntro,
  type PitchCandidate,
} from "@/services/slack-onboarding/pitches";

export const ONBOARDING_RESEARCH_SOURCE = "slack_onboarding_research";

async function dmInstaller(
  tenant_id: string,
  team_id: string,
  installerUserId: string,
  text: string,
): Promise<boolean> {
  const open = await slackFetch<{ channel?: { id?: string } }>(
    tenant_id,
    "conversations.open",
    { users: installerUserId },
    team_id,
  );
  const dmChannel = open.channel?.id;
  if (!dmChannel) return false;
  await slackFetch(
    tenant_id,
    "chat.postMessage",
    { channel: dmChannel, text },
    team_id,
  );
  return true;
}

function confirmWebsiteDmText(): string {
  return [
    `Hi :wave: it's *Zavi*. I'd love to come back with a few specific ways I can help your team,`,
    `but I want to make sure I get your company right first.`,
    ``,
    `*What's your company's website?* Reply with the URL and I'll dig in.`,
  ].join("\n");
}

function pitchCandidates(companyName: string): PitchCandidate[] {
  return [
    {
      agent_slug: "research",
      title: "Market & competitor intelligence",
      opportunity: `Your space moves fast and competitor moves are hard to track.`,
      what_id_do: `run a weekly competitor + market scan for ${companyName} and deliver a structured digest`,
      what_youd_get: `a sourced weekly market read, no setup`,
      source: { kind: "public_web" },
    },
    {
      agent_slug: "growth-lead",
      title: "Growth diagnosis",
      opportunity: `Finding the highest-leverage growth lever is hard without a full-funnel read.`,
      what_id_do: `read what's shared here, find the biggest drop, and propose 2 ranked bets`,
      what_youd_get: `a ranked bet list with the evidence behind each`,
      source: { kind: "slack" },
    },
    {
      agent_slug: "content-seo",
      title: "Content & SEO gaps",
      opportunity: `Buyers are searching for what ${companyName} does and may not be finding you.`,
      what_id_do: `audit your site for keyword + page gaps and draft the highest-value pages`,
      what_youd_get: `a prioritized page list + drafts, approval-gated`,
      source: { kind: "connector", connector_slug: "github" },
    },
    {
      agent_slug: "performance-marketer",
      title: "Paid acquisition watch",
      opportunity: `Paid spend without an always-on watcher leaks budget.`,
      what_id_do: `pull spend daily, flag CAC drift, and draft a reallocation`,
      what_youd_get: `a morning read + 1 concrete budget move, draft-only`,
      source: { kind: "connector", connector_slug: "google_ads" },
    },
    {
      agent_slug: "operator",
      title: "Always-on analyst",
      opportunity: `Questions about your own numbers shouldn't wait for someone to pull a report.`,
      what_id_do: `answer questions against your connected business data on demand`,
      what_youd_get: `same-day answers with the query behind them`,
      source: { kind: "connector", connector_slug: "operator_db" },
    },
  ];
}

export const slackTailoredOnboardingStartFn = inngest.createFunction(
  { id: "slack-tailored-onboarding-start", concurrency: 4, retries: 2 },
  { event: "slack.workspace.intro" },
  async ({ event, step, logger }) => {
    const claimedTenantId = event.data.tenant_id as string;
    const claimedTeamId = event.data.team_id as string;
    const installerUserId =
      (event.data.installer_slack_user_id as string | null) || null;
    const sb = serviceClient();

    const claim = await step.run("C8-reverified-claim-research", async () => {
      const { data, error } = await sb
        .from("slack_workspaces")
        .update({ research_started_at: new Date().toISOString() })
        .eq("tenant_id", claimedTenantId)
        .eq("team_id", claimedTeamId)
        .is("research_started_at", null)
        .select("tenant_id, team_id, team_name")
        .maybeSingle();
      if (error) throw new Error(`research claim: ${error.message}`);
      return (
        (data as {
          tenant_id: string;
          team_id: string;
          team_name: string | null;
        } | null) ?? null
      );
    });
    if (!claim) {
      logger.info(
        `slack-tailored-onboarding: already started (or no row) for ${claimedTenantId}/${claimedTeamId}`,
      );
      return { outcome: "already_started_or_no_row" };
    }
    const tenant_id = claim.tenant_id;
    const team_id = claim.team_id;
    const teamName = claim.team_name ?? "";

    if (!installerUserId) {
      await sb
        .from("slack_workspaces")
        .update({ suppressed_reason: "no_installer" })
        .eq("tenant_id", tenant_id)
        .eq("team_id", team_id);
      return { outcome: "no_installer" };
    }

    const verdict = await step.run("identity-gate", async () => {
      let installerEmail: string | null = null;
      try {
        const info = await slackFetch<{
          user?: { profile?: { email?: string } };
        }>(tenant_id, "users.info", { user: installerUserId }, team_id);
        installerEmail = info.user?.profile?.email ?? null;
      } catch (e) {
        logger.warn(`users.info failed: ${(e as Error).message}`);
      }
      const resolved = await resolveDomain(teamName);
      return { v: evaluateIdentity({ installerEmail, resolved }), resolved };
    });

    if (!verdict.v.ok) {
      const reason = verdict.v.reason;
      await step.run("abstain-confirm-dm", async () => {
        await sb
          .from("slack_workspaces")
          .update({ suppressed_reason: `identity_${reason}` })
          .eq("tenant_id", tenant_id)
          .eq("team_id", team_id);
        try {
          await dmInstaller(tenant_id, team_id, installerUserId, confirmWebsiteDmText());
        } catch (e) {
          logger.warn(`confirm-website DM failed: ${(e as Error).message}`);
        }
      });
      return { outcome: "abstained", reason };
    }

    const companyDomain = verdict.v.domain;

    const run_id = await step.run("dispatch-research", async () => {
      const ask = [
        `Research the company "${teamName}" (website ${companyDomain}).`,
        `Cover: what they do, who their customers are, their market and main competitors,`,
        `and 3 concrete, specific ways an AI growth agent could help them grow.`,
        `Public web only. Be concrete and cite sources.`,
      ].join(" ");
      const { run_id } = await enqueueAgentRun({
        tenant_id,
        agent_slug: "research",
        trigger: "cron",
        cron_dedupe_key: `slack-onboarding-research:${tenant_id}:${team_id}`,
        payload: {
          source: ONBOARDING_RESEARCH_SOURCE,
          ask,
          memory: { company_name: teamName, company_domain: companyDomain },
        },
      });
      return run_id;
    });

    await step.run("write-draft-shell", async () => {
      const up = await sb.from("slack_onboarding_drafts").upsert(
        {
          tenant_id,
          team_id,
          research_run_id: run_id,
          installer_user_id: installerUserId,
          company_name: teamName,
          company_domain: companyDomain,
        },
        { onConflict: "tenant_id,team_id" },
      );
      if (up.error) throw new Error(`write-draft-shell: ${up.error.message}`);
      const upd = await sb
        .from("slack_workspaces")
        .update({ research_run_id: run_id })
        .eq("tenant_id", tenant_id)
        .eq("team_id", team_id);
      if (upd.error) throw new Error(`stamp-research-run-id: ${upd.error.message}`);
    });

    return { outcome: "research_dispatched", tenant_id, run_id };
  },
);

export const slackTailoredOnboardingCompleteFn = inngest.createFunction(
  { id: "slack-tailored-onboarding-complete", concurrency: 4, retries: 2 },
  { event: "agent.run.distillable" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id as string;
    const sb = serviceClient();

    const run = await step.run("load-run", async () => {
      const { data, error } = await sb
        .from("agent_runs")
        .select("id, tenant_id, agent_slug, status, output_text, payload")
        .eq("id", run_id)
        .maybeSingle();
      if (error) throw new Error(`load-run: ${error.message}`);
      return (data as {
        id: string;
        tenant_id: string;
        agent_slug: string;
        status: string;
        output_text: string | null;
        payload: { source?: string } | null;
      } | null) ?? null;
    });
    if (
      !run ||
      run.payload?.source !== ONBOARDING_RESEARCH_SOURCE ||
      run.agent_slug !== "research" ||
      run.status !== "success"
    ) {
      return { skip: "not_onboarding_research_success" };
    }

    const draft = await step.run("load-draft", async () => {
      const { data, error } = await sb
        .from("slack_onboarding_drafts")
        .select("tenant_id, team_id, installer_user_id, company_name")
        .eq("tenant_id", run.tenant_id)
        .eq("research_run_id", run_id)
        .maybeSingle();
      if (error) throw new Error(`load-draft: ${error.message}`);
      return (data as {
        tenant_id: string;
        team_id: string;
        installer_user_id: string | null;
        company_name: string | null;
      } | null) ?? null;
    });
    if (!draft || !draft.installer_user_id) {
      return { skip: "no_draft_or_installer" };
    }

    const tenant_id = draft.tenant_id;
    const team_id = draft.team_id;
    const installerUserId = draft.installer_user_id;
    const companyName = draft.company_name || "your company";

    const pitches = await step.run("build-pitches", async () => {
      const [connectors, visible] = await Promise.all([
        readConnectorList(tenant_id),
        getVisibleAgentSlugs(tenant_id),
      ]);
      const connectedSlugs = new Set(connectors.map((c) => c.slug));
      const built = buildPitches({
        candidates: pitchCandidates(companyName),
        connectedSlugs,
        visibleSlugs: visible,
        max: 3,
      });
      const { error } = await sb
        .from("slack_onboarding_drafts")
        .update({
          pitches: built,
          research: { output_text: run.output_text ?? "" },
        })
        .eq("tenant_id", tenant_id)
        .eq("team_id", team_id);
      if (error) throw new Error(`persist-pitches: ${error.message}`);
      return built;
    });

    if (pitches.length === 0) {
      logger.warn(`slack-tailored-onboarding: no visible pitches for ${tenant_id}`);
      return { outcome: "no_pitches", tenant_id };
    }

    const result = await step.run("claim-and-send", async () => {
      const { data, error } = await sb
        .from("slack_workspaces")
        .update({ tailored_dm_sent_at: new Date().toISOString() })
        .eq("tenant_id", tenant_id)
        .eq("team_id", team_id)
        .is("tailored_dm_sent_at", null)
        .select("team_id")
        .maybeSingle();
      if (error) throw new Error(`send claim: ${error.message}`);
      if (!data) return "already_sent";
      const text = renderTailoredIntro({ companyName, pitches, forChannel: false });
      try {
        const ok = await dmInstaller(tenant_id, team_id, installerUserId, text);
        return ok ? "sent" : "dm_failed";
      } catch (e) {
        logger.warn(`tailored DM failed: ${(e as Error).message}`);
        return "dm_failed";
      }
    });

    return { outcome: result, tenant_id, pitches: pitches.length };
  },
);
