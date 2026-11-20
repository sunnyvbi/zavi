import { describe, it, expect, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

vi.mock("@/services/tools/pinterest-insights/read", () => ({ findOwnedPinterestBoard: vi.fn() }));

import { socialProposePostTool } from "../propose_post";
import {
  extractParentAttachmentRefs,
  normalizeChildAttachmentRefs,
  resolveForwardedContent,
} from "@/services/agents/a2a-attachment-forwarding";

const LIVE = process.env.REPRO_LIVE === "1" && !!process.env.REPRO_SUPABASE_URL;
const d = LIVE ? describe : describe.skip;

const TENANT = "00000000-0000-4000-8000-00000000c0de";
const FILE_ID = "11111111-0000-4000-8000-000000000001";
const STORED = `${TENANT}/${FILE_ID}.jpg`;
const JPG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD+/iiiigD/2Q==",
  "base64",
);

function stagingClient() {
  return createClient(process.env.REPRO_SUPABASE_URL!, process.env.REPRO_SUPABASE_KEY!, {
    auth: { persistSession: false },
  });
}

d("live staging repro — instagram_image staging path", () => {
  it("temp path fails exactly like prod; forwarded storage key stages", async () => {
    const sb = stagingClient();

    const up = await sb.storage.from("agent-chat-images").upload(STORED, JPG, {
      contentType: "image/jpeg",
      upsert: true,
    });
    expect(up.error).toBeNull();

    try {
      const refs = extractParentAttachmentRefs({ image_paths: [STORED] }, TENANT);
      expect(refs).toHaveLength(1);

      const content = (await resolveForwardedContent(
        sb as never,
        TENANT,
        normalizeChildAttachmentRefs(refs, TENANT),
        "Stage the truck photo with the for-sale caption.",
      )) as Array<{ type: string; text?: string; source?: { data?: string } }>;
      expect(content.find((b) => b.type === "image")?.source?.data?.length).toBeGreaterThan(100);
      const marker = content.find((b) => b.type === "text" && b.text?.includes("agent-chat-images"));
      expect(marker?.text).toContain(STORED);

      const emitA = vi.fn().mockResolvedValue("dec-x");
      await expect(
        socialProposePostTool.execute(
          { tenant_id: TENANT, emit_decision: emitA, log: vi.fn() } as never,
          {
            channel: "instagram_image",
            text: "Black lifted GMC single-cab. DM for details.",
            image_path: "/tmp/claude-501/images/1.png",
            rationale: "stage the user's truck photo",
          },
        ),
      ).rejects.toMatchObject({ code: "social_propose_image_not_owned" });
      expect(emitA).not.toHaveBeenCalled();

      const emitB = vi.fn().mockResolvedValue("dec-ok");
      const out = (await socialProposePostTool.execute(
        { tenant_id: TENANT, emit_decision: emitB, log: vi.fn() } as never,
        {
          channel: "instagram_image",
          text: "Black lifted GMC single-cab. DM for details.",
          image_path: STORED,
          rationale: "stage the user's truck photo",
        },
      )) as Record<string, unknown>;
      expect(out).toMatchObject({ staged: true, published: false });
      expect(emitB).toHaveBeenCalledOnce();
    } finally {
      await sb.storage.from("agent-chat-images").remove([STORED]);
    }
  }, 30_000);
});
