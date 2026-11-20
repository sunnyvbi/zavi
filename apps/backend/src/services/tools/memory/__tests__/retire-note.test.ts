
import { describe, it, expect, vi, beforeEach } from "vitest";

const retireMock = vi.hoisted(() => vi.fn());

vi.mock("../_anchor-pending", () => ({
  retireNotesByDescription: retireMock,
}));

import { brainRetireNoteTool } from "../retire-note";

const ctx = {
  tenant_id: "t1",
  run_id: "run-1",
  agent_slug: "chief-of-staff",
  run_trigger: "chat",
  chat_thread_id: "thread-1",
  log: () => {},
};
const input = { description: "the false claim that we're headquartered in Berlin" };

beforeEach(() => {
  retireMock.mockReset().mockResolvedValue({ retired: 1, titles: ["Headquarters location"] });
});

describe("brain_retire_note trust gate", () => {
  it.each(["cron", "a2a", "webhook", "slack", undefined])("FAILS CLOSED on trigger %s", async (t) => {
    await expect(
      brainRetireNoteTool.execute({ ...ctx, run_trigger: t as string }, input),
    ).rejects.toMatchObject({ code: "brain_retire_note_denied" });
    expect(retireMock).not.toHaveBeenCalled();
  });
});

describe("brain_retire_note happy path", () => {
  it("retires matching notes and reports the titles honestly", async () => {
    const out = (await brainRetireNoteTool.execute(ctx, input)) as Record<string, unknown>;
    expect(retireMock).toHaveBeenCalledWith("t1", input.description, {
      agent_slug: "chief-of-staff",
    });
    expect(out).toMatchObject({ retired: 1, titles: ["Headquarters location"] });
    expect(out.message).toContain("Headquarters location");
  });

  it("honestly reports when nothing matched", async () => {
    retireMock.mockResolvedValueOnce({ retired: 0, titles: [] });
    const out = (await brainRetireNoteTool.execute(ctx, input)) as Record<string, unknown>;
    expect(out.retired).toBe(0);
    expect(out.message).toMatch(/no clearly-matching note/i);
  });
});
