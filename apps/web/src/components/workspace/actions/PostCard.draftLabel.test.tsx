import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const handlers: ActionHandlers = { onRedo: vi.fn(), onSetStatus: vi.fn(async () => true) };

function mount(execStatus: "executed" | null) {
  vi.spyOn(api, "apiFetch").mockResolvedValue(new Response(JSON.stringify({ revision: "a".repeat(64), content: null, editable: true })));
  const action = makeAction("text_post", { id: "11111111-1111-4111-8111-111111111111", run_id: null, channel_slug: "linkedin_organic", post_revision: "a".repeat(64), exec_status: execStatus, body: { step: { deliverable: { kind: "post", content: "Shown" } } } });
  render(<ChannelSurface slug="linkedin_organic"><ChannelActionCard action={action} handlers={handlers} /></ChannelSurface>);
  return screen.getByTestId(`action-${action.id}`);
}

it("an executed linkedin_organic post card is not labelled Draft and offers no editor", () => {
  const card = mount("executed");
  expect(card.textContent).toContain("Shown");
  expect(card.textContent).not.toContain("Draft");
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
});
