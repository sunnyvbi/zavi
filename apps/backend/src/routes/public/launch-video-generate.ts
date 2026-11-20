
import type { Request, Response } from "express";
import { getBoolSetting } from "@/services/settings";
import { serviceClient } from "@/services/supabase";
import { inngest } from "@/../workers/client";
import { renderLaneKeys } from "@/../workers/functions/_render-launch-video-lanes";
import { intakeToVideoBrief, launchVideoIntakeSchema, type LaunchVideoIntake } from "@/services/launch-video/brief-mapper";
import { lintVideoBrief } from "@/services/launch-video/lint";
import { checkTestimonialProvenance } from "@/services/launch-video/testimonial-grounding";
import {
  validateGenerateBody,
  deriveShellSlug,
  isUpstreamUnavailable,
  isModerationOutage,
} from "@/services/launch-video-public/request";
import { authorIntake, moderateForm } from "@/services/launch-video-public/authoring";
import { composePublicVideo, TARGET_SECONDS } from "@/services/launch-video-public/compose";
import { checkAttemptCap, checkCaps } from "@/services/launch-video-public/caps";
import { verifyTurnstile, turnstileSiteKey } from "@/services/launch-video-public/captcha";
import { createJob, generateClientSecret, hashSecret, hashIp } from "@/services/launch-video-public/store";
import { parseSignupAttribution } from "@/services/tenants/signup-attribution";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

function clientIp(req: Request): string | null {
  return req.ip || req.socket?.remoteAddress || null;
}

export async function launchVideoPublicGenerate(req: Request, res: Response): Promise<void> {
  const enabled = await getBoolSetting("launch_video_public_enabled");
  if (!enabled) {
    res.status(404).json({ error: { code: "not_found", message: "Not found." } });
    return;
  }

  const parsed = validateGenerateBody(req.body);
  if (!parsed.ok) {
    const VALIDATION_MESSAGES: Record<string, string> = {
      too_many_metrics: "Real numbers takes up to 3 lines. Remove one and try again.",
      metric_value_too_long: "One of your numbers is too long. Keep the value short, like '$1.2M' or '400+'.",
      metric_label_too_long: "One of your number labels is too long. Shorten it and try again.",
      too_many_regions: "Where you operate takes up to 8 places. Remove a few and try again.",
      too_few_regions: "Name a second place, or clear Where you operate to skip that scene.",
      metric_line_invalid: "Each number needs both sides, like Teachers|400+.",
      region_too_long: "One of those place names is too long. Shorten it and try again.",
      invalid_email: "That email address doesn't look right.",
      missing_cta_url: "We need your website. It's also where the video's button points.",
      missing_cta_text: "Tell us what the closing button should say.",
      field_too_long: "One of the fields is too long. Shorten it and try again.",
    };
    res.status(400).json({
      error: {
        code: parsed.error,
        message: VALIDATION_MESSAGES[parsed.error] ?? "Please check the form and try again.",
        recoverable: true,
      },
    });
    return;
  }
  const { email, company, form } = parsed.value;
  const attribution = parseSignupAttribution(req.body?.attribution);

  const ip = clientIp(req);
  const ip_hash = ip ? hashIp(ip) : null;

  const captchaToken = typeof req.body?.captcha_token === "string" ? req.body.captcha_token : null;

  if (await getBoolSetting("launch_video_public_captcha_required")) {
    const verdict = turnstileSiteKey()
      ? await verifyTurnstile({ token: captchaToken, ip })
      : ({ ok: false, reason: "misconfigured" } as const);
    if (!verdict.ok) {
      const ours = verdict.reason === "misconfigured" || verdict.reason === "unavailable";
      res.status(ours ? 503 : 400).json({
        error: {
          code: ours ? "captcha_unavailable" : "captcha_failed",
          message: ours
            ? "We can't verify your request right now. Please try again in a moment."
            : "Please complete the verification and try again.",
        },
      });
      return;
    }
  }

  const cap = await checkCaps({ ip_hash });
  if (!cap.allowed) {
    res.status(429).json({
      error: { code: "rate_limited", message: "We've hit today's free-video limit. Please try again tomorrow." },
    });
    return;
  }

  const attempt = await checkAttemptCap({ ip_hash });
  if (!attempt.allowed) {
    if (attempt.reason === "cap") {
      res.status(429).json({
        error: {
          code: "attempt_limited",
          message: "Too many tries recently. Please wait a bit and try again.",
        },
      });
      return;
    }
    res.status(500).json({
      error: { code: "server_error", message: "Something went wrong. Please try again." },
    });
    return;
  }

  if (await getBoolSetting("launch_video_public_moderation_enabled")) {
    let moderation;
    try {
      moderation = await moderateForm(form);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[launch-video] moderation call failed: ${(e as Error).message}`);
      res.status(503).json({
        error: {
          code: "moderation_unavailable",
          message: "We couldn't check your details just now. Please try again in a minute.",
        },
      });
      return;
    }
    if (!moderation.allowed && isModerationOutage(moderation.reason)) {
      // eslint-disable-next-line no-console
      console.error(`[launch-video] moderation unavailable: ${moderation.reason}`);
      res.status(503).json({
        error: {
          code: "moderation_unavailable",
          message: "We couldn't check your details just now. Please try again in a minute.",
        },
      });
      return;
    }
    if (!moderation.allowed) {
      res.status(422).json({
        error: { code: "content_rejected", message: "We can't generate a video from that content." },
      });
      return;
    }
  }

  let authored = await authorIntake(form);
  if (!authored.ok && !isUpstreamUnavailable(authored.error)) {
    // eslint-disable-next-line no-console
    console.warn(`[launch-video] authoring attempt 1 rejected: ${authored.error}`);
    authored = await authorIntake(form);
  }
  if (!authored.ok) {
    if (isUpstreamUnavailable(authored.error)) {
      // eslint-disable-next-line no-console
      console.error(`[launch-video] authoring upstream unavailable: ${authored.error}`);
      res.status(503).json({
        error: {
          code: "authoring_unavailable",
          message: "We couldn't build your video just now. Please try again in a minute.",
        },
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.error(`[launch-video] authoring failed twice: ${authored.error}`);
    res.status(422).json({
      error: {
        code: "author_failed",
        message: "I could not turn these details into a film. Check them over, then try again.",
      },
    });
    return;
  }
  const authoredIntake = {
    ...(authored.intake as LaunchVideoIntake),
    theme: form.theme,
    video_type: "launch",
  } as LaunchVideoIntake;

  let intake = authoredIntake;
  if (authoredIntake.video_type !== "testimonial") {
    const plan = composePublicVideo({
      product_name: authoredIntake.product_name,
      one_liner: authoredIntake.one_liner,
      ...(authoredIntake.problem ? { problem: authoredIntake.problem } : {}),
      features: (authoredIntake.features ?? []).map((f) => ({ title: f.title, detail: f.detail })),
      ...(authoredIntake.product_surface
        ? {
            product_surface: {
              header: authoredIntake.product_surface.header ?? { title: authoredIntake.product_name.slice(0, 60) },
              items: authoredIntake.product_surface.items.map((i) => ({
                title: i.title,
                chips: i.chips,
                ...(i.glyph ? { glyph: i.glyph } : {}),
              })),
            },
          }
        : {}),
      ...(authoredIntake.metrics ? { metrics: authoredIntake.metrics } : {}),
      ...(authoredIntake.proof ? { proof: authoredIntake.proof } : {}),
      ...(authoredIntake.coverage ? { coverage: authoredIntake.coverage } : {}),
      cta_text: authoredIntake.cta_text,
      cta_url: authoredIntake.cta_url,
    });
    if (!plan.meets_target) {
      res.status(422).json({
        error: {
          code: "insufficient_material",
          message: `There is enough here for about ${Math.round(plan.seconds)} seconds. A launch film needs ${TARGET_SECONDS}.`,
          seconds: plan.seconds,
          target_seconds: TARGET_SECONDS,
          missing: plan.missing,
        },
      });
      return;
    }
    const composed = { ...authoredIntake, scenes: plan.scenes };

    const recheck = launchVideoIntakeSchema.safeParse(composed);
    if (!recheck.success) {
      // eslint-disable-next-line no-console
      console.error(
        `[launch-video] composed intake failed its own schema: ${recheck.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(" | ")}`,
      );
      res.status(422).json({
        error: { code: "brief_invalid", message: "We couldn't build a video from that. Try shortening the longest lines." },
      });
      return;
    }
    intake = composed;
  }

  if (intake.video_type === "testimonial") {
    if (Array.isArray(intake.scenes) && intake.scenes.length > 0) {
      res.status(422).json({
        error: { code: "testimonial_authored_scenes", message: "A testimonial video's quotes must be real, sourced reviews. Hand-authored scenes aren't allowed here." },
      });
      return;
    }
    const prov = checkTestimonialProvenance(intake.testimonials);
    if (!prov.ok) {
      res.status(422).json({
        error: { code: "testimonial_unsourced", message: "We can't build a testimonial video without real, sourced review quotes." },
      });
      return;
    }
  }

  try {
    const brief = intakeToVideoBrief(intake);
    const lint = lintVideoBrief(brief, intake.video_type ?? "launch", {
      avoid: intake.avoid,
      festival: intake.festival,
    });
    if (!lint.ok) {
      res.status(422).json({
        error: { code: "lint_rejected", message: "We can't generate a video with those claims." },
      });
      return;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[launch-video] brief build threw: ${(e as Error)?.message?.slice(0, 200)}`);
    res.status(422).json({
      error: { code: "brief_invalid", message: "I could not turn these details into a film. Check them over, then try again." },
    });
    return;
  }

  const sb = serviceClient();
  const { data: shellTenantId, error: shellErr } = await sb.rpc("create_launch_video_shell_tenant", {
    p_slug: deriveShellSlug(company || form.product_name),
    p_display_name: company || form.product_name,
  });
  if (shellErr || !shellTenantId || typeof shellTenantId !== "string") {
    // eslint-disable-next-line no-console
    console.error("[launch-video/generate] shell create failed", { msg: shellErr?.message });
    res.status(500).json({ error: { code: "provision_failed", message: "Something went wrong. Please try again." } });
    return;
  }

  const secret = generateClientSecret();
  let jobId: string;
  try {
    jobId = await createJob({
      tenant_id: shellTenantId,
      ip_hash,
      client_secret_hash: hashSecret(secret),
      email,
      form_input: { ...form, company, ...(attribution ? { signup_attribution: attribution } : {}) },
      intake,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[launch-video/generate] job insert failed", { msg: (e as Error).message });
    res.status(500).json({ error: { code: "provision_failed", message: "Something went wrong. Please try again." } });
    return;
  }

  try {
    await inngest.send({
      name: "video.render.requested",
      id: `lvp-${jobId}`,
      data: {
        run_id: jobId,
        job_id: jobId,
        delivery: "web",
        tenant_id: shellTenantId,
        ...renderLaneKeys({ run_id: jobId, job_id: jobId, delivery: "web", tenant_id: shellTenantId }),
        intake: intake as unknown as Record<string, unknown>,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[launch-video/generate] enqueue failed", { msg: (e as Error).message });
    res.status(500).json({ error: { code: "enqueue_failed", message: "Couldn't start the render. Please try again." } });
    return;
  }

  void notifyFounderActivity({
    event: "launch_video_requested",
    email,
    details: { company, product: form.product_name, website: form.cta_url, one_liner: form.one_liner, job_id: jobId },
  });

  res.status(200).json({ job_id: jobId, secret });
}
