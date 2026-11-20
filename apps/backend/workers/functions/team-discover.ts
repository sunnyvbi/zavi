
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  discoverGithubMembers,
  discoverJiraMembers,
  discoverSlackMembers,
  sanitizeDiscoveryError,
  type DiscoveredIdentity,
  type ProviderError,
} from "@/services/team-discovery";
import { reconcile } from "@/services/team-discovery/reconcile";

type JobRow = {
  id: string;
  tenant_id: string;
  status: string;
  providers: string[];
};

export const teamDiscoverFn = inngest.createFunction(
  { id: "team-discover", concurrency: 2, retries: 1 },
  { event: "team.discover.requested" },
  async ({ event, logger }) => {
    const { job_id } = event.data;
    const sb = serviceClient();

    const jobRes = await sb
      .from("team_discover_jobs")
      .select("id, tenant_id, status, providers")
      .eq("id", job_id)
      .single();
    if (jobRes.error || !jobRes.data) {
      logger.warn(`team-discover: job ${job_id} not found: ${jobRes.error?.message}`);
      return { outcome: "job_not_found" };
    }
    const job = jobRes.data as JobRow;

    const claim = await sb
      .from("team_discover_jobs")
      .update({ status: "running" })
      .eq("id", job_id)
      .eq("status", "queued")
      .select("id");
    if (claim.error || !claim.data || claim.data.length === 0) {
      logger.info(`team-discover: job ${job_id} already claimed; skipping`);
      return { outcome: "already_claimed" };
    }

    const errors: ProviderError[] = [];
    const allIdentities: DiscoveredIdentity[] = [];

    if (job.providers.includes("github")) {
      try {
        allIdentities.push(...(await discoverGithubMembers(job.tenant_id)));
      } catch (e) {
        errors.push(sanitizeDiscoveryError("github", e));
      }
    }
    if (job.providers.includes("slack")) {
      const { data: workspaces, error: wsErr } = await sb
        .from("slack_workspaces")
        .select("team_id")
        .eq("tenant_id", job.tenant_id);
      const teamIds = ((workspaces ?? []) as Array<{ team_id: string }>).map(
        (w) => w.team_id,
      );
      if (wsErr) {
        errors.push(sanitizeDiscoveryError("slack", wsErr));
      } else if (teamIds.length === 0) {
        try {
          allIdentities.push(...(await discoverSlackMembers(job.tenant_id)));
        } catch (e) {
          errors.push(sanitizeDiscoveryError("slack", e));
        }
      } else {
        for (const teamId of teamIds) {
          try {
            allIdentities.push(
              ...(await discoverSlackMembers(job.tenant_id, teamId)),
            );
          } catch (e) {
            errors.push(sanitizeDiscoveryError("slack", e));
          }
        }
      }
    }
    if (job.providers.includes("jira")) {
      try {
        allIdentities.push(...(await discoverJiraMembers(job.tenant_id)));
      } catch (e) {
        errors.push(sanitizeDiscoveryError("jira", e));
      }
    }

    const clusters = reconcile(allIdentities);

    let added = 0;
    let updated = 0;
    let mergedExisting = 0;
    for (const c of clusters) {
      const existingMemberIds = new Set<string>();
      if (c.primary_email) {
        const existing = await sb
          .from("team_members")
          .select("id")
          .eq("tenant_id", job.tenant_id)
          .eq("primary_email", c.primary_email)
          .eq("status", "active")
          .maybeSingle();
        if (existing.data) existingMemberIds.add((existing.data as { id: string }).id);
      }
      for (const i of c.identities) {
        const match = await sb
          .from("team_member_identities")
          .select("member_id")
          .eq("tenant_id", job.tenant_id)
          .eq("provider", i.provider)
          .eq("external_id", i.external_id)
          .maybeSingle();
        if (match.data) existingMemberIds.add((match.data as { member_id: string }).member_id);
      }

      let memberId: string | null = null;
      if (existingMemberIds.size === 1) {
        memberId = [...existingMemberIds][0];
      } else if (existingMemberIds.size > 1) {
        const order = await sb
          .from("team_members")
          .select("id, created_at")
          .eq("tenant_id", job.tenant_id)
          .in("id", [...existingMemberIds])
          .order("created_at", { ascending: true });
        const ordered = (order.data ?? []) as Array<{ id: string; created_at: string }>;
        if (ordered.length === 0) {
          logger.warn(`team-discover: lost existing members during merge ordering`);
        } else {
          const keepId = ordered[0].id;
          for (const row of ordered.slice(1)) {
            const dropId = row.id;
            const keepIdents = await sb
              .from("team_member_identities")
              .select("provider, external_id")
              .eq("tenant_id", job.tenant_id)
              .eq("member_id", keepId);
            const keepKeys = new Set<string>(
              (keepIdents.data ?? []).map(
                (r: { provider: string; external_id: string }) => `${r.provider}|${r.external_id}`,
              ),
            );
            const dropIdents = await sb
              .from("team_member_identities")
              .select("id, provider, external_id")
              .eq("tenant_id", job.tenant_id)
              .eq("member_id", dropId)
              .neq("source", "oauth_self");
            for (const di of (dropIdents.data ?? []) as Array<{
              id: string;
              provider: string;
              external_id: string;
            }>) {
              if (keepKeys.has(`${di.provider}|${di.external_id}`)) {
                await sb.from("team_member_identities").delete().eq("id", di.id);
              }
            }
            await sb
              .from("team_member_identities")
              .update({ member_id: keepId, source: "auto" })
              .eq("tenant_id", job.tenant_id)
              .eq("member_id", dropId)
              .neq("source", "oauth_self");
            await sb
              .from("team_members")
              .update({
                status: "merged_into",
                merged_into_id: keepId,
                updated_at: new Date().toISOString(),
              })
              .eq("id", dropId)
              .eq("tenant_id", job.tenant_id);
            mergedExisting += 1;
          }
          memberId = keepId;
        }
      }

      if (!memberId) {
        const ins = await sb
          .from("team_members")
          .insert({
            tenant_id: job.tenant_id,
            display_name: c.display_name,
            primary_email: c.primary_email,
            kind: c.kind,
          })
          .select("id")
          .single();
        if (ins.error || !ins.data) {
          logger.warn(`team-discover: member insert failed: ${ins.error?.message}`);
          continue;
        }
        memberId = (ins.data as { id: string }).id;
        added += 1;
      } else {
        if (c.primary_email) {
          await sb
            .from("team_members")
            .update({ primary_email: c.primary_email, updated_at: new Date().toISOString() })
            .eq("id", memberId)
            .eq("tenant_id", job.tenant_id)
            .is("primary_email", null);
        }
        updated += 1;
      }

      for (const i of c.identities) {
        const identityTeamId = i.provider === "slack" ? i.team_id ?? null : null;
        let exQuery = sb
          .from("team_member_identities")
          .select("id, source, member_id")
          .eq("tenant_id", job.tenant_id)
          .eq("provider", i.provider)
          .eq("external_id", i.external_id);
        exQuery = identityTeamId
          ? exQuery.eq("team_id", identityTeamId)
          : exQuery.is("team_id", null);
        const ex = await exQuery.maybeSingle();
        if (ex.data) {
          const row = ex.data as { id: string; source: string; member_id: string };
          if (row.source === "admin" || row.source === "oauth_self") {
            continue;
          }
          await sb
            .from("team_member_identities")
            .update({
              member_id: memberId,
              external_email: i.external_email,
              external_display_name: i.external_display_name,
              confidence: i.confidence,
              team_id: identityTeamId,
              recent_issue_keys: i.recent_issue_keys ?? null,
              avatar_url: i.avatar_url ?? null,
              source: "auto",
            })
            .eq("id", row.id);
        } else {
          await sb.from("team_member_identities").insert({
            tenant_id: job.tenant_id,
            member_id: memberId,
            provider: i.provider,
            external_id: i.external_id,
            external_email: i.external_email,
            external_display_name: i.external_display_name,
            confidence: i.confidence,
            team_id: identityTeamId,
            recent_issue_keys: i.recent_issue_keys ?? null,
            avatar_url: i.avatar_url ?? null,
            source: "auto",
          });
        }
      }
    }

    await sb
      .from("team_discover_jobs")
      .update({
        status: errors.length > 0 && clusters.length === 0 ? "error" : "done",
        results: { added, updated, merged_existing: mergedExisting, clusters: clusters.length, errors },
        error_reason: errors.length > 0 && clusters.length === 0 ? "all_providers_failed" : null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", job_id);

    return {
      outcome: "done",
      added,
      updated,
      merged_existing: mergedExisting,
      clusters: clusters.length,
      errors: errors.length,
    };
  },
);
