
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: "art-1" }, error: null }) }) })),
  upload: vi.fn(async () => ({ error: null })),
  binding: vi.fn(async () => ({ agent_slug: "operator", thread_id: null })),
  publish: vi.fn(async () => ({ published: true, url: "https://z.app/p/abc" })),
  guard: vi.fn(async () => "t-1"),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: () => ({ upsert: mocks.upsert }) }),
  tenantStorage: () => ({ from: () => ({ upload: mocks.upload }) }),
}));
vi.mock("../guard", () => ({ assertRunTenantOwnership: mocks.guard }));
vi.mock("../run-binding", () => ({ artifactRunBinding: mocks.binding }));
vi.mock("@/services/agents/prototype-links", () => ({ publishDocLink: mocks.publish }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/brand/resolve-brand-kit", () => ({
  resolveBrandKit: vi.fn(async () => ({
    primary: "#027bff", accent: null, bg: "#ffffff", text: "#191919",
    source: "default", source_url: null, evidence: [],
  })),
}));
vi.mock("@/services/sandbox/tool-registry", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sanitizeArtifactFilename: (f: string) => f,
}));

import { deliverDoc, PUBLIC_LINK_DISCLOSURE } from "../deliver-doc";

const INPUT = {
  title: "Co-host earnings",
  filename: "cohost-earnings.html",
  sections: [{ heading: "Pipeline", body_markdown: "Money moves." }],
};
const CTX = { tenant_id: "t-1", run_id: "r-1" };

describe("deliver_doc writes a row run_artifacts will actually accept", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("uses the real column names and the full conflict target", async () => {
    await deliverDoc(CTX, INPUT);
    const [row, opts] = mocks.upsert.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { onConflict: string },
    ];

    expect(row).toHaveProperty("mime", "text/html");
    expect(row).not.toHaveProperty("mime_type");

    expect(opts.onConflict).toBe("tenant_id,run_id,filename");
  });

  it("actually carries run_id — the field an unawaited spread silently dropped", async () => {
    await deliverDoc(CTX, INPUT);
    const [row] = mocks.upsert.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(row.run_id).toBe("r-1");
    expect(row.tenant_id).toBe("t-1");
    expect(row.filename).toBe("cohost-earnings.html");
    expect(typeof row.bytes).toBe("number");
    expect(row.bytes).toBeGreaterThan(0);
  });

  it("awaits the run binding rather than spreading a Promise", async () => {
    await deliverDoc(CTX, INPUT);
    const [row] = mocks.upsert.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(mocks.binding).toHaveBeenCalledWith("r-1");
    expect(row.agent_slug).toBe("operator");
  });

  it("hands back the disclosure whenever it hands back a link", async () => {
    const out = await deliverDoc(CTX, INPUT);
    expect(out.url).toBe("https://z.app/p/abc");
    expect(out.link_disclosure).toBe(PUBLIC_LINK_DISCLOSURE);
  });

  it("still delivers the file when the link is disabled, and claims no link", async () => {
    mocks.publish.mockResolvedValueOnce({ published: false, reason: "disabled" } as never);
    const out = await deliverDoc(CTX, INPUT);
    expect(out.url).toBeNull();
    expect(out.link_error).toBe("disabled");
    expect(out.link_disclosure).toBeUndefined();
    expect(out.artifact_id).toBe("art-1");
  });

  it("a link publish that throws never takes the document down with it", async () => {
    mocks.publish.mockRejectedValueOnce(new Error("boom"));
    const out = await deliverDoc(CTX, INPUT);
    expect(out.url).toBeNull();
    expect(out.artifact_id).toBe("art-1");
  });

  it("forces a .html extension", async () => {
    await deliverDoc(CTX, { ...INPUT, filename: "cohost-earnings" });
    const [row] = mocks.upsert.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(row.filename).toBe("cohost-earnings.html");
  });

  it("checks tenant ownership of the run before writing anything", async () => {
    await deliverDoc(CTX, INPUT);
    expect(mocks.guard).toHaveBeenCalledWith({ tenant_id: "t-1", run_id: "r-1" });
  });
});
