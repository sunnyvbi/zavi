
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RUN = "11111111-1111-4111-1111-111111111111";

const mocks = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  options: [] as unknown[],
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
        createSignedUrl: async (path: string, _ttl: number, options?: unknown) => {
          mocks.options.push(options);
          return { data: { signedUrl: `https://signed/${path}` }, error: null };
        },
      }),
    },
  }),
}));

import { IMAGE_THUMBNAIL, runArtifactUrl } from "../file-url";
import { clearSignedUrlCache } from "@/services/run-artifacts/signed-url-cache";

function mkRes() {
  const headers: Record<string, string> = {};
  const res: Record<string, unknown> = { statusCode: 200, headers };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.set = (k: string, v: string) => ((headers[k] = v), res);
  return res as { statusCode: number; body: { signed_url?: string }; headers: Record<string, string> };
}

function rowFor(filename: string, mime: string) {
  return {
    tenant_id: TENANT,
    storage_path: `${TENANT}/${RUN}/${filename}`,
    bucket: "agent-artifacts",
    filename,
    mime,
  };
}

async function call(query: Record<string, string>) {
  const res = mkRes();
  await runArtifactUrl({ params: { id: "a1" }, query } as never, res as never);
  return res;
}

beforeEach(() => {
  clearSignedUrlCache();
  mocks.options = [];
});

describe("runArtifactUrl ?thumb=1", () => {
  it("signs an image with the thumbnail transform", async () => {
    mocks.row = rowFor("visual.png", "image/png");
    const res = await call({ thumb: "1" });
    expect(res.statusCode).toBe(200);
    expect(mocks.options[0]).toEqual({ transform: IMAGE_THUMBNAIL });
  });

  it("ignores thumb for a non-image (a PDF stays the original)", async () => {
    mocks.row = rowFor("report.pdf", "application/pdf");
    await call({ thumb: "1" });
    expect(mocks.options[0]).toBeUndefined();
  });

  it("never resizes a download", async () => {
    mocks.row = rowFor("visual.png", "image/png");
    await call({ thumb: "1", download: "1" });
    expect(mocks.options[0]).toEqual({ download: "visual.png", transform: undefined });
  });

  it("without thumb, an image is signed exactly as before", async () => {
    mocks.row = rowFor("visual.png", "image/png");
    await call({});
    expect(mocks.options[0]).toBeUndefined();
  });

  it("keeps the aspect ratio: the gallery sizes tiles by the image, so the resize must not crop", () => {
    expect(IMAGE_THUMBNAIL.resize).toBe("contain");
    expect(IMAGE_THUMBNAIL.height).toBeUndefined();
  });

  it("a second thumbnail request reuses the remembered URL and lets the browser cache the answer", async () => {
    mocks.row = rowFor("visual.png", "image/png");
    const first = await call({ thumb: "1" });
    const second = await call({ thumb: "1" });
    expect(second.body.signed_url).toBe(first.body.signed_url);
    expect(mocks.options).toHaveLength(1);
    expect(first.headers["Cache-Control"]).toMatch(/^private, max-age=\d+$/);
  });

  it("a download answer is never cached by the browser", async () => {
    mocks.row = rowFor("visual.png", "image/png");
    const res = await call({ download: "1" });
    expect(res.headers["Cache-Control"]).toBeUndefined();
  });
});
