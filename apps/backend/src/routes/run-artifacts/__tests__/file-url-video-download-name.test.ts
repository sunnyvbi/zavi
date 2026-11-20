import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RUN = "11111111-1111-4111-1111-111111111111";

const mocks = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  options: [] as Array<{ download?: string } | undefined>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ user_id: "u1", tenant_id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: mocks.row, error: null }) }),
      }),
    }),
    storage: {
      from: () => ({
        createSignedUrl: async (path: string, _ttl: number, options?: { download?: string }) => {
          mocks.options.push(options);
          return { data: { signedUrl: `https://signed/${path}` }, error: null };
        },
      }),
    },
  }),
}));

import { runArtifactUrl, slugifyDownloadStem, videoDownloadName } from "../file-url";
import { clearSignedUrlCache } from "@/services/run-artifacts/signed-url-cache";

function mkRes() {
  const res: Record<string, unknown> = { statusCode: 200 };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.set = () => res;
  return res as { statusCode: number };
}

async function downloadNameFor(filename: string, title: string | null | undefined, id = "a1") {
  mocks.row = {
    tenant_id: TENANT,
    storage_path: `${TENANT}/${RUN}/${filename.toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`,
    bucket: "agent-artifacts",
    filename,
    title,
    mime: "video/mp4",
  };
  clearSignedUrlCache();
  mocks.options = [];
  await runArtifactUrl({ params: { id }, query: { download: "1" } } as never, mkRes() as never);
  return mocks.options[0]?.download;
}

const SAFE = /^[a-z0-9]+(-[a-z0-9]+)*\.(mp4|mov|webm|m4v)$/;

beforeEach(() => {
  clearSignedUrlCache();
  mocks.options = [];
});

describe("Library download of a generated video is named after the ad title", () => {
  it("uses the title, not the internal intent plus run id", async () => {
    const name = await downloadNameFor("talking_head-3bd37457.mp4", "Need a birthday cake by tonight.mp4");
    expect(name).toBe("need-a-birthday-cake-by-tonight.mp4");
  });

  it("accepts a title without an extension", async () => {
    expect(await downloadNameFor("talking_head-3bd37457.mp4", "Need a birthday cake by tonight")).toBe(
      "need-a-birthday-cake-by-tonight.mp4",
    );
  });

  it("keeps a title's trailing 8-char token instead of treating it as an id tag", async () => {
    expect(await downloadNameFor("x.mp4", "Pick the cake, then the day 3fa9c1d2.mp4")).toBe(
      "pick-the-cake-then-the-day-3fa9c1d2.mp4",
    );
    expect(await downloadNameFor("x-1a2b3c4d.mp4", "Sale 20261027")).toBe("sale-20261027.mp4");
    expect(await downloadNameFor("x-1a2b3c4d.mp4", "Sale 20261027.mov")).toBe("sale-20261027.mp4");
  });

  it("still drops the id tag from the stored filename when there is no title", async () => {
    expect(await downloadNameFor("Spring sale 3fa9c1d2.mp4", null)).toBe("spring-sale.mp4");
    expect(await downloadNameFor("Spring sale 3fa9c1d2.mp4", ".mov")).toBe("spring-sale.mp4");
  });

  it("takes the extension from the stored file, never from the title", async () => {
    expect(await downloadNameFor("clip.mp4", "Spring sale.mov")).toBe("spring-sale.mp4");
    expect(await downloadNameFor("clip.mp4", "Launch.mov")).toBe("launch.mp4");
    expect(await downloadNameFor("clip.webm", "Spring sale.MP4")).toBe("spring-sale.webm");
    expect(await downloadNameFor("CLIP.MOV", "Spring sale.webm")).toBe("spring-sale.mov");
  });

  it("strips every stacked video extension from the title", async () => {
    expect(await downloadNameFor("clip.mp4", "Promo.MP4.mov")).toBe("promo.mp4");
    expect(await downloadNameFor("clip.webm", "Promo.mov.M4V.mp4")).toBe("promo.webm");
  });

  it.each([".MP4.mov", ".mov", ".MOV", " .webm ", ".mp4.mp4.m4v"])(
    "falls back to the stored stem when the title %j is only extensions",
    async (title) => {
      expect(await downloadNameFor("talking_head-3bd37457.mp4", title)).toBe("talking-head-3bd37457.mp4");
      expect(await downloadNameFor("\u{1F382}.webm", title)).toBe("video.webm");
    },
  );

  it("strips emoji, accents, quotes and path characters", async () => {
    const name = await downloadNameFor(
      "talking_head-3bd37457.mp4",
      "\u{1F382} Café \"Crème\" / ..\\..\\etc\\passwd: 50% off!!! \u{1F389}.mp4",
    );
    expect(name).toBe("cafe-creme-etc-passwd-50-off.mp4");
    expect(name).toMatch(SAFE);
  });

  it("caps a very long title and never ends on a hyphen", async () => {
    const title = `${"extraordinarily ".repeat(60)}birthday cake.mp4`;
    const name = (await downloadNameFor("talking_head-3bd37457.mp4", title)) as string;
    expect(name.length).toBeLessThanOrEqual(80 + ".mp4".length);
    expect(name).toMatch(SAFE);
    const unbroken = (await downloadNameFor("talking_head-3bd37457.mp4", `${"a".repeat(500)}.mp4`)) as string;
    expect(unbroken).toBe(`${"a".repeat(80)}.mp4`);
  });

  it.each([null, undefined, "", "   ", ".mp4"])("falls back to the stored name for title %j", async (title) => {
    const name = (await downloadNameFor("talking_head-3bd37457.mp4", title as never)) as string;
    expect(name).toBe("talking-head-3bd37457.mp4");
  });

  it.each(["\u{1F382}\u{1F389}\u{1F525}", "!!! ??? ...", "日本語のタイトル", "---", "\u0000\u001f"])(
    "never produces an empty or unsafe name for symbol-only title %j",
    async (title) => {
      const name = (await downloadNameFor("talking_head-3bd37457.mp4", `${title}.mp4`)) as string;
      expect(name).toBe("talking-head-3bd37457.mp4");
      expect(await downloadNameFor("\u{1F382}.mp4", `${title}.mp4`)).toBe("video.mp4");
    },
  );

  it("keeps the stored extension", async () => {
    expect(await downloadNameFor("clip.webm", "Spring sale")).toBe("spring-sale.webm");
  });

  it("leaves a non-video artifact download untouched by the title", async () => {
    mocks.row = {
      tenant_id: TENANT,
      storage_path: `${TENANT}/${RUN}/report.pdf`,
      bucket: "agent-artifacts",
      filename: "report.pdf",
      title: "Q3 Report!",
      mime: "application/pdf",
    };
    clearSignedUrlCache();
    mocks.options = [];
    await runArtifactUrl({ params: { id: "a1" }, query: { download: "1" } } as never, mkRes() as never);
    expect(mocks.options[0]?.download).toBe("report.pdf");
  });

  it("slugifyDownloadStem and videoDownloadName are total", () => {
    for (const input of ["", " ", "\u{1F382}", "A".repeat(10_000), "a/b\\c", "‮\u0000", "\uD800"]) {
      expect(videoDownloadName(`${input}.mp4`)).toMatch(SAFE);
      expect(slugifyDownloadStem(input)).toMatch(/^[a-z0-9-]*$/);
    }
  });
});
