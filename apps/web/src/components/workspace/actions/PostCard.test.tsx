import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as api from "@/lib/api";
import { ChannelActionCard } from "./ChannelActionCard";
import { ChannelSurface } from "./ChannelSurface";
import { makeAction } from "./__tests__/fixtures";
import type { ActionHandlers } from "./types";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("publishes the displayed revision and adopts a new revision only after saving its own edit", async () => {
  const loaded = "a".repeat(64), saved = "b".repeat(64);
  vi.spyOn(api, "apiFetch").mockImplementation(async (_url, options) => new Response(JSON.stringify(options?.method === "PUT"
    ? { revision: saved, content: { text: "Saved here", thread: null } }
    : { revision: loaded, content: null, editable: true }), { status: 200 }));
  const action = makeAction("text_post", { id: "11111111-1111-4111-8111-111111111111", run_id: null, post_revision: loaded, body: { step: { deliverable: { kind: "post", content: "Shown" } } } });
  const onPublish = vi.fn(async () => false);
  const handlers: ActionHandlers = { onPublish, onRedo: vi.fn(), onSetStatus: vi.fn(async () => true) };
  render(<ChannelSurface slug="x_organic"><ChannelActionCard action={action} handlers={handlers} /></ChannelSurface>);
  fireEvent.click(screen.getByRole("button", { name: "Post on X" }));
  await waitFor(() => expect(onPublish).toHaveBeenCalledWith(action, { text: "Shown", thread: null, post_revision: loaded }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false));
  fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Saved here" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Post on X" }));
  await waitFor(() => expect(onPublish).toHaveBeenLastCalledWith(action, { text: "Saved here", thread: null, post_revision: saved }));
});

it("remounts the post content when a refreshed card brings a different saved revision", () => {
  vi.spyOn(api, "apiFetch").mockResolvedValue(new Response(JSON.stringify({ revision: "a".repeat(64), content: null, editable: true })));
  const action = makeAction("text_post", { id: "11111111-1111-4111-8111-111111111111", run_id: null, post_revision: "a".repeat(64), body: { step: { deliverable: { kind: "post", content: "Original" } } } });
  const handlers: ActionHandlers = { onRedo: vi.fn(), onSetStatus: vi.fn(async () => true) };
  const view = render(<ChannelSurface slug="x_organic"><ChannelActionCard action={action} handlers={handlers} /></ChannelSurface>);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Edit post"), { target: { value: "Unsaved local text" } });
  view.rerender(<ChannelSurface slug="x_organic"><ChannelActionCard action={{ ...action, post_revision: "b".repeat(64), edited_body: { text: "Saved in another tab", thread: null } }} handlers={handlers} /></ChannelSurface>);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByTestId("post-text").textContent).toBe("Saved in another tab");
});

it("does not adopt a different revision fetched after the card was displayed", async () => {
  vi.spyOn(api, "apiFetch").mockResolvedValue(new Response(JSON.stringify({ revision: "b".repeat(64), content: null, editable: true })));
  const action = makeAction("text_post", { id: "11111111-1111-4111-8111-111111111111", run_id: null, post_revision: "a".repeat(64), body: { step: { deliverable: { kind: "post", content: "Shown" } } } });
  const onPublish = vi.fn(async () => false);
  const handlers: ActionHandlers = { onPublish, onRedo: vi.fn(), onSetStatus: vi.fn() };
  render(<ChannelSurface slug="x_organic"><ChannelActionCard action={action} handlers={handlers} /></ChannelSurface>);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() => expect(screen.getByText("This draft changed. Refresh before editing it.")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Post on X" }));
  await waitFor(() => expect(onPublish).toHaveBeenCalledWith(action, { text: "Shown", thread: null, post_revision: "a".repeat(64) }));
});
