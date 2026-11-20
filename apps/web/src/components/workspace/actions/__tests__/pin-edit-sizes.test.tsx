// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { platformFor } from "../platforms";
import { makeAction } from "./fixtures";

vi.mock("../managed-campaigns/api", async (original) => ({
  ...(await original<typeof import("../managed-campaigns/api")>()),
  campaignFetch: vi.fn().mockResolvedValue({ files: [] }),
}));

const IMAGE = "https://cdn.example.com/pin.jpg";
const COPY = "Title: Small kitchen storage ideas\nDescription: Ten ways to clear a counter.\nDestination: https://www.example.com/kitchen\nBoard: Kitchen ideas";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

function openEditor(slug: string) {
  const a = makeAction("image_post", { channel_slug: slug, body: { media: { kind: "image", url: IMAGE }, step: { deliverable: { kind: "post", content: COPY } } } } as never);
  render(<ChannelActionCard action={a} platform={platformFor(slug)} handlers={{ onSetStatus: vi.fn(), onRedo: vi.fn(), onOpenChat: vi.fn() }} />);
  const edit = screen.queryByRole("button", { name: "Edit" });
  if (edit) return fireEvent.click(edit);
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Edit/ }));
}

describe("editing a Pinterest pin", () => {
  it("offers pin sizes and returns to the standard size after a reset", () => {
    openEditor("pinterest_organic");
    expect(screen.getByRole("button", { name: "Standard 2:3" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Feed 4:5" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Square 1:1" }));
    fireEvent.click(screen.getByRole("button", { name: /Reset to Zavi/ }));
    expect(screen.getByRole("button", { name: "Standard 2:3" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Select photo" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the feed sizes on Instagram", () => {
    openEditor("instagram_organic");
    expect(screen.getByRole("button", { name: "Feed 4:5" }).getAttribute("aria-pressed")).toBe("true");
  });
});
