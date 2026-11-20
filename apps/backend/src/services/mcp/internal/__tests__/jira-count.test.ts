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

async function callCount(jql: string): Promise<Record<string, unknown>> {
  const r = await callJiraTool({ tenant_id: "t1", run_id: "r1" }, "count", {
    jql,
  });
  return JSON.parse(r.content) as Record<string, unknown>;
}

describe("jira count — exact count via approximate-count", () => {
  it("returns the exact count and echoes the jql", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ count: 287 }));
    const json = await callCount('project = "SCRUM" AND statusCategory != Done');
    expect(json.count).toBe(287);
    expect(json.jql).toBe('project = "SCRUM" AND statusCategory != Done');
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/search/approximate-count");
  });

  it("count 0 with an accountId-shaped assignee returns a clean zero (no false hint)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ count: 0 }));
    const json = await callCount(
      'assignee = "5b10ac8d82e05b22cc7d4ef5" AND project = "SCRUM"',
    );
    expect(json.count).toBe(0);
    expect(json.agent_hints).toBeUndefined();
  });

  it("count 0 with a display-name assignee surfaces the lookup_account_id hint", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ count: 0 }));
    const json = await callCount('assignee = "Jemis" AND project = "SCRUM"');
    expect(json.count).toBe(0);
    const hints = json.agent_hints as Record<string, unknown> | undefined;
    expect(hints?.empty_due_to_likely_displayname).toBe(true);
    expect(hints?.suggested_lookup_name).toBe("Jemis");
    expect(String(hints?.suggestion)).toContain("lookup_account_id");
  });

  it("missing count field defaults to 0 (never NaN/undefined)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));
    const json = await callCount('project = "SCRUM"');
    expect(json.count).toBe(0);
  });
});
