
import type { Request, Response } from "express";
import { serviceClient } from "@/services/supabase";
import {
  listInstallationRepos,
  verifyWebhookSignature,
} from "@/services/connectors/github/oauth";
import { enqueueWorkItem } from "@/services/agents/work-queue";
import { postTrackerPrComment } from "@/services/agents/tracker-pr-comment";
import { seedPendingProfiles } from "@/services/sandbox/repo-profiles";
import { inngest } from "@/../workers/client";
import {
  enqueueDeployTruthWatch,
  realEnqueueDeployTruthDeps,
} from "@/services/pipeline/deploy-truth";

async function refreshRepoProfiles(
  tenant_id: string,
  repoFullNames: string[],
): Promise<void> {
  try {
    await seedPendingProfiles({ tenant_id, repos: repoFullNames });
  } catch (e) {
    console.warn(
      `[webhooks/github] seed pending profiles failed for tenant ${tenant_id}: ${(e as Error).message}`,
    );
  }
  try {
    await inngest.send({
      name: "repo.profile.build.requested",
      data: { tenant_id },
    });
  } catch (e) {
    console.warn(
      `[webhooks/github] enqueue repo-profile-build failed for tenant ${tenant_id}: ${(e as Error).message}`,
    );
  }
}
import { FleetHaltedError } from "@/services/agents/fleet-halt";
import { resolveRepoEventOwner } from "@/services/sites/app-identity";

const ENGINEER_BRANCH_PREFIX = "engineer/";
function isEngineerBranch(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.startsWith(ENGINEER_BRANCH_PREFIX);
}

type ShepherdSignal =
  | "ci_failure"
  | "changes_requested"
  | "review_commented"
  | "pr_comment";

function detectEngineerPrShepherdSignal(
  event: string,
  action: string,
  body: Record<string, unknown>,
): { signal: ShepherdSignal; head_branch: string | null } | null {
  if (event === "check_run" && action === "completed") {
    const checkRun = body.check_run as
      | {
          conclusion?: string | null;
          check_suite?: { head_branch?: string | null };
          pull_requests?: Array<{ head?: { ref?: string | null } }>;
        }
      | undefined;
    if (!checkRun || checkRun.conclusion !== "failure") return null;
    const suiteBranch = checkRun.check_suite?.head_branch ?? null;
    const prBranch =
      (checkRun.pull_requests ?? [])
        .map((p) => p.head?.ref ?? null)
        .find((r) => isEngineerBranch(r)) ?? null;
    const head_branch = isEngineerBranch(suiteBranch) ? suiteBranch : prBranch;
    if (!isEngineerBranch(head_branch)) return null;
    return { signal: "ci_failure", head_branch: head_branch ?? null };
  }

  if (event === "pull_request_review" && action === "submitted") {
    const review = body.review as { state?: string | null } | undefined;
    const pr = body.pull_request as { head?: { ref?: string | null } } | undefined;
    const headRef = pr?.head?.ref ?? null;
    if (!isEngineerBranch(headRef)) return null;
    const state = (review?.state ?? "").toLowerCase();
    if (state === "changes_requested") {
      return { signal: "changes_requested", head_branch: headRef };
    }
    if (state === "commented") {
      return { signal: "review_commented", head_branch: headRef };
    }
    return null;
  }

  if (event === "issue_comment" && action === "created") {
    const issue = body.issue as { pull_request?: unknown } | undefined;
    const comment = body.comment as
      | { user?: { type?: string | null } | null }
      | undefined;
    const isPr = !!issue?.pull_request;
    const isBot = (comment?.user?.type ?? "").toLowerCase() === "bot";
    if (!isPr || isBot) return null;
    return { signal: "pr_comment", head_branch: null };
  }

  return null;
}

export async function githubWebhook(req: Request, res: Response): Promise<void> {
  const signature = String(req.header("x-hub-signature-256") ?? "");
  const event = String(req.header("x-github-event") ?? "");
  const deliveryId = String(req.header("x-github-delivery") ?? "");
  const rawBuf = (req.body as Buffer | undefined) ?? Buffer.alloc(0);

  if (!signature) {
    res.status(401).json({ error: { code: "no_signature", message: "x-hub-signature-256 missing" } });
    return;
  }
  let valid: boolean;
  try {
    valid = verifyWebhookSignature(rawBuf, signature);
  } catch (e) {
    res.status(500).json({ error: { code: "verify_failed", message: (e as Error).message } });
    return;
  }
  if (!valid) {
    res.status(401).json({ error: { code: "bad_signature", message: "github signature invalid" } });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBuf.toString("utf-8")) as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: { code: "bad_json", message: "invalid json" } });
    return;
  }

  const action = String(body.action ?? "");
  const installation = body.installation as
    | { id?: number; account?: { login?: string; type?: string } }
    | undefined;
  const installation_id = installation?.id;
  const account_login = installation?.account?.login ?? "";
  const account_type = installation?.account?.type ?? "";

  let tenant_id: string | null = null;
  if (installation_id) {
    const { data, error } = await serviceClient()
      .from("connector_metadata")
      .select("tenant_id")
      .eq("slug", "github")
      .eq("installation_id", installation_id)
      .maybeSingle();
    if (!error && data) {
      tenant_id = (data as { tenant_id: string }).tenant_id;
    }
  }
  if (!tenant_id && account_login) {
    const { data, error } = await serviceClient()
      .from("connector_metadata")
      .select("tenant_id")
      .eq("slug", "github")
      .eq("account_login", account_login)
      .maybeSingle();
    if (!error && data) {
      tenant_id = (data as { tenant_id: string }).tenant_id;
    }
  }

  if (event === "installation" && action === "created" && tenant_id && installation_id) {
    try {
      const repos = await listInstallationRepos({ tenant_id, installation_id });
      const { error } = await serviceClient().rpc("set_github_connection", {
        p_tenant_id: tenant_id,
        p_installation_id: installation_id,
        p_account_login: account_login,
        p_account_type: account_type,
        p_repo_ids: repos.map((r) => r.id),
        p_repo_full_names: repos.map((r) => r.full_name),
        p_scopes: [],
        p_repo_private: repos.map((r) => r.private),
      });
      if (error) {
        console.error(
          `[webhooks/github] installation.created refresh failed for tenant ${tenant_id}: ${error.message}`,
        );
      } else {
        await refreshRepoProfiles(tenant_id, repos.map((r) => r.full_name));
      }
    } catch (e) {
      console.error(
        `[webhooks/github] installation.created repo fetch failed: ${(e as Error).message}`,
      );
    }
    res.status(200).json({ ok: true, action: "installation_refreshed" });
    return;
  }

  if (event === "installation" && action === "deleted" && tenant_id) {
    const { error } = await serviceClient()
      .from("tenant_mcp_servers")
      .update({ enabled: false })
      .eq("tenant_id", tenant_id)
      .eq("server_id", "github");
    if (error) {
      console.error(
        `[webhooks/github] tenant_mcp_servers disable failed for tenant ${tenant_id}: ${error.message}`,
      );
    }
    res.status(200).json({ ok: true, action: "mcp_disabled" });
    return;
  }

  const repoOwner = await resolveRepoEventOwner(
    (body.repository as { full_name?: string } | undefined)?.full_name ?? null,
    tenant_id,
  );
  if (repoOwner.kind === "lookup_failed") {
    console.error(
      `[webhooks/github] repo owner lookup failed (event=${event} action=${action} delivery=${deliveryId}); acting for no tenant: ${repoOwner.error}`,
    );
    res.status(200).json({ ok: true, action: "repo_owner_unresolved" });
    return;
  }
  if (repoOwner.kind === "site") {
    if (repoOwner.connector_mismatch) {
      console.warn(
        `[webhooks/github] site repo event via another tenant's installation: site=${repoOwner.site_id} owner=${repoOwner.tenant_id} installer=${tenant_id} event=${event}; acting for the owner`,
      );
    }
    if (!repoOwner.active) {
      res.status(200).json({ ok: true, ignored: { event, action, reason: "site_gone" } });
      return;
    }
    tenant_id = repoOwner.tenant_id;
  }
  const isSiteRepo = repoOwner.kind === "site";

  if (
    !isSiteRepo &&
    event === "pull_request" &&
    action === "closed" &&
    (body.pull_request as { merged?: boolean } | undefined)?.merged === true
  ) {
    try {
      const prMerged = body.pull_request as {
        html_url?: string;
        merge_commit_sha?: string | null;
        merged_at?: string | null;
      };
      const repoFullName =
        (body.repository as { full_name?: string } | undefined)?.full_name ?? "";
      await enqueueDeployTruthWatch({
        repoFullName,
        prUrl: prMerged.html_url ?? "",
        mergeCommitSha: prMerged.merge_commit_sha ?? null,
        mergedAt: prMerged.merged_at ?? new Date().toISOString(),
        deps: realEnqueueDeployTruthDeps,
      });
    } catch (e) {
      console.warn(
        `[webhooks/github] deploy-truth watch enqueue skipped: ${(e as Error).message}`,
      );
    }
  }

  if (
    event === "pull_request" &&
    action === "closed" &&
    tenant_id &&
    (body.pull_request as { merged?: boolean } | undefined)?.merged === true
  ) {
    const pr = body.pull_request as {
      html_url?: string;
      merged_at?: string;
    };
    const pr_url = pr.html_url ?? "";
    const merged_at = pr.merged_at ?? new Date().toISOString();
    if (pr_url) {
      try {
        const { markSitePrCardsMerged } = await import("@/services/channels/site-pr");
        const stamped = await markSitePrCardsMerged(tenant_id, pr_url, merged_at);
        if (stamped > 0) console.log(`[webhooks/github] site-pr card merged tenant=${tenant_id} pr=${pr_url} cards=${stamped}`);
      } catch (e) {
        console.warn(`[webhooks/github] site-pr card merge stamp skipped: ${(e as Error).message}`);
      }
    }
    if (pr_url) {
      const { data, error } = await serviceClient().rpc("mark_pr_merged", {
        p_tenant_id: tenant_id,
        p_pr_url: pr_url,
        p_merged_at: merged_at,
      });
      if (error) {
        console.error(
          `[webhooks/github] mark_pr_merged failed for tenant ${tenant_id}, pr=${pr_url}: ${error.message}`,
        );
      } else {
        const updated = (data ?? 0) as number;
        console.log(
          `[webhooks/github] pull_request.merged tenant=${tenant_id} pr=${pr_url} updated=${updated}`,
        );
        if (updated > 0) {
          try {
            const { data: runRow } = await serviceClient()
              .from("agent_runs")
              .select("payload")
              .eq("tenant_id", tenant_id)
              .eq("agent_slug", "engineer")
              .eq("parsed->>pr_url", pr_url)
              .limit(1)
              .maybeSingle();
            const originText =
              typeof (runRow as { payload?: { task_description?: unknown } } | null)
                ?.payload?.task_description === "string"
                ? (runRow as { payload: { task_description: string } }).payload
                    .task_description
                : "";
            if (originText) {
              await postTrackerPrComment({
                tenant_id,
                originText,
                pr_url,
                event: "merged",
              });
            }
          } catch (e) {
            console.warn(
              `[webhooks/github] tracker PR-merge comment skipped for tenant ${tenant_id} pr=${pr_url}: ${(e as Error).message}`,
            );
          }

          try {
            const prFull = body.pull_request as
              | {
                  number?: number;
                  base?: { repo?: { full_name?: string } };
                }
              | undefined;
            const repo_full_name = prFull?.base?.repo?.full_name ?? "";
            const pull_number = prFull?.number;
            if (repo_full_name && typeof pull_number === "number") {
              await inngest.send({
                name: "repo.conventions.distill.requested",
                data: { tenant_id, repo_full_name, pull_number, pr_url },
              });
            }
          } catch (e) {
            console.warn(
              `[webhooks/github] repo-conventions distill enqueue skipped for tenant ${tenant_id} pr=${pr_url}: ${(e as Error).message}`,
            );
          }
        }
      }
    }
    res.status(200).json({ ok: true, action: "merged_recorded" });
    return;
  }

  if (
    event === "pull_request" &&
    action === "closed" &&
    tenant_id &&
    (body.pull_request as { merged?: boolean } | undefined)?.merged !== true
  ) {
    const pr = body.pull_request as { html_url?: string; closed_at?: string };
    const pr_url = pr.html_url ?? "";
    const closed_at = pr.closed_at ?? new Date().toISOString();
    if (pr_url) {
      const { error } = await serviceClient().rpc("mark_pr_closed_unmerged", {
        p_tenant_id: tenant_id,
        p_pr_url: pr_url,
        p_closed_at: closed_at,
      });
      if (error) {
        console.error(
          `[webhooks/github] mark_pr_closed_unmerged failed for tenant ${tenant_id}, pr=${pr_url}: ${error.message}`,
        );
      }
    }
    res.status(200).json({ ok: true, action: "closed_unmerged_recorded" });
    return;
  }

  if (
    event === "installation_repositories" &&
    (action === "added" || action === "removed") &&
    tenant_id &&
    installation_id
  ) {
    try {
      const repos = await listInstallationRepos({ tenant_id, installation_id });
      const { error } = await serviceClient().rpc("set_github_connection", {
        p_tenant_id: tenant_id,
        p_installation_id: installation_id,
        p_account_login: "",
        p_account_type: "",
        p_repo_ids: repos.map((r) => r.id),
        p_repo_full_names: repos.map((r) => r.full_name),
        p_scopes: [],
        p_repo_private: repos.map((r) => r.private),
      });
      if (error) {
        console.error(`[webhooks/github] repo refresh failed: ${error.message}`);
      } else {
        await refreshRepoProfiles(tenant_id, repos.map((r) => r.full_name));
      }
    } catch (e) {
      console.error(`[webhooks/github] repo list fetch failed: ${(e as Error).message}`);
    }
    res.status(200).json({ ok: true, action: "repos_refreshed" });
    return;
  }

  const eventRepoHint =
    (body.repository as { full_name?: string } | undefined)?.full_name ?? null;
  const shepherd = detectEngineerPrShepherdSignal(event, action, body);
  if (tenant_id && deliveryId && shepherd) {
    try {
      await enqueueWorkItem({
        tenant_id,
        agent_slug: "engineer",
        source: "webhook_github",
        dedupe_key: `gh:${deliveryId}`,
        payload: {
          event,
          action,
          kind: "engineer_pr_shepherd",
          signal: shepherd.signal,
          head_branch: shepherd.head_branch ?? null,
          repo_hint: eventRepoHint,
        },
      });
      res.status(200).json({ ok: true, action: "shepherd_enqueued" });
      return;
    } catch (e) {
      if (!(e instanceof FleetHaltedError)) {
        console.error(
          `[webhooks/github] shepherd enqueueWorkItem failed for tenant ${tenant_id} delivery ${deliveryId}: ${(e as Error).message}`,
        );
      }
      res.status(200).json({ ok: true, action: "shepherd_skipped" });
      return;
    }
  }

  res.status(200).json({ ok: true, ignored: { event, action } });
}
