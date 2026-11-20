// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ActionHandlers } from "../types";

const { apiFetch, approveDecision } = vi.hoisted(() => ({ apiFetch: vi.fn(), approveDecision: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision }));
vi.mock("@/lib/analytics/posthog", () => ({ captureEvent: vi.fn() }));

const { ChannelActionCard } = await import("../ChannelActionCard");
const { platformFor } = await import("./index");
const { makeAction } = await import("../__tests__/fixtures");
await import("../../agent/xStagedPosts");

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  approveDecision.mockReset();
  approveDecision.mockResolvedValue({ ok: true, json: async () => ({}) });
});

const platform = platformFor("linkedin_organic");
const SHARE = "https://www.linkedin.com/feed/?shareActive=true&text=";
const handlers = (over: Partial<ActionHandlers> = {}) =>
  ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onOpenChat: vi.fn(), ...over }) satisfies ActionHandlers;

const POST = "I kept waiting at rental counters.\n\nSo I built Upcar. 🚗";
const COMMENT =
  "The trust layer is the real sticking point, not the supply. [one sentence from your own week: a customer moment only you saw]";
const postAction = () =>
  makeAction("text_post", { channel_slug: "linkedin_organic", body: { step: { deliverable: { kind: "post", content: POST } } } });
const commentAction = () =>
  makeAction("reply", { channel_slug: "linkedin_organic", body: { step: { deliverable: { kind: "comment", content: COMMENT } } } });

const ok = (body: unknown) => ({ ok: true, json: async () => body });

it("reads the personal publishing identity without borrowing the company metrics identity", () => {
  const account = platform.accountFromPayload!({ account: { name: "Upcar company" }, publishing_account: { name: "Ravi Founder" } });
  expect(account).toEqual({ name: "Ravi Founder", handle: "Connected publishing profile" });
  expect(platform.hidePublishingAccount).toBe(true);
  render(<ChannelActionCard action={postAction()} platform={{ ...platform, account }} handlers={handlers({ onPublish: vi.fn() })} />);
  expect(screen.getByRole("button", { name: "Post on LinkedIn" })).toBeTruthy();
  expect(screen.queryByText("Upcar company")).toBeNull();
});
it("keeps connection chrome out of the final card when the publishing identity is unknown", () => {
  expect(platform.accountFromPayload!({ account: { name: "Upcar company" } })).toBeUndefined();
  render(<ChannelActionCard action={postAction()} platform={platform} handlers={handlers({ onPublish: vi.fn() })} />);
  expect(screen.getByRole("button", { name: "Post on LinkedIn" })).toBeTruthy();
  expect(screen.queryByText(/Connected/)).toBeNull();
  expect(screen.queryByText("Upcar company")).toBeNull();
});

describe("linkedin_organic — not connected (most founders)", () => {
  it("one button, Open draft, into LinkedIn's share box with the text filled in", () => {
    render(<ChannelActionCard action={postAction()} platform={platform} handlers={handlers()} />);
    const link = screen.getByRole("link", { name: "Open draft in browser account" });
    expect(link.getAttribute("href")).toBe(`${SHARE}${encodeURIComponent(POST)}`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("button", { name: /^Post$/ })).toBeNull();
  });

  it("a comment draft never opens the share box: Copy and Done only", () => {
    render(<ChannelActionCard action={commentAction()} platform={platform} handlers={handlers()} />);
    expect(document.querySelector(`a[href^="${SHARE}"]`)).toBeNull();
    expect(screen.queryByRole("link", { name: /open draft/i })).toBeNull();
    const card = screen.getByRole("article", { name: "Title for reply" });
    expect(card.textContent).toContain("The trust layer is the real sticking point, not the supply.");
    expect(card.textContent).toContain("[one sentence from your own week: a customer moment only you saw]");
    expect(screen.getByRole("button", { name: /^Copy post/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Post on LinkedIn/i })).toBeNull();
  });
});

describe("linkedin_organic — connected", () => {
  it("uses the final Post on LinkedIn action and publishes once", async () => {
    const onPublish = vi.fn().mockResolvedValue(true);
    const h = handlers({ onPublish });
    render(<ChannelActionCard action={postAction()} platform={platform} handlers={h} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Post on LinkedIn" }));
    });
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onPublish.mock.calls[0]?.[1]).toEqual({ text: POST, thread: null });
    expect(h.onSetStatus).toHaveBeenCalledWith(expect.anything(), "acted", { keep: true });
  });

  it("a comment draft STILL gets no Post button", () => {
    render(<ChannelActionCard action={commentAction()} platform={platform} handlers={handlers({ onPublish: vi.fn() })} />);
    expect(screen.queryByRole("button", { name: /^Post$/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /open draft/i })).toBeNull();
  });
});

describe("linkedin_organic — publish never posts twice", () => {
  const publish = platform!.publish!;
  const DASHBOARD = "/api/agents/linkedin_organic/dashboard";
  const staged = (id: string, channel: string, text: string) => ({
    decision_id: id, source: "staged", label: null, needs_confirm: false, channel, text,
    thread: null, image_path: null, video_path: null, scheduled_at: null, rationale: null, emitted_at: null,
  });
  const proposeCalls = () => apiFetch.mock.calls.filter((c) => c[0] === "/api/social/propose");

  it("nothing staged → stages ONE proposal on the `linkedin` rail, then approves it", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === DASHBOARD ? ok({ drafts: [] }) : ok({ decision_id: "dec-new" }),
    );
    expect(await publish(postAction(), { text: POST, thread: null })).toBe(true);
    expect(proposeCalls()).toHaveLength(1);
    expect(JSON.parse(proposeCalls()[0]![1].body)).toEqual({ channel: "linkedin", payload: { text: POST } });
    expect(approveDecision).toHaveBeenCalledWith("dec-new");
  });

  it("the run already staged this copy → approves THAT one and stages nothing", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === DASHBOARD ? ok({ drafts: [staged("dec-staged", "linkedin", POST)] }) : ok({}),
    );
    expect(await publish(postAction(), { text: POST, thread: null })).toBe(true);
    expect(proposeCalls()).toHaveLength(0);
    expect(approveDecision).toHaveBeenCalledWith("dec-staged");
  });

  it("an edit still pairs on the run's copy, and goes out as the replacement body", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === DASHBOARD ? ok({ drafts: [staged("dec-staged", "linkedin", POST)] }) : ok({}),
    );
    const edited = { ...postAction(), edited_body: { text: "Edited by the founder.", thread: null } };
    await publish(edited, { text: "Edited by the founder.", thread: null });
    expect(proposeCalls()).toHaveLength(0);
    expect(approveDecision).toHaveBeenCalledWith("dec-staged", { payload_text: "Edited by the founder.", thread: null });
  });

  it("pairs on the dashboard's drafts and never reads the capped Approvals list", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === DASHBOARD ? ok({ drafts: [staged("dec-staged", "linkedin_image", POST)] }) : ok({}),
    );
    await publish(postAction(), { text: POST, thread: null });
    expect(apiFetch.mock.calls.some((c) => String(c[0]).startsWith("/api/approvals"))).toBe(false);
    expect(proposeCalls()).toHaveLength(0);
    expect(approveDecision).toHaveBeenCalledWith("dec-staged");
  });

  it("a shorter variant that only prefixes this post is not its proposal", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === DASHBOARD ? ok({ drafts_ok: true, drafts: [staged("dec-short", "linkedin", POST.slice(0, 20))] }) : ok({ decision_id: "dec-new" }),
    );
    await publish(postAction(), { text: POST, thread: null });
    expect(approveDecision).not.toHaveBeenCalledWith("dec-short");
  });

  it("a staged card approves its own decision and reads nothing", async () => {
    await publish({ ...postAction(), id: "dec-card", run_id: null }, { text: POST, thread: null });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(proposeCalls()).toHaveLength(0);
    expect(approveDecision).toHaveBeenCalledWith("dec-card");
  });

  it("a failed lookup throws and stages nothing: guessing 'not staged' is the double post", async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(publish(postAction(), { text: POST, thread: null })).rejects.toThrow(/already waiting/);
    expect(proposeCalls()).toHaveLength(0);
    expect(approveDecision).not.toHaveBeenCalled();
  });

  it("refuses a comment outright, and touches no network", async () => {
    expect(await publish(commentAction(), { text: COMMENT, thread: null })).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("names LinkedIn, not X, when the platform refuses the post", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === DASHBOARD ? ok({ drafts: [] }) : ok({ decision_id: "dec-new" }),
    );
    approveDecision.mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(publish(postAction(), { text: POST, thread: null })).rejects.toThrow(/^LinkedIn did not/);
  });
});

describe("linkedin_organic — the row itself", () => {
  it("counts the exact copy with the backend's UTF-16 limit", () => {
    expect(platform?.measure?.("🚗🚗🚗")).toBe(6);
    expect(platform?.measure?.("e\u0301")).toBe(2);
    expect(platform?.measure?.("a".repeat(2998) + "🚗")).toBe(platform?.charLimit);
    expect(platform?.measure?.("a".repeat(2999) + "🚗")).toBe((platform?.charLimit ?? 0) + 1);
  });
  it("labels exactly the keys the backend reader writes", () => {
    expect(Object.keys(platform?.metricDisplay ?? {}).sort()).toEqual(
      ["comments", "days_since_last_post", "engagement_rate", "followers", "reactions", "reposts", "total_posts"],
    );
  });
});

it("keeps separately staged posts whose opening matches but ending differs", () => {
  const prefix = "Same long opening. ".repeat(10);
  const action = {...postAction(), body:{step:{deliverable:{kind:"post",content:prefix+"First ending."}}}};
  const projected = platform!.stagedCards!({drafts:[{decision_id:"different-post",source:"staged",channel:"linkedin",text:prefix+"Second ending.",thread:null,image_path:null,video_path:null,scheduled_at:null,emitted_at:null}]},[action] as never);
  expect(projected.some(x=>x.id === "different-post")).toBe(true);
  expect(projected.find(x=>x.id === action.id)?.staged_draft_id).toBeFalsy();
});
it("shows the manual route and asks to recheck an older draft", () => {
  render(<ChannelActionCard action={{...postAction(),proposed_at:"2026-01-01T00:00:00Z"}} platform={platform} handlers={handlers()}/>);
  expect(screen.getByTestId("linkedin-draft-status").textContent).toContain("publish manually");
  expect(screen.getByTestId("linkedin-draft-status").textContent).toContain("Review this older draft");
});

it("publishing never approves another post sharing its first 120 characters", async () => {
  const prefix = "Same opening sentence. ".repeat(10);
  const original = prefix + "First ending.";
  apiFetch.mockImplementation(async (path: string) => path === "/api/agents/linkedin_organic/dashboard" ? ok({drafts:[{decision_id:"wrong-post",source:"staged",channel:"linkedin",text:prefix+"Different ending.",thread:null}]}) : ok({decision_id:"new-post"}));
  await platform.publish!({...postAction(),body:{step:{deliverable:{kind:"post",content:original}}}}, {text:original,thread:null});
  expect(approveDecision).toHaveBeenCalledWith("new-post");
  expect(approveDecision).not.toHaveBeenCalledWith("wrong-post");
});

it.each(["queued", "dispatching", "executed"] as const)("does not label a %s post as an unapproved draft", (exec_status) => {
 render(<ChannelActionCard action={{...postAction(),exec_status}} platform={platform} handlers={handlers()}/>);
 expect(screen.queryByTestId("linkedin-draft-status")).toBeNull();
});
