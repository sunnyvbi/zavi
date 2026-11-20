import { describe, it, expect } from "vitest";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { buildSdkUserPrompt, resolveChatResumeSessionId } from "@/services/agents/generic-dispatcher";
import { createSdkSessionStore, shouldUseDurableResume, type SessionStoreDb } from "@/services/agents/sdk-session-store";

const TENANT = "11111111-1111-1111-1111-111111111111";
const THREAD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const purgedDb: SessionStoreDb = {
  rpc: async () => ({ error: null }),
  from: () => {
    const b = { eq: () => b, order: async () => ({ data: [], error: null }) };
    return { select: () => b };
  },
};

async function resumeIdFor(thread: { sdk_session_id: string | null }): Promise<string | null> {
  const store = createSdkSessionStore({ runId: "run-1", tenantId: TENANT, threadId: THREAD }, purgedDb);
  let durable: string | null = null;
  if (shouldUseDurableResume({ isChatMode: true, durableEnabled: true, sdkSessionId: thread.sdk_session_id, mirrorDegradedAt: null })) {
    const preload = await store.load({ projectKey: TENANT, sessionId: thread.sdk_session_id as string });
    if (preload && preload.length > 0) durable = thread.sdk_session_id;
  }
  return durable ?? resolveChatResumeSessionId({ isChatMode: true, sdkSessionId: thread.sdk_session_id });
}

const messages: MessageParam[] = [
  { role: "user", content: "What did we decide about the pricing page?" },
  { role: "assistant", content: "We kept the four tiers and moved Pro to the right." },
  { role: "user", content: "Great, now draft the launch email." },
];

describe("a thread whose SDK session was purged", () => {
  it("pointer cleared by the purge: no resume, the prior turns are replayed into the prompt", async () => {
    const resumeSessionId = await resumeIdFor({ sdk_session_id: null });
    expect(resumeSessionId).toBeNull();
    const prompt = buildSdkUserPrompt({ messages, resumeSessionId, runId: "run-1", threadId: THREAD });
    expect(typeof prompt).toBe("string");
    expect(prompt as string).toContain("We kept the four tiers and moved Pro to the right.");
    expect((prompt as string).trimEnd().endsWith("Great, now draft the launch email.")).toBe(true);
  });

  it("pointer still set but the entries are gone: the pre-flight load finds nothing, same fallback", async () => {
    const resumeSessionId = await resumeIdFor({ sdk_session_id: "sess-old" });
    expect(resumeSessionId).toBeNull();
    const prompt = buildSdkUserPrompt({ messages, resumeSessionId, runId: "run-1", threadId: THREAD });
    expect(prompt as string).toContain("What did we decide about the pricing page?");
  });
});
