import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingleQueue: Array<{ data: unknown; error: unknown }> = [];
const updateEq = vi.fn();
const upsertAnchorMock = vi.fn();
const upsertAnchorGuardedMock = vi.fn();
const writeMutationAuditMock = vi.fn();

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      const pass = () => chain;
      for (const m of ["select", "eq", "is", "order"]) chain[m] = pass;
      chain.maybeSingle = () =>
        Promise.resolve(maybeSingleQueue.shift() ?? { data: null, error: null });
      chain.update = () => ({ eq: updateEq });
      return chain;
    },
  }),
}));

vi.mock("@/services/memory/upsert-anchor", () => ({
  upsertAnchor: (i: unknown, o?: unknown) => upsertAnchorMock(i, o),
  upsertAnchorGuarded: (i: unknown, a: unknown, o?: unknown) => upsertAnchorGuardedMock(i, a, o),
}));

const projectMock = vi.fn();
const regenerateMock = vi.fn();
vi.mock("@/services/company/facts", () => ({
  projectCompanyFactValue: (...a: unknown[]) => projectMock(...a),
}));
vi.mock("@/services/company/brief", () => ({
  regenerateCompanyBrief: (t: string) => regenerateMock(t),
}));

vi.mock("@/services/memory/mutation-audit", () => ({
  writeMutationAudit: (p: unknown) => writeMutationAuditMock(p),
  buildEditSnapshot: (n: unknown) => ({ snapshot: n }),
}));

import { promoteDiscoveryDraft, isCanonicalSlug } from "../promote-draft";

const TENANT = "49ca8ccd-e52c-4ca3-b7f2-14bcbe32b6fe";
const DRAFT = {
  data: {
    id: "draft-1",
    title: "company (unverified discovery draft)",
    body_markdown: "E Closet is a US college fashion-rental marketplace.",
    metadata: { discovery: { confidence: "high" } },
  },
  error: null,
};
const none = { data: null, error: null };

beforeEach(() => {
  vi.clearAllMocks();
  maybeSingleQueue.length = 0;
  updateEq.mockResolvedValue({ error: null });
  upsertAnchorMock.mockResolvedValue({ note_id: "canon-1", chunks: 3 });
  upsertAnchorGuardedMock.mockResolvedValue({ note_id: "canon-1", chunks: 3 });
  projectMock.mockResolvedValue({ written: true, error: null });
  regenerateMock.mockResolvedValue(true);
});

describe("promote a discovery draft into the canonical anchor (non-company slugs)", () => {
  it("canonical slug validation", () => {
    expect(isCanonicalSlug("company")).toBe(true);
    expect(isCanonicalSlug("company__inferred")).toBe(false);
    expect(isCanonicalSlug("nonsense")).toBe(false);
  });

  it("no draft → no_draft, nothing written", async () => {
    maybeSingleQueue.push(none);
    const r = await promoteDiscoveryDraft({ tenant_id: TENANT, slug: "ops" });
    expect(r).toMatchObject({ ok: false, code: "no_draft" });
    expect(upsertAnchorGuardedMock).not.toHaveBeenCalled();
    expect(upsertAnchorMock).not.toHaveBeenCalled();
  });

  it("empty anchor slot → promotes as praxis_staff (a human reviewed it) and retires the draft", async () => {
    maybeSingleQueue.push(DRAFT, none);
    const r = await promoteDiscoveryDraft({ tenant_id: TENANT, slug: "ops" });
    expect(r).toMatchObject({ ok: true, slug: "ops", note_id: "canon-1", forced: false });
    const [input] = upsertAnchorGuardedMock.mock.calls[0];
    expect(input).toMatchObject({ slug: "ops", source: "praxis_staff" });
    expect(updateEq).toHaveBeenCalled();
  });

  it("HUMAN anchor in the way + no force → REFUSES, canonical untouched", async () => {
    upsertAnchorGuardedMock.mockResolvedValue(null);
    maybeSingleQueue.push(DRAFT, {
      data: { id: "canon-existing", title: "ops.md", body_markdown: "founder wrote this", source: "human" },
      error: null,
    });

    const r = await promoteDiscoveryDraft({ tenant_id: TENANT, slug: "ops" });
    expect(r).toMatchObject({ ok: false, code: "protected_anchor", existing_source: "human" });
    expect(upsertAnchorMock).not.toHaveBeenCalled();
    expect(updateEq).not.toHaveBeenCalled();
  });

  it("force:true → deliberately overwrites the human anchor AND writes a WORM audit of what it replaced", async () => {
    maybeSingleQueue.push(DRAFT, {
      data: { id: "canon-existing", title: "ops.md", body_markdown: "founder wrote this", source: "human" },
      error: null,
    });

    const r = await promoteDiscoveryDraft({
      tenant_id: TENANT,
      slug: "ops",
      force: true,
      actor_user_id: "staff-1",
    });
    expect(r).toMatchObject({ ok: true, forced: true });
    expect(upsertAnchorMock).toHaveBeenCalled();
    const audit = writeMutationAuditMock.mock.calls[0][0] as {
      action: string;
      actor_user_id: string;
      reason: string;
    };
    expect(audit.action).toBe("edit");
    expect(audit.actor_user_id).toBe("staff-1");
    expect(audit.reason).toMatch(/FORCED/);
  });

  it("a discovery-written anchor may be replaced without force (it is not a human's)", async () => {
    maybeSingleQueue.push(DRAFT, {
      data: { id: "canon-existing", title: "ops.md", body_markdown: "older discovery", source: "agent_discovery_verified" },
      error: null,
    });
    const r = await promoteDiscoveryDraft({ tenant_id: TENANT, slug: "ops" });
    expect(r).toMatchObject({ ok: true, forced: false });
  });

  it("un-provenanced agent_write is OVERWRITABLE — a machine's guess is not the customer's words", async () => {
    maybeSingleQueue.push(DRAFT, {
      data: { id: "canon-existing", title: "ops.md", body_markdown: "an unsourced guess", source: "agent_write" },
      error: null,
    });

    const r = await promoteDiscoveryDraft({ tenant_id: TENANT, slug: "ops" });
    expect(r).toMatchObject({ ok: true, forced: false });

    const allowlist = upsertAnchorGuardedMock.mock.calls[0][1] as string[];
    expect(allowlist).toContain("agent_write");
  });

  it("the allowlist NEVER contains a human-authored source — widening it must not swallow the founder", async () => {
    maybeSingleQueue.push(DRAFT, none);
    await promoteDiscoveryDraft({ tenant_id: TENANT, slug: "ops" });

    const allowlist = upsertAnchorGuardedMock.mock.calls[0][1] as string[];
    for (const humanSource of ["human", "operator_feedback", "praxis_staff"]) {
      expect(allowlist).not.toContain(humanSource);
    }
  });

  it("names the ACTUAL source in a refusal — a provenance guard must never claim 'a human' wrote what it cannot attribute", async () => {
    upsertAnchorGuardedMock.mockResolvedValue(null);
    maybeSingleQueue.push(DRAFT, {
      data: { id: "canon-existing", title: "ops.md", body_markdown: "x", source: "operator_feedback" },
      error: null,
    });

    const r = await promoteDiscoveryDraft({ tenant_id: TENANT, slug: "ops" });
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === "protected_anchor") {
      expect(r.existing_source).toBe("operator_feedback");
      expect(r.message).toContain("operator_feedback");
      expect(r.message).not.toMatch(/was written by a human/);
    }
  });
});

describe("promote a company draft", () => {
  it("writes the prose into the record's story, and renders once via the fact write", async () => {
    maybeSingleQueue.push(DRAFT, none, {
      data: { id: "brief-1", metadata: { rendered_at: new Date(Date.now() + 1000).toISOString() } },
      error: null,
    });
    const r = await promoteDiscoveryDraft({ tenant_id: TENANT, slug: "company", via: "judge" });

    expect(r).toMatchObject({ ok: true, slug: "company", note_id: "brief-1" });
    expect(projectMock).toHaveBeenCalledWith(
      TENANT,
      "company_story",
      DRAFT.data.body_markdown,
      "onboarding_enrichment",
      expect.stringContaining("draft-1"),
    );
    expect(regenerateMock).not.toHaveBeenCalled();
    expect(upsertAnchorMock).not.toHaveBeenCalled();
    expect(upsertAnchorGuardedMock).not.toHaveBeenCalled();
    expect(updateEq).toHaveBeenCalled();
  });

  it("refuses when a higher-ranked source holds the story, and keeps the draft", async () => {
    projectMock.mockResolvedValue({ written: false, error: null });
    maybeSingleQueue.push(DRAFT, {
      data: { id: "canon-existing", title: "company.md", body_markdown: "founder wrote this", source: "human" },
      error: null,
    });

    const r = await promoteDiscoveryDraft({ tenant_id: TENANT, slug: "company" });
    expect(r).toMatchObject({ ok: false, code: "protected_anchor" });
    expect((r as { message: string }).message).toMatch(/Company Details/);
    expect(regenerateMock).not.toHaveBeenCalled();
    expect(updateEq).not.toHaveBeenCalled();
  });
});

describe("promote a company draft when the brief does not rebuild", () => {
  it("fails instead of retiring the draft against a stale note", async () => {
    maybeSingleQueue.push(DRAFT, none, {
      data: { id: "stale-note", metadata: { rendered_at: "2020-01-01T00:00:00.000Z" } },
      error: null,
    });
    const r = await promoteDiscoveryDraft({ tenant_id: TENANT, slug: "company", via: "judge" });

    expect(r).toMatchObject({ ok: false, code: "render_failed" });
    expect(updateEq).not.toHaveBeenCalled();
  });

  it("fails when there is no live brief at all afterwards", async () => {
    maybeSingleQueue.push(DRAFT, none, none);
    const r = await promoteDiscoveryDraft({ tenant_id: TENANT, slug: "company", via: "judge" });

    expect(r).toMatchObject({ ok: false, code: "render_failed" });
    expect(updateEq).not.toHaveBeenCalled();
  });
});
