import { beforeEach, describe, expect, it, vi } from "vitest";

const getBoolSetting = vi.fn(async (_key: string, _tenant?: string | null) => true);
vi.mock("@/services/settings", () => ({ getBoolSetting: (k: string, t?: string | null) => getBoolSetting(k, t) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import { isSiteBoundPayload, runSiteImagesTool, siteImagesSandboxOptions, siteImagesToolInput } from "../sandbox-tool";
import { siteImagesPromptFragment } from "../prompt";
import { resetSiteImageRunCounts, type SiteImageDeps } from "../generate";
import { z } from "zod";

const SITE_PAYLOAD = { stage: "build", fast_single_pass: true, site_id: "s1", target: { github_full_name: "org/site" } };

beforeEach(() => {
  getBoolSetting.mockReset();
  getBoolSetting.mockResolvedValue(true);
  resetSiteImageRunCounts();
});

describe("siteImagesSandboxOptions", () => {
  it("never turns the tool on for a run started from an AI assistant", async () => {
    expect(await siteImagesSandboxOptions(SITE_PAYLOAD, "t1", "mcp")).toEqual({});
    expect(await siteImagesSandboxOptions(SITE_PAYLOAD, "t1", "chat")).toEqual({ site_images: true });
  });

  it("turns the tool on for a site build or edit when site_images is on", async () => {
    expect(await siteImagesSandboxOptions(SITE_PAYLOAD, "t1")).toEqual({ site_images: true });
    expect(await siteImagesSandboxOptions({ refine_mode: true, site_id: "s1", target: { github_full_name: "org/site" } }, "t1")).toEqual({ site_images: true });
    expect(getBoolSetting).toHaveBeenCalledWith("site_images", "t1");
  });

  it("leaves every other run unchanged", async () => {
    expect(await siteImagesSandboxOptions({ stage: "build", target: { github_full_name: "org/app" } }, "t1")).toEqual({});
    expect(await siteImagesSandboxOptions(null, "t1")).toEqual({});
    expect(getBoolSetting).not.toHaveBeenCalled();
  });

  it("is off when the setting is off, and on (the default) when the setting cannot be read", async () => {
    getBoolSetting.mockResolvedValueOnce(false);
    expect(await siteImagesSandboxOptions(SITE_PAYLOAD, "t1")).toEqual({});
    getBoolSetting.mockRejectedValueOnce(new Error("db down"));
    expect(await siteImagesSandboxOptions(SITE_PAYLOAD, "t1")).toEqual({ site_images: true });
  });

  it("needs both a site and a repo", () => {
    expect(isSiteBoundPayload({ site_id: " ", target: { github_full_name: "org/site" } })).toBe(false);
    expect(isSiteBoundPayload({ site_id: "s1" })).toBe(false);
  });
});

describe("add_site_images input", () => {
  const schema = z.object(siteImagesToolInput);
  it("rejects a path-like slug and a missing alt", () => {
    expect(schema.safeParse({ images: [{ slug: "../x", prompt: "a calm yoga studio at dawn", alt: "studio" }] }).success).toBe(false);
    expect(schema.safeParse({ images: [{ slug: "hero", prompt: "a calm yoga studio at dawn" }] }).success).toBe(false);
    expect(schema.safeParse({ images: [{ slug: "hero", prompt: "a calm yoga studio at dawn", alt: "the studio" }] }).success).toBe(true);
  });

  it("defaults the aspect to a 16:9 hero", async () => {
    const generate = vi.fn(async (..._args: Parameters<SiteImageDeps["generate"]>) => ({ ok: false as const, reason: "refused" as const, error: "no" }));
    const deps: SiteImageDeps = {
      configured: async () => true,
      generate,
      download: async () => null,
      readText: async () => null,
      exists: async () => false,
      present: async () => false,
      writeBytes: async () => undefined,
      writeText: async () => undefined,
    };
    await runSiteImagesTool(
      { tenant_id: "t1", run_id: "r1", root: "/home/user/repo", getSandboxId: async () => "sb" },
      { images: [{ slug: "hero", prompt: "a calm yoga studio at dawn", alt: "the studio" }] },
      deps,
    );
    expect(generate).toHaveBeenCalledWith("image.hero", expect.any(String), "16:9");
  });
});

describe("siteImagesPromptFragment", () => {
  it("without a brief, asks for a hero plus key sections picked from the idea", () => {
    const t = siteImagesPromptFragment(null);
    expect(t).toContain("add_site_images");
    expect(t).toContain("lucide-react");
    expect(t).toMatch(/Pick the photos from the idea/);
  });

  it("with the brief's subjects, lists them (capped at one call) in an untrusted block with the style", () => {
    const t = siteImagesPromptFragment({ subjects: ["bakery counter", "baker shaping dough", "a", "b", "fifth one"], style: "warm film" });
    expect(t).toContain("bakery counter");
    expect(t).toContain("Style: warm film");
    expect(t).not.toContain("fifth one");
  });

  it("when the founder asked for no photos, never asks for the tool", () => {
    const t = siteImagesPromptFragment({ subjects: [], style: "" });
    expect(t).toMatch(/do not call `add_site_images`/);
    expect(t).toContain("lucide-react");
  });
});
