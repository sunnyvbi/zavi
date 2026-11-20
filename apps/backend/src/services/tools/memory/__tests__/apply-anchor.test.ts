
import { describe, it, expect, vi, beforeEach } from "vitest";

const readMock = vi.hoisted(() => vi.fn());
const clearMock = vi.hoisted(() => vi.fn(async () => undefined));
const supersedeMock = vi.hoisted(() => vi.fn(async () => 2));
const upsertMock = vi.hoisted(() => vi.fn(async () => ({ note_id: "note-9", chunks: 3 })));
const proseMock = vi.hoisted(() => vi.fn(async () => ({ stored: true, reason: "written", error: null })));

vi.mock("../_anchor-pending", () => ({
  readPending: readMock,
  clearPending: clearMock,
  supersedeContradictingDerivedNotes: supersedeMock,
  isPendingFresh: (p: { created_at: string }) => Date.parse(p.created_at) > 0 && true,
  hashBody: (s: string) => `h:${s.length}`,
}));
vi.mock("@/services/memory/upsert-anchor", () => ({ upsertAnchor: upsertMock }));
vi.mock("@/services/company/brief", () => ({ writeCompanyProse: proseMock }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: { id: "note-company" }, error: null });
    return { from: () => q };
  },
}));

import { brainApplyAnchorTool } from "../apply-anchor";

const BODY = "# Company\n\nWe are pre-revenue.";
const pending = {
  slug: "ops",
  proposed_body: BODY,
  key_facts: undefined,
  metadata: {},
  hash: `h:${BODY.length}`,
  run_id: "run-PRIOR",
  created_at: new Date().toISOString(),
};
const ctx = {
  tenant_id: "t1",
  run_id: "run-NOW",
  agent_slug: "chief-of-staff",
  run_trigger: "chat",
  chat_thread_id: "thread-1",
  log: () => {},
};

beforeEach(() => {
  readMock.mockReset().mockResolvedValue({ ...pending });
  clearMock.mockReset().mockResolvedValue(undefined);
  supersedeMock.mockReset().mockResolvedValue(2);
  upsertMock.mockReset().mockResolvedValue({ note_id: "note-9", chunks: 3 });
});

describe("brain_apply_anchor trust gate", () => {
  it.each(["cron", "a2a", "webhook", "slack", undefined])("FAILS CLOSED on trigger %s", async (t) => {
    await expect(
      brainApplyAnchorTool.execute({ ...ctx, run_trigger: t as string }, { confirm: true }),
    ).rejects.toMatchObject({ code: "brain_apply_anchor_denied" });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("requires confirm:true", async () => {
    await expect(brainApplyAnchorTool.execute(ctx, { confirm: false })).rejects.toMatchObject({
      code: "brain_apply_anchor_not_confirmed",
    });
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("brain_apply_anchor guards", () => {
  it("no-ops when nothing is pending", async () => {
    readMock.mockResolvedValueOnce(null);
    await expect(brainApplyAnchorTool.execute(ctx, { confirm: true })).rejects.toMatchObject({
      code: "brain_apply_anchor_nothing_pending",
    });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("rejects a same-run draft (forces echo-then-confirm across two turns)", async () => {
    readMock.mockResolvedValueOnce({ ...pending, run_id: "run-NOW" });
    await expect(brainApplyAnchorTool.execute(ctx, { confirm: true })).rejects.toMatchObject({
      code: "brain_apply_anchor_same_turn",
    });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("rejects + clears a corrupt draft (hash mismatch)", async () => {
    readMock.mockResolvedValueOnce({ ...pending, hash: "h:WRONG" });
    await expect(brainApplyAnchorTool.execute(ctx, { confirm: true })).rejects.toMatchObject({
      code: "brain_apply_anchor_corrupt",
    });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(clearMock).toHaveBeenCalled();
  });
});

describe("brain_apply_anchor happy path", () => {
  it("persists the EXACT stashed body, retires stale notes, clears pending", async () => {
    const out = (await brainApplyAnchorTool.execute(ctx, { confirm: true })) as Record<string, unknown>;
    expect(upsertMock).toHaveBeenCalledWith({
      tenant_id: "t1",
      slug: "ops",
      title: "ops.md",
      body_markdown: BODY,
      source: "agent_write",
      metadata: {},
    });
    expect(supersedeMock).toHaveBeenCalledWith("t1", "ops", "note-9", BODY);
    expect(clearMock).toHaveBeenCalled();
    expect(out).toMatchObject({ applied: true, note_id: "note-9", stale_notes_retired: 2 });
  });
});

describe("brain_apply_anchor on the company slug", () => {
  const companyPending = { ...pending, slug: "company" };

  beforeEach(() => {
    readMock.mockReset().mockResolvedValue({ ...companyPending });
  });

  it("writes the record as the founder, never the note", async () => {
    proseMock.mockResolvedValue({ stored: true, reason: "written", error: null });
    const out = (await brainApplyAnchorTool.execute(ctx, { confirm: true })) as Record<string, unknown>;

    expect(upsertMock).not.toHaveBeenCalled();
    expect(proseMock).toHaveBeenCalledWith("t1", BODY, "founder", expect.stringContaining("operator-confirmed"));
    expect(out).toMatchObject({ applied: true });
    expect(clearMock).toHaveBeenCalled();
  });

  it("keeps the pending draft when the write did not land", async () => {
    proseMock.mockResolvedValue({ stored: false, reason: "outranked", error: null });

    await expect(brainApplyAnchorTool.execute(ctx, { confirm: true })).rejects.toMatchObject({
      code: "brain_apply_anchor_outranked",
    });
    expect(clearMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("tells the operator the wording is still pending", async () => {
    proseMock.mockResolvedValue({ stored: false, reason: "outranked", error: null });
    await expect(brainApplyAnchorTool.execute(ctx, { confirm: true })).rejects.toMatchObject({
      message: expect.stringContaining("still pending"),
    });
  });
});
