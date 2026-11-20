
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import {
  logDecisionNotTaken,
  type DecisionRejectionType,
} from "@/services/agents/log-decision-not-taken";
import { buildShipPrEvidence } from "./ship-pr-evidence";
import { verifyFromTraces } from "./engineer-verify-receipt";
import {
  typecheckFromTraces,
  typecheckVerdictWithFinalCheck,
} from "./typecheck-receipt";
import { runTypecheckInSandbox } from "@/services/sandbox/typecheck-command";
import { attributeTestFailures } from "./engineer-test-baseline";
import { classifyEngineerPrApproval } from "./approval-class";
import { effectiveRiskClass, type TrivialGuardFile } from "./trivial-guard";
import { neutralizeSelfReportedTestClaim } from "./neutralize-test-claim";
import { detectStaleDeployedDist } from "./stale-dist-guard";
import type { ToolCallTrace } from "@/services/tools/types";
import {
  buildPrFilesFromSandboxFs,
  BuilderRejectedError,
  PRODUCT_BUILD_BUILDER_CAPS,
  OPERATOR_OPT_IN_BUILDER_CAPS,
} from "@/services/pr-builder/from-sandbox-fs";
import { isEngineerLargeDiffAllowlisted } from "@/services/agents/engineer-large-diff-allowlist";
import { buildPerBaseFiles } from "@/services/pr-builder/per-base-files";
import { withSandboxGithubToken } from "./sandbox-token-rearm";
import { execCommand } from "@/services/sandbox/e2b-client";
import { getSandboxIdForRun } from "@/services/sandbox/lifecycle";
import { bootEngineerPreviewForRun, engineerPreviewSourceDir } from "@/services/sandbox/engineer-preview";
import { callMcpTool } from "@/services/mcp/execute";
import { serviceClient } from "@/services/supabase";
import { buildConductorRunIdOf } from "@/services/billing/tiers";
import { ctoShipPrPayloadSchema } from "./input-contract";
import { runSandboxDetections } from "./sandbox-detections";
import { checkDiffWiring } from "./wiring-check";
import {
  designSpecFromContract,
  detectNativeControlSubstitution,
} from "./design-contract";
import { isHttpRoutePath } from "./route-detect";
import { verificationCoversAll } from "./completeness-check";
import { appendUiWireframeToPrBody } from "./wireframe";
import { resolveRepoFullName } from "@/services/agents/repo-resolver";
import { loadTenantProtectedGlobs } from "@/services/agents/pipeline-policy-store";
import { findProtectedPathHits } from "@/services/agents/pipeline-policy";
import { siteProtectedPathHits, verifySiteRepoRun } from "@/services/sites/site-build-target";
import { enforceSiteTheme } from "@/services/sites/design-direction-apply";
import { reportSiteDesignAdherence, sandboxHeadReader } from "@/services/sites/design-adherence";
import { recordBuildPhotos } from "@/services/sites/site-photos-record";
import { siteDesignStore } from "@/services/sites/site-design-store";
import { isFastSinglePassPayload } from "@/services/agents/fast-build-prompt";
import { injectEditorRuntimeIntoLayout } from "@/services/provisioning/picker-asset";
import { forbiddenPathRefusal } from "./forbidden-path-refusal";
import { getBoolSetting } from "@/services/settings";
import {
  commitRefineToDraft,
  isLiveEditPayload,
  kickLiveEditPreview,
  restoreDraftAfterReset,
} from "@/services/build/live-edit";
import { isProductBuilderEnabled } from "./product-builder-flag";
import { validateProposalForDispatch, type PrProposal } from "./output-schema";
import {
  buildStepCapProposal,
  isStepCapFallback,
  applyHandBackFields,
} from "./incomplete-pr";
import { engineerTaskText } from "@/services/agents/engineer-cost-v2";
import { ensureAppDatabase, type PushedFile } from "@/services/provisioning/app-db-on-demand";
import { assertNoUnsafeRoleGrant } from "@/services/provisioning/role-grant-check";
import { assertSchemaCoversQueries, readSchemaBaseline } from "@/services/provisioning/schema-coverage-check";
import { resolveHeadBranch } from "./branch-name";
import { isRunStopRequested } from "@/services/agents/run-stop";
import { RENDERED_MARKDOWN_MAX_CHARS } from "@/services/agents/engineer-caps";
import {
  evaluateCtoShipGate,
  shipBlockExplanation,
  buildShipBlockBody,
  isNoDiffReason,
  collectVerificationNotes,
  customerVerificationNotes,
  isTypecheckRed,
  appendTestingSection,
  type PrAudience,
  type ShipBlockReason,
} from "./ship-gate";
import { assertProvisionedRepoTarget } from "@/services/provisioning/provisioned-repo-gate";

const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;
function isSafeBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("-") &&
    SAFE_BRANCH.test(value)
  );
}

async function resolveBaseBranch(
  tenant_id: string,
  repo_full_name: string,
  model_emitted: unknown,
): Promise<string | null> {
  const emitted = typeof model_emitted === "string" ? model_emitted.trim() : "";
  if (emitted !== "" && emitted !== "main") return null;

  const sb = serviceClient();
  const { data, error } = await sb
    .from("connector_metadata")
    .select("repo_default_branches")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (error) {
    console.warn(
      `[engineer post-run] resolveBaseBranch: select failed: ${error.message}`,
    );
    return null;
  }
  const map =
    (data as { repo_default_branches?: Record<string, string> } | null)
      ?.repo_default_branches ?? {};
  const stored = map[repo_full_name];
  if (!isSafeBranch(stored)) return null;
  if (stored === emitted) return null;
  return stored;
}

export function branchToPersist(input: {
  payload: unknown;
  repo_full_name: string;
  base_branch: unknown;
  base_branches: unknown;
}): string | null {
  const kind = (input.payload as { kind?: unknown } | null)?.kind;
  if (kind === "engineer_pr_followup") return null;
  if (Array.isArray(input.base_branches) && input.base_branches.length > 1) return null;

  const emitted =
    typeof input.base_branch === "string" ? input.base_branch.trim() : "";
  if (emitted === "" || emitted === "main") return null;
  if (!isSafeBranch(emitted) || emitted === input.repo_full_name) return null;
  return emitted;
}

async function persistOperatorDeclaredBranch(
  ctx: AgentContext,
  payload: unknown,
  repo_full_name: string,
  merged: unknown,
): Promise<void> {
  try {
    const m = merged as Record<string, unknown>;
    const branch = branchToPersist({
      payload,
      repo_full_name,
      base_branch: m.base_branch,
      base_branches: m.base_branches,
    });
    if (!branch) return;

    const sb = serviceClient();
    const { error } = await sb.rpc("set_github_repo_operator_branch", {
      p_tenant_id: ctx.tenant_id,
      p_repo_full_name: repo_full_name,
      p_branch: branch,
    });
    if (error) {
      console.warn(
        `[engineer post-run] persistOperatorDeclaredBranch failed for ${repo_full_name}: ${error.message}`,
      );
    }
  } catch (e) {
    console.warn(
      `[engineer post-run] persistOperatorDeclaredBranch threw: ${(e as Error).message}`,
    );
  }
}

async function getRepoDefaultBranch(
  tenant_id: string,
  repo_full_name: string,
): Promise<string> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("connector_metadata")
    .select("repo_default_branches")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (error) {
    console.warn(
      `[engineer post-run] getRepoDefaultBranch: select failed: ${error.message}`,
    );
    return "main";
  }
  const map =
    (data as { repo_default_branches?: Record<string, string> } | null)
      ?.repo_default_branches ?? {};
  const stored = map[repo_full_name];
  return isSafeBranch(stored) ? stored : "main";
}

export type CtoPostRunOutcome =
  | { kind: "emit"; envelope: PrProposal }
  | { kind: "suppress"; reason: string; output_text?: string; detail?: string };

async function emitGateBlockTelemetry(
  ctx: AgentContext,
  reason: ShipBlockReason,
): Promise<void> {
  try {
    await ctx.emitProgress("completed", {
      code: `ship_gate_block_${reason}`,
    });
  } catch (e) {
    console.warn(
      `[engineer post-run] gate telemetry emit failed: ${(e as Error).message}`,
    );
  }
  try {
    await logDecisionNotTaken({
      tenant_id: ctx.tenant_id,
      rejection_type: "agent_not_emitted",
      agent_run_id: ctx.runId,
      agent_slug: ctx.agent.slug,
      decision_class: "engineer.ship-pr",
      reason_code: `gate_held_pr_${reason}`,
    });
  } catch {
  }
}

async function loadPersistedHeadBranch(
  runId: string,
  tenantId: string,
): Promise<string | null> {
  try {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("parsed")
      .eq("id", runId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error || !data) return null;
    const prior = (data.parsed as { pr_head_branch?: unknown } | null)?.pr_head_branch;
    return typeof prior === "string" && prior.startsWith("engineer/") ? prior : null;
  } catch {
    return null;
  }
}

export async function runCtoPostRun(
  ctx: AgentContext,
  envelope: unknown,
  payload: unknown,
  toolCalls?: readonly ToolCallTrace[],
): Promise<CtoPostRunOutcome> {
  if (ctx.shadow_mode) {
    return { kind: "suppress", reason: "shadow_mode" };
  }

  if (ctx.runId && (await isRunStopRequested(ctx.runId))) {
    return { kind: "suppress", reason: "run_stopped" };
  }

  if (isStepCapFallback(ctx, envelope, payload)) {
    const handBackRepo =
      payload && typeof payload === "object" &&
      typeof (payload as { repo_hint?: unknown }).repo_hint === "string"
        ? (payload as { repo_hint: string }).repo_hint
        : "";
    if (handBackRepo) {
      envelope = buildStepCapProposal({
        fallback: envelope,
        repo: handBackRepo,
        taskText: engineerTaskText(payload),
      });
      try {
        await ctx.emitProgress("parsed", { code: "engineer_step_cap_handback" });
      } catch {
      }
    }
  }

  const logNoShip = (rejection_type: DecisionRejectionType, reason_code: string) =>
    logDecisionNotTaken({
      tenant_id: ctx.tenant_id,
      rejection_type,
      agent_run_id: ctx.runId,
      agent_slug: ctx.agent.slug,
      decision_class: "engineer.ship-pr",
      reason_code,
    });

  const earlyGate = evaluateCtoShipGate(envelope);
  if (
    !earlyGate.shippable &&
    (earlyGate.reason === "refused_envelope" ||
      earlyGate.reason === "prose_fallback")
  ) {
    await emitGateBlockTelemetry(ctx, earlyGate.reason);
    const rm =
      envelope && typeof envelope === "object" &&
      typeof (envelope as { rendered_markdown?: unknown }).rendered_markdown ===
        "string"
        ? (envelope as { rendered_markdown: string }).rendered_markdown.trim()
        : "";
    return {
      kind: "suppress",
      reason: earlyGate.reason,
      output_text: rm.length > 0 ? rm : shipBlockExplanation(earlyGate.reason),
    };
  }

  const repoHint =
    payload && typeof payload === "object" &&
    typeof (payload as { repo_hint?: unknown }).repo_hint === "string"
      ? (payload as { repo_hint: string }).repo_hint
      : null;
  if (!repoHint) {
    return {
      kind: "suppress",
      reason: "no_repo",
      output_text:
        "I can't open a PR — no repo is connected to this thread yet. Connect or pick a repo, then resend the change request.",
    };
  }
  const sandbox_id = await getSandboxIdForRun(ctx.tenant_id, repoHint);
  if (!sandbox_id) {
    return {
      kind: "suppress",
      reason: "no_sandbox",
      output_text:
        "I prepared a plan but couldn't open a PR — the sandbox for this thread is unavailable. Try again in a moment.",
    };
  }

  const repoRootRaw = (payload as { _mt_repo_root?: unknown } | null)
    ?._mt_repo_root;
  const runRepoRoot =
    typeof repoRootRaw === "string" && repoRootRaw.startsWith("/home/user/")
      ? repoRootRaw
      : undefined;

  const productBuilderEnabled = await isProductBuilderEnabled().catch(() => false);
  const isProductBuildCodegen = (() => {
    if (!productBuilderEnabled) return false;
    const pl =
      payload && typeof payload === "object"
        ? (payload as { stage?: unknown; target?: { github_full_name?: unknown } })
        : {};
    const stage = typeof pl.stage === "string" ? pl.stage : "";
    const targetFullName =
      typeof pl.target?.github_full_name === "string"
        ? pl.target.github_full_name.trim()
        : "";
    return (
      (stage === "scaffold" || stage === "build") &&
      targetFullName.length > 0 &&
      repoHint === targetFullName
    );
  })();

  const optInCaps =
    !isProductBuildCodegen &&
    (await isEngineerLargeDiffAllowlisted(ctx.tenant_id))
      ? OPERATOR_OPT_IN_BUILDER_CAPS
      : null;

  const siteCheck = isSiteRunPayload(payload)
    ? await verifySiteRepoRun({ tenant_id: ctx.tenant_id, repo_full_name: repoHint, payload })
    : null;
  const isSiteRepoBuild = siteCheck?.ok === true;

  let built;
  try {
    built = await buildPrFilesFromSandboxFs({
      sandbox_id,
      ...(runRepoRoot ? { repo_root: runRepoRoot } : {}),
      ...(isSiteRepoBuild ? { site_repo: true } : {}),
      ...(isProductBuildCodegen
        ? { caps: PRODUCT_BUILD_BUILDER_CAPS }
        : optInCaps
          ? { caps: optInCaps }
          : {}),
    });
  } catch (e) {
    if (e instanceof BuilderRejectedError) {
      const d = e.detail;
      let measure: string | null = null;
      if (d.kind === "max_changed_lines_exceeded") {
        measure = `${d.total_changed_lines} changed lines (cap ${d.cap})`;
      } else if (d.kind === "diff_byte_cap_exceeded") {
        measure = `${d.total_diff_bytes} diff bytes (cap ${d.cap})`;
      } else if (d.kind === "max_post_image_bytes_exceeded") {
        measure = `${d.total_post_image_bytes} new-file bytes (cap ${d.cap})`;
      } else if (d.kind === "max_files_exceeded") {
        measure = `${d.total_files} changed files (cap ${d.cap})`;
      }
      if (measure) {
        const rm =
          envelope && typeof envelope === "object" &&
          typeof (envelope as { rendered_markdown?: unknown }).rendered_markdown === "string"
            ? (envelope as { rendered_markdown: string }).rendered_markdown.trim()
            : "";
        const notice =
          `\n\n---\nI prepared this change but did **not** open a PR automatically — it's ${measure}, over the auto-ship cap that keeps unreviewed PRs small. The diagnosis above stands; open the PR manually, or split the change into smaller commits.`;
        await logNoShip("cap_exceeded", "over_ship_cap");
        return {
          kind: "suppress",
          reason: "over_ship_cap",
          output_text: rm.length > 0 ? rm + notice : notice.trimStart(),
        };
      }
      await logNoShip("condition_unmet", `builder_rejected:${d.kind}`);
      if (d.kind === "forbidden_path") {
        const refusal = forbiddenPathRefusal({
          detail: d,
          siteCheck,
          payload,
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          repo: repoHint,
        });
        if (refusal.stageError) throw refusal.stageError;
        return {
          kind: "suppress",
          reason: `builder_rejected:${d.kind}`,
          output_text: refusal.output_text,
        };
      }
      return {
        kind: "suppress",
        reason: `builder_rejected:${d.kind}`,
        output_text: `I made changes in the sandbox but the platform refused to ship them: ${d.kind}. Details: ${JSON.stringify(d).slice(0, 800)}`,
      };
    }
    throw e;
  }

  if (built.files.length === 0) {
    const rm =
      envelope && typeof envelope === "object" &&
      typeof (envelope as { rendered_markdown?: unknown }).rendered_markdown ===
        "string"
        ? (envelope as { rendered_markdown: string }).rendered_markdown.trim()
        : "";
    await logNoShip("condition_unmet", "empty_diff");
    return {
      kind: "suppress",
      reason: "empty_diff",
      output_text: rm.length > 0 ? rm : undefined,
      detail:
        `typecheck:${typecheckFromTraces(toolCalls ?? []).status};` +
        `tests:${verifyFromTraces(toolCalls ?? []).status}`,
    };
  }

  if (isSiteRepoBuild && isFastSinglePassPayload(payload)) {
    const site_id = (payload as { site_id: string }).site_id;
    const pushedFiles = built.files;
    for (let attempt = 1; ; attempt++) {
      try {
        await enforceSiteTheme({ tenant_id: ctx.tenant_id, site_id, files: pushedFiles }, siteDesignStore());
        break;
      } catch (e) {
        const why = String((e as Error)?.message ?? e).slice(0, 200);
        if (attempt >= 3) throw new Error(`the site's chosen look could not be sealed into the build: ${why}`);
        console.warn(`[engineer post-run] site theme seal try ${attempt} failed run=${ctx.runId}: ${why}`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  if (sandbox_id) {
    await recordBuildPhotos({ tenant_id: ctx.tenant_id, payload, sandbox_id, repoRoot: runRepoRoot ?? "/home/user/repo" });
  }

  if (isSiteRepoBuild) {
    const changedFiles = built.files;
    await reportSiteDesignAdherence(
      { tenant_id: ctx.tenant_id, run_id: ctx.runId, first_build: isFastSinglePassPayload(payload), payload, files: changedFiles },
      { readBefore: sandboxHeadReader((cmd) => execCommand(sandbox_id, cmd, 15_000), runRepoRoot ?? "/home/user/repo") },
    ).catch(() => null);
  }

  const targetMode =
    payload && typeof payload === "object" &&
    typeof (payload as { target?: { github_target_mode?: unknown } }).target
      ?.github_target_mode === "string"
      ? (payload as { target: { github_target_mode: string } }).target.github_target_mode.trim()
      : "umbrella";
  const isZaviOwnedBuildTarget = isProductBuildCodegen && targetMode !== "user_repo";
  if (isZaviOwnedBuildTarget) {
    const ROOT_LAYOUTS = new Set([
      "app/layout.tsx",
      "app/layout.jsx",
      "src/app/layout.tsx",
      "src/app/layout.jsx",
    ]);
    let injectedLayouts = 0;
    for (const f of built.files) {
      if (f.action === "delete" || typeof f.content !== "string") continue;
      if (!ROOT_LAYOUTS.has(f.path)) continue;
      const withRuntime = injectEditorRuntimeIntoLayout(f.content);
      if (withRuntime !== f.content) {
        f.content = withRuntime;
        injectedLayouts++;
      }
    }
    if (injectedLayouts > 0) {
      console.log(
        `[engineer post-run] re-injected zavi editor runtime into ${injectedLayouts} generated layout(s) for ${repoHint}`,
      );
    }
  }

  try {
    const repoRoot = runRepoRoot ?? "/home/user/repo";
    if (/^\/home\/user\/[A-Za-z0-9._/-]+$/.test(repoRoot)) {
      const trackedResult = await execCommand(
        sandbox_id,
        `git -C ${repoRoot} ls-files`,
        15_000,
      );
      const evidenceResult = await execCommand(
        sandbox_id,
        `git -C ${repoRoot} grep -I -n -E '(node|pm2|CMD|ENTRYPOINT).{0,160}dist/|dist/.{0,160}(deploy|committed|tracked)' -- .github Dockerfile package.json apps 2>/dev/null || true`,
        15_000,
      );
      const verdict = detectStaleDeployedDist({
        changed_paths: built.files.map((file) => file.path),
        tracked_paths: trackedResult.stdout.split(/\r?\n/).filter(Boolean),
        deployment_evidence: evidenceResult.stdout,
      });
      if (verdict.stale) {
        await logNoShip("condition_unmet", "stale_dist");
        return {
          kind: "suppress",
          reason: "stale_dist",
          output_text: `I did not open the PR because this repository deploys tracked dist/ output, but the generated files are stale or missing for: ${verdict.source_paths.join(", ")}. Rebuild and include ${verdict.expected_dist_paths.join(", ")}, then retry.`,
        };
      }
    }
  } catch (e) {
    console.warn(
      `[engineer post-run] stale-dist check unavailable; continuing with existing gates: ${(e as Error).message}`,
    );
  }

  if (!isLiveEditPayload(payload)) {
    try {
      await bootEngineerPreviewForRun({
        sandbox_id,
        tenant_id: ctx.tenant_id,
        repo_full_name: repoHint,
        run_id: ctx.runId,
        worktree_dir: engineerPreviewSourceDir({
          worktree_dir: runRepoRoot,
          provisioned_refine:
            isZaviOwnedBuildTarget &&
            (payload as { refine_mode?: unknown } | null)?.refine_mode === true,
        }),
        files: built.files,
        agent_preview_path: (envelope as { preview_path?: unknown } | null | undefined)
          ?.preview_path,
      });
    } catch (e) {
      console.warn(
        `[engineer post-run] live-preview boot threw (ignored): ${(e as Error).message}`,
      );
    }
  }

  const merged = {
    ...((envelope ?? {}) as Record<string, unknown>),
    files: built.files,
  } as PrProposal;

  try {
    const globs = await loadTenantProtectedGlobs(ctx.tenant_id);
    const changedPaths = built.files.map((f) => f.path);
    const hits = isSiteRepoBuild
      ? siteProtectedPathHits(built.files, globs)
      : findProtectedPathHits(changedPaths, globs);
    if (hits.length > 0) {
      (merged as Record<string, unknown>).protected_paths = hits;
    }
  } catch (e) {
    console.warn(
      `[engineer post-run] protected-path stamp threw (ignored): ${(e as Error).message}`,
    );
  }

  {
    const m = merged as Record<string, unknown>;
    m.body = appendUiWireframeToPrBody(m.body, built.files);
  }

  const followupCheckoutRef =
    payload && typeof payload === "object" &&
    (payload as { kind?: unknown }).kind === "engineer_pr_followup" &&
    typeof (payload as { checkout_ref?: unknown }).checkout_ref === "string"
      ? (payload as { checkout_ref: string }).checkout_ref.trim()
      : "";

  const branchSlugSources: Array<string | undefined> = [
    payload && typeof payload === "object" &&
    typeof (payload as { task_description?: unknown }).task_description === "string"
      ? (payload as { task_description: string }).task_description
      : undefined,
    typeof (merged as Record<string, unknown>).title === "string"
      ? ((merged as Record<string, unknown>).title as string)
      : undefined,
  ];

  {
    const m = merged as Record<string, unknown>;
    const priorBranch =
      ctx.agent.slug === "engineer" && !followupCheckoutRef
        ? await loadPersistedHeadBranch(ctx.runId, ctx.tenant_id)
        : null;
    const resolvedBranch = resolveHeadBranch({
      agentSlug: ctx.agent.slug,
      runId: ctx.runId,
      emitted: m.head_branch,
      isProductBuildCodegen,
      followupCheckoutRef,
      slugSources: branchSlugSources,
      priorBranch,
    });
    if (resolvedBranch !== undefined) {
      m.head_branch = resolvedBranch;
    }

    if (typeof m.head_branch === "string" && /[{}]/.test(m.head_branch)) {
      await logNoShip("condition_unmet", "head_branch_placeholder_unresolved");
      const rm =
        typeof m.rendered_markdown === "string" ? m.rendered_markdown.trim() : "";
      const explanation =
        "\n\n---\nI prepared this change but did **not** open a PR — the branch name still contained an unresolved `{...}` placeholder, which would not produce a real PR. The diagnosis above stands; re-run and I'll open it on a concrete branch.";
      return {
        kind: "suppress",
        reason: "head_branch_placeholder_unresolved",
        output_text: rm.length > 0 ? rm + explanation : explanation.trimStart(),
      };
    }
  }

  applyHandBackFields(merged as Record<string, unknown>, {
    costV2: ctx.engineer_cost_v2 === true,
    payload,
  });

  const overrideBase = await resolveBaseBranch(
    ctx.tenant_id,
    repoHint,
    (merged as Record<string, unknown>).base_branch,
  );
  if (overrideBase) {
    (merged as Record<string, unknown>).base_branch = overrideBase;
  }

  await persistOperatorDeclaredBranch(ctx, payload, repoHint, merged);

  {
    const m = merged as Record<string, unknown>;
    if (Array.isArray(m.base_branches) && m.base_branches.length <= 1) {
      delete m.base_branches;
    }
    const declaredBases: string[] = Array.isArray(m.base_branches)
      ? (m.base_branches as unknown[]).filter(
          (b): b is string => typeof b === "string" && b.length > 0,
        )
      : typeof m.base_branch === "string" && m.base_branch.length > 0
        ? [m.base_branch]
        : [];
    const defaultBranch = await getRepoDefaultBranch(ctx.tenant_id, repoHint);
    const nonDefault = declaredBases.filter((b) => b !== defaultBranch);
    if (nonDefault.length > 0) {
      const pb = await withSandboxGithubToken(ctx.tenant_id, payload, sandbox_id, () =>
        buildPerBaseFiles({
          sandbox_id,
          defaultBranch,
          bases: declaredBases,
          defaultFiles: built.files,
          ...(runRepoRoot ? { repo_root: runRepoRoot } : {}),
        }),
      );
      const okBases = Object.keys(pb.perBase);
      const blocked = [...pb.conflicts, ...pb.errors];
      if (okBases.length === 0) {
        if (pb.errors.length > 0) {
          await logNoShip("condition_unmet", "base_build_error");
          return {
            kind: "suppress",
            reason: "base_build_error",
            output_text: `I couldn't open the PR — building the change for ${blocked.join(
              ", ",
            )} failed before it could be applied (a platform-side error, not a clean hold). Retry, or ship to one branch at a time.`,
          };
        }
        await logNoShip("condition_unmet", "all_bases_conflict");
        return {
          kind: "suppress",
          reason: "all_bases_conflict",
          output_text: `I couldn't open the PR — the change doesn't apply cleanly on ${pb.conflicts.join(
            ", ",
          )} (it touches files that differ between those branches, so shipping it there would clobber their content). Ship to one branch at a time, or reconcile the branches first.`,
        };
      }
      m.per_base_files = pb.perBase;
      if (blocked.length > 0) m.base_conflicts = blocked;
      if (Array.isArray(m.base_branches)) m.base_branches = okBases;
    }
  }

  const detections = await runSandboxDetections({
    files: built.files,
    run: (cmd, timeoutMs) => execCommand(sandbox_id, cmd, timeoutMs),
    ...(runRepoRoot ? { repo_root: runRepoRoot } : {}),
  });

  if (detections.carried.status === "fulfilled") {
    const carried = detections.carried.value;
    if (carried.carried_constants.length > 0) {
      (merged as Record<string, unknown>).carried_constants =
        carried.carried_constants;
      try {
        await ctx.emitProgress("completed", { code: "carried_constant_found" });
      } catch {
      }
    }
  } else {
    console.warn(
      `[engineer post-run] carried-constant detection threw: ${(detections.carried.reason as Error).message}`,
    );
  }

  if (detections.stale.status === "fulfilled") {
    const stale = detections.stale.value;
    if (stale.length > 0) {
      (merged as Record<string, unknown>).stale_committed_dist = stale;
      try {
        await ctx.emitProgress("completed", { code: "stale_committed_dist" });
      } catch {
      }
    }
  } else {
    console.warn(
      `[engineer post-run] stale-committed-dist detection threw: ${(detections.stale.reason as Error).message}`,
    );
  }

  const taskDescription = ctoTaskDescription(payload);

  try {
    const contract = (payload as
      | { approved_design_contract?: { text?: unknown } }
      | undefined)?.approved_design_contract;
    const spec = designSpecFromContract(contract);
    const gateOn =
      spec === undefined
        ? false
        : await getBoolSetting("engineer_design_fidelity_gate_enabled", ctx.tenant_id);
    if (gateOn && spec !== undefined && Array.isArray(built.files)) {
      const addedLines: string[] = [];
      for (const f of built.files as ReadonlyArray<Record<string, unknown>>) {
        const diff = typeof f?.diff === "string" ? f.diff : "";
        const content = typeof f?.content === "string" ? f.content : "";
        if (diff) {
          for (const line of diff.split("\n")) {
            if (line.startsWith("+") && !line.startsWith("+++")) addedLines.push(line.slice(1));
          }
        } else if (content) {
          addedLines.push(...content.split("\n"));
        }
      }
      const verdict = detectNativeControlSubstitution(addedLines, spec);
      if (!verdict.ok) {
        (merged as Record<string, unknown>).design_fidelity_substituted =
          verdict.substituted.slice(0, 10);
        console.warn(
          `[design-fidelity] BLOCK — build introduced native control(s) the approved mock did not bless: ${verdict.substituted.join(", ")}`,
        );
      }
    }
  } catch (e) {
    console.warn(
      `[design-fidelity] check failed (fail-open, not blocking): ${(e as Error).message}`,
    );
  }

  try {
    let resolvedRepo: string;
    try {
      resolvedRepo = await resolveRepoFullName({
        tenant_id: ctx.tenant_id,
        repo_hint: repoHint,
      });
    } catch {
      resolvedRepo = "";
    }
    if (resolvedRepo) {
      const prBodyForWiring =
        typeof (merged as Record<string, unknown>).rendered_markdown === "string"
          ? ((merged as Record<string, unknown>).rendered_markdown as string)
          : undefined;
      const wiring = await checkDiffWiring(
        ctx.tenant_id,
        resolvedRepo,
        built.files,
        prBodyForWiring,
      );
      if (wiring.status === "unverified" && wiring.unwired_symbols.length > 0) {
        (merged as Record<string, unknown>).wiring_unverified = true;
        (merged as Record<string, unknown>).wiring_unwired_symbols =
          wiring.unwired_symbols.slice(0, 20);
      }
      if (
        (wiring.exempt_by_framework_count ?? 0) > 0 ||
        (wiring.exempt_by_escape_hatch_count ?? 0) > 0
      ) {
        try {
          await ctx.emitProgress("completed", {
            code: "wiring_check_exempt",
          });
        } catch {
        }
      }
    }
  } catch (e) {
    console.warn(
      `[engineer post-run] wiring check threw: ${(e as Error).message}`,
    );
  }

  if (
    built.files.some(
      (f) => f.action !== "delete" && isHttpRoutePath(f.path),
    )
  ) {
    (merged as Record<string, unknown>).http_route_changed = true;
  }

  if ((merged as Record<string, unknown>).risk_class === "trivial") {
    const effRisk = effectiveRiskClass("trivial", {
      files: built.files as ReadonlyArray<TrivialGuardFile>,
      httpRouteChanged:
        (merged as Record<string, unknown>).http_route_changed === true,
    });
    if (effRisk !== "trivial") {
      (merged as Record<string, unknown>).risk_class = effRisk;
      if (envelope && typeof envelope === "object") {
        (envelope as Record<string, unknown>).risk_class = effRisk;
      }
      console.log(
        `[engineer trivial-guard] downgraded model risk_class trivial→${effRisk} (diff not server-trivial)`,
      );
    }
  }

  const verify = verifyFromTraces(toolCalls ?? []);
  (merged as Record<string, unknown>).verify = verify;
  if (envelope && typeof envelope === "object") {
    (envelope as Record<string, unknown>).verify = verify;
  }

  const pipelineStage = (payload as { stage?: unknown } | null)?.stage;
  const { verdict: typecheckVerify, ranFinal } = await typecheckVerdictWithFinalCheck({
    traces: toolCalls ?? [],
    files: built.files,
    pipelineRun: typeof pipelineStage === "string" && pipelineStage.length > 0,
    runFinal: () =>
      runTypecheckInSandbox({ sandbox_id, root: runRepoRoot ?? "/home/user/repo" }),
  });
  if (ranFinal) {
    console.log(`[engineer typecheck] post-run final check: ${typecheckVerify.status}`);
  }
  (merged as Record<string, unknown>).typecheck_verify = typecheckVerify;
  if (envelope && typeof envelope === "object") {
    (envelope as Record<string, unknown>).typecheck_verify = typecheckVerify;
  }

  if (verify.status === "failed" && runRepoRoot) {
    try {
      const attribution = await attributeTestFailures({
        sandbox_id,
        worktree_path: runRepoRoot,
        command: verify.command,
        head_failures: verify.failing_tests,
        head_confidence: verify.names_confidence,
      });
      (merged as Record<string, unknown>).test_attribution = attribution;
      if (envelope && typeof envelope === "object") {
        (envelope as Record<string, unknown>).test_attribution = attribution;
      }
      console.log(
        `[engineer attribution] ${
          attribution.kind === "attributed"
            ? `new=${attribution.new_failures.length} pre_existing=${attribution.pre_existing.length}`
            : `unknown (${attribution.why})`
        }${attribution.restore_failed ? " restore_failed (the sandbox worktree is not the agent's tree)" : ""}`,
      );
    } catch (e) {
      console.warn(
        `[engineer attribution] failed, falling back to un-attributed warn: ${(e as Error).message}`,
      );
    }
  }

  const approvalClass = classifyEngineerPrApproval(merged);
  (merged as Record<string, unknown>).approval_class = approvalClass;
  if (envelope && typeof envelope === "object") {
    (envelope as Record<string, unknown>).approval_class = approvalClass;
  }

  const prAudience = await resolvePrAudience(ctx.tenant_id, merged, repoHint);
  const fullGate = evaluateCtoShipGate(
    prAudience === "customer" ? withoutTypecheck(merged) : merged,
  );
  if (prAudience === "customer" && isTypecheckRed(merged)) {
    try {
      await ctx.emitProgress("completed", { code: "customer_repo_typecheck_red" });
    } catch (e) {
      console.warn(`[engineer post-run] typecheck telemetry emit failed: ${(e as Error).message}`);
    }
  }
  if (!fullGate.shippable && isNoDiffReason(fullGate.reason)) {
    await emitGateBlockTelemetry(ctx, fullGate.reason);
    const rendered_markdown =
      typeof (merged as Record<string, unknown>).rendered_markdown === "string"
        ? ((merged as Record<string, unknown>).rendered_markdown as string)
        : undefined;
    return {
      kind: "suppress",
      reason: fullGate.reason,
      output_text: buildShipBlockBody(fullGate.reason, { rendered_markdown }),
    };
  }
  if (!fullGate.shippable) {
    await emitGateBlockTelemetry(ctx, fullGate.reason);
    (merged as Record<string, unknown>).ship_gate_warning = fullGate.reason;
  }

  if (fullGate.shippable && fullGate.tests_warning === "tests_missing") {
    (merged as Record<string, unknown>).tests_warning = "tests_missing";
    try {
      await ctx.emitProgress("completed", { code: "ship_gate_warn_tests_missing" });
    } catch (e) {
      console.warn(
        `[engineer post-run] tests_missing warn telemetry emit failed: ${(e as Error).message}`,
      );
    }
  }

  if (fullGate.shippable && fullGate.wiring_warning === "wiring_unverified") {
    try {
      await ctx.emitProgress("completed", {
        code: "ship_gate_warn_wiring_unverified",
      });
    } catch (e) {
      console.warn(
        `[engineer post-run] wiring_unverified warn telemetry emit failed: ${(e as Error).message}`,
      );
    }
  }

  if (fullGate.shippable) {
    try {
      const rm =
        typeof (merged as Record<string, unknown>).rendered_markdown === "string"
          ? ((merged as Record<string, unknown>).rendered_markdown as string)
          : "";
      if (!verificationCoversAll(taskDescription, rm)) {
        (merged as Record<string, unknown>).completeness_unverified = true;
        await ctx.emitProgress("completed", {
          code: "ship_gate_warn_completeness_unverified",
        });
      }
    } catch (e) {
      console.warn(
        `[engineer post-run] completeness check threw: ${(e as Error).message}`,
      );
    }
  }

  {
    const m = merged as Record<string, unknown>;
    const vnotes = collectVerificationNotes(m);
    if (vnotes.length > 0) m.verification_notes = vnotes;
    const bodyNotes = prAudience === "customer" ? customerVerificationNotes(m) : vnotes;
    if (bodyNotes.length > 0) {
      m.body = appendTestingSection(m.body, bodyNotes, undefined, prAudience);
    }
  }

  let refineGoingLiveThreadId: string | null = null;
  let liveEditDraft = false;
  let liveEditBrokeTest = false;
  {
    const pl =
      payload && typeof payload === "object"
        ? (payload as {
            stage?: unknown;
            target?: { github_full_name?: unknown };
            refine_mode?: unknown;
            repair_mode?: unknown;
            customer_origin?: unknown;
            defer_pr?: unknown;
            chat_thread_id?: unknown;
          })
        : {};
    const stage = typeof pl.stage === "string" ? pl.stage : "";
    const targetFullName =
      typeof pl.target?.github_full_name === "string"
        ? pl.target.github_full_name.trim()
        : "";
    const isProductBuildNode = stage === "scaffold" || stage === "build";
    const isRefineNode = pl.refine_mode === true && pl.repair_mode !== true;
    const directMergeEnabled = isRefineNode
      ? await resolveRefineDirectMerge(payload, ctx.tenant_id)
      : true;
    const refineBrakeActive = isRefineNode && !directMergeEnabled;
    const hasVerificationIssue =
      Array.isArray((merged as Record<string, unknown>).verification_notes) &&
      ((merged as Record<string, unknown>).verification_notes as unknown[])
        .length > 0;
    void hasVerificationIssue;
    const brokeBasePassingTest =
      !fullGate.shippable && fullGate.reason === "tests_failed_new";
    const isProductBuildPush =
      isProductBuildNode &&
      !!targetFullName &&
      repoHint === targetFullName &&
      !brokeBasePassingTest;
    if (isProductBuildPush) {
      assertNoUnsafeRoleGrant(built.files);
      if (!isSiteRunPayload(payload) && (await buildSmokeGateOn(ctx.tenant_id))) {
        const repoSchema = await readSchemaBaseline(
          (cmd, timeoutMs) => execCommand(sandbox_id, cmd, timeoutMs),
          runRepoRoot ?? "/home/user/repo",
          built.files,
        );
        assertSchemaCoversQueries(built.files, repoSchema);
      }
      await ensureAppDbBeforePush(ctx.tenant_id, built.files, merged, payload);
    }
    liveEditDraft = isProductBuildPush && pl.refine_mode === true && isLiveEditPayload(payload);
    liveEditBrokeTest =
      isProductBuildNode &&
      isRefineNode &&
      isLiveEditPayload(payload) &&
      brokeBasePassingTest &&
      !!targetFullName &&
      repoHint === targetFullName;
    if (liveEditDraft) {
      (merged as Record<string, unknown>).defer_pr = true;
      (merged as Record<string, unknown>).live_edit_draft = true;
    } else if (isProductBuildPush && !refineBrakeActive) {
      (merged as Record<string, unknown>).push_to_main = true;
      if (
        isRefineNode &&
        typeof pl.chat_thread_id === "string" &&
        pl.chat_thread_id.length > 0
      ) {
        refineGoingLiveThreadId = pl.chat_thread_id;
      }
    }
  }

  if (liveEditBrokeTest) {
    const pl = payload as { target?: { github_full_name?: unknown; default_branch?: unknown } };
    const repo = typeof pl.target?.github_full_name === "string" ? pl.target.github_full_name : repoHint;
    const defaultBranch =
      typeof pl.target?.default_branch === "string" && pl.target.default_branch
        ? pl.target.default_branch
        : "main";
    await withSandboxGithubToken(ctx.tenant_id, payload, sandbox_id, () =>
      restoreDraftAfterReset({
        sandbox_id,
        tenant_id: ctx.tenant_id,
        repo_full_name: repo,
        default_branch: defaultBranch,
      }),
    );
    await logNoShip("condition_unmet", "live_edit_broke_test");
    return {
      kind: "suppress",
      reason: "live_edit_broke_test",
      output_text:
        "I made the change, but it broke a test that was passing before, so I didn't save it to your draft. Nothing changed in your preview or your live app. Try describing the change again.",
    };
  }

  const deferPrActive = ((): boolean => {
    const pl =
      payload && typeof payload === "object"
        ? (payload as { defer_pr?: unknown; refine_mode?: unknown; repair_mode?: unknown })
        : {};
    return pl.defer_pr === true && pl.refine_mode === true && pl.repair_mode !== true;
  })();
  if (deferPrActive) {
    (merged as Record<string, unknown>).defer_pr = true;
  }

  (merged as Record<string, unknown>).decision_evidence = buildShipPrEvidence(
    merged as Record<string, unknown>,
  );

  {
    const m = merged as Record<string, unknown>;
    const fileCount = built.files.length;
    const changedLines = built.total_changed_lines;
    const evidenceBits = [
      `Diff: ${fileCount} file${fileCount === 1 ? "" : "s"}, ${changedLines} line${changedLines === 1 ? "" : "s"} changed`,
    ];
    switch (verify.status) {
      case "passed":
        evidenceBits.push("tests passed");
        break;
      case "failed":
        evidenceBits.push("tests failed");
        break;
      case "couldnt_run":
        evidenceBits.push("tests couldn't run in sandbox");
        break;
      case "not_run":
        evidenceBits.push("tests not run");
        break;
    }
    if (typeof m.typecheck_ok === "boolean") {
      evidenceBits.push(`typecheck ${m.typecheck_ok ? "clean" : "RED"}`);
    }
    const evidenceLine = `_${evidenceBits.join(" · ")}_`;
    let existing = typeof m.rendered_markdown === "string" ? m.rendered_markdown : "";
    if (verify.status !== "passed") {
      existing = neutralizeSelfReportedTestClaim(existing).text;
    }
    let combined =
      existing.includes(evidenceLine)
        ? existing
        : existing.trim().length > 0
          ? `${existing.trimEnd()}\n\n${evidenceLine}`
          : evidenceLine;
    if (combined.length > RENDERED_MARKDOWN_MAX_CHARS) {
      const budget = RENDERED_MARKDOWN_MAX_CHARS - evidenceLine.length - 4;
      combined =
        budget > 0
          ? `${existing.slice(0, budget).trimEnd()}…\n\n${evidenceLine}`
          : evidenceLine.slice(0, RENDERED_MARKDOWN_MAX_CHARS);
    }
    m.rendered_markdown = combined;
  }

  {
    const isProductBuildDispatch =
      productBuilderEnabled &&
      ((merged as Record<string, unknown>).push_to_main === true ||
        (merged as Record<string, unknown>).defer_pr === true);
    const check = validateProposalForDispatch(merged, {
      productBuild: isProductBuildDispatch,
    });
    if (!check.ok) {
      const rm =
        typeof (merged as Record<string, unknown>).rendered_markdown === "string"
          ? ((merged as Record<string, unknown>).rendered_markdown as string).trim()
          : "";
      const explanation = check.over_cap
        ? `\n\n---\nI prepared this change but did **not** open a PR automatically — it exceeds the dispatch size ceiling (${check.reason}). The diagnosis above stands; open the PR manually, or split the change into smaller commits.`
        : `\n\n---\nI prepared this change but the platform could not dispatch it as a PR — the proposal failed validation: ${check.reason}. The work is preserved above; this is a platform-side issue worth reporting.`;
      await logNoShip(
        check.over_cap ? "cap_exceeded" : "condition_unmet",
        "dispatch_validation_failed",
      );
      return {
        kind: "suppress",
        reason: "dispatch_validation_failed",
        output_text: rm.length > 0 ? rm + explanation : explanation.trimStart(),
      };
    }
  }

  if (deferPrActive) {
    const m = merged as Record<string, unknown>;
    const repo = typeof m.repo === "string" && m.repo.trim() ? m.repo.trim() : repoHint;
    const headBranch =
      typeof m.head_branch === "string" && m.head_branch.trim()
        ? m.head_branch.trim()
        : `engineer/${ctx.runId}`;
    const baseBranch =
      typeof m.base_branch === "string" && m.base_branch.trim() ? m.base_branch.trim() : "main";
    const title = typeof m.title === "string" && m.title.trim() ? m.title.trim() : "Refine";
    const owner = repo.split("/")[0];
    const repoName = repo.split("/")[1];
    const pushFiles: Array<{ path: string; action: "create" | "modify" | "delete"; content?: string; encoding?: "base64" }> = [];
    let missingContent = "";
    for (const f of built.files) {
      if (f.action === "delete") {
        pushFiles.push({ path: f.path, action: "delete" });
        continue;
      }
      if (typeof f.content !== "string" || f.content.length === 0) {
        missingContent = f.path;
        break;
      }
      pushFiles.push({ path: f.path, action: f.action, content: f.content, ...(f.encoding ? { encoding: f.encoding } : {}) });
    }
    if (missingContent || !owner || !repoName) {
      await logNoShip("condition_unmet", "defer_pr_push_precondition");
      return {
        kind: "suppress",
        reason: "defer_pr_push_failed",
        output_text:
          "I prepared the change in the sandbox but couldn't stage the review branch (missing file content or repo). Nothing was pushed.",
      };
    }
    if (ctx.runId && (await isRunStopRequested(ctx.runId))) {
      return { kind: "suppress", reason: "run_stopped" };
    }
    const pushRes = await callMcpTool(
      { tenant_id: ctx.tenant_id, run_id: ctx.runId },
      "github",
      "push_branch",
      { owner, repo: repoName, base_branch: baseBranch, head_branch: headBranch, title, files: pushFiles },
    );
    if (pushRes.is_error) {
      console.warn(
        `[engineer post-run] defer_pr push_branch FAILED for ${repo} (run ${ctx.runId}): ${pushRes.content}`,
      );
      await logNoShip("condition_unmet", "defer_pr_push_failed");
      return {
        kind: "suppress",
        reason: "defer_pr_push_failed",
        output_text:
          "I prepared the change in the sandbox but couldn't push the review branch. This is a platform-side issue worth reporting; nothing shipped.",
      };
    }
    let commitSha = "";
    try {
      commitSha = (JSON.parse(pushRes.content) as { commit_sha?: string }).commit_sha ?? "";
    } catch {
    }
    const tr = (m.test_results ?? {}) as { passed?: unknown; failed?: unknown };
    const serverTc = (m.typecheck_verify ?? null) as { status?: unknown } | null;
    const serverTcStatus =
      serverTc && typeof serverTc.status === "string" ? serverTc.status : undefined;
    const modelTypecheckOk =
      typeof m.typecheck_ok === "boolean" ? (m.typecheck_ok as boolean) : null;
    const typecheckOk =
      serverTcStatus === "failed"
        ? false
        : serverTcStatus === "passed"
          ? true
          : modelTypecheckOk;
    m.refine_gate_meta = {
      head_branch: headBranch,
      commit_sha: commitSha,
      base_branch: baseBranch,
      repo,
      title,
      build_ok: typecheckOk !== false,
      tests_passed: typeof tr.passed === "number" ? tr.passed : 0,
      tests_failed: typeof tr.failed === "number" ? tr.failed : 0,
      typecheck_ok: typecheckOk,
    };
  }

  if (liveEditDraft) {
    const m = merged as Record<string, unknown>;
    const pl = payload as { target?: { github_full_name?: unknown; default_branch?: unknown } };
    const repo = typeof pl.target?.github_full_name === "string" ? pl.target.github_full_name : repoHint;
    const defaultBranch =
      typeof pl.target?.default_branch === "string" && pl.target.default_branch ? pl.target.default_branch : "main";
    const title = typeof m.title === "string" && m.title.trim() ? m.title.trim() : "Refine";
    const draftFiles: Array<{ path: string; action: "create" | "modify" | "delete"; content?: string; encoding?: "base64" }> = [];
    let missing = "";
    for (const f of built.files) {
      if (f.action === "delete") {
        draftFiles.push({ path: f.path, action: "delete" });
        continue;
      }
      if (typeof f.content !== "string") {
        missing = f.path;
        break;
      }
      draftFiles.push({ path: f.path, action: f.action, content: f.content, ...(f.encoding ? { encoding: f.encoding } : {}) });
    }
    let draftSha = "";
    let draftError = missing ? `missing content for ${missing}` : "";
    if (!draftError) {
      try {
        draftSha = (
          await commitRefineToDraft({
            tenant_id: ctx.tenant_id,
            repo_full_name: repo,
            default_branch: defaultBranch,
            message: title,
            files: draftFiles,
          })
        ).commit_sha;
      } catch (e) {
        draftError = (e as Error).message ?? String(e);
      }
    }
    if (draftError) {
      console.warn(`[engineer post-run] live edit draft commit FAILED for ${repo} (run ${ctx.runId}): ${draftError}`);
      await withSandboxGithubToken(ctx.tenant_id, payload, sandbox_id, () =>
        restoreDraftAfterReset({
          sandbox_id,
          tenant_id: ctx.tenant_id,
          repo_full_name: repo,
          default_branch: defaultBranch,
        }),
      );
      await logNoShip("condition_unmet", "live_edit_draft_failed");
      return {
        kind: "suppress",
        reason: "live_edit_draft_failed",
        output_text:
          "I made the change in the preview but couldn't save it to your draft. Nothing reached your live app. Try the change again.",
      };
    }
    m.commit_sha = draftSha;
    m.live_edit_draft_sha = draftSha;
    await kickLiveEditPreview({
      tenant_id: ctx.tenant_id,
      repo_full_name: repo,
      sandbox_id,
      run_id: ctx.runId,
      install: true,
    });
    if (envelope && typeof envelope === "object") {
      (envelope as Record<string, unknown>).commit_sha = draftSha;
      (envelope as Record<string, unknown>).live_edit_draft_sha = draftSha;
    }
  }

  if (refineGoingLiveThreadId) {
    await postRefineGoingLive({
      tenant_id: ctx.tenant_id,
      run_id: ctx.runId,
      thread_id: refineGoingLiveThreadId,
      preview_only: await siteEditStopsAtPreview(ctx.tenant_id, payload),
    });
  }

  return { kind: "emit", envelope: merged };
}

export async function resolveRefineDirectMerge(payload: unknown, tenantId: string): Promise<boolean> {
  const stamped =
    payload && typeof payload === "object"
      ? (payload as { direct_merge_enabled?: unknown }).direct_merge_enabled
      : undefined;
  if (typeof stamped === "boolean") return stamped;
  return getBoolSetting("refine_direct_merge_enabled", tenantId);
}

async function buildSmokeGateOn(tenant_id: string): Promise<boolean> {
  try {
    return await getBoolSetting("build_smoke_gate", tenant_id);
  } catch {
    return false;
  }
}

export async function resolvePrAudience(
  tenant_id: string,
  envelope: unknown,
  repoHint: string,
): Promise<PrAudience> {
  const repo =
    envelope && typeof envelope === "object" &&
    typeof (envelope as { repo?: unknown }).repo === "string"
      ? ((envelope as { repo: string }).repo).trim()
      : "";
  if (!repo || repo !== repoHint.trim()) return "customer";
  try {
    const gate = await assertProvisionedRepoTarget(tenant_id, repo);
    return gate.ok ? "zavi_built" : "customer";
  } catch {
    return "customer";
  }
}

function withoutTypecheck(envelope: unknown): Record<string, unknown> {
  const {
    typecheck_verify: _typecheckVerify,
    typecheck_ok: _typecheckOk,
    ...rest
  } = (envelope ?? {}) as Record<string, unknown>;
  return rest;
}

export function ctoTaskDescription(payload: unknown): string {
  const parsedPayload = ctoShipPrPayloadSchema.safeParse(payload);
  return parsedPayload.success
    ? parsedPayload.data.task_description
    : `[payload did not match CtoShipPrPayload contract; raw preview]\n${JSON.stringify(payload).slice(0, 2000)}`;
}

export function isSiteRunPayload(payload: unknown): boolean {
  const v = (payload as { site_id?: unknown } | null | undefined)?.site_id;
  return typeof v === "string" && v.trim().length > 0;
}

async function ensureAppDbBeforePush(
  tenant_id: string,
  files: ReadonlyArray<PushedFile>,
  merged: unknown,
  payload: unknown,
): Promise<void> {
  if (isSiteRunPayload(payload)) return;
  const r = await ensureAppDatabase({ tenant_id, files });
  if (r.added) (merged as Record<string, unknown>).app_db_added = true;
}

export async function siteEditStopsAtPreview(
  tenant_id: string,
  payload: unknown,
): Promise<boolean | "unknown"> {
  if (!isSiteRunPayload(payload)) return false;
  const conductorRunId = buildConductorRunIdOf(payload);
  if (!conductorRunId) return "unknown";
  try {
    const { data, error } = await serviceClient()
      .from("conductor_runs")
      .select("goal_graph")
      .eq("id", conductorRunId)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    const graph = (data as { goal_graph?: unknown } | null)?.goal_graph;
    if (error || !Array.isArray(graph) || graph.length === 0) return "unknown";
    const nodes = graph as Array<{ payload?: { stage?: unknown; direct_merge_enabled?: unknown } } | null>;
    if (nodes.some((n) => n?.payload?.stage === "deploy")) return false;
    return nodes[0]?.payload?.direct_merge_enabled === false ? false : true;
  } catch {
    return "unknown";
  }
}

export async function postRefineGoingLive(args: {
  tenant_id: string;
  run_id: string;
  thread_id: string;
  preview_only?: boolean | "unknown";
}): Promise<void> {
  const body =
    args.preview_only === true
        ? "✅ Built. Your change is ready to review in your preview; it should show up there " +
          "in a minute or two. Nothing changes at your site's address until you press Publish."
        : args.preview_only === "unknown"
          ? "✅ Built. I've finished your change and sent it to your preview. It should show " +
            "up there in a minute or two."
          : "✅ Built and shipping — I've finished your change and handed it off to deploy " +
            "to your live site. It should show up in a minute or two; nothing for you to do " +
            "on your end.";
  try {
    const svc = serviceClient();
    const { data: thread, error: thErr } = await svc
      .from("agent_threads")
      .select("id")
      .eq("id", args.thread_id)
      .eq("tenant_id", args.tenant_id)
      .maybeSingle();
    if (thErr || !thread) {
      console.warn(
        `[engineer post-run] refine going-live post SKIPPED (thread=${args.thread_id}): ` +
          (thErr ? `lookup failed: ${thErr.message}` : "thread not found for tenant"),
      );
      return;
    }
    const { error: insErr } = await svc.from("agent_thread_messages").insert({
      thread_id: args.thread_id,
      tenant_id: args.tenant_id,
      sender_role: "assistant",
      body,
      agent_run_id: args.run_id,
      meta: { refine_going_live: true },
    });
    if (insErr) {
      console.warn(
        `[engineer post-run] refine going-live post FAILED (thread=${args.thread_id}): ${insErr.message}`,
      );
      return;
    }
    await svc
      .from("agent_threads")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", args.thread_id);
  } catch (e) {
    console.warn(
      `[engineer post-run] refine going-live post threw (thread=${args.thread_id}): ${(e as Error).message}`,
    );
  }
}
