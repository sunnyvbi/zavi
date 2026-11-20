import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

const AUTH_TENANT = "11111111-1111-4111-8111-111111111111";
const AUTH_USER = "22222222-2222-4222-8222-222222222222";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: AUTH_TENANT, user_id: AUTH_USER, access_token: "tok" })),
}));
vi.mock("@/services/video-studio/store", () => ({ supabaseStudioStore: vi.fn() }));
const posted = vi.hoisted(() => ({ readPostStates: vi.fn() }));
vi.mock("@/services/video-studio/post", () => ({ readPostStates: posted.readPostStates }));

import { requireAuth } from "@/services/auth/middleware";
import { videoStudioHandlers } from "../index";
import type { StudioDeps, StudioMessageRow, StudioStore } from "@/services/video-studio/studio";
import { memorySendClaims } from "@/services/video-studio/__tests__/send-claims-memory";

function res() {
  const r = { statusCode: 200, body: undefined as unknown } as { statusCode: number; body: unknown } & Partial<Response>;
  r.status = vi.fn((c: number) => {
    r.statusCode = c;
    return r as Response;
  }) as never;
  r.json = vi.fn((b: unknown) => {
    r.body = b;
    return r as Response;
  }) as never;
  return r as Response & { statusCode: number; body: unknown };
}

const MESSAGE_ID = "00000000-0000-4000-8000-000000000009";

function deps() {
  const store = {
    findThread: vi.fn(async () => null),
    createThread: vi.fn(),
    listMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => null),
    insertMessage: vi.fn(),
    claimRender: vi.fn(),
    createRenderRun: vi.fn(),
    listVideoArtifacts: vi.fn(async () => []),
  };
  const d: StudioDeps = {
    store,
    draft: {},
    videoEnabled: vi.fn(async () => true),
    routerEnabled: vi.fn(async () => true),
    business: vi.fn(async () => null),
    tier: vi.fn(async () => ({ allowed: true, required_tier: "starter" })),
    send: vi.fn(),
  };
  return { d, store };
}

describe("video studio routes", () => {
  it("scopes the store to the authenticated tenant, never one named in the body", async () => {
    const { d } = deps();
    const make = vi.fn(() => d);
    const h = videoStudioHandlers(make);
    const r = res();
    await h.send({ body: { text: "ugc ad", tenant_id: "99999999-9999-4999-8999-999999999999" } } as Request, r);
    expect(make).toHaveBeenCalledWith(AUTH_TENANT);
  });

  it("the business prompt reads the signed-in workspace and moves past the angle named in after", async () => {
    const { d } = deps();
    const business = vi.fn(async () => ({ name: "Sunrise Gym", what_we_sell: "classes", website: "sunrisegym.com" }));
    const make = vi.fn((_t: string) => ({ ...d, business }));
    const h = videoStudioHandlers(make);
    const first = res();
    await h.prompt({ query: { tenant_id: "99999999-9999-4999-8999-999999999999" } } as unknown as Request, first);
    const firstBody = first.body as { prompt: string; variant: number };
    expect(make).toHaveBeenCalledWith(AUTH_TENANT);
    expect(business).toHaveBeenCalledWith(AUTH_TENANT);
    expect(firstBody.variant).toBe(0);
    const second = res();
    await h.prompt({ query: { after: String(firstBody.variant) } } as unknown as Request, second);
    const secondBody = second.body as { prompt: string; variant: number };
    expect(secondBody.prompt).not.toBe(firstBody.prompt);
    expect(secondBody.variant).not.toBe(firstBody.variant);
    for (const after of ["-1", "abc", "1e3", ["0", "1"]]) {
      const r = res();
      await h.prompt({ query: { after } } as unknown as Request, r);
      expect(r.body).toEqual(firstBody);
    }
  });

  it("an image-only send checks the image against the signed-in workspace, not one named in the body", async () => {
    const { d } = deps();
    const checkImage = vi.fn(async () => {
      throw Object.assign(new Error("That image is not in this workspace."), { code: "image_not_owned" });
    });
    const h = videoStudioHandlers(() => ({ ...d, checkImage }));
    const r = res();
    await h.send({ body: { image_path: "99999999-9999-4999-8999-999999999999/a.jpg", tenant_id: "99999999-9999-4999-8999-999999999999" } } as Request, r);
    expect(checkImage).toHaveBeenCalledWith(AUTH_TENANT, "99999999-9999-4999-8999-999999999999/a.jpg");
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatchObject({ error: { code: "image_not_owned" } });
  });

  it("a script send reaches the studio as word for word", async () => {
    const { d } = deps();
    const complete = vi.fn(async () => { throw new Error("model down"); });
    const h = videoStudioHandlers(() => ({ ...d, draft: { complete } }));
    const short = res();
    await h.send({ body: { text: "Come in today.", verbatim: true } } as Request, short);
    expect(short.statusCode).toBe(400);
    expect(short.body).toMatchObject({ error: { code: "script_length" } });
    expect(complete).not.toHaveBeenCalled();
  });

  it("the script writer answers with the script for the signed-in workspace and nothing else", async () => {
    const { d, store } = deps();
    const script = "Our gym opens at five every morning. Come in this week and your first class is free.";
    const complete = vi.fn(async () =>
      JSON.stringify({ reply: "ok", intent: "talking_head", aspect_ratio: "9:16", visual: "A coach in a gym.", script, hook: "Our gym opens at five.", presenter_gender: "female" }),
    );
    const make = vi.fn((_t: string) => ({ ...d, draft: { complete } }));
    const h = videoStudioHandlers(make);
    const ok = res();
    await h.script({ body: { prompt: "free first class", tenant_id: "99999999-9999-4999-8999-999999999999" } } as Request, ok);
    expect(make).toHaveBeenCalledWith(AUTH_TENANT);
    expect(ok.body).toEqual({ script });
    expect(store.insertMessage).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
    const bad = res();
    await h.script({ body: { prompt: 42 } } as Request, bad);
    expect(bad.statusCode).toBe(400);
  });

  it("a malformed chat id is a 400 before any read, and the chat list and gallery read the signed-in workspace", async () => {
    const { d, store } = deps();
    const make = vi.fn((_t: string) => d);
    const h = videoStudioHandlers(make);
    const bad = res();
    await h.read({ query: { thread_id: "not-a-uuid" } } as unknown as Request, bad);
    expect(bad.statusCode).toBe(400);
    expect(store.findThread).not.toHaveBeenCalled();
    const list = res();
    await h.threads({} as Request, list);
    expect(list.body).toEqual({ threads: [] });
    const gallery = res();
    await h.gallery({} as Request, gallery);
    expect(gallery.body).toEqual({ videos: [] });
    expect(make.mock.calls.every(([t]) => t === AUTH_TENANT)).toBe(true);
  });

  it("rejects any field besides the message id, so a client cannot switch on the premium model or a script", async () => {
    const { d, store } = deps();
    const h = videoStudioHandlers(() => d);
    const r = res();
    await h.render({ body: { message_id: MESSAGE_ID, premium: true } } as Request, r);
    expect(r.statusCode).toBe(400);
    expect(store.findThread).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("maps a missing draft to 404 with a readable message", async () => {
    const { d } = deps();
    const h = videoStudioHandlers(() => d);
    const r = res();
    await h.render({ body: { message_id: MESSAGE_ID } } as Request, r);
    expect(r.statusCode).toBe(404);
    expect(r.body).toMatchObject({ error: { code: "draft_not_found" } });
  });

  it("passes a superseded Try again through as a 409 with its code and message, and starts nothing", async () => {
    const { d, store } = deps();
    const THREAD = "00000000-0000-4000-8000-000000000001";
    const NEWER = "00000000-0000-4000-8000-000000000010";
    const draft = {
      intent: "talking_head",
      aspect_ratio: "9:16",
      visual: "A woman in her late 20s in a bright bathroom.",
      script: "Meet the serum that layers under makeup without pilling, so your skin looks calm by noon and stays that way all day long.",
      hook: "Meet the serum.",
      presenter_gender: "female",
      image_path: null,
    };
    const row = (id: string, created_at: string): StudioMessageRow => ({ id, sender_role: "assistant", body: "draft", meta: { video_draft: draft }, agent_run_id: null, created_at });
    store.findThread.mockResolvedValue(THREAD as never);
    store.getMessage.mockResolvedValue(row(MESSAGE_ID, "2026-10-26T10:00:00Z") as never);
    store.listMessages.mockResolvedValue([row(NEWER, "2026-10-26T10:05:00Z"), row(MESSAGE_ID, "2026-10-26T10:00:00Z")] as never);
    const h = videoStudioHandlers(() => d);
    const r = res();
    await h.render({ body: { message_id: MESSAGE_ID } } as Request, r);
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: { code: "superseded", message: "A newer version of this ad exists. Nothing was made or charged." } });
    expect(store.claimRender).not.toHaveBeenCalled();
    expect(store.createRenderRun).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it("bad requests answer in the ad's words, never raw field names, zod text or the old chat", async () => {
    const { d } = deps();
    const h = videoStudioHandlers(() => d);
    const replies = [res(), res(), res(), res()];
    await h.read({ query: { thread_id: "not-a-uuid" } } as unknown as Request, replies[0]);
    await h.send({ body: { text: 42 } } as unknown as Request, replies[1]);
    await h.render({ body: { message_id: "nope", premium: true } } as Request, replies[2]);
    await h.script({ body: { prompt: 42 } } as unknown as Request, replies[3]);
    for (const r of replies) {
      expect(r.statusCode).toBe(400);
      const message = (r.body as { error: { message: string } }).error.message;
      expect(message).not.toMatch(/[{}]|\bchat\b|message_id|invalid|uuid|unrecognized|expected/i);
      expect(message.length).toBeGreaterThan(10);
    }
  });

  it("hides internal errors behind a generic 500", async () => {
    const { d, store } = deps();
    store.findThread.mockRejectedValueOnce(new Error("relation agent_threads does not exist"));
    const h = videoStudioHandlers(() => d);
    const r = res();
    await h.read({} as Request, r);
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("agent_threads");
  });

  it("returns the plan refusal with its required tier so the web can show the upgrade screen", async () => {
    const { d } = deps();
    d.tier = vi.fn(async () => ({ allowed: false, required_tier: "starter" }));
    const h = videoStudioHandlers(() => d);
    const r = res();
    await h.send({ body: { text: "ugc ad" } } as Request, r);
    expect(r.statusCode).toBe(403);
    expect(r.body).toMatchObject({ error: { code: "plan_upgrade_required", required_tier: "starter" } });
  });

  it("two tabs posting the same message with their own Idempotency-Keys get one model call, one render and the same answer", async () => {
    let seq = 0;
    const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
    const threads: string[] = [];
    const rows: Array<StudioMessageRow & { thread_id: string }> = [];
    const store: StudioStore = {
      sendClaims: memorySendClaims().claims,
      findThread: async () => threads[threads.length - 1] ?? null,
      createThread: async () => {
        threads.push(id());
        return threads[threads.length - 1];
      },
      listMessages: async (thread_id) => rows.filter((m) => m.thread_id === thread_id),
      getMessage: async () => null,
      insertMessage: async (m) => {
        const row = { id: id(), thread_id: m.thread_id, sender_role: m.sender_role, body: m.body, meta: m.meta ?? {}, agent_run_id: m.agent_run_id ?? null, created_at: new Date().toISOString() };
        rows.push(row);
        return row;
      },
      claimRender: async () => true,
      createRenderRun: async () => id(),
      listVideoArtifacts: async () => [],
    };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const complete = vi.fn(async () => {
      await gate;
      return JSON.stringify({
        reply: "Making it.",
        intent: "talking_head",
        aspect_ratio: "9:16",
        visual: "A woman in a bright bathroom.",
        script: "Meet the serum that layers under makeup without pilling, so your skin looks calm by noon and stays that way all day long.",
        hook: "Meet the serum.",
        presenter_gender: "female",
        image_path: null,
      });
    });
    const send = vi.fn(async () => ({ ids: ["x"] }));
    const d: StudioDeps = { ...deps().d, store, draft: { complete }, send };
    const h = videoStudioHandlers(() => d);
    const tabA = res();
    const tabB = res();
    const body = { text: "ugc ad for our serum", new_thread: true };
    const a = h.send({ body, headers: { "idempotency-key": "tab-a-key-0001" } } as unknown as Request, tabA);
    const b = h.send({ body, headers: { "idempotency-key": "tab-b-key-0002" } } as unknown as Request, tabB);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([a, b]);
    expect(tabA.statusCode).toBe(200);
    expect(tabB.statusCode).toBe(200);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(threads).toHaveLength(1);
    expect(tabB.body).toEqual(tabA.body);
  });
});

describe("a staff or eval session acting on another workspace", () => {
  function overriddenOnce() {
    vi.mocked(requireAuth).mockResolvedValueOnce({ tenant_id: AUTH_TENANT, user_id: AUTH_USER, access_token: "tok", tenant_overridden: true } as never);
  }

  it.each([
    ["Generate", "send", { text: "ugc ad for the summer sale" }],
    ["Script writer", "script", { prompt: "a presenter talks about the summer sale" }],
    ["Try again", "render", { message_id: MESSAGE_ID }],
  ] as const)("cannot use %s: 403 tenant_override_forbidden and nothing is written, drafted or sent", async (_n, handler, body) => {
    const { d, store } = deps();
    const complete = vi.fn(async () => "draft");
    const make = vi.fn(() => ({ ...d, draft: { complete } }));
    const h = videoStudioHandlers(make);
    overriddenOnce();
    const r = res();
    await h[handler]({ body } as Request, r);
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." } });
    expect(make).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
    expect(store.insertMessage).not.toHaveBeenCalled();
    expect(store.claimRender).not.toHaveBeenCalled();
    expect(store.createRenderRun).not.toHaveBeenCalled();
  });

  it("can still read the studio, its ads and the Library", async () => {
    const { d } = deps();
    const h = videoStudioHandlers(() => d);
    overriddenOnce();
    const studio = res();
    await h.read({ query: {} } as unknown as Request, studio);
    expect(studio.statusCode).toBe(200);
    overriddenOnce();
    const gallery = res();
    await h.gallery({} as Request, gallery);
    expect(gallery.statusCode).toBe(200);
  });
});

describe("the Library lists where each video was posted", () => {
  function galleryDeps() {
    const { d } = deps();
    const store = {
      ...d.store,
      listVideoRuns: vi.fn(async () => [
        { id: "run-1", created_at: "2026-10-15T10:00:00Z", enqueued_by: AUTH_USER, studio_thread_id: "th-1" },
      ]),
      listGalleryArtifacts: vi.fn(async () => [
        { id: "a-posted", run_id: "run-1", filename: "p.mp4", created_at: "2026-10-15T10:05:00Z" },
        { id: "a-fresh", run_id: "run-1", filename: "f.mp4", created_at: "2026-10-15T10:04:00Z" },
      ]),
    };
    return { ...d, store } as StudioDeps;
  }

  it("asks for this workspace's posts on exactly the listed videos and returns them per video", async () => {
    posted.readPostStates.mockReset();
    posted.readPostStates.mockResolvedValueOnce({ "a-posted": { posted_on: ["instagram"], posting_on: ["linkedin"], check_on: ["tiktok"], failed_on: ["x"] } });
    const h = videoStudioHandlers(() => galleryDeps());
    const r = res();
    await h.gallery({} as Request, r);
    expect(posted.readPostStates).toHaveBeenCalledTimes(1);
    expect(posted.readPostStates).toHaveBeenCalledWith(AUTH_TENANT, ["a-posted", "a-fresh"]);
    const videos = (r.body as { videos: Array<{ artifact_id: string; posted_on: string[]; posting_on: string[]; check_on: string[]; failed_on: string[] }> }).videos;
    expect(videos.map((v) => [v.artifact_id, v.posted_on, v.posting_on, v.check_on, v.failed_on])).toEqual([
      ["a-posted", ["instagram"], ["linkedin"], ["tiktok"], ["x"]],
      ["a-fresh", [], [], [], []],
    ]);
  });

  it("still lists every video, each posted nowhere, when the posts cannot be read", async () => {
    posted.readPostStates.mockReset();
    posted.readPostStates.mockRejectedValueOnce(new Error("relation channel_post_decisions does not exist"));
    const h = videoStudioHandlers(() => galleryDeps());
    const r = res();
    await h.gallery({} as Request, r);
    expect(r.statusCode).toBe(200);
    const videos = (r.body as { videos: Array<{ artifact_id: string; posted_on: string[]; posting_on: string[] }> }).videos;
    expect(videos.map((v) => [v.artifact_id, v.posted_on, v.posting_on])).toEqual([
      ["a-posted", [], []],
      ["a-fresh", [], []],
    ]);
  });
});
