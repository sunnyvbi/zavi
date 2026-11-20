// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";
import { announceChannelActionsChanged } from "./topActions/api";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const SLUG = "linkedin_organic";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const first = makeAction("text_post", { id: "ca-1", channel_slug: SLUG, title: "The card already on the page" });
const pasted = makeAction("check", { id: "ca-2", channel_slug: SLUG, title: "The email pasted a moment ago" });
let actions = [first];

const actionReads = () => apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(`/api/channels/${SLUG}/actions`));

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount() {
  return render(
    <ChannelActionsLane slug={SLUG} legacy={<p>LEGACY RAIL</p>} workState="idle" lastRunAt="2026-09-20T10:00:00Z" actionCount={0} connected hasConnectors>
      <li>an approvals row</li>
    </ChannelActionsLane>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
  actions = [first];
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes(`/api/channels/${SLUG}/actions`)) return ok({ actions, more: 0, store: "channel_actions" });
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    return ok({});
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a card added outside a run", () => {
  it("re-reads the list once when this channel says its cards changed, and the new card appears without a reload and starts no polling", async () => {
    mount();
    await flush();
    expect(actionReads()).toHaveLength(1);
    expect(screen.queryAllByText("The email pasted a moment ago")).toHaveLength(0);
    actions = [first, pasted];
    act(() => announceChannelActionsChanged(SLUG));
    await flush();
    expect(actionReads()).toHaveLength(2);
    expect(screen.queryAllByText("The email pasted a moment ago").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("The card already on the page").length).toBeGreaterThan(0);
    await flush(120_000);
    expect(actionReads()).toHaveLength(2);
  });

  it("ignores the same signal from another channel", async () => {
    mount();
    await flush();
    actions = [first, pasted];
    act(() => announceChannelActionsChanged("email_marketing"));
    await flush();
    expect(actionReads()).toHaveLength(1);
    expect(screen.queryAllByText("The email pasted a moment ago")).toHaveLength(0);
  });
});
