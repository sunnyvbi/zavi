import { describe, expect, it } from "vitest";
import type { ComposioExecResult } from "@/services/connectors/composio/api";
import type { EmailTool, ProviderCall } from "@/services/connectors/email-campaign/providers";
import { sendgridErrorText } from "@/services/connectors/email-campaign/providers-sendgrid";
import { readTestLists, readToolLists, type ToolCaller } from "../lists";

const wrapped = (status_code: number | null): ComposioExecResult => {
  const message = `Failed to get lists: ${status_code ?? "?"} Client Error: Unauthorized for url: https://a.klaviyo.com/api/lists/?sort=name`;
  return { ok: false, status: 200, data: status_code === null ? { message } : { message, status_code }, error: message, outcome_unknown: false };
};

const callers = (m: Partial<Record<EmailTool, ProviderCall>>): ToolCaller => async (_t, tool) => m[tool] ?? null;

describe("Klaviyo refusing the saved key, as Composio actually answers it (HTTP 200, vendor status in the body)", () => {
  it("the route says the key was rejected, not that Zavi can't reach Klaviyo", async () => {
    let calls = 0;
    const klaviyo: ProviderCall = async () => {
      calls++;
      return wrapped(401);
    };
    const v = await readTestLists("t", {
      sendgridNeedsPermissions: async () => false,
      caller: callers({ klaviyo }),
      marks: async () => new Set(),
      zaviLists: async () => [],
    });
    const route = v.routes.find((r) => r.route === "klaviyo")!;
    expect(calls).toBe(1);
    expect(route.status).toBe("unreadable");
    expect(route.error).toMatch(/rejected the key/i);
    expect(route.error).toMatch(/disconnect Klaviyo, then reconnect it with a new API key/);
    expect(route.error).toMatch(/Private API key/);
    expect(route.error).not.toMatch(/could not be read right now|try again in a minute/i);
  });

  it("a wrapped 403 saying the account is suspended is not a rejected key", async () => {
    const message = "Failed to get lists: 403 Client Error: Forbidden. Detail: This account has been suspended.";
    const r = await readToolLists("t", "klaviyo", {
      caller: callers({ klaviyo: async () => ({ ok: false, status: 200, data: { message, status_code: 403 }, error: message, outcome_unknown: false }) }),
    });
    expect(r.error).not.toMatch(/rejected the key|disconnect Klaviyo/i);
  });

  it("a wrapped 403 for a key missing a scope sends the founder to make a key with the right scopes, never to wait", async () => {
    const message = "Failed to get lists: 403 Client Error: Forbidden. Detail: You do not have permission to perform this action. Missing scope lists:read.";
    const r = await readToolLists("t", "klaviyo", {
      caller: callers({ klaviyo: async () => ({ ok: false, status: 200, data: { message, status_code: 403 }, error: message, outcome_unknown: false }) }),
    });
    expect(r.status).toBe("unreadable");
    expect(r.error).toMatch(/Klaviyo rejected the key/);
    expect(r.error).toMatch(/lacks a permission Zavi needs/);
    expect(r.error).toMatch(/new API key that has every permission Zavi needs/);
    expect(r.error).toMatch(/Private API key under Settings > API keys/);
    expect(r.error).not.toMatch(/try again in a minute/i);
  });

  it("a SendGrid 403 is a rejected key, not an outage", async () => {
    const error = sendgridErrorText(403, { errors: [{ field: null, message: "access forbidden" }] });
    const r = await readToolLists("t", "sendgrid", {
      caller: callers({ sendgrid: async () => ({ ok: false, status: 403, data: { errors: [{ field: null, message: "access forbidden" }] }, error, outcome_unknown: false }) }),
    });
    expect(r.error).toMatch(/SendGrid rejected the key/);
    expect(r.error).toMatch(/new API key that has every permission Zavi needs/);
    expect(r.error).not.toMatch(/try again in a minute/i);
  });

  it("a wrapped 403 whose body says the API key is invalid is a rejected key", async () => {
    const message = "Failed to get lists: 403 Client Error: Forbidden. Detail: The API key specified is invalid.";
    const r = await readToolLists("t", "klaviyo", {
      caller: callers({ klaviyo: async () => ({ ok: false, status: 200, data: { message, status_code: 403 }, error: message, outcome_unknown: false }) }),
    });
    expect(r.error).toMatch(/Klaviyo rejected the key/);
  });

  it("a wrapped failure with no vendor status stays a passing outage", async () => {
    const r = await readToolLists("t", "klaviyo", { caller: callers({ klaviyo: async () => wrapped(null) }) });
    expect(r.status).toBe("unreadable");
    expect(r.error).toBe("Klaviyo could not be read right now. Try again in a minute.");
  });
});
