// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { makeAction } from "../actions/__tests__/fixtures";
import { ChannelChatProvider, type ChannelChatPin } from "../actions/channelChat";
import { ChannelPlanLockProvider, type ChannelPlanLock } from "../actions/channelPlanLock";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { RELOAD_GAVE_UP, RELOAD_TRIES, VideoOverview, threadTitle } from "./VideoOverview";
import { RENDER_POLL_MS } from "./studioApi";
import { STAGE_MS, SuggestedAds, type AdItem } from "./SuggestedAds";
import { STUDIO_PATH, type StudioView } from "./types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch, IDEMPOTENCY_HEADER: "Idempotency-Key", newIdempotencyKey: () => "k" }));

const ws = vi.hoisted(() => ({ value: null as null | { role: string; openTab: ReturnType<typeof vi.fn> } }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ws.value, useWorkspace: () => ws.value }));

const channel = vi.hoisted(() => ({ actions: [] as unknown[], refreshSilent: vi.fn(async () => undefined) }));
vi.mock("../actions/useChannelActions", () => ({
  useChannelActions: () => ({ actions: channel.actions, refreshSilent: channel.refreshSilent, loading: false, completed: [], more: 0, plan: null, metrics: [] }),
}));

const SLUG = "generated_video";
const RUN = "run-starters";

const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

type Answer = { body: unknown; status?: number } | (() => Promise<unknown>);

let threads: Array<{ id: string; title: string; last_message_at: string }> = [];
let views: Record<string, StudioView> = {};
let messageAnswers: Answer[] = [];
let renderAnswer: Answer = { body: { ok: true } };
let approveAnswer: Answer = { body: { ok: true, exec_status: "queued" } };
let startersGet: Record<string, unknown> = { run_id: RUN };
let channelsBody: unknown = {};
const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
const scrolled: Element[] = [];
const posts: Array<{ url: string; body: Record<string, unknown> }> = [];

function answer(a: Answer) {
  if (typeof a === "function") return a();
  return Promise.resolve(res(a.body, a.status ?? 200));
}

const DRAFT = { intent: "talking_head", aspect_ratio: "9:16", visual: "A founder at a desk", script: "Stop wasting mornings. Our app plans your day in one tap.", hook: null, presenter_gender: null } as const;

function view(id: string, status: "rendering" | "done" | "failed" | "stalled" | null, extra: Partial<StudioView> = {}): StudioView {
  return {
    thread_id: id,
    messages: [
      { id: `u-${id}`, role: "user", body: "make an ad", created_at: "2026-10-26T10:00:00Z", kind: null, draft: null, render_run_id: null, run_id: null },
      Object.assign({ id: `m-${id}`, role: "assistant" as const, body: "Here is a draft", created_at: "2026-10-26T10:00:05Z", kind: null, draft: { ...DRAFT }, render_run_id: status ? `r-${id}` : null, run_id: null }, { credits: 900 }),
    ],
    renders: status
      ? { [`r-${id}`]: { status, started_at: new Date(Date.now() - 1000).toISOString(), videos: status === "done" ? [{ artifact_id: `a-${id}`, filename: null }] : [] } }
      : {},
    ...extra,
  };
}

function card(id: string, over: Partial<ChannelActionView> = {}): ChannelActionView {
  return makeAction("video_post", {
    id,
    run_id: RUN,
    channel_slug: SLUG,
    title: "Explainer: Why it takes 20 seconds",
    executable: true,
    exec_status: null,
    status: "pending",
    proposed_at: "2026-10-01T14:00:00Z",
    body: {
      video_format: "explainer",
      cost_credits: 1500,
      step: { deliverable: { content: "Here is the first line. Then the rest of it." } },
    } as unknown as ChannelActionView["body"],
    ...over,
  });
}

beforeEach(() => {
  threads = [];
  views = {};
  messageAnswers = [];
  renderAnswer = { body: { ok: true } };
  approveAnswer = { body: { ok: true, exec_status: "queued" } };
  startersGet = { run_id: RUN };
  channelsBody = {};
  observers.length = 0;
  posts.length = 0;
  channel.actions = [];
  ws.value = null;
  channel.refreshSilent.mockClear();
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  apiFetch.mockReset();
  window.sessionStorage.clear();
  apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (init?.method === "POST") posts.push({ url: u, body: init.body ? JSON.parse(init.body) : {} });
    if (u === `${STUDIO_PATH}/threads`) return res({ threads });
    if (u.startsWith(`${STUDIO_PATH}?thread_id=`)) {
      const id = decodeURIComponent(u.split("=")[1]);
      return views[id] ? res(views[id]) : res({}, 404);
    }
    if (u === `${STUDIO_PATH}/messages`) {
      const next = messageAnswers.shift();
      if (!next) throw new Error("unexpected message POST");
      return answer(next);
    }
    if (u === `${STUDIO_PATH}/render`) return answer(renderAnswer);
    if (u === "/api/channels") return res(channelsBody);
    if (u === `/api/channels/${SLUG}/starters`) return init?.method === "POST" ? res({ run_id: "run-new" }) : res(startersGet);
    if (u.endsWith("/approve")) return answer(approveAnswer);
    if (u.startsWith("/api/run-artifacts/")) return res({ signed_url: "https://cdn.test/v.mp4" });
    return res({});
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(wrap?: (n: ReactNode) => ReactNode, focusThread: string | null = null) {
  const node = <VideoOverview slug={SLUG} focusThread={focusThread} />;
  await act(async () => {
    render(wrap ? wrap(node) : node);
  });
}

const input = () => screen.getByLabelText("Your script") as HTMLTextAreaElement;
const generate = () => within(screen.getByTestId("video-studio-empty")).getByRole("button", { name: "Generate" });
const adId = (el: Element) => el.closest("li")?.id;
const ads = () => screen.queryAllByTestId("suggested-ad");
const messagePosts = () => posts.filter((p) => p.url === `${STUDIO_PATH}/messages`);

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}

function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

describe("VideoOverview Generate adds a work item", () => {
  it("puts a making item at the top and scrolls to it before the server answers", async () => {
    threads = [{ id: "old", title: "Older ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { old: view("old", "done") };
    const gate = deferred();
    messageAnswers = [() => gate.promise];
    await mount();
    expect(ads()).toHaveLength(1);

    type("A video about our morning planner for busy parents");
    await act(async () => {
      fireEvent.click(generate());
      await new Promise((r) => setTimeout(r, 0));
    });

    const items = ads();
    expect(items).toHaveLength(2);
    expect((items[0]).getAttribute("data-state")).toBe("making");
    expect(within(items[0]).getByRole("heading").textContent).toBe("A video about our morning planner for busy parents");
    expect(within(items[0]).getByTestId("suggested-ad-stage").textContent).toBe("Writing the script");
    expect(within(items[0]).getByTestId("suggested-ad-status").textContent).toBe("Making your ad from your script, word for word.");
    expect(screen.getByTestId("video-overview-status").textContent).toBe('Making "A video about our morning planner for busy parents". This takes a few minutes.');
    expect((items[1]).getAttribute("data-state")).toBe("ready");
    expect(scrolled.some((el) => el.id?.startsWith("suggested-ad-pending-"))).toBe(true);
    expect(input().value).toBe("");
    expect(messagePosts()).toHaveLength(1);
    expect(messagePosts()[0].body).toEqual({ text: "A video about our morning planner for busy parents", verbatim: true, new_thread: true });

    views.t1 = view("t1", "rendering");
    await act(async () => {
      gate.resolve(res({ thread_id: "t1", render: null }));
    });
    await waitFor(() => expect(adId(ads()[0])).toBe("suggested-ad-thread-t1"));
    expect(ads()).toHaveLength(2);
    expect((ads()[0]).getAttribute("data-state")).toBe("making");
  });

  it("the starting title and announcement read the first sentence with no ellipsis, and stay the same after the server answers", async () => {
    const gate = deferred();
    messageAnswers = [() => gate.promise];
    await mount();

    type("A short talking-head ad for Cakely.\nCakely sells: Cakes for birthdays, celebrations, and other special moments.");
    await act(async () => {
      fireEvent.click(generate());
      await new Promise((r) => setTimeout(r, 0));
    });

    const title = "A short talking-head ad for Cakely.";
    expect(within(ads()[0]).getByRole("heading").textContent).toBe(title);
    expect(screen.getByTestId("video-overview-status").textContent).toBe(`Making "${title}". This takes a few minutes.`);

    views.t1 = view("t1", "rendering");
    await act(async () => {
      gate.resolve(res({ thread_id: "t1", render: null }));
    });
    await waitFor(() => expect(adId(ads()[0])).toBe("suggested-ad-thread-t1"));
    expect(within(ads()[0]).getByRole("heading").textContent).toBe(title);
  });

  it("the ad just made stays above the not-yet-made suggested ads when the server answers", async () => {
    channel.actions = [card("fresh-1"), card("fresh-2")];
    threads = [{ id: "old", title: "Older ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { old: view("old", "done") };
    const gate = deferred();
    messageAnswers = [() => gate.promise];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(3));

    type("A video about our morning planner for busy parents");
    await act(async () => {
      fireEvent.click(generate());
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(adId(ads()[0])).toMatch(/^suggested-ad-pending-/);

    views.t1 = view("t1", "rendering");
    await act(async () => {
      gate.resolve(res({ thread_id: "t1", render: null }));
    });
    await waitFor(() => expect(ads().map(adId)).toContain("suggested-ad-thread-t1"));
    expect(ads().map(adId)).toEqual(["suggested-ad-thread-t1", "suggested-ad-starter-fresh-1", "suggested-ad-starter-fresh-2", "suggested-ad-thread-old"]);
    expect(ads()[0].getAttribute("data-state")).toBe("making");
  });

  it("a double click on Generate sends one message", async () => {
    const gate = deferred();
    messageAnswers = [() => gate.promise, () => gate.promise];
    await mount();
    type("One ad please for our local gym");
    await act(async () => {
      const b = generate();
      b.click();
      b.click();
    });
    expect(messagePosts()).toHaveLength(1);
    expect(ads()).toHaveLength(1);
  });

  it("every prompt makes its own item, newest first, while the first is still drafting", async () => {
    const first = deferred();
    const second = deferred();
    messageAnswers = [() => first.promise, () => second.promise];
    await mount();
    type("First idea here for our gym");
    await act(async () => fireEvent.click(generate()));
    type("Second idea here for our gym");
    await act(async () => fireEvent.click(generate()));
    const titles = ads().map((a) => within(a).getByRole("heading").textContent);
    expect(titles).toEqual(["Second idea here for our gym", "First idea here for our gym"]);
    expect(messagePosts().map((p) => p.body.text)).toEqual(["First idea here for our gym", "Second idea here for our gym"]);
    expect(messagePosts().every((p) => p.body.new_thread === true && !("thread_id" in p.body))).toBe(true);
  });

  it("Enable prompt starts off, so the script is sent word for word and shown as such", async () => {
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    expect((screen.getByRole("switch", { name: /Enable prompt/ })).getAttribute("aria-checked")).toBe("false");
    type("Say exactly this line, word for word.");
    await act(async () => fireEvent.click(generate()));
    expect(messagePosts()[0].body).toEqual({ text: "Say exactly this line, word for word.", verbatim: true, new_thread: true });
    expect(screen.getByTestId("suggested-ad-stage").textContent).toBe("Writing the script");
    expect(screen.getByTestId("suggested-ad-status").textContent).toBe("Making your ad from your script, word for word.");
    expect((screen.getByRole("switch", { name: /Enable prompt/ })).getAttribute("aria-checked")).toBe("false");
  });

  const ANGLES = ["Angle one: the problem and the fix.", "Angle two: a moment from a customer's day.", "Angle three: the doubt, answered."];
  function servePromptAngles() {
    const promptGets: string[] = [];
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u === `${STUDIO_PATH}/prompt` || u.startsWith(`${STUDIO_PATH}/prompt?`)) {
        promptGets.push(u);
        const after = new URL(u, "http://x").searchParams.get("after");
        const variant = after === null ? 0 : (Number(after) + 1) % ANGLES.length;
        return res({ prompt: ANGLES[variant], variant });
      }
      return base(url, init);
    });
    return promptGets;
  }

  it("after Generate uses the business prompt, turning Enable prompt on again asks past it and fills a different prompt", async () => {
    window.sessionStorage.clear();
    const promptGets = servePromptAngles();
    messageAnswers = [() => new Promise(() => undefined), () => new Promise(() => undefined)];
    await mount();
    const toggle = () => screen.getByRole("switch", { name: /Enable prompt/ });
    await act(async () => fireEvent.click(toggle()));
    await waitFor(() => expect(input().value).toBe(ANGLES[0]));
    await act(async () => fireEvent.click(generate()));
    expect(messagePosts()[0].body.text).toBe(ANGLES[0]);
    expect(input().value).toBe("");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => fireEvent.click(toggle()));
    await waitFor(() => expect(input().value).not.toBe(""));
    expect(input().value).not.toBe(ANGLES[0]);
    expect(input().value).toBe(ANGLES[1]);
    expect(promptGets).toEqual([`${STUDIO_PATH}/prompt`, `${STUDIO_PATH}/prompt?after=0`]);
    await act(async () => fireEvent.click(generate()));
    expect(messagePosts().map((p) => p.body.text)).toEqual([ANGLES[0], ANGLES[1]]);
  });

  it("a page reload after Generate used a prompt does not bring that prompt back, and another workspace starts fresh", async () => {
    window.sessionStorage.clear();
    ws.value = { role: "owner", openTab: vi.fn(), tenantId: "tenant-a" } as unknown as typeof ws.value;
    const promptGets = servePromptAngles();
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    const toggle = () => screen.getByRole("switch", { name: /Enable prompt/ });
    await act(async () => fireEvent.click(toggle()));
    await waitFor(() => expect(input().value).toBe(ANGLES[0]));
    await act(async () => fireEvent.click(generate()));
    expect(messagePosts()[0].body.text).toBe(ANGLES[0]);

    cleanup();
    await mount();
    await act(async () => fireEvent.click(toggle()));
    await waitFor(() => expect(input().value).not.toBe(""));
    expect(input().value).not.toBe(ANGLES[0]);
    expect(promptGets).toEqual([`${STUDIO_PATH}/prompt`, `${STUDIO_PATH}/prompt?after=0`]);

    cleanup();
    ws.value = { role: "owner", openTab: vi.fn(), tenantId: "tenant-b" } as unknown as typeof ws.value;
    await mount();
    await act(async () => fireEvent.click(toggle()));
    await waitFor(() => expect(input().value).toBe(ANGLES[0]));
    expect(promptGets[2]).toBe(`${STUDIO_PATH}/prompt`);
    window.sessionStorage.clear();
  });

  it("Ask Zavi then Generate continues that ad in place and adds no new item", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", null) };
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Ask Zavi" }));
    expect(screen.getByTestId("video-studio-editing").textContent).toContain("Planner ad");
    type("Make the hook punchier");
    await act(async () => fireEvent.click(generate()));
    expect(messagePosts()[0].body).toEqual({ text: "Make the hook punchier", thread_id: "t1" });
    expect(ads()).toHaveLength(1);
    expect((ads()[0]).getAttribute("data-state")).toBe("making");
    expect(screen.queryByTestId("video-studio-editing")).toBeNull();
  });

  it("on a channel page Ask Zavi opens the side chat with that ad's script unsent, and the studio composer stays untouched", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", null) };
    const opened: ChannelChatPin[] = [];
    await mount((n) => <ChannelChatProvider open={(p) => opened.push(p)}>{n}</ChannelChatProvider>);
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Ask Zavi" }));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Ask Zavi" }));
    expect(opened).toHaveLength(2);
    const pin = opened[0];
    expect(pin.target).toBe("channel");
    if (pin.target !== "channel") return;
    expect(pin.draft?.autoSend).toBeUndefined();
    expect(pin.draft?.text).toBe(`About the AI UGC ad "Planner ad". Its script:\n${DRAFT.script}\n\n`);
    expect(opened[1].target === "channel" && opened[1].draft?.nonce).not.toBe(undefined);
    expect(screen.queryByTestId("video-studio-editing")).toBeNull();
    expect(input().value).toBe("");
    expect(posts).toHaveLength(0);
  });

  it("a failed send keeps the other ads, offers Try again and Dismiss, and Try again sends again", async () => {
    threads = [{ id: "old", title: "Older ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { old: view("old", "done") };
    messageAnswers = [{ body: { error: { message: "Zavi is busy right now." } }, status: 503 }, () => new Promise(() => undefined)];
    await mount();
    type("Fail me once for our local gym");
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect((ads()[0]).getAttribute("data-state")).toBe("failed"));
    expect(ads()).toHaveLength(2);
    expect(within(ads()[0]).getByRole("alert").textContent).toBe("Zavi is busy right now.");
    expect(within(ads()[0]).queryByTestId("suggested-ad-top-up")).toBeNull();
    const placeholder = within(ads()[0]).getByTestId("suggested-ad-placeholder");
    expect(placeholder.textContent).toContain("Not made");
    expect(placeholder.textContent).not.toContain("Not made yet");
    expect(placeholder.textContent).toContain("Try again");
    expect(within(ads()[1]).queryByTestId("suggested-ad-placeholder")).toBeNull();
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Try again" })));
    expect(within(ads()[0]).queryByTestId("suggested-ad-placeholder")).toBeNull();
    expect(within(ads()[0]).getByTestId("suggested-ad-stage")).toBeTruthy();
    expect(messagePosts()).toHaveLength(2);
    expect(messagePosts()[1].body).toEqual({ text: "Fail me once for our local gym", verbatim: true, new_thread: true });
    expect((ads()[0]).getAttribute("data-state")).toBe("making");
  });

  it("an out-of-credits refusal shows Top up, and Dismiss removes only that item", async () => {
    threads = [{ id: "old", title: "Older ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { old: view("old", "done") };
    messageAnswers = [{ body: { error: { code: "insufficient_credits", message: "no" } }, status: 402 }];
    await mount();
    type("Costly ad for our local gym today");
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect(within(ads()[0]).getByTestId("suggested-ad-top-up")).toBeTruthy());
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Dismiss" }));
    expect(ads()).toHaveLength(1);
    expect(adId(ads()[0])).toBe("suggested-ad-thread-old");
  });

  it("a refused Generate clears the Making status and announces the refusal as an alert", async () => {
    messageAnswers = [{ body: { error: { code: "insufficient_credits", message: "no" } }, status: 402 }];
    await mount();
    type("Costly ad for our local gym today");
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect(within(ads()[0]).getByTestId("suggested-ad-top-up")).toBeTruthy());
    expect(screen.getByTestId("video-overview-status").textContent).toBe("");
    const alert = within(ads()[0]).getByRole("alert");
    expect(alert.textContent).toMatch(/credits/i);
    expect(alert.textContent).not.toBe("no");
  });

  it("a failed Generate clears the Making status and the server error is an alert", async () => {
    messageAnswers = [{ body: { error: { message: "Zavi is busy right now." } }, status: 503 }];
    await mount();
    type("Failing ad for our local gym today");
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect(ads()[0].getAttribute("data-state")).toBe("failed"));
    expect(screen.getByTestId("video-overview-status").textContent).toBe("");
    expect(within(ads()[0]).getByRole("alert").textContent).toBe("Zavi is busy right now.");
  });

  it("a plan refusal clears the Making status too", async () => {
    const upgrade = vi.fn();
    messageAnswers = [{ body: { error: { code: "plan_upgrade_required", required_tier: "growth" } }, status: 403 }];
    await mount((n) => <ChannelPlanLockProvider value={{ tierName: null, upgrade }}>{n}</ChannelPlanLockProvider>);
    type("Locked ad for our local gym today");
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect(upgrade).toHaveBeenCalledWith("growth"));
    expect(screen.getByTestId("video-overview-status").textContent).toBe("");
  });

  it("script text typed before switching to Image mode is never sent as the motion prompt, and comes back on return", async () => {
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      String(url) === "/api/chat/upload-image" ? res({ image_path: "uploads/car.png" }) : base(url, init),
    );
    messageAnswers = [{ body: { thread_id: "new1" } }];
    await mount();
    const SCRIPT = "Stop wasting mornings with this one simple planner";
    type(SCRIPT);
    fireEvent.click(screen.getByRole("radio", { name: "Image to video" }));
    expect((screen.getByLabelText("How the image should move") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("radio", { name: "Script to video" }));
    expect(input().value).toBe(SCRIPT);
    fireEvent.click(screen.getByRole("radio", { name: "Image to video" }));
    await act(async () => {
      fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [new File(["x"], "car.png", { type: "image/png" })] } });
    });
    await waitFor(() => expect(within(screen.getByTestId("video-studio-empty")).getByRole("button", { name: "Generate" }).hasAttribute("disabled")).toBe(false));
    await act(async () => fireEvent.click(generate()));
    expect(messagePosts()).toHaveLength(1);
    expect(messagePosts()[0].body).toEqual({ text: "", image_path: "uploads/car.png", new_thread: true });
    expect(JSON.stringify(messagePosts()[0].body)).not.toContain("mornings");
  });

  it("a plan refusal opens the upgrade path instead of showing an error item", async () => {
    const upgrade = vi.fn();
    messageAnswers = [{ body: { error: { code: "plan_upgrade_required", required_tier: "growth" } }, status: 403 }];
    await mount((n) => <ChannelPlanLockProvider value={{ tierName: null, upgrade }}>{n}</ChannelPlanLockProvider>);
    type("Locked ad for our local gym today");
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect(upgrade).toHaveBeenCalledWith("growth"));
    expect(ads()).toHaveLength(0);
  });

  it("a Script writer plan refusal opens the upgrade path and writes nothing into the script box", async () => {
    const upgrade = vi.fn();
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      String(url) === `${STUDIO_PATH}/script`
        ? res({ error: { code: "plan_upgrade_required", required_tier: "starter", message: "AI UGC Videos needs the Starter plan ($20/mo)." } }, 403)
        : base(url, init),
    );
    await mount((n) => <ChannelPlanLockProvider value={{ tierName: null, upgrade }}>{n}</ChannelPlanLockProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Script writer" }));
    fireEvent.change(screen.getByLabelText("Your prompt"), { target: { value: "An ad for our local gym" } });
    await act(async () => fireEvent.click(within(screen.getByRole("dialog", { name: "Script writer" })).getByRole("button", { name: "Generate" })));
    await waitFor(() => expect(upgrade).toHaveBeenCalledWith("starter"));
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls.filter(([u]) => String(u) === `${STUDIO_PATH}/script`)).toHaveLength(1);
    expect(input().value).toBe("");
    expect(messagePosts()).toHaveLength(0);
  });
});

describe("VideoOverview progress", () => {
  it("polls a rendering ad, stops once it is done, and shows the video", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "rendering") };
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect((ads()[0]).getAttribute("data-state")).toBe("making");
    const viewCalls = () => apiFetch.mock.calls.filter(([u]) => String(u) === `${STUDIO_PATH}?thread_id=t1`).length;
    const before = viewCalls();
    views.t1 = view("t1", "done");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS);
    });
    expect(viewCalls()).toBe(before + 1);
    expect((ads()[0]).getAttribute("data-state")).toBe("ready");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS * 3);
    });
    expect(viewCalls()).toBe(before + 1);
    expect(screen.getByRole("button", { name: "Play Planner ad" })).toBeTruthy();
  });

  it("a made ad signs its video once and downloads from the card with no Post button; a making ad shows the wait instead", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    threads = [
      { id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" },
      { id: "t2", title: "Gym ad", last_message_at: "2026-10-24T00:00:00Z" },
    ];
    views = { t1: view("t1", "done"), t2: view("t2", "rendering") };
    await mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Play Planner ad" })).toBeTruthy());
    const ready = ads().find((a) => a.getAttribute("data-state") === "ready")!;
    const signs = () => apiFetch.mock.calls.filter(([u]) => String(u).startsWith("/api/run-artifacts/") && !String(u).includes("download=1"));
    expect(signs()).toHaveLength(1);
    expect(within(ready).queryByTestId("suggested-ad-post")).toBeNull();
    expect(within(ready).queryByRole("button", { name: /post/i })).toBeNull();
    expect(ready.textContent).not.toContain("Coming soon");
    const download = within(ready).getByRole("button", { name: "Download" }) as HTMLButtonElement;
    expect(download.getAttribute("aria-label")).toBeNull();
    expect(screen.getByTestId("video-overview-status").textContent).toBe("");
    await act(async () => fireEvent.click(download));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://cdn.test/v.mp4"));
    expect(within(ready).getByTestId("suggested-ad-download").textContent).toBe("Download again");
    expect(screen.getByTestId("video-overview-status").textContent).toBe('Downloaded "Planner ad".');
    expect(apiFetch.mock.calls.filter(([u]) => String(u).includes("download=1"))).toHaveLength(1);
    expect(signs()).toHaveLength(1);
    const making = ads().find((a) => a.getAttribute("data-state") === "making")!;
    expect(within(making).queryByRole("button", { name: /^Download/ })).toBeNull();
    expect(within(making).queryByTestId("suggested-ad-post")).toBeNull();
    expect((within(making).getByRole("button", { name: "Making it · a few minutes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the stage line and the bar move on every 20 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    const v = view("t1", "rendering");
    v.renders["r-t1"].started_at = new Date(Date.now()).toISOString();
    views = { t1: v };
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("suggested-ad-stage").textContent).toBe("Writing the script");
    expect(screen.getByTestId("suggested-ad-progress").style.width).toBe("25%");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAGE_MS);
    });
    expect(screen.getByTestId("suggested-ad-stage").textContent).toBe("Picking scenes");
    expect(screen.getByTestId("suggested-ad-progress").style.width).toBe("50%");
  });

  it("a video waiting behind others says so, and flips to Making it only once it starts", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    threads = [
      { id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" },
      { id: "t2", title: "Gym ad", last_message_at: "2026-10-25T00:00:00Z" },
    ];
    const ahead = view("t1", "rendering");
    ahead.renders["r-t1"] = { ...ahead.renders["r-t1"], working_since: new Date(Date.now()).toISOString() };
    const behind = view("t2", "rendering");
    behind.renders["r-t2"] = { ...behind.renders["r-t2"], queued: true };
    views = { t1: ahead, t2: behind };
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const byTitle = (title: string) => ads().find((a) => a.textContent?.includes(title))!;
    const waiting = byTitle("Gym ad");
    const running = byTitle("Planner ad");
    expect(waiting.getAttribute("data-state")).toBe("making");
    expect((within(waiting).getByRole("button", { name: "In line behind other videos" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(waiting).queryByRole("button", { name: /Making it/ })).toBeNull();
    expect(within(waiting).getByTestId("suggested-ad-stage").textContent).toBe("Waiting for the videos ahead");
    expect(within(waiting).getByTestId("suggested-ad-queued").textContent).toBe("Other videos in this workspace are being made first. This one starts on its own when they finish.");
    expect(within(waiting).queryByTestId("suggested-ad-progress")).toBeNull();
    expect(within(running).getByRole("button", { name: "Making it · a few minutes" })).toBeTruthy();
    expect(within(running).queryByRole("button", { name: "In line behind other videos" })).toBeNull();
    expect(within(running).getByTestId("suggested-ad-stage").textContent).toBe("Writing the script");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAGE_MS * 3);
    });
    expect(within(byTitle("Gym ad")).getByTestId("suggested-ad-stage").textContent).toBe("Waiting for the videos ahead");
    const started = view("t2", "rendering");
    started.renders["r-t2"] = { ...started.renders["r-t2"], working_since: new Date(Date.now()).toISOString() };
    views = { ...views, t2: started };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS);
    });
    const now = byTitle("Gym ad");
    expect(within(now).getByRole("button", { name: "Making it · a few minutes" })).toBeTruthy();
    expect(within(now).queryByRole("button", { name: "In line behind other videos" })).toBeNull();
    expect(within(now).queryByTestId("suggested-ad-queued")).toBeNull();
    expect(within(now).getByTestId("suggested-ad-stage").textContent).toBe("Writing the script");
    expect(within(now).getByTestId("suggested-ad-progress").style.width).toBe("25%");
  });

  it("Try again on a stopped video asks for a render of that draft only", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "stalled") };
    const gate = deferred();
    renderAnswer = () => gate.promise;
    await mount();
    expect(within(ads()[0]).getByText("This video is taking much longer than usual. Press Try again to check on it: if it is still being made, Zavi keeps that same video, and you are charged once, only when it arrives.")).toBeTruthy();
    expect(ads()[0].textContent).not.toContain("You were not charged");
    await act(async () => {
      const b = within(ads()[0]).getByRole("button", { name: "Try again" });
      b.click();
      b.click();
    });
    const renders = posts.filter((p) => p.url === `${STUDIO_PATH}/render`);
    expect(renders).toEqual([{ url: `${STUDIO_PATH}/render`, body: { message_id: "m-t1", thread_id: "t1" } }]);
    views.t1 = view("t1", "rendering");
    await act(async () => gate.resolve(res({ ok: true })));
    await waitFor(() => expect((ads()[0]).getAttribute("data-state")).toBe("making"));
  });

  it("a Try again that dies on a gateway timeout keeps the ad, never says nothing was charged, and a second press still asks once", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "failed") };
    renderAnswer = async () => ({ ok: false, status: 504, json: async () => { throw new Error("not json"); } });
    await mount();
    await act(async () => {
      within(ads()[0]).getByRole("button", { name: "Try again" }).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(ads()[0].textContent).toContain("Zavi could not confirm this video started."));
    expect(ads()[0].textContent).toContain("you are only charged for a video that is made");
    expect(ads()).toHaveLength(1);
    expect(ads()[0].textContent).not.toMatch(/could not start|nothing was charged|not charged/i);

    renderAnswer = { body: { ok: true } };
    views.t1 = view("t1", "rendering");
    await act(async () => {
      within(ads()[0]).getByRole("button", { name: "Try again" }).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(ads()[0].getAttribute("data-state")).toBe("making"));
    expect(posts.filter((p) => p.url === `${STUDIO_PATH}/render`)).toHaveLength(2);
  });

  it("a Try again that times out at the gateway but did start shows the ad as making, not as failed", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "failed") };
    renderAnswer = async () => {
      views.t1 = view("t1", "rendering");
      return { ok: false, status: 504, json: async () => { throw new Error("not json"); } };
    };
    await mount();
    await act(async () => {
      within(ads()[0]).getByRole("button", { name: "Try again" }).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(ads()[0].getAttribute("data-state")).toBe("making"));
    expect(ads()[0].textContent).not.toMatch(/could not confirm|not charged/i);
  });

  it.each([
    [504, { error: { message: "upstream request timeout" } }, "Zavi could not confirm this video started.", "upstream request timeout"],
    [502, { message: "Bad gateway" }, "Zavi could not confirm this video started.", "Bad gateway"],
    [503, { error: { code: "video_unavailable", message: "Video making is off right now." } }, "Video making is off right now.", "could not confirm"],
    [500, { error: { code: "internal", message: "boom" } }, "Zavi could not confirm this video started.", "boom"],
    [404, {}, "Zavi could not start this video. Try again.", "could not confirm"],
  ])("a Try again answered %i tells a gateway failure from Zavi's own refusal", async (status, body, shown, hidden) => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "failed") };
    renderAnswer = { body, status };
    await mount();
    await act(async () => {
      within(ads()[0]).getByRole("button", { name: "Try again" }).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(ads()[0].textContent).toContain(shown));
    expect(ads()[0].textContent).not.toContain(hidden);
  });

  it("a stalled video's preview tile says it is taking longer, in a neutral badge, and agrees with the card body", async () => {
    threads = [
      { id: "t1", title: "Stalled ad", last_message_at: "2026-10-26T00:00:00Z" },
      { id: "t2", title: "Failed ad", last_message_at: "2026-10-25T00:00:00Z" },
    ];
    views = { t1: view("t1", "stalled"), t2: view("t2", "failed") };
    await mount();
    const stalled = ads().find((a) => adId(a) === "suggested-ad-thread-t1")!;
    const failed = ads().find((a) => adId(a) === "suggested-ad-thread-t2")!;
    const tile = within(stalled).getByTestId("suggested-ad-placeholder");
    const badge = within(tile).getByText("Taking longer");
    expect(badge.className).not.toContain("coral");
    expect(tile.textContent).toContain("Press Try again to check on it.");
    expect(tile.textContent).not.toContain("Not made");
    expect(tile.textContent).not.toContain("Press Try again to make it.");
    const failedTile = within(failed).getByTestId("suggested-ad-placeholder");
    expect(within(failedTile).getByText("Not made").className).toContain("text-coral");
    expect(failedTile.textContent).toContain("Press Try again to make it.");
    expect(failedTile.textContent).not.toContain("Taking longer");
  });

  it("a studio draft whose render never started is not made yet, not failed, and Make video starts that draft once", async () => {
    threads = [
      { id: "t1", title: "Planner ad", last_message_at: "2026-10-26T00:00:00Z" },
      { id: "t2", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" },
    ];
    views = { t1: view("t1", null), t2: view("t2", "done") };
    channelsBody = { channels: [{ channel_slug: SLUG, video_credits_each: 1700 }] };
    const gate = deferred();
    renderAnswer = () => gate.promise;
    await mount();
    const draft = ads().find((a) => adId(a) === "suggested-ad-thread-t1")!;
    expect(ads().find((a) => adId(a) === "suggested-ad-thread-t2")!.getAttribute("data-state")).toBe("ready");
    expect(draft.getAttribute("data-state")).toBe("draft");
    const preview = within(draft).getByTestId("suggested-ad-placeholder");
    expect(preview.textContent).toContain("Not made yet");
    expect(preview.textContent).toContain("Your video shows here once you make it.");
    expect(draft.textContent).not.toContain("Press Try again to make it.");
    expect(within(draft).queryByRole("button", { name: "Try again" })).toBeNull();
    await waitFor(() => expect(within(draft).getByTestId("suggested-ad-cost").textContent).toBe("About 900 credits, charged only if the video arrives."));
    await act(async () => {
      const b = within(draft).getByRole("button", { name: "Make video" });
      b.click();
      b.click();
    });
    expect(posts.filter((p) => p.url === `${STUDIO_PATH}/render`)).toEqual([{ url: `${STUDIO_PATH}/render`, body: { message_id: "m-t1", thread_id: "t1" } }]);
    expect(posts.filter((p) => p.url !== `${STUDIO_PATH}/render`)).toEqual([]);
    views.t1 = view("t1", "rendering");
    await act(async () => gate.resolve(res({ ok: true })));
    await waitFor(() => expect(ads().find((a) => adId(a) === "suggested-ad-thread-t1")!.getAttribute("data-state")).toBe("making"));
  });

  it("Make video refused with 409 already_rendered reloads the thread so the card leaves draft, and sends no second render", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-26T00:00:00Z" }];
    views = { t1: view("t1", null) };
    renderAnswer = { body: { error: { code: "already_rendered", message: "This video is already being made or is done. Press Edit to change the ad." } }, status: 409 };
    await mount();
    expect(ads()[0].getAttribute("data-state")).toBe("draft");
    views.t1 = view("t1", "rendering");
    await act(async () => {
      within(ads()[0]).getByRole("button", { name: "Make video" }).click();
    });
    await waitFor(() => expect(ads()[0].getAttribute("data-state")).toBe("making"));
    expect(posts.filter((p) => p.url === `${STUDIO_PATH}/render`)).toHaveLength(1);
  });

  it("Try again whose reload fails shows the ad as making, never a second Try again, and picks the video up once the read recovers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "failed") };
    let down = false;
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      down && String(url) === `${STUDIO_PATH}?thread_id=t1` ? res({}, 500) : base(url, init),
    );
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ads()[0].getAttribute("data-state")).toBe("failed");
    down = true;
    await act(async () => {
      within(ads()[0]).getByRole("button", { name: "Try again" }).click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(posts.filter((p) => p.url === `${STUDIO_PATH}/render`)).toHaveLength(1);
    expect(ads()[0].getAttribute("data-state")).toBe("making");
    expect(within(ads()[0]).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(ads()[0].textContent).not.toContain("Press Try again to make it.");
    down = false;
    views.t1 = view("t1", "done");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS);
    });
    expect(ads()[0].getAttribute("data-state")).toBe("ready");
  });
});

describe("VideoOverview suggested starters", () => {
  it("Make video approves the starter once even on a double click", async () => {
    channel.actions = [card("s1")];
    const gate = deferred();
    approveAnswer = () => gate.promise;
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    expect(within(ads()[0]).getByRole("heading").textContent).toBe("Why it takes 20 seconds");
    await act(async () => {
      const b = within(ads()[0]).getByRole("button", { name: "Make video" });
      b.click();
      b.click();
    });
    expect(posts.filter((p) => p.url.endsWith("/approve"))).toHaveLength(1);
    await act(async () => gate.resolve(res({ ok: true, exec_status: "queued" })));
    await waitFor(() => expect((ads()[0]).getAttribute("data-state")).toBe("making"));
    expect(channel.refreshSilent).toHaveBeenCalled();
  });

  it("a plan-locked channel upgrades instead of approving", async () => {
    channel.actions = [card("s1")];
    const lock: ChannelPlanLock = { tierName: "Starter", upgrade: vi.fn() };
    await mount((n) => <ChannelPlanLockProvider value={lock}>{n}</ChannelPlanLockProvider>);
    await waitFor(() => expect(ads()).toHaveLength(1));
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    expect(lock.upgrade).toHaveBeenCalledTimes(1);
    expect(posts.filter((p) => p.url.endsWith("/approve"))).toHaveLength(0);
  });

  it("a starter refused for credits shows the credit line and Top up", async () => {
    channel.actions = [card("s1")];
    approveAnswer = { body: { error: { code: "insufficient_credits", message: "no credits" } }, status: 402 };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    await waitFor(() => expect(within(ads()[0]).getByTestId("suggested-ad-top-up")).toBeTruthy());
    expect((ads()[0]).getAttribute("data-state")).toBe("draft");
  });

  it("a starter that failed for a temporary reason says Press Try again, and Try again approves it once on a double click", async () => {
    channel.actions = [card("s1", { exec_status: "failed", exec_bucket: "temporary", exec_code: "provider_timeout" })];
    const gate = deferred();
    approveAnswer = () => gate.promise;
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    const ad = ads()[0];
    expect(ad.getAttribute("data-state")).toBe("failed");
    const tile = within(ad).getByTestId("suggested-ad-placeholder");
    expect(tile.textContent).toContain("Press Try again to make it.");
    expect(tile.textContent).not.toContain("Edit it or ask Zavi for a new one.");
    expect(within(ad).queryByRole("button", { name: "Make video" })).toBeNull();
    expect(within(ad).getByTestId("suggested-ad-cost").textContent).toContain("1,500 credits");
    expect(within(ad).queryByTestId("suggested-ad-top-up")).toBeNull();
    await act(async () => {
      const b = within(ad).getByRole("button", { name: "Try again" });
      b.click();
      b.click();
    });
    expect(posts.filter((p) => p.url.endsWith("/approve"))).toHaveLength(1);
    expect(posts.filter((p) => p.url.endsWith("/approve"))[0].url).toContain("s1");
    await act(async () => gate.resolve(res({ ok: true, exec_status: "queued" })));
    expect(posts.filter((p) => p.url.endsWith("/approve"))).toHaveLength(1);
  });

  it("a starter that failed for good says Edit it or ask Zavi and offers no Try again or Make video", async () => {
    channel.actions = [card("s1", { exec_status: "failed", exec_bucket: "blocked_on_us", exec_code: "content_policy" })];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    const ad = ads()[0];
    expect(ad.getAttribute("data-state")).toBe("failed");
    const tile = within(ad).getByTestId("suggested-ad-placeholder");
    expect(tile.textContent).toContain("Edit it or ask Zavi for a new one.");
    expect(tile.textContent).not.toContain("Press Try again");
    expect(within(ad).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(ad).queryByRole("button", { name: "Make video" })).toBeNull();
    expect(within(ad).queryByTestId("suggested-ad-cost")).toBeNull();
    expect(posts.filter((p) => p.url.endsWith("/approve"))).toHaveLength(0);
  });

  it("a starter that failed for credits shows Top up and Try again, and Try again approves once and shows the credit refusal if still short", async () => {
    channel.actions = [card("s1", { exec_status: "failed", exec_bucket: "needs_founder", exec_code: "insufficient_credits" })];
    approveAnswer = { body: { error: { code: "insufficient_credits", message: "no credits" } }, status: 402 };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    const ad = ads()[0];
    expect(within(ad).getByText("Not enough credits for this video. Nothing was charged.")).toBeTruthy();
    expect(within(ad).getByTestId("suggested-ad-top-up")).toBeTruthy();
    expect(within(ad).getByTestId("suggested-ad-placeholder").textContent).toContain("Press Try again to make it.");
    expect(within(ad).queryByRole("button", { name: "Make video" })).toBeNull();
    expect(within(ad).getByTestId("suggested-ad-cost").textContent).toContain("1,500 credits");
    await act(async () => {
      const b = within(ad).getByRole("button", { name: "Try again" });
      b.click();
      b.click();
    });
    await waitFor(() => expect(within(ads()[0]).getByRole("alert").textContent).toBeTruthy());
    expect(posts.filter((p) => p.url.endsWith("/approve"))).toHaveLength(1);
    expect(ads()[0].getAttribute("data-state")).toBe("failed");
    expect(within(ads()[0]).getByTestId("suggested-ad-top-up")).toBeTruthy();
    expect(within(ads()[0]).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  const HOOKS = ["Here is the first line.", "Nobody tells you this.", "Stop scrolling for a second."];
  const hookedCard = () => card("s1", {
    body: {
      video_format: "talking_head",
      cost_credits: 1500,
      hooks: HOOKS,
      step: { deliverable: { content: "Here is the first line. Then the rest of it." } },
    } as unknown as ChannelActionView["body"],
  });
  const approvals = () => posts.filter((p) => p.url.endsWith("/approve"));
  const chips = () => within(within(ads()[0]).getByRole("radiogroup", { name: "Pick the hook" })).getAllByRole("radio");

  it("a starter with three hooks shows them as chips, and Make video on the untouched first hook approves the card once", async () => {
    channel.actions = [hookedCard()];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    expect(chips().map((c) => c.textContent)).toEqual(HOOKS);
    expect(chips().map((c) => c.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(within(ads()[0]).getByTestId("suggested-ad-preview-hook").textContent).toContain(HOOKS[0]);
    await act(async () => {
      const b = within(ads()[0]).getByRole("button", { name: "Make video" });
      b.click();
      b.click();
    });
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0].url).toContain("s1");
    expect(messagePosts()).toHaveLength(0);
  });

  it("picking another hook chip makes the video word for word as a new ad, never approving the card", async () => {
    channel.actions = [hookedCard()];
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    expect(within(ads()[0]).getByTestId("suggested-ad-cost").textContent).toContain("1,500 credits");
    fireEvent.click(chips()[2]);
    expect(within(ads()[0]).getByTestId("suggested-ad-preview-hook").textContent).toContain(HOOKS[2]);
    expect(within(ads()[0]).getByTestId("suggested-ad-cost").textContent).toBe("About 1,500 credits for the suggested script. Yours is priced by its length, charged only if the video arrives.");
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    expect(approvals()).toHaveLength(0);
    expect(messagePosts()).toHaveLength(1);
    expect(messagePosts()[0].body).toEqual({ text: `${HOOKS[2]} Then the rest of it.`, verbatim: true, new_thread: true });
  });

  it("Edit opens in the card, not the composer; Save with hook 2 and a new script makes exactly that text", async () => {
    channel.actions = [hookedCard()];
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(input().value).toBe("");
    const form = screen.getByRole("form", { name: /^Edit "/ });
    fireEvent.change(within(form).getByLabelText("Hook 2"), { target: { value: "Your mornings are lying to you." } });
    fireEvent.click(within(form).getByRole("radio", { name: "Use hook 2" }));
    fireEvent.change(within(form).getByLabelText("Script"), { target: { value: "  We fixed that in one tap.  " } });
    fireEvent.submit(form);
    expect(screen.queryByRole("form")).toBeNull();
    expect(chips()[1].textContent).toBe("Your mornings are lying to you.");
    expect(chips()[1].getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    expect(approvals()).toHaveLength(0);
    expect(messagePosts().map((p) => p.body)).toEqual([{ text: "Your mornings are lying to you. We fixed that in one tap.", verbatim: true, new_thread: true }]);
  });

  it("Cancel throws the edit away and Make video still approves the untouched card", async () => {
    channel.actions = [hookedCard()];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form");
    fireEvent.change(within(form).getByLabelText("Script"), { target: { value: "Something else entirely" } });
    fireEvent.click(within(form).getByRole("radio", { name: "Use hook 3" }));
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(chips().map((c) => c.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(ads()[0].textContent).not.toContain("Something else entirely");
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    expect(approvals()).toHaveLength(1);
    expect(messagePosts()).toHaveLength(0);
  });

  it("a studio draft with alt hooks makes the picked one in the same thread, word for word", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    const v = view("t1", null);
    v.messages[1].draft = { ...DRAFT, hook: "Stop wasting mornings.", alt_hooks: ["Mornings are broken.", "Stop wasting mornings."] } as never;
    views = { t1: v };
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    expect(chips().map((c) => c.textContent)).toEqual(["Stop wasting mornings.", "Mornings are broken."]);
    fireEvent.click(chips()[1]);
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    expect(messagePosts().map((p) => p.body)).toEqual([{ text: "Mornings are broken. Our app plans your day in one tap.", verbatim: true, thread_id: "t1" }]);
  });
});

describe("VideoOverview keeps everything the Ideas tab had", () => {
  it("shows a video idea from a channel run, not only the starter run, with its price, Ask Zavi and no Dismiss", async () => {
    startersGet = { run_id: null };
    channel.actions = [card("c1", { run_id: "channel-run" })];
    apiFetch.mockImplementationOnce(async () => res({ threads: [] }));
    const opened: ChannelChatPin[] = [];
    await mount((n) => <ChannelChatProvider open={(p) => opened.push(p)}>{n}</ChannelChatProvider>);
    await waitFor(() => expect(ads()).toHaveLength(1));
    expect(ads()[0].getAttribute("data-state")).toBe("draft");
    expect(within(ads()[0]).getByTestId("suggested-ad-cost").textContent).toContain("1,500 credits");
    expect(within(ads()[0]).getByRole("heading").textContent).toBe("Why it takes 20 seconds");
    expect(within(ads()[0]).queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Ask Zavi" }));
    expect(opened).toHaveLength(1);
    const pin = opened[0];
    expect(pin.target === "channel" && pin.draft?.text).toBe(`About the AI UGC ad "Why it takes 20 seconds". Its script:\nHere is the first line. Then the rest of it.\n\n`);
    expect(posts).toHaveLength(0);
    expect(apiFetch.mock.calls.some(([u]) => String(u).startsWith("/api/channel-actions/"))).toBe(false);
    expect(ads()).toHaveLength(1);
  });

  it("marks only the card Zavi started on its own as the first video it is making, says it is charged only if it arrives, and the subtitle stops saying nothing is made", async () => {
    startersGet = { run_id: RUN, first_video_used: true, first_video_action_id: "auto-1" };
    channel.actions = [card("auto-1", { exec_status: "queued" }), card("other-1", { exec_status: "queued" }), card("draft-1")];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(3));
    const byId = (id: string) => ads().find((a) => adId(a) === `suggested-ad-starter-${id}`)!;
    expect(byId("auto-1").getAttribute("data-state")).toBe("making");
    expect(within(byId("auto-1")).getByTestId("suggested-ad-free").textContent).toBe("Zavi is making this first one now. It is charged only if it arrives.");
    expect(within(byId("other-1")).queryByTestId("suggested-ad-free")).toBeNull();
    expect(within(byId("draft-1")).queryByTestId("suggested-ad-free")).toBeNull();
    const sub = screen.getByTestId("suggested-ads-subtitle").textContent;
    expect(sub).toBe("Zavi is making the first one now. It is charged only if it arrives.");
    expect(document.body.textContent).not.toMatch(/\bfree\b/i);
    expect(sub).not.toContain("Nothing is made until you do");
  });

  it("never promises nothing is made when no card was started by Zavi, and says Suggest makes the first one", async () => {
    startersGet = { run_id: RUN, first_video_used: false, first_video_action_id: null };
    channel.actions = [card("other-1", { exec_status: "queued" }), card("draft-1")];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(2));
    expect(screen.queryByTestId("suggested-ad-free")).toBeNull();
    expect(screen.getByTestId("suggested-ads-subtitle").textContent).toBe("Pick a hook on any ad and make it.");
    await waitFor(() => expect(screen.getByTestId("suggest-ads")).toBeTruthy());
    expect(document.body.textContent).toContain("Zavi writes a few ads and makes the first one right away. It is charged only if it arrives.");
    expect(document.body.textContent).not.toContain("Nothing is made until you do");
  });

  it("shows only the one subtitle line under the Suggested ads heading once the first video is used", async () => {
    startersGet = { run_id: RUN, first_video_used: true, first_video_action_id: null };
    channel.actions = [card("c1")];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("suggest-ads")).toBeTruthy());
    const section = screen.getByTestId("suggested-ads");
    const lines = [...section.querySelectorAll("p")].filter((el) => !ads().some((ad) => ad.contains(el))).map((el) => el.textContent);
    expect(lines).toEqual(["Pick a hook on any ad and make it."]);
    expect(section.textContent).not.toContain("Autopilot");
    expect(section.textContent).not.toContain("right away");
  });

  it("a non-video next step shows under Zavi needs you and its done button records it once", async () => {
    channel.actions = [
      card("n1", {
        executable: false,
        title: "Confirm the refund wording",
        done_label: "I checked it",
        body: { step: { body: "Check the policy page says 24 hours." } } as unknown as ChannelActionView["body"],
      }),
    ];
    await mount();
    const step = await screen.findByTestId("next-step");
    expect(ads()).toHaveLength(0);
    expect(step.textContent).toContain("Check the policy page says 24 hours.");
    await act(async () => {
      const b = within(step).getByRole("button", { name: "I checked it" });
      b.click();
      b.click();
    });
    const acted = posts.filter((p) => p.url === "/api/channel-actions/n1");
    expect(acted).toHaveLength(1);
    expect(acted[0].body.action).toBe("acted");
    await waitFor(() => expect(screen.queryByTestId("next-step")).toBeNull());
  });

  it("an answer card under Zavi needs you takes a typed reply, sends it once as an answer and never marks the card done", async () => {
    channel.actions = [
      card("q1", {
        executable: false,
        card_kind: "task",
        title: "Who is the voice in your ads?",
        primary_label: "Reply",
        done_label: "Sent",
        body: { step: { intent: "answer", body: "Tell Zavi which presenter to use." } } as unknown as ChannelActionView["body"],
      }),
    ];
    await mount();
    const step = await screen.findByTestId("next-step");
    expect(within(step).queryByRole("button", { name: "Sent" })).toBeNull();
    expect(within(step).queryByRole("textbox")).toBeNull();
    await act(async () => fireEvent.click(within(step).getByRole("button", { name: "Reply" })));
    const box = within(step).getByRole("textbox", { name: "Your answer" });
    const send = within(step).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "  Use Maya, the founder.  " } });
    expect(send.disabled).toBe(false);
    await act(async () => {
      send.click();
      send.click();
    });
    const redo = posts.filter((p) => p.url === "/api/channel-actions/q1/redo");
    expect(redo).toEqual([{ url: "/api/channel-actions/q1/redo", body: { note: "Use Maya, the founder.", kind: "answer" } }]);
    expect(posts.filter((p) => p.url === "/api/channel-actions/q1")).toHaveLength(0);
    await waitFor(() => expect(screen.queryByTestId("next-step")).toBeNull());
    expect(channel.refreshSilent).toHaveBeenCalled();
  });

  it("a failed answer keeps the typed reply and says so plainly", async () => {
    channel.actions = [
      card("q1", {
        executable: false,
        card_kind: "task",
        title: "Who is the voice in your ads?",
        primary_label: "Reply",
        done_label: "Sent",
        body: { intent: "answer" } as unknown as ChannelActionView["body"],
      }),
    ];
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      String(url) === "/api/channel-actions/q1/redo" ? res({ error: { code: "boom", message: "HTTP 500" } }, 500) : base(url, init),
    );
    await mount();
    const step = await screen.findByTestId("next-step");
    await act(async () => fireEvent.click(within(step).getByRole("button", { name: "Reply" })));
    fireEvent.change(within(step).getByRole("textbox", { name: "Your answer" }), { target: { value: "Use Maya" } });
    await act(async () => fireEvent.click(within(step).getByRole("button", { name: "Send" })));
    await waitFor(() => expect(step.textContent).toContain("Zavi could not send that. Try again."));
    expect((within(step).getByRole("textbox", { name: "Your answer" }) as HTMLTextAreaElement).value).toBe("Use Maya");
    expect(document.body.textContent).not.toContain("HTTP 500");
    expect(screen.getByTestId("next-step")).toBeTruthy();
  });

  it("an answer the plan refuses opens the upgrade path instead of asking to try again", async () => {
    channel.actions = [
      card("q1", {
        executable: false,
        card_kind: "task",
        title: "Who is the voice in your ads?",
        primary_label: "Reply",
        done_label: "Sent",
        body: { intent: "answer" } as unknown as ChannelActionView["body"],
      }),
    ];
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      String(url) === "/api/channel-actions/q1/redo" ? res({ error: { code: "plan_upgrade_required", required_tier: "growth", message: "Needs Growth." } }, 403) : base(url, init),
    );
    const upgrade = vi.fn();
    await mount((n) => <ChannelPlanLockProvider value={{ tierName: null, upgrade }}>{n}</ChannelPlanLockProvider>);
    const step = await screen.findByTestId("next-step");
    await act(async () => fireEvent.click(within(step).getByRole("button", { name: "Reply" })));
    fireEvent.change(within(step).getByRole("textbox", { name: "Your answer" }), { target: { value: "Use Maya" } });
    await act(async () => fireEvent.click(within(step).getByRole("button", { name: "Send" })));
    await waitFor(() => expect(upgrade).toHaveBeenCalledWith("growth"));
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(step.textContent).not.toContain("Zavi could not send that. Try again.");
    expect((within(step).getByRole("textbox", { name: "Your answer" }) as HTMLTextAreaElement).value).toBe("Use Maya");
  });

  it("Suggest new ads starts one starter run on a double click and shows the scripts being written", async () => {
    startersGet = { run_id: null };
    const gate = deferred();
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url) === `/api/channels/${SLUG}/starters` && init?.method === "POST") {
        posts.push({ url: String(url), body: {} });
        await gate.promise;
        return res({ run_id: "run-new" });
      }
      return base(url, init);
    });
    await mount();
    const button = await screen.findByTestId("suggest-ads");
    await act(async () => {
      button.click();
      button.click();
    });
    expect(posts.filter((p) => p.url === `/api/channels/${SLUG}/starters`)).toHaveLength(1);
    expect(screen.getByTestId("suggest-ads").textContent).toBe("Starting…");
    await act(async () => gate.resolve(undefined));
    await waitFor(() => expect(ads()).toHaveLength(5));
    expect(ads().every((a) => a.getAttribute("data-state") === "making")).toBe(true);
    expect(screen.getAllByTestId("suggested-ad-stage").map((e) => e.textContent)).toEqual(Array(5).fill("Writing the script…"));
    expect(screen.queryAllByTestId("suggested-ad-progress")).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: /Making it/ })).toHaveLength(0);
    expect(screen.getByTestId("suggest-ads").textContent).toBe("Writing new ads…");
    expect((screen.getByTestId("suggest-ads") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an empty suggest run with ads waiting says why and never points at Zavi needs you", async () => {
    startersGet = { run_id: RUN, run_status: "completed", last_empty: true };
    channel.actions = ["a", "b", "c", "d", "e"].map((id) => card(id));
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(5));
    await waitFor(() => expect(document.body.textContent).toContain("No new ads: each format already has an ad waiting. Make or dismiss one to get new ideas."));
    expect(document.body.textContent).not.toMatch(/Zavi needs you|finished without any ads/);
  });

  it("an empty suggest run counts only ads not yet made as waiting", async () => {
    startersGet = { run_id: RUN, run_status: "completed", last_empty: true };
    channel.actions = [card("a", { exec_status: "queued" }), card("b", { exec_status: "failed" })];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(2));
    expect(document.body.textContent).toContain("The last suggestion finished without any ads. If Zavi needs you above, do that first.");
    expect(document.body.textContent).not.toContain("each format already has an ad waiting");
  });

  it("an empty suggest run with no ads waiting keeps the Zavi needs you line", async () => {
    startersGet = { run_id: RUN, run_status: "completed", last_empty: true };
    channel.actions = [];
    await mount();
    await screen.findByTestId("suggest-ads");
    await waitFor(() => expect(document.body.textContent).toContain("The last suggestion finished without any ads. If Zavi needs you above, do that first."));
    expect(document.body.textContent).not.toContain("each format already has an ad waiting");
  });

  it("the empty-run hint is hidden while Suggest new ads is starting", async () => {
    startersGet = { run_id: RUN, run_status: "completed", last_empty: true };
    channel.actions = ["a", "b"].map((id) => card(id));
    const gate = deferred();
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url) === `/api/channels/${SLUG}/starters` && init?.method === "POST") {
        await gate.promise;
        return res({ run_id: "run-new" });
      }
      return base(url, init);
    });
    await mount();
    await waitFor(() => expect(document.body.textContent).toContain("each format already has an ad waiting"));
    await act(async () => {
      (await screen.findByTestId("suggest-ads")).click();
    });
    expect(screen.getByTestId("suggest-ads").textContent).toBe("Starting…");
    expect(document.body.textContent).not.toMatch(/each format already has an ad waiting|finished without any ads/);
    await act(async () => gate.resolve(undefined));
  });

  it("Suggest new ads on a locked plan upgrades and starts nothing", async () => {
    startersGet = { run_id: null };
    const lock: ChannelPlanLock = { tierName: "Starter", upgrade: vi.fn() };
    await mount((n) => <ChannelPlanLockProvider value={lock}>{n}</ChannelPlanLockProvider>);
    await act(async () => fireEvent.click(await screen.findByTestId("suggest-ads")));
    expect(lock.upgrade).toHaveBeenCalledTimes(1);
    expect(posts.filter((p) => p.url.endsWith("/starters"))).toHaveLength(0);
  });

  it("a starter run with no status that was not started here shows no writing placeholders", async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId("suggest-ads")).toBeTruthy());
    expect(ads()).toHaveLength(0);
  });
});

describe("VideoOverview loads more ads as you scroll", () => {
  class IO {
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
      observers.push(cb);
    }
    observe() {}
    disconnect() {}
  }
  const viewReads = () => apiFetch.mock.calls.filter(([u]) => String(u).startsWith(`${STUDIO_PATH}?thread_id=`)).length;

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", IO);
    for (let i = 0; i < 10; i++) {
      threads.push({ id: `t${i}`, title: `Ad ${i}`, last_message_at: "2026-10-26T10:00:00Z" });
      views[`t${i}`] = view(`t${i}`, null);
    }
  });

  it("reads only the first page, then the next page when the end comes into view", async () => {
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(6));
    expect(viewReads()).toBe(6);
    expect(screen.getByTestId("suggested-ads-sentinel")).toBeTruthy();
    await act(async () => observers[observers.length - 1]([{ isIntersecting: false }]));
    expect(viewReads()).toBe(6);
    await act(async () => observers[observers.length - 1]([{ isIntersecting: true }]));
    await waitFor(() => expect(ads()).toHaveLength(10));
    expect(viewReads()).toBe(10);
    expect(screen.queryByTestId("suggested-ads-sentinel")).toBeNull();
  });

  it("shows loading cards while the next page is read", async () => {
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(6));
    const gate = deferred();
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url).startsWith(`${STUDIO_PATH}?thread_id=`)) await gate.promise;
      return base(url, init);
    });
    await act(async () => observers[observers.length - 1]([{ isIntersecting: true }]));
    expect(screen.getAllByTestId("suggested-ads-more")).toHaveLength(1);
    expect(screen.getByTestId("suggested-ads-more").querySelector("svg.animate-spin")).toBeTruthy();
    expect(ads()).toHaveLength(6);
    expect(screen.queryByTestId("suggested-ads-sentinel")).toBeNull();
    await act(async () => gate.resolve(undefined));
    await waitFor(() => expect(ads()).toHaveLength(10));
    expect(screen.queryAllByTestId("suggested-ads-more")).toHaveLength(0);
  });

  it("a view that fails to load stops the spinner, is retried once only, and scrolling on still reads the next page", async () => {
    const base = apiFetch.getMockImplementation()!;
    const reads = (id: string) => apiFetch.mock.calls.filter(([u]) => String(u) === `${STUDIO_PATH}?thread_id=${id}`).length;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url) === `${STUDIO_PATH}?thread_id=t2`) return res({ error: "boom" }, 500);
      if (String(url) === `${STUDIO_PATH}?thread_id=t4`) throw new Error("network");
      return base(url, init);
    });
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(4));
    await waitFor(() => expect(screen.queryAllByTestId("suggested-ads-more")).toHaveLength(0));
    expect(screen.getByTestId("suggested-ads-sentinel")).toBeTruthy();
    expect(reads("t2")).toBe(2);
    expect(reads("t4")).toBe(2);
    expect(document.getElementById("suggested-ad-thread-t2")).toBeNull();
    expect(screen.getByText("Some of your ads could not be loaded. Refresh the page.")).toBeTruthy();
    expect(viewReads()).toBe(8);
    await act(async () => observers[observers.length - 1]([{ isIntersecting: true }]));
    await waitFor(() => expect(ads()).toHaveLength(8));
    expect(["t6", "t7", "t8", "t9"].map(reads)).toEqual([1, 1, 1, 1]);
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(reads("t2")).toBe(2);
    expect(reads("t4")).toBe(2);
    expect(viewReads()).toBe(12);
    expect(screen.queryAllByTestId("suggested-ads-more")).toHaveLength(0);
  });

  it("the latest suggestion's ads show on the first page above older ads, not after every thread", async () => {
    channel.actions = [card("fresh-1")];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(6));
    expect(adId(ads()[0])).toBe("suggested-ad-starter-fresh-1");
    expect(viewReads()).toBe(5);
  });

  it("cards newer than the older studio threads, made by Home chat outside the starter run, show first and no older thread jumps ahead", async () => {
    threads.length = 0;
    for (let i = 0; i < 12; i++) {
      threads.push({ id: `t${i}`, title: `Ad ${i}`, last_message_at: "2026-10-10T10:00:00Z" });
      views[`t${i}`] = view(`t${i}`, null);
    }
    channel.actions = [1, 2, 3, 4, 5].map((n) => card(`chat-${n}`, { run_id: `chat-run-${n}`, proposed_at: `2026-10-26T1${n}:00:00Z` }));
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(6));
    expect(ads().map(adId)).toEqual([5, 4, 3, 2, 1].map((n) => `suggested-ad-starter-chat-${n}`).concat("suggested-ad-thread-t0"));
    expect(viewReads()).toBe(1);
    await act(async () => observers[observers.length - 1]([{ isIntersecting: true }]));
    await waitFor(() => expect(ads()).toHaveLength(12));
    expect(ads().slice(5).map(adId)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6"].map((id) => `suggested-ad-thread-${id}`));
  });

  it("opening an ad from the Library that sits past the first page loads it and scrolls to it", async () => {
    await mount(undefined, "t9");
    await waitFor(() => expect(scrolled.some((el) => el.id === "suggested-ad-thread-t9")).toBe(true));
  });
});

describe("VideoOverview ad cards", () => {
  const starterWithHooks = () => card("s1", {
    body: {
      video_format: "talking_head",
      cost_credits: 1500,
      hooks: ["Here is the first line.", "Nobody tells you this.", "Stop scrolling for a second."],
      step: { deliverable: { content: "Here is the first line. Then the rest of it." } },
    } as unknown as ChannelActionView["body"],
  });

  it("a script typed in the composer is split into its hook and the rest, not shown as a note", async () => {
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    type("Stop wasting mornings. Our app plans your day in one tap.");
    await act(async () => fireEvent.click(generate()));
    const item = ads()[0];
    expect(item.getAttribute("data-state")).toBe("making");
    expect(within(item).getByRole("heading").textContent).toBe("Stop wasting mornings.");
    expect(within(item).getByTestId("suggested-ad-hook").textContent).toBe("Stop wasting mornings.");
    expect(within(item).getByTestId("suggested-ad-script").textContent).toBe("Stop wasting mornings. Our app plans your day in one tap.");
    expect(item.textContent!.split("Our app plans your day in one tap.").length - 1).toBe(1);
    expect(within(item).queryByRole("radiogroup")).toBeNull();
  });

  it("the stage line of a composer ad moves on every stage while its status line stays for screen readers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    type("Say exactly this line, word for word.");
    await act(async () => {
      fireEvent.click(generate());
      await vi.advanceTimersByTimeAsync(0);
    });
    const stage = () => screen.getByTestId("suggested-ad-stage").textContent;
    expect(stage()).toBe("Writing the script");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAGE_MS);
    });
    expect(stage()).toBe("Picking scenes");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAGE_MS);
    });
    expect(stage()).toBe("Adding the voice");
    const status = screen.getByTestId("suggested-ad-status");
    expect(status.textContent).toBe("Making your ad from your script, word for word.");
    expect(status.className.split(" ")).toContain("sr-only");
    expect(stage()!.includes("...")).toBe(false);
  });

  it("a hook picked on a draft never leaks into the made ad: it shows the made hook, its video, Edit, and no chips or Ask Zavi", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    const draft = view("t1", null);
    draft.messages[1].draft = { ...DRAFT, hook: "Stop wasting mornings.", alt_hooks: ["Mornings are broken."] } as never;
    views = { t1: draft };
    messageAnswers = [{ body: { thread_id: "t1" } }];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    const radios = () => within(within(ads()[0]).getByRole("radiogroup", { name: "Pick the hook" })).getAllByRole("radio");
    fireEvent.click(radios()[1]);
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");
    const made = view("t1", "done");
    made.messages[1].draft = { ...DRAFT, script: "Mornings are broken. Our app plans your day in one tap.", hook: "Mornings are broken.", alt_hooks: ["Stop wasting mornings."] } as never;
    views = { t1: made };
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    await waitFor(() => expect(ads()[0].getAttribute("data-state")).toBe("ready"));
    const ready = ads()[0];
    expect(within(ready).getByRole("button", { name: "Play Planner ad" })).toBeTruthy();
    expect(within(ready).getByTestId("suggested-ad-hook").textContent).toBe("Mornings are broken.");
    expect(within(ready).queryByRole("radiogroup")).toBeNull();
    expect(within(ready).queryByRole("button", { name: "Ask Zavi" })).toBeNull();
    expect(within(ready).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(ready).getByRole("button", { name: "Download" })).toBeTruthy();
  });

  it("a making ad offers neither Ask Zavi nor Edit, while a not-made ad offers both", async () => {
    threads = [
      { id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" },
      { id: "t2", title: "Gym ad", last_message_at: "2026-10-24T00:00:00Z" },
    ];
    views = { t1: view("t1", "rendering"), t2: view("t2", null) };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(2));
    const making = ads().find((a) => a.getAttribute("data-state") === "making")!;
    const draft = ads().find((a) => a.getAttribute("data-state") === "draft")!;
    expect(within(making).queryByRole("button", { name: "Ask Zavi" })).toBeNull();
    expect(within(making).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(draft).getByRole("button", { name: "Ask Zavi" })).toBeTruthy();
    expect(within(draft).getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("the composer offers Make it shorter and Different presenter only once the ad being edited is ready", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "stalled") };
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const chipsShown = () => ["Make it shorter", "Different presenter"].map((n) => within(screen.getByTestId("video-studio-empty")).queryByRole("button", { name: n }) !== null);
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Ask Zavi" })));
    expect(screen.getByTestId("video-studio-editing").textContent).toContain("Planner ad");
    expect(chipsShown()).toEqual([false, false]);
    views.t1 = view("t1", "rendering");
    await act(async () => {
      fireEvent.click(within(ads()[0]).getByRole("button", { name: "Try again" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ads()[0].getAttribute("data-state")).toBe("making");
    expect(screen.getByTestId("video-studio-editing").textContent).toContain("Planner ad");
    expect(chipsShown()).toEqual([false, false]);
    views.t1 = view("t1", "done");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS);
    });
    expect(ads()[0].getAttribute("data-state")).toBe("ready");
    expect(chipsShown()).toEqual([true, true]);
  });

  async function editReadyAd() {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "stalled") };
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Ask Zavi" })));
    views.t1 = view("t1", "rendering");
    await act(async () => {
      fireEvent.click(within(ads()[0]).getByRole("button", { name: "Try again" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    views.t1 = view("t1", "done");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS);
    });
    expect(ads()[0].getAttribute("data-state")).toBe("ready");
    expect(screen.getByTestId("video-studio-editing").textContent).toContain("Planner ad");
    vi.useRealTimers();
    messageAnswers = [() => new Promise(() => undefined)];
    posts.length = 0;
  }

  it("a revise chip on a ready ad never carries the image staged in the composer, and the image stays staged for its own video", async () => {
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      String(url) === "/api/chat/upload-image" ? res({ image_path: "uploads/car.png" }) : base(url, init),
    );
    await editReadyAd();
    fireEvent.click(screen.getByRole("radio", { name: "Image to video" }));
    await act(async () => {
      fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [new File(["x"], "car.png", { type: "image/png" })] } });
    });
    await waitFor(() => expect(within(screen.getByTestId("video-studio-empty")).getByRole("button", { name: "Generate" }).hasAttribute("disabled")).toBe(false));
    await act(async () => fireEvent.click(within(screen.getByTestId("video-studio-empty")).getByRole("button", { name: "Make it shorter" })));
    expect(messagePosts()).toHaveLength(1);
    expect(messagePosts()[0].body).toEqual({ text: "Make it shorter", thread_id: "t1" });
    expect(screen.getByTestId("video-studio-attachment")).toBeTruthy();
  });

  it("a revise chip pressed while an image is still uploading sends the revision without the image", async () => {
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      String(url) === "/api/chat/upload-image" ? new Promise(() => undefined) : base(url, init),
    );
    await editReadyAd();
    fireEvent.click(screen.getByRole("radio", { name: "Image to video" }));
    await act(async () => {
      fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [new File(["x"], "car.png", { type: "image/png" })] } });
    });
    await act(async () => fireEvent.click(within(screen.getByTestId("video-studio-empty")).getByRole("button", { name: "Different presenter" })));
    expect(messagePosts()).toHaveLength(1);
    expect(messagePosts()[0].body).toEqual({ text: "Use a different presenter", thread_id: "t1" });
  });

  it("Save stays off while any hook or the script is empty, and a forced submit changes nothing", async () => {
    channel.actions = [starterWithHooks()];
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form");
    const save = () => within(form).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save().disabled).toBe(false);
    fireEvent.change(within(form).getByLabelText("Hook 2"), { target: { value: "   " } });
    expect(save().disabled).toBe(true);
    fireEvent.submit(form);
    expect(screen.getByRole("form")).toBe(form);
    fireEvent.change(within(form).getByLabelText("Hook 2"), { target: { value: "A new second hook." } });
    expect(save().disabled).toBe(false);
    fireEvent.change(within(form).getByLabelText("Script"), { target: { value: "" } });
    expect(save().disabled).toBe(true);
    const script = within(form).getByLabelText("Script");
    const hint = document.getElementById(script.getAttribute("aria-describedby")!);
    expect(hint?.textContent?.length).toBeGreaterThan(0);
    fireEvent.change(script, { target: { value: "Then the rest of it." } });
    expect(screen.getByTestId("video-overview-status").textContent).toBe("");
    fireEvent.submit(form);
    expect(screen.queryByRole("form")).toBeNull();
    const chips = within(within(ads()[0]).getByRole("radiogroup", { name: "Pick the hook" })).getAllByRole("radio");
    expect(chips.map((c) => c.textContent)).toEqual(["Here is the first line.", "A new second hook.", "Stop scrolling for a second."]);
    expect(screen.getByTestId("video-overview-status").textContent).toBe('Saved your changes to "Why it takes 20 seconds".');
    expect(posts.filter((p) => p.url.endsWith("/approve"))).toHaveLength(0);
    expect(messagePosts()).toHaveLength(0);
  });
});

describe("VideoOverview QA fixes", () => {
  const HOOKS = ["Here is the first line.", "Nobody tells you this.", "Stop scrolling for a second."];
  const hookedCard = (id = "s1") => card(id, {
    body: {
      video_format: "talking_head",
      cost_credits: 1500,
      hooks: HOOKS,
      step: { deliverable: { content: "Here is the first line. Then the rest of it." } },
    } as unknown as ChannelActionView["body"],
  });
  const approvals = () => posts.filter((p) => p.url.endsWith("/approve"));
  const renderPosts = () => posts.filter((p) => p.url === `${STUDIO_PATH}/render`);
  const chips = () => within(within(ads()[0]).getByRole("radiogroup", { name: "Pick the hook" })).getAllByRole("radio");
  const failView = (id: string, code: string | null) => {
    const v = view(id, "failed");
    v.renders[`r-${id}`].code = code;
    return v;
  };

  it.each([
    { label: "prompt on", promptOn: true, render: null as null | { error: string; code: string } },
    { label: "script, word for word", promptOn: false, render: null },
    { label: "draft accepted but the render refused", promptOn: true, render: { error: "This ad breaks the ad rules.", code: "refused_fake_testimonial" } },
  ])("a Generate the server refuses with a 200 stops announcing Making and announces the refusal ($label)", async ({ promptOn, render }) => {
    const ASK = "A customer giving a 5-star review saying she bought her cake from us and loved it";
    const REFUSAL = "Zavi will not make a fake customer testimonial. Try an ad in your own voice instead.";
    const v: StudioView = {
      thread_id: "t-ref",
      messages: [
        { id: "u-ref", role: "user", body: ASK, created_at: "2026-10-26T10:00:00Z", kind: null, draft: null, render_run_id: null, run_id: null },
        { id: "x-ref", role: "assistant", body: REFUSAL, created_at: "2026-10-26T10:00:05Z", kind: "video_studio_refused", draft: null, render_run_id: null, run_id: null },
      ],
      renders: {},
    };
    const gate = deferred();
    messageAnswers = [
      async () => {
        await gate.promise;
        views["t-ref"] = v;
        return res({
          thread_id: "t-ref",
          user_message: { id: "u-ref", thread_id: "t-ref", sender_role: "user", body: ASK, meta: {}, created_at: "2026-10-26T10:00:00Z" },
          reply: { id: "x-ref", thread_id: "t-ref", sender_role: "assistant", body: REFUSAL, meta: { kind: "video_studio_refused", code: "fake_testimonial" }, created_at: "2026-10-26T10:00:05Z" },
          render,
        });
      },
    ];
    await mount();
    if (promptOn) fireEvent.click(screen.getByRole("switch", { name: /Enable prompt/ }));
    type(ASK);
    await act(async () => fireEvent.click(generate()));
    const status = () => screen.getByTestId("video-overview-status");
    expect(status().getAttribute("role")).toBe("status");
    expect(status().textContent).toContain("Making");
    await act(async () => {
      gate.resolve(undefined);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("failed"));
    expect(messagePosts()).toHaveLength(1);
    expect(messagePosts()[0].body.verbatim).toBe(promptOn ? undefined : true);
    expect(status().textContent).not.toContain("Making");
    expect(status().textContent).toContain(render ? render.error : REFUSAL);
    expect(status().textContent).toContain("did not make");
  });

  it("a refused ad offers no Try again and sends no render", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    const v = view("t1", null);
    v.messages.push({ id: "x-t1", role: "assistant", body: "This video breaks the ad rules, so Zavi will not make it.", created_at: "2026-10-26T10:01:00Z", kind: "video_studio_refused", draft: null, render_run_id: null, run_id: null });
    views = { t1: v };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    expect(ads()[0].getAttribute("data-state")).toBe("failed");
    expect(within(ads()[0]).getByText("This video breaks the ad rules, so Zavi will not make it.")).toBeTruthy();
    expect(within(ads()[0]).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(ads()[0]).getByTestId("suggested-ad-placeholder").textContent).not.toContain("Try again");
    expect(renderPosts()).toHaveLength(0);
  });

  it("Make video on a second starter while the first is still being approved approves both", async () => {
    channel.actions = [card("s1"), card("s2", { title: "Explainer: Second idea" })];
    const gate = deferred();
    approveAnswer = () => gate.promise;
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(2));
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    await act(async () => fireEvent.click(within(ads()[1]).getByRole("button", { name: "Make video" })));
    expect(approvals().map((p) => p.url)).toEqual(["/api/channel-actions/s1/approve", "/api/channel-actions/s2/approve"]);
    await act(async () => gate.resolve(res({ ok: true, exec_status: "queued" })));
  });

  it("arrow keys move the hook choice and focus, with one tab stop", async () => {
    channel.actions = [hookedCard()];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    expect(chips().map((c) => c.tabIndex)).toEqual([0, -1, -1]);
    chips()[0].focus();
    fireEvent.keyDown(chips()[0], { key: "ArrowRight" });
    expect(chips().map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(document.activeElement).toBe(chips()[1]);
    expect(chips().map((c) => c.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(chips()[1], { key: "End" });
    expect(document.activeElement).toBe(chips()[2]);
    fireEvent.keyDown(chips()[2], { key: "ArrowDown" });
    expect(chips()[0].getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(chips()[0]);
    fireEvent.keyDown(chips()[0], { key: "ArrowUp" });
    expect(chips()[2].getAttribute("aria-checked")).toBe("true");
    expect(within(ads()[0]).getByTestId("suggested-ad-preview-hook").textContent).toContain(HOOKS[2]);
    expect(posts).toHaveLength(0);
  });

  it("a render that failed for credits says so and Top up opens billing in place for an owner", async () => {
    const openTab = vi.fn();
    ws.value = { role: "owner", openTab };
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: failView("t1", "insufficient_credits") };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    expect(within(ads()[0]).getByText("Not enough credits for this video. Nothing was charged.")).toBeTruthy();
    const top = within(ads()[0]).getByTestId("suggested-ad-top-up");
    expect(top.tagName).toBe("BUTTON");
    expect(top.getAttribute("href")).toBeNull();
    fireEvent.click(top);
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it("a member sees who to ask instead of a Top up button", async () => {
    ws.value = { role: "member", openTab: vi.fn() };
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: failView("t1", "insufficient_credits") };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    expect(within(ads()[0]).getByTestId("suggested-ad-top-up").textContent).toBe("Ask your workspace owner to add credits.");
    expect(within(ads()[0]).queryByRole("button", { name: "Top up credits" })).toBeNull();
  });

  it.each([
    ["insufficient_credits", "Sorry, this video costs about 92 credits and your workspace doesn't have that many right now. Top up and try again. You were not charged for it."],
    [null, "Sorry, the video took too long to generate. You were not charged for it."],
  ])("a render the worker failed in the background with code %s shows the right note and Top up only for credits", async (code, workerBody) => {
    ws.value = { role: "owner", openTab: vi.fn() };
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    const v = failView("t1", code);
    v.messages.push({ id: "f-t1", role: "assistant", body: workerBody, created_at: "2026-10-26T10:03:00Z", kind: "generative_video_failed", draft: null, render_run_id: null, run_id: "r-t1" });
    views = { t1: v };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    const ad = ads()[0];
    expect(ad.getAttribute("data-state")).toBe("failed");
    const credit = "Not enough credits for this video. Nothing was charged.";
    if (code) {
      expect(ad.textContent?.split("Not enough credits for this video.").length).toBe(2);
      expect(within(ad).getAllByText(credit)).toHaveLength(1);
      expect(within(ad).getAllByTestId("suggested-ad-top-up")).toHaveLength(1);
      expect(within(ad).getAllByRole("button", { name: "Top up credits" })).toHaveLength(1);
      expect(ad.textContent).not.toContain("costs about 92 credits");
    } else {
      expect(within(ad).getByText(workerBody)).toBeTruthy();
      expect(ad.textContent).not.toContain("Not enough credits");
      expect(within(ad).queryByTestId("suggested-ad-top-up")).toBeNull();
      expect(within(ad).queryByRole("button", { name: "Top up credits" })).toBeNull();
    }
    expect(within(ad).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it("a render that failed for another reason shows no Top up", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: failView("t1", null) };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    expect(within(ads()[0]).queryByTestId("suggested-ad-top-up")).toBeNull();
    expect(ads()[0].textContent).not.toContain("Not enough credits");
  });

  it.each([
    ["an HTTP 500", () => Promise.resolve(res({}, 500))],
    ["a server error message", () => Promise.resolve(res({ error: { message: "relation channel_actions does not exist" } }, 500))],
    ["a dropped connection", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("Make video failing with %s shows the plain line", async (_name, fail) => {
    channel.actions = [card("s1")];
    approveAnswer = fail;
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    await waitFor(() => expect(within(ads()[0]).getByRole("alert").textContent).toBe("Zavi could not start this video. Try again."));
    expect(document.body.textContent).not.toMatch(/HTTP 500|Failed to fetch|relation/);
  });

  it("Make video refused with a 4xx reason keeps that reason", async () => {
    channel.actions = [card("s1")];
    approveAnswer = { body: { error: { message: "This idea was already used." } }, status: 409 };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    await waitFor(() => expect(within(ads()[0]).getByRole("alert").textContent).toBe("This idea was already used."));
  });

  it.each([
    ["an HTTP 500", () => Promise.resolve(res({}, 500))],
    ["a dropped connection", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 409 refusal with the server's own words", () => Promise.resolve(res({ error: { code: "refused", message: "That action can't be changed from here." } }, 409))],
    ["a 404 with the server's own words", () => Promise.resolve(res({ error: { code: "not_found", message: "Action not found." } }, 404))],
  ])("a next step's done button failing with %s shows the plain line", async (_name, fail) => {
    channel.actions = [
      card("n1", {
        executable: false,
        title: "Confirm the refund wording",
        done_label: "I checked it",
        body: { step: { body: "Check the policy page says 24 hours." } } as unknown as ChannelActionView["body"],
      }),
    ];
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => (String(url) === "/api/channel-actions/n1" ? fail() : base(url, init)));
    await mount();
    const step = await screen.findByTestId("next-step");
    await act(async () => fireEvent.click(within(step).getByRole("button", { name: "I checked it" })));
    await waitFor(() => expect(step.textContent).toContain("Zavi could not save that. Try again."));
    expect(document.body.textContent).not.toMatch(/HTTP 500|Failed to fetch|can't be changed from here|Action not found/);
  });

  const failSuggest = (body: unknown, status: number) => {
    startersGet = { run_id: null };
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      String(url) === `/api/channels/${SLUG}/starters` && init?.method === "POST" ? res(body, status) : base(url, init),
    );
  };

  it.each(["insufficient_credits", "out_of_credits"])("Suggest new ads refused for credits (%s) says Out of credits, not a video, with Top up", async (code) => {
    failSuggest({ error: { code, message: "no" } }, 402);
    await mount();
    await act(async () => fireEvent.click(await screen.findByTestId("suggest-ads")));
    const err = await screen.findByTestId("suggest-ads-error");
    expect(err.textContent).toContain("Out of credits.");
    expect(err.textContent).not.toContain("Not enough credits for this video.");
    expect(document.body.textContent).not.toContain("Not enough credits for this video.");
    expect(within(err).getByTestId("suggest-ads-top-up")).toBeTruthy();
  });

  it("a member refused for credits on Suggest new ads gets the ask-your-owner line without a p inside the alert p", async () => {
    ws.value = { role: "member", openTab: vi.fn() };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      failSuggest({ error: { code: "insufficient_credits", message: "no" } }, 402);
      await mount();
      await act(async () => fireEvent.click(await screen.findByTestId("suggest-ads")));
      const err = await screen.findByTestId("suggest-ads-error");
      expect(within(err).getByTestId("suggest-ads-top-up").textContent).toBe("Ask your workspace owner to add credits.");
      expect(document.querySelector("p p")).toBeNull();
      const nesting = errors.mock.calls.filter((c) => c.some((a) => typeof a === "string" && /validateDOMNesting|cannot be a descendant of|cannot contain a nested/.test(a)));
      expect(nesting).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  describe("downloading a ready ad that has a direct url", () => {
    const ready = (): AdItem => ({
      key: "thread-t1",
      title: "Planner ad",
      hooks: [],
      script: "Stop wasting mornings.",
      state: "ready",
      video: { url: "https://cdn.test/v.mp4", downloadUrl: "https://cdn.test/v.mp4?download=1" },
    });
    let clicks: Array<{ href: string; download: string }>;
    let anchorClick: { mockRestore: () => void };
    beforeEach(() => {
      clicks = [];
      anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push({ href: this.href, download: this.download });
      });
      URL.createObjectURL = () => "blob:saved";
      URL.revokeObjectURL = () => undefined;
    });
    afterEach(() => anchorClick.mockRestore());

    async function press(announce: (m: string) => void) {
      render(<SuggestedAds items={[ready()]} loading={false} error={null} now={0} announce={announce} />);
      await act(async () => fireEvent.click(screen.getByTestId("suggested-ad-download")));
      await act(async () => {
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
    }

    it("saves the file and says Downloaded when the fetch works", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["mp4"]) })));
      const open = vi.fn();
      vi.stubGlobal("open", open);
      const announce = vi.fn();
      await press(announce);
      expect(clicks).toEqual([{ href: "blob:saved", download: "Planner ad.mp4" }]);
      expect(open).not.toHaveBeenCalled();
      expect(screen.getByTestId("suggested-ad-download").textContent).toBe("Download again");
      expect(announce).toHaveBeenCalledWith('Downloaded "Planner ad".');
      expect(screen.queryByTestId("suggested-ad-opened")).toBeNull();
    });

    it("opening in a new tab instead does not claim it downloaded", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("CORS"))));
      const tab = { opener: {} as unknown };
      const open = vi.fn(() => tab);
      vi.stubGlobal("open", open);
      const announce = vi.fn();
      await press(announce);
      expect(open).toHaveBeenCalledWith("https://cdn.test/v.mp4?download=1", "_blank");
      expect(tab.opener).toBeNull();
      expect(screen.getByTestId("suggested-ad-opened").textContent).toBe("Opened in a new tab.");
      expect(screen.getByTestId("suggested-ad-download").textContent).toBe("Download");
      expect(announce).not.toHaveBeenCalled();
      expect(screen.queryByTestId("suggested-ad-download-error")).toBeNull();
    });

    it("a blocked new tab shows the download failed alert and no Downloaded", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, blob: async () => new Blob([]) })));
      vi.stubGlobal("open", vi.fn(() => null));
      const announce = vi.fn();
      await press(announce);
      expect(screen.getByTestId("suggested-ad-download-error").textContent).toBe("The download did not start. Try again.");
      expect(screen.getByTestId("suggested-ad-download").textContent).toBe("Download");
      expect(screen.queryByTestId("suggested-ad-opened")).toBeNull();
      expect(announce).not.toHaveBeenCalled();
    });
  });

  it("Suggest new ads failing on the server hides the raw message", async () => {
    failSuggest({ error: { message: "TypeError: cannot read properties of undefined (reading 'tenant_id')" } }, 500);
    await mount();
    await act(async () => fireEvent.click(await screen.findByTestId("suggest-ads")));
    expect((await screen.findByTestId("suggest-ads-error")).textContent).toBe("Zavi could not suggest new ads. Try again.");
  });

  it("Suggest new ads with video making switched off shows the server message, not the retry text", async () => {
    const msg = "Video making is switched off right now, so nothing was made and nothing was charged.";
    failSuggest({ error: { code: "video_unavailable", message: msg } }, 503);
    await mount();
    await act(async () => fireEvent.click(await screen.findByTestId("suggest-ads")));
    expect((await screen.findByTestId("suggest-ads-error")).textContent).toBe(msg);
    expect(document.body.textContent).not.toContain("Zavi could not suggest new ads. Try again.");
  });

  it("Suggest new ads 503 without the video_unavailable code keeps the generic text", async () => {
    failSuggest({ error: { code: "upstream_down", message: "Video making is switched off right now, so nothing was made and nothing was charged." } }, 503);
    await mount();
    await act(async () => fireEvent.click(await screen.findByTestId("suggest-ads")));
    expect((await screen.findByTestId("suggest-ads-error")).textContent).toBe("Zavi could not suggest new ads. Try again.");
    expect(document.body.textContent).not.toContain("switched off");
  });

  it("the empty list only names Suggest new ads when that button is there", () => {
    const { rerender } = render(<SuggestedAds items={[]} loading={false} error={null} now={0} />);
    expect(screen.getByText("Your ads show here. Describe one above and press Generate.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Suggest new ads");
    rerender(<SuggestedAds items={[]} loading={false} error={null} now={0} suggest={{ busy: false, onSuggest: () => undefined, hint: null, error: null }} />);
    expect(screen.getByText("Your ads show here. Describe one above and press Generate, or press Suggest new ads.")).toBeTruthy();
  });

  it("an edit whose reload fails stays making with no Try again on the old script, then shows the new one", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "stalled") };
    messageAnswers = [{ body: { thread_id: "t1", render: null } }];
    let down = false;
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      down && String(url) === `${STUDIO_PATH}?thread_id=t1` ? res({}, 500) : base(url, init),
    );
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Ask Zavi" }));
    type("Make the hook punchier");
    down = true;
    await act(async () => {
      fireEvent.click(generate());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(messagePosts()).toHaveLength(1);
    expect(ads()[0].getAttribute("data-state")).toBe("making");
    expect(within(ads()[0]).queryByRole("button", { name: "Try again" })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS);
    });
    expect(ads()[0].getAttribute("data-state")).toBe("making");
    expect(renderPosts()).toHaveLength(0);
    down = false;
    views.t1 = view("t1", "done");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS);
    });
    expect(ads()[0].getAttribute("data-state")).toBe("ready");
    const reads = () => apiFetch.mock.calls.filter(([u]) => String(u) === `${STUDIO_PATH}?thread_id=t1`).length;
    const settled = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS * 3);
    });
    expect(reads()).toBe(settled);
  });

  async function editWithReload(read: () => Promise<unknown>) {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "stalled") };
    messageAnswers = [{ body: { thread_id: "t1", render: null } }];
    let down = false;
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      down && String(url) === `${STUDIO_PATH}?thread_id=t1` ? read() : base(url, init),
    );
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Ask Zavi" }));
    type("Make the hook punchier");
    down = true;
    await act(async () => {
      fireEvent.click(generate());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ads()[0].getAttribute("data-state")).toBe("making");
    return () => apiFetch.mock.calls.filter(([u]) => String(u) === `${STUDIO_PATH}?thread_id=t1`).length;
  }

  it("a reload that never answers is not fired again on every tick", async () => {
    let n = 0;
    const reads = await editWithReload(() => (++n <= 2 ? Promise.resolve(res({}, 500)) : new Promise(() => undefined)));
    expect(n).toBe(2);
    const start = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS * 6);
    });
    expect(reads()).toBe(start + 1);
    expect(ads()[0].getAttribute("data-state")).toBe("making");
  });

  it("a reload that keeps failing stops polling after the bounded tries and tells the founder", async () => {
    const reads = await editWithReload(() => Promise.resolve(res({}, 500)));
    const start = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS * RELOAD_TRIES);
    });
    expect(reads()).toBe(start + RELOAD_TRIES);
    expect(ads()[0].getAttribute("data-state")).toBe("making");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS);
    });
    expect(ads()[0].getAttribute("data-state")).not.toBe("making");
    expect(within(ads()[0]).getByRole("alert").textContent).toBe(RELOAD_GAVE_UP);
    const after = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS * 20);
    });
    expect(reads()).toBe(after);
  });

  it("an edit whose reload gives up leaves the older failed draft without Try again, so it cannot be made and charged again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "failed") };
    messageAnswers = [{
      body: {
        thread_id: "t1",
        reply: { id: "m-t1-v2", body: "Here is the punchier draft", meta: { video_draft: { ...DRAFT } } },
        render: { run_id: "r-t1-v2" },
      },
    }];
    let down = false;
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      down && String(url) === `${STUDIO_PATH}?thread_id=t1` ? res({}, 500) : base(url, init),
    );
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(ads()[0]).getByRole("button", { name: "Try again" })).toBeTruthy();
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Ask Zavi" }));
    type("Make the hook punchier");
    down = true;
    await act(async () => {
      fireEvent.click(generate());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(messagePosts()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_POLL_MS * (RELOAD_TRIES + 2));
    });
    expect(within(ads()[0]).getByRole("alert").textContent).toBe(RELOAD_GAVE_UP);
    expect(ads()[0].getAttribute("data-state")).toBe("failed");
    expect(within(ads()[0]).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(ads()[0]).queryByRole("button", { name: /Make video/ })).toBeNull();
    expect(renderPosts()).toEqual([]);
  });

  it("a Try again the server refuses as superseded shows why and takes Try again away even when the refresh fails", async () => {
    const SUPERSEDED = "A newer version of this ad exists. Nothing was made or charged.";
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "failed") };
    renderAnswer = { body: { error: { code: "superseded", message: SUPERSEDED } }, status: 409 };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    delete views.t1;
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Try again" })));
    await waitFor(() => expect(within(ads()[0]).getByRole("alert").textContent).toBe(SUPERSEDED));
    expect(renderPosts()).toHaveLength(1);
    expect(within(ads()[0]).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("a picked hook made as its own ad takes the starter card's place, and Dismiss on a failed one brings it back", async () => {
    channel.actions = [hookedCard()];
    messageAnswers = [{ body: { error: { message: "Zavi is busy right now." } }, status: 503 }];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    fireEvent.click(chips()[1]);
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    expect(ads()).toHaveLength(1);
    expect(adId(ads()[0])).toMatch(/^suggested-ad-pending-/);
    expect(document.getElementById("suggested-ad-starter-s1")).toBeNull();
    await waitFor(() => expect(ads()[0].getAttribute("data-state")).toBe("failed"));
    expect(screen.queryAllByRole("button", { name: "Make video" })).toHaveLength(0);
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Dismiss" }));
    expect(ads()).toHaveLength(1);
    expect(adId(ads()[0])).toBe("suggested-ad-starter-s1");
    expect(approvals()).toHaveLength(0);
  });

  it("an ad opened from the Library that is not in the loaded list is read and scrolled to", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "done"), far: view("far", "done") };
    await mount(undefined, "far");
    await waitFor(() => expect(document.getElementById("suggested-ad-thread-far")).toBeTruthy());
    await waitFor(() => expect(scrolled.some((el) => el.id === "suggested-ad-thread-far")).toBe(true));
    expect(within(document.getElementById("suggested-ad-thread-far")!).getByRole("heading").textContent).toBe("make an ad");
    expect(apiFetch.mock.calls.filter(([u]) => String(u) === `${STUDIO_PATH}?thread_id=far`)).toHaveLength(1);
  });

  it("an ad opened from the Library that cannot be read says so", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "done") };
    await mount(undefined, "gone");
    await waitFor(() => expect(screen.getByText("Some of your ads could not be loaded. Refresh the page.")).toBeTruthy());
    expect(ads()).toHaveLength(1);
  });

  it("a download that does not start says so and is not reported as done", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "done") };
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      String(url).includes("download=1") ? res({}, 500) : base(url, init),
    );
    await mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Play Planner ad" })).toBeTruthy());
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Download" })));
    await waitFor(() => expect(within(ads()[0]).getByTestId("suggested-ad-download-error").textContent).toBe("The download did not start. Try again."));
    expect(within(ads()[0]).getByTestId("suggested-ad-download-error").getAttribute("role")).toBe("alert");
    expect(within(ads()[0]).getByTestId("suggested-ad-download").textContent).toBe("Download");
    expect(screen.getByTestId("video-overview-status").textContent).toBe("");
    expect(assign).not.toHaveBeenCalled();
  });

  const linkCard = () => card("v1", {
    exec_status: "executed",
    body: {
      video_format: "explainer",
      cost_credits: 1500,
      media: { kind: "video", url: "https://cdn.test/s1.mp4" },
      step: { deliverable: { content: "Here is the first line. Then the rest of it." } },
    } as unknown as ChannelActionView["body"],
  });

  it("downloading a starter video with no download link stays in Zavi", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const tab = { opener: {} as unknown };
    const open = vi.fn(() => tab);
    vi.stubGlobal("open", open);
    channel.actions = [linkCard()];
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("cors")));
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Download" })));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(assign).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("https://cdn.test/s1.mp4", "_blank");
    expect(tab.opener).toBeNull();
    expect(within(ads()[0]).getByTestId("suggested-ad-opened").textContent).toBe("Opened in a new tab.");
    expect(within(ads()[0]).getByTestId("suggested-ad-download").textContent).toBe("Download");
  });

  it("downloading a starter video that has a download link saves it as a file and never navigates the tab", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["x"]) });
    vi.stubGlobal("fetch", fetchMock);
    const create = vi.fn(() => "blob:zavi/1");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const clicked: HTMLAnchorElement[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    const card = linkCard();
    (card.body as unknown as { media: { download_url: string } }).media.download_url = "https://cdn.test/s1.mp4?dl=1";
    channel.actions = [card];
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Download" })));
    await waitFor(() => expect(clicked).toHaveLength(1));
    spy.mockRestore();
    expect(assign).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.test/s1.mp4?dl=1");
    expect(clicked[0].href).toBe("blob:zavi/1");
    expect(clicked[0].hasAttribute("download")).toBe(true);
    expect(clicked[0].target).not.toBe("_blank");
  });

  it("a download link that cannot be fetched opens a new tab instead of leaving Zavi", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("cors")));
    const open = vi.fn(() => ({ opener: null }));
    vi.stubGlobal("open", open);
    const card = linkCard();
    (card.body as unknown as { media: { download_url: string } }).media.download_url = "https://cdn.test/s1.mp4?dl=1";
    channel.actions = [card];
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Download" })));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(assign).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("https://cdn.test/s1.mp4?dl=1", "_blank");
    expect(screen.getByTestId("video-overview-status").textContent).not.toContain("Downloaded");
  });

  it("a starter video that cannot be loaded says so instead of a black box", async () => {
    channel.actions = [linkCard()];
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    const video = ads()[0].querySelector("video")!;
    expect(video).toBeTruthy();
    fireEvent.error(video);
    expect(within(ads()[0]).getByText("This video could not be loaded. Refresh the page.")).toBeTruthy();
    expect(ads()[0].querySelector("video")).toBeNull();
  });

  it("Play moves focus to the video controls, and the end of the video moves it back to Play", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "done") };
    await mount();
    const play = await screen.findByRole("button", { name: "Play Planner ad" });
    play.focus();
    await act(async () => fireEvent.click(play));
    expect(document.activeElement?.closest('[data-testid="video-controls"]')).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
    await act(async () => fireEvent.ended(ads()[0].querySelector("video")!));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Play Planner ad" }));
  });

  it("after a reload the ad still being made stays above the suggested ads, where it was before the reload", async () => {
    channel.actions = [card("fresh-1"), card("fresh-2"), card("fresh-3")];
    threads = [
      { id: "old", title: "Older ad", last_message_at: "2026-10-25T00:00:00Z" },
      { id: "mine", title: "My script ad", last_message_at: "2026-10-26T00:00:00Z" },
    ];
    views = { old: view("old", "done"), mine: view("mine", "rendering") };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(5));
    expect(ads().map(adId)).toEqual([
      "suggested-ad-thread-mine",
      "suggested-ad-starter-fresh-1",
      "suggested-ad-starter-fresh-2",
      "suggested-ad-starter-fresh-3",
      "suggested-ad-thread-old",
    ]);
  });
});

describe("VideoOverview Edit opens in the card on every ad with words", () => {
  const HOOKED = { ...DRAFT, hook: "Stop wasting mornings.", alt_hooks: ["Mornings are broken.", "Busy parents, listen."] };
  const hooked = (id: string, status: "done" | "failed" | null) => {
    const v = view(id, status);
    v.messages[1].draft = { ...HOOKED } as never;
    return v;
  };
  const form = () => screen.getByRole("form", { name: /^Edit "/ });
  const hookInputs = () => [1, 2, 3].map((n) => (within(form()).queryByLabelText(`Hook ${n}`) as HTMLInputElement | null)?.value ?? null);
  const scriptBox = () => within(form()).getByLabelText("Script") as HTMLTextAreaElement;
  const formChips = () => within(within(form()).getByRole("radiogroup", { name: "Hook to use" })).getAllByRole("radio");
  const cardChips = (el: HTMLElement) => within(within(el).getByRole("radiogroup", { name: "Pick the hook" })).getAllByRole("radio");
  const renders = () => posts.filter((p) => p.url === `${STUDIO_PATH}/render`);

  it("Edit on a finished ad opens the form in that card, not the composer, and keeps the video", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: hooked("t1", "done") };
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(screen.queryByTestId("video-studio-editing")).toBeNull();
    expect(input().value).toBe("");
    expect(ads()[0].contains(form())).toBe(true);
    expect(within(ads()[0]).getByRole("heading").textContent).toBe("Planner ad");
    expect(hookInputs()).toEqual(["Stop wasting mornings.", "Mornings are broken.", "Busy parents, listen."]);
    expect(scriptBox().value).toBe("Our app plans your day in one tap.");
    expect(within(form()).getByText("The picked hook is said first, then this.")).toBeTruthy();
    expect(document.activeElement).toBe(within(form()).getByLabelText("Hook 1"));
    expect(within(ads()[0]).getByRole("button", { name: "Play Planner ad" })).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it("Edit on a hookless ad shows no hook picker and no note about a picked hook, and the script points at no missing hint", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "done") };
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(hookInputs()).toEqual([null, null, null]);
    expect(within(form()).queryByRole("radiogroup")).toBeNull();
    expect(within(form()).queryByText(/picked hook/i)).toBeNull();
    expect(form().textContent).not.toMatch(/hook/i);
    const hint = scriptBox().getAttribute("aria-describedby");
    expect(hint === null || document.getElementById(hint) !== null).toBe(true);
    expect(document.activeElement).toBe(scriptBox());
  });

  it("on a finished ad, editing hook 2 then Save then Make video sends one new ad with hook 2 first and the edited script, and the old video stays", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: hooked("t1", "done") };
    const gate = deferred();
    messageAnswers = [() => gate.promise];
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    expect(within(ads()[0]).queryByRole("button", { name: "Make video" })).toBeNull();
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(form()).getByLabelText("Hook 2"), { target: { value: "Your mornings are lying to you." } });
    fireEvent.keyDown(formChips()[0], { key: "ArrowDown" });
    expect(formChips().map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(document.activeElement).toBe(formChips()[1]);
    fireEvent.change(scriptBox(), { target: { value: "We fixed that in one tap." } });
    fireEvent.submit(form());
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(cardChips(ads()[0])[1].textContent).toBe("Your mornings are lying to you.");
    expect(cardChips(ads()[0])[1].getAttribute("aria-checked")).toBe("true");
    expect(within(ads()[0]).getByTestId("suggested-ad-script").textContent).toBe("Your mornings are lying to you. We fixed that in one tap.");
    expect(messagePosts()).toHaveLength(0);
    await act(async () => {
      const b = within(ads()[0]).getByRole("button", { name: "Make video" });
      b.click();
      b.click();
    });
    expect(messagePosts().map((p) => p.body)).toEqual([{ text: "Your mornings are lying to you. We fixed that in one tap.", verbatim: true, new_thread: true }]);
    expect(renders()).toHaveLength(0);
    expect(ads()).toHaveLength(2);
    expect(ads()[0].getAttribute("data-state")).toBe("making");
    expect(cardChips(ads()[1])[1].textContent).toBe("Your mornings are lying to you.");
    views.new1 = view("new1", "rendering");
    await act(async () => {
      gate.resolve(res({ thread_id: "new1", render: { run_id: "r-new1" } }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(ads()[1].getAttribute("data-state")).toBe("ready"));
    const old = ads()[1];
    expect(within(old).getByRole("button", { name: "Play Planner ad" })).toBeTruthy();
    await waitFor(() => expect(within(old).getByTestId("suggested-ad-hook").textContent).toBe("Stop wasting mornings."));
    expect(within(old).queryByRole("button", { name: "Make video" })).toBeNull();
  });

  it("a Make video on a finished ad that the server refuses for credits keeps the founder's edited hook and script on that ad", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: hooked("t1", "done") };
    messageAnswers = [{ body: { error: { code: "insufficient_credits", message: "no", required_credits: 900 } }, status: 402 }];
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(form()).getByLabelText("Hook 2"), { target: { value: "Your mornings are lying to you." } });
    fireEvent.click(formChips()[1]);
    fireEvent.change(scriptBox(), { target: { value: "We fixed that in one tap." } });
    fireEvent.submit(form());
    await act(async () => {
      within(ads()[0]).getByRole("button", { name: "Make video" }).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(messagePosts()).toHaveLength(1);
    await waitFor(() => expect(ads().find((a) => a.getAttribute("data-state") === "failed")).toBeTruthy());
    const old = ads().find((a) => a.getAttribute("data-state") === "ready")!;
    expect(cardChips(old)[1].textContent).toBe("Your mornings are lying to you.");
    expect(cardChips(old)[1].getAttribute("aria-checked")).toBe("true");
    expect(within(old).getByTestId("suggested-ad-script").textContent).toBe("Your mornings are lying to you. We fixed that in one tap.");
    expect(within(old).getByRole("button", { name: "Make video" })).toBeTruthy();
  });

  it("Edit on a thread ad seeds its real hooks and script, shows the price after Save, and Make video sends that text once in the same thread", async () => {
    channelsBody = { channels: [{ channel_slug: SLUG, video_credits_each: 1700 }] };
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: hooked("t1", "failed") };
    messageAnswers = [() => new Promise(() => undefined), () => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(within(ads()[0]).getByTestId("suggested-ad-cost").textContent).toBe("About 900 credits, charged only if the video arrives."));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(screen.queryByTestId("video-studio-editing")).toBeNull();
    expect(hookInputs()).toEqual(["Stop wasting mornings.", "Mornings are broken.", "Busy parents, listen."]);
    expect(scriptBox().value).toBe("Our app plans your day in one tap.");
    fireEvent.change(within(form()).getByLabelText("Hook 2"), { target: { value: "Mornings are a scam." } });
    fireEvent.click(within(form()).getByRole("radio", { name: "Use hook 2" }));
    fireEvent.change(scriptBox(), { target: { value: "  Plan the whole day in one tap.  " } });
    fireEvent.click(within(form()).getByRole("button", { name: "Save" }));
    expect(within(ads()[0]).getByTestId("suggested-ad-cost").textContent).toBe(
      "About 900 credits for the suggested script. Yours is priced by its length, charged only if the video arrives.",
    );
    expect(within(ads()[0]).queryByRole("button", { name: "Try again" })).toBeNull();
    await act(async () => {
      const b = within(ads()[0]).getByRole("button", { name: "Make video" });
      b.click();
      b.click();
    });
    expect(messagePosts().map((p) => p.body)).toEqual([{ text: "Mornings are a scam. Plan the whole day in one tap.", verbatim: true, thread_id: "t1" }]);
    expect(renders()).toHaveLength(0);
    expect(ads()).toHaveLength(1);
    expect(ads()[0].getAttribute("data-state")).toBe("making");
  });

  it("Cancel and Escape restore the text, and reopening shows the saved text, not the thrown-away edit", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: hooked("t1", null) };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    const before = within(ads()[0]).getByTestId("suggested-ad-script").textContent;
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(form()).getByLabelText("Hook 1"), { target: { value: "Thrown away hook." } });
    fireEvent.change(scriptBox(), { target: { value: "Thrown away script." } });
    fireEvent.click(within(form()).getByRole("radio", { name: "Use hook 3" }));
    fireEvent.click(within(form()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(within(ads()[0]).getByTestId("suggested-ad-script").textContent).toBe(before);
    expect(ads()[0].textContent).not.toContain("Thrown away");
    expect(cardChips(ads()[0]).map((c) => c.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(hookInputs()).toEqual(["Stop wasting mornings.", "Mornings are broken.", "Busy parents, listen."]);
    expect(scriptBox().value).toBe("Our app plans your day in one tap.");
    fireEvent.change(scriptBox(), { target: { value: "Also thrown away." } });
    fireEvent.keyDown(scriptBox(), { key: "Escape" });
    expect(screen.queryByRole("form")).toBeNull();
    expect(ads()[0].textContent).not.toContain("Also thrown away");
    expect(posts).toHaveLength(0);
  });

  it("a thread with a script and no hooks edits the whole script with no hook picker, and sends exactly that", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", null) };
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(within(form()).queryByText("Pick the hook")).toBeNull();
    expect(within(form()).queryByRole("radiogroup")).toBeNull();
    expect(hookInputs()).toEqual([null, null, null]);
    expect(scriptBox().value).toBe(DRAFT.script);
    expect(document.activeElement).toBe(scriptBox());
    fireEvent.change(scriptBox(), { target: { value: "Mornings are hard. We make them easy." } });
    fireEvent.submit(form());
    expect(within(ads()[0]).getByTestId("suggested-ad-script").textContent).toBe("Mornings are hard. We make them easy.");
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    expect(messagePosts().map((p) => p.body)).toEqual([{ text: "Mornings are hard. We make them easy.", verbatim: true, thread_id: "t1" }]);
  });

  it("Save with nothing changed on a hookless thread keeps Try again and sends nothing new", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: view("t1", "failed") };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    fireEvent.submit(form());
    expect(within(ads()[0]).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(ads()[0]).queryByRole("button", { name: "Make video" })).toBeNull();
  });

  it("a finished starter ad edits in place and Make video adds a new ad while the starter keeps its video", async () => {
    channel.actions = [card("v1", {
      exec_status: "executed",
      body: {
        video_format: "talking_head",
        cost_credits: 1500,
        hooks: ["Here is the first line.", "Nobody tells you this."],
        media: { kind: "video", url: "https://cdn.test/s1.mp4" },
        step: { deliverable: { content: "Here is the first line. Then the rest of it." } },
      } as unknown as ChannelActionView["body"],
    })];
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(screen.queryByTestId("video-studio-editing")).toBeNull();
    fireEvent.click(within(form()).getByRole("radio", { name: "Use hook 2" }));
    fireEvent.submit(form());
    expect(within(ads()[0]).getByTestId("suggested-ad-cost").textContent).toContain("Yours is priced by its length");
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    expect(posts.filter((p) => p.url.endsWith("/approve"))).toHaveLength(0);
    expect(messagePosts().map((p) => p.body)).toEqual([{ text: "Nobody tells you this. Then the rest of it.", verbatim: true, new_thread: true }]);
    expect(ads()).toHaveLength(2);
    expect(ads()[1].getAttribute("data-state")).toBe("ready");
    expect(ads()[1].querySelector("video")?.getAttribute("src")).toBe("https://cdn.test/s1.mp4");
  });

  it("a failed composer ad edits in place and Make video resends the edited text once as that ad", async () => {
    messageAnswers = [{ body: { error: { message: "nope" } }, status: 500 }, () => new Promise(() => undefined)];
    await mount();
    type("Stop wasting mornings. Our app plans your day in one tap.");
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect(ads()[0].getAttribute("data-state")).toBe("failed"));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(hookInputs()).toEqual(["Stop wasting mornings.", "", ""]);
    fireEvent.change(scriptBox(), { target: { value: "Plan it in one tap." } });
    fireEvent.submit(form());
    await act(async () => fireEvent.click(within(ads()[0]).getByRole("button", { name: "Make video" })));
    expect(messagePosts().map((p) => p.body.text)).toEqual(["Stop wasting mornings. Our app plans your day in one tap.", "Stop wasting mornings. Plan it in one tap."]);
    expect(ads()).toHaveLength(1);
    expect(ads()[0].getAttribute("data-state")).toBe("making");
  });

  const noDraft = (id: string, user: Partial<StudioView["messages"][number]> = {}) => {
    const v = view(id, null);
    v.messages = [{ ...v.messages[0], ...user }, { ...v.messages[1], draft: null, body: "I could not write that one." }];
    return v;
  };
  const requestBox = () => within(form()).getByLabelText("Your request") as HTMLTextAreaElement;
  const reviseButtons = (el: HTMLElement) => within(el).queryAllByRole("button", { name: /^(Make it shorter|Different presenter)$/ });
  const adTitled = (title: string) => ads().find((a) => within(a).queryByRole("heading")?.textContent === title)!;

  it("a failed thread with no draft opens its request in the card, not the composer, and Make video asks once in that thread", async () => {
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: noDraft("t1") };
    messageAnswers = [() => new Promise(() => undefined), () => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("failed"));
    expect(within(ads()[0]).getByText("Your request")).toBeTruthy();
    expect(within(ads()[0]).getByTestId("suggested-ad-script").textContent).toBe("make an ad");
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(screen.queryByTestId("video-studio-editing")).toBeNull();
    expect(input().value).toBe("");
    expect(ads()[0].contains(form())).toBe(true);
    expect(within(form()).queryByRole("radiogroup")).toBeNull();
    expect(hookInputs()).toEqual([null, null, null]);
    expect(within(form()).queryByLabelText("Script")).toBeNull();
    expect(requestBox().value).toBe("make an ad");
    fireEvent.change(requestBox(), { target: { value: "Thrown away." } });
    fireEvent.click(within(form()).getByRole("button", { name: "Cancel" }));
    expect(ads()[0].textContent).not.toContain("Thrown away");
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(requestBox().value).toBe("make an ad");
    fireEvent.change(requestBox(), { target: { value: "  A short ad about our planner for busy parents  " } });
    fireEvent.click(within(form()).getByRole("button", { name: "Save" }));
    expect(within(ads()[0]).getByTestId("suggested-ad-script").textContent).toBe("A short ad about our planner for busy parents");
    expect(messagePosts()).toHaveLength(0);
    await act(async () => {
      const b = within(ads()[0]).getByRole("button", { name: "Make video" });
      b.click();
      b.click();
    });
    expect(messagePosts().map((p) => p.body)).toEqual([{ text: "A short ad about our planner for busy parents", thread_id: "t1" }]);
    expect(ads()).toHaveLength(1);
    expect(ads()[0].getAttribute("data-state")).toBe("making");
    expect(screen.queryByTestId("video-studio-editing")).toBeNull();
  });

  it("a thread with no draft whose request was only an image still opens the composer as Editing <title>", async () => {
    threads = [{ id: "t1", title: "Animated image", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: noDraft("t1", { body: "", image_path: "u/t/photo.png" }) };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(1));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("form", { name: /^Edit "/ })).toBeNull();
    expect(screen.getByTestId("video-studio-editing").textContent).toContain("Animated image");
  });

  it("a failed prompt ad opens its request in the card and Make video resends the edited request once, still as a prompt", async () => {
    messageAnswers = [{ body: { error: { message: "nope" } }, status: 500 }, () => new Promise(() => undefined), () => new Promise(() => undefined)];
    await mount();
    type("An ad for our morning planner");
    fireEvent.click(screen.getByRole("switch", { name: /Enable prompt/ }));
    expect(screen.getByRole("switch", { name: /Enable prompt/ }).getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect(ads()[0].getAttribute("data-state")).toBe("failed"));
    expect(messagePosts()[0].body).toEqual({ text: "An ad for our morning planner", new_thread: true });
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(screen.queryByTestId("video-studio-editing")).toBeNull();
    expect(hookInputs()).toEqual([null, null, null]);
    expect(requestBox().value).toBe("An ad for our morning planner");
    fireEvent.change(requestBox(), { target: { value: "An ad for busy parents about mornings" } });
    fireEvent.submit(form());
    await act(async () => {
      const b = within(ads()[0]).getByRole("button", { name: "Make video" });
      b.click();
      b.click();
    });
    expect(messagePosts().map((p) => p.body)).toEqual([
      { text: "An ad for our morning planner", new_thread: true },
      { text: "An ad for busy parents about mornings", new_thread: true },
    ]);
    expect(ads()).toHaveLength(1);
    expect(ads()[0].getAttribute("data-state")).toBe("making");
    expect(within(ads()[0]).getByTestId("suggested-ad-status").textContent).toBe("Zavi is writing your script…");
  });

  it("a finished ad offers Make it shorter and Different presenter next to Edit, and each asks once in that ad's thread", async () => {
    threads = [
      { id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" },
      { id: "t2", title: "Gym ad", last_message_at: "2026-10-24T00:00:00Z" },
    ];
    views = { t1: hooked("t1", "done"), t2: hooked("t2", "done") };
    messageAnswers = [() => new Promise(() => undefined), () => new Promise(() => undefined), () => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(ads().map((a) => a.getAttribute("data-state"))).toEqual(["ready", "ready"]));
    const planner = adTitled("Planner ad");
    const edit = within(planner).getByRole("button", { name: "Edit" });
    expect(reviseButtons(planner).map((b) => b.textContent)).toEqual(["Make it shorter", "Different presenter"]);
    expect(reviseButtons(planner).every((b) => b.parentElement === edit.parentElement)).toBe(true);
    await act(async () => {
      const b = within(planner).getByRole("button", { name: "Make it shorter" });
      b.click();
      b.click();
    });
    expect(messagePosts().map((p) => p.body)).toEqual([{ text: "Make it shorter", thread_id: "t1" }]);
    expect(renders()).toHaveLength(0);
    expect(ads()).toHaveLength(2);
    expect(adTitled("Planner ad").getAttribute("data-state")).toBe("making");
    expect(reviseButtons(adTitled("Planner ad"))).toHaveLength(0);
    expect(adTitled("Gym ad").getAttribute("data-state")).toBe("ready");
    await act(async () => {
      const b = within(adTitled("Gym ad")).getByRole("button", { name: "Different presenter" });
      b.click();
      b.click();
    });
    expect(messagePosts().map((p) => p.body)).toEqual([
      { text: "Make it shorter", thread_id: "t1" },
      { text: "Use a different presenter", thread_id: "t2" },
    ]);
    expect(ads()).toHaveLength(2);
    expect(adTitled("Gym ad").getAttribute("data-state")).toBe("making");
    expect(screen.queryByTestId("video-studio-editing")).toBeNull();
  });

  it("Make it shorter and Different presenter are absent on ads not made yet, failed ads, starter videos, image videos, and after a saved edit", async () => {
    channelsBody = { channels: [{ channel_slug: SLUG, video_credits_each: 1700 }] };
    channel.actions = [card("v1", {
      exec_status: "executed",
      body: {
        video_format: "talking_head",
        cost_credits: 1500,
        hooks: ["Here is the first line."],
        media: { kind: "video", url: "https://cdn.test/s1.mp4" },
        step: { deliverable: { content: "Here is the first line. Then the rest of it." } },
      } as unknown as ChannelActionView["body"],
    })];
    const image = view("t4", "done");
    image.messages[1].draft = { ...DRAFT, intent: "animate", script: null, visual: "A slow zoom on the product" } as never;
    threads = [
      { id: "t1", title: "Draft ad", last_message_at: "2026-10-25T00:00:00Z" },
      { id: "t2", title: "Failed ad", last_message_at: "2026-10-24T00:00:00Z" },
      { id: "t3", title: "Done ad", last_message_at: "2026-10-23T00:00:00Z" },
      { id: "t4", title: "Animated image", last_message_at: "2026-10-22T00:00:00Z" },
    ];
    views = { t1: hooked("t1", null), t2: hooked("t2", "failed"), t3: hooked("t3", "done"), t4: image };
    await mount();
    await waitFor(() => expect(ads()).toHaveLength(5));
    await waitFor(() => expect(adTitled("Done ad").getAttribute("data-state")).toBe("ready"));
    expect(reviseButtons(adTitled("Draft ad"))).toHaveLength(0);
    expect(reviseButtons(adTitled("Failed ad"))).toHaveLength(0);
    expect(reviseButtons(adTitled("Animated image"))).toHaveLength(0);
    const starter = ads().find((a) => a.querySelector("video")?.getAttribute("src") === "https://cdn.test/s1.mp4")!;
    expect(starter.getAttribute("data-state")).toBe("ready");
    expect(reviseButtons(starter)).toHaveLength(0);
    const done = adTitled("Done ad");
    expect(reviseButtons(done)).toHaveLength(2);
    expect(within(done).queryByTestId("suggested-ad-cost")).toBeNull();
    fireEvent.click(within(done).getByRole("button", { name: "Edit" }));
    fireEvent.change(scriptBox(), { target: { value: "We fixed mornings in one tap." } });
    fireEvent.submit(form());
    expect(reviseButtons(adTitled("Done ad"))).toHaveLength(0);
    expect(within(adTitled("Done ad")).getByRole("button", { name: "Make video" })).toBeTruthy();
    expect(within(adTitled("Done ad")).getByTestId("suggested-ad-cost").textContent).toBe(
      "About 900 credits for the suggested script. Yours is priced by its length, charged only if the video arrives.",
    );
    expect(messagePosts()).toHaveLength(0);
  });

  it("Edit on a one-hook ad offers three hook rows with radios, saves a hook typed in row 2, and an untouched Save is not an edit", async () => {
    channel.actions = [card("v1", {
      exec_status: "executed",
      body: {
        video_format: "talking_head",
        cost_credits: 1500,
        hooks: ["Here is the first line."],
        media: { kind: "video", url: "https://cdn.test/s1.mp4" },
        step: { deliverable: { content: "Here is the first line. Then the rest of it." } },
      } as unknown as ChannelActionView["body"],
    })];
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(hookInputs()).toEqual(["Here is the first line.", "", ""]);
    expect(formChips().map((c) => c.getAttribute("aria-label"))).toEqual(["Use hook 1", "Use hook 2", "Use hook 3"]);
    fireEvent.click(within(form()).getByRole("radio", { name: "Use hook 3" }));
    expect((within(form()).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form());
    expect(screen.getByRole("form", { name: /^Edit "/ })).toBeTruthy();
    fireEvent.click(within(form()).getByRole("radio", { name: "Use hook 1" }));
    fireEvent.submit(form());
    expect(screen.queryByRole("form", { name: /^Edit "/ })).toBeNull();
    expect(within(ads()[0]).queryByTestId("suggested-ad-cost")).toBeNull();
    expect(within(ads()[0]).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(ads()[0].querySelector("video")?.getAttribute("src")).toBe("https://cdn.test/s1.mp4");
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(form()).getByLabelText("Hook 2"), { target: { value: "  Nobody tells you this.  " } });
    fireEvent.click(within(form()).getByRole("radio", { name: "Use hook 2" }));
    fireEvent.submit(form());
    expect(screen.queryByRole("form", { name: /^Edit "/ })).toBeNull();
    expect(cardChips(ads()[0]).map((c) => c.textContent)).toEqual(["Here is the first line.", "Nobody tells you this."]);
    expect(within(ads()[0]).getByTestId("suggested-ad-cost").textContent).toContain("Yours is priced by its length");
    expect(messagePosts()).toHaveLength(0);
  });

  it("an image ad with no script still opens the composer, not the in-card form", async () => {
    threads = [{ id: "t1", title: "Animated image", last_message_at: "2026-10-25T00:00:00Z" }];
    const v = view("t1", "done");
    v.messages[1].draft = { ...DRAFT, intent: "animate", script: null, visual: "A slow zoom on the product" } as never;
    views = { t1: v };
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("form", { name: /^Edit "/ })).toBeNull();
    expect(screen.getByTestId("video-studio-editing").textContent).toContain("Animated image");
  });
});

describe("threadTitle", () => {
  it("ends at the first sentence end when it is within 60 characters", () => {
    expect(threadTitle("Fresh birthday cakes baked every morning at Cakely. Order by 9am for same-day pickup.", false)).toBe(
      "Fresh birthday cakes baked every morning at Cakely.",
    );
    expect(threadTitle("Is your cake fresh? Ours is baked this morning for you and everyone you love.", false)).toBe("Is your cake fresh?");
  });

  it("never cuts a word when there is no early sentence end", () => {
    const out = threadTitle("Fresh birthday cakes baked every morning at Cakely with real butter and no shortcuts ever", false);
    expect(out).toBe("Fresh birthday cakes baked every morning at Cakely with…");
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it("does not treat a decimal point as a sentence end", () => {
    expect(threadTitle("Rated 4.8 stars by every customer who tried our famous chocolate fudge cake", false)).toBe(
      "Rated 4.8 stars by every customer who tried our famous…",
    );
  });

  it("keeps a short script whole and falls back for empty text", () => {
    expect(threadTitle("  Quick cake ad  ", false)).toBe("Quick cake ad");
    expect(threadTitle("   ", false)).toBe("New video");
    expect(threadTitle("", true)).toBe("Animated image");
    expect(threadTitle("", true, true)).toBe("Presenter video");
    expect(threadTitle("  Fresh   cakes\n daily  ", false)).toBe("Fresh cakes daily");
  });
});

describe("VideoOverview QA follow-ups", () => {
  const OWN = "Our gym opens at five every morning. Come in this week and your first class is free, no card needed at all.";
  const failedDraft = (id: string, user: Record<string, unknown> = {}) => {
    const v = view(id, null);
    v.messages = [
      Object.assign({ ...v.messages[0], body: OWN }, user),
      { ...v.messages[1], draft: null, kind: "video_studio_draft_failed", body: "I couldn't turn that into a video. Try describing it another way." },
    ];
    return v;
  };
  const editForm = () => screen.getByRole("form", { name: /^Edit "/ });

  it("a thread ad shows the credits its own draft is charged, not the Pro starter price", async () => {
    channelsBody = { channels: [{ channel_slug: SLUG, video_credits_each: 840 }] };
    threads = [{ id: "t1", title: "Planner ad", last_message_at: "2026-10-25T00:00:00Z" }];
    const v = view("t1", "failed");
    Object.assign(v.messages[1], { credits: 420 });
    views = { t1: v };
    await mount();
    await waitFor(() => expect(within(ads()[0]).getByTestId("suggested-ad-cost").textContent).toBe("About 420 credits, charged only if the video arrives."));
    expect(ads()[0].textContent).not.toContain("840");
  });

  it("a 500 on send shows Zavi's own words, not the server's generic error", async () => {
    messageAnswers = [{ body: { error: { code: "send_failed", message: "Something went wrong. Try again." } }, status: 500 }];
    await mount();
    type("Failing ad for our local gym today");
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect(ads()[0].getAttribute("data-state")).toBe("failed"));
    expect(within(ads()[0]).getByRole("alert").textContent).toBe("Zavi could not start this video. Try again.");
  });

  it("a new script whose draft fails offers Try again, which resends it word for word in that thread, and Dismiss, which removes it", async () => {
    views = { new1: failedDraft("new1", { verbatim: true }) };
    messageAnswers = [{ body: { thread_id: "new1", reply: { body: "I couldn't turn that into a video." }, render: null } }, () => new Promise(() => undefined)];
    await mount();
    type(OWN);
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect(within(ads()[0]).queryByRole("button", { name: "Try again" })).toBeTruthy());
    expect(ads()).toHaveLength(1);
    expect(adId(ads()[0])).toBe("suggested-ad-thread-new1");
    expect(within(ads()[0]).getByRole("button", { name: "Dismiss" })).toBeTruthy();
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Try again" }));
    expect(within(ads()[0]).queryByRole("button", { name: "Try again" })).toBeNull();
    await act(async () => undefined);
    expect(messagePosts().map((p) => p.body)).toEqual([
      { text: OWN, verbatim: true, new_thread: true },
      { text: OWN, verbatim: true, thread_id: "new1" },
    ]);
    expect(ads()[0].getAttribute("data-state")).toBe("making");
  });

  it("Dismiss on a new thread whose draft failed removes the ad and sends nothing", async () => {
    views = { new1: failedDraft("new1", { verbatim: true }) };
    messageAnswers = [{ body: { thread_id: "new1", reply: { body: "I couldn't turn that into a video." }, render: null } }];
    await mount();
    type(OWN);
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect(within(ads()[0]).queryByRole("button", { name: "Dismiss" })).toBeTruthy());
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Dismiss" }));
    expect(ads()).toHaveLength(0);
    expect(messagePosts()).toHaveLength(1);
  });

  it("an older thread whose draft failed gets Try again but no Dismiss", async () => {
    threads = [{ id: "t1", title: "Gym ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: failedDraft("t1") };
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("failed"));
    expect(within(ads()[0]).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(ads()[0]).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("Edit then Make video on a failed word-for-word script keeps it word for word", async () => {
    threads = [{ id: "t1", title: "Gym ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { t1: failedDraft("t1", { verbatim: true }) };
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("failed"));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    const box = within(editForm()).getByLabelText("Your request") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: `${OWN} Bring a friend.` } });
    fireEvent.submit(editForm());
    await act(async () => within(ads()[0]).getByRole("button", { name: "Make video" }).click());
    expect(messagePosts().map((p) => p.body)).toEqual([{ text: `${OWN} Bring a friend.`, verbatim: true, thread_id: "t1" }]);
  });

  it("an image-only ad is titled like the server titles it, before and after the server answers", async () => {
    const base = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      String(url) === "/api/chat/upload-image" ? res({ image_path: "uploads/face.png" }) : base(url, init),
    );
    const gate = deferred();
    messageAnswers = [() => gate.promise];
    const v = view("new1", "rendering");
    v.messages[0] = { ...v.messages[0], body: "", image_path: "uploads/face.png" };
    views = { new1: v };
    await mount();
    fireEvent.click(screen.getByRole("radio", { name: "Image to video" }));
    await act(async () => {
      fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [new File(["x"], "face.png", { type: "image/png" })] } });
    });
    await waitFor(() => expect(generate().hasAttribute("disabled")).toBe(false));
    await act(async () => fireEvent.click(generate()));
    expect(within(ads()[0]).getByRole("heading").textContent).toBe("Animated image");
    await act(async () => {
      gate.resolve(res({ thread_id: "new1", render: { run_id: "r-new1" } }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(adId(ads()[0])).toBe("suggested-ad-thread-new1"));
    expect(within(ads()[0]).getByRole("heading").textContent).toBe("Presenter video");
    expect(screen.queryByText("Video from your photo")).toBeNull();
  });

  it("Edit on a scene ad with no script opens the composer as a prompt, so Generate does not send it as a word-for-word script", async () => {
    threads = [{ id: "t1", title: "Beach scene", last_message_at: "2026-10-25T00:00:00Z" }];
    const v = view("t1", "done");
    v.messages[0] = { ...v.messages[0], body: "A sunset beach scene with our drink" };
    v.messages[1].draft = { ...DRAFT, intent: "cinematic", script: null, visual: "A sunset beach" } as never;
    views = { t1: v };
    messageAnswers = [() => new Promise(() => undefined)];
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("ready"));
    fireEvent.click(within(ads()[0]).getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("video-studio-editing").textContent).toContain("Beach scene");
    expect(screen.getByRole("switch", { name: /Enable prompt/ }).getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(generate()));
    expect(messagePosts().map((p) => p.body)).toEqual([{ text: "A sunset beach scene with our drink", thread_id: "t1" }]);
  });

  it("an animated image ad says Animated image on its preview, not AI presenter", async () => {
    threads = [{ id: "t1", title: "Product zoom", last_message_at: "2026-10-25T00:00:00Z" }];
    const v = view("t1", "failed");
    v.messages[1].draft = { ...DRAFT, intent: "animate", script: null, visual: "A slow zoom on the product" } as never;
    views = { t1: v };
    await mount();
    await waitFor(() => expect(ads()[0]?.getAttribute("data-state")).toBe("failed"));
    expect(ads()[0].textContent).toContain("Animated image");
    expect(ads()[0].textContent).not.toContain("AI presenter");
  });
});

describe("VideoOverview credit refusal while other videos are being made", () => {
  it("a Generate refused because videos already being made use up the credits tells the founder that, not that the card price is unaffordable", async () => {
    threads = [{ id: "old", title: "Older ad", last_message_at: "2026-10-25T00:00:00Z" }];
    views = { old: view("old", "rendering") };
    messageAnswers = [
      {
        body: {
          error: {
            code: "insufficient_credits",
            message: "server sentence",
            required_credits: 450,
            reason: "videos_ahead",
            ahead_credits: 450,
          },
        },
        status: 402,
      },
    ];
    await mount();
    type("Second ad for our local gym today");
    await act(async () => fireEvent.click(generate()));
    await waitFor(() => expect(within(ads()[0]).getByTestId("suggested-ad-top-up")).toBeTruthy());
    const alert = within(ads()[0]).getByRole("alert");
    expect(alert.textContent).toBe("Not enough credits for this video while your other videos are still being made.");
    expect(alert.textContent).not.toBe("Not enough credits for this video.");
    expect(messagePosts()).toHaveLength(1);
  });
});
