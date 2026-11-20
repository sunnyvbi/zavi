import { describe, it, expect, vi, beforeEach } from "vitest";

const sent: unknown[] = [];
vi.mock("@/services/connectors/teams/adapter", () => ({
  teamsEnv: () => ({ appId: "app-id", appPassword: "pw", appType: "SingleTenant", appTenantId: "" }),
  getTeamsAdapter: async () => ({
    continueConversationAsync: async (_id: string, _ref: unknown, cb: (ctx: unknown) => Promise<void>) =>
      cb({ sendActivity: async (a: unknown) => { sent.push(a); } }),
  }),
}));

import { postTeamsReply, AI_GENERATED_ENTITY } from "../_client";

describe("postTeamsReply AI label", () => {
  beforeEach(() => { sent.length = 0; });

  it("labels an AI-generated reply so Teams shows 'AI generated'", async () => {
    const r = await postTeamsReply({ conversationReference: {}, text: "plan", aiGenerated: true });
    expect(r).toEqual({ ok: true });
    expect(sent).toEqual([{ type: "message", text: "plan", entities: [AI_GENERATED_ENTITY] }]);
  });

  it("sends fixed system text without the label", async () => {
    await postTeamsReply({ conversationReference: {}, text: "on it" });
    expect(sent).toEqual([{ type: "message", text: "on it" }]);
  });
});
