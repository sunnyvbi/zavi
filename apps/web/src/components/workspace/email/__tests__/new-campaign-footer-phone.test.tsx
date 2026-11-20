// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  apiFetch: async () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }),
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("../../actions/channelPlanLock", () => ({ useChannelPlanLock: () => null, upgradeOnPlanRefusal: () => false }));

import { NewCampaignDialog } from "../NewCampaignDialog";

const classes = (el: HTMLElement) => el.className.split(/\s+/);

function guardFooter() {
  const footer = screen.getByTestId("action-modal-footer");
  const buttons = screen.getByTestId("action-modal-buttons");
  const hint = screen.getByTestId("action-modal-hint");
  const row = classes(footer);
  expect(row).toContain("flex-col");
  expect(row).toContain("sm:flex-row");
  expect(row).toContain("sm:items-center");
  expect(row).toContain("px-6");
  expect(footer.contains(buttons)).toBe(true);
  expect(footer.contains(hint)).toBe(true);
  const group = classes(buttons);
  expect(group).not.toContain("shrink-0");
  expect(group).toContain("sm:shrink-0");
  expect(group).toContain("w-full");
  expect(group).toContain("flex-wrap");
  expect(classes(hint)).toContain("min-w-0");
  for (const b of Array.from(buttons.querySelectorAll("button"))) expect(classes(b)).toEqual(expect.arrayContaining(["inline-flex", "items-center", "justify-center"]));
  return buttons;
}

describe("New campaign footer at phone width (structural class guard, not a pixel measurement)", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  });
  afterEach(cleanup);

  it("Write it mode stacks the hint above the buttons below sm", async () => {
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
    const buttons = guardFooter();
    expect(buttons.textContent).toContain("Write it");
  });

  it("Plan it mode stacks the hint above the buttons below sm", async () => {
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Pick a time/ }));
    const buttons = guardFooter();
    expect(buttons.textContent).toContain("Plan it");
  });

  it("Paste my email mode stacks the hint above the buttons below sm", async () => {
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    const buttons = guardFooter();
    expect(buttons.textContent).toContain("Add it for approval");
    expect(screen.getByTestId("action-modal-hint").textContent).toContain("Nothing is sent until an owner or admin approves it.");
  });
});
