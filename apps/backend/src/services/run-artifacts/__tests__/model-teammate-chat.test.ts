
import { describe, it, expect } from "vitest";
import { presentArtifact, readableThreadIds, type ArtifactRow } from "../model";

const row = (over: Partial<ArtifactRow> = {}): ArtifactRow => ({
  id: "a1",
  tenant_id: "t1",
  run_id: "r1",
  storage_path: "t1/r1/x.pdf",
  bucket: null,
  filename: "x.pdf",
  title: null,
  mime: "application/pdf",
  bytes: 1,
  created_at: "2026-09-27T00:00:00Z",
  updated_at: null,
  agent_slug: "operator",
  thread_id: "own-thread",
  ...over,
});

function sbSeeing(visible: string[], opts: { fail?: boolean } = {}) {
  const calls: string[][] = [];
  const sb = {
    from: () => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => {
          calls.push(ids);
          if (opts.fail) return { data: null, error: { message: "boom" } };
          return { data: ids.filter((id) => visible.includes(id)).map((id) => ({ id })), error: null };
        },
      }),
    }),
  };
  return { sb, calls };
}

describe("presentArtifact — teammate chats", () => {
  it("links a file from the member's OWN chat to that chat", async () => {
    const { sb } = sbSeeing(["own-thread"]);
    const r = row();
    const a = presentArtifact(r, null, await readableThreadIds(sb, [r]));
    expect(a.source.href).toBe("/workspace?agent=operator&thread=own-thread");
    expect(a.source.title).toBe("Operator chat");
  });

  it("drops the link on a file from a TEAMMATE's chat", async () => {
    const { sb } = sbSeeing([]);
    const r = row({ thread_id: "their-thread" });
    const a = presentArtifact(r, null, await readableThreadIds(sb, [r]));
    expect(a.source.href).toBeNull();
    expect(a.source.title).toBe("a teammate's chat");
  });

  it("keeps the run link for a task file (no thread), including a missing thread_id", async () => {
    const { sb, calls } = sbSeeing([]);
    const rows = [row({ thread_id: null }), row({ thread_id: undefined as unknown as null })];
    const readable = await readableThreadIds(sb, rows);
    expect(calls).toEqual([]);
    for (const r of rows) {
      expect(presentArtifact(r, null, readable).source.href).toBe("/workspace/runs/r1");
    }
  });

  it("a failed ownership read keeps the link instead of hiding one that works", async () => {
    const { sb } = sbSeeing([], { fail: true });
    const r = row();
    const readable = await readableThreadIds(sb, [r]);
    expect(readable).toBeNull();
    expect(presentArtifact(r, null, readable).source.href).toBe(
      "/workspace?agent=operator&thread=own-thread",
    );
  });

  it("checks each thread once", async () => {
    const { sb, calls } = sbSeeing(["own-thread"]);
    await readableThreadIds(sb, [row(), row(), row({ thread_id: "their-thread" })]);
    expect(calls).toEqual([["own-thread", "their-thread"]]);
  });
});
