// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const shared = vi.hoisted(() => ({ marketplaceEnabled: true }));
vi.mock("@zavi/shared", () => ({ get CREATOR_MARKETPLACE_ENABLED() { return shared.marketplaceEnabled; } }));

vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return {
    ...actual,
    creatorApi: {
      threadMessages: vi.fn(async () => ({ messages: [] })),
      threadOffers: vi.fn(async () => ({ offers: [] })),
      markThreadRead: vi.fn(async () => ({ ok: true })),
    },
  };
});

import { CreatorThreadView } from "./CreatorThread";

afterEach(() => {
  cleanup();
  shared.marketplaceEnabled = true;
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("creator: Send a custom offer", () => {
  it("scrolls the new offer form fully into view when it opens", async () => {
    const scroll = vi.fn();
    const scrolled: Element[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      value: function (this: Element, opts: unknown) {
        scrolled.push(this);
        scroll(opts);
      },
      configurable: true,
    });
    render(<CreatorThreadView threadId="t1" name="UpcarAI" />);
    const button = await screen.findByRole("button", { name: "Send a custom offer" });
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(button);
    const form = await screen.findByTestId("offer-form");
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" }));
    expect(scrolled.at(-1)).toBe(form);
  });

  it("keeps messages available but removes new offers when the marketplace is retired", async () => {
    shared.marketplaceEnabled = false;
    render(<CreatorThreadView threadId="t1" name="UpcarAI" />);
    expect(await screen.findByLabelText("Write a message")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send a custom offer" })).toBeNull();
    expect(screen.queryByText("How offers work")).toBeNull();
  });
});
