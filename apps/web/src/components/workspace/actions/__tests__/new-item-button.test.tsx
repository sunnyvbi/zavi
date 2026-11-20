// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PlatformSpec } from "../types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("../platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "../ChannelActionsLane";
import { ChannelChatProvider, type ChannelChatPin } from "../channelChat";
import { email_marketing } from "../platforms/email_marketing";

const withNewItem: PlatformSpec = { ...email_marketing, newItem: { label: "New email", request: "Draft a new email for one of my lists: " } };

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, clone() { return this; } });
apiFetch.mockImplementation(async (url: string) => (String(url).includes("/actions") ? ok({ actions: [], more: 0, store: "channel_actions" }) : ok({ metrics: [] })));

function lane(open?: (pin: ChannelChatPin) => void) {
  const el = (
    <ChannelActionsLane slug="email_marketing" legacy={<p>legacy</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>
      {null}
    </ChannelActionsLane>
  );
  return render(open ? <ChannelChatProvider open={open}>{el}</ChannelChatProvider> : el);
}

afterEach(cleanup);

describe("New email", () => {
  it("opens the channel chat with the request in the box, unsent", async () => {
    spec.current = withNewItem;
    const open = vi.fn();
    lane(open);
    const btn = await waitFor(() => screen.getByTestId("channel-new-item"));
    expect(btn.textContent).toBe("New email");
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledTimes(1);
    const pin = open.mock.calls[0][0] as ChannelChatPin & { target: "channel" };
    expect(pin.target).toBe("channel");
    expect(pin.draft?.text).toMatch(/^Draft a new email/);
    expect(pin.draft?.autoSend).toBeUndefined();
  });

  it("is absent where no chat column exists, and on a row that declares none", async () => {
    spec.current = withNewItem;
    lane();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId("channel-new-item")).toBeNull();
    cleanup();
    spec.current = email_marketing;
    lane(vi.fn());
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId("channel-new-item")).toBeNull();
  });

  it("Email campaigns keeps New campaign in the header, not above the actions; Run now is the outlined secondary", async () => {
    spec.current = email_marketing;
    lane(vi.fn());
    expect(email_marketing.headTools).toBe("email_campaign");
    const run = await screen.findByTestId("run-channel");
    expect(run.className).toContain("bg-ca-bg");
    expect(run.className).not.toContain("bg-ca-action");
    expect(screen.queryByTestId("channel-top-actions")).toBeNull();
    expect(screen.queryByText(/New email|New campaign/)).toBeNull();
  });

  it("a channel that does not declare a secondary run keeps the dark Run now", async () => {
    spec.current = { ...email_marketing, runIsSecondary: undefined };
    lane(vi.fn());
    const run = await screen.findByTestId("run-channel");
    expect(run.className).toContain("bg-ca-action");
  });

  it("Email campaigns shows no run cost; a channel without the flag still does", async () => {
    spec.current = email_marketing;
    lane(vi.fn());
    await screen.findByTestId("run-channel");
    expect(screen.queryByTestId("run-cost")).toBeNull();
    expect(screen.queryByText(/credits/i)).toBeNull();
    cleanup();
    spec.current = { ...email_marketing, hideRunCost: undefined };
    lane(vi.fn());
    await screen.findByTestId("run-channel");
    await waitFor(() => expect(screen.queryByTestId("run-cost") ?? screen.queryByText(/credits/i)).not.toBeNull());
  });

  it("Email campaigns hides the generic account snapshot; other channels keep it", async () => {
    spec.current = email_marketing;
    lane(vi.fn());
    await screen.findByTestId("run-channel");
    const snap = document.querySelector('[data-section="snapshot"]') as HTMLElement | null;
    expect(snap === null || snap.hidden).toBe(true);
    cleanup();
    spec.current = { ...email_marketing, hideAccountSnapshot: undefined };
    lane(vi.fn());
    await screen.findByTestId("run-channel");
    const shown = document.querySelector('[data-section="snapshot"]') as HTMLElement | null;
    expect(shown).not.toBeNull();
    expect(shown!.hidden).toBe(false);
  });
});
