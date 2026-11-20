import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TIKTOK_TOOLS, tiktokCreatePostTool } from "../tools";
import { readTikTokVideoBytes, TIKTOK_VIDEO_PATH_RE } from "@/services/connectors/tiktok/api";

const WRITE_TOOLS = [
  "tiktok_create_post",
  "tiktok_schedule_post",
  "tiktok_update_scheduled_post",
  "tiktok_cancel_scheduled_post",
  "tiktok_upload_draft",
] as const;
const READ_TOOLS = [
  "tiktok_get_creator_info",
  "tiktok_get_account_stats",
  "tiktok_list_videos",
  "tiktok_analyze_content",
  "tiktok_list_scheduled_posts",
  "tiktok_get_post_status",
] as const;

describe("TikTok organic tools", () => {
  it("exposes the promised eleven-tool surface", () => {
    expect(TIKTOK_TOOLS.map((t) => t.name)).toEqual([
      "tiktok_get_creator_info", "tiktok_get_account_stats", "tiktok_list_videos", "tiktok_create_post",
      "tiktok_schedule_post", "tiktok_list_scheduled_posts", "tiktok_update_scheduled_post",
      "tiktok_cancel_scheduled_post", "tiktok_get_post_status", "tiktok_upload_draft",
      "tiktok_analyze_content",
    ]);
  });

  it("refuses a publish before any API or database work without explicit consent", async () => {
    await expect(tiktokCreatePostTool.execute({ tenant_id: "tenant-a", run_trigger: "chat", log: () => {} }, {
      media_type: "VIDEO", video_path: "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.mp4",
      title: "A post", description: "", privacy_level: "SELF_ONLY",
      disable_comment: false, disable_duet: false, disable_stitch: false,
      auto_add_music: false, confirm_user_consent: false,
    })).rejects.toMatchObject({ code: "tiktok_consent_required" });
  });

  it("refuses a post with an unfilled blank when the job is made, before any API or database work", async () => {
    await expect(tiktokCreatePostTool.execute({ tenant_id: "tenant-a", run_trigger: "chat", log: () => {} }, {
      media_type: "VIDEO", video_path: "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.mp4",
      title: "Our [city] launch", description: "", privacy_level: "SELF_ONLY",
      disable_comment: false, disable_duet: false, disable_stitch: false,
      auto_add_music: false, confirm_user_consent: true,
    })).rejects.toMatchObject({ code: "publish_refused_blanks" });
  });

  it("refuses autonomous publish creation even if model input claims consent", async () => {
    await expect(tiktokCreatePostTool.execute({ tenant_id: "tenant-a", run_trigger: "cron", log: () => {} }, {
      media_type: "VIDEO", video_path: "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.mp4",
      title: "A post", description: "", privacy_level: "SELF_ONLY",
      disable_comment: false, disable_duet: false, disable_stitch: false,
      auto_add_music: false, confirm_user_consent: true,
    })).rejects.toMatchObject({ code: "tiktok_interactive_consent_required" });
  });

  describe("the interactive gate covers every write and no read", () => {
    it.each(WRITE_TOOLS)("%s refuses a channel-recipe run", async (name) => {
      const tool = TIKTOK_TOOLS.find((t) => t.name === name)!;
      await expect(
        tool.execute({ tenant_id: "tenant-a", run_trigger: "channel_recipe", log: () => {} }, {}),
      ).rejects.toMatchObject({ code: "tiktok_interactive_consent_required" });
    });

    it.each(WRITE_TOOLS)("%s ALLOWS an operator handoff carrying a human actor", async (name) => {
      const tool = TIKTOK_TOOLS.find((t) => t.name === name)!;
      const err = await tool
        .execute(
          {
            tenant_id: "tenant-a",
            run_trigger: "handoff",
            actor: { actor_source: "chat", actor_user_id: "u1", resolved_tenant_member: true, provenance_label: "member" },
            log: () => {},
          },
          {},
        )
        .then(() => null, (e) => e);
      expect(err?.code).not.toBe("tiktok_interactive_consent_required");
    });

    it.each(WRITE_TOOLS)("%s refuses a handoff with a system actor", async (name) => {
      const tool = TIKTOK_TOOLS.find((t) => t.name === name)!;
      await expect(
        tool.execute(
          {
            tenant_id: "tenant-a",
            run_trigger: "handoff",
            actor: { actor_source: "cron", actor_user_id: null, resolved_tenant_member: false, provenance_label: "scheduled run" },
            log: () => {},
          },
          {},
        ),
      ).rejects.toMatchObject({ code: "tiktok_interactive_consent_required" });
    });

    it("allows an unverified Slack human (actor_user_id null)", async () => {
      const tool = TIKTOK_TOOLS.find((t) => t.name === "tiktok_schedule_post")!;
      const err = await tool
        .execute(
          {
            tenant_id: "tenant-a",
            run_trigger: "handoff",
            actor: { actor_source: "slack", actor_user_id: null, resolved_tenant_member: false, provenance_label: "unverified external" },
            log: () => {},
          },
          {},
        )
        .then(() => null, (e) => e);
      expect(err?.code).not.toBe("tiktok_interactive_consent_required");
    });

    it("no read tool carries the gate", () => {
      const src = readFileSync(join(__dirname, "..", "tools.ts"), "utf-8");
      const gated = READ_TOOLS.filter((name) => {
        const start = src.indexOf(`name: "${name}"`);
        const next = src.indexOf("export const tiktok", start);
        const body = src.slice(start, next === -1 ? undefined : next);
        return body.includes("assertInteractiveConsent(ctx)");
      });
      expect(gated).toEqual([]);
    });

    it("accounts for every tool — no tool is in neither list", () => {
      expect([...WRITE_TOOLS, ...READ_TOOLS].sort()).toEqual(
        TIKTOK_TOOLS.map((t) => t.name).sort(),
      );
    });
  });

  describe("video is a tenant-owned storage path, never a URL", () => {
    const TENANT = "11111111-1111-1111-1111-111111111111";
    const PATH = `${TENANT}/22222222-2222-2222-2222-222222222222.mp4`;

    it("accepts the <tenant>/<uuid>.mp4 shape and nothing else", () => {
      expect(TIKTOK_VIDEO_PATH_RE.test(PATH)).toBe(true);
      for (const bad of [
        "https://media.bebee.com/logo.jpg",
        "https://example.com/v.mp4",
        `${TENANT}/not-a-uuid.mp4`,
        `${TENANT}/22222222-2222-2222-2222-222222222222.mov`,
        "../../etc/passwd",
      ]) {
        expect(TIKTOK_VIDEO_PATH_RE.test(bad)).toBe(false);
      }
    });

    it("refuses a URL where a path belongs, before any storage or network call", async () => {
      await expect(
        readTikTokVideoBytes(TENANT, "https://media.bebee.com/logo.mp4"),
      ).rejects.toMatchObject({ code: "tiktok_video_path_required" });
    });

    it("refuses another tenant's path — storage has no row filter to fall back on", async () => {
      const foreign = "99999999-9999-9999-9999-999999999999/22222222-2222-2222-2222-222222222222.mp4";
      await expect(readTikTokVideoBytes(TENANT, foreign)).rejects.toMatchObject({
        code: "tiktok_video_path_foreign",
      });
    });

    it("no tool still advertises a video_url input", () => {
      const withVideoUrl = TIKTOK_TOOLS.filter((t) => {
        const shape = (t.input_schema as { shape?: Record<string, unknown> }).shape ?? {};
        return Object.keys(shape).includes("video_url");
      }).map((t) => t.name);
      expect(withVideoUrl).toEqual([]);
    });
  });
});