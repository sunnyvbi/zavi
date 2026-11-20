// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import {
  ChannelRefreshNotice,
  ChannelRefreshProvider,
  updatedAgo,
  useChannelReadCachedAt,
} from "./ChannelRefresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const MIN = 60_000;

function Read({ at }: { at: number | null }) {
  const ownLine = useChannelReadCachedAt(at);
  return ownLine ? <p>own line</p> : null;
}

function Page({ a, b }: { a: number | null; b: number | null }) {
  return (
    <ChannelRefreshProvider>
      <ChannelRefreshNotice />
      <Read at={a} />
      <Read at={b} />
    </ChannelRefreshProvider>
  );
}

it("shows the age of the oldest cached read, and clears once all are fresh", async () => {
  const now = Date.now();
  const { rerender } = render(<Page a={now - 12 * MIN} b={now - 3 * MIN} />);
  expect(screen.getByTestId("channel-cached-line").textContent).toBe("Updated 12 min ago");

  await act(async () => rerender(<Page a={null} b={now - 3 * MIN} />));
  expect(screen.getByTestId("channel-cached-line").textContent).toBe("Updated 3 min ago");

  await act(async () => rerender(<Page a={null} b={null} />));
  expect(screen.queryByTestId("channel-cached-line")).toBeNull();
});

it("tells a read outside a channel page to render its own line", () => {
  render(<Read at={Date.now()} />);
  expect(screen.getByText("own line")).toBeTruthy();
});

it("words the age plainly", () => {
  const now = Date.now();
  expect(updatedAgo(now - 20_000, now)).toBe("just now");
  expect(updatedAgo(now - MIN, now)).toBe("1 min ago");
  expect(updatedAgo(now - 45 * MIN, now)).toBe("45 min ago");
  expect(updatedAgo(now - 130 * MIN, now)).toBe("2 h ago");
});

it("keeps the cached line's height once the fresh read lands, so the page below does not move up", async () => {
  const now = Date.now();
  const { container, rerender } = render(<Page a={now - 12 * MIN} b={null} />);
  const line = screen.getByTestId("channel-cached-line");
  const lineBox = line.className.split(" ").filter((c) => c !== "text-inkMuted").sort();
  expect(container.firstElementChild).toBe(line);

  await act(async () => rerender(<Page a={null} b={null} />));
  expect(screen.queryByTestId("channel-cached-line")).toBeNull();
  const slot = screen.getByTestId("channel-cached-slot");
  expect(container.firstElementChild).toBe(slot);
  expect(slot.getAttribute("aria-hidden")).toBe("true");
  expect(slot.textContent?.trim()).toBe("");
  expect(slot.textContent?.length).toBe(1);
  const slotBox = slot.className.split(" ").filter((c) => c !== "invisible").sort();
  expect(slotBox).toEqual(lineBox);
  expect(slot.className.split(" ")).toContain("invisible");
  expect(slot.className.split(" ")).not.toContain("hidden");
});

it("reserves nothing on a page that never painted a cached answer", () => {
  render(<Page a={null} b={null} />);
  expect(screen.queryByTestId("channel-cached-slot")).toBeNull();
  expect(screen.queryByTestId("channel-cached-line")).toBeNull();
});
