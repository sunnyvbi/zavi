import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ enqueue: vi.fn(), admit: vi.fn(), renderOn: vi.fn(), generativeOn: vi.fn() }));
vi.mock("@/services/supabase", async () => {
  const { sharedDb } = await import("@/services/approvals/__tests__/fake-db");
  return { serviceClient: () => sharedDb.client };
});
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: (...a: unknown[]) => m.enqueue(...a) }));
vi.mock("@/services/agents/visibility", () => ({ getVisibleAgentSlugs: async () => new Set(["operator", "generated_video", "pm"]) }));
vi.mock("@/services/agents/entitlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: async () => ({ enforced: false, tier: "pro", required_tier: "free", allowed: true }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn().mockResolvedValue(undefined), LOG_META_KEYS: ["agent_slug"] }));
vi.mock("../../../../../workers/client", () => ({ inngest: { send: vi.fn(async () => ({ ids: ["e"] })) } }));
vi.mock("@/services/channels/direct-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/channels/direct-run")>()),
  admitDirectChannelRun: (...a: unknown[]) => m.admit(...a),
  stampDirectChannelRunWithin: async () => true,
}));
vi.mock("@/services/agents/_render-launch-video-flag-check", () => ({
  isRenderLaunchVideoEnabled: (...a: unknown[]) => m.renderOn(...a),
  isGenerativeVideoEnabled: (...a: unknown[]) => m.generativeOn(...a),
}));

import { sharedDb as db } from "@/services/approvals/__tests__/fake-db";
import { callPraxisTool } from "@/services/mcp/internal/praxis";

const T = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";
const ASK = "make a short video ad about our eggless chocolate truffle cake for kids' birthdays";

const chatCtx = {
  tenant_id: T,
  run_id: "op-run",
  agent_slug: "operator",
  trigger: "chat",
  chat_thread_id: "th1",
  user_id: OWNER,
  actor: { actor_user_id: OWNER, actor_source: "chat", resolved_tenant_member: true, provenance_label: "signed-in user" },
};

beforeEach(() => {
  db.reset();
  m.enqueue.mockReset().mockResolvedValue({ run_id: "child-1" });
  m.admit.mockReset().mockImplementation(async (_t: string, _slug: string, forChannel?: string) => ({
    allowed: true,
    channel_slug: forChannel === "youtube_organic" ? "youtube_organic" : "generated_video",
    estimate: 10,
  }));
  m.renderOn.mockReset().mockResolvedValue(false);
  m.generativeOn.mockReset().mockResolvedValue(false);
  db.put("tenant_users", { user_id: OWNER, tenant_id: T, role: "owner" });
  db.put("agent_runs", { id: "op-run", tenant_id: T, trigger: "chat", enqueued_by: OWNER, agent_slug: "operator", enqueued_at: new Date().toISOString(), payload: { thread_id: "th1", user_message_id: "msg-1" } });
  db.put("agent_thread_messages", { id: "msg-1", tenant_id: T, thread_id: "th1", sender_role: "user", body: ASK, agent_run_id: "op-run", source: "chat", created_at: new Date(Date.now() - 30_000).toISOString() });
  db.rpcs.lineage_tree_stats = () => [{ max_depth: 1, target_slugs: [], cumulative_cost: 0 }];
});

async function handoff(args: Record<string, unknown>) {
  const res = await callPraxisTool(chatCtx as never, "handoff", { intent: ASK, ...args });
  expect(res.ok, res.content).toBe(true);
  return JSON.parse(res.content) as { run_id: string; target: string; message: string };
}

const TESTIMONIAL_ASK = "make a testimonial-style video of a customer giving a 5-star review of our chocolate fudge cake";

function expectNonCommittal(message: string) {
  expect(message).toContain("Tell the founder only that the request went to the video team, which checks it and replies here.");
  expect(message).toContain("Do not say what it will make, who or what will be in it, whether a video or ideas will come back");
  expect(message).not.toMatch(/Suggested ads|Make video|Channels >|credits are charged|writes the video ad ideas|post the result back|when it finishes|Tell the founder exactly that/i);
}

describe("Home chat video ad handed to AI UGC Videos", () => {
  it("a fake-review ask gets a handoff that promises no video: the video team checks it and replies here", async () => {
    const out = await handoff({ target_agent_slug: "generated_video", intent: TESTIMONIAL_ASK });
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.enqueue.mock.calls[0][0]).toMatchObject({ agent_slug: "generated_video", payload: { channel_slug: "generated_video" } });
    expect(out.target).toBe("generated_video");
    expect(out.run_id).toBe("child-1");
    expectNonCommittal(out.message);
  });

  it("a video ad ask gets the same non-committal handoff", async () => {
    const out = await handoff({ target_agent_slug: "generated_video" });
    expectNonCommittal(out.message);
  });

  it("a video for YouTube is admitted to the YouTube channel and the handoff still promises nothing", async () => {
    const out = await handoff({ target_agent_slug: "generated_video", for_channel: "youtube_organic" });
    expect(m.enqueue.mock.calls[0][0]).toMatchObject({ agent_slug: "generated_video", payload: { channel_slug: "youtube_organic" } });
    expectNonCommittal(out.message);
  });

  it("another specialist still gets the post-back handoff message", async () => {
    m.admit.mockResolvedValueOnce({ allowed: true, channel_slug: "", estimate: 0 });
    const out = await handoff({ target_agent_slug: "pm" });
    expect(out.message).toContain("I'll post the result back in here when it finishes");
  });

  it("render_video switched off steers an ad to the handoff without naming the tool to the founder", async () => {
    const res = await callPraxisTool(chatCtx as never, "render_video", { product_name: "Cakely", video_type: "ad", one_liner: "An eggless chocolate truffle cake." });
    const body = JSON.parse(res.content) as { status: string; next?: string };
    expect(body.status).toBe("not_enabled");
    expect(body.next).toMatch(/hand off to generated_video/);
    expect(body.next).toMatch(/without mentioning this tool or that it is off/);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("generative render_video switched off carries the same steer", async () => {
    const res = await callPraxisTool(chatCtx as never, "render_video", { generative_intent: "social", prompt: "a cake at a kids' party" });
    const body = JSON.parse(res.content) as { status: string; next?: string };
    expect(body.status).toBe("not_enabled");
    expect(body.next).toMatch(/hand off to generated_video/);
  });
});
