import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getConnectorTokenMock: vi.fn(),
  forceRefreshConnectorMock: vi.fn(),
  getSecretMock: vi.fn(),
}));

vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: mocks.getConnectorTokenMock,
  forceRefreshConnector: mocks.forceRefreshConnectorMock,
}));

vi.mock("@/services/secrets/vault", () => ({
  getSecret: mocks.getSecretMock,
}));

import { callJiraTool } from "../jira";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchSpy: any;

beforeEach(() => {
  mocks.getConnectorTokenMock.mockResolvedValue("tok");
  mocks.getSecretMock.mockResolvedValue("cloud-id-abc");
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  mocks.getConnectorTokenMock.mockReset();
  mocks.getSecretMock.mockReset();
  mocks.forceRefreshConnectorMock.mockReset();
});

async function callSearch(): Promise<Record<string, unknown>> {
  const r = await callJiraTool(
    { tenant_id: "t1", run_id: "r1" },
    "search",
    { jql: "project = X", max_results: 5 },
  );
  return JSON.parse(r.content) as Record<string, unknown>;
}

describe("jira search — agent_hints.truncated coverage", () => {
  it("count-based truncation: total > returned → truncated:true", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ issues: [{ key: "X-1" }], total: 17 }),
    );
    const json = await callSearch();
    const hints = json.agent_hints as Record<string, unknown> | undefined;
    expect(hints?.truncated).toBe(true);
    expect(hints?.total).toBe(17);
  });

  it("token-based truncation: isLast=false → truncated:true with next_page_token", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        issues: [{ key: "X-1" }, { key: "X-2" }],
        isLast: false,
        nextPageToken: "tok-abc",
      }),
    );
    const json = await callSearch();
    const hints = json.agent_hints as Record<string, unknown> | undefined;
    expect(hints?.truncated).toBe(true);
    expect(hints?.next_page_token).toBe("tok-abc");
  });

  it("not truncated: total === returned, no isLast/nextPageToken → no truncated hint", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        issues: [{ key: "X-1" }, { key: "X-2" }],
        total: 2,
        isLast: true,
      }),
    );
    const json = await callSearch();
    const hints = json.agent_hints as Record<string, unknown> | undefined;
    if (hints) {
      expect(hints.truncated).toBeUndefined();
    }
  });
});
