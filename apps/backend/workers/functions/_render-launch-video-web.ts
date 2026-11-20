
import { NonRetriableError } from "inngest";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { intakeToVideoBrief, launchVideoIntakeSchema, totalBriefFrames } from "@/services/launch-video/brief-mapper";
import { authorFilm } from "@/services/launch-video/authored-film";
import { intakeToFilmContent, buildThemeFilmSource } from "@/services/launch-video/theme-film";
import { chooseTemplate, extractFilmFacts, type FilmFacts } from "@/services/launch-video/film-facts";
import { filmFrames } from "@/services/launch-video/theme-film-types";
import { loadAuthoringReferences } from "@/services/launch-video/authoring-references";
import { resolveTenantBrandKit } from "./_launch-video-brand-kit";
import { lintVideoBrief } from "@/services/launch-video/lint";
import { checkTestimonialProvenance } from "@/services/launch-video/testimonial-grounding";
import { renderLaunchVideoAspects, LaunchVideoRenderError } from "@/services/launch-video/render";
import { getJobById, updateJob } from "@/services/launch-video-public/store";
import { checkCaps } from "@/services/launch-video-public/caps";
import { CALM_MIN_SECONDS, FPS } from "@/services/launch-video-public/compose";

const LAUNCH_VIDEO_BUCKET = "launch-video-artifacts";
const WATERMARK_TEXT = "zaviagent.com";
const DEFAULT_MUSIC_FILE = "assets/default-music.mp3";
const KILL_SWITCH = "launch_video_public_enabled" as const;

type WebEventData = {
  job_id?: string;
  run_id?: string;
  intake?: Record<string, unknown>;
};

async function persistArtifact(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  job_id: string,
  filename: string,
  bytes: Uint8Array,
  title: string,
): Promise<string> {
  const storagePath = `${tenant_id}/${job_id}/${filename}`;
  const { error: upErr } = await sb.storage
    .from(LAUNCH_VIDEO_BUCKET)
    .upload(storagePath, Buffer.from(bytes), { contentType: "video/mp4", upsert: true });
  if (upErr) throw new Error(`artifact upload failed (${filename}): ${upErr.message}`);
  const { data, error: rowErr } = await sb
    .from("run_artifacts")
    .upsert(
      {
        tenant_id,
        run_id: job_id,
        storage_path: storagePath,
        bucket: LAUNCH_VIDEO_BUCKET,
        filename,
        mime: "video/mp4",
        bytes: bytes.byteLength,
        agent_slug: "launch-video-public",
        title,
      },
      { onConflict: "tenant_id,run_id,filename" },
    )
    .select("id")
    .single<{ id: string }>();
  if (rowErr || !data?.id) throw new Error(`run_artifacts upsert failed (${filename}): ${rowErr?.message ?? "no id"}`);
  return data.id;
}

export type WebLaunchVideoResult = {
  ok?: boolean;
  skipped?: string;
  job_id?: string;
  email?: string | null;
  alreadyDone?: boolean;
};

export async function handleWebLaunchVideoRender(args: {
  event: { data: WebEventData };
  logger: { warn: (msg: string) => void };
}): Promise<WebLaunchVideoResult> {
  const { event, logger } = args;
  const jobId = event.data.job_id || event.data.run_id;
  if (!jobId) throw new NonRetriableError("render-launch-video[web]: missing job_id");

  const sb = serviceClient();

  const job = await getJobById(jobId);
  if (!job) throw new NonRetriableError(`render-launch-video[web]: no job row for ${jobId}`);
  const tenant_id = job.tenant_id;

  if (job.status === "ready" || job.status === "claimed") {
    return { ok: true, skipped: "already_done", alreadyDone: true, job_id: jobId, email: job.email };
  }

  const failJob = async (error: string): Promise<void> => {
    try {
      await updateJob(jobId, { status: "failed", error });
    } catch (e) {
      logger.warn(`render-launch-video[web]: failed to mark job ${jobId} failed: ${(e as Error).message}`);
    }
  };

  const enabled = await getBoolSetting(KILL_SWITCH);
  if (!enabled) {
    await failJob("disabled");
    return { skipped: "kill_switch_off" };
  }
  const cap = await checkCaps({ ip_hash: job.ip_hash });
  if (!cap.allowed) {
    await failJob("capped");
    return { skipped: "capped" };
  }

  const parsed = launchVideoIntakeSchema.safeParse(job.intake);
  if (!parsed.success) {
    await failJob("invalid_intake");
    throw new NonRetriableError(`render-launch-video[web]: invalid intake for job ${jobId}`);
  }

  await updateJob(jobId, { status: "rendering" });

  try {
    if (parsed.data.video_type === "testimonial") {
      if (Array.isArray(parsed.data.scenes) && parsed.data.scenes.length > 0) {
        await failJob("testimonial_authored_scenes");
        throw new NonRetriableError(`render-launch-video[web]: authored-scenes testimonial rejected job ${jobId}`);
      }
      const prov = checkTestimonialProvenance(parsed.data.testimonials);
      if (!prov.ok) {
        await failJob("testimonial_unsourced");
        throw new NonRetriableError(`render-launch-video[web]: unsourced testimonial rejected job ${jobId}`);
      }
    }
    const brandKit = await resolveTenantBrandKit(tenant_id, sb);
    const brief = intakeToVideoBrief(parsed.data, { brandKit });
    brief.music = { file: DEFAULT_MUSIC_FILE };
    const lint = lintVideoBrief(brief, parsed.data.video_type ?? "launch", {
      avoid: parsed.data.avoid,
      festival: parsed.data.festival,
    });
    if (!lint.ok) {
      await failJob("lint_rejected");
      throw new NonRetriableError(
        `render-launch-video[web]: lint rejected job ${jobId}: ${lint.violations.map((v) => v.code).join(",")}`,
      );
    }

    let authoredTsx: string | undefined;
    let authoredFrames: number | undefined;
    let themeFilm = false;
    let otherTemplate: "in_use" | "journey" | undefined;
    let refill: (() => { tsx: string; frames: number }) | undefined;
    if (parsed.data.video_type !== "testimonial" && (await getBoolSetting("launch_video_theme_film_enabled"))) {
      const formInput = (job.form_input ?? {}) as Record<string, unknown>;
      const asked = typeof formInput.film === "string" ? (formInput.film as string) : undefined;
      let filmIntake = parsed.data as unknown as Record<string, unknown>;
      let theme = asked;
      if (!asked) {
        const facts: FilmFacts = (await getBoolSetting("launch_video_film_facts_enabled"))
          ? await extractFilmFacts({ url: parsed.data.url, intake: filmIntake, avoid: parsed.data.avoid })
          : { dropped: ["setting off"] };
        if (facts.dropped.length > 0) {
          // eslint-disable-next-line no-console
          console.info(`[launch-video] film facts for job ${jobId} dropped: ${facts.dropped.slice(0, 12).join("; ")}`);
        }
        filmIntake = {
          ...filmIntake,
          ...(facts.in_use ? { in_use: facts.in_use } : {}),
          ...(facts.journey ? { journey: facts.journey } : {}),
          ...(facts.brand ? { brand: { accent: facts.brand.accent } } : {}),
        };
        theme = chooseTemplate(facts);
        otherTemplate = theme === "in_use" ? "journey" : "in_use";
      }
      const fill = (t: string | undefined) => {
        const content = intakeToFilmContent(filmIntake, { theme: t });
        return { tsx: buildThemeFilmSource(content), frames: filmFrames(content) };
      };
      ({ tsx: authoredTsx, frames: authoredFrames } = fill(theme));
      refill = otherTemplate ? () => fill(otherTemplate) : undefined;
      themeFilm = true;
    } else if (parsed.data.video_type !== "testimonial" && (await getBoolSetting("launch_video_authored_enabled"))) {
      const refs = loadAuthoringReferences();
      if (refs) {
        const formInput = (job.form_input ?? {}) as Record<string, unknown>;
        const g = formInput.grammar;
        const asked = g === "dense" || g === "calm" ? g : undefined;
        const filmSeconds = totalBriefFrames(brief.beats) / FPS;
        const grammar = asked === "calm" && filmSeconds < CALM_MIN_SECONDS ? "dense" : asked;
        const authored = await authorFilm({
          intake: parsed.data as unknown as Record<string, unknown>,
          targetFrames: totalBriefFrames(brief.beats),
          technique: refs.technique,
          exemplar: refs.exemplar,
          ...(grammar ? { grammar } : {}),
        });
        if (authored.ok) {
          authoredTsx = authored.tsx;
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[launch-video] authoring skipped for job ${jobId}: ${authored.error}`);
        }
      }
    }

    let gate = themeFilm && refill !== undefined;
    const renderOnce = (tsx?: string) =>
      renderLaunchVideoAspects({
        tenant_id,
        brief,
        audio: new Map(),
        images: [],
        videos: [],
        aspects: [brief.aspect ?? "16:9"],
        watermark: { text: WATERMARK_TEXT },
        ...(tsx
          ? {
              authoredTsx: tsx,
              authoredFrames: authoredFrames ?? totalBriefFrames(brief.beats),
              ...(gate ? { gateThemeFilm: true } : {}),
            }
          : {}),
      });

    let results: Awaited<ReturnType<typeof renderOnce>>["results"];
    try {
      try {
        ({ results } = await renderOnce(authoredTsx));
      } catch (e) {
        if (!(e instanceof LaunchVideoRenderError) || e.code !== "film_gate_failed" || !refill) throw e;
        // eslint-disable-next-line no-console
        console.warn(`[launch-video] film gate rejected the first template for job ${jobId}, drawing ${otherTemplate}: ${e.message.slice(0, 300)}`);
        gate = false;
        ({ tsx: authoredTsx, frames: authoredFrames } = refill());
        ({ results } = await renderOnce(authoredTsx));
      }
    } catch (e) {
      const code = e instanceof LaunchVideoRenderError ? e.code : "";
      const filmCouldCause =
        code === "render_failed" || code === "render_empty" || code === "authored_lockdown_failed";
      if (!authoredTsx || !filmCouldCause) throw e;
      if (themeFilm) {
        // eslint-disable-next-line no-console
        console.error(`[launch-video] THEME FILM FAILED for job ${jobId}: ${(e as Error).message.slice(0, 400)}`);
        throw e;
      }
      // eslint-disable-next-line no-console
      console.warn(`[launch-video] authored render failed for job ${jobId}, falling back: ${(e as Error).message.slice(0, 200)}`);
      ({ results } = await renderOnce());
    }
    const out = results[0];
    if (!out) throw new LaunchVideoRenderError("render_empty", "no aspect rendered");
    if (!out.previewBytes || out.previewBytes.byteLength === 0) {
      throw new LaunchVideoRenderError("watermark_missing", "no watermarked preview produced");
    }

    const hdId = await persistArtifact(sb, tenant_id, jobId, "hd.mp4", out.bytes, "Launch video (HD)");
    const previewId = await persistArtifact(
      sb,
      tenant_id,
      jobId,
      "preview.mp4",
      out.previewBytes,
      "Launch video (preview, watermarked)",
    );

    await updateJob(jobId, {
      status: "ready",
      hd_artifact_id: hdId,
      preview_artifact_id: previewId,
    });

    return { ok: true, job_id: jobId, email: job.email };
  } catch (e) {
    const reason =
      e instanceof LaunchVideoRenderError ? e.code : e instanceof NonRetriableError ? "render_failed" : "render_error";
    if (job.status !== "failed") await failJob(reason);
    if (e instanceof NonRetriableError) throw e;
    throw new NonRetriableError(`render-launch-video[web]: ${(e as Error).message}`);
  }
}
