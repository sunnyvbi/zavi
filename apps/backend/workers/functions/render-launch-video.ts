
import { NonRetriableError } from "inngest";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { trackMediaGenerated } from "@/services/analytics/action-events";
import { isRenderLaunchVideoEnabled } from "@/services/agents/_render-launch-video-flag-check";
import {
  intakeToVideoBrief,
  launchVideoIntakeSchema,
  type Aspect,
  type BrandKit,
  type VideoType,
} from "@/services/launch-video/brief-mapper";
import { resolveRenderAspects, aspectArtifactFilename } from "@/services/launch-video/aspect-artifacts";
import { buildAdDraftHandoff, adArtifactHandoffMeta } from "@/services/launch-video/ad-handoff";
import { logHandoffIntent } from "@/services/agents/handoff-intent";
import { resolveScriptVariants, capVariantsForAspects, applyHookPack } from "@/services/launch-video/script-variants";
import { lintVideoBrief, formatLintAdvisory, selectAdvisories } from "@/services/launch-video/lint";
import { synthesizeBeatVo, describeVoOutcome, type TtsFailureReason } from "@/services/launch-video/vo";
import { generateBeatMedia } from "@/services/launch-video/media";
import { flushCharges, type PendingCharge } from "@/services/media-router/charge";
import {
  captureProductStill,
  resolveCaptureTarget,
  stripImagePromptAt,
  captureImageFor,
  type CaptureTarget,
} from "@/services/launch-video/capture-bridge";
import { renderLaunchVideoAspects, LaunchVideoRenderError, type AspectRenderResult } from "@/services/launch-video/render";
import { uploadFileToThread } from "@/services/tools/slack/upload_file";
import { deliverArtifactToThread } from "@/services/agents/deliver-artifact-to-thread";
import type { VideoDeliveryTarget } from "@/services/launch-video/delivery-target";
import { callSlackTool } from "@/services/mcp/internal/slack";
import { handleWebLaunchVideoRender } from "./_render-launch-video-web";
import { sendLaunchVideoClaimEmail } from "@/email/sendAuthEmail";
import { PUBLIC_RENDER_CONCURRENCY } from "./_render-launch-video-lanes";
import { resolveTenantBrandKit } from "./_launch-video-brand-kit";

const LAUNCH_VIDEO_BUCKET = "launch-video-artifacts";

export const renderLaunchVideoFn = inngest.createFunction(
  {
    id: "render-launch-video",
    retries: 1,
    concurrency: [
      { key: "event.data.tenant_lane_key", limit: 1 },
      { key: "event.data.public_lane_key", limit: PUBLIC_RENDER_CONCURRENCY },
    ],
    idempotency: "event.data.run_id",
  },
  { event: "video.render.requested" },
  (ctx) => renderLaunchVideoHandler(ctx as unknown as RenderLaunchVideoCtx),
);

export type RenderLaunchVideoCtx = {
  event: {
    data: {
      run_id: string;
      tenant_id?: string;
      intake: Record<string, unknown>;
      delivery?: "slack" | "web";
      job_id?: string;
      delivery_target?: VideoDeliveryTarget;
      channel_id?: string;
      thread_ts?: string;
      team_id?: string | null;
    };
  };
  step: { run: <T>(name: string, fn: () => T | Promise<T>) => Promise<T> };
  logger: { info: (m: string) => void; warn: (m: string) => void };
};

async function sendClaimEmailFailSoft(
  email: string,
  jobId: string,
  logger: { warn: (m: string) => void },
): Promise<{ sent: boolean }> {
  try {
    await sendLaunchVideoClaimEmail(email, jobId);
    return { sent: true };
  } catch (e) {
    logger.warn(`render-launch-video[web]: claim email send failed for job ${jobId}: ${(e as Error).message}`);
    return { sent: false };
  }
}

export async function renderLaunchVideoHandler({ event, step, logger }: RenderLaunchVideoCtx): Promise<unknown> {
  {
    if (event.data.delivery === "web") {
      const web = await handleWebLaunchVideoRender({ event, logger });

      if (web.email && web.job_id) {
        const email = web.email;
        const jobId = web.job_id;
        await step.run("send-claim-email", () => sendClaimEmailFailSoft(email, jobId, logger));
      }

      return web;
    }

    const { run_id, intake: rawIntake, channel_id, thread_ts, team_id } = event.data;
    if (!run_id) throw new NonRetriableError("render-launch-video: missing run_id");
    const target: VideoDeliveryTarget | null =
      (event.data.delivery_target as VideoDeliveryTarget | undefined) ??
      (channel_id ? { kind: "slack", channel_id, thread_ts, team_id: team_id ?? null } : null);
    if (!target) throw new NonRetriableError("render-launch-video: no delivery target");
    const slackTarget = target.kind === "slack" ? target : null;

    const sb = serviceClient();

    const { data: runRow, error: runErr } = await step.run("derive-tenant-c8-reverified", async () =>
      sb.from("agent_runs").select("tenant_id").eq("id", run_id).maybeSingle<{ tenant_id: string }>(),
    );
    if (runErr) throw new Error(`render-launch-video: agent_runs read failed: ${runErr.message}`);
    const tenant_id = runRow?.tenant_id;
    if (!tenant_id) throw new NonRetriableError(`render-launch-video: no agent_runs row for ${run_id}`);

    const enabled = await step.run("flag-check", () => isRenderLaunchVideoEnabled(tenant_id, sb));
    if (!enabled) {
      logger.warn(`render-launch-video: flag OFF for tenant ${tenant_id} — skipping (run ${run_id})`);
      return { skipped: "flag_off" };
    }

    const parsed = launchVideoIntakeSchema.safeParse(rawIntake);
    if (!parsed.success) {
      await postFailure(tenant_id, target, run_id, "the video brief was incomplete");
      throw new NonRetriableError(`render-launch-video: invalid intake: ${parsed.error.message}`);
    }
    const brandKit = await resolveTenantBrandKit(tenant_id, sb);
    const videoType: VideoType = parsed.data.video_type ?? "launch";

    const packedIntake = applyHookPack(parsed.data);
    const isPack = packedIntake !== parsed.data;

    const allVariants = resolveScriptVariants(packedIntake);

    const baseBrief = intakeToVideoBrief(allVariants[0].intake, { brandKit });
    const aspects: Aspect[] = resolveRenderAspects(parsed.data.aspects, baseBrief.aspect);

    const { kept: variants, capped } = capVariantsForAspects(allVariants, aspects.length);
    if (capped) {
      logger.warn(
        `render-launch-video: capped ${allVariants.length} variant(s) → ${variants.length} at ${aspects.length} aspect(s) ` +
          `(max outputs, run ${run_id})`,
      );
    }
    const multiVariant = variants.length > 1;

    const perVariantBudget = isPack ? Math.max(1, Math.floor(150 / variants.length)) : 150;

    const built = variants.map((v, i) => ({
      label: v.label,
      intake: v.intake,
      brief: i === 0 ? baseBrief : intakeToVideoBrief(v.intake, { brandKit }),
    }));

    const advisoryByLabel = new Map<string, string>();
    for (const b of built) {
      const lint = lintVideoBrief(b.brief, videoType, { avoid: b.intake.avoid, festival: b.intake.festival });
      const tag = multiVariant ? ` variant ${b.label}` : "";
      if (!lint.ok) {
        logger.warn(
          `render-launch-video: lint flagged ${lint.violations.length} issue(s) on ${videoType}${tag} (advisory, run ${run_id}): ${lint.violations
            .map((v) => v.code)
            .join(", ")}`,
        );
      }
      if (lint.caveats.length > 0) logger.info(`render-launch-video: lint caveats${tag} (run ${run_id}): ${lint.caveats.join(" ")}`);
      const advisory = formatLintAdvisory(lint);
      if (advisory) advisoryByLabel.set(b.label, advisory);
    }

    const voiceId = brandKit?.voiceId ?? (await resolveVoiceId(sb));

    let capturePng: Buffer | null = null;
    if (parsed.data.capture_url) {
      const cap = await captureProductStill({ tenant_id, run_id, url: parsed.data.capture_url });
      if (cap.ok) {
        capturePng = cap.png;
        logger.info(`render-launch-video: real-UI capture OK (${cap.png.byteLength}B, run ${run_id})`);
      } else {
        logger.info(`render-launch-video: real-UI capture skipped → stylized fallback: ${cap.reason} (run ${run_id})`);
      }
    }

    type TaggedResult = AspectRenderResult & { label: string };
    const results: TaggedResult[] = [];
    let voicedBeats = 0;
    let ttsBlocked: TtsFailureReason | null = null;
    const pendingByLabel = new Map<string, PendingCharge[]>();
    for (const b of built) {
      const vo = await synthesizeBeatVo({ tenant_id, run_id, beats: b.brief.beats, voiceId, variant: b.label });
      const audio = vo.audio;
      if (vo.blocked && !ttsBlocked) ttsBlocked = vo.blocked;
      const pending: PendingCharge[] = [...vo.pendingCharges];

      let captureTarget: CaptureTarget | null = null;
      if (capturePng) {
        captureTarget = resolveCaptureTarget(b.brief);
        if (captureTarget) stripImagePromptAt(b.brief, captureTarget);
      }

      let images: Awaited<ReturnType<typeof generateBeatMedia>>["images"] = [];
      let videos: Awaited<ReturnType<typeof generateBeatMedia>>["videos"] = [];
      try {
        const media = await generateBeatMedia(b.brief, {
          budgetCredits: perVariantBudget,
          tenant_id,
          run_id,
          variant: b.label,
        });
        images = media.images;
        videos = media.videos;
        pending.push(...media.pendingCharges);
        logger.info(
          `render-launch-video: media ${images.length} image(s) + ${videos.length} clip(s), ${media.creditsSpent}cr spent` +
            `${multiVariant ? ` (variant ${b.label})` : ""} (run ${run_id})`,
        );
        for (const line of media.log) logger.info(`render-launch-video/media: ${line}`);
      } catch (e) {
        logger.warn(`render-launch-video: media phase failed (fallback render): ${(e as Error).message}`);
      }

      if (capturePng && captureTarget) {
        images = [...images, captureImageFor(captureTarget, capturePng, b.label)];
        logger.info(
          `render-launch-video: injected real-UI capture at beat ${captureTarget.beatIndex}/${captureTarget.itemIndex ?? "hero"}` +
            `${multiVariant ? ` (variant ${b.label})` : ""} (run ${run_id})`,
        );
      }

      try {
        const r = await renderLaunchVideoAspects({ tenant_id, brief: b.brief, audio, images, videos, aspects });
        for (const res of r.results) results.push({ ...res, label: b.label });
        voicedBeats = Math.max(voicedBeats, r.results[0]?.voicedBeats ?? 0);
        if (pending.length > 0) pendingByLabel.set(b.label, pending);
      } catch (e) {
        const reason =
          e instanceof LaunchVideoRenderError
            ? e.code === "engine_tarball_missing"
              ? "the render engine isn't fully configured yet"
              : "the render didn't complete"
            : "the render didn't complete";
        await postFailure(tenant_id, target, run_id, reason);
        if (e instanceof LaunchVideoRenderError) {
          throw new NonRetriableError(`render-launch-video: ${e.code}: ${e.message}`);
        }
        throw e;
      }
    }

    const authoredVoBeats = built.reduce(
      (n, b) => n + b.brief.beats.filter((beat) => Boolean((beat as { vo?: { srtText?: string } }).vo?.srtText)).length,
      0,
    );
    const voOutcome = describeVoOutcome({ authoredVoBeats, voicedBeats, ttsBlocked });

    await step.run("persist-artifacts", async () => {
      for (const res of results) {
        const filename = aspectArtifactFilename(res.aspect, multiVariant ? res.label : undefined);
        const storagePath = `${tenant_id}/${run_id}/${filename}`;
        const { error: upErr } = await sb.storage
          .from(LAUNCH_VIDEO_BUCKET)
          .upload(storagePath, Buffer.from(res.bytes), { contentType: "video/mp4", upsert: true });
        if (upErr) throw new Error(`artifact upload failed (${filename}): ${upErr.message}`);
        const { error: rowErr } = await sb.from("run_artifacts").upsert(
          {
            tenant_id,
            run_id,
            storage_path: storagePath,
            bucket: LAUNCH_VIDEO_BUCKET,
            filename,
            mime: "video/mp4",
            bytes: res.bytes.byteLength,
            agent_slug: "operator",
            render_input: {
              ...(videoType === "ad"
                ? adArtifactHandoffMeta(res.aspect, multiVariant ? res.label : null)
                : {}),
              voiceover: {
                state: voOutcome.state,
                silent: voOutcome.silent,
                authored_beats: authoredVoBeats,
                voiced_beats: voicedBeats,
                blocked_reason: ttsBlocked,
              },
            },
          },
          { onConflict: "tenant_id,run_id,filename" },
        );
        if (rowErr) throw new Error(`run_artifacts upsert failed (${filename}): ${rowErr.message}`);
      }
      trackMediaGenerated({ tenant_id, media: "video", kind: "launch_video" });
    });

    for (const [label, pending] of pendingByLabel) {
      if (!results.some((r) => r.label === label)) continue;
      await step
        .run(`charge-media-${label}`, async () => {
          await flushCharges(pending);
          return { label, charges: pending.length };
        })
        .catch((e) => console.error(`[render-launch-video] charge-media-${label} gave up: ${(e as Error).message}`));
    }

    const multiOutput = results.length > 1;
    let slack_ok = 0;
    const deliveredLabels = new Set<string>();
    for (const res of results) {
      if (!slackTarget) {
        deliveredLabels.add(res.label);
        continue;
      }
      const filename = aspectArtifactFilename(res.aspect, multiVariant ? res.label : undefined);
      const titleSuffix = multiOutput
        ? ` (${[multiVariant ? `variant ${res.label}` : null, res.aspect].filter(Boolean).join(", ")}, v1 draft)`
        : " (v1 draft)";
      try {
        await uploadFileToThread({
          tenant_id,
          channel_id: slackTarget.channel_id,
          thread_ts: slackTarget.thread_ts,
          bytes: res.bytes,
          filename,
          title: `Your launch video${titleSuffix}`,
          team_id: slackTarget.team_id ?? undefined,
        });
        slack_ok++;
        deliveredLabels.add(res.label);
      } catch (e) {
        logger.warn(`render-launch-video: slack delivery soft-failed for ${filename}: ${(e as Error).message}`);
      }
    }

    const delivered = slackTarget ? slack_ok : results.length;

    if (voOutcome.silent && voOutcome.notice && delivered > 0 && slackTarget) {
      logger.warn(
        `render-launch-video: VO ${voOutcome.state} for every beat — delivering SILENT video with disclosure ` +
          `(${authoredVoBeats} authored line(s), run ${run_id})`,
      );
      try {
        await callSlackTool(
          tenant_id,
          "post_message",
          { channel_id: slackTarget.channel_id, thread_ts: slackTarget.thread_ts, text: voOutcome.notice },
          slackTarget.team_id ?? undefined,
        );
      } catch (e) {
        logger.warn(`render-launch-video: silent-video notice post soft-failed: ${(e as Error).message}`);
      }
    } else if (voOutcome.silent) {
      logger.warn(
        `render-launch-video: SILENT video (${voOutcome.state}), no Slack delivery to disclose on ` +
          `(${authoredVoBeats} authored line(s), run ${run_id})`,
      );
    }

    if (slack_ok > 0) {
      try {
        await sb
          .from("run_artifacts")
          .update({
            slack_delivered: true,
            slack_channel_id: slackTarget?.channel_id ?? null,
            slack_thread_ts: slackTarget?.thread_ts ?? null,
          })
          .eq("tenant_id", tenant_id)
          .eq("run_id", run_id)
          .in(
            "filename",
            results
              .filter((r) => deliveredLabels.has(r.label))
              .map((r) => aspectArtifactFilename(r.aspect, multiVariant ? r.label : undefined)),
          );
      } catch (e) {
        logger.warn(`render-launch-video: delivery bookkeeping update soft-failed: ${(e as Error).message}`);
      }
    }

    const advisoryText = selectAdvisories(advisoryByLabel, deliveredLabels, multiVariant);
    if (advisoryText && slackTarget) {
      try {
        await callSlackTool(
          tenant_id,
          "post_message",
          { channel_id: slackTarget.channel_id, thread_ts: slackTarget.thread_ts, text: advisoryText },
          slackTarget.team_id ?? undefined,
        );
      } catch (e) {
        logger.warn(`render-launch-video: lint advisory post soft-failed: ${(e as Error).message}`);
      }
    }

    let chat_delivered = false;
    if (target.kind === "chat") {
      const noun = results.length > 1 ? `${results.length} versions of your video are` : "Your video is";
      const body = [
        `${noun} ready — attached below.`,
        voOutcome.silent && voOutcome.notice ? voOutcome.notice : null,
        advisoryText,
      ]
        .filter(Boolean)
        .join("\n\n");
      chat_delivered = await deliverArtifactToThread({
        tenant_id,
        thread_id: target.thread_id,
        run_id,
        body,
        meta: { kind: "launch_video", aspects: results.map((r) => r.aspect) },
      });
      if (!chat_delivered) {
        logger.warn(
          `render-launch-video: chat delivery post failed (thread ${target.thread_id}, run ${run_id}) — ` +
            `artifact rows are written, the chip will appear on the next thread load`,
        );
      }
    }

    const adHandoff = buildAdDraftHandoff({
      videoType,
      outputs: results.map((r) => ({ aspect: r.aspect, label: r.label })),
      multiVariant,
    });
    if (adHandoff && delivered > 0) {
      await logHandoffIntent({
        tenant_id,
        source_agent_slug: "operator",
        target_agent_slug: "performance-marketer",
        surface: target.kind === "chat" ? "chat" : "slack",
        authorized: true,
        run_id,
      });
      logger.info(
        `render-launch-video: ad DRAFT handoff → performance-marketer, ${adHandoff.assets.length} placement-tagged ` +
          `creative(s), draft-only never-live (run ${run_id})`,
      );
    }

    return {
      ok: true,
      lint_advisories: advisoryText ? 1 : 0,
      variants: built.map((b) => b.label),
      aspects: results.map((r) => r.aspect),
      bytes: results.reduce((s, r) => s + r.bytes.byteLength, 0),
      voicedBeats,
      voiceover: voOutcome.state,
      slack_delivered: slack_ok,
      chat_delivered,
      ad_handoff: adHandoff ? { assets: adHandoff.assets.length, status: adHandoff.status, live: adHandoff.live } : null,
    };
  }
}

async function resolveVoiceId(sb: ReturnType<typeof serviceClient>): Promise<string | undefined> {
  try {
    const { data } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    const v = (data?.blob ?? {})["launch_video_voice_id"];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

async function postFailure(
  tenant_id: string,
  target: VideoDeliveryTarget,
  run_id: string,
  reason: string,
): Promise<void> {
  const text = `I couldn't finish your video — ${reason}. No credits were used. You can ask me to try again.`;
  try {
    if (target.kind === "chat") {
      await deliverArtifactToThread({
        tenant_id,
        thread_id: target.thread_id,
        run_id,
        body: text,
        meta: { kind: "launch_video_failed" },
      });
      return;
    }
    await callSlackTool(
      tenant_id,
      "post_message",
      { channel_id: target.channel_id, thread_ts: target.thread_ts, text },
      target.team_id ?? undefined,
    );
  } catch (e) {
    console.warn(`[render-launch-video] failure-message post failed: ${(e as Error).message}`);
  }
}
