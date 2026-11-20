
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const getSecret = vi.fn();
vi.mock("@/services/secrets/vault", () => ({ getSecret: (...a: unknown[]) => getSecret(...a) }));

import { posthogQueryTool } from "../query";
import { posthogCreds } from "../_client";
import { POSTHOG_HOSTS } from "../keys";

const ctx = { tenant_id: "t-1", log: () => {} };

beforeEach(() => {
  getSecret.mockReset();
});

describe("posthog_query read-only guard", () => {
  for (const q of [
    "DELETE FROM events",
    "insert into persons values (1)",
    "SELECT 1; DROP TABLE events",
    "  Update events SET event = 'x'",
    "TRUNCATE events",
  ]) {
    it(`rejects: ${q.slice(0, 32)}`, async () => {
      await expect(posthogQueryTool.execute(ctx, { query: q })).rejects.toMatchObject({
        code: "posthog_query_not_read_only",
      });
    });
  }

  it("does not reject an ordinary SELECT before it reaches the credential lookup", async () => {
    getSecret.mockResolvedValue(null);
    await expect(
      posthogQueryTool.execute(ctx, {
        query: "SELECT event, count() FROM events GROUP BY event",
      }),
    ).rejects.toMatchObject({ code: "posthog_not_connected" });
  });
});

describe("posthogCreds fails closed", () => {
  it("throws posthog_not_connected when no secrets exist", async () => {
    getSecret.mockResolvedValue(null);
    const err = await posthogCreds("t-1").catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("posthog_not_connected");
    expect(err.message).toMatch(/Settings/);
  });

  it("throws rather than building a URL when the stored region is unrecognized", async () => {
    getSecret.mockImplementation(async (_t: string, key: string) =>
      key === "posthog.region" ? "moon" : "value",
    );
    const err = await posthogCreds("t-1").catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("posthog_not_connected");
  });

  it("resolves the host from the FIXED region map, never from stored input", async () => {
    getSecret.mockImplementation(async (_t: string, key: string) => {
      if (key === "posthog.region") return "eu";
      if (key === "posthog.project_id") return "12345";
      return "phx_test";
    });
    const creds = await posthogCreds("t-1");
    expect(creds.host).toBe(POSTHOG_HOSTS.eu);
    expect(Object.values(POSTHOG_HOSTS)).toContain(creds.host);
  });
});
