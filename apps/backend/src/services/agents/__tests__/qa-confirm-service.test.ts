import { describe, it, expect, beforeEach, vi } from "vitest";

const addCalls: Array<{ title: string; created_by: string }> = [];
let dupTitles = new Set<string>();
let hardErrTitles = new Set<string>();
vi.mock("@/services/mcp/internal/qa-engineer", () => ({
  qaAddTestCase: vi.fn(async (_ctx: unknown, args: { title: string; created_by: string }) => {
    if (dupTitles.has(args.title)) {
      const err = new Error(`a test case titled "${args.title}" already exists`) as Error & { code?: string };
      err.code = "duplicate_title";
      throw err;
    }
    if (hardErrTitles.has(args.title)) {
      throw new Error(`transient DB error inserting "${args.title}"`);
    }
    addCalls.push({ title: args.title, created_by: args.created_by });
    return { id: `id-${addCalls.length}` };
  }),
}));

import { dispatchDeterministicConfirm } from "../qa-confirm-service";

const draft = (index: number, title: string) => ({
  index,
  title,
  role: "guest" as const,
  nl_spec: { steps: ["s1"], expected_outcome: "done ok", preconditions: [] },
  tags: ["t"],
});

const DRAFTS = [draft(1, "Sign up"), draft(2, "Search"), draft(3, "Checkout")];

type Captured = { inserts: Array<Record<string, unknown>> };
function mkSb(priorMeta: unknown, insertError = false): { sb: any; captured: Captured } {
  const captured: Captured = { inserts: [] };
  const sb = {
    from(table: string) {
      return {
        select() {
          const chain: any = {
            eq() { return chain; },
            filter() { return chain; },
            not() { return chain; },
            order() { return chain; },
            limit() { return chain; },
            async maybeSingle() {
              if (table === "agent_thread_messages") {
                return { data: priorMeta == null ? null : { id: "draft-msg", agent_run_id: "run-1", meta: priorMeta }, error: null };
              }
              return { data: null, error: null };
            },
          };
          return chain;
        },
        insert(row: Record<string, unknown>) {
          captured.inserts.push(row);
          return Promise.resolve(
            insertError ? { error: { message: "insert failed" } } : { error: null },
          );
        },
        update() {
          const inner: any = { eq() { return inner; }, then(r: (v: { error: null }) => void) { r({ error: null }); } };
          return inner;
        },
      };
    },
  };
  return { sb, captured };
}

const userBubbles = (captured: Captured) =>
  captured.inserts.filter((i) => i.sender_role === "user");

beforeEach(() => {
  addCalls.length = 0;
  dupTitles = new Set();
  hardErrTitles = new Set();
});

const base = { tenantId: "t1", threadId: "th1", message: "" };

describe("dispatchDeterministicConfirm", () => {
  it("returns handled:false when there is no prior draft turn", async () => {
    const { sb } = mkSb(null);
    const r = await dispatchDeterministicConfirm({ ...base, sb, message: "add 1" });
    expect(r.handled).toBe(false);
    expect(addCalls).toHaveLength(0);
  });

  it("returns handled:false when meta.drafts is malformed", async () => {
    const { sb } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: [{ bad: true }] });
    const r = await dispatchDeterministicConfirm({ ...base, sb, message: "add 1" });
    expect(r.handled).toBe(false);
  });

  it("returns handled:false on an unparsable reply (LLM fallback)", async () => {
    const { sb } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS });
    const r = await dispatchDeterministicConfirm({ ...base, sb, message: "the first two please" });
    expect(r.handled).toBe(false);
    expect(addCalls).toHaveLength(0);
  });

  it("'add 1, 3' inserts exactly those two with created_by=operator-chat", async () => {
    const { sb } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS });
    const r = await dispatchDeterministicConfirm({ ...base, sb, message: "add 1, 3" });
    expect(r).toMatchObject({ handled: true, action: "added", added: 2, duplicates: 0 });
    expect(addCalls.map((c) => c.title)).toEqual(["Sign up", "Checkout"]);
    expect(addCalls.every((c) => c.created_by === "operator-chat")).toBe(true);
  });

  it("'add all' inserts every draft", async () => {
    const { sb } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS });
    const r = await dispatchDeterministicConfirm({ ...base, sb, message: "add all" });
    expect(r).toMatchObject({ handled: true, action: "added", added: 3 });
    expect(addCalls).toHaveLength(3);
  });

  it("'skip' inserts nothing and writes a skipped bubble", async () => {
    const { sb, captured } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS });
    const r = await dispatchDeterministicConfirm({ ...base, sb, message: "skip" });
    expect(r).toMatchObject({ handled: true, action: "skipped", added: 0 });
    expect(addCalls).toHaveLength(0);
    const assistant = captured.inserts.find((i) => i.sender_role === "assistant");
    expect((assistant?.meta as { envelope_category?: string })?.envelope_category).toBe("qa-chat-add-skipped");
  });

  it("out-of-range 'add 5' on 3 drafts → clarify, no inserts, no LLM fallback", async () => {
    const { sb, captured } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS });
    const r = await dispatchDeterministicConfirm({ ...base, sb, message: "add 5" });
    expect(r).toMatchObject({ handled: true, action: "clarify", added: 0 });
    expect(addCalls).toHaveLength(0);
    const assistant = captured.inserts.find((i) => i.sender_role === "assistant");
    expect((assistant?.meta as { envelope_category?: string })?.envelope_category).toBe("qa-chat-add-clarify");
  });

  it("counts duplicate_title without crashing", async () => {
    dupTitles = new Set(["Search"]);
    const { sb } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS });
    const r = await dispatchDeterministicConfirm({ ...base, sb, message: "add 1, 2" });
    expect(r).toMatchObject({ handled: true, action: "added", added: 1, duplicates: 1 });
    expect(addCalls.map((c) => c.title)).toEqual(["Sign up"]);
  });

  it("hard error mid-loop → partial_error, does NOT throw, owns the turn", async () => {
    hardErrTitles = new Set(["Search"]);
    const { sb, captured } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS });
    const r = await dispatchDeterministicConfirm({ ...base, sb, message: "add all" });
    expect(r).toMatchObject({ handled: true, action: "partial_error" });
    expect(addCalls.map((c) => c.title)).toEqual(["Sign up"]);
    expect(userBubbles(captured)).toHaveLength(1);
    const assistant = captured.inserts.find(
      (i) => (i.meta as { envelope_category?: string })?.envelope_category === "qa-chat-add-partial-error",
    );
    expect(assistant).toBeTruthy();
  });

  it("a non-duplicate error does not bubble out as a thrown exception", async () => {
    hardErrTitles = new Set(["Sign up"]);
    const { sb } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS });
    await expect(
      dispatchDeterministicConfirm({ ...base, sb, message: "add 1" }),
    ).resolves.toMatchObject({ handled: true, action: "partial_error", added: 0 });
  });

  it("skip still writes the user bubble", async () => {
    const { sb, captured } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS });
    await dispatchDeterministicConfirm({ ...base, sb, message: "skip" });
    expect(userBubbles(captured)).toHaveLength(1);
  });

  it("out-of-range clarify still writes the user bubble", async () => {
    const { sb, captured } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS });
    await dispatchDeterministicConfirm({ ...base, sb, message: "add 5" });
    expect(userBubbles(captured)).toHaveLength(1);
  });

  it("add all writes exactly one user bubble", async () => {
    const { sb, captured } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS });
    await dispatchDeterministicConfirm({ ...base, sb, message: "add all" });
    expect(userBubbles(captured)).toHaveLength(1);
  });

  it("survives a Supabase {error} on the bubble insert (no throw)", async () => {
    const { sb } = mkSb({ envelope_category: "qa-chat-add-draft", drafts: DRAFTS }, true);
    const r = await dispatchDeterministicConfirm({ ...base, sb, message: "add 1" });
    expect(r).toMatchObject({ handled: true, action: "added", added: 1 });
  });
});
