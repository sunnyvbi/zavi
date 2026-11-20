
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildToolInputShape, unwrapToolArgs } from "../mcp-server-tools";

const SEARCH_CODE_SCHEMA = {
  type: "object",
  properties: {
    owner: { type: "string" },
    repo: { type: "string" },
    query: { type: "string" },
  },
  required: ["owner", "repo", "query"],
};

const repoCoord = z.object({ owner: z.string().min(1), repo: z.string().min(1) });

function throughSdk(inputSchema: unknown, emitted: unknown) {
  const { shape, declaresOwnInput } = buildToolInputShape(inputSchema);
  const parsed = z.object(shape).parse(emitted);
  return unwrapToolArgs(parsed, declaresOwnInput);
}

describe("buildToolInputShape / unwrapToolArgs", () => {
  it("FLAT args survive and satisfy downstream validation (the prod bug)", () => {
    const realInput = throughSdk(SEARCH_CODE_SCHEMA, {
      owner: "rravi149",
      repo: "upcar-private",
      query: "trial",
    });

    expect(realInput).toEqual({
      owner: "rravi149",
      repo: "upcar-private",
      query: "trial",
    });
    expect(repoCoord.safeParse(realInput).success).toBe(true);
  });

  it("the OLD shape reproduces the exact prod failure — proves the fix is load-bearing", () => {
    const oldShape = z.object({ input: z.record(z.string(), z.unknown()).optional() });
    const parsed = oldShape.parse({
      owner: "rravi149",
      repo: "upcar-private",
      query: "trial",
    });

    expect(parsed).toEqual({});
    const failure = repoCoord.safeParse(parsed);
    expect(failure.success).toBe(false);
    if (!failure.success) {
      expect(failure.error.issues.map((i) => i.path[0])).toContain("owner");
      expect(failure.error.issues[0]?.message).toContain("received undefined");
    }
  });

  it("NESTED {input:{...}} still works — back-compat is preserved", () => {
    const realInput = throughSdk(SEARCH_CODE_SCHEMA, {
      input: { owner: "rravi149", repo: "upcar-private", query: "trial" },
    });

    expect(realInput).toEqual({
      owner: "rravi149",
      repo: "upcar-private",
      query: "trial",
    });
    expect(repoCoord.safeParse(realInput).success).toBe(true);
  });

  it("a tool that declares its OWN `input` param keeps it — no envelope unwrap", () => {
    const schema = {
      type: "object",
      properties: { input: { type: "string" }, mode: { type: "string" } },
    };
    const { declaresOwnInput } = buildToolInputShape(schema);
    expect(declaresOwnInput).toBe(true);

    const realInput = throughSdk(schema, { input: "some text", mode: "fast" });
    expect(realInput).toEqual({ input: "some text", mode: "fast" });
  });

  it("a no-arg tool still accepts the legacy envelope and an empty call", () => {
    const schema = { type: "object", properties: {} };
    expect(throughSdk(schema, {})).toEqual({});
    expect(throughSdk(schema, { input: { a: 1 } })).toEqual({ a: 1 });
  });

  it("a missing / malformed input_schema degrades to the legacy envelope shape", () => {
    for (const bad of [undefined, null, "nonsense", 42]) {
      const { shape, declaresOwnInput } = buildToolInputShape(bad);
      expect(Object.keys(shape)).toEqual(["input"]);
      expect(declaresOwnInput).toBe(false);
    }
  });

  it("optional properties mean a partial call reaches downstream validation, not zod", () => {
    const realInput = throughSdk(SEARCH_CODE_SCHEMA, { owner: "rravi149" });
    expect(realInput).toEqual({ owner: "rravi149" });
    expect(repoCoord.safeParse(realInput).success).toBe(false);
  });
});
