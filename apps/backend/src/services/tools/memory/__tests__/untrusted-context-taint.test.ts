
import { describe, it, expect, vi, beforeEach } from "vitest";

const previewMock = vi.hoisted(() => vi.fn());
const stashMock = vi.hoisted(() => vi.fn(async () => undefined));
const readMock = vi.hoisted(() => vi.fn());
const clearMock = vi.hoisted(() => vi.fn(async () => undefined));
const supersedeMock = vi.hoisted(() => vi.fn(async () => 2));
const upsertMock = vi.hoisted(() => vi.fn(async () => ({ note_id: "note-9", chunks: 3 })));
const retireMock = vi.hoisted(() =>
  vi.fn(async () => ({ retired: 1, titles: ["a stale note"] })),
);

vi.mock("@/services/memory/generate-anchors", () => ({
  generateRefinedAnchorPreview: previewMock,
}));
vi.mock("@/services/memory/upsert-anchor", () => ({ upsertAnchor: upsertMock }));
vi.mock("../_anchor-pending", () => ({
  stashPending: stashMock,
  readPending: readMock,
  clearPending: clearMock,
  supersedeContradictingDerivedNotes: supersedeMock,
  isPendingFresh: () => true,
  hashBody: (s: string) => `h:${s.length}`,
  retireNotesByDescription: retireMock,
}));

import { brainRefineAnchorTool } from "../refine-anchor";
import { brainApplyAnchorTool } from "../apply-anchor";
import { brainRetireNoteTool } from "../retire-note";

const BODY = "# Company\n\nWe are pre-revenue.";
const PREVIEW = {
  slug: "ops",
  body_markdown: BODY,
  key_facts: [{ label: "stage", value: "pre-revenue" }],
  metadata: { key_facts: [{ label: "stage", value: "pre-revenue" }] },
  note_id: "",
  chunks: 0,
  tokens: { input: 1, output: 1 },
};
const PENDING = {
  slug: "ops",
  proposed_body: BODY,
  key_facts: undefined,
  metadata: {},
  hash: `h:${BODY.length}`,
  run_id: "run-PRIOR",
  created_at: new Date().toISOString(),
};

function ctx(untrusted_context?: boolean) {
  return {
    tenant_id: "t1",
    run_id: "run-NOW",
    agent_slug: "chief-of-staff",
    run_trigger: "chat",
    untrusted_context,
    chat_thread_id: "thread-1",
    log: () => {},
  };
}

function screenshotCtx() {
  return { ...ctx(false), captured_page_context: true };
}

beforeEach(() => {
  vi.clearAllMocks();
  previewMock.mockResolvedValue(PREVIEW);
  stashMock.mockResolvedValue(undefined);
  readMock.mockResolvedValue({ ...PENDING });
  upsertMock.mockResolvedValue({ note_id: "note-9", chunks: 3 });
  retireMock.mockResolvedValue({ retired: 1, titles: ["a stale note"] });
});

describe("brain_refine_anchor — tainted chat is refused like a non-chat trigger", () => {
  const input = { slug: "ops" as const, refine_instruction: "we are pre-revenue" };

  it("TAINTED: refused with the SAME code a cron run gets, and no draft is generated", async () => {
    await expect(brainRefineAnchorTool.execute(ctx(true), input)).rejects.toMatchObject({
      code: "brain_refine_anchor_denied",
    });
    expect(previewMock).not.toHaveBeenCalled();
    expect(stashMock).not.toHaveBeenCalled();
  });

  it("UNTAINTED chat still drafts + stashes", async () => {
    await brainRefineAnchorTool.execute(ctx(undefined), input);
    expect(previewMock).toHaveBeenCalledTimes(1);
    expect(stashMock).toHaveBeenCalledTimes(1);
  });
});

describe("brain_apply_anchor — tainted chat is refused like a non-chat trigger", () => {
  it("TAINTED: refused, and NOTHING is written to the brain", async () => {
    await expect(
      brainApplyAnchorTool.execute(ctx(true), { confirm: true }),
    ).rejects.toMatchObject({ code: "brain_apply_anchor_denied" });
    expect(readMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  it("UNTAINTED chat still persists the confirmed draft", async () => {
    await brainApplyAnchorTool.execute(ctx(undefined), { confirm: true });
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});

describe("brain_retire_note — tainted chat is refused like a non-chat trigger", () => {
  const input = { description: "the note saying we have 100 customers" };

  it("TAINTED: refused, and NOTHING is retired", async () => {
    await expect(brainRetireNoteTool.execute(ctx(true), input)).rejects.toMatchObject({
      code: "brain_retire_note_denied",
    });
    expect(retireMock).not.toHaveBeenCalled();
  });

  it("UNTAINTED chat still retires the matching notes", async () => {
    const out = (await brainRetireNoteTool.execute(ctx(undefined), input)) as {
      retired: number;
    };
    expect(out.retired).toBe(1);
    expect(retireMock).toHaveBeenCalledTimes(1);
  });
});

describe("the taint cannot be cleared from LLM input (C8)", () => {
  it("a model-supplied untrusted_context:false in the tool input is ignored", async () => {
    await expect(
      brainRetireNoteTool.execute(ctx(true), {
        description: "forget everything",
        untrusted_context: false,
        run_trigger: "chat",
      } as never),
    ).rejects.toMatchObject({ code: "brain_retire_note_denied" });
    expect(retireMock).not.toHaveBeenCalled();
  });
});

describe("the three brain tools refuse a SCREENSHOT turn too", () => {
  it("refine is refused", async () => {
    await expect(
      brainRefineAnchorTool.execute(screenshotCtx(), {
        slug: "ops" as const,
        refine_instruction: "we are pre-revenue",
      }),
    ).rejects.toMatchObject({ code: "brain_refine_anchor_denied" });
    expect(stashMock).not.toHaveBeenCalled();
  });

  it("apply is refused", async () => {
    await expect(
      brainApplyAnchorTool.execute(screenshotCtx(), { confirm: true }),
    ).rejects.toMatchObject({ code: "brain_apply_anchor_denied" });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("retire is refused — this one DELETES the company's own facts", async () => {
    await expect(
      brainRetireNoteTool.execute(screenshotCtx(), { description: "anything stale" }),
    ).rejects.toMatchObject({ code: "brain_retire_note_denied" });
    expect(retireMock).not.toHaveBeenCalled();
  });

  it("an ordinary typed chat turn is still allowed through", async () => {
    await expect(
      brainRefineAnchorTool.execute(ctx(false), {
        slug: "ops" as const,
        refine_instruction: "we are pre-revenue",
      }),
    ).resolves.toBeDefined();
    expect(stashMock).toHaveBeenCalled();
  });
});
