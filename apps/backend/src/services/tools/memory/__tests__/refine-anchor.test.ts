
import { describe, it, expect, vi, beforeEach } from "vitest";

const previewMock = vi.hoisted(() => vi.fn());
const stashMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/services/memory/generate-anchors", () => ({
  generateRefinedAnchorPreview: previewMock,
}));
vi.mock("../_anchor-pending", () => ({
  stashPending: stashMock,
  hashBody: (s: string) => `h:${s.length}`,
}));

import { brainRefineAnchorTool } from "../refine-anchor";
import { ExpectedToolError } from "../../types";

const PREVIEW = {
  slug: "company",
  body_markdown: "# Company\n\nWe are pre-revenue.",
  key_facts: [{ label: "stage", value: "pre-revenue" }],
  metadata: { key_facts: [{ label: "stage", value: "pre-revenue" }] },
  note_id: "",
  chunks: 0,
  tokens: { input: 1, output: 1 },
};

const baseCtx = {
  tenant_id: "t1",
  run_id: "run-1",
  agent_slug: "chief-of-staff",
  run_trigger: "chat",
  chat_thread_id: "thread-1",
  log: () => {},
};
const input = { slug: "company", refine_instruction: "we are pre-revenue, no customer count" };

beforeEach(() => {
  previewMock.mockReset().mockResolvedValue(PREVIEW);
  stashMock.mockReset().mockResolvedValue(undefined);
});

describe("brain_refine_anchor trust gate", () => {
  it.each(["cron", "a2a", "webhook", "slack", "manual", "email", "handoff", undefined])(
    "FAILS CLOSED on non-chat trigger: %s",
    async (trigger) => {
      await expect(
        brainRefineAnchorTool.execute({ ...baseCtx, run_trigger: trigger as string }, input),
      ).rejects.toMatchObject({ code: "brain_refine_anchor_denied" });
      expect(previewMock).not.toHaveBeenCalled();
      expect(stashMock).not.toHaveBeenCalled();
    },
  );

  it("requires a chat thread to stage the confirmation", async () => {
    await expect(
      brainRefineAnchorTool.execute({ ...baseCtx, chat_thread_id: undefined }, input),
    ).rejects.toMatchObject({ code: "brain_refine_anchor_no_thread" });
    expect(stashMock).not.toHaveBeenCalled();
  });
});

describe("brain_refine_anchor happy path", () => {
  it("previews, stashes the body, and asks for confirmation", async () => {
    const out = (await brainRefineAnchorTool.execute(baseCtx, input)) as Record<string, unknown>;
    expect(previewMock).toHaveBeenCalledWith({
      tenant_id: "t1",
      slug: "company",
      refineInstruction: "we are pre-revenue, no customer count",
    });
    expect(stashMock).toHaveBeenCalledTimes(1);
    const stashed = (stashMock.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(stashed.proposed_body).toBe(PREVIEW.body_markdown);
    expect(stashed.run_id).toBe("run-1");
    expect(out.awaiting_confirmation).toBe(true);
    expect(out.body_markdown).toBe(PREVIEW.body_markdown);
  });

  it("surfaces a stable error when the preview throws", async () => {
    previewMock.mockRejectedValue(new Error("opus parse fail"));
    const err = await brainRefineAnchorTool.execute(baseCtx, input).catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect((err as { code: string }).code).toBe("brain_refine_anchor_failed");
    expect(stashMock).not.toHaveBeenCalled();
  });
});
