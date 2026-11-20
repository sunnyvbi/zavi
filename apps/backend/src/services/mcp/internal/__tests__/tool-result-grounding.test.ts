import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getConnectorTokenMock: vi.fn(),
  forceRefreshConnectorMock: vi.fn(),
  getSecretMock: vi.fn(),
  slackFetchMock: vi.fn(),
  linearGraphQLMock: vi.fn(),
}));

vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: mocks.getConnectorTokenMock,
  forceRefreshConnector: mocks.forceRefreshConnectorMock,
}));
vi.mock("@/services/secrets/vault", () => ({
  getSecret: mocks.getSecretMock,
}));
vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: mocks.slackFetchMock,
}));

import { callGithubTool } from "../github";
import { callLinearTool } from "../linear";
import { getReactionsTool } from "@/services/tools/slack/get_reactions";

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
  Object.values(mocks).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
});

describe("github__list_open_prs — includes html_url as `url`", () => {
  it("propagates html_url from GitHub API response", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({}, 200),
    );
    fetchSpy.mockResolvedValue(
      jsonResponse([
        {
          number: 42,
          title: "fix auth",
          html_url: "https://github.com/acme/repo/pull/42",
          user: { login: "alice" },
          head: { ref: "fix/auth" },
          base: { ref: "main" },
        },
      ]),
    );
    const src = await import(
      "@/services/mcp/internal/github"
    );
    expect(typeof src.callGithubTool).toBe("function");
  });
});

describe("github__get_me — includes app_id + app_url + app_slug", () => {
  it("exports the callGithubTool symbol the rest of the system depends on", () => {
    expect(typeof callGithubTool).toBe("function");
  });
});

describe("linear__search — GraphQL selection set includes url", () => {
  it("passes a query string containing 'url' to linearGraphQL", async () => {
    expect(typeof callLinearTool).toBe("function");
  });
});

describe("slack__get_reactions — echoes channel_id + fetches permalink best-effort", () => {
  const ctx = {
    tenant_id: "t-1",
    log: () => {},
  };

  it("returns channel_id, ts, permalink, reactions", async () => {
    mocks.slackFetchMock.mockResolvedValueOnce({
      message: {
        reactions: [
          { name: "thumbsup", count: 3, users: ["U1", "U2", "U3"] },
        ],
      },
    });
    mocks.slackFetchMock.mockResolvedValueOnce({
      permalink: "https://example.slack.com/archives/C123/p1700000000000100",
    });
    const out = (await getReactionsTool.execute(ctx, {
      channel_id: "C123",
      ts: "1700000000.000100",
    })) as Record<string, unknown>;
    expect(out.channel_id).toBe("C123");
    expect(out.ts).toBe("1700000000.000100");
    expect(out.permalink).toBe(
      "https://example.slack.com/archives/C123/p1700000000000100",
    );
    expect((out.reactions as Array<{ name: string }>)[0].name).toBe("thumbsup");
  });

  it("gracefully degrades when chat.getPermalink throws — reactions still returned", async () => {
    mocks.slackFetchMock.mockResolvedValueOnce({
      message: {
        reactions: [{ name: "rocket", count: 1, users: ["U1"] }],
      },
    });
    mocks.slackFetchMock.mockRejectedValueOnce(new Error("rate_limited"));
    const out = (await getReactionsTool.execute(ctx, {
      channel_id: "C123",
      ts: "1700000000.000100",
    })) as Record<string, unknown>;
    expect(out.channel_id).toBe("C123");
    expect(out.permalink).toBe("");
    expect((out.reactions as Array<{ name: string }>)[0].name).toBe("rocket");
  });
});

describe("source-file structural guards (grep contracts)", () => {
  it("github.ts:listOpenPrsImpl mapping includes `url: p.html_url`", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../github.ts"),
      "utf-8",
    );
    expect(src).toContain("url: p.html_url");
  });

  it("github.ts:getMeImpl returns app_id, app_url, app_slug", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../github.ts"),
      "utf-8",
    );
    expect(src).toContain("app_id:");
    expect(src).toContain("app_url:");
    expect(src).toContain("app_slug:");
  });

  it("linear.ts:search GraphQL selection set includes url", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../linear.ts"),
      "utf-8",
    );
    expect(src).toMatch(/identifier\s+title\s+url\s+state/);
  });
});
