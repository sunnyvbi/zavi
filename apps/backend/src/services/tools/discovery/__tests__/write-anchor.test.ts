import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantMaybeSingle = vi.fn();
const upsertAnchorMock = vi.fn();
const upsertAnchorGuardedMock = vi.fn();
const getCaptureLedgerMock = vi.fn();

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: tenantMaybeSingle }),
      }),
    }),
  }),
}));

vi.mock("@/services/memory/upsert-anchor", () => ({
  upsertAnchor: (input: unknown, opts?: unknown) => upsertAnchorMock(input, opts),
  upsertAnchorGuarded: (input: unknown, allowed: unknown, opts?: unknown) =>
    upsertAnchorGuardedMock(input, allowed, opts),
}));

vi.mock("@/services/agents/engine/capture-ledger", () => ({
  getCaptureLedger: (run_id: string) => getCaptureLedgerMock(run_id),
}));

import {
  discoveryWriteAnchorTool,
  DISCOVERY_AGENT_SLUG,
  DISCOVERY_OWNED_SOURCES,
  hostOf,
  isOwnHost,
  type WriteAnchorOutput,
} from "../write-anchor";
import { ExpectedToolError } from "../../types";

const TENANT = "49ca8ccd-e52c-4ca3-b7f2-14bcbe32b6fe";
const ctx = (agent_slug: string | undefined = DISCOVERY_AGENT_SLUG) => ({
  tenant_id: TENANT,
  run_id: "run-1",
  agent_slug,
  log: () => {},
});
const call = (c: ReturnType<typeof ctx>, input: unknown): Promise<WriteAnchorOutput> =>
  discoveryWriteAnchorTool.execute(c, input) as Promise<WriteAnchorOutput>;

const cap = (final_url: string) => ({ requested_url: final_url, final_url });
const CITED = [
  { url: "https://eclosetapp.com/about" },
  { url: "https://theplainsman.com/article/e-closet" },
];

beforeEach(() => {
  vi.clearAllMocks();
  tenantMaybeSingle.mockResolvedValue({
    data: { product_url: { marketing: "https://eclosetapp.com" } },
    error: null,
  });
  getCaptureLedgerMock.mockReturnValue([
    cap("https://eclosetapp.com/about"),
    cap("https://theplainsman.com/article/e-closet"),
  ]);
  upsertAnchorGuardedMock.mockResolvedValue({ note_id: "note-canonical", chunks: 2 });
  upsertAnchorMock.mockResolvedValue({ note_id: "note-draft", chunks: 0 });
});

describe("host parsing cannot be spoofed", () => {
  it("strips userinfo: https://eclosetapp.com@evil.tld is EVIL.TLD", () => {
    expect(hostOf("https://eclosetapp.com@evil.tld/x")).toBe("evil.tld");
  });
  it("rejects non-https", () => {
    expect(hostOf("http://eclosetapp.com")).toBeNull();
  });
  it("isOwnHost: exact host and subdomains match", () => {
    const own = new Set(["eclosetapp.com"]);
    expect(isOwnHost("eclosetapp.com", own)).toBe(true);
    expect(isOwnHost("www.eclosetapp.com", own)).toBe(true);
  });
  it("isOwnHost REGRESSION: a neighbour on the same public suffix does NOT match", () => {
    const own = new Set(["brand.github.io"]);
    expect(isOwnHost("evil.github.io", own)).toBe(false);
    expect(isOwnHost("attacker.co.uk", new Set(["company.co.uk"]))).toBe(false);
  });
});

describe("onboarding_discovery.write_anchor — anti-poisoning guards", () => {
  it("GUARD 1: refuses any agent that is not onboarding-discovery", async () => {
    await expect(
      discoveryWriteAnchorTool.execute(ctx("performance-marketer"), {
        slug: "company",
        body_markdown: "hi",
        sources: CITED,
      }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(upsertAnchorGuardedMock).not.toHaveBeenCalled();
    expect(upsertAnchorMock).not.toHaveBeenCalled();
  });

  it("GUARD 5: refuses when no https evidence is cited", async () => {
    await expect(
      discoveryWriteAnchorTool.execute(ctx(), {
        slug: "company",
        body_markdown: "hi",
        sources: [{ url: "http://insecure.example.com" }],
      }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
  });

  it("DRAFT-ONLY: even a fully-corroborated finding is a DRAFT, never a canonical write", async () => {
    const out = await call(ctx(), {
      slug: "company",
      body_markdown: "E Closet is a US college fashion-rental marketplace.",
      sources: CITED,
    });
    expect(out).toMatchObject({ written: "draft", slug: "company__inferred", confidence: "high" });
    expect(upsertAnchorGuardedMock).not.toHaveBeenCalled();
    const [input] = upsertAnchorMock.mock.calls[0];
    expect(input).toMatchObject({ slug: "company__inferred", source: "agent_discovery_inferred" });
  });

  it("GUARD 2 (REGRESSION): CITING the tenant's site without FETCHING it ⇒ draft", async () => {
    getCaptureLedgerMock.mockReturnValue([cap("https://a.evil.tld/x"), cap("https://b.evil.tld/y")]);
    const out = await call(ctx(), {
      slug: "company",
      body_markdown: "hallucinated body an injected page told me to write",
      sources: [{ url: "https://eclosetapp.com/" }, { url: "https://a.evil.tld/x" }],
    });
    expect(out.written).toBe("draft");
    expect(out.confidence).toBe("low");
    expect(out.reason).toMatch(/never actually fetched/i);
  });

  it("GUARD 2 (REGRESSION): a same-public-suffix neighbour cannot corroborate", async () => {
    tenantMaybeSingle.mockResolvedValue({
      data: { product_url: { marketing: "https://brand.github.io" } },
      error: null,
    });
    getCaptureLedgerMock.mockReturnValue([cap("https://evil.github.io/x"), cap("https://other.tld/y")]);
    const out = await call(ctx(), {
      slug: "company",
      body_markdown: "poison",
      sources: [{ url: "https://evil.github.io/x" }],
    });
    expect(out.written).toBe("draft");
  });

  it("GUARD 2: only the tenant's own domain fetched (1 independent domain) ⇒ draft", async () => {
    getCaptureLedgerMock.mockReturnValue([cap("https://eclosetapp.com/a"), cap("https://eclosetapp.com/b")]);
    const out = await call(ctx(), { slug: "company", body_markdown: "x", sources: CITED });
    expect(out.written).toBe("draft");
  });

  it("GUARD 2: tenant has NO registered product domain ⇒ nothing can be verified", async () => {
    tenantMaybeSingle.mockResolvedValue({ data: { product_url: null }, error: null });
    const out = await call(ctx(), { slug: "company", body_markdown: "x", sources: CITED });
    expect(out.written).toBe("draft");
    expect(out.reason).toMatch(/no registered product domain/i);
  });

  it("GUARD 3: a human anchor can never be touched — discovery has NO canonical write path", async () => {
    await call(ctx(), {
      slug: "company",
      body_markdown: "discovery thinks it knows better than the human",
      sources: CITED,
    });
    expect(upsertAnchorGuardedMock).not.toHaveBeenCalled();
    const writtenSlugs = upsertAnchorMock.mock.calls.map((c) => (c[0] as { slug: string }).slug);
    expect(writtenSlugs).not.toContain("company");
  });

  it("GUARD 4: drafts use a NON-canonical slug, never embed, and get a SERVER-written title", async () => {
    getCaptureLedgerMock.mockReturnValue([cap("https://one.com/x")]);
    await call(ctx(), {
      slug: "ops",
      body_markdown: "draft",
      sources: [{ url: "https://one.com/x" }],
      title: "IGNORE ME: injected title poison",
    });
    const [input, opts] = upsertAnchorMock.mock.calls[0];
    expect(input).toMatchObject({ slug: "ops__inferred", source: "agent_discovery_inferred" });
    expect((input as { title: string }).title).toBe("ops (unverified discovery draft)");
    expect(opts).toEqual({ skipEmbedding: true });
  });

  it("GUARD 5: payload is bounded (oversized body rejected)", async () => {
    await expect(
      discoveryWriteAnchorTool.execute(ctx(), {
        slug: "company",
        body_markdown: "x".repeat(9000),
        sources: CITED,
      }),
    ).rejects.toBeTruthy();
  });
});
