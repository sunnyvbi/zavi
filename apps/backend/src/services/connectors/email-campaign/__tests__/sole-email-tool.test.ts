import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { soleEmailTool } from "../account";

const T = "7c70da58-091e-4ff5-8f77-343034d448d9";
const composio = (connected: string[]) => (async (_t: string, tool: string) => (connected.includes(tool) ? { connected_account_id: "ca", auth_config_id: "ac" } : null)) as never;
const noSendgrid = (async () => null) as never;

describe("the one email tool a workspace is on", () => {
  it.each(["mailchimp", "klaviyo"])("names %s when only it is connected", async (tool) => {
    expect(await soleEmailTool(T, { resolveAccount: composio([tool]), resolveSendgrid: noSendgrid })).toBe(tool);
  });

  it("names SendGrid when only its key is connected", async () => {
    expect(await soleEmailTool(T, { resolveAccount: composio([]), resolveSendgrid: (async () => ({ key_digest: "d" })) as never })).toBe("sendgrid");
  });

  it("does not guess between two connected tools", async () => {
    expect(await soleEmailTool(T, { resolveAccount: composio(["mailchimp", "klaviyo"]), resolveSendgrid: noSendgrid })).toBeNull();
  });

  it("is null when nothing is connected", async () => {
    expect(await soleEmailTool(T, { resolveAccount: composio([]), resolveSendgrid: noSendgrid })).toBeNull();
  });

  it("does not hide a failed lookup as no tool", async () => {
    const resolveAccount = (async () => {
      throw new Error("composio down");
    }) as never;
    await expect(soleEmailTool(T, { resolveAccount, resolveSendgrid: noSendgrid })).rejects.toThrow("composio down");
  });
});
