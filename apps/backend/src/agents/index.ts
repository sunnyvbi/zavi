
import { readCustomerFacingFields } from "@/services/agents/model-refusal-envelope";
import type { DispatcherFn } from "@/services/agents/types";
import { CHAT_CARD_OFFER_LINE } from "@/services/agents/channel-chat-mode";
import { isQaWeeklyCaseRun, runQaWeeklyCase } from "./qa/weekly-case";

import {
  attributionSentence,
  type TestAttribution,
} from "@/agents/engineer/engineer-test-baseline";
import {
  readApprovalClass,
  requiresExplicitShipRed,
} from "@/agents/engineer/approval-class";
import { validateDecisionEvidenceInBody } from "@/services/agents/decision-evidence";
import { z } from "zod";
import type { ZodTypeAny } from "zod";
import { digestSchema, type Digest } from "./chief-of-staff/output-schema";
import { chiefOfStaffDispatcher } from "./chief-of-staff/dispatcher";
import { cosScrubAndAnnotate } from "./chief-of-staff/post-run";
import {
  revenueDataAvailable,
  scrubUngroundedRevenueProse,
} from "./chief-of-staff/gmv-guard";
import { prProposalModelOutputSchema } from "./engineer/output-schema";
import { runCtoPostRun } from "./engineer/post-run";
import { isEngineerHtmlPreviewEnabled } from "./engineer/engineer-html-preview-flag";
import {
  resolveEngineerHtmlPreview,
  stripHtmlPreviewBlock,
  hasExplicitPreviewIntent,
  isPreviewComplaintTurn,
} from "./engineer/html-preview";
import {
  hasHtmlPreviewBlock,
  type HtmlPreview,
  type HtmlPreviewMetadata,
} from "./engineer/output-schema";
import { publishPrototypeLink } from "@/services/agents/prototype-links";
import {
  loadReadyHtmlPreview,
  loadRunHtmlPreviewState,
  markHtmlPreviewFailed,
  stageHtmlPreviewArtifact,
  type HtmlPreviewFailureReason,
  htmlPreviewFailureMessage,
} from "@/services/agents/html-preview-artifacts";
import { adviceSchema } from "./advisor/output-schema";
import { seoGeoAdviceSchema } from "./seo-geo/output-schema";
import { fundraisingEnvelopeSchema } from "./fundraising/output-schema";
import { fundraisingPostProcess } from "./fundraising/post-run";
import { productPmBacklogSchema } from "./pm/output-schema";
import { productPmDispatcher, productPmPostProcess } from "./pm/dispatcher";
import { createSideEffectDispatcher } from "./lib/side-effect-dispatcher";
import type { SideEffectDispatcherFn } from "./lib/side-effect-dispatcher";
import { stampQaCatalogBuildCount } from "./qa/post-run";
import { researchReportEnvelopeSchema } from "./research/output-schema";
import { researchDispatcher, researchChatPostProcess } from "./research/dispatcher";
import { competitorSnapshotPostProcess } from "./research/persist-snapshot";
import { growthDigestSchema as growthOrchestratorOutputSchema } from "./growth-lead/output-schema";
import { growthOrchestratorPostProcess } from "./growth-lead/post-run";
import { advisorPostProcess } from "./advisor/post-run";
import { cgoPostProcess } from "@/agents/cgo/post-run";
import { operatorPostProcess } from "./operator/post-run";
import { adsManagerPostProcess } from "./performance-marketer/post-run";
import { contentSeoDigestSchema } from "./content-design/output-schema";
import { contentSeoPostProcess } from "./content-design/post-run";
import { AGENT_SLUG as CONTENT_DESIGN_SLUG } from "./content-design/constants";
import { supportTriageSchema } from "./support-lead/output-schema";
import {
  disputeResponseSchema,
  hasSubmittableEvidencePacket,
} from "./dispute-response/output-schema";
import {
  channelRecipeStepEnvelopeSchema,
  hasRecipeSteps,
  stepDecisionBodies,
} from "./lib/channel-recipe-step";
import { groundChannelDeliverables } from "./lib/ground-channel-deliverables";
import { withPublishGates } from "./lib/publish-gates";
import {
  shouldEmitRedditOrganic,
  transformRedditDraftPost,
} from "./lib/reddit-draft-post-fallback";

const gatedChannelTransform = withPublishGates(groundChannelDeliverables);
const redditOrganicTransform: NonNullable<Parameters<typeof createSideEffectDispatcher>[0]["transformBeforeCriticAndEmit"]> =
  (envelope, ctx, payload, result) =>
    transformRedditDraftPost(
      envelope,
      payload,
      (next) => gatedChannelTransform(next, ctx, payload, result),
    );
import { serviceClient } from "@/services/supabase";
import { isBuildStepRun } from "./lib/build-step-run";

export const dispatchers: Record<string, DispatcherFn> = {
  "chief-of-staff": chiefOfStaffDispatcher,
  "pm": productPmDispatcher,
  "engineer": createSideEffectDispatcher({
    slug: "engineer",
    decisionClass: "engineer.ship-pr",
    backfillImprovementAttempt: true,
    transformBeforeCriticAndEmit: async (envelope, ctx, payload, result) => {
      const outcome = await runCtoPostRun(ctx, envelope, payload, result?.tool_calls);
      if (outcome.kind === "suppress") {
        return {
          suppress: true,
          reason: outcome.reason,
          output_text: outcome.output_text,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        };
      }
      return { envelope: outcome.envelope };
    },
  }),
  "dispute-response": createSideEffectDispatcher({
    slug: "dispute-response",
    decisionClass: "dispute-response.submit-evidence",
    schema: disputeResponseSchema,
    shouldEmit: (parsed) => hasSubmittableEvidencePacket(parsed),
  }),
  "qa": withQaWeeklyCase(createSideEffectDispatcher({
    slug: "qa",
    decisionClass: "qa.weekly-digest",
    shouldEmit: (_parsed, ctx, payload) => !isBuildStepRun(ctx.trigger, payload),
    transformBeforeCriticAndEmit: async (envelope, _ctx, _payload, result) => ({
      envelope: stampQaCatalogBuildCount(envelope as Digest, result),
    }),
  })),
  research: researchDispatcher,
  "google_ads": createSideEffectDispatcher({
    slug: "google_ads",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "seo": createSideEffectDispatcher({
    slug: "seo",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "geo": createSideEffectDispatcher({
    slug: "geo",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),

  "meta_ads": createSideEffectDispatcher({
    slug: "meta_ads",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "linkedin_organic": createSideEffectDispatcher({
    slug: "linkedin_organic",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "reddit_organic": createSideEffectDispatcher({
    slug: "reddit_organic",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed, _ctx, payload) => shouldEmitRedditOrganic(parsed, payload),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: redditOrganicTransform,
  }),
  "pinterest_organic": createSideEffectDispatcher({
    slug: "pinterest_organic",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "blog": createSideEffectDispatcher({
    slug: "blog",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "x_organic": createSideEffectDispatcher({
    slug: "x_organic",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "instagram_organic": createSideEffectDispatcher({
    slug: "instagram_organic",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "tiktok_organic": createSideEffectDispatcher({
    slug: "tiktok_organic",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "youtube_organic": createSideEffectDispatcher({
    slug: "youtube_organic",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "ugc": createSideEffectDispatcher({
    slug: "ugc",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "sms": createSideEffectDispatcher({
    slug: "sms",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "email_marketing": createSideEffectDispatcher({
    slug: "email_marketing",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "youtube_ads": createSideEffectDispatcher({
    slug: "youtube_ads",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "tiktok_ads": createSideEffectDispatcher({
    slug: "tiktok_ads",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "linkedin_ads": createSideEffectDispatcher({
    slug: "linkedin_ads",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "reddit_ads": createSideEffectDispatcher({
    slug: "reddit_ads",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "x_ads": createSideEffectDispatcher({
    slug: "x_ads",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "chatgpt_ads": createSideEffectDispatcher({
    slug: "chatgpt_ads",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
  "generated_video": createSideEffectDispatcher({
    slug: "generated_video",
    decisionClass: "channel.recipe_step",
    schema: channelRecipeStepEnvelopeSchema,
    shouldEmit: (parsed) => hasRecipeSteps(parsed),
    fanOut: stepDecisionBodies,
    transformBeforeCriticAndEmit: gatedChannelTransform,
  }),
};

export const outputSchemas: Record<string, ZodTypeAny> = {
  "chief-of-staff": digestSchema,
  "engineer": prProposalModelOutputSchema,
  "qa": digestSchema,
  advisor: adviceSchema,
  "seo-geo": seoGeoAdviceSchema,
  fundraising: fundraisingEnvelopeSchema,
  "pm": productPmBacklogSchema,
  "growth-lead": growthOrchestratorOutputSchema,
  "performance-marketer": growthOrchestratorOutputSchema,
  "dispute-response": disputeResponseSchema,
  [CONTENT_DESIGN_SLUG]: contentSeoDigestSchema,
  research: researchReportEnvelopeSchema,
  "support-lead": supportTriageSchema,
  "google_ads": channelRecipeStepEnvelopeSchema,
  "seo": channelRecipeStepEnvelopeSchema,
  "geo": channelRecipeStepEnvelopeSchema,
  "meta_ads": channelRecipeStepEnvelopeSchema,
  "linkedin_organic": channelRecipeStepEnvelopeSchema,
  "reddit_organic": channelRecipeStepEnvelopeSchema,
  "pinterest_organic": channelRecipeStepEnvelopeSchema,
  "blog": channelRecipeStepEnvelopeSchema,
  "x_organic": channelRecipeStepEnvelopeSchema,
  "instagram_organic": channelRecipeStepEnvelopeSchema,
  "tiktok_organic": channelRecipeStepEnvelopeSchema,
  "youtube_organic": channelRecipeStepEnvelopeSchema,
  "ugc": channelRecipeStepEnvelopeSchema,
  "sms": channelRecipeStepEnvelopeSchema,
  "email_marketing": channelRecipeStepEnvelopeSchema,
  "youtube_ads": channelRecipeStepEnvelopeSchema,
  "tiktok_ads": channelRecipeStepEnvelopeSchema,
  "linkedin_ads": channelRecipeStepEnvelopeSchema,
  "reddit_ads": channelRecipeStepEnvelopeSchema,
  "x_ads": channelRecipeStepEnvelopeSchema,
  "chatgpt_ads": channelRecipeStepEnvelopeSchema,
  "generated_video": channelRecipeStepEnvelopeSchema,
};

export type DispatcherSlug = keyof typeof dispatchers;

export type PostProcessorFn = (
  ctx: import("@/services/agents/types").AgentContext,
  result: import("@/services/agents/types").DispatcherResult,
  payload?: unknown,
) => Promise<void>;

const ctoEngineerChatPostProcess: PostProcessorFn = async (ctx, result, payload) => {
  try {
    if (await isEngineerHtmlPreviewEnabled(ctx.tenant_id)) {
      const p = (payload ?? {}) as {
        current_user_text_raw?: unknown;
        current_message?: unknown;
        prior_messages?: unknown;
      };
      const userText =
        (typeof p.current_user_text_raw === "string" ? p.current_user_text_raw : "") ||
        (typeof p.current_message === "string" ? p.current_message : "");
      const priorMessages = Array.isArray(p.prior_messages) ? p.prior_messages : null;
      const rawText = result.raw_response_text || result.output_text || "";
      const surface = resolveEngineerHtmlPreview({
        rawText,
        userText,
        priorMessages,
      });
      const persistPreviewFailure = async (
        reason: HtmlPreviewFailureReason,
      ): Promise<void> => {
        const kept = stripHtmlPreviewBlock(rawText);
        result.raw_response_text = kept;
        result.output_text = htmlPreviewFailureMessage(reason, kept);
        result.parsed = {
          version: 2,
          kind: "html_preview",
          state: "html_preview_failed",
          failure_reason: reason,
          pending_html_preview: false,
        } as typeof result.parsed;
        result.parse_ok = true;
        result.parse_error = undefined;
        await markHtmlPreviewFailed({
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
          failure_reason: reason,
        }).catch(() => undefined);
        await ctx
          .emitProgress("completed", { code: "engineer_html_preview_failed" })
          .catch(() => undefined);
      };

      if (!surface && hasHtmlPreviewBlock(rawText)) {
        const stripped = stripHtmlPreviewBlock(rawText);
        if (stripped !== rawText) {
          result.output_text = stripped;
          result.raw_response_text = stripped;
          console.log(
            "[engineer chat post-process] html_preview suppressed — stripped an unsolicited preview block from output_text",
          );
        }
      }

      if (
        !surface &&
        !isPreviewComplaintTurn(userText) &&
        hasExplicitPreviewIntent(userText) &&
        hasHtmlPreviewBlock(rawText)
      ) {
        const reason = /<html_preview>[\s\S]*<\/html_preview>/i.test(rawText)
          ? "malformed_metadata"
          : "truncated_response";
        await persistPreviewFailure(reason);
        console.warn(
          "[engineer chat post-process] html_preview unusable on an explicit preview ask — suppressing build (no PR)",
        );
        return;
      }

      if (!surface && !hasHtmlPreviewBlock(rawText)) {
        const stagedState = await loadRunHtmlPreviewState({
          tenant_id: ctx.tenant_id,
          run_id: ctx.runId,
        });
        if (stagedState?.status === "html_preview_ready") {
          await persistPreviewFailure("artifact_missing");
          console.warn(
            "[engineer chat post-process] html_preview staged but never emitted — suppressing build (no PR)",
          );
          return;
        }
      }

      if (surface) {
        let metadata: HtmlPreviewMetadata;
        let stored: Awaited<ReturnType<typeof loadReadyHtmlPreview>>;
        if ("html" in surface.envelope) {
          const legacy = surface.envelope as HtmlPreview;
          const staged = await stageHtmlPreviewArtifact({
            tenant_id: ctx.tenant_id,
            run_id: ctx.runId,
            title: legacy.title,
            summary: legacy.summary,
            html: legacy.html,
            design_spec: legacy.design_spec,
          });
          if (!staged.ok) {
            await persistPreviewFailure(staged.failure_reason);
            return;
          }
          metadata = {
            version: 2,
            kind: "html_preview",
            state: "html_preview_ready",
            title: staged.title,
            summary: staged.summary,
            preview_id: staged.preview_id,
            ...(staged.design_spec ? { design_spec: staged.design_spec } : {}),
          };
          stored = await loadReadyHtmlPreview({
            tenant_id: ctx.tenant_id,
            run_id: ctx.runId,
            preview_id: staged.preview_id,
          });
        } else {
          metadata = surface.envelope;
          stored = await loadReadyHtmlPreview({
            tenant_id: ctx.tenant_id,
            run_id: ctx.runId,
            preview_id: metadata.preview_id,
          });
        }
        if (!stored) {
          await persistPreviewFailure("metadata_mismatch");
          return;
        }

        result.parsed = {
          ...metadata,
          pending_html_preview: true,
        } as typeof result.parsed;
        result.parse_ok = true;
        result.parse_error = undefined;
        result.raw_response_text = stripHtmlPreviewBlock(rawText);
        result.output_text = surface.outputText;
        try {
          await ctx.emitProgress("completed", { code: "engineer_html_preview" });
        } catch {
        }
        try {
          await publishPrototypeLink({
            tenant_id: ctx.tenant_id,
            run_id: ctx.runId,
            envelope: {
              kind: "html_preview",
              title: metadata.title,
              summary: metadata.summary,
              html: stored.html,
              ...(metadata.design_spec
                ? { design_spec: metadata.design_spec }
                : {}),
            },
          });
        } catch {
        }
        console.log(
          "[engineer chat post-process] html_preview surfaced — pausing before build (no sandbox, no decision)",
        );
        return;
      }
    }
  } catch (e) {
    console.warn(
      `[engineer chat post-process] html_preview check failed: ${(e as Error).message}`,
    );
    const rawText = result.raw_response_text || result.output_text || "";
    if (hasHtmlPreviewBlock(rawText)) {
      const kept = stripHtmlPreviewBlock(rawText);
      result.raw_response_text = kept;
      result.output_text = htmlPreviewFailureMessage("artifact_storage_failed", kept);
      result.parsed = {
        version: 2,
        kind: "html_preview",
        state: "html_preview_failed",
        failure_reason: "artifact_storage_failed",
        pending_html_preview: false,
      } as typeof result.parsed;
      result.parse_ok = true;
      result.parse_error = undefined;
      return;
    }
  }

  const ctoChatIntent = (payload as { cto_chat_intent?: unknown } | undefined)
    ?.cto_chat_intent;
  if (ctoChatIntent === "info") {
    try {
      await ctx.emitProgress("completed", { code: "ship_gate_info_readonly" });
    } catch (e) {
      console.warn(
        `[engineer chat post-process] info-readonly telemetry failed: ${(e as Error).message}`,
      );
    }
    console.log(
      `[engineer chat post-process] info intent — skipping PR pipeline (prose answer only)`,
    );
    return;
  }

  if (
    (payload as { preview_build_blocked?: unknown } | undefined)
      ?.preview_build_blocked === true
  ) {
    result.output_text =
      "The previous preview was not successfully displayed, so I did not build or open a PR. Please retry the preview.";
    result.raw_response_text = result.output_text;
    result.parsed = {
      version: 2,
      kind: "html_preview",
      state: "html_preview_failed",
      failure_reason: "artifact_missing",
      pending_html_preview: false,
    } as typeof result.parsed;
    result.parse_ok = true;
    result.parse_error = undefined;
    return;
  }

  if (
    (payload as { preview_retry_requested?: unknown } | undefined)
      ?.preview_retry_requested === true
  ) {
    result.output_text =
      "The preview retry did not produce a displayable preview, so I did not build or open a PR. Please retry the preview.";
    result.raw_response_text = result.output_text;
    result.parsed = {
      version: 2,
      kind: "html_preview",
      state: "html_preview_failed",
      failure_reason: "malformed_metadata",
      pending_html_preview: false,
    } as typeof result.parsed;
    result.parse_ok = true;
    result.parse_error = undefined;
    return;
  }

  if (!result.parse_ok || !result.parsed) return;

  let outcome;
  try {
    outcome = await runCtoPostRun(ctx, result.parsed, payload, result.tool_calls);
  } catch (e) {
    const msg = (e as Error).message;
    console.warn(`[engineer chat post-process] threw: ${msg}`);
    result.parse_error = result.parse_error
      ? `${result.parse_error}; cto_post_run_threw:${msg.slice(0, 200)}`
      : `cto_post_run_threw:${msg.slice(0, 200)}`;
    return;
  }
  if (outcome.kind === "suppress") {
    if (outcome.output_text) {
      result.output_text = outcome.output_text;
    }
    if (outcome.reason === "refused_envelope") {
      const declared = readCustomerFacingFields(result.parsed);
      if (declared.customer_summary) result.customer_summary = declared.customer_summary;
      result.side_effect = {
        kind: "refused",
        reason: outcome.reason,
        ...(declared.reason_code ? { reason_code: declared.reason_code } : {}),
      };
    }
    if (outcome.reason === "no_repo" || outcome.reason === "no_sandbox") {
      result.parsed = null;
    }
    console.log(
      `[engineer chat post-process] suppressed: ${outcome.reason}`,
    );
    return;
  }
  let proposalDecisionId: string | undefined;
  try {
    validateDecisionEvidenceInBody(outcome.envelope as Record<string, unknown>, {
      decision_class: "engineer.ship-pr",
    });
    const { data: did, error: emitErr } = await serviceClient().rpc(
      "emit_decision",
      {
        p_tenant_id: ctx.tenant_id,
        p_agent_run_id: ctx.runId,
        p_decision_class: "engineer.ship-pr",
        p_body: outcome.envelope as object,
        p_autonomy_override: "approval",
      },
    );
    if (emitErr) {
      console.warn(
        `[engineer chat post-process] proposal-time emit_decision failed (fallback to emit-on-yes): ${emitErr.message}`,
      );
    } else if (typeof did === "string") {
      proposalDecisionId = did;
      try {
        await ctx.emitProgress("completed", {
          code: "chat_engineer_pr_awaiting_yes",
        });
      } catch {
      }
    }
  } catch (e) {
    console.warn(
      `[engineer chat post-process] proposal-time emit threw: ${(e as Error).message}`,
    );
  }

  const augmented = {
    ...outcome.envelope,
    pending_pr_proposal: true,
    ...(proposalDecisionId ? { decision_id: proposalDecisionId } : {}),
  };
  result.parsed = augmented as typeof result.parsed;

  const shipGateWarningRaw = (
    outcome.envelope as { ship_gate_warning?: unknown }
  ).ship_gate_warning;
  const shipGateWarning =
    typeof shipGateWarningRaw === "string" ? shipGateWarningRaw : null;
  const attribution = (
    outcome.envelope as { test_attribution?: TestAttribution | null }
  ).test_attribution;
  const baseBranch =
    typeof (outcome.envelope as { base_branch?: unknown }).base_branch === "string"
      ? ((outcome.envelope as { base_branch: string }).base_branch)
      : "the base branch";
  const approvalClass = readApprovalClass(outcome.envelope);
  const requiresShipRed = approvalClass
    ? requiresExplicitShipRed(approvalClass)
    : shipGateWarning === "tests_failed_new";

  const safety = attribution
    ? `\n\n${attributionSentence(attribution, baseBranch)}`
    : approvalClass === "soft_yes_red"
    ? "\n\n_Tests are red, and I couldn't tell whether my change caused it. Review the PR before merging._"
    : approvalClass === "soft_yes_couldnt_run"
    ? "\n\n_Tests couldn't run for this change. Review it before merging._"
    : approvalClass === "soft_yes_not_run"
    ? "\n\n_Tests were not run for this change. Review it before merging._"
    : shipGateWarning
    ? "\n\n_A check before the PR came back red. Review the PR before approving._"
    : "";

  const cta = requiresShipRed
    ? "\n\n---\nI'd rather fix this than ship it. Reply **`fix it`** and I'll try again — or **`ship red`** if you want the PR opened anyway."
    : "\n\n---\nReply **`yes`** to open the PR, or tell me what to adjust.";
  const incompleteLine =
    (outcome.envelope as { incomplete?: unknown }).incomplete === true
      ? "\n\n_This PR is incomplete: I reached my step budget before finishing. What is left is listed in the PR._"
      : "";
  const promptLine = incompleteLine + safety + cta;
  const alreadyHasCta =
    result.output_text &&
    (result.output_text.includes("Reply **`yes`** to open the PR") ||
      result.output_text.includes("**`ship red`**"));
  if (result.output_text && !alreadyHasCta) {
    result.output_text = result.output_text + promptLine;
  }

  console.log(
    `[engineer chat post-process] proposal stashed in chat (no decision yet — awaiting operator yes/no in next chat turn)`,
  );
};

const cosChatPostProcess: PostProcessorFn = async (ctx, result, payload) => {
  cosScrubAndAnnotate(ctx, result);
  if (!revenueDataAvailable(result.tool_calls)) {
    const p = (payload ?? {}) as {
      current_user_text_raw?: unknown;
      current_message?: unknown;
    };
    const fedIn =
      (typeof p.current_user_text_raw === "string"
        ? p.current_user_text_raw
        : "") ||
      (typeof p.current_message === "string" ? p.current_message : "");
    if (typeof result.output_text === "string") {
      const stripped = scrubUngroundedRevenueProse(result.output_text, fedIn);
      if (stripped.subs > 0) result.output_text = stripped.text;
    }
    const parsed = result.parsed as { rendered_markdown?: unknown } | null;
    if (parsed && typeof parsed.rendered_markdown === "string") {
      const stripped = scrubUngroundedRevenueProse(parsed.rendered_markdown, fedIn);
      if (stripped.subs > 0) parsed.rendered_markdown = stripped.text;
    }
  }
};

async function runCardCount(tenantId: string, runId: string): Promise<number | null> {
  try {
    const { tenantClient, asTenantId } = await import("@/services/tenant-client");
    const { count, error } = await tenantClient(asTenantId(tenantId))
      .from("channel_actions").select("id", { count: "exact", head: true }).eq("run_id", runId);
    return error || count == null ? null : count;
  } catch {
    return null;
  }
}

function channelChatCards(slug: string): PostProcessorFn {
  return async (ctx, result, payload) => {
    const d = dispatchers[slug] as Partial<SideEffectDispatcherFn> | undefined;
    if (!d?.emitAfterRun) return;
    if (!result.parse_ok || !hasRecipeSteps(result.parsed)) return;
    if (ctx.chat_turn_verdict === "answer") {
      const parsed = result.parsed as { steps: unknown[]; rendered_markdown?: unknown };
      const offer = (text: string) => (text.includes(CHAT_CARD_OFFER_LINE) ? text : `${text.trimEnd()}\n\n${CHAT_CARD_OFFER_LINE}`);
      if (typeof parsed.rendered_markdown === "string" && parsed.rendered_markdown.trim()) parsed.rendered_markdown = offer(parsed.rendered_markdown);
      if (typeof result.output_text === "string" && result.output_text.trim()) result.output_text = offer(result.output_text);
      parsed.steps = [];
      return;
    }
    const { healChatRunStamp } = await import("@/services/channels/direct-run");
    let healed = await healChatRunStamp(ctx.tenant_id, ctx.runId);
    if (healed === "unreadable") healed = await healChatRunStamp(ctx.tenant_id, ctx.runId);
    if (healed === null || healed === "failed" || healed === "unreadable") {
      throw new Error(`channel stamp not confirmed on chat run ${ctx.runId} (${healed}); cards not filed`);
    }
    const steps = (result.parsed as { steps: unknown[] }).steps;
    if (slug === "email_marketing" && steps.length === 1) {
      const { redraftCopyCardFromStep } = await import("@/services/tools/email/propose_campaign");
      const cardId = (payload as { channel_action_id?: unknown } | undefined)?.channel_action_id;
      const reply = await redraftCopyCardFromStep(ctx.tenant_id, ctx.runId, cardId, steps[0]);
      if (reply) {
        result.output_text = reply;
        result.parsed = { rendered_markdown: reply, steps: [] } as typeof result.parsed;
        return;
      }
    }
    const expected = steps.length;
    await d.emitAfterRun(ctx, result, payload);
    if (!result.parse_ok) throw new Error("Channel card preparation failed; no success receipt is available");
    const ids = result.side_effect?.kind === "shipped" ? result.side_effect.detail?.split(",").filter(Boolean) ?? [] : [];
    if (ids.length !== expected) {
      const counted = await runCardCount(ctx.tenant_id, ctx.runId);
      const saved = counted === null ? null : Math.max(ids.length, counted);
      const plural = (n: number) => `${n} card${n === 1 ? "" : "s"}`;
      const reply = saved === null
        ? "Zavi could not confirm which proposed cards were saved. Check the channel's Actions list before asking again."
        : saved >= expected
        ? `Saved ${plural(saved)} from this reply. The channel's Actions list shows them.`
        : saved
        ? `Saved ${plural(saved)}. The channel's Actions list shows the saved cards; other proposed steps were not added.`
        : "This reply added no new cards. Matching cards may already exist in the channel's Actions list.";
      result.output_text = reply;
      result.parsed = { rendered_markdown: reply, steps: [] } as typeof result.parsed;
    }
  };
}

export const postProcessors: Record<string, PostProcessorFn> = {
  "pm": productPmPostProcess,
  "engineer": ctoEngineerChatPostProcess,
  "chief-of-staff": cosChatPostProcess,
  "growth-lead": growthOrchestratorPostProcess,
  "performance-marketer": adsManagerPostProcess,
  [CONTENT_DESIGN_SLUG]: contentSeoPostProcess,
  "advisor": advisorPostProcess,
  "cgo": cgoPostProcess,
  "fundraising": fundraisingPostProcess,
  "research": async (ctx, result, payload) => {
    await researchChatPostProcess(ctx, result, payload);
    await competitorSnapshotPostProcess(ctx, result, payload);
  },
  "operator": operatorPostProcess,
  "google_ads": channelChatCards("google_ads"),
  "seo": channelChatCards("seo"),
  "geo": channelChatCards("geo"),
  "meta_ads": channelChatCards("meta_ads"),
  "linkedin_organic": channelChatCards("linkedin_organic"),
  "reddit_organic": channelChatCards("reddit_organic"),
  "pinterest_organic": channelChatCards("pinterest_organic"),
  "blog": channelChatCards("blog"),
  "x_organic": channelChatCards("x_organic"),
  "instagram_organic": channelChatCards("instagram_organic"),
  "tiktok_organic": channelChatCards("tiktok_organic"),
  "youtube_organic": channelChatCards("youtube_organic"),
  "ugc": channelChatCards("ugc"),
  "sms": channelChatCards("sms"),
  "email_marketing": channelChatCards("email_marketing"),
  "youtube_ads": channelChatCards("youtube_ads"),
  "tiktok_ads": channelChatCards("tiktok_ads"),
  "linkedin_ads": channelChatCards("linkedin_ads"),
  "reddit_ads": channelChatCards("reddit_ads"),
  "x_ads": channelChatCards("x_ads"),
  "chatgpt_ads": channelChatCards("chatgpt_ads"),
  "generated_video": channelChatCards("generated_video"),
};

function withQaWeeklyCase(base: DispatcherFn): DispatcherFn {
  return (ctx, payload) => (isQaWeeklyCaseRun(ctx, payload) ? runQaWeeklyCase(ctx, payload) : base(ctx, payload));
}
