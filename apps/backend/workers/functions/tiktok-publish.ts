import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  fetchTikTokPostStatus,
  initTikTokPost,
  publishTikTokVideoBytes,
  queryCreatorInfo,
  readTikTokVideoBytes,
} from "@/services/connectors/tiktok/api";
import { checkPublishText } from "@/services/connectors/social-publish-content-guard";

type Row = { id: string; tenant_id: string; content: any };

export const tiktokPublishFn = inngest.createFunction(
  { id: "tiktok-publish", retries: 3, concurrency: 1 },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const due = await step.run("load-due", async () => {
      const { data, error } = await serviceClient().from("tiktok_scheduled_posts")
        .select("id, tenant_id, content").eq("status", "scheduled")
        .lte("scheduled_at", new Date().toISOString()).order("scheduled_at").limit(25);
      if (error) throw new Error(`TikTok due-post read failed: ${error.message}`);
      return (data ?? []) as Row[];
    });

    const results = [];
    for (const candidate of due) {
      const result = await step.run(`publish-${candidate.id}`, async () => {
        const { data: claimed, error: claimError } = await serviceClient().rpc("tiktok_publish_claim", { p_post_id: candidate.id });
        if (claimError) throw new Error(`TikTok claim failed: ${claimError.message}`);
        if (!claimed) return { id: candidate.id, status: "already_claimed" };

        const { data: fresh, error: freshError } = await serviceClient().from("tiktok_scheduled_posts")
          .select("id, tenant_id, content").eq("id", candidate.id).eq("status", "publishing").maybeSingle();
        if (freshError || !fresh) throw new Error(`TikTok claimed-row read failed: ${freshError?.message || "missing"}`);
        const row = fresh as Row;
        try {
          const creator: any = await queryCreatorInfo(row.tenant_id);
          const c = row.content;
          const allowed = creator?.data?.privacy_level_options as string[] | undefined;
          if (allowed && !allowed.includes(c.privacy_level)) throw new Error(`privacy_level_no_longer_allowed:${c.privacy_level}`);
          const refused = checkPublishText({ title: c.title, description: c.description });
          if (refused) throw new Error(`${refused.code}: ${refused.message}`);
          let publishId: string | undefined;
          if (c.media_type === "VIDEO") {
            const bytes = await readTikTokVideoBytes(row.tenant_id, c.video_path);
            const up = await publishTikTokVideoBytes(
              row.tenant_id,
              "/v2/post/publish/video/init/",
              { title: c.title, privacy_level: c.privacy_level, disable_duet: c.disable_duet, disable_comment: c.disable_comment, disable_stitch: c.disable_stitch },
              bytes,
            );
            publishId = up.publish_id;
          } else {
            const out: any = await initTikTokPost(row.tenant_id, "PHOTO", {
              post_info: { title: c.title, description: c.description, privacy_level: c.privacy_level, disable_comment: c.disable_comment, auto_add_music: c.auto_add_music },
              source_info: { source: "PULL_FROM_URL", photo_images: c.photo_urls, photo_cover_index: 0 },
              post_mode: "DIRECT_POST", media_type: "PHOTO",
            });
            publishId = out?.data?.publish_id;
          }
          if (!publishId) throw new Error("TikTok returned no publish_id");
          const { error } = await serviceClient().rpc("tiktok_publish_finalize", { p_post_id: row.id, p_publish_id: publishId, p_error: null });
          if (error) throw new Error(`TikTok finalize failed: ${error.message}`);
          return { id: row.id, status: "processing", publish_id: publishId };
        } catch (e) {
          await serviceClient().rpc("tiktok_publish_finalize", { p_post_id: row.id, p_publish_id: null, p_error: (e as Error).message.slice(0, 500) });
          return { id: row.id, status: "failed" };
        }
      });
      results.push(result);
    }
    const processing = await step.run("load-processing", async () => {
      const { data, error } = await serviceClient().from("tiktok_scheduled_posts")
        .select("id, tenant_id, publish_id").eq("status", "processing").not("publish_id", "is", null)
        .order("updated_at").limit(25);
      if (error) throw new Error(`TikTok processing read failed: ${error.message}`);
      return data ?? [];
    });
    for (const item of processing as Array<{ id: string; tenant_id: string; publish_id: string }>) {
      await step.run(`status-${item.id}`, async () => {
        const live: any = await fetchTikTokPostStatus(item.tenant_id, item.publish_id);
        const s = live?.data?.status;
        const status = s === "PUBLISH_COMPLETE" ? "published" : s === "FAILED" ? "failed" : "processing";
        const { error } = await serviceClient().from("tiktok_scheduled_posts").update({
          status,
          external_post_ids: live?.data?.publicly_available_post_id ?? live?.data?.publicaly_available_post_id ?? [],
          failure_reason: live?.data?.fail_reason ?? null,
          updated_at: new Date().toISOString(),
        }).eq("id", item.id).eq("tenant_id", item.tenant_id).eq("publish_id", item.publish_id);
        if (error) throw new Error(`TikTok status persist failed: ${error.message}`);
      });
    }
    return { published_attempts: results.length, status_checks: processing.length, results };
  },
);
