// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const CARD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const h = vi.hoisted(() => ({
  location: "/workspace?tab=channels&channel=geo",
  chatProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/responsive", () => ({
  useIsCompact: () => false,
  useMediaMatch: () => false,
}));
vi.mock("../navigation/useWorkspaceLocation", () => ({
  useWorkspaceLocation: () => h.location,
}));
vi.mock("../navigation/workspaceRoutes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => h.location,
  replaceWorkspaceLocation: () => {},
  pushWorkspaceLocation: () => {},
}));
vi.mock("./ChannelActionChat", () => ({
  ChannelActionChat: (props: Record<string, unknown>) => {
    h.chatProps.push(props);
    return null;
  },
}));

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";
import { useChannelChatOpener } from "../actions/channelChat";

const entry = (slug: string, name: string): ChannelEntry =>
  ({ channel: { slug, name, connectors: [] }, count: 0, waiting: 0, subtitle: null, lock: null }) as unknown as ChannelEntry;

function Detail() {
  const openChat = useChannelChatOpener();
  return (
    <>
      <button type="button" onClick={() => openChat?.({ target: "channel" })}>
        open-channel-chat
      </button>
      <button
        type="button"
        onClick={() =>
          openChat?.({
            target: "action",
            mode: "ask",
            action: { id: CARD_B, title: "Card B" },
            onRedo: async () => true,
          } as never)
        }
      >
        ask-b
      </button>
    </>
  );
}

const page = () => (
  <ChannelsPage
    entries={[entry("geo", "GEO"), entry("seo", "SEO")]}
    loading={false}
    onShow={() => {}}
    onUpgrade={() => {}}
    renderDetail={() => <Detail />}
  />
);

const last = () => h.chatProps[h.chatProps.length - 1];

beforeEach(() => {
  window.localStorage.clear();
  h.chatProps = [];
  h.location = "/workspace?tab=channels&channel=geo";
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

describe("ChannelsPage hands a card deep link to the chat column", () => {
  it("passes the linked card id when ?action= names a card on the open channel", async () => {
    h.location = `/workspace?tab=channels&channel=geo&action=${CARD_A}`;
    await act(async () => {
      render(page());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "open-channel-chat" }));
    });
    const channelColumns = h.chatProps.filter((p) => (p.pin as { target: string }).target === "channel");
    expect(channelColumns.length).toBeGreaterThan(0);
    for (const p of channelColumns) expect(p.linkedActionId).toBe(CARD_A);
  });

  it("passes no link without ?action=, and ignores a non-uuid action", async () => {
    await act(async () => {
      render(page());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "open-channel-chat" }));
    });
    expect(h.chatProps.length).toBeGreaterThan(0);
    for (const p of h.chatProps) expect(p.linkedActionId).toBeNull();
    cleanup();
    h.chatProps = [];
    h.location = "/workspace?tab=channels&channel=geo&action=not-a-card";
    await act(async () => {
      render(page());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "open-channel-chat" }));
    });
    expect(h.chatProps.length).toBeGreaterThan(0);
    for (const p of h.chatProps) expect(p.linkedActionId).toBeNull();
  });

  it("Ask Zavi on another card after a deep link pins the column to that card", async () => {
    h.location = `/workspace?tab=channels&channel=geo&action=${CARD_A}`;
    await act(async () => {
      render(page());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ask-b" }));
    });
    const p = last() as { pin: { target: string; action?: { id: string } } };
    expect(p.pin.target).toBe("action");
    expect(p.pin.action?.id).toBe(CARD_B);
  });
});
