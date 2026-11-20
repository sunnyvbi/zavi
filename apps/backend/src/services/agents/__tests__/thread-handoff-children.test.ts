import { describe, it, expect } from "vitest";
import {
  handoffStatusBlock,
  readRecentHandoffChildren,
  readTenantWorkingRunSlugs,
  readWorkingHandoffChildSlugs,
  type HandoffChild,
} from "../thread-handoff-children";

const THREAD = "a2d80040-6dc6-4274-a3ba-a73d765bf980";

const failed: HandoffChild = { id: "c1", agent_slug: "engineer", status: "parse_failed" };
const running: HandoffChild = { id: "c2", agent_slug: "engineer", status: "running" };
const shipped: HandoffChild = {
  id: "c3",
  agent_slug: "engineer",
  status: "success",
  outcome: { side_effect: { kind: "shipped" } } as HandoffChild["outcome"],
  parsed: { pr_url: "https://github.com/acme/web/pull/12", pr_number: 12, title: "Add pricing page" },
};

describe("handoffStatusBlock — the operator's view of its hand-offs", () => {
  it("is empty when the thread handed nothing off", () => {
    expect(handoffStatusBlock([])).toBe("");
  });

  it("says plainly that a failed hand-off couldn't finish, with no ids", () => {
    const block = handoffStatusBlock([failed]);
    expect(block).toContain("- engineer: couldn't finish. Nothing was saved.");
    expect(block).not.toContain("c1");
    expect(block).not.toMatch(/still working/);
  });

  it("still tells the operator an answer-only child answered", () => {
    const block = handoffStatusBlock([{ ...failed, status: "success", outcome: null, output_text: "Here is the spec." }]);
    expect(block).toContain("- engineer: finished. Answered.");
  });

  it("reports working and a shipped PR with its link", () => {
    const block = handoffStatusBlock([running, shipped]);
    expect(block).toContain("- engineer: still working on it.");
    expect(block).toContain(
      "- engineer: finished. Opened PR #12: Add pricing page https://github.com/acme/web/pull/12",
    );
  });
});

describe("readRecentHandoffChildren", () => {
  function fakeSb(result: { data: unknown; error: unknown }, calls: string[][]) {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "order", "limit", "in"]) {
      q[m] = (...args: unknown[]) => {
        calls.push([m, ...args.map(String)]);
        return m === "limit" || m === "in" ? Promise.resolve(result) : q;
      };
    }
    return { from: (t: string) => (calls.push(["from", t]), q) } as never;
  }

  it("filters by tenant, hand-off trigger and this thread", async () => {
    const calls: string[][] = [];
    const rows = await readRecentHandoffChildren(
      fakeSb({ data: [failed], error: null }, calls),
      "tenant-1",
      THREAD,
    );
    expect(rows).toEqual({ ok: true, value: [failed] });
    expect(calls).toContainEqual(["eq", "tenant_id", "tenant-1"]);
    expect(calls).toContainEqual(["eq", "trigger", "handoff"]);
    expect(calls).toContainEqual(["eq", "payload->>operator_thread_id", THREAD]);
  });

  it("reports a read error as unknown, not as no children", async () => {
    expect(await readRecentHandoffChildren(fakeSb({ data: null, error: { message: "x" } }, []), "t", THREAD)).toEqual({ ok: false });
    expect(await readRecentHandoffChildren(fakeSb({ data: [failed], error: null }, []), "t", "not-a-uuid")).toEqual({ ok: true, value: [] });
    expect(await readRecentHandoffChildren(fakeSb({ data: [failed], error: null }, []), "t", null)).toEqual({ ok: true, value: [] });
  });
});

describe("readWorkingHandoffChildSlugs", () => {
  function fakeSb(result: { data: unknown; error: unknown }, calls: string[][]) {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "order", "limit", "in"]) {
      q[m] = (...args: unknown[]) => {
        calls.push([m, ...args.map(String)]);
        return m === "in" ? Promise.resolve(result) : q;
      };
    }
    return { from: (t: string) => (calls.push(["from", t]), q) } as never;
  }

  it("reads every queued/running child of this thread, tenant-scoped, with no row cap", async () => {
    const calls: string[][] = [];
    const r = await readWorkingHandoffChildSlugs(
      fakeSb({ data: [{ agent_slug: "engineer" }, { agent_slug: "research" }], error: null }, calls),
      "tenant-1",
      THREAD,
    );
    expect(r).toEqual({ ok: true, value: ["engineer", "research"] });
    expect(calls).toContainEqual(["eq", "tenant_id", "tenant-1"]);
    expect(calls).toContainEqual(["eq", "trigger", "handoff"]);
    expect(calls).toContainEqual(["eq", "payload->>operator_thread_id", THREAD]);
    expect(calls).toContainEqual(["in", "status", "queued,running,pending"]);
    expect(calls.some((c) => c[0] === "limit")).toBe(false);
  });

  it("returns unknown on a read error or a throw", async () => {
    expect(await readWorkingHandoffChildSlugs(fakeSb({ data: null, error: { message: "x" } }, []), "t", THREAD)).toEqual({ ok: false });
    const throwing = { from: () => { throw new Error("boom"); } } as never;
    expect(await readWorkingHandoffChildSlugs(throwing, "t", THREAD)).toEqual({ ok: false });
  });
});

describe("readTenantWorkingRunSlugs — what backs 'the specialist is working on it'", () => {
  function sb(result: { data: unknown; error: unknown }, calls: Array<[string, unknown]>) {
    const b: any = {
      from: () => b,
      select: () => b,
      eq: (k: string, v: unknown) => (calls.push([k, v]), b),
      in: (k: string, v: unknown) => (calls.push([k, v]), b),
      gte: (k: string, v: unknown) => (calls.push([k, v]), b),
      order: () => b,
      limit: async () => result,
    };
    return b;
  }

  it("lists this tenant's recent working runs, leaving out this turn and cgo", async () => {
    const calls: Array<[string, unknown]> = [];
    const r = await readTenantWorkingRunSlugs(
      sb({ data: [{ id: "me", agent_slug: "operator" }, { id: "x", agent_slug: "cgo" }, { id: "y", agent_slug: "instagram_organic" }], error: null }, calls),
      "t1",
      "me",
    );
    expect(r).toEqual({ ok: true, value: ["instagram_organic"] });
    expect(calls).toEqual(expect.arrayContaining([["tenant_id", "t1"], ["status", ["queued", "running", "pending"]]]));
    expect(calls.some(([k]) => k === "enqueued_at")).toBe(true);
  });

  it("a failed read is unknown, never 'nothing is working'", async () => {
    expect(await readTenantWorkingRunSlugs(sb({ data: null, error: { message: "boom" } }, []), "t1", "me")).toEqual({ ok: false });
  });
});

