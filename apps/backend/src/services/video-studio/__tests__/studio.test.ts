import { describe, expect, it, vi } from "vitest";
import {
  RENDER_STALL_MS,
  RENDER_QUEUE_MAX_MS,
  buildStudioView,
  DRAFT_FAILED_REPLY,
  readStudio,
  retryStudioRender,
  sendStudioMessage,
  START_FAILED_REPLY,
  CHANNEL_OFF_REPLY,
  ENQUEUE_ATTEMPTS,
  StudioError,
  type StudioDeps,
  type StudioMessageRow,
  type StudioStore,
  type VideoArtifactRow,
  type GalleryArtifactRow,
  type GalleryRunRow,
  listStudioThreads,
  readGallery,
  writeStudioScript,
  NO_SCRIPT_REPLY,
  SCRIPT_FAILED_REPLY,
  DUPLICATE_SEND_REPLY,
  MAX_TITLE_CHARS,
  threadTitle,
  cheapestStudioVideoUsd,
  businessPrompt,
  readStudioPrompt,
  PROMPT_VARIANTS,
  NOT_ENOUGH_WITH_VIDEOS_AHEAD,
} from "../studio";
import { ANIMATE_WITH_PROMPT_REPLY, ANIMATE_CUSTOMER_VOICE_REFUSAL, DEFAULT_ANIMATE_PROMPT, DIFFERENT_PRESENTER_REPLY, PHOTO_PRESENTER_REPLY, SCRIPT_WRITER_HINT, VERBATIM_REPLY, VERBATIM_SCRIPT_HINT, type BusinessContext, type VideoDraft } from "../draft";
import { ExpectedToolError } from "@/services/tools/types";
import { memorySendClaims } from "./send-claims-memory";
import { draftToIntake } from "../draft";
import { billedVideoCredits, starterVideoCredits } from "@/services/launch-video/video-estimate";
import type { AffordCheck } from "@/services/media-router/charge";
import { NOT_ENOUGH_CREDITS as NOT_ENOUGH_CREDITS_COPY } from "@/services/channels/generated-video-render";

vi.mock("@/services/billing/flat-pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/billing/flat-pricing")>()),
  isFlatJobPricingOn: async () => true,
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "33333333-3333-4333-8333-333333333333";
const SCRIPT = "Meet the serum that layers under makeup without pilling, so your skin looks calm by noon and stays that way all day long.";

const DRAFT: VideoDraft = {
  intent: "talking_head",
  aspect_ratio: "9:16",
  visual: "A woman in her late 20s in a bright bathroom.",
  script: SCRIPT,
  hook: "Meet the serum.",
  presenter_gender: "female",
  image_path: null,
};

type Evt = { id: string; name: string; data: Record<string, unknown> };

function memoryStore() {
  const threads: Array<{ id: string; user_id: string; title: string | null; created_at: string }> = [];
  const videoRuns: GalleryRunRow[] = [];
  const galleryArtifacts: GalleryArtifactRow[] = [];
  const messages: Array<StudioMessageRow & { thread_id: string }> = [];
  const runs: string[] = [];
  const artifacts: VideoArtifactRow[] = [];
  let seq = 0;
  let clock = Date.now() - 60_000;
  const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const tick = () => new Date((clock += 1000)).toISOString();
  const store: StudioStore = {
    async findThread(user_id) {
      return [...threads].reverse().find((t) => t.user_id === user_id)?.id ?? null;
    },
    async getOwnThread(user_id, thread_id) {
      return threads.find((t) => t.id === thread_id && t.user_id === user_id)?.id ?? null;
    },
    async listThreads(user_id, limit) {
      return [...threads]
        .reverse()
        .filter((t) => t.user_id === user_id)
        .slice(0, limit)
        .map((t) => ({ id: t.id, title: t.title, created_at: t.created_at, last_message_at: null }));
    },
    async setThreadTitle(thread_id, title) {
      const t = threads.find((x) => x.id === thread_id);
      if (t) t.title = title;
    },
    async listVideoRuns(limit) {
      return videoRuns.slice(0, limit);
    },
    async listGalleryArtifacts(run_ids) {
      return galleryArtifacts.filter((a) => run_ids.includes(a.run_id));
    },
    async createThread(user_id) {
      const t = { id: id(), user_id, title: null, created_at: tick() };
      threads.push(t);
      return t.id;
    },
    async listMessages(thread_id, limit) {
      return messages
        .filter((m) => m.thread_id === thread_id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map((m) => ({ ...m, meta: { ...m.meta } }));
    },
    async listRunMessages(thread_id, run_id) {
      return messages
        .filter((m) => m.thread_id === thread_id && (m.agent_run_id === run_id || m.meta.source_run_id === run_id))
        .map((m) => ({ ...m, meta: { ...m.meta } }));
    },
    async getMessage(thread_id, message_id) {
      const m = messages.find((x) => x.thread_id === thread_id && x.id === message_id);
      return m ? { ...m, meta: { ...m.meta } } : null;
    },
    async insertMessage(m) {
      if (m.sender_role === "assistant" && m.agent_run_id && messages.some((x) => x.sender_role === "assistant" && x.agent_run_id === m.agent_run_id)) {
        throw new Error("duplicate key value violates unique constraint agent_thread_messages_one_assistant_per_run");
      }
      const row = {
        id: id(),
        thread_id: m.thread_id,
        sender_role: m.sender_role,
        body: m.body,
        meta: m.meta ?? {},
        attachments: m.attachments ?? null,
        agent_run_id: m.agent_run_id ?? null,
        created_at: tick(),
      };
      messages.push(row);
      return { ...row };
    },
    async claimRender(thread_id, message_id, run_id, previous_run_id) {
      await Promise.resolve();
      const m = messages.find((x) => x.thread_id === thread_id && x.id === message_id);
      const current = typeof m?.meta.render_run_id === "string" ? m.meta.render_run_id : null;
      if (!m || current !== previous_run_id) return false;
      m.meta = { ...m.meta, render_run_id: run_id };
      return true;
    },
    async createRenderRun(a) {
      await Promise.resolve();
      const r = a.id ?? id();
      runs.push(r);
      return r;
    },
    async listVideoArtifacts(run_ids) {
      return artifacts.filter((a) => run_ids.includes(a.run_id));
    },
  };
  return { store, threads, messages, runs, artifacts, videoRuns, galleryArtifacts };
}

const draftReply = (over: Record<string, unknown> = {}) => JSON.stringify({ reply: "Making a 9:16 presenter video.", ...DRAFT, ...over });

function setup(over: Partial<StudioDeps> = {}, reply: string = draftReply()) {
  const mem = memoryStore();
  const complete = vi.fn(async (_s: string, _u: string) => reply);
  const send = vi.fn(async (_e: Evt): Promise<unknown> => ({ ids: ["x"] }));
  const deps: StudioDeps = {
    store: mem.store,
    draft: { complete },
    business: async () => null,
    videoEnabled: async () => true,
    routerEnabled: async () => true,
    tier: async () => ({ allowed: true, required_tier: "starter" }),
    send,
    ...over,
  };
  return { mem, deps, complete, send: (over.send as typeof send | undefined) ?? send };
}

const say = (deps: StudioDeps, text = "ugc ad for our serum", user_id = USER) => sendStudioMessage(deps, { tenant_id: TENANT, user_id, text });
const evt = (send: { mock: { calls: unknown[][] } }, i = 0) => send.mock.calls[i][0] as Evt;

describe("one message makes the video", () => {
  it("drafts and queues exactly one chat render on the standard avatar tier, tied to the rendering message", async () => {
    const { deps, send, mem } = setup();
    const out = await say(deps);
    expect(out.reply.meta).toMatchObject({ kind: "video_studio_draft", video_draft: DRAFT });
    expect(out.render && "run_id" in out.render).toBe(true);
    const run_id = (out.render as { run_id: string }).run_id;
    expect(send).toHaveBeenCalledTimes(1);
    expect(evt(send)).toMatchObject({
      id: `video-generate-${run_id}`,
      name: "video.generate.requested",
      data: {
        run_id,
        tenant_id: TENANT,
        delivery_target: { kind: "chat", thread_id: out.thread_id },
        intake: { intent: "talking_head", script: SCRIPT, presenter_gender: "female", aspect_ratio: "9:16", avatar_tier: "standard" },
      },
    });
    const rendering = (out.render as { rendering_message: StudioMessageRow }).rendering_message;
    expect(rendering.agent_run_id).toBe(run_id);
    expect(mem.messages.find((m) => m.id === out.reply.id)?.meta.render_run_id).toBe(run_id);
  });

  it("a follow-up revises the last script and makes a new video", async () => {
    const { deps, complete, send, mem } = setup();
    await say(deps);
    await say(deps, "use a male presenter");
    expect(complete.mock.calls[0][1]).not.toContain("<current_draft>");
    expect(complete.mock.calls[1][1]).toContain("<current_draft>");
    expect(complete.mock.calls[1][1]).toContain("layers under makeup");
    expect(send).toHaveBeenCalledTimes(2);
    expect(mem.threads).toHaveLength(1);
  });

  it("a follow-up keeps the founder's own offer from an earlier message as their words, not an invented claim", async () => {
    const { deps, complete } = setup();
    await say(deps, "A promo for our yoga studio. First class is free this week.");
    await say(deps, "make it shorter and use a woman");
    const user = complete.mock.calls[1][1];
    expect(user).toMatch(/<earlier_requests>[^]*First class is free this week\.[^]*<\/earlier_requests>/);
    expect(user).toMatch(/<request>make it shorter and use a woman<\/request>/);
    expect(complete.mock.calls[1][0]).toContain("<earlier_requests>");
  });

  it("an earlier message Zavi refused is not passed back as the founder's words", async () => {
    const { deps, complete, mem } = setup();
    await say(deps, "A promo for our yoga studio.");
    const refusedUser = await deps.store.insertMessage({ thread_id: mem.threads[0].id, sender_role: "user", body: "Say we are rated number one in the city." });
    await deps.store.insertMessage({ thread_id: mem.threads[0].id, sender_role: "assistant", body: "No.", meta: { kind: "video_studio_refused", code: "testimonial" } });
    expect(refusedUser.id).toBeTruthy();
    await say(deps, "make it shorter");
    const user = complete.mock.calls[1][1];
    expect(user).toContain("A promo for our yoga studio.");
    expect(user).not.toContain("rated number one");
  });

  it("an earlier message from another chat never reaches the model", async () => {
    const { deps, complete } = setup();
    await say(deps, "First class is free this week.");
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "a gym promo", new_thread: true });
    expect(complete.mock.calls[1][1]).not.toContain("First class is free");
    expect(complete.mock.calls[1][1]).not.toContain("<earlier_requests>");
  });

  it("gives the model the workspace's business so the first video is about it", async () => {
    const biz: BusinessContext = { name: "Rise Bakery", what_we_sell: "Sourdough and pastries, pre-order for 8am pickup", website: "https://rise.example" };
    const { deps, complete } = setup({ business: async () => biz });
    await say(deps, "a 15 second ad");
    const user = complete.mock.calls[0][1];
    expect(user).toContain("<business>");
    expect(user).toContain("Rise Bakery");
    expect(user).toContain("pre-order for 8am pickup");
  });

  it("sends no business block when the workspace has none", async () => {
    const { deps, complete } = setup();
    await say(deps);
    expect(complete.mock.calls[0][1]).not.toContain("<business>");
  });

  it("a testimonial request is answered with a refusal and makes no video", async () => {
    const { deps, send, mem } = setup();
    const out = await say(deps, "a testimonial from a happy customer about our serum");
    expect(out.reply.meta).toMatchObject({ kind: "video_studio_refused", code: "testimonial" });
    expect(out.render).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(mem.runs).toHaveLength(0);
  });

  it("a model outage answers in the thread and makes no video", async () => {
    const { deps, send, mem } = setup({ draft: { complete: async () => { throw new Error("529 overloaded"); } } });
    const out = await say(deps);
    expect(out.reply.body).toBe(DRAFT_FAILED_REPLY);
    expect(out.render).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(mem.runs).toHaveLength(0);
  });

  it("rejects an empty prompt before touching the model", async () => {
    const { deps, complete } = setup();
    await expect(say(deps, "   ")).rejects.toMatchObject({ status: 400 });
    expect(complete).not.toHaveBeenCalled();
  });

  it("a plan without AI UGC Videos spends neither a model call nor a render", async () => {
    const { deps, complete, send, mem } = setup({ tier: async () => ({ allowed: false, required_tier: "starter" }) });
    await expect(say(deps)).rejects.toMatchObject({ status: 403, code: "plan_upgrade_required", extra: { required_tier: "starter" } });
    expect(complete).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mem.messages).toHaveLength(0);
  });

  it("a workspace with no credits left spends no model call and starts no render", async () => {
    const { deps, complete, send, mem } = setup({ afford: async () => "short" as const });
    await expect(say(deps)).rejects.toMatchObject({ status: 402, code: "insufficient_credits" });
    expect(complete).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mem.messages ?? []).toHaveLength(0);
  });

  it("an unreadable balance does not block the chat; the worker's own check still guards the paid step", async () => {
    const { deps, complete } = setup({ afford: async () => "unknown" as const });
    await say(deps);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("with video switched off nothing is drafted, so no model money is spent on a video that cannot be made", async () => {
    const { deps, complete, send } = setup({ routerEnabled: async () => false });
    await expect(say(deps)).rejects.toMatchObject({ status: 503, code: "video_unavailable" });
    expect(complete).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("a flaky enqueue is retried inside the request with the same run and event id, so a call that did land is never bought twice", async () => {
    let calls = 0;
    const send = vi.fn(async (_e: Evt): Promise<unknown> => {
      calls++;
      if (calls < 3) throw new Error("response lost");
      return {};
    });
    const { deps, mem } = setup({ send });
    const out = await say(deps);
    expect(out.render && "run_id" in out.render).toBe(true);
    expect(mem.runs).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(send.mock.calls.map((c) => (c[0] as Evt).id)).size).toBe(1);
    expect(new Set(send.mock.calls.map((c) => (c[0] as Evt).data.run_id)).size).toBe(1);
    expect(mem.messages.some((m) => m.body === START_FAILED_REPLY)).toBe(false);
  });

  it("an enqueue that timed out after the event landed shows the video as being made, never claims nothing was made or charged, and Try again does not buy it twice", async () => {
    const send = vi.fn(async (_e: Evt): Promise<unknown> => {
      throw new Error("Request timed out");
    });
    const { deps, mem } = setup({ send });
    const out = await say(deps);
    expect(send).toHaveBeenCalledTimes(ENQUEUE_ATTEMPTS);
    const run_id = mem.runs[0];
    const told = mem.messages.find((m) => m.meta.source_run_id === run_id)!;
    for (const text of [told.body, (out.render as { error: string }).error]) {
      expect(text).not.toMatch(/nothing was made|not charged|nothing was charged/i);
      expect(text).toMatch(/only charged|charged only/i);
    }
    mem.store.listStartedRuns = async (ids) => ids.filter((i) => i === run_id).map((i) => ({ run_id: i, created_at: new Date().toISOString() }));
    const view = await readStudio(mem.store, USER);
    expect(view.renders[run_id]).toMatchObject({ status: "rendering" });
    expect(view.renders[run_id].working_since).toEqual(expect.any(String));
    send.mockClear();
    send.mockImplementation(async () => ({}));
    await expect(retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 409 });
    expect(send).not.toHaveBeenCalled();
    expect(mem.runs).toHaveLength(1);
  });

  it("a worker failure on a run is still a failure even when its job row exists", async () => {
    const { deps, mem } = setup();
    const out = await say(deps);
    const run_id = mem.runs[0];
    await mem.store.insertMessage({ thread_id: out.thread_id, sender_role: "assistant", body: "Sorry", meta: { source_run_id: run_id, kind: "generative_video_failed" } });
    mem.store.listStartedRuns = async (ids) => ids.map((i) => ({ run_id: i, created_at: new Date().toISOString() }));
    expect((await readStudio(mem.store, USER)).renders[run_id].status).toBe("failed");
  });

  it("an enqueue that keeps failing says so, keeps the script, and Try again re-sends the same run under the same event id", async () => {
    let fail = true;
    const send = vi.fn(async (_e: Evt): Promise<unknown> => {
      if (fail) throw new Error("inngest down");
      return {};
    });
    const { deps, mem } = setup({ send });
    mem.store.listStartedRuns = async () => [];
    const out = await say(deps);
    expect(out.render).toMatchObject({ code: "enqueue_failed" });
    expect(send).toHaveBeenCalledTimes(ENQUEUE_ATTEMPTS);
    expect((await readStudio(mem.store, USER)).renders[mem.runs[0]].status).toBe("failed");
    fail = false;
    const retry = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id });
    expect(retry.run_id).toBe(mem.runs[0]);
    expect(mem.runs).toHaveLength(1);
    expect(evt(send, ENQUEUE_ATTEMPTS)).toEqual(evt(send, 0));
    const view = await readStudio(mem.store, USER);
    expect(view.renders[retry.run_id]).toMatchObject({ status: "rendering", queued: true });
    expect(view.renders[retry.run_id].code).toBeUndefined();
    expect(view.messages.some((m) => m.kind === "video_studio_requeued")).toBe(false);
  });

  it("a send Inngest accepted but reported as failed, then Try again, buys exactly one video and one charge", async () => {
    const accepted = new Set<string>();
    const workerRuns = new Set<string>();
    let vendorSubmits = 0;
    let charges = 0;
    let ambiguous = true;
    const send = vi.fn(async (e: Evt): Promise<unknown> => {
      if (!accepted.has(e.id)) {
        accepted.add(e.id);
        const run_id = String(e.data.run_id);
        if (!workerRuns.has(run_id)) {
          workerRuns.add(run_id);
          vendorSubmits++;
          charges++;
        }
      }
      if (ambiguous) throw new Error("inngest send timed out");
      return { ids: [e.id] };
    });
    const { deps, mem } = setup({ send });
    mem.store.listStartedRuns = async () => [];
    const out = await say(deps);
    expect(out.render).toMatchObject({ code: "enqueue_failed" });
    expect(vendorSubmits).toBe(1);
    const run_id = mem.runs[0];
    const before = await readStudio(mem.store, USER);
    expect(before.renders[run_id]).toMatchObject({ status: "failed", code: "enqueue_failed" });

    ambiguous = false;
    const retry = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id });
    expect(vendorSubmits).toBe(1);
    expect(charges).toBe(1);
    expect(retry.run_id).toBe(run_id);
    expect(new Set(send.mock.calls.map((c) => (c[0] as Evt).id))).toEqual(new Set([`video-generate-${run_id}`]));
    expect(mem.runs).toEqual([run_id]);
    expect(mem.messages.find((m) => m.id === out.reply.id)?.meta.render_run_id).toBe(run_id);
    expect((await readStudio(mem.store, USER)).renders[run_id]).toMatchObject({ status: "rendering", queued: true });

    await expect(retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 409, code: "already_rendered" });
    expect(vendorSubmits).toBe(1);
    expect(charges).toBe(1);
  });

  it("a re-send that fails again shows failed again, and the next Try again still re-sends the same run", async () => {
    let fail = true;
    const send = vi.fn(async (_e: Evt): Promise<unknown> => {
      if (fail) throw new Error("inngest down");
      return {};
    });
    const { deps, mem } = setup({ send });
    const out = await say(deps);
    const run_id = mem.runs[0];
    await expect(retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 502, code: "enqueue_failed" });
    expect((await readStudio(mem.store, USER)).renders[run_id]).toMatchObject({ status: "failed", code: "enqueue_failed" });
    fail = false;
    const retry = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id });
    expect(retry.run_id).toBe(run_id);
    expect(mem.runs).toEqual([run_id]);
    expect(new Set(send.mock.calls.map((c) => (c[0] as Evt).id)).size).toBe(1);
  });

  it("a worker failure after an ambiguous send still lets Try again buy a fresh run", async () => {
    let fail = true;
    const send = vi.fn(async (_e: Evt): Promise<unknown> => {
      if (fail) throw new Error("inngest send timed out");
      return {};
    });
    const { deps, mem } = setup({ send });
    const out = await say(deps);
    const run_id = mem.runs[0];
    await mem.store.insertMessage({ thread_id: out.thread_id, sender_role: "assistant", body: "Sorry", meta: { source_run_id: run_id, kind: "generative_video_failed" } });
    fail = false;
    const retry = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id });
    expect(retry.run_id).not.toBe(run_id);
    expect(mem.runs).toEqual([run_id, retry.run_id]);
  });

  it("if the rendering status cannot be written after the claim, Try again still works instead of the script locking forever", async () => {
    const { deps, mem, send } = setup();
    const insert = mem.store.insertMessage.bind(mem.store);
    let breakOnce = true;
    mem.store.insertMessage = async (m) => {
      if (breakOnce && m.meta?.kind === "video_studio_rendering") {
        breakOnce = false;
        throw new Error("db blip");
      }
      return insert(m);
    };
    await expect(say(deps)).rejects.toThrow("db blip");
    const draft = mem.messages.find((m) => m.meta?.kind === "video_studio_draft")!;
    const shown = (await readStudio(mem.store, USER)).messages.find((m) => m.id === draft.id)!;
    expect(shown.render_run_id).toBeNull();
    const retry = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: draft.id });
    expect(retry.run_id).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a locked channel refuses before any model call or render, and an unreadable lock refuses too", async () => {
    const { deps, complete, send } = setup({ channelLocked: async () => true });
    await expect(say(deps)).rejects.toMatchObject({ status: 503, code: "video_unavailable", message: CHANNEL_OFF_REPLY });
    deps.channelLocked = async () => {
      throw new Error("config down");
    };
    await expect(say(deps)).rejects.toMatchObject({ status: 503, code: "video_unavailable" });
    expect(complete).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["an enqueue_failed run whose event did land", true],
    ["a run that is still rendering past the stall window", false],
  ])("when the job read fails, Try again on %s refuses with 503 and buys no second video", async (_label, enqueueFails) => {
    const landed = new Set<string>();
    let charges = 0;
    let clock = Date.now();
    const send = vi.fn(async (e: Evt): Promise<unknown> => {
      if (!landed.has(e.id)) {
        landed.add(e.id);
        charges++;
      }
      if (enqueueFails) throw new Error("inngest send timed out");
      return { ids: [e.id] };
    });
    const { deps, mem } = setup({ send, now: () => clock });
    const out = await say(deps);
    const run_id = mem.runs[0];
    expect(charges).toBe(1);
    const sendsBefore = send.mock.calls.length;
    clock += 25 * 60 * 60 * 1000;
    landed.clear();
    const readError = new Error("job rows read timed out");
    mem.store.listStartedRuns = vi.fn(async () => {
      throw readError;
    });
    const claim = vi.spyOn(mem.store, "claimRender");
    const createRun = vi.spyOn(mem.store, "createRenderRun");
    const insert = vi.spyOn(mem.store, "insertMessage");
    const messagesBefore = mem.messages.map((m) => ({ id: m.id, meta: JSON.stringify(m.meta) }));

    const err = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id }).catch((e) => e);

    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ status: 503, code: "render_check_unavailable", message: "Zavi could not check this video just now. Try again in a minute." });
    expect(mem.store.listStartedRuns).toHaveBeenCalled();
    expect(send.mock.calls.length).toBe(sendsBefore);
    expect(charges).toBe(1);
    expect(claim).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(mem.runs).toEqual([run_id]);
    expect(mem.messages.map((m) => ({ id: m.id, meta: JSON.stringify(m.meta) }))).toEqual(messagesBefore);
    expect(mem.messages.find((m) => m.id === out.reply.id)?.meta.render_run_id).toBe(run_id);
  });
});

describe("Try again", () => {
  async function failedDraft() {
    const s = setup();
    const out = await say(s.deps);
    const run_id = (out.render as { run_id: string }).run_id;
    await s.mem.store.insertMessage({
      thread_id: out.thread_id,
      sender_role: "assistant",
      body: "Sorry, the video took too long to generate. You were not charged for it.",
      meta: { artifact_delivery: true, source_run_id: run_id, kind: "generative_video_failed" },
    });
    return { ...s, out, run_id };
  }

  it("two Try again clicks racing on one failed video buy one new video, not two", async () => {
    const { deps, send, out } = await failedDraft();
    const results = await Promise.allSettled([
      retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id }),
      retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(StudioError);
    expect(lost.reason.status).toBe(409);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a Try again that loses the race leaves no run behind: every run row is the one a rendering message points at", async () => {
    const { deps, out, mem, run_id } = await failedDraft();
    const results = await Promise.allSettled([
      retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id }),
      retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id }),
      retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id }),
    ]);
    const won = results.filter((r): r is PromiseFulfilledResult<{ run_id: string; thread_id: string; rendering_message: StudioMessageRow }> => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    expect(mem.runs).toEqual([run_id, won[0].value.run_id]);
    const rendered = mem.messages.filter((m) => m.meta.kind === "video_studio_rendering").map((m) => m.agent_run_id);
    expect([...mem.runs].sort()).toEqual([...rendered].sort());
    expect(mem.messages.find((m) => m.id === out.reply.id)?.meta.render_run_id).toBe(won[0].value.run_id);
  });

  it("a run that cannot be recorded hands the video back, so Try again still works and nothing was queued", async () => {
    const { deps, out, mem, send, run_id } = await failedDraft();
    const real = mem.store.createRenderRun.bind(mem.store);
    mem.store.createRenderRun = async () => {
      throw new Error("insert failed");
    };
    await expect(retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toThrow("insert failed");
    expect(mem.messages.find((m) => m.id === out.reply.id)?.meta.render_run_id).toBe(run_id);
    expect(send).toHaveBeenCalledTimes(1);
    mem.store.createRenderRun = real;
    const retry = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id });
    expect(mem.runs).toEqual([run_id, retry.run_id]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("refuses to re-make a video that is still rendering", async () => {
    const { deps, send } = setup();
    const out = await say(deps);
    await expect(retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 409 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses to re-make a video that already arrived", async () => {
    const { deps, send, out, run_id, mem } = await failedDraft();
    const retry = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id });
    mem.artifacts.push({ id: "art", run_id: retry.run_id, filename: "v.mp4" });
    await expect(retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 409 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(retry.run_id).not.toBe(run_id);
  });

  it("refuses a message from another user's chat", async () => {
    const { deps, send, out } = await failedDraft();
    await say(deps, "hi", OTHER_USER);
    await expect(retryStudioRender(deps, { tenant_id: TENANT, user_id: OTHER_USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 404 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("refuses a message that holds no video script", async () => {
    const { deps, mem, send } = await failedDraft();
    const userMsg = mem.messages.find((m) => m.sender_role === "user")!;
    await expect(retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: userMsg.id })).rejects.toMatchObject({ status: 404 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a render past the worker's maximum with no video and no failure post can be retried, and the new run names the run it replaces", async () => {
    let now = 0;
    const s = setup({ now: () => now });
    const createRun = vi.spyOn(s.mem.store, "createRenderRun");
    const out = await say(s.deps);
    const run_id = (out.render as { run_id: string }).run_id;
    const started = Date.parse((await s.mem.store.listMessages(out.thread_id, 200)).find((m) => m.agent_run_id === run_id)!.created_at);

    now = started + RENDER_STALL_MS - 1000;
    await expect(retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 409 });
    expect(s.send).toHaveBeenCalledTimes(1);

    now = started + RENDER_STALL_MS + 1000;
    const retry = await retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id });
    expect(retry.run_id).not.toBe(run_id);
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(createRun).toHaveBeenLastCalledWith(expect.objectContaining({ retry_of: run_id, message_id: out.reply.id }));
    expect(s.mem.messages.find((m) => m.id === out.reply.id)?.meta.render_run_id).toBe(retry.run_id);
  });

  it("a render past the worker's maximum whose video did arrive is not re-made", async () => {
    let now = 0;
    const s = setup({ now: () => now });
    const out = await say(s.deps);
    const run_id = (out.render as { run_id: string }).run_id;
    s.mem.artifacts.push({ id: "art", run_id, filename: "v.mp4" });
    now = Date.now() + RENDER_STALL_MS * 3;
    await expect(retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 409 });
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("an older video under 250 newer messages cannot be made again: still being made or done says so, and a failed one a newer draft replaced is superseded", async () => {
    const { deps, send, out, mem, run_id } = await failedDraft();
    const making = await say(deps, "a second ad for the serum");
    const makingRun = (making.render as { run_id: string }).run_id;
    const done = await say(deps, "a third ad for the serum");
    const doneRun = (done.render as { run_id: string }).run_id;
    mem.artifacts.push({ id: "art-done", run_id: doneRun, filename: "v.mp4" });
    for (let i = 0; i < 250; i++) {
      await mem.store.insertMessage({ thread_id: out.thread_id, sender_role: i % 2 ? "assistant" : "user", body: `later ${i}` });
    }
    const window = await mem.store.listMessages(out.thread_id, 200);
    expect(window.some((m) => m.agent_run_id === run_id || m.meta.source_run_id === run_id || m.agent_run_id === makingRun)).toBe(false);
    send.mockClear();

    await expect(retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: making.reply.id })).rejects.toMatchObject({ status: 409, code: "already_rendered" });
    await expect(retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: done.reply.id })).rejects.toMatchObject({ status: 409, code: "already_rendered" });
    expect(send).not.toHaveBeenCalled();

    await expect(retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 409, code: "superseded" });
    expect(send).not.toHaveBeenCalled();
    expect(mem.messages.find((m) => m.id === out.reply.id)?.meta.render_run_id).toBe(run_id);
  });

  it("Try again on a failed draft that a newer draft replaced is refused before anything is claimed, queued or charged", async () => {
    const { deps, send, out, mem, run_id } = await failedDraft();
    const newer = await say(deps, "make the hook punchier");
    const newerRun = (newer.render as { run_id: string }).run_id;
    expect(newer.thread_id).toBe(out.thread_id);
    const tier = vi.spyOn(deps, "tier");
    const afford = vi.fn(async (): Promise<AffordCheck> => "ok");
    deps.afford = afford;
    const claim = vi.spyOn(mem.store, "claimRender");
    const createRun = vi.spyOn(mem.store, "createRenderRun");
    const insert = vi.spyOn(mem.store, "insertMessage");
    send.mockClear();
    const runsBefore = [...mem.runs];

    const err = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id, thread_id: out.thread_id }).catch((e) => e);

    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ status: 409, code: "superseded", message: "A newer version of this ad exists. Nothing was made or charged." });
    expect(send).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(tier).not.toHaveBeenCalled();
    expect(afford).not.toHaveBeenCalled();
    expect(mem.runs).toEqual(runsBefore);
    expect(mem.messages.find((m) => m.id === out.reply.id)?.meta.render_run_id).toBe(run_id);
    expect(mem.messages.find((m) => m.id === newer.reply.id)?.meta.render_run_id).toBe(newerRun);
  });

  it("Try again on the thread's latest draft still makes the video after an older draft in the same thread", async () => {
    const { deps, send, out, mem } = await failedDraft();
    const newer = await say(deps, "make the hook punchier");
    const newerRun = (newer.render as { run_id: string }).run_id;
    await mem.store.insertMessage({
      thread_id: out.thread_id,
      sender_role: "assistant",
      body: "Sorry, the video took too long to generate. You were not charged for it.",
      meta: { artifact_delivery: true, source_run_id: newerRun, kind: "generative_video_failed" },
    });
    send.mockClear();

    const retry = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: newer.reply.id, thread_id: out.thread_id });

    expect(retry.run_id).not.toBe(newerRun);
    expect(send).toHaveBeenCalledTimes(1);
    expect(evt(send).data.run_id).toBe(retry.run_id);
    expect(mem.messages.find((m) => m.id === newer.reply.id)?.meta.render_run_id).toBe(retry.run_id);
  });

  it("Try again fails closed with a 503 when the latest-draft read fails, and nothing is claimed, queued or charged", async () => {
    const { deps, send, out, mem, run_id } = await failedDraft();
    const real = mem.store.listMessages.bind(mem.store);
    mem.store.listMessages = vi.fn(async () => {
      throw new Error("messages read timed out");
    });
    const tier = vi.spyOn(deps, "tier");
    const claim = vi.spyOn(mem.store, "claimRender");
    const createRun = vi.spyOn(mem.store, "createRenderRun");
    send.mockClear();

    const err = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id }).catch((e) => e);

    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ status: 503, code: "render_check_unavailable", message: "Zavi could not check this video just now. Try again in a minute." });
    expect(mem.store.listMessages).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(tier).not.toHaveBeenCalled();
    expect(mem.runs).toEqual([run_id]);
    mem.store.listMessages = real;
  });

  it("re-checks the plan, so a downgrade after a failure cannot buy another video", async () => {
    let allowed = true;
    const s = setup({ tier: async () => ({ allowed, required_tier: "starter" }) });
    const out = await say(s.deps);
    const run_id = (out.render as { run_id: string }).run_id;
    await s.mem.store.insertMessage({ thread_id: out.thread_id, sender_role: "assistant", body: "failed", meta: { source_run_id: run_id, kind: "generative_video_failed" } });
    allowed = false;
    await expect(retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 403 });
    expect(s.send).toHaveBeenCalledTimes(1);
  });
});

describe("readStudio", () => {
  it("moves renders to done when the video lands and to failed on the worker's failure post", async () => {
    const { deps, mem } = setup();
    const a = await say(deps);
    const b = await say(deps, "another one");
    const r1 = (a.render as { run_id: string }).run_id;
    const r2 = (b.render as { run_id: string }).run_id;
    let view = await readStudio(mem.store, USER);
    expect(view.renders[r1].status).toBe("rendering");
    mem.artifacts.push({ id: "art-1", run_id: r1, filename: "video.mp4" });
    await mem.store.insertMessage({
      thread_id: a.thread_id,
      sender_role: "assistant",
      body: "Sorry, the video generation didn't complete.",
      meta: { artifact_delivery: true, source_run_id: r2, kind: "generative_video_failed" },
    });
    view = await readStudio(mem.store, USER);
    expect(view.renders[r1]).toMatchObject({ status: "done", videos: [{ artifact_id: "art-1", filename: "video.mp4" }] });
    expect(view.renders[r2].status).toBe("failed");
    expect(view.messages.find((m) => m.id === a.reply.id)?.render_run_id).toBe(r1);
    expect(view.messages.map((m) => m.created_at)).toEqual([...view.messages.map((m) => m.created_at)].sort());
  });

  it("calls a render with no outcome after the stall window stalled; a late video still lands as done", async () => {
    const { deps, mem } = setup();
    const out = await say(deps);
    const run_id = (out.render as { run_id: string }).run_id;
    const rows = await mem.store.listMessages(out.thread_id, 200);
    const started = Date.parse(rows.find((m) => m.agent_run_id === run_id)!.created_at);
    expect(buildStudioView(out.thread_id, rows, [], started + RENDER_STALL_MS - 1000).renders[run_id].status).toBe("rendering");
    expect(buildStudioView(out.thread_id, rows, [], started + RENDER_STALL_MS + 1000).renders[run_id].status).toBe("stalled");
    expect(buildStudioView(out.thread_id, rows, [{ id: "a", run_id, filename: "v.mp4" }], started + RENDER_STALL_MS * 3).renders[run_id].status).toBe("done");
  });

  it("a render no worker has started yet is queued with no work time; once a job row exists it counts from that row", async () => {
    const { deps, mem } = setup();
    const out = await say(deps);
    const run_id = (out.render as { run_id: string }).run_id;
    const rows = await mem.store.listMessages(out.thread_id, 200);
    const started = Date.parse(rows.find((m) => m.agent_run_id === run_id)!.created_at);
    const waiting = buildStudioView(out.thread_id, rows, [], started + 6 * 60_000, []).renders[run_id];
    expect(waiting).toMatchObject({ status: "rendering", queued: true });
    expect(waiting.working_since).toBeUndefined();
    const at = new Date(started + 6 * 60_000).toISOString();
    const later = new Date(started + 7 * 60_000).toISOString();
    const working = buildStudioView(out.thread_id, rows, [], started + 8 * 60_000, [{ run_id, created_at: later }, { run_id, created_at: at }, { run_id: "other-run", created_at: new Date(started).toISOString() }]).renders[run_id];
    expect(working.queued).toBeUndefined();
    expect(working.working_since).toBe(at);
    expect(buildStudioView(out.thread_id, rows, [], started + 6 * 60_000).renders[run_id].queued).toBeUndefined();
  });

  it("a render waiting behind others is queued, not stalled, and its stall clock starts when its job starts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let now = Date.now();
      const s = setup({ now: () => now });
      const out = await say(s.deps);
      const run_id = (out.render as { run_id: string }).run_id;
      const created = Date.parse((await s.mem.store.listMessages(out.thread_id, 200)).find((m) => m.agent_run_id === run_id)!.created_at);
      let jobAt: number | null = null;
      s.mem.store.listStartedRuns = async (ids) => (jobAt === null ? [] : ids.filter((i) => i === run_id).map((i) => ({ run_id: i, created_at: new Date(jobAt!).toISOString() })));
      const at = async (t: number) => {
        now = t;
        vi.setSystemTime(t);
        return (await readStudio(s.mem.store, USER)).renders[run_id];
      };

      expect(RENDER_QUEUE_MAX_MS).toBeGreaterThan(3 * RENDER_STALL_MS);
      expect(await at(created + 3 * RENDER_STALL_MS)).toMatchObject({ status: "rendering", queued: true });
      await expect(retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 409 });
      expect(s.send).toHaveBeenCalledTimes(1);

      jobAt = created + 4 * RENDER_STALL_MS - 60_000;
      const fresh = await at(created + 4 * RENDER_STALL_MS);
      expect(fresh).toMatchObject({ status: "rendering", working_since: new Date(jobAt).toISOString() });
      expect(fresh.queued).toBeUndefined();
      await expect(retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id })).rejects.toMatchObject({ status: 409 });
      expect(s.send).toHaveBeenCalledTimes(1);

      expect((await at(jobAt + RENDER_STALL_MS - 1000)).status).toBe("rendering");
      expect((await at(jobAt + RENDER_STALL_MS + 1000)).status).toBe("stalled");

      jobAt = null;
      expect(await at(created + RENDER_QUEUE_MAX_MS - 1000)).toMatchObject({ status: "rendering", queued: true });
      const dead = await at(created + RENDER_QUEUE_MAX_MS + 1000);
      expect(dead.status).toBe("stalled");
      expect(dead.queued).toBeUndefined();
      const retry = await retryStudioRender(s.deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id });
      expect(retry.run_id).not.toBe(run_id);
      expect(s.send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opening the tab creates no thread until the first message", async () => {
    const { mem } = setup();
    expect(await readStudio(mem.store, USER)).toEqual({ thread_id: null, messages: [], renders: {} });
    expect(mem.threads).toHaveLength(0);
  });
});

describe("an attached image becomes the first frame", () => {
  const IMAGE = `${TENANT}/4c1e.jpg`;
  const show = (deps: StudioDeps, text: string, image_path: string | null = IMAGE) =>
    sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text, image_path });

  it("an image with no text animates it without a model call, on video.animate's intake, and the chat shows the image", async () => {
    const checkImage = vi.fn(async () => undefined);
    const { deps, complete, send, mem } = setup({ checkImage });
    const out = await show(deps, "");
    expect(checkImage).toHaveBeenCalledWith(TENANT, IMAGE);
    expect(complete).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(evt(send).data.intake).toEqual({ prompt: DEFAULT_ANIMATE_PROMPT, intent: "animate", premium: false, image_path: IMAGE });
    expect(out.reply.meta).toMatchObject({ kind: "video_studio_draft", video_draft: { intent: "animate", aspect_ratio: "auto", image_path: IMAGE } });
    expect(mem.messages.find((m) => m.id === out.user_message.id)?.attachments).toEqual([{ path: IMAGE, kind: "image" }]);
    const view = await readStudio(mem.store, USER);
    expect(view.messages.find((m) => m.id === out.user_message.id)?.image_path).toBe(IMAGE);
  });

  it("text with the image becomes the motion prompt", async () => {
    const { deps, send } = setup({ checkImage: async () => undefined });
    await show(deps, "slow zoom in while steam rises from the cup");
    expect(evt(send).data.intake).toMatchObject({ intent: "animate", prompt: "slow zoom in while steam rises from the cup", image_path: IMAGE });
  });

  it("an image from another workspace is refused before anything is written, drafted or queued", async () => {
    const checkImage = vi.fn(async () => {
      throw new ExpectedToolError("image_not_owned", "That image is not in this workspace.");
    });
    const { deps, complete, send, mem } = setup({ checkImage });
    const err = await show(deps, "", "99999999-9999-4999-8999-999999999999/x.jpg").catch((e) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ status: 400, code: "image_not_owned" });
    expect(mem.threads).toHaveLength(0);
    expect(mem.messages).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "99999999-9999-4999-8999-999999999999/woman.jpg",
    `99999999-9999-4999-8999-999999999999/${TENANT}/woman.jpg`,
    `${TENANT}/../99999999-9999-4999-8999-999999999999/woman.jpg`,
  ])("the real ownership check refuses %s before the photo is looked at, drafted or rendered", async (foreign) => {
    const lookAtPhoto = vi.fn(async () => ({ has_person: true, gender: "female" as const }));
    const { deps, complete, send, mem } = setup({ lookAtPhoto });
    expect(deps.checkImage).toBeUndefined();
    const err = await show(deps, "a presenter video about our gym", foreign).catch((e) => e);
    expect(err).toMatchObject({ status: 400, code: "image_not_owned" });
    expect(lookAtPhoto).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mem.messages).toHaveLength(0);
  });

  it("a follow-up without an image re-animates the same picture with the change, and asking for a presenter goes back to scripts", async () => {
    const { deps, complete, send } = setup({ checkImage: async () => undefined });
    await show(deps, "steam rises from the cup");
    await show(deps, "make the camera move left", null);
    expect(complete).not.toHaveBeenCalled();
    expect(evt(send, 1).data.intake).toMatchObject({ intent: "animate", image_path: IMAGE, prompt: "steam rises from the cup\nChange: make the camera move left" });
    await show(deps, "now a presenter video about our cafe", null);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][1]).not.toContain("<current_draft>");
    expect(evt(send, 2).data.intake).toMatchObject({ intent: "talking_head" });
  });

  it.each(["make a cinematic gym ad", "a new video for our summer sale", "another promo, a quick social reel for the bakery"])(
    "after an animation, %s is a new video, not a motion change to the old photo",
    async (ask) => {
      const { deps, complete, send } = setup({ checkImage: async () => undefined });
      await show(deps, "steam rises from the cup");
      await show(deps, ask, null);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0][1]).not.toContain("<current_draft>");
      expect(evt(send, 1).data.intake).not.toMatchObject({ intent: "animate" });
      expect(evt(send, 1).data.intake).not.toHaveProperty("image_path", IMAGE);
    },
  );

  it("a new video after an animation still sees the founder's offer from the animation message", async () => {
    const { deps, complete } = setup({ checkImage: async () => undefined });
    await show(deps, "steam rises from the cup, 20% off lattes this week");
    await show(deps, "make a cinematic cafe ad", null);
    expect(complete.mock.calls[0][1]).toMatch(/<earlier_requests>[^]*20% off lattes this week[^]*<\/earlier_requests>/);
  });

  it.each([
    "make it shorter",
    "slow zoom in",
    "make it more cinematic",
    "make the steam rise faster in the video",
    "turn it into a slow cinematic reel",
    "make it a cinematic clip",
    "make the new video slower",
  ])(
    "after an animation, %s still changes the motion of the same photo",
    async (ask) => {
      const { deps, complete, send } = setup({ checkImage: async () => undefined });
      await show(deps, "steam rises from the cup");
      await show(deps, ask, null);
      expect(complete).not.toHaveBeenCalled();
      expect(evt(send, 1).data.intake).toMatchObject({ intent: "animate", image_path: IMAGE });
    },
  );

  it("an image whose prompt makes someone speak as a customer is refused and makes no video", async () => {
    const { deps, send, mem } = setup({ checkImage: async () => undefined });
    const out = await show(deps, "she says I've been using this serum for a month");
    expect(out.render).toBeNull();
    expect(out.reply.body).toBe(ANIMATE_CUSTOMER_VOICE_REFUSAL);
    expect(send).not.toHaveBeenCalled();
    expect(mem.runs).toHaveLength(0);
  });

  it("neither text nor an image is refused", async () => {
    const { deps } = setup();
    await expect(show(deps, "   ", null)).rejects.toMatchObject({ status: 400, code: "empty_message" });
  });
});

describe("several chats", () => {
  const send = (deps: StudioDeps, text: string, extra: { thread_id?: string; new_thread?: boolean } = {}, user_id = USER) =>
    sendStudioMessage(deps, { tenant_id: TENANT, user_id, text, ...extra });

  it("New chat starts a second thread; the tab opens on the newest, an older chat still reads its own messages, and each is titled by its first message", async () => {
    const { deps, mem } = setup();
    const first = await send(deps, "ugc ad for our serum");
    const second = await send(deps, "a video about our summer camp", { new_thread: true });
    expect(second.thread_id).not.toBe(first.thread_id);
    expect(mem.threads).toHaveLength(2);
    expect((await readStudio(mem.store, USER)).thread_id).toBe(second.thread_id);
    const old = await readStudio(mem.store, USER, first.thread_id);
    expect(old.messages.map((m) => m.body)).toContain("ugc ad for our serum");
    expect(old.messages.map((m) => m.body)).not.toContain("a video about our summer camp");
    expect((await listStudioThreads(mem.store, USER)).map((t) => t.title)).toEqual(["a video about our summer camp", "ugc ad for our serum"]);
  });

  it("a follow-up in an older chat revises that chat's script, not the newest one's", async () => {
    const { deps, complete } = setup();
    const first = await send(deps, "ugc ad for our serum");
    await send(deps, "a video about our summer camp", { new_thread: true });
    complete.mockClear();
    await send(deps, "make it shorter", { thread_id: first.thread_id });
    expect(complete.mock.calls[0][1]).toContain("layers under makeup");
  });

  it("another user's chat can be neither read, written nor retried", async () => {
    const { deps, mem, send: queued } = setup();
    const theirs = await send(deps, "their video", {}, OTHER_USER);
    const before = mem.messages.length;
    await expect(send(deps, "hijack", { thread_id: theirs.thread_id })).rejects.toMatchObject({ status: 404, code: "thread_not_found" });
    await expect(readStudio(mem.store, USER, theirs.thread_id)).rejects.toMatchObject({ code: "thread_not_found" });
    await expect(
      retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: theirs.reply.id, thread_id: theirs.thread_id }),
    ).rejects.toMatchObject({ code: "thread_not_found" });
    expect(mem.messages.length).toBe(before);
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it("an image-only first message titles the chat Animated image", async () => {
    const { deps, mem } = setup({ checkImage: async () => undefined });
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "", image_path: `${TENANT}/a.jpg` });
    expect((await listStudioThreads(mem.store, USER))[0].title).toBe("Animated image");
  });
});

describe("the video gallery", () => {
  it("lists every AI UGC video in the workspace newest first, marks chat or card, and links only your own chats", async () => {
    const { mem } = setup();
    mem.videoRuns.push(
      { id: "run-mine", created_at: "2026-10-15T10:00:00Z", enqueued_by: USER, studio_thread_id: "th-mine" },
      { id: "run-theirs", created_at: "2026-10-15T09:00:00Z", enqueued_by: OTHER_USER, studio_thread_id: "th-theirs" },
      { id: "run-card", created_at: "2026-10-14T09:00:00Z", enqueued_by: null, studio_thread_id: null },
    );
    mem.galleryArtifacts.push(
      { id: "a-card-1", run_id: "run-card", filename: "hook.mp4", created_at: "2026-10-14T09:05:00Z" },
      { id: "a-mine", run_id: "run-mine", filename: "video.mp4", created_at: "2026-10-15T10:05:00Z" },
      { id: "a-theirs", run_id: "run-theirs", filename: "video.mp4", created_at: "2026-10-15T09:05:00Z" },
      { id: "a-stray", run_id: "run-unknown", filename: "x.mp4", created_at: "2026-10-16T00:00:00Z" },
    );
    const { videos } = await readGallery(mem.store, USER);
    expect(videos.map((v) => [v.artifact_id, v.source, v.thread_id])).toEqual([
      ["a-mine", "chat", "th-mine"],
      ["a-theirs", "chat", null],
      ["a-card-1", "card", null],
    ]);
  });

  it("sends each video's kind so the Library can label a presenter ad apart from an animated image", async () => {
    const { mem } = setup();
    mem.videoRuns.push(
      { id: "run-presenter", created_at: "2026-10-15T10:00:00Z", enqueued_by: USER, studio_thread_id: "th", intent: "talking_head" },
      { id: "run-animate", created_at: "2026-10-15T09:00:00Z", enqueued_by: USER, studio_thread_id: "th", intent: "animate" },
      { id: "run-old", created_at: "2026-10-14T09:00:00Z", enqueued_by: null, studio_thread_id: null },
    );
    mem.galleryArtifacts.push(
      { id: "a-presenter", run_id: "run-presenter", filename: "p.mp4", created_at: "2026-10-15T10:05:00Z" },
      { id: "a-animate", run_id: "run-animate", filename: "a.mp4", created_at: "2026-10-15T09:05:00Z" },
      { id: "a-old", run_id: "run-old", filename: "o.mp4", created_at: "2026-10-14T09:05:00Z" },
    );
    const { videos } = await readGallery(mem.store, USER);
    expect(videos.map((v) => [v.artifact_id, v.intent])).toEqual([
      ["a-presenter", "talking_head"],
      ["a-animate", "animate"],
      ["a-old", null],
    ]);
  });

  it("an empty workspace reads no files at all", async () => {
    const { mem } = setup();
    const spy = vi.spyOn(mem.store, "listGalleryArtifacts");
    expect(await readGallery(mem.store, USER)).toEqual({ videos: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("a photo of a person becomes the presenter", () => {
  const PHOTO = `${TENANT}/woman.jpg`;
  const show = (deps: StudioDeps, text: string, image_path: string | null = PHOTO) =>
    sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text, image_path });
  const lookPerson = vi.fn(async () => ({ has_person: true, gender: "female" as const }));

  it("a person in the photo makes a presenter video with that photo and a matching voice, never an animation the model refuses", async () => {
    const { deps, complete, send } = setup({ checkImage: async () => undefined, lookAtPhoto: lookPerson }, draftReply({ presenter_gender: "male" }));
    const out = await show(deps, "A 30 second presenter video explaining what we do");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][1]).toContain("person in the photo");
    expect(out.reply.meta).toMatchObject({ video_draft: { intent: "talking_head", image_path: PHOTO, presenter_gender: "female" } });
    expect(out.reply.body).toBe(PHOTO_PRESENTER_REPLY);
    const intake = evt(send).data.intake as Record<string, unknown>;
    expect(intake).toMatchObject({ intent: "talking_head", portrait_path: PHOTO, presenter_gender: "female", avatar_tier: "standard" });
    expect(intake.image_path).toBeUndefined();
  });

  it("a photo of a person with no words titles the chat Presenter video, not Animated image", async () => {
    const { mem, deps, send } = setup({ checkImage: async () => undefined, lookAtPhoto: lookPerson }, draftReply({ presenter_gender: "male" }));
    await show(deps, "");
    expect(evt(send).data.intake).toMatchObject({ intent: "talking_head", portrait_path: PHOTO });
    expect((await listStudioThreads(mem.store, USER))[0].title).toBe("Presenter video");
  });

  it("a photo with no person and no words still titles the chat Animated image", async () => {
    const { mem, deps } = setup({ checkImage: async () => undefined, lookAtPhoto: async () => ({ has_person: false, gender: null }) });
    await show(deps, "");
    expect((await listStudioThreads(mem.store, USER))[0].title).toBe("Animated image");
  });

  it("a photo with no person still animates, whatever the words say", async () => {
    const { deps, complete, send } = setup({ checkImage: async () => undefined, lookAtPhoto: async () => ({ has_person: false, gender: null }) });
    await show(deps, "a presenter video about this");
    expect(complete).not.toHaveBeenCalled();
    expect(evt(send).data.intake).toMatchObject({ intent: "animate", image_path: PHOTO });
  });

  it("when the photo cannot be looked at, presenter words decide", async () => {
    const { deps, send } = setup({ checkImage: async () => undefined, lookAtPhoto: async () => null });
    await show(deps, "a presenter video about our gym");
    expect(evt(send).data.intake).toMatchObject({ intent: "talking_head", portrait_path: PHOTO });
    await show(deps, "slow zoom in", PHOTO);
    expect(evt(send, 1).data.intake).toMatchObject({ intent: "animate" });
  });

  it("a follow-up keeps the founder's photo and voice gender", async () => {
    const { deps, send } = setup({ checkImage: async () => undefined, lookAtPhoto: lookPerson }, draftReply({ presenter_gender: "male" }));
    await show(deps, "a presenter video about us");
    await show(deps, "make it shorter", null);
    expect(evt(send, 1).data.intake).toMatchObject({ intent: "talking_head", portrait_path: PHOTO, presenter_gender: "female" });
  });

  it("Use a different presenter on a photo-presenter ad drops the photo, keeps the script, and never pays for the same person again", async () => {
    const { mem, deps, complete, send } = setup({ checkImage: async () => undefined, lookAtPhoto: lookPerson }, draftReply({ presenter_gender: "female" }));
    await show(deps, "a presenter video about us");
    expect(evt(send).data.intake).toMatchObject({ intent: "talking_head", portrait_path: PHOTO });
    complete.mockImplementation(async () => draftReply({ reply: "Here is a fresh take.", script: "A rewritten script the founder never asked for, about something else.", visual: "A man in his 40s in a workshop.", presenter_gender: "male" }));
    const out = await show(deps, "Use a different presenter", null);
    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls.slice(1)) expect(JSON.stringify(call[0])).not.toContain(PHOTO);
    const intake = evt(send, 1).data.intake as Record<string, unknown>;
    expect(intake.portrait_path).toBeUndefined();
    expect(intake.image_path).toBeUndefined();
    expect(intake).toMatchObject({ intent: "talking_head", script: SCRIPT, presenter_gender: "male" });
    expect(out.reply.body).not.toBe(PHOTO_PRESENTER_REPLY);
    expect(out.reply.body).toBe(DIFFERENT_PRESENTER_REPLY);
    expect(mem.messages.find((m) => m.id === out.reply.id)?.meta.video_draft).toMatchObject({ image_path: null, script: SCRIPT, hook: DRAFT.hook });
  });

  it("Make it shorter on the same photo-presenter ad still keeps the photo", async () => {
    const { deps, complete, send } = setup({ checkImage: async () => undefined, lookAtPhoto: lookPerson }, draftReply({ presenter_gender: "female" }));
    await show(deps, "a presenter video about us");
    complete.mockImplementation(async () => draftReply({ script: "Meet the serum. Short and sweet for busy mornings.", presenter_gender: "male" }));
    const out = await show(deps, "Make it shorter", null);
    expect(evt(send, 1).data.intake).toMatchObject({ intent: "talking_head", portrait_path: PHOTO, presenter_gender: "female" });
    expect(out.reply.body).toBe(PHOTO_PRESENTER_REPLY);
  });

  it("after a refused animation of the photo, asking for a presenter uses that same photo", async () => {
    const { deps, send } = setup({ checkImage: async () => undefined, lookAtPhoto: async () => ({ has_person: false, gender: null }) });
    await show(deps, "make it move");
    deps.lookAtPhoto = lookPerson;
    await show(deps, "use her as the presenter for our business", null);
    expect(evt(send, 1).data.intake).toMatchObject({ intent: "talking_head", portrait_path: PHOTO, presenter_gender: "female" });
  });

  it("if the model will not write a presenter script for the photo, nothing is rendered", async () => {
    const { deps, send } = setup(
      { checkImage: async () => undefined, lookAtPhoto: lookPerson },
      draftReply({ intent: "cinematic", script: null, hook: null, presenter_gender: null }),
    );
    const out = await show(deps, "a video about us");
    expect(out.render).toBeNull();
    expect(out.reply.body).toBe(DRAFT_FAILED_REPLY);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("review fixes", () => {
  const IMG = `${TENANT}/product.jpg`;
  const FACE = `${TENANT}/face.jpg`;

  it("a new presenter photo after an animation uses the new photo, never re-animates the old one", async () => {
    const { deps, send } = setup({
      checkImage: async () => undefined,
      lookAtPhoto: async (_t: string, p: string) => (p === FACE ? { has_person: true, gender: "female" as const } : { has_person: false, gender: null }),
    });
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "steam rises", image_path: IMG });
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "", image_path: FACE });
    const second = evt(send, 1).data.intake as Record<string, unknown>;
    expect(second).toMatchObject({ intent: "talking_head", portrait_path: FACE });
    expect(second.image_path).toBeUndefined();
  });

  it("a long motion history still sends the newest change to the vendor", async () => {
    const { deps, send } = setup({ checkImage: async () => undefined, lookAtPhoto: async () => ({ has_person: false, gender: null }) });
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "x".repeat(1490), image_path: IMG });
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "move the camera left" });
    const prompt = (evt(send, 1).data.intake as { prompt: string }).prompt;
    expect(prompt.endsWith("Change: move the camera left")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(1500);
  });
});

describe("pass-3 studio fixes", () => {
  it("an unconfirmed plan check refuses before any model call", async () => {
    const { deps, complete } = setup({ tier: async () => ({ allowed: true, required_tier: "starter", unverified: true }) });
    await expect(say(deps)).rejects.toMatchObject({ status: 503 });
    expect(complete).not.toHaveBeenCalled();
  });

  it("an animation framed as a customer testimonial is refused", async () => {
    const { deps, send } = setup({ checkImage: async () => undefined, lookAtPhoto: async () => ({ has_person: false, gender: null }) });
    const out = await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "turn this into a glowing customer testimonial for the product", image_path: `${TENANT}/a.jpg` });
    expect(out.render).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("after a photo presenter, asking for a cinematic shot makes the cinematic shot without the photo", async () => {
    const { deps, send, complete } = setup({ checkImage: async () => undefined, lookAtPhoto: async () => ({ has_person: true, gender: "female" as const }) });
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "a presenter video", image_path: `${TENANT}/face.jpg` });
    complete.mockResolvedValueOnce(draftReply({ intent: "cinematic", script: null, hook: null, presenter_gender: null, visual: "mountains at dawn" }));
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "make it a cinematic mountain shot with no presenter" });
    const intake = evt(send, 1).data.intake as Record<string, unknown>;
    expect(intake.intent).toBe("cinematic");
    expect(intake.portrait_path).toBeUndefined();
  });
});

describe("two identical sends at once start one paid render", () => {
  function gated(reply: string = draftReply()) {
    const waiting: Array<() => void> = [];
    const complete = vi.fn(async (_s: string, _u: string) => {
      await new Promise<void>((r) => waiting.push(r));
      return reply;
    });
    const open = async () => {
      while (waiting.length === 0) await new Promise((r) => setTimeout(r, 1));
      waiting.splice(0).forEach((r) => r());
    };
    const drive = async <T,>(p: Promise<T>): Promise<T> => {
      let done = false;
      const settled = p.finally(() => {
        done = true;
      });
      while (!done) {
        waiting.splice(0).forEach((r) => r());
        await new Promise((r) => setTimeout(r, 1));
      }
      return settled;
    };
    return { complete, open, drive, waiting };
  }

  function guarded(over: Partial<StudioDeps> = {}, reply?: string) {
    const g = gated(reply);
    const s = setup({ draft: { complete: g.complete }, ...over });
    const claims = memorySendClaims(() => (s.deps.now ?? Date.now)());
    s.mem.store.sendClaims = claims.claims;
    return { ...s, ...g, claims };
  }

  it("two tabs sending the same text to the same chat while the first is still drafting make one model call, one render, and both get the first send's answer", async () => {
    const { deps, complete, send, mem, open } = guarded();
    const first = say(deps, "first message");
    await open();
    await first;
    const thread_id = mem.threads[0].id;
    complete.mockClear();
    send.mockClear();
    const a = sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "ugc ad for our serum", thread_id });
    const b = sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "ugc ad for our serum", thread_id });
    await open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mem.runs).toHaveLength(2);
    expect(rb).toEqual(ra);
    expect(mem.messages.filter((m) => m.sender_role === "user" && m.body === "ugc ad for our serum")).toHaveLength(1);
  });

  it("two API calls at once on the latest chat with no thread id buy one video, not two", async () => {
    const { deps, complete, send, mem, open } = guarded();
    const a = say(deps);
    const b = say(deps);
    await open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mem.runs).toHaveLength(1);
    expect(mem.threads).toHaveLength(1);
    expect(rb.thread_id).toBe(ra.thread_id);
    expect((rb.render as { run_id: string }).run_id).toBe((ra.render as { run_id: string }).run_id);
  });

  it("two tabs pressing Make video in a fresh chat create one chat and one render", async () => {
    const { deps, complete, send, mem, open } = guarded();
    const fresh = () => sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "ugc ad for our serum", new_thread: true });
    const a = fresh();
    const b = fresh();
    await open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(mem.threads).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rb.thread_id).toBe(ra.thread_id);
  });

  it("a duplicate that lands just after the first finished gets its answer back instead of a second render", async () => {
    const { deps, complete, send, open } = guarded();
    const a = say(deps);
    await open();
    const ra = await a;
    const rb = await say(deps);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rb).toEqual(ra);
  });

  it("two different messages at once both get made", async () => {
    const { deps, complete, send, mem, drive } = guarded();
    await drive(say(deps, "first chat opener"));
    complete.mockClear();
    send.mockClear();
    const thread_id = mem.threads[0].id;
    const a = sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "use a male presenter", thread_id });
    const b = sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "make it 16:9", thread_id });
    await drive(Promise.all([a, b]));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("the same text sent again on purpose later, after the first video started, makes a new video", async () => {
    let clock = Date.now();
    const { deps, complete, send, open } = guarded({ now: () => clock });
    const a = say(deps);
    await open();
    await a;
    clock += 5 * 60_000;
    const b = say(deps);
    await open();
    await b;
    expect(complete).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a settle write that fails once is retried, so the next identical send is not blocked as a phantom duplicate", async () => {
    const { deps, mem, open, claims } = guarded();
    const settle = claims.claims.settle.bind(claims.claims);
    let fails = 1;
    claims.claims.settle = async (...args) => {
      if (fails-- > 0) throw new Error("connection reset");
      return settle(...args);
    };
    const first = say(deps);
    await open();
    await first;
    const states = [...claims.rows.values()].map((r) => r.status);
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((st) => st === "done")).toBe(true);
    expect(mem.runs.length).toBeGreaterThan(0);
  });

  it("resending the same text right after Zavi could not draft it tries again instead of replaying the failure", async () => {
    const { deps, complete, send, drive } = guarded({}, "not json");
    expect((await drive(say(deps))).reply.body).toBe(DRAFT_FAILED_REPLY);
    const firstCalls = complete.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);
    expect((await drive(say(deps))).reply.body).toBe(DRAFT_FAILED_REPLY);
    expect(complete.mock.calls.length).toBe(2 * firstCalls);
    expect(send).not.toHaveBeenCalled();
  });

  it("a first send that crashes frees the message, so the waiting duplicate makes the one video instead of failing", async () => {
    const { deps, complete, send, mem, open } = guarded();
    let crashes = 1;
    const find = mem.store.findThread;
    mem.store.findThread = async (u) => {
      if (crashes-- > 0) throw new Error("db blip");
      return find(u);
    };
    const a = say(deps);
    const b = say(deps);
    await expect(a).rejects.toThrow("db blip");
    await open();
    const rb = await b;
    expect(rb.render && "run_id" in rb.render).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a duplicate still waiting when its wait runs out gets a clear 409 and spends nothing", async () => {
    const { deps, complete, send, open } = guarded({ sendWaitMs: 300 });
    const a = say(deps);
    const b = say(deps);
    await expect(b).rejects.toMatchObject({ status: 409, code: "duplicate_send" });
    await open();
    await a;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a claim left by a request that died long ago is taken over once, by one of two racing sends", async () => {
    let clock = Date.now();
    const { deps, complete, send, claims, open } = guarded({ now: () => clock });
    const { sendKey } = await import("../studio");
    const key = sendKey({ text: "ugc ad for our serum", image_path: null });
    await claims.claims.claim(USER, key);
    clock += 11 * 60_000;
    const a = say(deps);
    const b = say(deps);
    await open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rb).toEqual(ra);
  });

  it("an unreadable claim store refuses before any model call or render", async () => {
    const { deps, complete, send, mem } = guarded();
    mem.store.sendClaims = { ...mem.store.sendClaims!, claim: async () => { throw new Error("db down"); } };
    await expect(say(deps)).rejects.toMatchObject({ status: 503, code: "send_guard_unavailable" });
    expect(complete).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("a word-for-word script", () => {
  const OWN = "Our gym opens at five every morning. Come in this week and your first class is free.";
  const speak = (deps: StudioDeps, text: string, over: Partial<Parameters<typeof sendStudioMessage>[1]> = {}) =>
    sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text, verbatim: true, ...over });

  it("renders the founder's exact words as a presenter video even when the model rewrites them into a scene", async () => {
    const { deps, complete, send, mem } = setup({}, draftReply({ intent: "cinematic", script: "Something else entirely, rewritten by the model to sound punchier." }));
    const out = await speak(deps, `  ${OWN}  `);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][1]).toContain(VERBATIM_SCRIPT_HINT);
    expect(send).toHaveBeenCalledTimes(1);
    expect(evt(send).data.intake).toMatchObject({ intent: "talking_head", script: OWN, hook: "Our gym opens at five every morning.", aspect_ratio: "9:16" });
    expect(out.reply.body).toBe(VERBATIM_REPLY);
    expect(mem.messages.find((m) => m.id === out.reply.id)?.meta.video_draft).toMatchObject({ intent: "talking_head", script: OWN });
  });

  it.each([
    ["too short", "Come in today."],
    ["too long", Array.from({ length: 151 }, (_, i) => `word${i}`).join(" ")],
  ])("a script %s is refused before any model call, message or render", async (_label, text) => {
    const { deps, complete, send, mem } = setup();
    await expect(speak(deps, text)).rejects.toMatchObject({ status: 400, code: "script_length" });
    expect(complete).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mem.messages).toHaveLength(0);
  });

  it("the same length rule does not apply when Zavi writes the script", async () => {
    const { deps, send } = setup();
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "Come in today." });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a script that speaks as a customer is refused in the chat and makes no video, even when the model's own draft was clean", async () => {
    const { deps, send, mem } = setup();
    const out = await speak(deps, "I've been using this serum for three weeks and my skin has never looked better.");
    expect(out.reply.meta).toMatchObject({ kind: "video_studio_refused", code: "customer_voice" });
    expect(out.render).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(mem.runs).toHaveLength(0);
    expect(mem.messages.some((m) => m.meta.kind === "video_studio_draft")).toBe(false);
  });

  it("after an animation, a script is spoken by a presenter instead of re-animating the picture", async () => {
    const IMAGE = `${TENANT}/4c1e.jpg`;
    const { deps, complete, send } = setup({ checkImage: async () => undefined });
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "steam rises from the cup", image_path: IMAGE });
    await speak(deps, OWN);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(evt(send, 1).data.intake).toMatchObject({ intent: "talking_head", script: OWN });
  });

  it("an attached image is animated, never read out as a script", async () => {
    const IMAGE = `${TENANT}/4c1e.jpg`;
    const { deps, complete, send } = setup({ checkImage: async () => undefined });
    await speak(deps, "slow zoom", { image_path: IMAGE });
    expect(complete).not.toHaveBeenCalled();
    expect(evt(send).data.intake).toMatchObject({ intent: "animate", prompt: "slow zoom" });
  });

  it("Use a different presenter on a word-for-word ad keeps the founder's exact words even when the model rewrites them", async () => {
    const { deps, complete, send, mem } = setup();
    await speak(deps, OWN);
    complete.mockImplementation(async () => draftReply({ script: "A punchier rewrite the founder did not write, with new claims.", hook: "A punchier rewrite.", presenter_gender: "male", visual: "A man in a gym." }));
    const out = await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "Use a different presenter", verbatim: false });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(evt(send, 1).data.intake).toMatchObject({ intent: "talking_head", script: OWN, hook: "Our gym opens at five every morning.", presenter_gender: "male" });
    expect(mem.messages.find((m) => m.id === out.reply.id)?.meta.video_draft).toMatchObject({ script: OWN, hook: "Our gym opens at five every morning." });
  });

  it("sending the same words as a script right after sending them as an idea makes a second video, not a replay of the first", async () => {
    const s = setup();
    const claims = memorySendClaims(() => Date.now());
    s.mem.store.sendClaims = claims.claims;
    const idea = await sendStudioMessage(s.deps, { tenant_id: TENANT, user_id: USER, text: OWN });
    const script = await speak(s.deps, OWN);
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(script.reply.id).not.toBe(idea.reply.id);
    expect(evt(s.send, 1).data.intake).toMatchObject({ script: OWN });
  });
});

describe("the script writer", () => {
  const write = (deps: StudioDeps, prompt = "a promo for our gym's free first class") => writeStudioScript(deps, { tenant_id: TENANT, prompt });

  it("returns the model's presenter script and makes, writes and charges nothing", async () => {
    const { deps, complete, send, mem } = setup();
    expect(await write(deps)).toEqual({ script: SCRIPT });
    expect(complete.mock.calls[0][1]).toContain(SCRIPT_WRITER_HINT);
    expect(complete.mock.calls[0][1]).toContain("free first class");
    expect(send).not.toHaveBeenCalled();
    expect(mem.threads).toHaveLength(0);
    expect(mem.messages).toHaveLength(0);
    expect(mem.runs).toHaveLength(0);
  });

  it("a scene with nothing to say asks what the presenter should talk about", async () => {
    const { deps } = setup({}, draftReply({ intent: "cinematic", script: null, hook: null }));
    await expect(write(deps)).rejects.toMatchObject({ status: 422, code: "no_script", message: NO_SCRIPT_REPLY });
  });

  it("a testimonial is refused with the policy reply", async () => {
    const { deps } = setup();
    await expect(write(deps, "a testimonial from a happy customer about our serum")).rejects.toMatchObject({ status: 422, code: "refused_testimonial" });
  });

  it("a model outage says so instead of returning an empty script", async () => {
    const { deps } = setup({ draft: { complete: async () => { throw new Error("529 overloaded"); } } });
    await expect(write(deps)).rejects.toMatchObject({ status: 502, code: "script_failed", message: SCRIPT_FAILED_REPLY });
  });

  it("a plan without AI UGC Videos, no credits, or an empty prompt spend no model call", async () => {
    const noPlan = setup({ tier: async () => ({ allowed: false, required_tier: "starter" }) });
    await expect(write(noPlan.deps)).rejects.toMatchObject({ status: 403 });
    const broke = setup({ afford: async () => "short" as const });
    await expect(write(broke.deps)).rejects.toMatchObject({ status: 402 });
    const empty = setup();
    await expect(write(empty.deps, "   ")).rejects.toMatchObject({ status: 400, code: "empty_prompt" });
    expect(noPlan.complete).not.toHaveBeenCalled();
    expect(broke.complete).not.toHaveBeenCalled();
    expect(empty.complete).not.toHaveBeenCalled();
  });
});

describe("the wallet is checked against the real price of the video", () => {
  const IMAGE = `${TENANT}/4c1e.jpg`;
  const wallet = (start: number) => {
    const w = { credits: start, asked: [] as number[] };
    const afford = vi.fn(async (_t: string, usd: number): Promise<AffordCheck> => {
      w.asked.push(usd);
      return Math.round(usd / 0.0025) <= w.credits ? "ok" : "short";
    });
    return { w, afford };
  };
  const priceOf = async (d: VideoDraft) => {
    const i = draftToIntake(d);
    if (!i.ok) throw new Error(i.message);
    return billedVideoCredits(i.intake);
  };

  it("a presenter video costing hundreds of credits is refused for a wallet holding only the cheapest video, before anything is queued", async () => {
    const price = await priceOf(DRAFT);
    expect(price).toBeGreaterThan(400);
    const { w, afford } = wallet(Math.round((await cheapestStudioVideoUsd()) / 0.0025));
    const { deps, send, mem } = setup({ afford });
    const err = await say(deps).catch((e) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ status: 402, code: "insufficient_credits", extra: { required_credits: price } });
    expect(err.message).toContain(`${price.toLocaleString("en-US")} credits`);
    expect(w.asked.map((usd) => Math.round(usd / 0.0025))).toContain(price);
    expect(send).not.toHaveBeenCalled();
    expect(mem.runs).toHaveLength(0);
    expect(mem.messages.some((m) => typeof m.meta.render_run_id === "string")).toBe(false);
    expect(mem.messages.some((m) => m.meta.kind === "video_studio_rendering")).toBe(false);
  });

  it("an animated image at 1,510 credits is refused for a wallet that could afford a presenter video", async () => {
    const presenter = await priceOf(DRAFT);
    const { afford } = wallet(presenter + 100);
    const { deps, send, mem, complete } = setup({ afford, checkImage: async () => undefined });
    const err = await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "", image_path: IMAGE }).catch((e) => e);
    expect(err).toMatchObject({ status: 402, code: "insufficient_credits", extra: { required_credits: 1510 } });
    expect(complete).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mem.runs).toHaveLength(0);
  });

  it("a wallet holding exactly the price makes the video", async () => {
    const { afford } = wallet(await priceOf(DRAFT));
    const { deps, send, mem } = setup({ afford });
    const out = await say(deps);
    expect(out.render && "run_id" in out.render).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mem.runs).toHaveLength(1);
  });

  it("Try again on a failed video checks the wallet against the video's price and queues nothing when short", async () => {
    const price = await priceOf(DRAFT);
    const { w, afford } = wallet(price);
    const { deps, send, mem } = setup({ afford });
    const out = await say(deps);
    const run_id = (out.render as { run_id: string }).run_id;
    await mem.store.insertMessage({
      thread_id: out.thread_id,
      sender_role: "assistant",
      body: "Sorry, the video took too long to generate. You were not charged for it.",
      meta: { artifact_delivery: true, source_run_id: run_id, kind: "generative_video_failed" },
    });
    w.credits = 50;
    w.asked = [];
    const err = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id }).catch((e) => e);
    expect(err).toMatchObject({ status: 402, code: "insufficient_credits", extra: { required_credits: price } });
    expect(w.asked.map((usd) => Math.round(usd / 0.0025))).toEqual([price]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mem.runs).toEqual([run_id]);
    expect(mem.messages.find((m) => m.id === out.reply.id)?.meta.render_run_id).toBe(run_id);
    w.credits = price;
    const retry = await retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: out.reply.id });
    expect(mem.runs).toEqual([run_id, retry.run_id]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("a second video while the first is still being made", () => {
  const wallet = (start: number) => {
    const w = { credits: start, asked: [] as number[] };
    const afford = vi.fn(async (_t: string, usd: number): Promise<AffordCheck> => {
      w.asked.push(usd);
      return Math.round(usd / 0.0025) <= w.credits ? "ok" : "short";
    });
    return { w, afford };
  };
  const priceOf = async (d: VideoDraft) => {
    const i = draftToIntake(d);
    if (!i.ok) throw new Error(i.message);
    return billedVideoCredits(i.intake);
  };
  const inFlightFrom = (mem: ReturnType<typeof memoryStore>, credits: number) =>
    vi.fn(async (_t: string) => {
      const ended = new Set(mem.messages.filter((m) => m.meta.kind === "generative_video_failed").map((m) => m.meta.source_run_id));
      return mem.runs.filter((r) => !ended.has(r)).length * credits * 0.0025;
    });

  for (const verbatim of [false, true]) {
    it(`is refused up front with 402 when the wallet pays for one video but not two, and nothing is queued or sent (${verbatim ? "word for word" : "drafted"})`, async () => {
      const price = await priceOf(DRAFT);
      const { w, afford } = wallet(price + Math.floor(price / 2));
      const mem = memoryStore();
      const inFlightVideoUsd = inFlightFrom(mem, price);
      const { deps, send, complete } = setup({ afford, inFlightVideoUsd, store: mem.store });
      const go = () => (verbatim ? sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: SCRIPT, verbatim: true }) : say(deps));
      const first = await go();
      expect(first.render && "run_id" in first.render).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      expect(mem.runs).toHaveLength(1);
      const renderingBefore = mem.messages.filter((m) => m.meta.kind === "video_studio_rendering").length;
      const claimedBefore = mem.messages.filter((m) => typeof m.meta.render_run_id === "string").length;
      w.asked = [];
      const err = await go().catch((e) => e);
      expect(err).toBeInstanceOf(StudioError);
      expect(err).toMatchObject({ status: 402, code: "insufficient_credits" });
      expect(err.extra).toEqual({ required_credits: price, reason: "videos_ahead", ahead_credits: price });
      expect(err.message).toBe(NOT_ENOUGH_WITH_VIDEOS_AHEAD(price));
      expect(w.asked.map((usd) => Math.round(usd / 0.0025))).toContain(price * 2);
      expect(send).toHaveBeenCalledTimes(1);
      expect(mem.runs).toHaveLength(1);
      expect(mem.messages.filter((m) => m.meta.kind === "video_studio_rendering")).toHaveLength(renderingBefore);
      expect(mem.messages.filter((m) => typeof m.meta.render_run_id === "string")).toHaveLength(claimedBefore);
      expect(complete).toHaveBeenCalledTimes(2);
    });
  }

  it("goes ahead once the first video has ended without a charge", async () => {
    const price = await priceOf(DRAFT);
    const { afford } = wallet(price + Math.floor(price / 2));
    const mem = memoryStore();
    const { deps, send } = setup({ afford, inFlightVideoUsd: inFlightFrom(mem, price), store: mem.store });
    const first = await say(deps);
    await mem.store.insertMessage({
      thread_id: first.thread_id,
      sender_role: "assistant",
      body: "Sorry, the video took too long to generate. You were not charged for it.",
      meta: { artifact_delivery: true, source_run_id: (first.render as { run_id: string }).run_id, kind: "generative_video_failed" },
    });
    const second = await say(deps);
    expect(second.render && "run_id" in second.render).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(mem.runs).toHaveLength(2);
  });

  for (const verbatim of [false, true]) {
    it(`says this video alone is short, with no videos-ahead reason, when the wallet cannot pay for it even with nothing else being made (${verbatim ? "word for word" : "drafted"})`, async () => {
      const price = await priceOf(DRAFT);
      const { w, afford } = wallet(price - 1);
      const inFlightVideoUsd = vi.fn(async () => price * 3 * 0.0025);
      const { deps, send, mem } = setup({ afford, inFlightVideoUsd });
      const go = () => (verbatim ? sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: SCRIPT, verbatim: true }) : say(deps));
      const err = await go().catch((e) => e);
      expect(err).toBeInstanceOf(StudioError);
      expect(err).toMatchObject({ status: 402, code: "insufficient_credits" });
      expect(err.extra).toEqual({ required_credits: price });
      expect(err.message).toBe(NOT_ENOUGH_CREDITS_COPY(price));
      expect(err.message).not.toBe(NOT_ENOUGH_WITH_VIDEOS_AHEAD(price));
      const asked = w.asked.map((usd) => Math.round(usd / 0.0025));
      expect(asked).toContain(price * 4);
      expect(asked).toContain(price);
      expect(send).not.toHaveBeenCalled();
      expect(mem.runs).toHaveLength(0);
    });
  }

  it("falls back to the price of this video alone when the in-flight read fails, and still refuses a wallet short for that", async () => {
    const price = await priceOf(DRAFT);
    const { w, afford } = wallet(price);
    const boom = vi.fn(async () => {
      throw new Error("db down");
    });
    const { deps, send, mem } = setup({ afford, inFlightVideoUsd: boom });
    const out = await say(deps);
    expect(out.render && "run_id" in out.render).toBe(true);
    expect(w.asked.map((usd) => Math.round(usd / 0.0025))).toContain(price);
    expect(boom).toHaveBeenCalled();
    w.credits = price - 1;
    const err = await say(deps).catch((e) => e);
    expect(err).toMatchObject({ status: 402, code: "insufficient_credits", extra: { required_credits: price } });
    expect(err.message).toBe(NOT_ENOUGH_CREDITS_COPY(price));
    expect(send).toHaveBeenCalledTimes(1);
    expect(mem.runs).toHaveLength(1);
  });
});

describe("errors talk about the ad in front of the founder, not the old chat", () => {
  const OLD_CHAT = /\bchat\b|\bmessage\b|send a new/i;

  it("a missing ad, someone else's ad, a video already made and a double send all read in the Overview's words", async () => {
    const { deps, mem } = setup();
    const theirs = await say(deps, "their ad", OTHER_USER);
    const mine = await say(deps);
    const userMsg = mem.messages.find((m) => m.sender_role === "user" && m.thread_id === mine.thread_id)!;
    const errors = await Promise.all([
      sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "x", thread_id: theirs.thread_id }).catch((e) => e),
      retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: userMsg.id }).catch((e) => e),
      retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: theirs.reply.id, thread_id: theirs.thread_id }).catch((e) => e),
      retryStudioRender(deps, { tenant_id: TENANT, user_id: USER, message_id: mine.reply.id }).catch((e) => e),
    ]);
    expect(errors.map((e) => [e.status, e.code])).toEqual([
      [404, "thread_not_found"],
      [404, "draft_not_found"],
      [404, "thread_not_found"],
      [409, "already_rendered"],
    ]);
    for (const e of errors) {
      expect(e.message).not.toMatch(OLD_CHAT);
      expect(e.message).toMatch(/\bad\b|video/i);
    }
    expect(errors[3].message).toMatch(/Edit/);
    for (const text of [DUPLICATE_SEND_REPLY, VERBATIM_REPLY, ANIMATE_WITH_PROMPT_REPLY]) expect(text).not.toMatch(OLD_CHAT);
  });
});

describe("threadTitle", () => {
  it("cuts a long title at a whole word, never mid-word", () => {
    const out = threadTitle("Custom cakes from Cakely for every birthday, delivered fresh to your door this week.", false);
    expect(out).toBe("Custom cakes from Cakely for every birthday, delivered…");
    expect(out).not.toContain("fres…");
  });

  it("ends at the first sentence end within the cap", () => {
    expect(threadTitle("Fresh cakes daily! Order now for the weekend and get free delivery on every box.", false)).toBe("Fresh cakes daily!");
    expect(threadTitle("Fresh   cakes\n daily. More text follows here and keeps going on and on and on.", false)).toBe("Fresh cakes daily.");
  });

  it("hard-cuts a single word longer than the cap and stays within it", () => {
    const out = threadTitle("x".repeat(100), false);
    expect(out).toBe(`${"x".repeat(MAX_TITLE_CHARS - 1)}…`);
    expect(out.length).toBe(MAX_TITLE_CHARS);
  });

  it("never exceeds the cap including the ellipsis and trims trailing punctuation", () => {
    for (let n = 55; n < 70; n++) {
      const out = threadTitle(`${"ab ".repeat(30)}`.slice(0, n) + " tail words, more words here", false);
      expect(out.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
      expect(out).not.toMatch(/[\s,;:]…$/);
    }
    expect(threadTitle("a".repeat(MAX_TITLE_CHARS), false)).toBe("a".repeat(MAX_TITLE_CHARS));
  });

  it("falls back for empty text", () => {
    expect(threadTitle("  ", true)).toBe("Animated image");
    expect(threadTitle("", false)).toBe("New video");
  });
});

describe("a customer line the founder describes instead of quoting is refused before anything is paid for", () => {
  const CAKE = "Cakely bakes every cake to order in our own kitchen and delivers it the same day, so your celebration starts the moment the box opens on the table.";
  const cleanCake = (over: Record<string, unknown> = {}) => draftReply({ script: CAKE, hook: "Cakely bakes every cake to order.", ...over });
  const wallet = () => vi.fn(async (_t: string, _usd: number): Promise<AffordCheck> => "ok");

  it.each([
    ["talking_head", "A video where the presenter tells viewers they have been ordering Cakely cakes for months as a regular customer and loves them"],
    ["social", "A video where the presenter tells viewers they have been ordering Cakely cakes for months as a regular customer and loves them"],
    ["talking_head", "have the presenter pretend to be a customer who orders Cakely every week"],
    ["talking_head", "presenter should say they bought a Cakely cake for her mum's birthday"],
    ["talking_head", "make her act as a happy client of Cakely"],
    ["talking_head", "the presenter reviews Cakely as if they used it for a party"],
    ["talking_head", "presenter says she's been ordering from Cakely since last spring"],
    ["talking_head", "UGC ad: he tells the camera he has bought five cakes from us"],
    ["talking_head", "presenter speaks as a loyal Cakely customer about our sponge"],
    ["talking_head", "UGC creator gives a testimonial about Cakely"],
  ])("Zavi writes a clean %s ad for %j, yet nothing is made, queued or charged", async (intent, text) => {
    const afford = wallet();
    const over = intent === "social" ? { intent: "social", script: null, hook: null, presenter_gender: null, visual: "Slow push-in on a Cakely sponge on a kitchen table." } : {};
    const { deps, send, mem, complete } = setup({ afford }, cleanCake(over));
    const out = await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(out.reply.meta.kind).toBe("video_studio_refused");
    expect(["customer_voice", "testimonial"]).toContain(out.reply.meta.code);
    expect(out.render).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(mem.runs).toHaveLength(0);
    expect(mem.messages.some((m) => m.meta.kind === "video_studio_draft" || m.meta.kind === "video_studio_rendering")).toBe(false);
    const floor = await cheapestStudioVideoUsd();
    expect(afford.mock.calls.every(([, usd]) => usd <= floor)).toBe(true);
  });

  it("the QA repro is refused with the same customer-voice reply word-for-word mode gives", async () => {
    const { deps, send, mem } = setup({}, cleanCake());
    const prompt = await sendStudioMessage(deps, {
      tenant_id: TENANT,
      user_id: USER,
      text: "A video where the presenter tells viewers they have been ordering Cakely cakes for months as a regular customer and loves them",
    });
    const verbatim = await sendStudioMessage(deps, {
      tenant_id: TENANT,
      user_id: USER,
      new_thread: true,
      verbatim: true,
      text: "I've been ordering Cakely cakes for months as a regular customer and every single one has been perfect for our family birthdays.",
    });
    expect(prompt.reply.meta).toMatchObject({ kind: "video_studio_refused", code: "customer_voice" });
    expect(verbatim.reply.meta).toMatchObject({ kind: "video_studio_refused", code: "customer_voice" });
    expect(prompt.reply.body).toBe(verbatim.reply.body);
    expect(send).not.toHaveBeenCalled();
    expect(mem.runs).toHaveLength(0);
  });

  it.each([
    "A presenter explains why customers order Cakely for birthdays",
    "presenter says she is the founder and bakes every cake",
    "presenter tells viewers they can order Cakely cakes online and get them the same day",
    "I've been using spreadsheets for orders, make a presenter video about Cakely",
  ])("an honest presenter request still makes exactly one paid video: %j", async (text) => {
    const afford = wallet();
    const { deps, send, mem } = setup({ afford }, cleanCake());
    const out = await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text });
    expect(out.reply.meta.kind).toBe("video_studio_draft");
    expect(send).toHaveBeenCalledTimes(1);
    expect(mem.runs).toHaveLength(1);
    expect(afford.mock.calls.some(([, usd]) => usd > 0.01)).toBe(true);
  });

  it("a request for a quote off the real reviews page stays on the testimonial refusal, never a generated customer", async () => {
    const { deps, send, mem } = setup({}, cleanCake());
    const out = await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: "Show a customer review screenshot quote from our real reviews page" });
    expect(out.reply.meta).toMatchObject({ kind: "video_studio_refused", code: "testimonial" });
    expect(send).not.toHaveBeenCalled();
    expect(mem.runs).toHaveLength(0);
  });
});

describe("a short wallet is refused before any ad, message or draft is made", () => {
  const IMAGE = `${TENANT}/4c1e.jpg`;
  const wallet = (start: number) => {
    const w = { credits: start };
    const afford = vi.fn(async (_t: string, usd: number): Promise<AffordCheck> => (Math.round(usd / 0.0025) <= w.credits ? "ok" : "short"));
    return { w, afford };
  };
  const priceOf = async (d: VideoDraft) => {
    const i = draftToIntake(d);
    if (!i.ok) throw new Error(i.message);
    return billedVideoCredits(i.intake);
  };
  const floorCredits = async () => Math.round((await cheapestStudioVideoUsd()) / 0.0025);
  const watched = (over: Partial<StudioDeps>) => {
    const s = setup(over);
    const createThread = vi.spyOn(s.mem.store, "createThread");
    const insertMessage = vi.spyOn(s.mem.store, "insertMessage");
    const setThreadTitle = vi.spyOn(s.mem.store, "setThreadTitle" as never);
    s.mem.store.sendClaims = memorySendClaims(() => Date.now()).claims;
    return { ...s, createThread, insertMessage, setThreadTitle };
  };
  const newAd = (deps: StudioDeps, text = "ugc ad for our serum") => sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text, new_thread: true });

  it("a wallet below the cheapest video makes no ad, no message and no draft call", async () => {
    const floor = await floorCredits();
    expect(floor).toBeGreaterThan(1);
    const lookAtPhoto = vi.fn(async () => null);
    const { afford } = wallet(floor - 1);
    const s = watched({ afford, lookAtPhoto });
    const err = await newAd(s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ status: 402, code: "insufficient_credits", extra: { required_credits: floor } });
    expect(s.complete).not.toHaveBeenCalled();
    expect(lookAtPhoto).not.toHaveBeenCalled();
    expect(s.createThread).not.toHaveBeenCalled();
    expect(s.insertMessage).not.toHaveBeenCalled();
    expect(s.setThreadTitle).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
    expect(s.mem.threads).toHaveLength(0);
    expect(s.mem.messages).toHaveLength(0);
  });

  it("a wallet that covers the cheapest video but not this one is refused at the real price with no ad or message left behind, and the same button works after a top-up", async () => {
    const price = await priceOf(DRAFT);
    const floor = await floorCredits();
    expect(floor).toBeLessThan(price);
    const { w, afford } = wallet(floor);
    const s = watched({ afford });
    const err = await newAd(s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ status: 402, code: "insufficient_credits", extra: { required_credits: price } });
    expect(err.message).toContain(`${price.toLocaleString("en-US")} credits`);
    expect(s.complete).toHaveBeenCalledTimes(1);
    expect(s.createThread).not.toHaveBeenCalled();
    expect(s.insertMessage).not.toHaveBeenCalled();
    expect(s.setThreadTitle).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
    expect(s.mem.threads).toHaveLength(0);
    expect(s.mem.messages).toHaveLength(0);
    expect(s.mem.runs).toHaveLength(0);
    expect(await listStudioThreads(s.mem.store, USER)).toEqual([]);

    w.credits = price;
    const out = await newAd(s.deps);
    expect(out.render && "run_id" in out.render).toBe(true);
    expect(s.createThread).toHaveBeenCalledTimes(1);
    expect(s.mem.threads).toHaveLength(1);
    expect(s.mem.threads[0].id).toBe(out.thread_id);
    expect(s.mem.messages.map((m) => m.sender_role)).toEqual(["user", "assistant", "assistant"]);
    expect(s.mem.messages.every((m) => m.thread_id === out.thread_id)).toBe(true);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.mem.runs).toHaveLength(1);
  });

  it("a follow-up in an existing ad that the wallet cannot cover adds nothing to that ad", async () => {
    const price = await priceOf(DRAFT);
    const { w, afford } = wallet(price);
    const s = watched({ afford });
    const first = await newAd(s.deps);
    const before = s.mem.messages.length;
    w.credits = await floorCredits();
    s.createThread.mockClear();
    s.insertMessage.mockClear();
    const err = await sendStudioMessage(s.deps, { tenant_id: TENANT, user_id: USER, text: "use a male presenter", thread_id: first.thread_id }).catch((e) => e);
    expect(err).toMatchObject({ status: 402, code: "insufficient_credits", extra: { required_credits: price } });
    expect(s.createThread).not.toHaveBeenCalled();
    expect(s.insertMessage).not.toHaveBeenCalled();
    expect(s.mem.messages).toHaveLength(before);
    expect(s.mem.threads).toHaveLength(1);
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("a wallet that drops after the draft check leaves no draft without a render behind", async () => {
    const answers: AffordCheck[] = ["ok", "ok", "short", "short"];
    const afford = vi.fn(async (): Promise<AffordCheck> => answers.shift() ?? "short");
    const s = watched({ afford, checkImage: async () => undefined });
    const out = await sendStudioMessage(s.deps, { tenant_id: TENANT, user_id: USER, text: "", image_path: IMAGE, new_thread: true }).catch((e) => e);
    expect(out).not.toBeInstanceOf(StudioError);
    expect(afford).toHaveBeenCalledTimes(2);
    const drafts = s.mem.messages.filter((m) => m.meta.kind === "video_studio_draft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].meta.render_run_id).toBe(s.mem.runs[0]);
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("an image to animate the wallet cannot cover makes no ad, no message and no draft call", async () => {
    const floor = await floorCredits();
    expect(floor).toBeLessThan(1510);
    const { afford } = wallet(1509);
    const s = watched({ afford, checkImage: async () => undefined });
    const err = await sendStudioMessage(s.deps, { tenant_id: TENANT, user_id: USER, text: "", image_path: IMAGE, new_thread: true }).catch((e) => e);
    expect(err).toMatchObject({ status: 402, code: "insufficient_credits", extra: { required_credits: 1510 } });
    expect(s.complete).not.toHaveBeenCalled();
    expect(s.createThread).not.toHaveBeenCalled();
    expect(s.insertMessage).not.toHaveBeenCalled();
    expect(s.mem.threads).toHaveLength(0);
  });
});

describe("the Enable prompt business prompt", () => {
  const BIZ: BusinessContext = { name: "Sunrise Gym", what_we_sell: "24/7   strength classes", website: "sunrisegym.com" };
  const depsWith = (b: BusinessContext | null) => ({ business: async () => b }) as unknown as StudioDeps;

  it("asking again after the prompt just used returns a different prompt, and cycles through every angle before repeating", async () => {
    const deps = depsWith(BIZ);
    const first = await readStudioPrompt(deps, { tenant_id: TENANT });
    const second = await readStudioPrompt(deps, { tenant_id: TENANT, after: first.variant });
    expect(second.prompt).not.toBe(first.prompt);
    const seen = [first.prompt];
    let at = first.variant;
    for (let i = 1; i < PROMPT_VARIANTS; i++) {
      const next = await readStudioPrompt(deps, { tenant_id: TENANT, after: at });
      expect(next.prompt).not.toBe(seen[seen.length - 1]);
      seen.push(next.prompt);
      at = next.variant;
    }
    expect(new Set(seen).size).toBe(PROMPT_VARIANTS);
    expect(PROMPT_VARIANTS).toBeGreaterThanOrEqual(3);
  });

  it("a missing, negative or junk hint starts at the first angle", async () => {
    const deps = depsWith(BIZ);
    const base = await readStudioPrompt(deps, { tenant_id: TENANT });
    for (const after of [null, undefined, -1, 1.5, Number.NaN]) {
      expect(await readStudioPrompt(deps, { tenant_id: TENANT, after })).toEqual(base);
    }
  });

  it("every angle names the business, what it sells and its site when given, and none of them when absent", () => {
    for (let v = 0; v < PROMPT_VARIANTS; v++) {
      const full = businessPrompt(BIZ, v);
      expect(full).toContain("Sunrise Gym");
      expect(full).toContain("24/7 strength classes");
      expect(full).toContain("sunrisegym.com");
      const empty = businessPrompt(null, v);
      expect(empty).toContain("my business");
      expect(empty).not.toMatch(/null|undefined|Sunrise|sunrisegym|\(\s*\)|visit\s*\./);
      const blank = businessPrompt({ name: "  ", what_we_sell: "", website: " " }, v);
      expect(blank).toBe(empty);
    }
  });
});

describe("the thread shows the price the draft is charged", () => {
  it("the latest draft carries the exact credits the wallet is asked for, not the Pro starter price", async () => {
    const asked: number[] = [];
    const afford = vi.fn(async (_t: string, usd: number): Promise<AffordCheck> => {
      asked.push(usd);
      return "ok";
    });
    const { deps, mem } = setup({ afford });
    await say(deps);
    const view = await readStudio(mem.store, USER);
    const draft = view.messages.find((m) => m.draft);
    const charged = Math.round(asked[asked.length - 1] / 0.0025);
    expect(draft?.credits).toBe(charged);
    expect(draft?.credits).toBe(await billedVideoCredits((draftToIntake(DRAFT) as { ok: true; intake: Parameters<typeof billedVideoCredits>[0] }).intake));
    expect(draft?.credits).not.toBe(await starterVideoCredits());
  });

  it("only the newest draft is priced, and a scene draft is priced as a scene", async () => {
    const { deps, mem } = setup();
    await say(deps);
    deps.draft = { complete: vi.fn(async () => draftReply({ intent: "cinematic", script: null })) };
    await say(deps, "now a cinematic one");
    const view = await readStudio(mem.store, USER);
    const drafts = view.messages.filter((m) => m.draft);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].credits).toBeUndefined();
    const scene = draftToIntake(drafts[1].draft!);
    if (!scene.ok) throw new Error(scene.message);
    expect(drafts[1].credits).toBe(await billedVideoCredits(scene.intake));
    expect(drafts[1].credits).not.toBe(await billedVideoCredits((draftToIntake(DRAFT) as { ok: true; intake: Parameters<typeof billedVideoCredits>[0] }).intake));
  });
});

describe("a word-for-word request stays word-for-word in the thread", () => {
  const OWN = "Our gym opens at five every morning. Come in this week and your first class is free.";

  it("the user message of a verbatim send is marked verbatim, even when the draft fails", async () => {
    const { deps, mem } = setup({}, "not json");
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: OWN, verbatim: true });
    const view = await readStudio(mem.store, USER);
    expect(view.messages.find((m) => m.role === "user")?.verbatim).toBe(true);
    expect(view.messages.find((m) => m.role === "assistant")?.kind).toBe("video_studio_draft_failed");
  });

  it("a request Zavi writes the script for is not marked verbatim", async () => {
    const { deps, mem } = setup({}, "not json");
    await sendStudioMessage(deps, { tenant_id: TENANT, user_id: USER, text: OWN });
    const view = await readStudio(mem.store, USER);
    expect(view.messages.find((m) => m.role === "user")?.verbatim).toBe(false);
  });
});
