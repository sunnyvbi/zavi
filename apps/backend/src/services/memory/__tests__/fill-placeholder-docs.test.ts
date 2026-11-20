import { describe, it, expect, vi, beforeEach } from "vitest";

const tc = vi.hoisted(() => ({
  rows: [] as unknown,
  calls: { tid: undefined as string | undefined, table: undefined as string | undefined, in: undefined as unknown, is: undefined as unknown },
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => {
    tc.calls.tid = tid;
    return {
      from: (t: string) => {
        tc.calls.table = t;
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.in = (_c: string, v: unknown) => {
          tc.calls.in = v;
          return q;
        };
        q.is = (c: string, v: unknown) => {
          tc.calls.is = [c, v];
          const rows = tc.rows;
          return Promise.resolve(rows instanceof Error ? { data: null, error: { message: rows.message } } : { data: rows, error: null });
        };
        return q;
      },
    };
  },
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../generate-anchors", () => ({ regenerateAnchor: vi.fn() }));
vi.mock("../upsert-anchor", () => ({ upsertAnchorGuarded: vi.fn() }));

import { fillPlaceholderDocs, placeholderDocSlugsFor } from "../fill-placeholder-docs";
import { logEvent } from "@/services/logging/logEvent";

type Row = { slug: string; source: string; metadata: Record<string, unknown> };

function makeSb(rows: Row[] | Error) {
  tc.rows = rows;
  tc.calls = { tid: undefined, table: undefined, in: undefined, is: undefined };
  return { sb: undefined, calls: tc.calls };
}

const placeholder = (slug: string): Row => ({ slug, source: "onboarding_seed", metadata: { seed: "placeholder" } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let regenerate: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let upsertGuarded: any;

beforeEach(() => {
  vi.clearAllMocks();
  regenerate = vi.fn(async ({ slug }: { slug: string }) => ({
    slug,
    body_markdown: `# ${slug}\n\nreal text`,
    key_facts: undefined,
    note_id: "",
    chunks: 0,
    tokens: { input: 1, output: 1 },
  }));
  upsertGuarded = vi.fn(async () => ({ note_id: "n", chunks: 1 }));
});

describe("placeholderDocSlugsFor", () => {
  it("maps only support-lead and dispute-response", () => {
    expect(placeholderDocSlugsFor("support-lead")).toEqual(["policies", "disputes", "support"]);
    expect(placeholderDocSlugsFor("dispute-response")).toEqual(["disputes"]);
    expect(placeholderDocSlugsFor("operator")).toEqual([]);
  });
});

describe("fillPlaceholderDocs", () => {
  it("regenerates only onboarding_seed placeholders and writes them guarded as seed:'ai'", async () => {
    const { sb, calls } = makeSb([
      placeholder("policies"),
      { slug: "disputes", source: "human", metadata: {} },
      { slug: "support", source: "agent_write", metadata: { seed: "placeholder" } },
    ]);
    const out = await fillPlaceholderDocs("t-1", "support-lead", { regenerate: regenerate as never, upsertGuarded: upsertGuarded as never });

    expect(calls.table).toBe("memory_note");
    expect(calls.tid).toBe("t-1");
    expect(calls.in).toEqual(["policies", "disputes", "support"]);
    expect(calls.is).toEqual(["superseded_by", null]);

    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerate).toHaveBeenCalledWith({ tenant_id: "t-1", slug: "policies", persist: false });
    expect(upsertGuarded).toHaveBeenCalledTimes(1);
    expect(upsertGuarded).toHaveBeenCalledWith(
      {
        tenant_id: "t-1",
        slug: "policies",
        title: "policies.md",
        body_markdown: "# policies\n\nreal text",
        source: "onboarding_seed",
        metadata: { seed: "ai" },
      },
      ["onboarding_seed"],
    );
    expect(out).toEqual({ filled: ["policies"], refused: [], failed: [] });
  });

  it("leaves an onboarding_seed doc the AI already wrote (seed:'ai') alone", async () => {
    const { sb } = makeSb([{ slug: "disputes", source: "onboarding_seed", metadata: { seed: "ai" } }]);
    const out = await fillPlaceholderDocs("t-1", "dispute-response", { regenerate: regenerate as never, upsertGuarded: upsertGuarded as never });
    expect(regenerate).not.toHaveBeenCalled();
    expect(out.filled).toEqual([]);
  });

  it("dispute-response fills only disputes", async () => {
    const { sb, calls } = makeSb([placeholder("disputes")]);
    const out = await fillPlaceholderDocs("t-1", "dispute-response", { regenerate: regenerate as never, upsertGuarded: upsertGuarded as never });
    expect(calls.in).toEqual(["disputes"]);
    expect(out.filled).toEqual(["disputes"]);
  });

  it("other agents are a no-op (no read, no model call)", async () => {
    const { sb, calls } = makeSb([placeholder("policies")]);
    const out = await fillPlaceholderDocs("t-1", "operator", { regenerate: regenerate as never, upsertGuarded: upsertGuarded as never });
    expect(calls.table).toBeUndefined();
    expect(regenerate).not.toHaveBeenCalled();
    expect(out).toEqual({ filled: [], refused: [], failed: [] });
  });

  it("guard refusal (founder edited in between) is reported, not an error", async () => {
    const { sb } = makeSb([placeholder("support")]);
    upsertGuarded.mockResolvedValueOnce(null);
    const out = await fillPlaceholderDocs("t-1", "support-lead", { regenerate: regenerate as never, upsertGuarded: upsertGuarded as never });
    expect(out).toEqual({ filled: [], refused: ["support"], failed: [] });
  });

  it("swallows a model failure on one slug, still fills the others, and logs", async () => {
    const { sb } = makeSb([placeholder("policies"), placeholder("disputes")]);
    regenerate.mockRejectedValueOnce(new Error("model down"));
    const out = await fillPlaceholderDocs("t-1", "support-lead", { regenerate: regenerate as never, upsertGuarded: upsertGuarded as never });
    expect(out.failed).toEqual(["policies"]);
    expect(out.filled).toEqual(["disputes"]);
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(expect.objectContaining({ code: "placeholder_doc_fill_failed", tenant_id: "t-1" }));
  });

  it("swallows a read error", async () => {
    const { sb } = makeSb(new Error("db down"));
    await expect(
      fillPlaceholderDocs("t-1", "support-lead", { regenerate: regenerate as never, upsertGuarded: upsertGuarded as never }),
    ).resolves.toEqual({ filled: [], refused: [], failed: [] });
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("never throws even when logging throws", async () => {
    vi.mocked(logEvent).mockRejectedValueOnce(new Error("log down"));
    const { sb } = makeSb([placeholder("policies")]);
    upsertGuarded.mockRejectedValueOnce(new Error("rpc down"));
    const out = await fillPlaceholderDocs("t-1", "support-lead", { regenerate: regenerate as never, upsertGuarded: upsertGuarded as never });
    expect(out.failed).toEqual(["policies"]);
  });
});
