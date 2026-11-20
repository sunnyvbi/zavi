// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })) }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: () => Promise.resolve(null) }));

import { DISPLAY_CHANNELS } from "@/lib/workspace/feedRows";
import { DecisionCard, type Decision } from "../ChannelsPanel";

afterEach(cleanup);

const channel = DISPLAY_CHANNELS[0]!;
const PATH = "7c70da58-091e-4ff5-8f77-343034d448d9/bd1380c9-a549-4b9c-9d3e-0b2c3d4e5f60.jpg";

const pin = (payload: Record<string, unknown>, channelKey = "pinterest_pin"): Decision => ({
  id: "d1",
  decision_class: "social.publish.v2",
  body: {
    channel: channelKey,
    payload,
    readiness: { ok: true, checks: { board: { status: "pass" }, media: { status: "pass" }, link: { status: "pass" }, identity: { status: "pass" } } },
  },
  handler: null,
  emitted_at: new Date().toISOString(),
  channel_slug: "pinterest_organic",
  action_source: "decision",
  exec_class: null,
});

function mount(d: Decision) {
  const h = { onApprove: vi.fn(), onReject: vi.fn(), onReview: vi.fn(), onOpen: vi.fn(), onOpenChannel: vi.fn() };
  const { container } = render(
    <ul>
      <DecisionCard decision={d} channel={channel} mode="execute" busy={false} {...h} />
    </ul>,
  );
  return { h, card: container.querySelector("li")! };
}

describe("a staged Pinterest pin reads as one card", () => {
  const PAYLOAD = { title: "Cake", text: "ihio", image_path: PATH, board_name: "Yoga", board_id: "1", link: "https://sweet-layers.example.com/custom" };

  it("names the pin by its board once, with no second box and no repeated Pinterest header inside", () => {
    const { card } = mount(pin(PAYLOAD));
    expect(within(card).getByText("New pin")).toBeTruthy();
    expect(within(card).getAllByText("Yoga")).toHaveLength(1);
    expect(within(card).getAllByText("Cake")).toHaveLength(1);
    expect(card.querySelectorAll(".border-rule.shadow-sm")).toHaveLength(0);
    expect(within(card).queryByText(/· board Yoga/)).toBeNull();
    expect(within(card).getByText("Yoga").previousElementSibling?.textContent).toBe("Board");
    const link = within(card).getByRole("link", { name: "sweet-layers.example.com" }) as HTMLAnchorElement;
    expect(link.href).toBe("https://sweet-layers.example.com/custom");
    expect(link.closest("dd")?.previousElementSibling?.textContent).toBe("Link");
    const checks = within(card).getByRole("list", { name: "Pinterest checks" });
    expect(within(checks).getAllByRole("listitem")).toHaveLength(1);
    expect(within(checks).getByRole("listitem").textContent).toContain("Ready to post");
  });

  it("says what Approve does on the same row as the buttons, exactly once", () => {
    const { card, h } = mount(pin(PAYLOAD));
    expect(within(card).getAllByText("Posts to Pinterest when you approve")).toHaveLength(1);
    const row = within(card).getByTestId("pin-posts-note").parentElement!;
    expect(within(row).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Reject" })).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Approve" }));
    expect(h.onApprove).toHaveBeenCalledTimes(1);
  });

  it("a pin without a board still gets a plain header", () => {
    const { card } = mount(pin({ title: "Cake", text: "ihio", image_path: PATH }));
    expect(within(card).getByText("New pin")).toBeTruthy();
  });

  it("other channels' staged posts keep their header, their own box and no pin note", () => {
    const { card } = mount(pin({ text: "Fall weekend", image_path: PATH }, "instagram_image"));
    expect(within(card).queryByText(/New pin/)).toBeNull();
    expect(within(card).queryByTestId("pin-posts-note")).toBeNull();
    expect(card.querySelectorAll(".border-ca-border").length).toBeGreaterThan(0);
    expect(screen.getByText("Publishes when you approve")).toBeTruthy();
  });
});

describe("an approved pin shows its post, never just vanishes", () => {
  const PAYLOAD = { title: "Cake", text: "ihio", image_path: PATH, board_name: "Yoga", board_id: "1", link: "https://sweet-layers.example.com" };
  const mountPosting = (posting: import("../ChannelsPanel").PinPosting) => {
    const h = { onApprove: vi.fn(), onReject: vi.fn(), onReview: vi.fn(), onOpen: vi.fn(), onOpenChannel: vi.fn(), onDismissPosting: vi.fn() };
    const { container } = render(
      <ul>
        <DecisionCard decision={pin(PAYLOAD)} channel={channel} mode="execute" busy={false} posting={posting} {...h} />
      </ul>,
    );
    return { h, card: container.querySelector("li")! };
  };

  it("while posting: a spinner and 'Posting to Pinterest…', and no Approve or Reject to press twice", () => {
    const { card } = mountPosting({ phase: "posting" });
    expect(within(card).getByTestId("pin-posting").textContent).toBe("Posting to Pinterest…");
    expect(within(card).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Reject" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("posted: says so with a link to the pin, with nothing left to press", () => {
    const { card } = mountPosting({ phase: "posted", url: "https://www.pinterest.com/pin/123/" });
    expect(within(card).getByTestId("pin-posted").textContent).toContain("Posted to Pinterest");
    expect((within(card).getByRole("link", { name: "Open pin ↗" }) as HTMLAnchorElement).href).toBe("https://www.pinterest.com/pin/123/");
    expect(within(card).queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(within(card).getByTestId("pin-posted").className).toContain("text-ca-success");
    expect(card.hasAttribute("data-leaving")).toBe(false);
  });

  it("posted and leaving: the card fades out and stops taking clicks", () => {
    const { card } = mountPosting({ phase: "posted", url: null, leaving: true });
    expect(card.hasAttribute("data-leaving")).toBe(true);
    expect(card.className).toContain("opacity-0");
    expect(card.className).toContain("pointer-events-none");
  });

  it("failed: shows the reason on the card and keeps it until dismissed", () => {
    const { card } = mountPosting({ phase: "failed", message: "Pinterest did not accept it. Board not found." });
    expect(within(card).getByRole("alert").textContent).toBe("Couldn't post: Pinterest did not accept it. Board not found.");
    expect(within(card).getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });
});
