import { describe, expect, it, vi } from "vitest";
import { checkCreativeImage, signChatCreativeImage, signCreativeImage, SIGNED_URL_TTL_S, type CreativeImageDeps } from "./creative-images";
import { ExpectedToolError } from "@/services/tools/types";
import { SsrfBlockedError } from "@/services/onboarding/enrichment/url-guard";

const T = "0b0c5f7e-1111-4222-8333-944455556666";
const OTHER = "9f9f9f9f-1111-4222-8333-944455556666";
const ART = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
type Row = { id: string; storage_path: string; bucket: string | null; mime: string | null };
const own: Row = { id: ART, storage_path: `${T}/run/social-1.png`, bucket: "agent-artifacts", mime: "image/png" };
function deps(row: Partial<Row> | null, signed: string | null = "https://store.test/signed.png?token=x") {
  const readArtifact = vi.fn(async () => (row ? { ...own, ...row } : null));
  const sign = vi.fn(async () => signed);
  const d: CreativeImageDeps = {
    readArtifact,
    sign,
    safeUrl: async (u: string) => {
      const url = new URL(u);
      if (url.hostname.endsWith(".internal")) throw new SsrfBlockedError("private");
      return url;
    },
    checkChatImage: async (tenantId: string, path: string) => {
      if (!path.startsWith(`${tenantId}/`)) throw new ExpectedToolError("image_not_owned", "That image is not in this workspace.");
    },
    signChatImage: async (tenantId: string, path: string) => {
      if (!path.startsWith(`${tenantId}/`)) throw new ExpectedToolError("image_not_owned", "That image is not in this workspace.");
      return "https://store.test/chat.jpg?token=y";
    },
  };
  return { d, readArtifact, sign };
}

describe("checkCreativeImage (propose: nothing signed, nothing stored but the id)", () => {
  it("this workspace's own Zavi PNG/JPEG passes; the lookup is made as the calling tenant; no link is signed", async () => {
    const { d, readArtifact, sign } = deps({});
    await checkCreativeImage(T, { image_artifact_id: ART }, d);
    expect(readArtifact).toHaveBeenCalledWith(T, ART);
    expect(sign).not.toHaveBeenCalled();
    await checkCreativeImage(T, { image_artifact_id: ART }, deps({ mime: "image/jpeg" }).d);
  });

  it("another tenant's image, a chat upload or document, a logo or any other bucket, a non-image, a format Reddit does not take, a path trick: one refusal", async () => {
    for (const row of [
      null,
      { storage_path: `${OTHER}/run/social-1.png` },
      { bucket: "agent-chat-images" },
      { bucket: "tenant-documents" },
      { bucket: "ad-assets" },
      { mime: "application/pdf" },
      { mime: "image/webp" },
      { storage_path: `${T}/../${OTHER}/x.png` },
      { id: "2c9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" },
    ]) {
      await expect(checkCreativeImage(T, { image_artifact_id: ART }, deps(row).d), JSON.stringify(row)).rejects.toMatchObject({ code: "reddit_ads_image_unusable" });
    }
  });

  it("a public https link passes; a private or http one is refused without echoing it; exactly one source", async () => {
    await checkCreativeImage(T, { image_url: "https://cdn.example.com/a.jpg" }, deps({}).d);
    const e = (await checkCreativeImage(T, { image_url: "https://files.internal/a.jpg?token=secret" }, deps({}).d).catch((x: unknown) => x)) as Error & { code?: string };
    expect(e.code).toBe("reddit_ads_image_unusable");
    expect(e.message).not.toContain("secret");
    await expect(checkCreativeImage(T, { image_url: "http://cdn.example.com/a.jpg" }, deps({}).d)).rejects.toMatchObject({ code: "reddit_ads_image_unusable" });
    await expect(checkCreativeImage(T, {}, deps({}).d)).rejects.toMatchObject({ code: "reddit_ads_image_unusable" });
    await expect(checkCreativeImage(T, { image_url: "https://cdn.example.com/a.jpg", image_artifact_id: ART }, deps({}).d)).rejects.toMatchObject({ code: "reddit_ads_image_unusable" });
  });
});

describe("signCreativeImage (execution: one object, minutes, ownership re-checked)", () => {
  it("signs exactly this tenant's object path in agent-artifacts for at most 15 minutes", async () => {
    const { d, sign } = deps({});
    expect(await signCreativeImage(T, ART, d)).toBe("https://store.test/signed.png?token=x");
    expect(sign).toHaveBeenCalledWith(T, "agent-artifacts", `${T}/run/social-1.png`, SIGNED_URL_TTL_S);
    expect(SIGNED_URL_TTL_S).toBeLessThanOrEqual(15 * 60);
  });

  it("an image that stopped being this tenant's own Zavi image refuses as a plan correction, and signs nothing", async () => {
    for (const row of [null, { storage_path: `${OTHER}/run/social-1.png` }, { bucket: "agent-chat-images" }]) {
      const { d, sign } = deps(row);
      await expect(signCreativeImage(T, ART, d)).rejects.toMatchObject({ code: "reddit_ads_invalid_request" });
      expect(sign).not.toHaveBeenCalled();
    }
  });

  it("a signing failure creates nothing and says approve again", async () => {
    await expect(signCreativeImage(T, ART, deps({}, null).d)).rejects.toMatchObject({ code: "reddit_ads_image_unreadable" });
  });
});

describe("a photo the founder attached in chat", () => {
  const PHOTO = `${T}/2c9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jpg`;
  it("passes for this workspace's own upload and is refused for another's", async () => {
    await checkCreativeImage(T, { image_path: PHOTO }, deps({}).d);
    await expect(checkCreativeImage(T, { image_path: `${OTHER}/2c9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jpg` }, deps({}).d)).rejects.toMatchObject({ code: "reddit_ads_image_unusable" });
  });
  it("is one picture source: two at once is refused", async () => {
    await expect(checkCreativeImage(T, { image_path: PHOTO, image_url: "https://x.test/a.jpg" }, deps({}).d)).rejects.toMatchObject({ code: "reddit_ads_image_unusable" });
  });
  it("is signed only at the write, and another workspace's path is a plan correction", async () => {
    expect(await signChatCreativeImage(T, PHOTO, deps({}).d)).toBe("https://store.test/chat.jpg?token=y");
    await expect(signChatCreativeImage(OTHER, PHOTO, deps({}).d)).rejects.toMatchObject({ code: "reddit_ads_invalid_request" });
  });
});
