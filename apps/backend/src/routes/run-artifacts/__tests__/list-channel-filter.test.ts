
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const SEO_RUN = "11111111-1111-4111-1111-111111111111";
const GEO_RUN = "22222222-2222-4222-2222-222222222222";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  runs: [] as Record<string, unknown>[],
  artifacts: [] as Record<string, unknown>[],
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      let inIds: string[] | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: string) => { f[c] = v; return chain; },
        in: (_c: string, v: string[]) => { inIds = v; return chain; },
        order: () => chain,
        limit: () => {
          const src = table === "agent_runs" ? mocks.runs : mocks.artifacts;
          let data = src.filter((r) =>
            Object.entries(f).every(([k, v]) => r[k] === v),
          );
          if (inIds) data = data.filter((r) => inIds!.includes(String(r.run_id)));
          return Promise.resolve({ data, error: null });
        },
      };
      return chain;
    },
  }),
  serviceClient: () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed" }, error: null }) }) },
  }),
}));

import { listRunArtifacts } from "../list";
import { clearSignedUrlCache } from "@/services/run-artifacts/signed-url-cache";

function res() {
  const r: { code?: number; body?: unknown } = {};
  return {
    r,
    status(c: number) { r.code = c; return this; },
    json(b: unknown) { r.body = b; return this; },
  } as never;
}
const artifacts = (o: ReturnType<typeof res>) =>
  ((o as unknown as { r: { body: { artifacts: { filename: string }[] } } }).r.body.artifacts);

beforeEach(() => {
  clearSignedUrlCache();
  mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT, access_token: "t" });
  mocks.runs = [
    { id: SEO_RUN, tenant_id: TENANT, channel_slug: "seo" },
    { id: GEO_RUN, tenant_id: TENANT, channel_slug: "geo" },
  ];
  mocks.artifacts = [
    { id: "a1", tenant_id: TENANT, run_id: SEO_RUN, agent_slug: "seo", filename: "seo-page-draft.html", title: "SEO draft", mime: "text/html", bytes: 7893, storage_path: `${TENANT}/x/seo-page-draft.html`, bucket: "agent-artifacts", created_at: "2026-09-14T08:22:00Z", updated_at: null, thread_id: null },
    { id: "a2", tenant_id: TENANT, run_id: GEO_RUN, agent_slug: "seo", filename: "geo-answer-brief.html", title: "GEO brief", mime: "text/html", bytes: 4100, storage_path: `${TENANT}/y/geo-answer-brief.html`, bucket: "agent-artifacts", created_at: "2026-09-13T10:00:00Z", updated_at: null, thread_id: null },
  ];
});

describe("run-artifacts ?channel", () => {
  it("returns only the named channel's outputs", async () => {
    const o = res();
    await listRunArtifacts({ query: { channel: "seo" } } as never, o);
    expect(artifacts(o).map((a) => a.filename)).toEqual(["seo-page-draft.html"]);
  });

  it("does NOT leak a sibling channel that shares the same executor", async () => {
    const o = res();
    await listRunArtifacts({ query: { channel: "geo" } } as never, o);
    const got = artifacts(o).map((a) => a.filename);
    expect(got).toEqual(["geo-answer-brief.html"]);
    expect(got).not.toContain("seo-page-draft.html");
  });

  it("an unknown channel returns EMPTY, never the whole tenant", async () => {
    const o = res();
    await listRunArtifacts({ query: { channel: "does-not-exist" } } as never, o);
    expect(artifacts(o)).toEqual([]);
  });

  it("omitting ?channel still lists everything (unchanged behaviour)", async () => {
    const o = res();
    await listRunArtifacts({ query: {} } as never, o);
    expect(artifacts(o)).toHaveLength(2);
  });

  it("an artifact from an UNSTAMPED run is not attributed to any channel", async () => {
    mocks.artifacts.push({ id: "a3", tenant_id: TENANT, run_id: "33333333-3333-4333-3333-333333333333", agent_slug: "seo", filename: "orphan-draft.html", title: null, mime: "text/html", bytes: 100, storage_path: `${TENANT}/z/orphan-draft.html`, bucket: "agent-artifacts", created_at: "2026-09-14T09:00:00Z", updated_at: null, thread_id: null });
    const o = res();
    await listRunArtifacts({ query: { channel: "seo" } } as never, o);
    expect(artifacts(o).map((a) => a.filename)).toEqual(["seo-page-draft.html"]);
  });
});
