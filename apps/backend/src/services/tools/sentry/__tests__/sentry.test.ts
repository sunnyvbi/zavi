
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const getSecret = vi.fn();
vi.mock("@/services/secrets/vault", () => ({ getSecret: (...a: unknown[]) => getSecret(...a) }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { sentryListIssuesTool } from "../list_issues";
import { sentryGetIssueTool } from "../get_issue";
import { sentryCreds } from "../_client";

const ctx = { tenant_id: "t-1", log: () => {} };

beforeEach(() => {
  getSecret.mockReset();
  fetchMock.mockReset();
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("sentryCreds fails closed", () => {
  it("throws sentry_not_connected when no secrets exist", async () => {
    getSecret.mockResolvedValue(null);
    const err = await sentryCreds("t-1").catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("sentry_not_connected");
    expect(err.message).toMatch(/Settings/);
  });

  it("throws sentry_not_connected when only one of the two secrets exists", async () => {
    getSecret.mockImplementation(async (_t: string, key: string) =>
      key === "sentry.auth_token" ? "tok" : null,
    );
    const err = await sentryCreds("t-1").catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("sentry_not_connected");
  });
});

describe("sentry_list_issues", () => {
  it("fails closed with sentry_not_connected before making a request", async () => {
    getSecret.mockResolvedValue(null);
    await expect(
      sentryListIssuesTool.execute(ctx, { project: "backend" }),
    ).rejects.toMatchObject({ code: "sentry_not_connected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hits the organization-scoped issues endpoint with the org slug from Vault", async () => {
    getSecret.mockImplementation(async (_t: string, key: string) =>
      key === "sentry.auth_token" ? "tok_abc" : "my-org",
    );
    fetchMock.mockResolvedValue(
      jsonResponse(200, [
        { id: "1", title: "TypeError: x is undefined", culprit: "app.foo", level: "error", status: "unresolved", count: "12" },
      ]),
    );

    const result = await sentryListIssuesTool.execute(ctx, { project: "backend" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://sentry.io/api/0/organizations/my-org/issues/?project=backend&query=is%3Aunresolved&sort=date&limit=25",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_abc");
    expect(result).toMatchObject({ count: 1, issues: [{ id: "1", title: "TypeError: x is undefined" }] });
  });

  it("sanitizes a rejected-token error — never echoes the response body", async () => {
    getSecret.mockImplementation(async (_t: string, key: string) =>
      key === "sentry.auth_token" ? "tok_bad" : "my-org",
    );
    fetchMock.mockResolvedValue(jsonResponse(401, { detail: "Invalid token tok_bad supplied" }));

    await expect(sentryListIssuesTool.execute(ctx, { project: "backend" })).rejects.toMatchObject({
      code: "sentry_key_rejected",
    });
    await expect(
      sentryListIssuesTool.execute(ctx, { project: "backend" }).catch((e: Error) => e.message),
    ).resolves.not.toMatch(/tok_bad/);
  });
});

describe("sentry_get_issue", () => {
  it("fails closed with sentry_not_connected before making a request", async () => {
    getSecret.mockResolvedValue(null);
    await expect(
      sentryGetIssueTool.execute(ctx, { issue_id: "123" }),
    ).rejects.toMatchObject({ code: "sentry_not_connected" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the issue and its latest event, trimming stack frames", async () => {
    getSecret.mockImplementation(async (_t: string, key: string) =>
      key === "sentry.auth_token" ? "tok_abc" : "my-org",
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/issues/123/")) {
        return jsonResponse(200, {
          id: "123",
          title: "TypeError: x is undefined",
          culprit: "app.foo",
          level: "error",
          status: "unresolved",
          count: "12",
        });
      }
      if (url.endsWith("/issues/123/events/latest/")) {
        return jsonResponse(200, {
          eventID: "abc123",
          dateCreated: "2026-09-01T00:00:00Z",
          entries: [
            {
              type: "exception",
              data: {
                values: [
                  {
                    stacktrace: {
                      frames: [
                        {
                          filename: "app.js",
                          function: "foo",
                          lineNo: 42,
                          inApp: true,
                          context: [[41, "const x = undefined;"]],
                          vars: { secret: "should-not-appear" },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await sentryGetIssueTool.execute(ctx, { issue_id: "123" });

    expect(result).toMatchObject({
      id: "123",
      title: "TypeError: x is undefined",
      latest_event: {
        event_id: "abc123",
        frames: [{ filename: "app.js", function: "foo", lineno: 42, inApp: true }],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/should-not-appear/);
    expect(serialized).not.toMatch(/context/);
  });

  it("sanitizes a rejected-token error — never echoes the response body", async () => {
    getSecret.mockImplementation(async (_t: string, key: string) =>
      key === "sentry.auth_token" ? "tok_bad" : "my-org",
    );
    fetchMock.mockResolvedValue(jsonResponse(403, { detail: "Invalid token tok_bad supplied" }));

    await expect(sentryGetIssueTool.execute(ctx, { issue_id: "123" })).rejects.toMatchObject({
      code: "sentry_key_rejected",
    });
    await expect(
      sentryGetIssueTool.execute(ctx, { issue_id: "123" }).catch((e: Error) => e.message),
    ).resolves.not.toMatch(/tok_bad/);
  });
});
