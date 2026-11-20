import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  single: [] as { path: string; ttl: number; options: unknown }[],
  batch: [] as { paths: string[]; ttl: number }[],
  now: 1_700_000_000_000,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async (path: string, ttl: number, options?: unknown) => {
          mocks.single.push({ path, ttl, options });
          return { data: { signedUrl: `https://signed/${path}?n=${mocks.single.length}` }, error: null };
        },
        createSignedUrls: async (paths: string[], ttl: number) => {
          mocks.batch.push({ paths, ttl });
          return {
            data: paths.map((path) => ({
              path,
              signedUrl: `https://signed/${path}?b=${mocks.batch.length}`,
              error: null,
            })),
            error: null,
          };
        },
      }),
    },
  }),
}));

import {
  IMAGE_THUMBNAIL,
  signTenantArtifactPath,
  signTenantArtifactPaths,
  TTL_SECONDS,
} from "../file-url";
import {
  clearSignedUrlCache,
  MIN_REMAINING_SECONDS,
  readSignedUrl,
  SIGN_TTL_SECONDS,
  signedUrlCacheKey,
  storeSignedUrl,
} from "@/services/run-artifacts/signed-url-cache";

const TENANT = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const RUN = "11111111-1111-4111-1111-111111111111";
const PATH = `${TENANT}/${RUN}/visual.png`;
const OTHER = `${TENANT}/${RUN}/other.png`;

beforeEach(() => {
  clearSignedUrlCache();
  mocks.single = [];
  mocks.batch = [];
  vi.useRealTimers();
});

describe("signed URL memo", () => {
  it("signs a path once and hands the same URL back for the next ten minutes at least", async () => {
    const first = await signTenantArtifactPath(TENANT, PATH);
    const second = await signTenantArtifactPath(TENANT, PATH);
    expect(first).toBe(second);
    expect(mocks.single).toHaveLength(1);
    expect(mocks.single[0].ttl).toBeGreaterThanOrEqual(SIGN_TTL_SECONDS);
    expect(SIGN_TTL_SECONDS - TTL_SECONDS).toBeGreaterThanOrEqual(MIN_REMAINING_SECONDS);
  });

  it("re-signs once the remembered URL has less than the advertised TTL left", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(mocks.now);
    const first = await signTenantArtifactPath(TENANT, PATH);
    vi.setSystemTime(mocks.now + (SIGN_TTL_SECONDS - MIN_REMAINING_SECONDS - 1) * 1000);
    expect(await signTenantArtifactPath(TENANT, PATH)).toBe(first);
    vi.setSystemTime(mocks.now + (SIGN_TTL_SECONDS - MIN_REMAINING_SECONDS + 1) * 1000);
    const later = await signTenantArtifactPath(TENANT, PATH);
    expect(later).not.toBe(first);
    expect(mocks.single).toHaveLength(2);
  });

  it("keeps the thumbnail, the original and a download apart", async () => {
    const original = await signTenantArtifactPath(TENANT, PATH);
    const thumb = await signTenantArtifactPath(TENANT, PATH, TTL_SECONDS, undefined, undefined, IMAGE_THUMBNAIL);
    const download = await signTenantArtifactPath(TENANT, PATH, TTL_SECONDS, undefined, "visual.png");
    expect(new Set([original, thumb, download]).size).toBe(3);
    expect(mocks.single).toHaveLength(3);
    expect(await signTenantArtifactPath(TENANT, PATH, TTL_SECONDS, undefined, undefined, IMAGE_THUMBNAIL)).toBe(thumb);
    expect(mocks.single).toHaveLength(3);
  });

  it("the list batch skips paths a single sign already remembered, and the single signer reuses what the batch minted", async () => {
    const single = await signTenantArtifactPath(TENANT, PATH);
    const batch = await signTenantArtifactPaths(TENANT, [
      { storagePath: PATH },
      { storagePath: OTHER },
    ]);
    expect(batch[0]).toBe(single);
    expect(mocks.batch).toHaveLength(1);
    expect(mocks.batch[0].paths).toEqual([OTHER]);
    expect(await signTenantArtifactPath(TENANT, OTHER)).toBe(batch[1]);
    expect(mocks.single).toHaveLength(1);
  });

  it("never remembers a refused path, so a foreign tenant cannot be served from the memo", async () => {
    const foreign = `bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb/${RUN}/visual.png`;
    expect(await signTenantArtifactPath(TENANT, foreign)).toBeNull();
    expect(readSignedUrl(signedUrlCacheKey("agent-artifacts", foreign, undefined))).toBeNull();
    expect(mocks.single).toHaveLength(0);
  });

  it("refuses to remember a URL that would expire before the advertised TTL", () => {
    storeSignedUrl("k", "https://x", MIN_REMAINING_SECONDS);
    expect(readSignedUrl("k")).toBeNull();
  });
});
