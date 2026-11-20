import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { apiFetch } from "@/lib/api";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { ChannelSurface } from "./ChannelSurface";
import { makeAction } from "./__tests__/fixtures";
import type { PlatformSpec } from "./types";
import type { XDraft } from "../agent/xDraftTypes";

vi.mock("./topActions/postToast", () => ({ followPostInToast: vi.fn(async () => ({ state: "posted", url: null })) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("./platforms", async (original) => ({
  ...(await original<typeof import("./platforms")>()), platformFor: () => spec.current,
}));

const actionId = "11111111-1111-4111-8111-111111111111";
const decisionId = "22222222-2222-4222-8222-222222222222";
const image = `${actionId}/33333333-3333-4333-8333-333333333333.png`;
const original = "Original post that the channel run staged.";
const saved = "Saved caption from the paired draft.";
const initialRevision = "a".repeat(64);
let draft: XDraft;
let revision: string;
let acted: boolean;
const approvals: Record<string, unknown>[] = [];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const action = makeAction("text_post", { id: actionId, body: { step: { responsibility: "client", deliverable: { kind: "post", content: original } } } });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  approvals.length = 0;
  revision = initialRevision;
  acted = false;
  draft = { decision_id: decisionId, source: "staged", post_revision: revision, channel: "x_image", text: saved, original_text: original,
    original_image_path: null, thread: null, image_path: image, video_path: null, scheduled_at: null, rationale: null, emitted_at: null,
    edited_body: { text: saved, thread: null, image_path: image, rendered_image_path: image, headline: "Saved photo" } };
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    if (url === `/api/channel-actions/${actionId}` && options?.method === "POST") {
      acted = true;
      return reply({ ok: true });
    }
    if (url === `/api/approvals/${decisionId}/approve`) {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      approvals.push(body);
      return body.expected_post_revision === revision ? reply({ ok: true }) : reply({ error: { code: "stale_card", message: "This post changed. Refresh before publishing." } }, 409);
    }
    if (url.includes("/post-draft") && options?.method === "PUT") {
      const input = JSON.parse(String(options.body)) as { content: { text: string; thread: null } };
      revision = "b".repeat(64);
      draft = { ...draft, post_revision: revision, text: input.content.text, edited_body: { ...draft.edited_body, ...input.content } };
      return reply({ revision, content: draft.edited_body });
    }
    if (url.includes("/post-draft")) return reply({ revision, content: draft.edited_body, editable: true });
    if (url.includes("image-url")) return reply({ signed_url: "https://example.com/saved.png" });
    if (url.includes("/actions") && !options?.method) return reply({ actions: acted ? [] : [action], more: 0, store: "channel_actions" });
    if (url.includes("/dashboard")) return reply({ connected: true, attention: [], drafts: [draft], metrics: [], read: { read: true } });
    if (url.includes("/metrics")) return reply({ metrics: [] });
    return reply({ ok: true });
  });
});
afterEach(cleanup);

async function mount(slug: "x_organic" | "linkedin_organic") {
  const platforms = await vi.importActual<typeof import("./platforms")>("./platforms");
  spec.current = platforms.platformFor(slug);
  draft.channel = slug === "x_organic" ? "x_image" : "linkedin_image";
  const view = render(<ChannelSurface slug={slug}><ChannelActionsLane slug={slug} legacy={<p>Legacy</p>} workState="idle" lastRunAt={null} actionCount={1} connected hasConnectors><li>Prior row</li></ChannelActionsLane></ChannelSurface>);
  await waitFor(() => expect(screen.getByTestId("post-text").textContent).toBe(draft.text));
  return view;
}

it.each(["x_organic", "linkedin_organic"] as const)("%s renders and publishes the paired saved caption, photo and revision", async (slug) => {
  await mount(slug);
  expect(screen.getAllByTestId("post-text")).toHaveLength(1);
  await waitFor(() => expect(screen.getByRole("img", { name: "Saved photo" }).getAttribute("src")).toContain("saved.png"));
  const card = screen.getByTestId("post-text").closest("article");
  if (!card) throw new Error("Missing card");
  fireEvent.click(within(card).getByRole("button", { name: /^Post on / }));
  await waitFor(() => expect(approvals).toHaveLength(1));
  expect(approvals[0]).toMatchObject({ expected_post_revision: initialRevision, payload_text: saved, image_path: image });
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => url === "/api/social/propose")).toBe(false);
  await screen.findByText(/^Posted on /);
  expect(screen.queryByRole("button", { name: /^Post on / })).toBeNull();
});

it("publishes a revision saved on a paired channel card without requiring a refresh", async () => {
  await mount("x_organic");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false));
  fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Saved on this card" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(vi.mocked(apiFetch).mock.calls.some(([url, options]) => url.includes(`/${decisionId}/post-draft?store=decisions`) && options?.method === "PUT")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /^Post on / }));
  await waitFor(() => expect(approvals).toHaveLength(1));
  expect(approvals[0]).toMatchObject({ expected_post_revision: "b".repeat(64), payload_text: "Saved on this card" });
});

it("keeps stale paired cards pending and renders the latest draft after reloading", async () => {
  const view = await mount("x_organic");
  revision = "b".repeat(64);
  draft = { ...draft, post_revision: revision, text: "Saved in another tab", edited_body: { ...draft.edited_body, text: "Saved in another tab", thread: null } };
  fireEvent.click(screen.getByRole("button", { name: /^Post on / }));
  await screen.findByText("This post changed. Refresh before publishing.");
  expect(approvals[0].expected_post_revision).toBe(initialRevision);
  view.unmount();
  await mount("x_organic");
  fireEvent.click(screen.getByRole("button", { name: /^Post on / }));
  await waitFor(() => expect(approvals).toHaveLength(2));
  expect(approvals[1].expected_post_revision).toBe(revision);
});
