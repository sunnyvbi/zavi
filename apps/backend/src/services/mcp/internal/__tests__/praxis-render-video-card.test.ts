import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  sent: [] as Array<{ name: string; data?: Record<string, unknown> }>,
  record: vi.fn(),
  stamp: vi.fn(),
  admit: vi.fn(),
  track: vi.fn(),
  locked: vi.fn(),
  planLock: vi.fn(),
  chatStart: vi.fn(),
  showInChat: vi.fn(),
}));
vi.mock("@/services/supabase", async () => {
  const { sharedDb } = await import("@/services/approvals/__tests__/fake-db");
  return { serviceClient: () => sharedDb.client };
});
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn().mockResolvedValue(undefined), LOG_META_KEYS: ["agent_slug"] }));
vi.mock("../../../../../workers/client", () => ({
  inngest: {
    send: vi.fn(async (e: { name: string; data?: Record<string, unknown> }) => {
      m.sent.push(e);
      return { ids: ["e"] };
    }),
  },
}));
vi.mock("@/services/tools/generated-video/chat-card", async (orig) => ({
  ...(await orig<typeof import("@/services/tools/generated-video/chat-card")>()),
  showVideoCardInChat: (...a: unknown[]) => m.showInChat(...a),
}));
vi.mock("@/services/channels/exec-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/channels/exec-actions")>()),
  recordChannelExecAction: (...a: unknown[]) => m.record(...a),
}));
vi.mock("@/services/channels/direct-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/channels/direct-run")>()),
  stampDirectChannelRunWithin: (...a: unknown[]) => m.stamp(...a),
  stampDirectChannelRun: (...a: unknown[]) => m.stamp(...a),
  admitDirectChannelRun: (...a: unknown[]) => m.admit(...a),
}));
vi.mock("@/services/analytics/action-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/analytics/action-events")>()),
  trackChannelRunStarted: (...a: unknown[]) => m.track(...a),
}));
vi.mock("@/services/channels/lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/channels/lock")>()),
  isChannelLockedStrict: (...a: unknown[]) => m.locked(...a),
}));
vi.mock("@/services/growth/preview-plan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/growth/preview-plan")>()),
  channelPlanLock: (...a: unknown[]) => m.planLock(...a),
}));
vi.mock("@/services/tools/generated-video/starter-autostart", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/tools/generated-video/starter-autostart")>()),
  autostartChatVideo: (...a: unknown[]) => m.chatStart(...a),
}));
vi.mock("@/services/agents/_render-launch-video-flag-check", () => ({
  isRenderLaunchVideoEnabled: async () => true,
  isGenerativeVideoEnabled: async () => true,
}));
vi.mock("@/services/launch-video/url-grounding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/launch-video/url-grounding")>()),
  loadUrlGroundingSources: async () => ({ productHosts: ["upcar.ai"], userTexts: [] }),
}));

import { sharedDb as db } from "@/services/approvals/__tests__/fake-db";
import { callPraxisTool } from "@/services/mcp/internal/praxis";
import { billedVideoCredits } from "@/services/launch-video/video-estimate";
import { generativeVideoIntakeSchema } from "@/services/launch-video/generative-video-intake";
import { ExpectedToolError } from "@/services/tools/types";
import { failRequestedVideoRun } from "@/services/tools/generated-video/propose_video";

const T = "11111111-1111-4111-8111-111111111111";
const ctx = {
  tenant_id: T,
  run_id: "op-run",
  agent_slug: "operator",
  trigger: "slack" as const,
  slack_routing: { channel_id: "C9", thread_ts: "1.9", original_ts: "1.9", event_id: "EvGen" },
};
const gen = {
  generative_intent: "talking_head",
  prompt: "A presenter in a bright kitchen explains UpcarAI",
  script: "Book a car near you in two taps and drive away today, no counter and no queue.",
  presenter_gender: "female",
};
const motion = {
  product_name: "Upcar",
  one_liner: "Rent the perfect car from local hosts.",
  url: "https://upcar.ai",
  audience: "weekend renters",
  tone: "bold",
  features: [{ title: "Book in two minutes", detail: "Reserve a car near you instantly." }],
  cta_text: "Start your trip",
  cta_url: "https://upcar.ai",
};

const LOCKED = "locked";
const BELOW_STARTER = "below starter";
function block(kind: typeof LOCKED | typeof BELOW_STARTER) {
  if (kind === LOCKED) m.locked.mockResolvedValue(true);
  else m.planLock.mockResolvedValue({ required_tier: "starter" });
}

beforeEach(() => {
  db.reset();
  m.sent.length = 0;
  m.record.mockReset().mockResolvedValue({ id: "card-1", replayed: false, kept: false });
  m.stamp.mockReset().mockResolvedValue(true);
  m.locked.mockReset().mockResolvedValue(false);
  m.planLock.mockReset().mockResolvedValue(null);
  m.track.mockReset();
  m.admit.mockReset().mockResolvedValue({ allowed: true, channel_slug: "generated_video", estimate: 10 });
  m.chatStart.mockReset().mockResolvedValue("not_chat");
  m.showInChat.mockReset().mockResolvedValue("not_chat");
  db.rpcs.tick_enrichment_rate_limit = (a) => {
    const rows = (db.tables.enrichment_rate_limit ??= []);
    let row = rows.find((r) => r.key === a.p_key);
    if (!row) rows.push((row = { key: a.p_key, window_start: new Date().toISOString(), count: 0 }));
    row.count = (row.count as number) + 1;
    return (row.count as number) <= (a.p_limit as number);
  };
});

const holders = () => (db.tables.agent_runs ?? []).filter((r) => r.agent_definition_hash === "generated-video-requested-card");

describe("render_video with generative_intent files a Make video card", () => {
  it("an entitled tenant gets exactly one priced card on AI UGC Videos and no render event", async () => {
    const res = await callPraxisTool(ctx as never, "render_video", gen);
    expect(res.ok, res.content).toBe(true);
    expect(m.sent).toEqual([]);
    expect(m.stamp).not.toHaveBeenCalled();
    expect(m.admit).toHaveBeenCalledWith(T, "generated_video", undefined, { chat: false, accepted: expect.any(Number) });
    expect(holders()).toHaveLength(1);
    const holder = holders()[0];
    expect(holder).toMatchObject({ tenant_id: T, agent_slug: "generated_video", channel_slug: "generated_video", status: "success", cost_usd: 0 });
    expect(holder.trigger).toBe("chat");
    expect(holder.id).not.toBe("op-run");
    expect((db.tables.agent_runs ?? []).some((r) => r.id === "op-run")).toBe(false);
    expect(m.record).toHaveBeenCalledTimes(1);
    const card = m.record.mock.calls[0][0] as {
      tenantId: string;
      runId: string;
      channelSlug: string;
      execClass: string;
      actionType: string;
      execPayload: { intake: Record<string, unknown> };
      body: { cost_credits: number; step: { body: string }; exact_change: { rows: Array<{ item: string; after: string }> } };
    };
    expect(card).toMatchObject({ tenantId: T, runId: holder.id, channelSlug: "generated_video", execClass: "generated_video.render.v1", actionType: "video_post" });
    const intake = generativeVideoIntakeSchema.parse(card.execPayload.intake);
    expect(intake).toMatchObject({ intent: "talking_head", script: gen.script, prompt: gen.prompt, presenter_gender: "female" });
    const price = await billedVideoCredits(intake);
    expect(price).toBeGreaterThan(0);
    expect(card.body.cost_credits).toBe(price);
    expect(card.body.step.body).toContain(`${price.toLocaleString("en-US")} credits`);
    expect(card.body.exact_change.rows.find((r) => r.item === "Cost")?.after).toContain(`${price.toLocaleString("en-US")} credits`);
    const reply = JSON.parse(res.content as string) as { status: string; action_id: string; cost_credits: number; message: string; next: string };
    expect(reply.status).toBe("card_filed");
    expect(reply.action_id).toBe("card-1");
    expect(reply.cost_credits).toBe(price);
    expect(`${reply.message} ${reply.next}`).toContain("Make video");
    expect(reply.next).toContain("Suggested ads");
    expect(`${reply.message} ${reply.next}`).not.toMatch(/generating|in this thread in/i);
  });

  it("a founder-typed ask files its card as the founder's own, so a later agent card cannot retire it", async () => {
    await callPraxisTool({ ...ctx, founder_chat_order: true } as never, "render_video", gen);
    const payload = (m.record.mock.calls[0][0] as { execPayload: Record<string, unknown> }).execPayload;
    expect(payload.origin).toBe("user_initiated_chat");
    expect(payload.intake).toBeTruthy();
  });

  it.each([
    ["an agent or channel run", {}],
    ["an ask the server could not prove came from the founder", { founder_chat_order: false }],
  ])("%s files a card with no founder origin", async (_label, extra) => {
    await callPraxisTool({ ...ctx, ...extra } as never, "render_video", gen);
    const payload = (m.record.mock.calls[0][0] as { execPayload: Record<string, unknown> }).execPayload;
    expect(payload).not.toHaveProperty("origin");
  });

  it("the card carries the script alone as its founder-visible text, with the scene in its own field like a starter card", async () => {
    await callPraxisTool(ctx as never, "render_video", gen);
    const body = (m.record.mock.calls[0][0] as { body: Record<string, unknown> & { step: { deliverable: { content: string } } } }).body;
    expect(body.step.deliverable.content).toBe(gen.script);
    expect(body.step.deliverable.content).not.toMatch(/Scene:/);
    expect(body.scene).toBe(gen.prompt);
    expect(Array.isArray(body.hooks)).toBe(true);
    expect(body.video_format).toBe("talking_head");
  });

  it("an operator run already stamped for another channel still files the card on the holder and leaves the operator run alone", async () => {
    db.put("agent_runs", { id: "op-run", tenant_id: T, agent_slug: "operator", channel_slug: "meta_ads", trigger: "slack", status: "running" });
    m.stamp.mockImplementation(async (_t: string, id: string, ch: string) => {
      const row = db.tables.agent_runs.find((r) => r.id === id);
      if (row && row.channel_slug == null) m.track({ tenant_id: T, channel_slug: ch, path: "direct" });
      return !row || row.channel_slug == null || row.channel_slug === ch;
    });
    const res = await callPraxisTool(ctx as never, "render_video", gen);
    expect(res.ok, res.content).toBe(true);
    expect(res.is_error).toBe(false);
    expect(res.content).not.toContain("render_video_card_not_filed");
    expect(JSON.parse(res.content as string).status).toBe("card_filed");
    expect(holders()).toHaveLength(1);
    expect((m.record.mock.calls[0][0] as { runId: string }).runId).toBe(holders()[0].id);
    expect(db.tables.agent_runs.find((r) => r.id === "op-run")).toMatchObject({ channel_slug: "meta_ads", status: "running" });
    expect(m.stamp).not.toHaveBeenCalled();
    expect(m.track).not.toHaveBeenCalled();
  });

  it.each([LOCKED, BELOW_STARTER] as const)("a %s tenant is refused with no card, no stamp and no event", async (kind) => {
    block(kind);
    const res = await callPraxisTool(ctx as never, "render_video", gen);
    const reply = JSON.parse(res.content as string) as { status: string; message: string; next?: string };
    expect(reply.status).toBe("not_enabled");
    expect(m.record).not.toHaveBeenCalled();
    expect(m.stamp).not.toHaveBeenCalled();
    expect(holders()).toEqual([]);
    expect(m.sent).toEqual([]);
  });

  it.each([
    ["founder_stopped", "The founder stopped AI UGC Videos, so Zavi does not run it."],
    ["budget", "This channel has used its 30-day credit cap."],
  ] as const)("a %s channel files no card and creates no holder run", async (reason, message) => {
    m.admit.mockResolvedValue({ allowed: false, reason, message });
    const res = await callPraxisTool(ctx as never, "render_video", gen);
    expect(res.is_error).toBe(false);
    const reply = JSON.parse(res.content as string) as { status: string; message: string; next: string };
    expect(reply.status).toBe("not_filed");
    expect(reply.message).toContain(message);
    expect(reply.message).toMatch(/nothing was made or charged/i);
    expect(m.record).not.toHaveBeenCalled();
    expect(m.stamp).not.toHaveBeenCalled();
    expect(holders()).toEqual([]);
    expect(m.sent).toEqual([]);
  });

  it("the plan-lock refusal carries a plain-words next that keeps the raw message out of the founder's reply", async () => {
    block(BELOW_STARTER);
    const res = await callPraxisTool(ctx as never, "render_video", gen);
    const reply = JSON.parse(res.content as string) as { message: string; next?: string };
    expect(reply.message).toContain("Your plan does not include AI UGC Videos (it needs starter)");
    expect(typeof reply.next).toBe("string");
    expect(reply.next).not.toMatch(/plan does not include/i);
    expect(reply.next).toMatch(/own words/);
    expect(reply.next).toMatch(/nothing was charged/i);
  });

  it("a card that fails to file marks its holder run failed and stamps nothing", async () => {
    m.record.mockRejectedValue(new Error("rpc down"));
    const res = await callPraxisTool(ctx as never, "render_video", gen);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("nothing was made or charged");
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(holders()).toHaveLength(1);
    expect(holders()[0].status).toBe("failed");
    expect((m.record.mock.calls[0][0] as { runId: string }).runId).toBe(holders()[0].id);
    expect(m.stamp).not.toHaveBeenCalled();
    expect(m.sent).toEqual([]);
  });

  it("a draft run writes nothing", async () => {
    const res = await callPraxisTool({ ...ctx, writes_suppressed: true } as never, "render_video", gen);
    expect(JSON.parse(res.content as string).status).toBe("not_filed");
    expect(m.stamp).not.toHaveBeenCalled();
    expect(m.admit).not.toHaveBeenCalled();
    expect(holders()).toEqual([]);
    expect(m.record).not.toHaveBeenCalled();
    expect(m.sent).toEqual([]);
  });
});

type FiledCard = {
  runId: string;
  execPayload: { intake: { aspect_ratio?: string } };
  body: { step: { body: string }; exact_change: { rows: Array<{ item: string; after: string }> } };
};
const filed = () => m.record.mock.calls[0][0] as FiledCard;
const videoRow = (c: FiledCard) => c.body.exact_change.rows.find((r) => r.item === "Video")?.after ?? "";

describe("render_video with generative_intent tells the founder the format the worker will make", () => {
  it("a talking head with no aspect files a 9:16 card with no AI-generated label", async () => {
    await callPraxisTool(ctx as never, "render_video", gen);
    const c = filed();
    expect(c.execPayload.intake.aspect_ratio).toBe("9:16");
    expect(c.body.step.body).toContain("9:16 video");
    expect(c.body.step.body).not.toMatch(/AI-generated|labelled/i);
    expect(videoRow(c)).not.toMatch(/AI-generated|label/i);
    expect(c.body.step.body).not.toContain("16:9");
  });

  it("a cinematic clip with no aspect files 16:9 with no AI-generated label", async () => {
    await callPraxisTool(ctx as never, "render_video", { ...gen, generative_intent: "cinematic", script: undefined, presenter_gender: undefined });
    const c = filed();
    expect(c.execPayload.intake.aspect_ratio).toBe("16:9");
    expect(c.body.step.body).toContain("16:9 video");
    expect(c.body.step.body).not.toMatch(/AI-generated|labelled/i);
    expect(videoRow(c)).toBe("Cinematic clip, about 8 seconds, 16:9");
  });

  it("an aspect the renderer does not make falls back to the talking-head default and never reaches the card", async () => {
    await callPraxisTool(ctx as never, "render_video", { ...gen, aspect_ratio: "3:2" });
    const c = filed();
    expect(c.execPayload.intake.aspect_ratio).toBe("9:16");
    expect(c.body.step.body).toContain("9:16 video");
    expect(c.body.step.body).not.toContain("3:2");
    expect(videoRow(c)).not.toContain("3:2");
  });

  it("a supported square or portrait-feed aspect is kept, with no AI-generated label", async () => {
    await callPraxisTool(ctx as never, "render_video", { ...gen, aspect_ratio: "4:5" });
    const c = filed();
    expect(c.execPayload.intake.aspect_ratio).toBe("4:5");
    expect(c.body.step.body).toContain("4:5 video");
    expect(c.body.step.body).not.toMatch(/AI-generated|labelled/i);
  });
});

describe("render_video with generative_intent when the card is a repeat the founder already settled", () => {
  it.each([
    ["channel_card_already_done", /already made/i],
    ["channel_card_already_rejected", /dismissed this same video/i],
  ] as const)("%s answers honestly, not with try again, and charges nothing", async (code, said) => {
    m.record.mockRejectedValue(new ExpectedToolError(code, "matched an earlier card"));
    const res = await callPraxisTool(ctx as never, "render_video", gen);
    expect(res.is_error).toBe(false);
    expect(res.content).not.toContain("render_video_card_not_filed");
    const reply = JSON.parse(res.content as string) as { status: string; message: string; next: string };
    expect(reply.status).toBe("not_filed");
    expect(reply.message).toMatch(said);
    expect(reply.message).toMatch(/nothing (new )?was made or charged/i);
    expect(`${reply.message} ${reply.next}`).not.toMatch(/try again in|a minute/i);
    expect(reply.next).toContain("render_video again");
    expect(m.sent).toEqual([]);
  });

  it("a reused holder that already carries a filed card is not marked failed when a later card on it fails", async () => {
    const first = await callPraxisTool(ctx as never, "render_video", gen);
    expect(JSON.parse(first.content as string).status).toBe("card_filed");
    const holder = holders()[0];
    db.put("channel_actions", { id: "card-1", tenant_id: T, channel_slug: "generated_video", run_id: holder.id, status: "pending" });
    await failRequestedVideoRun(T, holder.id as string);
    expect(holders()[0].status).toBe("success");
    db.tables.channel_actions = [];
    await failRequestedVideoRun(T, holder.id as string);
    expect(holders()[0].status).toBe("failed");
  });
});

describe("render_video with generative_intent stops at 20 chat-filed cards a UTC day", () => {
  const today = () => new Date().toISOString();
  const yesterday = () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 60_000).toISOString();
  let n = 0;
  function seedHolder(at: string, card: "pending" | "stale" | "rejected" | "acted" | null) {
    const id = `seed-run-${++n}`;
    db.put("agent_runs", { id, tenant_id: T, agent_slug: "generated_video", agent_definition_hash: "generated-video-requested-card", status: "success", enqueued_at: at });
    if (card) db.put("channel_actions", { id: `seed-card-${n}`, tenant_id: T, channel_slug: "generated_video", run_id: id, status: card });
  }
  function seedNoise() {
    for (let i = 0; i < 5; i++) seedHolder(yesterday(), "pending");
    for (let i = 0; i < 5; i++) seedHolder(today(), "stale");
    for (let i = 0; i < 5; i++) seedHolder(today(), null);
    for (let i = 0; i < 5; i++) {
      db.put("agent_runs", { id: `channel-run-${i}`, tenant_id: T, agent_slug: "generated_video", agent_definition_hash: "h", status: "success", enqueued_at: today() });
      db.put("channel_actions", { id: `channel-card-${i}`, tenant_id: T, channel_slug: "generated_video", run_id: `channel-run-${i}`, status: "pending" });
    }
    db.put("agent_runs", { id: "other-tenant-run", tenant_id: "22222222-2222-4222-8222-222222222222", agent_slug: "generated_video", agent_definition_hash: "generated-video-requested-card", status: "success", enqueued_at: today() });
    db.put("channel_actions", { id: "other-tenant-card", tenant_id: "22222222-2222-4222-8222-222222222222", channel_slug: "generated_video", run_id: "other-tenant-run", status: "pending" });
  }
  function seedFiled(count: number) {
    const states = ["pending", "rejected", "acted"] as const;
    for (let i = 0; i < count; i++) seedHolder(today(), states[i % states.length]);
  }
  function failRead(table: string) {
    const real = db.client.from;
    vi.spyOn(db.client, "from").mockImplementation((t: string) => {
      if (t !== table) return real(t);
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq", "neq", "gte", "in", "limit", "order"]) chain[k] = () => chain;
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "read timed out" } }).then(res);
      return chain as never;
    });
  }
  const holdersNow = () => holders().filter((r) => !String(r.id).startsWith("seed-run-") && r.id !== "other-tenant-run");

  it("files the 20th card when 19 are already filed today", async () => {
    seedNoise();
    seedFiled(19);
    const res = await callPraxisTool(ctx as never, "render_video", gen);
    expect(res.ok, res.content).toBe(true);
    expect(JSON.parse(res.content as string).status).toBe("card_filed");
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(holdersNow()).toHaveLength(1);
  });

  it("refuses the 21st card in plain words and files nothing", async () => {
    seedNoise();
    seedFiled(20);
    const res = await callPraxisTool(ctx as never, "render_video", gen);
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    const reply = JSON.parse(res.content as string) as { status: string; message: string };
    expect(reply.status).toBe("not_filed");
    expect(reply.message).toBe("You have asked for 20 videos today. Make or dismiss some in Suggested ads, then ask again tomorrow.");
    expect(m.record).not.toHaveBeenCalled();
    expect(holdersNow()).toHaveLength(0);
    expect(m.sent).toEqual([]);
  });

  it("a repeated identical request that kept the earlier card does not use up a slot", async () => {
    seedFiled(19);
    m.record.mockImplementation(async (a: { runId: string }) => {
      const kept = (db.tables.channel_actions ?? []).find((r) => r.status === "pending");
      return { id: kept?.id ?? "x", replayed: false, kept: true, runId: a.runId };
    });
    for (let i = 0; i < 3; i++) {
      const res = await callPraxisTool(ctx as never, "render_video", gen);
      expect(JSON.parse(res.content as string).status).toBe("card_filed");
    }
    expect(m.record).toHaveBeenCalledTimes(3);
  });

  it("a repeated identical request that replaced the earlier card does not use up a slot", async () => {
    seedFiled(19);
    m.record.mockImplementation(async (a: { runId: string }) => {
      for (const r of db.tables.channel_actions ?? []) if (r.status === "pending" && r.run_id !== a.runId) r.status = "stale";
      const id = `new-card-${a.runId}`;
      db.put("channel_actions", { id, tenant_id: T, channel_slug: "generated_video", run_id: a.runId, status: "pending" });
      return { id, replayed: false, kept: false };
    });
    for (let i = 0; i < 4; i++) {
      const res = await callPraxisTool(ctx as never, "render_video", gen);
      expect(JSON.parse(res.content as string).status).toBe("card_filed");
    }
    expect(m.record).toHaveBeenCalledTimes(4);
  });

  const lockRows = () => (db.tables.enrichment_rate_limit ?? []).filter((r) => r.key === `tenant:${T}:requested_video_card_lock`);

  it("two requests at the same moment with 19 filed today file exactly one card", async () => {
    seedNoise();
    seedFiled(19);
    m.record.mockImplementation(async (a: { runId: string }) => {
      await new Promise((r) => setTimeout(r, 20));
      const id = `race-card-${a.runId}`;
      db.put("channel_actions", { id, tenant_id: T, channel_slug: "generated_video", run_id: a.runId, status: "pending" });
      return { id, replayed: false, kept: false };
    });
    const replies = await Promise.all([0, 1, 2].map(() => callPraxisTool(ctx as never, "render_video", gen)));
    const statuses = replies.map((r) => JSON.parse(r.content as string).status).sort();
    expect(statuses).toEqual(["card_filed", "not_filed", "not_filed"]);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect((db.tables.channel_actions ?? []).filter((r) => String(r.id).startsWith("race-card-"))).toHaveLength(1);
    expect(lockRows()).toHaveLength(0);
  });

  it("a failed lock claim files nothing and says try again", async () => {
    seedFiled(3);
    db.rpcs.tick_enrichment_rate_limit = () => {
      throw new Error("rpc timed out");
    };
    const res = await callPraxisTool(ctx as never, "render_video", gen);
    expect(res.is_error).toBe(true);
    expect(String(res.content)).toMatch(/nothing was set up or charged/);
    expect(m.record).not.toHaveBeenCalled();
    expect(holdersNow()).toHaveLength(0);
  });

  it("the lock is let go after a filing error, so the next request files", async () => {
    m.record.mockRejectedValueOnce(new Error("insert failed"));
    const first = await callPraxisTool(ctx as never, "render_video", gen);
    expect(first.is_error).toBe(true);
    expect(lockRows()).toHaveLength(0);
    const second = await callPraxisTool(ctx as never, "render_video", gen);
    expect(JSON.parse(second.content as string).status).toBe("card_filed");
  });

  it.each(["agent_runs", "channel_actions"])("a failed %s count read files nothing and says try again", async (table) => {
    seedFiled(3);
    failRead(table);
    const res = await callPraxisTool(ctx as never, "render_video", gen);
    vi.restoreAllMocks();
    expect(res.is_error).toBe(true);
    expect(String(res.content)).toMatch(/Try again in a minute/);
    expect(String(res.content)).toMatch(/nothing was set up or charged/);
    expect(m.record).not.toHaveBeenCalled();
    expect(holdersNow()).toHaveLength(0);
    expect(m.sent).toEqual([]);
  });
});

describe("render_video motion graphics with an AI clip", () => {
  const withClip = [
    ["broll_prompt", { ...motion, broll_prompt: "a young woman gasps, then smiles at her phone" }],
    [
      "a broll scene",
      {
        ...motion,
        scenes: [
          { kind: "broll", video_prompt: "a young woman gasps, then smiles at her phone", duration_frames: 75 },
          { kind: "productui", header: { title: "Find a car" }, items: [{ title: "Book in two minutes", chips: ["Free"] }], duration_frames: 375 },
        ],
      },
    ],
  ] as const;

  it.each(withClip.flatMap(([label, args]) => ([LOCKED, BELOW_STARTER] as const).map((kind) => [label, kind, args] as const)))(
    "with %s on a %s tenant is refused before any render event",
    async (_label, kind, args) => {
      block(kind);
      const res = await callPraxisTool(ctx as never, "render_video", args);
      const reply = JSON.parse(res.content as string) as { status: string; next?: string };
      expect(reply.status).toBe("not_enabled");
      expect(reply.next).toMatch(/without the AI clip/);
      expect(m.sent).toEqual([]);
    },
  );

  it.each(withClip.map(([label, args]) => [label, args] as const))(
    "with %s on an entitled tenant is refused before any render event and points to a priced card",
    async (_label, args) => {
      const res = await callPraxisTool(ctx as never, "render_video", args);
      expect(res.is_error).toBe(false);
      const reply = JSON.parse(res.content as string) as { status: string; message: string; next: string };
      expect(reply.status).toBe("needs_priced_card");
      expect(reply.message).toMatch(/Nothing was charged/);
      expect(reply.next).toMatch(/generative_intent/);
      expect(reply.next).toMatch(/without the AI clip/);
      expect(m.sent).toEqual([]);
      expect(m.record).not.toHaveBeenCalled();
    },
  );

  it("without an AI clip an entitled tenant still gets its motion-graphics render", async () => {
    const res = await callPraxisTool(ctx as never, "render_video", motion);
    expect(res.ok, res.content).toBe(true);
    expect(m.sent.filter((e) => e.name === "video.render.requested")).toHaveLength(1);
  });

  it("without an AI clip a locked tenant still gets its motion-graphics render", async () => {
    block(LOCKED);
    const res = await callPraxisTool(ctx as never, "render_video", motion);
    expect(res.ok, res.content).toBe(true);
    expect(m.sent.filter((e) => e.name === "video.render.requested")).toHaveLength(1);
  });
});

describe("render_video asked for in chat starts the video without Make video", () => {
  const FOUNDER = "33333333-3333-4333-8333-333333333333";
  const founderCtx = { ...ctx, founder_chat_order: true, founder_order_unverified: false, actor: { actor_user_id: FOUNDER } };

  const webCtx = { ...founderCtx, trigger: "chat" as const, chat_thread_id: "thread-1", user_id: FOUNDER, slack_routing: undefined };

  it("a web chat shows the card there, starts nothing and keeps the founder in the chat", async () => {
    m.showInChat.mockResolvedValue("shown");
    m.chatStart.mockResolvedValue("started");
    const res = await callPraxisTool(webCtx as never, "render_video", gen);
    expect(res.ok, res.content).toBe(true);
    expect(m.showInChat).toHaveBeenCalledWith(T, ctx.run_id, "card-1");
    expect(m.chatStart).not.toHaveBeenCalled();
    const reply = JSON.parse(res.content as string) as { status: string; action_id: string; message: string; next: string };
    expect(reply.status).toBe("card_in_chat");
    expect(reply.action_id).toBe("card-1");
    expect(reply.next).not.toContain("Suggested ads");
    expect(reply.next).toContain("Do not send them to the AI UGC Videos channel");
  });

  it("a web chat card that could not be shown spends nothing and says where the card is", async () => {
    m.showInChat.mockResolvedValue("not_shown");
    m.chatStart.mockResolvedValue("started");
    const res = await callPraxisTool(webCtx as never, "render_video", gen);
    expect(m.chatStart).not.toHaveBeenCalled();
    const reply = JSON.parse(res.content as string) as { status: string; next: string };
    expect(reply.status).toBe("card_filed");
    expect(reply.next).toContain("Suggested ads");
  });

  it("a Slack ask never tries the web chat and keeps its auto-start", async () => {
    m.showInChat.mockResolvedValue("shown");
    m.chatStart.mockResolvedValue("started");
    const res = await callPraxisTool(founderCtx as never, "render_video", gen);
    expect(m.showInChat).not.toHaveBeenCalled();
    expect(m.chatStart).toHaveBeenCalledTimes(1);
    expect((JSON.parse(res.content as string) as { status: string }).status).toBe("video_started");
  });

  it("hands the filed card and the founder who asked to the auto-start, and tells the founder it is being made", async () => {
    m.chatStart.mockResolvedValue("started");
    const res = await callPraxisTool(founderCtx as never, "render_video", gen);
    expect(res.ok, res.content).toBe(true);
    expect(m.chatStart).toHaveBeenCalledTimes(1);
    expect(m.chatStart).toHaveBeenCalledWith(T, holders()[0].id, { actionId: "card-1", kept: false }, { founder: true, unverified: false, userId: FOUNDER });
    const reply = JSON.parse(res.content as string) as { status: string; action_id: string; message: string; next: string };
    expect(reply.status).toBe("video_started");
    expect(reply.action_id).toBe("card-1");
    expect(reply.message).not.toContain("Make video");
    expect(reply.next).not.toContain("Suggested ads");
  });

  it("an unverified founder order is passed on as unverified", async () => {
    await callPraxisTool({ ...founderCtx, founder_order_unverified: true } as never, "render_video", gen);
    expect(m.chatStart.mock.calls[0][3]).toEqual({ founder: true, unverified: true, userId: FOUNDER });
  });

  it.each(["not_chat", "not_first", "failed"])("when the auto-start answers %s the founder still gets the Make video card", async (outcome) => {
    m.chatStart.mockResolvedValue(outcome);
    const res = await callPraxisTool(founderCtx as never, "render_video", gen);
    const reply = JSON.parse(res.content as string) as { status: string; message: string; next: string };
    expect(reply.status).toBe("card_filed");
    expect(`${reply.message} ${reply.next}`).toContain("Make video");
  });

  it("a card that was not filed starts nothing", async () => {
    block(LOCKED);
    await callPraxisTool(founderCtx as never, "render_video", gen);
    expect(m.chatStart).not.toHaveBeenCalled();
  });

  it("a repeat ask that kept the earlier card tells the auto-start so, and the founder gets the Make video card instead of a second paid render", async () => {
    m.record.mockResolvedValue({ id: "card-1", replayed: false, kept: true });
    m.chatStart.mockImplementation(async (_t: unknown, _h: unknown, card: { kept: boolean }) => (card.kept ? "not_first" : "started"));
    const res = await callPraxisTool(founderCtx as never, "render_video", gen);
    expect(m.chatStart.mock.calls[0][2]).toEqual({ actionId: "card-1", kept: true });
    expect(JSON.parse(res.content as string).status).toBe("card_filed");
  });

  it("a redo run sets up no new video: no admission, no holder, no card, no auto-start", async () => {
    const res = await callPraxisTool({ ...founderCtx, redo: true } as never, "render_video", gen);
    expect(res.content).toMatch(/redo/i);
    expect(m.admit).not.toHaveBeenCalled();
    expect(holders()).toEqual([]);
    expect(m.record).not.toHaveBeenCalled();
    expect(m.chatStart).not.toHaveBeenCalled();
    expect(m.sent).toEqual([]);
  });

  it("a founder-typed ask is admitted as the founder's own chat turn with this video's price", async () => {
    const res = await callPraxisTool(founderCtx as never, "render_video", gen);
    const reply = JSON.parse(res.content as string) as { cost_credits: number };
    expect(m.admit).toHaveBeenCalledTimes(1);
    const [tenant, slug, forChannel, opts] = m.admit.mock.calls[0] as [string, string, unknown, { chat: boolean; accepted: number }];
    expect([tenant, slug, forChannel]).toEqual([T, "generated_video", undefined]);
    expect(opts.chat).toBe(true);
    expect(opts.accepted).toBe(reply.cost_credits);
    expect(opts.accepted).toBeGreaterThan(0);
  });

  it("an ask the founder did not type is checked against the founder's stop and the channel cap, with this video's price counted", async () => {
    m.admit.mockResolvedValue({ allowed: false, reason: "budget", message: "This channel reached its monthly credit limit." });
    const res = await callPraxisTool({ ...founderCtx, founder_chat_order: false } as never, "render_video", gen);
    const opts = m.admit.mock.calls[0][3] as { chat: boolean; accepted: number };
    expect(opts.chat).toBe(false);
    expect(opts.accepted).toBeGreaterThan(0);
    expect(JSON.parse(res.content as string).status).toBe("not_filed");
    expect(m.record).not.toHaveBeenCalled();
    expect(m.chatStart).not.toHaveBeenCalled();
  });
});
