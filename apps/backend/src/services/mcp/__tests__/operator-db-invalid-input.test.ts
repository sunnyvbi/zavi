
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

vi.mock("@/services/data-gateway", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withAttachedDriver: vi.fn(async () => {
    throw new Error("execute must not be reached on invalid input");
  }),
}));

import { callOperatorDbTool } from "../internal/operator-db";

const TENANT = "00000000-0000-0000-0000-000000000001";

describe("callOperatorDbTool — invalid input", () => {
  it.each([
    ["unparseable sort value", { collection: "trips", mode: "find", sort: { a: "-1" } }],
    ["stringified stage inside a real array", { collection: "trips", mode: "aggregate", pipeline: ['{"$match":{}}'] }],
    ["non-numeric limit", { collection: "trips", mode: "find", limit: "50 rows" }],
    ["missing required collection", { mode: "find" }],
  ])("returns a tool error instead of throwing on %s", async (_label, args) => {
    const res = await callOperatorDbTool(TENANT, "query", args);
    expect(res.ok).toBe(false);
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("tool_input_invalid");
  });

  it("still routes unknown tools to tool_unknown", async () => {
    const res = await callOperatorDbTool(TENANT, "nope", {});
    expect(JSON.parse(res.content).error).toBe("tool_unknown");
  });
});
