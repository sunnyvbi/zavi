import { beforeEach, describe, expect, it, vi } from "vitest";

const uploads: { path: string; body: string; contentType: string }[] = [];
const rows: Record<string, unknown>[] = [];
let refuseTextPlain = false;

vi.mock("@/services/reports/constants", () => ({ ARTIFACT_BUCKET: "agent-artifacts", ARTIFACT_MAX_BYTES: 1 }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantStorage: () => ({
    from: () => ({
      upload: async (path: string, bytes: Buffer, opts: { contentType: string }) => {
        if (refuseTextPlain && opts.contentType === "text/plain") {
          return { error: { message: "mime type text/plain is not supported" } };
        }
        uploads.push({ path, body: bytes.toString("utf8"), contentType: opts.contentType });
        return { error: null };
      },
    }),
  }),
  tenantClient: () => ({
    from: () => ({
      upsert: async (row: Record<string, unknown>, opts: { onConflict: string }) => {
        expect(opts.onConflict).toBe("tenant_id,run_id,filename");
        const i = rows.findIndex(
          (r) => r.tenant_id === row.tenant_id && r.run_id === row.run_id && r.filename === row.filename,
        );
        if (i >= 0) rows[i] = row;
        else rows.push(row);
        return { error: null };
      },
    }),
  }),
}));

import { extractCopyBlocks, saveCopyBlockArtifacts } from "../copy-block-artifacts";

const ctx = { tenant_id: "t1", run_id: "r1", agent_slug: "cgo", thread_id: "th1" };

const REPLY = [
  "```copy Caption",
  "Fall weekend, sorted. Book a local car.",
  "#Upcar",
  "```",
  "",
  "```copy Ad copy",
  "No counter, no line.",
  "```",
  "",
  "Why these work: the first leads with the season.",
  "",
  "```sql",
  "select 1",
  "```",
].join("\n");

beforeEach(() => {
  uploads.length = 0;
  rows.length = 0;
  refuseTextPlain = false;
});

describe("extractCopyBlocks", () => {
  it("takes only ```copy fences, with their titles, and leaves analysis and code out", () => {
    expect(extractCopyBlocks(REPLY)).toEqual([
      { title: "Caption", text: "Fall weekend, sorted. Book a local car.\n#Upcar" },
      { title: "Ad copy", text: "No counter, no line." },
    ]);
  });

  it("names an untitled block and finds nothing in a reply without copy fences", () => {
    expect(extractCopyBlocks("```copy\nHello\n```")).toEqual([{ title: "Copy 1", text: "Hello" }]);
    expect(extractCopyBlocks("**Caption 1**\n\nPlain text")).toEqual([]);
    expect(extractCopyBlocks("```copywriting\nx\n```")).toEqual([]);
  });
});

describe("saveCopyBlockArtifacts", () => {
  it("writes one text artifact per block holding the block's exact text", async () => {
    expect(await saveCopyBlockArtifacts(ctx, REPLY)).toBe(2);
    expect(rows.map((r) => [r.filename, r.title, r.mime, r.thread_id])).toEqual([
      ["copy-1.txt", "Caption", "text/plain", "th1"],
      ["copy-2.txt", "Ad copy", "text/plain", "th1"],
    ]);
    expect(uploads[0]).toEqual({
      path: "t1/r1/copy-1.txt",
      body: "Fall weekend, sorted. Book a local car.\n#Upcar\n",
      contentType: "text/plain",
    });
  });

  it("does not duplicate on a retry of the same run", async () => {
    await saveCopyBlockArtifacts(ctx, REPLY);
    await saveCopyBlockArtifacts(ctx, REPLY);
    expect(rows).toHaveLength(2);
  });

  it("stores the object under an allowed type when the bucket refuses text/plain", async () => {
    refuseTextPlain = true;
    await saveCopyBlockArtifacts(ctx, "```copy\nHi\n```");
    expect(uploads).toEqual([{ path: "t1/r1/copy-1.txt", body: "Hi\n", contentType: "text/csv" }]);
    expect(rows[0].mime).toBe("text/plain");
  });

  it("writes nothing when the reply has no copy block", async () => {
    expect(await saveCopyBlockArtifacts(ctx, "Just analysis.")).toBe(0);
    expect(uploads).toHaveLength(0);
  });
});
