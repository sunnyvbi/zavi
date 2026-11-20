
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const RUN = "11111111-1111-4111-1111-111111111111";

const mocks = vi.hoisted(() => ({
  signed: [] as { bucket: string; path: string; options?: { download?: string } }[],
  batchSigned: [] as string[],
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, _ttl?: number, options?: { download?: string }) => {
          mocks.signed.push({ bucket, path, options });
          return { data: { signedUrl: `https://signed/${bucket}/${path}` }, error: null };
        },
        createSignedUrls: async (paths: string[]) => {
          mocks.batchSigned.push(...paths);
          return { data: paths.map((p) => ({ path: p, signedUrl: `https://batch/${bucket}/${p}`, error: null })), error: null };
        },
      }),
    },
  }),
}));

import { signTenantArtifactPath, signTenantArtifactPaths, videoDownloadName } from "../file-url";
import { clearSignedUrlCache } from "@/services/run-artifacts/signed-url-cache";

beforeEach(() => {
  clearSignedUrlCache();
  mocks.signed = [];
  mocks.batchSigned = [];
});

describe("signTenantArtifactPath — bucket allowlist", () => {
  it("signs the default agent-artifacts bucket (unchanged behavior)", async () => {
    const url = await signTenantArtifactPath(TENANT_A, `${TENANT_A}/${RUN}/report.pdf`);
    expect(url).toContain("agent-artifacts");
    expect(mocks.signed[0].bucket).toBe("agent-artifacts");
  });

  it("signs a tab-task step screenshot in agent-chat-images, but never a plain chat image path", async () => {
    const step = `${TENANT_A}/${RUN}/0b8f3a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.jpg`;
    expect(await signTenantArtifactPath(TENANT_A, step, 600, "agent-chat-images")).toContain("agent-chat-images");
    expect(await signTenantArtifactPath(TENANT_A, `${TENANT_A}/0b8f3a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.jpg`, 600, "agent-chat-images")).toBeNull();
    expect(await signTenantArtifactPath(TENANT_A, `${TENANT_B}/${RUN}/x.jpg`, 600, "agent-chat-images")).toBeNull();
    expect(mocks.signed).toHaveLength(1);
  });

  it("signs launch-video-artifacts, so a delivered video chip actually opens", async () => {
    const url = await signTenantArtifactPath(
      TENANT_A,
      `${TENANT_A}/${RUN}/launch-video.mp4`,
      600,
      "launch-video-artifacts",
    );
    expect(url).toContain("launch-video-artifacts");
  });

  it("REFUSES an off-allowlist bucket without ever calling storage", async () => {
    const url = await signTenantArtifactPath(TENANT_A, `${TENANT_A}/${RUN}/x.mp4`, 600, "generative-video");
    expect(url).toBeNull();
    expect(mocks.signed).toHaveLength(0);
  });

  it("REFUSES an attacker-shaped bucket string without calling storage", async () => {
    for (const bucket of ["", "../agent-artifacts", "AGENT-ARTIFACTS", "agent-artifacts/../secrets"]) {
      expect(await signTenantArtifactPath(TENANT_A, `${TENANT_A}/${RUN}/x.pdf`, 600, bucket)).toBeNull();
    }
    expect(mocks.signed).toHaveLength(0);
  });
});

describe("signTenantArtifactPath — tenant isolation holds on EVERY bucket", () => {
  it("refuses another tenant's path in the video bucket", async () => {
    const url = await signTenantArtifactPath(
      TENANT_A,
      `${TENANT_B}/${RUN}/launch-video.mp4`,
      600,
      "launch-video-artifacts",
    );
    expect(url).toBeNull();
    expect(mocks.signed).toHaveLength(0);
  });

  it("refuses a traversal path that starts with the caller's tenant prefix", async () => {
    const url = await signTenantArtifactPath(
      TENANT_A,
      `${TENANT_A}/../${TENANT_B}/${RUN}/launch-video.mp4`,
      600,
      "launch-video-artifacts",
    );
    expect(url).toBeNull();
    expect(mocks.signed).toHaveLength(0);
  });

  it("refuses a malformed (non <tenant>/<run>/<file>) path in the video bucket", async () => {
    expect(
      await signTenantArtifactPath(TENANT_A, `${TENANT_A}/loose.mp4`, 600, "launch-video-artifacts"),
    ).toBeNull();
    expect(mocks.signed).toHaveLength(0);
  });
});

describe("bucket fallback is nullish-only", () => {
  it("an empty-string bucket is REFUSED, not silently signed as the default", async () => {
    expect(await signTenantArtifactPath(TENANT_A, `${TENANT_A}/${RUN}/x.pdf`, 600, "")).toBeNull();
    expect(mocks.signed).toHaveLength(0);
  });

  it("forces .svg to download instead of rendering inline (same rule as .html)", async () => {
    await signTenantArtifactPath(TENANT_A, `${TENANT_A}/${RUN}/logo.svg`);
    expect(mocks.signed[0].options?.download).toBe("logo.svg");
  });

  it("leaves a .png inline (no download option)", async () => {
    await signTenantArtifactPath(TENANT_A, `${TENANT_A}/${RUN}/shot.png`);
    expect(mocks.signed[0].options?.download).toBeUndefined();
  });

  it("the batch signer also forces .svg to download, not inline", async () => {
    const urls = await signTenantArtifactPaths(TENANT_A, [
      { storagePath: `${TENANT_A}/${RUN}/logo.svg`, bucket: "agent-artifacts" },
      { storagePath: `${TENANT_A}/${RUN}/shot.png`, bucket: "agent-artifacts" },
    ]);
    expect(urls).toHaveLength(2);
    expect(mocks.signed.map((x) => x.path)).toEqual([`${TENANT_A}/${RUN}/logo.svg`]);
    expect(mocks.signed[0].options?.download).toBe("logo.svg");
    expect(mocks.batchSigned).toEqual([`${TENANT_A}/${RUN}/shot.png`]);
  });
});

describe("artifact download names", () => {
  it("drops the id tag and the comma", () => {
    expect(videoDownloadName("Pick the cake, then the day 3fa9c1d2.mp4")).toBe("pick-the-cake-then-the-day.mp4");
  });

  it("gives a clean name for a question mark and an ellipsis title", () => {
    expect(videoDownloadName("Got a birthday coming up? Let's talk cake 7553adc2.mp4")).toBe("got-a-birthday-coming-up-lets-talk-cake.mp4");
    expect(videoDownloadName("The worst cake problem is finding out on the birthday that\u2026 7553adc2.mp4")).toBe("the-worst-cake-problem-is-finding-out-on-the-birthday-that.mp4");
  });

  it("replaces quotes and emoji and collapses spaces", () => {
    expect(videoDownloadName('Pick the "cake", then the day \u{1F382}  3fa9c1d2.mp4')).toBe("pick-the-cake-then-the-day.mp4");
  });

  it("emits only characters encodeURIComponent leaves alone", () => {
    const out = videoDownloadName("A/b\\c: d'e;f%g&h=i+j,k\u00e9\u{1F382} (x)-y_z 3fa9c1d2.mp4");
    expect(out).toBe("a-b-c-de-f-g-h-i-j-ke-x-y-z.mp4");
    expect(out).toBe(encodeURIComponent(out));
  });

  it.each([
    ["\u{1F382}, .mp4", "video.mp4"],
    [".mp4", "video.mp4"],
    [".mov", "video.mov"],
    [".WEBM", "video.webm"],
    [".M4V", "video.m4v"],
  ])("names an empty-stem %j video: %j", (input, expected) => {
    expect(videoDownloadName(input)).toBe(expected);
  });

  it("keeps a title that legitimately ends in an 8-char word without a digit", () => {
    expect(videoDownloadName("Summer sale starts beautiful.mp4")).toBe("summer-sale-starts-beautiful.mp4");
    expect(videoDownloadName("Launch deadbeef.mp4")).toBe("launch-deadbeef.mp4");
    expect(videoDownloadName("3fa9c1d2.mp4")).toBe("3fa9c1d2.mp4");
  });

  it("signs the download with the clean name", async () => {
    mocks.signed.length = 0;
    clearSignedUrlCache();
    const path = `${TENANT_A}/${RUN}/clip.mp4`;
    await signTenantArtifactPath(TENANT_A, path, 60, "launch-video-artifacts", "Pick the cake, then the day 3fa9c1d2.mp4");
    expect(mocks.signed[0].options?.download).toBe("pick-the-cake-then-the-day.mp4");
  });

  it("leaves a non-video download name exactly as given", async () => {
    mocks.signed.length = 0;
    clearSignedUrlCache();
    const path = `${TENANT_A}/${RUN}/report.pdf`;
    await signTenantArtifactPath(TENANT_A, path, 60, "launch-video-artifacts", "Q3 20241031.pdf");
    expect(mocks.signed[0].options?.download).toBe("Q3 20241031.pdf");
    clearSignedUrlCache();
    await signTenantArtifactPath(TENANT_A, path, 60, "launch-video-artifacts", "R\u00e9sum\u00e9 plan.pdf");
    expect(mocks.signed[1].options?.download).toBe("R\u00e9sum\u00e9 plan.pdf");
  });
});
