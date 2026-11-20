
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  storageDownloadMock: vi.fn(),
  runGenericMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: mocks.fromMock,
    rpc: mocks.rpcMock,
    storage: {
      from: () => ({ download: mocks.storageDownloadMock }),
    },
  }),
  serverClientFromBearer: () => ({}),
}));

vi.mock("../generic-dispatcher", () => ({ runGeneric: mocks.runGenericMock }));

import { runChat } from "../chat-dispatcher";
import type { AgentContext } from "../types";

const fromMock = mocks.fromMock;
const storageDownloadMock = mocks.storageDownloadMock;
const runGenericMock = mocks.runGenericMock;

const TENANT_A = "11111111-aaaa-aaaa-aaaa-111111111111";
const THREAD_ID = "33333333-cccc-cccc-cccc-333333333333";
const USER_MSG_ID = "44444444-dddd-dddd-dddd-444444444444";
const IMAGE_UUID = "55555555-eeee-eeee-eeee-555555555555";
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function ctx(): AgentContext {
  return {
    agent: { slug: "support-lead", metadata_praxis: { tools: [] } } as never,
    tenant_id: TENANT_A,
    tenantConfig: {} as never,
    memory: {} as never,
    anthropic: {} as never,
    runId: "run-test",
    trigger: "chat" as never,
    scanRecentRuns: vi.fn().mockResolvedValue([]),
    emitDecision: vi.fn(),
    emitProgress: vi.fn(),
  } as never;
}

function stubChain(rows: unknown, err: unknown = null) {
  const result = Promise.resolve({ data: rows, error: err });
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "lt", "gte", "filter", "order", "limit", "in"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => result);
  chain.maybeSingle = vi.fn(() => result);
  chain.then = (resolve: (v: unknown) => unknown) => result.then(resolve);
  return chain as never;
}

function makeThreadMessagesStub(priorRows: unknown[] = []) {
  const userRow = {
    id: USER_MSG_ID,
    body: "what's in this image?",
    created_at: "2026-05-17T20:00:00Z",
    sender_role: "user",
    thread_id: THREAD_ID,
  };
  const single = Promise.resolve({ data: userRow, error: null });
  const list = Promise.resolve({ data: priorRows, error: null });
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "lt", "gte", "filter", "order", "limit", "in"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(() => single);
  chain.maybeSingle = vi.fn(() => single);
  chain.then = (resolve: (v: unknown) => unknown) => list.then(resolve);
  return chain as never;
}

function defaultFromImpl(priorRows: unknown[] = []) {
  return (table: string) => {
    if (table === "tenant_agent_kill_switch") return stubChain(null);
    if (table === "agent_threads") {
      return stubChain({
        id: THREAD_ID,
        tenant_id: TENANT_A,
        agent_slug: "support-lead",
      });
    }
    if (table === "agent_thread_messages") {
      return makeThreadMessagesStub(priorRows);
    }
    return stubChain([]);
  };
}

describe("chat-dispatcher image content", () => {
  it("builds image block with media_type='image/jpeg' (hardcoded, not from ext)", async () => {
    fromMock.mockImplementation(defaultFromImpl());
    mocks.rpcMock.mockResolvedValue({ error: null });
    storageDownloadMock.mockResolvedValue({
      data: { arrayBuffer: async () => JPEG_MAGIC.buffer.slice(0) },
      error: null,
    });
    runGenericMock.mockResolvedValue({ output_text: "I see something." });

    const path = `${TENANT_A}/${IMAGE_UUID}.jpg`;
    await runChat(ctx(), {
      thread_id: THREAD_ID,
      user_message_id: USER_MSG_ID,
      image_paths: [path],
    });

    expect(runGenericMock).toHaveBeenCalledTimes(1);
    const payload = runGenericMock.mock.calls[0][1] as {
      current_message_content?: Array<{
        type: string;
        source?: { type: string; media_type: string; data: string };
        text?: string;
      }>;
    };
    expect(payload.current_message_content).toBeDefined();
    expect(payload.current_message_content?.length).toBe(2);
    const [imgBlock, textBlock] = payload.current_message_content!;
    expect(imgBlock.type).toBe("image");
    expect(imgBlock.source?.type).toBe("base64");
    expect(imgBlock.source?.media_type).toBe("image/jpeg");
    expect(imgBlock.source?.data?.length ?? 0).toBeGreaterThan(0);
    expect(textBlock.type).toBe("text");
    expect(textBlock.text?.startsWith("what's in this image?")).toBe(true);
    expect(textBlock.text).toContain("[Note from Zavi, not the user: the user attached a photo");
    expect(textBlock.text).toContain(`1: image_path=${path}`);
    expect(textBlock.text).toContain("do not ask the user to host these photos");
  });

  it("replays an earlier photo and PDF for a chat agent, but neither for an eager sandbox agent (engineer)", async () => {
    const DOC_UUID = "66666666-ffff-ffff-ffff-666666666666";
    const prior = [
      { sender_role: "assistant", body: "Got them.", created_at: "2026-05-17T19:01:00Z" },
      {
        sender_role: "user",
        body: "here is our menu and storefront",
        created_at: "2026-05-17T19:00:00Z",
        attachments: [
          { path: `${TENANT_A}/${IMAGE_UUID}.jpg`, kind: "image" },
          { path: `${TENANT_A}/${DOC_UUID}.pdf`, kind: "doc" },
        ],
      },
    ];
    mocks.rpcMock.mockResolvedValue({ error: null });
    storageDownloadMock.mockResolvedValue({
      data: { arrayBuffer: async () => JPEG_MAGIC.buffer.slice(0) },
      error: null,
    });
    runGenericMock.mockResolvedValue({ output_text: "ok" });
    const types = async (sandbox: boolean, lazy = false) => {
      runGenericMock.mockClear();
      fromMock.mockImplementation(defaultFromImpl(prior));
      const c = ctx() as { agent: { metadata_praxis: Record<string, unknown> }; lazySandboxEligible?: boolean };
      c.agent.metadata_praxis = { tools: [], ...(sandbox ? { requires_sandbox: true } : {}) };
      if (lazy) c.lazySandboxEligible = true;
      await runChat(c as never, { thread_id: THREAD_ID, user_message_id: USER_MSG_ID });
      const msgs = (runGenericMock.mock.calls[0][1] as { prior_messages: Array<{ content: unknown }> }).prior_messages;
      return msgs.map((m) => (typeof m.content === "string" ? "string" : (m.content as Array<{ type: string }>).map((b) => b.type).join(",")));
    };
    expect(await types(false)).toEqual(["image,document,text", "string"]);
    expect(await types(true)).toEqual(["string", "string"]);
    expect(await types(true, true)).toEqual(["image,document,text", "string"]);
  });

  it("flags an earlier owner file even when it was not replayed, and never trusts a raw flag", async () => {
    mocks.rpcMock.mockResolvedValue({ error: null });
    runGenericMock.mockResolvedValue({ output_text: "ok" });
    storageDownloadMock.mockResolvedValue({ data: null, error: { message: "gone" } });
    const flag = async (prior: unknown[], raw: Record<string, unknown> = {}) => {
      runGenericMock.mockClear();
      fromMock.mockImplementation(defaultFromImpl(prior));
      await runChat(ctx(), { thread_id: THREAD_ID, user_message_id: USER_MSG_ID, ...raw });
      const payload = runGenericMock.mock.calls[0][1] as { prior_had_attachments?: unknown; prior_messages: Array<{ content: unknown }> };
      return { flag: payload.prior_had_attachments, firstIsText: typeof payload.prior_messages[0]?.content === "string" };
    };
    const photoTurn = { sender_role: "user", body: "caption this", created_at: "2026-05-17T19:00:00Z", attachments: [{ path: `${TENANT_A}/${IMAGE_UUID}.jpg`, kind: "image" }] };
    expect(await flag([photoTurn])).toEqual({ flag: true, firstIsText: true });
    const textTurn = { sender_role: "user", body: "hello", created_at: "2026-05-17T19:00:00Z" };
    expect(await flag([textTurn], { prior_had_attachments: true })).toEqual({ flag: undefined, firstIsText: true });
  });

  it("does NOT forward raw image_paths into the run-context visible payload", async () => {
    fromMock.mockImplementation(defaultFromImpl());
    mocks.rpcMock.mockResolvedValue({ error: null });
    storageDownloadMock.mockResolvedValue({
      data: { arrayBuffer: async () => JPEG_MAGIC.buffer.slice(0) },
      error: null,
    });
    runGenericMock.mockResolvedValue({ output_text: "ok" });

    const path = `${TENANT_A}/${IMAGE_UUID}.jpg`;
    await runChat(ctx(), {
      thread_id: THREAD_ID,
      user_message_id: USER_MSG_ID,
      image_paths: [path],
    });

    const payload = runGenericMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.image_paths).toBeUndefined();
  });

  it("throws on tenant-prefix mismatch (Codex C8 re-derive)", async () => {
    fromMock.mockImplementation(defaultFromImpl());
    runGenericMock.mockResolvedValue({ output_text: "ok" });
    const foreignTenant = "99999999-9999-9999-9999-999999999999";
    const path = `${foreignTenant}/${IMAGE_UUID}.jpg`;
    await expect(
      runChat(ctx(), {
        thread_id: THREAD_ID,
        user_message_id: USER_MSG_ID,
        image_paths: [path],
      }),
    ).rejects.toThrow(/does not belong to tenant/);
  });

  it("throws on .png extension (proves .jpg-only regex holds in worker)", async () => {
    fromMock.mockImplementation(defaultFromImpl());
    runGenericMock.mockResolvedValue({ output_text: "ok" });
    const pngPath = `${TENANT_A}/${IMAGE_UUID}.png`;
    await expect(
      runChat(ctx(), {
        thread_id: THREAD_ID,
        user_message_id: USER_MSG_ID,
        image_paths: [pngPath],
      }),
    ).rejects.toThrow(/does not belong to tenant/);
  });
});

describe("chat-dispatcher attached video", () => {
  const VIDEO_UUID = "77777777-ffff-ffff-ffff-777777777777";

  function lastPayload() {
    return runGenericMock.mock.calls.at(-1)![1] as {
      current_message?: string;
      current_message_content?: Array<{ type: string; text?: string }>;
      video_paths?: unknown;
    };
  }

  it("names the attached video and its exact path in the turn text", async () => {
    fromMock.mockImplementation(defaultFromImpl());
    mocks.rpcMock.mockResolvedValue({ error: null });
    runGenericMock.mockResolvedValue({ output_text: "ok" });

    const path = `${TENANT_A}/${VIDEO_UUID}.mp4`;
    await runChat(ctx(), {
      thread_id: THREAD_ID,
      user_message_id: USER_MSG_ID,
      video_paths: [path],
    });

    const payload = lastPayload();
    expect(payload.current_message).toContain("what's in this image?");
    expect(payload.current_message).toContain(`[Attached video: ${path}]`);
    expect(payload.current_message).toContain("`video_path`");
    expect(payload.video_paths).toEqual([path]);
    expect(payload.current_message_content).toBeUndefined();
  });

  it("carries the note into the text block when an image rides along too", async () => {
    fromMock.mockImplementation(defaultFromImpl());
    mocks.rpcMock.mockResolvedValue({ error: null });
    storageDownloadMock.mockResolvedValue({
      data: { arrayBuffer: async () => JPEG_MAGIC.buffer.slice(0) },
      error: null,
    });
    runGenericMock.mockResolvedValue({ output_text: "ok" });

    const video = `${TENANT_A}/${VIDEO_UUID}.mp4`;
    await runChat(ctx(), {
      thread_id: THREAD_ID,
      user_message_id: USER_MSG_ID,
      image_paths: [`${TENANT_A}/${IMAGE_UUID}.jpg`],
      video_paths: [video],
    });

    const textBlock = lastPayload().current_message_content?.find((b) => b.type === "text");
    expect(textBlock?.text).toContain(`[Attached video: ${video}]`);
  });

  it("drops a video path under another tenant: not mentioned, not forwarded", async () => {
    fromMock.mockImplementation(defaultFromImpl());
    mocks.rpcMock.mockResolvedValue({ error: null });
    runGenericMock.mockResolvedValue({ output_text: "ok" });

    const foreign = `99999999-9999-9999-9999-999999999999/${VIDEO_UUID}.mp4`;
    await runChat(ctx(), {
      thread_id: THREAD_ID,
      user_message_id: USER_MSG_ID,
      video_paths: [foreign],
    });

    const payload = lastPayload();
    expect(payload.current_message).not.toContain("Attached video");
    expect(payload.video_paths).toBeUndefined();
  });
});

describe("chat-dispatcher attached photo note", () => {
  function textBlock() {
    const payload = runGenericMock.mock.calls.at(-1)![1] as {
      current_message?: string;
      current_message_content?: Array<{ type: string; text?: string }>;
    };
    return payload.current_message_content?.find((b) => b.type === "text")?.text ?? payload.current_message ?? "";
  }

  it("tells the operator an attached photo is the user's own, usable as is, with no rights questions", async () => {
    fromMock.mockImplementation(defaultFromImpl());
    mocks.rpcMock.mockResolvedValue({ error: null });
    storageDownloadMock.mockResolvedValue({
      data: { arrayBuffer: async () => JPEG_MAGIC.buffer.slice(0) },
      error: null,
    });
    runGenericMock.mockResolvedValue({ output_text: "ok" });

    await runChat(ctx(), {
      thread_id: THREAD_ID,
      user_message_id: USER_MSG_ID,
      image_paths: [`${TENANT_A}/${IMAGE_UUID}.jpg`],
    });

    const text = textBlock();
    expect(text).toContain("what's in this image?");
    expect(text).toContain("[Note from Zavi, not the user: the user attached a photo");
    expect(text).toContain("copyright");
    expect(text).toContain("never ask them to send it again");
    expect(text).toContain("hand the change to the engineer");
  });

  it("a text-only turn carries no photo note", async () => {
    fromMock.mockImplementation(defaultFromImpl());
    mocks.rpcMock.mockResolvedValue({ error: null });
    runGenericMock.mockResolvedValue({ output_text: "ok" });

    await runChat(ctx(), { thread_id: THREAD_ID, user_message_id: USER_MSG_ID });

    expect(textBlock()).not.toContain("Note from Zavi");
  });
});

describe("chat-dispatcher hand-off status on an attachment turn", () => {
  it("puts the hand-off block in the trailing text block", async () => {
    const base = defaultFromImpl();
    fromMock.mockImplementation((table: string) => {
      if (table === "agent_threads") {
        return stubChain({ id: THREAD_ID, tenant_id: TENANT_A, agent_slug: "operator" });
      }
      if (table === "agent_runs") {
        const chain = stubChain([]) as unknown as Record<string, unknown>;
        let handoff = false;
        const eq = vi.fn((col: string, val: unknown) => {
          if (col === "trigger" && val === "handoff") handoff = true;
          return chain;
        });
        chain.eq = eq;
        chain.limit = vi.fn(() =>
          handoff
            ? Promise.resolve({
                data: [{ id: "c1", agent_slug: "engineer", status: "running" }],
                error: null,
              })
            : chain,
        );
        return chain as never;
      }
      return base(table);
    });
    mocks.rpcMock.mockResolvedValue({ error: null });
    storageDownloadMock.mockResolvedValue({
      data: { arrayBuffer: async () => JPEG_MAGIC.buffer.slice(0) },
      error: null,
    });
    runGenericMock.mockResolvedValue({ output_text: "ok" });

    const c = ctx() as unknown as { agent: unknown };
    c.agent = { slug: "operator", metadata_praxis: { tools: [] } };
    await runChat(c as never, {
      thread_id: THREAD_ID,
      user_message_id: USER_MSG_ID,
      image_paths: [`${TENANT_A}/${IMAGE_UUID}.jpg`],
    });

    const payload = runGenericMock.mock.calls.at(-1)![1] as {
      current_message?: string;
      current_message_content?: Array<{ type: string; text?: string }>;
    };
    expect(payload.current_message).toContain("- engineer: still working on it.");
    const textBlock = payload.current_message_content?.find((b) => b.type === "text");
    expect(textBlock?.text).toContain("- engineer: still working on it.");
    expect(textBlock?.text).toContain("what's in this image?");
  });
});
