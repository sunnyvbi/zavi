import { describe, it, expect, vi, beforeEach } from "vitest";

const posts: Array<{ text: string }> = [];
const enqueued: Array<{ payload: { teams: { text: string } } }> = [];
let boundTenant: string | null = null;

vi.mock("@/services/connectors/teams/adapter", () => ({
  teamsEnabled: () => true,
  getConversationReference: async () => ({ conversation: { id: "c1" } }),
  getTeamsAdapter: async () => ({
    process: async (_req: unknown, _res: unknown, cb: (ctx: unknown) => Promise<void>) =>
      cb({ activity: (_req as { body: unknown }).body }),
  }),
}));
vi.mock("@/services/tools/teams/_client", () => ({
  postTeamsReply: async (a: { text: string }) => { posts.push(a); return { ok: true }; },
}));
vi.mock("@/services/agents/work-queue", () => ({
  enqueueWorkItem: async (a: never) => { enqueued.push(a); },
}));
vi.mock("@/services/redactor/teams-payload-sanitizer", () => ({
  sanitizeTeamsActivityPayload: (a: unknown) => a,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: boundTenant ? { tenant_id: boundTenant, status: "enabled" } : null,
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (name: string) => ({ data: name === "ingest_event" ? "ingest-1" : null, error: null }),
  }),
}));

import { teamsWebhook } from "../teams";
import {
  TEAMS_NOT_CONNECTED_TEXT,
  TEAMS_GREETING_TEXT,
  TEAMS_HELP_TEXT,
  teamsInstallWelcomeText,
} from "@/services/connectors/teams/commands";
import { ON_IT_ACK } from "@/services/connectors/chat-copy";

function message(text: string) {
  return {
    type: "message",
    id: "act-1",
    text,
    channelData: { tenant: { id: "m365-1" } },
    conversation: { id: "c1" },
    recipient: { id: "bot" },
  };
}
async function send(body: unknown) {
  await teamsWebhook({ body } as never, { headersSent: true } as never);
}

beforeEach(() => {
  posts.length = 0;
  enqueued.length = 0;
  boundTenant = null;
});

describe("teams webhook commands", () => {
  it("answers a not-yet-connected organization with how to connect, and starts no run", async () => {
    await send(message("hi"));
    expect(posts.map((p) => p.text)).toEqual([TEAMS_NOT_CONNECTED_TEXT]);
    expect(enqueued).toEqual([]);
  });

  it("answers hi and help from a connected organization without an agent run", async () => {
    boundTenant = "t1";
    await send(message("hello"));
    await send(message("help"));
    expect(posts.map((p) => p.text)).toEqual([TEAMS_GREETING_TEXT, TEAMS_HELP_TEXT]);
    expect(posts.some((p) => (p as { aiGenerated?: boolean }).aiGenerated)).toBe(false);
    expect(enqueued).toEqual([]);
  });

  it("runs the agent on 'ask <question>' with the command word removed", async () => {
    boundTenant = "t1";
    await send(message("ask why did signups drop?"));
    expect(posts).toEqual([expect.objectContaining({ text: ON_IT_ACK, aiGenerated: true })]);
    expect(enqueued[0].payload.teams.text).toBe("why did signups drop?");
  });

  it("welcomes a user who adds the app in a connected organization", async () => {
    boundTenant = "t1";
    await send({
      type: "conversationUpdate",
      membersAdded: [{ id: "bot" }],
      recipient: { id: "bot" },
      channelData: { tenant: { id: "m365-1" } },
    });
    expect(posts.map((p) => p.text)).toEqual([TEAMS_HELP_TEXT]);
  });

  it("welcomes a user who adds the app before connecting, with value, setup steps, sign-up and help", async () => {
    await send({
      type: "conversationUpdate",
      membersAdded: [{ id: "bot" }],
      recipient: { id: "bot" },
      channelData: { tenant: { id: "m365-1" } },
    });
    expect(posts).toHaveLength(1);
    const text = posts[0].text;
    const code = /\*\*([A-Z0-9]{4}-[A-Z0-9]{4})\*\* \(expires/.exec(text)?.[1] ?? "";
    expect(text).toBe(
      teamsInstallWelcomeText(
        `https://www.zaviagent.com/workspace?tab=settings&teams_bind=${encodeURIComponent(code)}`,
        code,
      ),
    );
    expect(text).toContain("https://www.zaviagent.com/start");
    expect(text).toContain("https://www.zaviagent.com/support");
  });
});
