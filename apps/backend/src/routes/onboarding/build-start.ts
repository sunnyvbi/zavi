
import { templateChoiceFrom } from "@/services/sites/site-templates";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { verifyBearer } from "@/services/auth/jwt";
import { isProductBuilderEnabled } from "@/agents/engineer/product-builder-flag";
import { buildRequestKeyFrom, DuplicateBuildRequest, stampBuildRequestKey } from "@/services/agents/build-request-key";
import { claimStart, recordStartClaim, releaseStartClaim } from "@/services/onboarding/start-claims";
import {
  isProductBuilderUnavailable,
  respondProductBuilderUnavailable,
} from "@/agents/engineer/product-builder-unavailable";
import { serviceClient } from "@/services/supabase";
import { track, setProfile } from "@/services/analytics/mixpanel";
import { invalidateCachedTenant } from "@/services/auth/tenant-cache";
import { setSessionTenant } from "@/services/tenants/session-tenant";
import { setTenantSetting, getBoolSetting } from "@/services/settings";
import { sendWelcomeBuildEmail } from "@/email/sendAuthEmail";
import { notifyNewTenant } from "@/services/tenants/new-tenant-alert";
import { persistSignupAttribution } from "@/services/tenants/signup-attribution";
import { attributeTenant } from "@/services/affiliates/attribution";
import { requestConductorTick } from "@/services/agents/conductor-kick";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { sendBuildNotStartedEmail } from "@/email/sendAuthEmail";
import { enrolFromDayOne } from "@/services/onboarding-emails/sequence";
import { auditTenantKind } from "@/services/tenants/classify-test-tenant";
import { checkSelfServeTenantCap } from "@/services/tenants/tenant-create-guard";
import { baseSlug, validateCompanyName } from "@/services/provisioning/tenant-slug";
import { resolveSiteName } from "@/services/sites/site-name";
import { classifyShapeStage } from "@/services/onboarding/enrichment/classify-shape-stage";
import { persistCompanyShapeFrom } from "@/routes/onboarding/activate";
import { requireClosedBetaGrant } from "@/services/auth/closedBetaGate";
import {
  startProductBuildDetached,
  InvalidCompanyName,
  DoubleBuildInFlight,
  TooManyBuildsToday,
  ProvisionBudgetExceeded,
  BuildRepoNotProvisioned,
  buildSetupFailedBody,
} from "@/services/agents/start-product-build";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";
import { refusalFor } from "@/services/agents/refusal";
import { sanitizeFetchedContent, xmlEscapeContent } from "@/services/onboarding/enrichment/sanitize";
import { extractIdeaIntake } from "@/services/onboarding/idea-intake";
import { projectCompanyFactValue } from "@/services/company/facts";
import { competitorsFromIdea } from "@/services/company/idea-competitors";
import { persistDraftGoal, writeTypedFactsFromWizard } from "./activate";
import { buildUrl, workspaceUrl } from "@/services/web-base";
import { inngest } from "../../../workers/client";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";
import { storeIdeaImages, validateIdeaImages } from "@/services/onboarding/idea-reference-images";
import { seedTenantBootstrap } from "@/services/tenants/bootstrap";
import { isValidTimeZone } from "@/services/analytics/metric-time";
import { canonicalTz } from "@/services/agents/custom-agents";
import { reserveWorkspaceSlot, WORKSPACE_LIMIT_MESSAGE } from "@/services/onboarding/workspace-create-limit";

const MIN_IDEA_LEN = 8;
const MAX_IDEA_LEN = 4000;

export async function postOnboardingBuildStart(req: Request, res: Response): Promise<void> {
  let builderOn: boolean;
  try {
    builderOn = await isProductBuilderEnabled();
  } catch (e) {
    if (!isProductBuilderUnavailable(e)) throw e;
    respondProductBuilderUnavailable(res);
    return;
  }
  if (!builderOn) {
    res.status(403).json({
      error: {
        code: "product_builder_disabled",
        message: "Building new apps is paused right now. Nothing was started and nothing was charged. Please try again a little later.",
      },
    });
    return;
  }

  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({ error: { code: "unauthorized", message: "Sign in required." } });
    return;
  }
  const user_id = verified.user_id;

  const gate = await requireClosedBetaGrant(user_id);
  if (!gate.ok) {
    res.status(gate.status).json({ error: { code: gate.code, message: gate.message } });
    return;
  }

  const body = (req.body ?? {}) as {
    idea?: unknown;
    company_name?: unknown;
    additional?: unknown;
    attribution?: unknown;
    affiliate_click?: unknown;
    reference_images?: unknown;
    await_look_pick?: unknown;
    template?: unknown;
    timezone?: unknown;
  };

  const additional = body.additional === true;

  const idea = typeof body.idea === "string" ? body.idea.trim() : "";
  if (idea.length < MIN_IDEA_LEN || idea.length > MAX_IDEA_LEN) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: `idea (${MIN_IDEA_LEN}–${MAX_IDEA_LEN} chars) is required. Describe what you want to build`,
      },
    });
    return;
  }
  const safeSeed = sanitizeFetchedContent(idea);
  const cleanIdea = xmlEscapeContent(safeSeed);

  const templateChoice = templateChoiceFrom(body.template, idea);
  if (!templateChoice.ok) {
    res.status(400).json({ error: { code: templateChoice.code, message: templateChoice.message } });
    return;
  }

  const ideaAttach =
    body.reference_images !== undefined &&
    (await getBoolSetting("build_idea_attach").catch(() => false));
  const ideaImages = ideaAttach ? await validateIdeaImages(body.reference_images) : { ok: true as const, jpegs: [] };
  if (!ideaImages.ok) {
    res.status(400).json({ error: { code: "invalid_reference_images", message: ideaImages.message } });
    return;
  }

  const sb = serviceClient();

  const requestKey = buildRequestKeyFrom(req.headers?.["idempotency-key"]);
  let claimToken = "";
  if (requestKey) {
    const claim = await claimStart(sb, user_id, requestKey);
    if (claim.kind === "owned") claimToken = claim.token;
    if (claim.kind === "replay") {
      res.json({ ok: true, tenant_id: claim.tenant_id, conductor_run_id: claim.conductor_run_id, replayed: true });
      return;
    }
    if (claim.kind === "busy") {
      res.status(409).json({
        error: {
          code: claim.stale ? "build_start_incomplete" : "idempotency_in_progress",
          message: claim.stale
            ? "Your workspace was created but its build did not start. Open it and start the build there."
            : "Your build is still being set up.",
        },
        ...(claim.tenant_id ? { tenant_id: claim.tenant_id } : {}),
      });
      return;
    }
    if (claim.kind === "unavailable") {
      res.status(503).json({ error: { code: "idempotency_unavailable", message: "Could not start this safely. Try again.", retryable: true } });
      return;
    }
  }

  if (additional) {
    const capRejection = await checkSelfServeTenantCap(user_id);
    if (capRejection) {
      if (requestKey) await releaseStartClaim(sb, user_id, requestKey, claimToken);
      res.status(403).json({ error: capRejection });
      return;
    }
  } else {
    const { data: prof } = await sb
      .from("profiles")
      .select("active_tenant_id")
      .eq("user_id", user_id)
      .maybeSingle();
    const existingTenant = (prof as { active_tenant_id?: string | null } | null)?.active_tenant_id ?? null;
    if (existingTenant) {
      if (requestKey) await releaseStartClaim(sb, user_id, requestKey, claimToken);
      res.status(409).json({
        error: {
          code: "tenant_exists",
          message: "You already have a workspace. Use it to build or refine.",
        },
        tenant_id: existingTenant,
      });
      return;
    }
    const capRejection = await checkSelfServeTenantCap(user_id);
    if (capRejection) {
      if (requestKey) await releaseStartClaim(sb, user_id, requestKey, claimToken);
      res.status(403).json({ error: capRejection });
      return;
    }
  }

  const clientName =
    typeof body.company_name === "string" && body.company_name.trim().length > 0
      ? body.company_name.trim().slice(0, 100)
      : null;
  const guessedName = clientName ? null : (await resolveSiteName({ idea, company_name: "", workspace_name: null })) || null;
  const rawName = clientName ?? guessedName ?? "My App";
  const nameRejection = validateCompanyName(rawName);
  if (nameRejection) {
    if (requestKey) await releaseStartClaim(sb, user_id, requestKey, claimToken);
    res.status(400).json({
      error: { code: "invalid_company_name", message: InvalidCompanyName.messageFor(nameRejection) },
    });
    return;
  }
  const suffix = additional
    ? `${user_id.replace(/-/g, "").slice(0, 6)}-${randomBytes(3).toString("hex")}`
    : user_id.replace(/-/g, "").slice(0, 6);
  const slug = `${baseSlug(rawName, 40) || "app"}-${suffix}`;

  const slot = reserveWorkspaceSlot(req.ip);
  if (!slot) {
    if (requestKey) await releaseStartClaim(sb, user_id, requestKey, claimToken);
    res.status(429).json({ error: { code: "workspace_limit", message: WORKSPACE_LIMIT_MESSAGE } });
    return;
  }

  const { data: tenantId, error: rpcErr } = await sb.rpc("activate_tenant_lite", {
    p_user_id: user_id,
    p_slug: slug,
    p_display_name: rawName,
    p_allow_additional: additional,
  });
  if (rpcErr || !tenantId) {
    slot.release();
    if ((rpcErr as { code?: string } | null)?.code === "45001") {
      const { data: p2 } = await sb
        .from("profiles").select("active_tenant_id").eq("user_id", user_id).maybeSingle();
      if (requestKey) await releaseStartClaim(sb, user_id, requestKey, claimToken);
      res.status(409).json({
        error: { code: "tenant_exists", message: "You already have a workspace. Use it to build or refine." },
        tenant_id: (p2 as { active_tenant_id?: string | null } | null)?.active_tenant_id ?? null,
      });
      return;
    }
    if (requestKey) await releaseStartClaim(sb, user_id, requestKey, claimToken);
    res.status(500).json({
      error: { code: "tenant_create_failed", message: rpcErr?.message ?? "Could not create your workspace." },
    });
    return;
  }
  const tenant_id = String(tenantId);
  slot.commit(tenant_id);
  track("tenant_created", { tenant_id, user_id, path: "build_start" });
  if (requestKey && !(await recordStartClaim(sb, user_id, requestKey, claimToken, { tenant_id }))) {
    res.status(503).json({
      error: {
        code: "build_start_unrecorded",
        message: "Your workspace is ready, but the build could not be started safely from here. Open your workspace and start it there.",
        retryable: true,
      },
      tenant_id,
    });
    return;
  }
  setProfile(user_id, { tenant_id, tenant_slug: slug });
  if (isValidTimeZone(body.timezone)) {
    try {
      const { error: tzErr } = await sb.from("tenants").update({ timezone: canonicalTz(body.timezone) }).eq("id", tenant_id);
      if (tzErr) throw new Error(tzErr.message);
    } catch (e) {
      console.warn(`[onboarding/build-start] timezone save failed for ${tenant_id}: ${(e as Error).message}`);
    }
  }
  void seedTenantBootstrap(tenant_id).catch((e: Error) => {
    console.warn(`[onboarding/build-start] seedTenantBootstrap failed for ${tenant_id}: ${e.message}`);
  });

  const modelName = clientName ? null : guessedName;
  void (async () => {
    try {
      const modelWhatWeSell = clientName ? null : (await extractIdeaIntake(safeSeed).catch(() => null))?.what_we_sell ?? null;
      await writeTypedFactsFromWizard(
        tenant_id,
        user_id,
        { orgName: clientName ?? undefined, freeText: safeSeed },
        { skipWhatWeSell: Boolean(modelWhatWeSell) },
      );
      const modelFacts: Array<["company_name" | "what_we_sell", string | null]> = [
        ["company_name", modelName],
        ["what_we_sell", modelWhatWeSell],
      ];
      for (const [key, value] of modelFacts) {
        if (!value) continue;
        const { error } = await projectCompanyFactValue(
          tenant_id,
          key,
          value,
          "ai_estimated",
          "idea intake (fast model)",
        );
        if (error) {
          console.warn(`[onboarding/build-start] ${key} not projected for ${tenant_id}: ${error}`);
        }
      }
    } catch (e) {
      console.warn(
        `[onboarding/build-start] company record not seeded for ${tenant_id}: ${(e as Error).message}`,
      );
    }
  })();

  void competitorsFromIdea(tenant_id, safeSeed).catch((e: unknown) => {
    console.warn(
      `[onboarding/build-start] competitors not researched for ${tenant_id}: ${(e as Error).message}`,
    );
  });

  void (async () => {
    try {
      const inferred = await classifyShapeStage(safeSeed);
      await persistCompanyShapeFrom(tenant_id, [
        { kind: "inferred", shape: inferred.shape, confidence: inferred.confidence },
      ]);
    } catch (e) {
      console.warn(
        `[onboarding/build-start] shape inference failed for ${tenant_id}: ${(e as Error).message}`,
      );
    }
  })();

  if (additional) {
    invalidateCachedTenant(user_id);
  }

  if (verified.session_id) {
    try {
      await setSessionTenant(verified.session_id, user_id, tenant_id);
    } catch (e) {
      console.warn(
        `[build-start] session pin failed for tenant ${tenant_id}: ${(e as Error).message}`,
      );
    }
  }

  await auditTenantKind(tenant_id, user_id, verified.email);

  try {
    await setTenantSetting(tenant_id, "build_app_intent", "fresh", user_id);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[build-start] build_app_intent persist failed for ${tenant_id}: ${(e as Error).message}`);
  }

  await persistDraftGoal(tenant_id, user_id);

  await persistSignupAttribution(tenant_id, user_id, body.attribution, req.query);
  await attributeTenant({ tenantId: tenant_id, click: body.affiliate_click, door: "build_start", email: verified.email ?? null, userId: user_id });
  void notifyNewTenant({ tenant_id, user_id, path: "build_start" });

  let conductor_run_id: string;
  try {
    let reference_images: string[] = [];
    if (ideaImages.jpegs.length > 0) {
      try {
        reference_images = await storeIdeaImages(tenant_id, ideaImages.jpegs);
      } catch {
        res.status(503).json({
          error: { code: "reference_images_unavailable", message: "Your reference images could not be stored. Open your workspace and try the build again." },
          tenant_id,
          company_name: rawName,
        });
        return;
      }
      if (reference_images.length !== ideaImages.jpegs.length) {
        res.status(503).json({
          error: { code: "reference_images_unavailable", message: "Your reference images could not be stored. Open your workspace and try the build again." },
          tenant_id,
          company_name: rawName,
        });
        return;
      }
    }
    const started = await startProductBuildDetached({
      tenant_id,
      company_name: rawName,
      idea: cleanIdea,
      started_by_user_id: user_id,
      ...(reference_images.length ? { reference_images } : {}),
      ...(body.await_look_pick === true ? { await_look_pick: true } : {}),
      ...(templateChoice.template ? { site_template: templateChoice.template } : {}),
      ...(requestKey ? { onRunCreated: (run_id: string) => stampBuildRequestKey(tenant_id, run_id, requestKey) } : {}),
    });
    const run_id = started.conductor_run_id;
    conductor_run_id = run_id;
    void started.setup
      .then(() => requestConductorTick(inngest, run_id))
      .catch((e: unknown) => {
        console.warn(`[build-start] site setup failed for ${tenant_id} run=${run_id}: ${(e as Error).message}`);
      });
    if (requestKey) await recordStartClaim(sb, user_id, requestKey, claimToken, { tenant_id, conductor_run_id });
  } catch (e) {
    if (e instanceof DuplicateBuildRequest) {
      if (requestKey) await recordStartClaim(sb, user_id, requestKey, claimToken, { tenant_id, conductor_run_id: e.conductor_run_id });
      res.json({ ok: true, tenant_id, conductor_run_id: e.conductor_run_id, replayed: true });
      return;
    }
    const sendRefusalNote = (reason: string) => {
      void (async () => {
        try {
          const alreadySent = await getBoolSetting("welcome_email_sent", tenant_id);
          if (alreadySent) return;
          const result = await sendBuildNotStartedEmail({
            user_id,
            displayName: rawName,
            workspaceUrl: workspaceUrl(),
            reason,
          });
          if (result.sent) {
            await setTenantSetting(tenant_id, "welcome_email_sent", true, user_id);
          }
        } catch (mailErr) {
          console.warn(
            `[build-start] build-not-started email failed for ${tenant_id}: ${(mailErr as Error).message}`,
          );
        }
      })();
    };

    if (e instanceof DoubleBuildInFlight) {
      let run_id: string | null = null;
      try {
        const { data: row } = await tenantClient(asTenantId(tenant_id))
          .from("conductor_runs")
          .select("id")
          .in("status", ["provisioning", "active"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        run_id = (row as { id?: string } | null)?.id ?? null;
      } catch {
      }
      res.status(409).json({
        error: { code: "build_already_in_progress", message: (e as Error).message },
        tenant_id,
        company_name: rawName,
        ...(run_id ? { run_id } : {}),
      });
      return;
    }
    if (e instanceof TooManyBuildsToday) {
      sendRefusalNote((e as Error).message);
      res.status(429).json({
        error: { code: "daily_build_limit_reached", message: (e as Error).message },
        tenant_id,
        company_name: rawName,
      });
      return;
    }
    if (e instanceof InsufficientCreditsForBuild) {
      const refusal = refusalFor({
        kind: "credits_for_build",
        required_credits: e.required_credits,
        remaining_credits: e.remaining_credits,
        free_plan: e.free_plan,
      });
      void notifyFounderActivity({
        event: "out_of_credits",
        tenant_id,
        user_id,
        details: {
          refused: "insufficient_credits_for_build",
          where: "first app build",
          required_credits: e.required_credits,
          remaining_credits: e.remaining_credits,
        },
      });
      sendRefusalNote(
        e.free_plan
          ? refusal.message
          : `This build needs about ${e.required_credits.toLocaleString("en-US")} credits and your workspace has ${e.remaining_credits.toLocaleString("en-US")} credits.`,
      );
      res.status(402).json({
        error: {
          code: "insufficient_credits_for_build",
          message: refusal.message,
          required_credits: e.required_credits,
          remaining_credits: e.remaining_credits,
          free_plan: e.free_plan,
        },
        tenant_id,
        company_name: rawName,
      });
      return;
    }
    if (e instanceof ProvisionBudgetExceeded) {
      sendRefusalNote((e as Error).message);
      res.status(402).json({
        error: { code: "provision_budget_exceeded", message: (e as Error).message },
        tenant_id,
        company_name: rawName,
      });
      return;
    }
    if (e instanceof BuildRepoNotProvisioned) {
      res.status(503).json({
        error: buildSetupFailedBody(e),
        tenant_id,
        company_name: rawName,
      });
      return;
    }
    res.status(500).json({
      error: { code: "build_start_failed", message: (e as Error).message },
      tenant_id,
      company_name: rawName,
    });
    return;
  }

  try {
    await inngest.send({
      name: "tenant.bootstrap_anchors.requested",
      data: { tenant_id, seed_text: safeSeed },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[build-start] bootstrap_anchors event send failed for ${tenant_id}: ${(e as Error).message}`);
  }

  void (async () => {
    try {
      const alreadySent = await getBoolSetting("welcome_email_sent", tenant_id);
      if (alreadySent) return;
      const result = await sendWelcomeBuildEmail({
        user_id,
        displayName: rawName,
        buildUrl: buildUrl(conductor_run_id),
      });
      if (result.sent) {
        await setTenantSetting(tenant_id, "welcome_email_sent", true, user_id);
      }
    } catch (e) {
      console.warn(
        `[build-start] welcome email send failed for ${tenant_id}: ${(e as Error).message}`,
      );
    }
  })();

  void enrolFromDayOne({ tenant_id, user_id });

  res.json({ ok: true, tenant_id, conductor_run_id });
}

