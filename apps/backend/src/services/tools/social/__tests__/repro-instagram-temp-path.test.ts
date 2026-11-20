import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tools/pinterest-insights/read", () => ({ findOwnedPinterestBoard: vi.fn() }));

import { socialProposePostTool } from "../propose_post";
import {
  extractParentAttachmentRefs,
  normalizeChildAttachmentRefs,
  resolveForwardedContent,
  lookbackThreadAttachmentsWithExpiry,
  LOOKBACK_WINDOW_MS,
  LOOKBACK_WINDOW_MINUTES,
  EXPIRED_UPLOAD_NOTE,
} from "@/services/agents/a2a-attachment-forwarding";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const STORED = `${TENANT}/9f9f9f9f-0000-4000-8000-000000000000.jpg`;
const SDK_TEMP_PATH = "/tmp/claude-501/images/1.png";

function toolCtx(emit = vi.fn().mockResolvedValue("dec-1")) {
  return { tenant_id: TENANT, emit_decision: emit, log: vi.fn() } as never;
}

describe("step 1 — the exact prod error", () => {
  it("temp SDK path → social_propose_image_not_owned (screenshot error, verbatim)", async () => {
    await expect(
      socialProposePostTool.execute(toolCtx(), {
        channel: "instagram_image",
        text: "Black lifted GMC single-cab, chrome wheels, all-terrain tires. DM for details.",
        image_path: SDK_TEMP_PATH,
        rationale: "user asked to stage their truck photo",
      }),
    ).rejects.toMatchObject({
      code: "social_propose_image_not_owned",
      message: expect.stringContaining(
        "image_path must be a storage path the operator uploaded in this workspace (not a URL).",
      ),
    });
  });

  it("the refusal now tells the model the recovery: ask the user to re-attach", async () => {
    const err = (await socialProposePostTool
      .execute(toolCtx(), {
        channel: "instagram_image",
        text: "caption",
        image_path: SDK_TEMP_PATH,
        rationale: "r",
      })
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("re-attach");
    expect(err.message).toContain(`${LOOKBACK_WINDOW_MINUTES} minutes`);
  });

  it("a signed/public URL fails the same way", async () => {
    await expect(
      socialProposePostTool.execute(toolCtx(), {
        channel: "instagram_image",
        text: "caption",
        image_path: `https://x.supabase.co/storage/v1/object/sign/agent-chat-images/${STORED}`,
        rationale: "r",
      }),
    ).rejects.toMatchObject({ code: "social_propose_image_not_owned" });
  });
});

describe("step 2 — the designed path DOES hand the specialist the stageable key", () => {
  it("handoff forwarding yields image block + path marker, and that path stages", async () => {
    const refs = extractParentAttachmentRefs({ image_paths: [STORED] }, TENANT);
    expect(refs).toEqual([{ path: STORED, kind: "image" }]);

    const sb = {
      storage: {
        from: () => ({
          download: async () => ({ data: new Blob([Buffer.from([0xff, 0xd8, 0xff])]), error: null }),
        }),
      },
    } as never;
    const content = (await resolveForwardedContent(
      sb,
      TENANT,
      normalizeChildAttachmentRefs(refs, TENANT),
      "Stage the truck photo with the for-sale caption.",
    )) as Array<{ type: string; text?: string }>;

    const marker = content.find((b) => b.type === "text" && b.text?.includes("agent-chat-images"));
    expect(marker?.text).toContain(STORED);
    expect(marker?.text).toContain("pass that exact value as image_path");

    const emit = vi.fn().mockResolvedValue("dec-ok");
    const out = (await socialProposePostTool.execute(toolCtx(emit), {
      channel: "instagram_image",
      text: "caption",
      image_path: STORED,
      rationale: "r",
    })) as Record<string, unknown>;
    expect(out).toMatchObject({ staged: true, published: false });
  });
});

describe("step 3 — the three ways the specialist ends up with pixels/temp-file but no key", () => {
  it("a. flag OFF is the dispatcher default — nothing is stamped, specialist gets intent text only", () => {
    expect(normalizeChildAttachmentRefs(undefined, TENANT)).toEqual([]);
  });

  it("b. text-only retry turn after the window — no refs, but expiry IS now reported", async () => {
    const uploadedAt = Date.now() - (LOOKBACK_WINDOW_MS + 60_000);
    const sb = {
      from: () => {
        let excluded = false;
        const chain = {
          select: () => chain,
          eq: () => chain,
          not: () => chain,
          gte: (_col: string, since: string) => {
            excluded = new Date(since).getTime() > uploadedAt;
            return chain;
          },
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () =>
            excluded
              ? { data: null, error: null }
              : { data: { attachments: [{ path: STORED, kind: "image" }] }, error: null },
        };
        return chain;
      },
    } as never;

    const out = await lookbackThreadAttachmentsWithExpiry(sb, TENANT, { thread_id: "t-1" });
    expect(out.refs).toEqual([]);
    expect(out.expiredUpload).toBe(true);

    expect(EXPIRED_UPLOAD_NOTE).toContain("re-attach");
    expect(EXPIRED_UPLOAD_NOTE).toContain(`${LOOKBACK_WINDOW_MINUTES} minutes`);
  });

  it("c. non-exact path shapes are silently dropped at the source seam", () => {
    expect(
      extractParentAttachmentRefs(
        {
          image_paths: [
            `${TENANT}/subfolder/9f9f9f9f-0000-4000-8000-000000000000.jpg`,
            `e0fe9ea8-0000-4000-8000-000000000000/9f9f9f9f-0000-4000-8000-000000000000.jpg`,
            SDK_TEMP_PATH,
          ],
        },
        TENANT,
      ),
    ).toEqual([]);
  });
});
