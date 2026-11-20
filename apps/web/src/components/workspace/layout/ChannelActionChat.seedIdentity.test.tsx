// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const seen = vi.hoisted(() => [] as unknown[]);
vi.mock("../sidechat/SideChat", () => ({
  channelChatWidthKey: (slug: string) => `zavi.channelChat.${slug}.width`,
  SideChat:({ seed }: { seed?: unknown }) => {
    seen.push(seed);
    return null;
  },
}));
vi.mock("@/components/ZaviMascot", () => ({ ZaviMascot: () => null }));

import { ChannelActionChat } from "./ChannelActionChat";
import type { ChannelChatPin } from "../actions/channelChat";

afterEach(() => {
  cleanup();
  seen.length = 0;
});

it("hands down the pin's own draft object on every mount", () => {
  const draft = { text: "Write episode 2 now", nonce: 1, autoSend: true };
  const pin: ChannelChatPin = { target: "channel", draft };
  const a = render(<ChannelActionChat pin={pin} channelSlug="instagram_organic" channelName="Instagram" open onClose={() => {}} />);
  a.unmount();
  render(<ChannelActionChat pin={pin} channelSlug="instagram_organic" channelName="Instagram" open onClose={() => {}} />);
  expect(seen.length).toBeGreaterThanOrEqual(2);
  for (const s of seen) expect(s).toBe(draft);
});
