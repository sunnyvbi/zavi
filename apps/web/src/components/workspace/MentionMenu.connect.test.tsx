// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";

const launched = vi.hoisted(() => [] as string[]);
vi.mock("@/app/connectors/connectStrategies", () => ({
  launchConnect: vi.fn(async (slug: string) => {
    launched.push(slug);
  }),
}));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => null }));

import { MentionMenu } from "./MentionMenu";
import { channelTarget } from "./composer/mentionTargets";

const byExecutor = (e: string) => CHANNELS.find((c) => c.executor === e) as Channel;

afterEach(() => {
  cleanup();
  launched.length = 0;
});

function renderRows(executors: string[], connected: Set<string> | null) {
  render(
    <MentionMenu
      sections={[{ id: "x", heading: "Not connected yet", rows: executors.map((e) => channelTarget(byExecutor(e))) }]}
      cursor={0}
      onSelect={() => {}}
      connected={connected}
    />,
  );
}

describe("MentionMenu Connect pill", () => {
  it("shows Connect for an unlinked channel with a connect path and starts its launcher", () => {
    renderRows(["meta_ads"], new Set());
    fireEvent.mouseDown(screen.getByRole("button", { name: "Connect" }));
    expect(launched).toEqual(["meta_ads"]);
  });

  it("shows no pill for a channel with nothing to connect, a linked one, or before the read lands", () => {
    renderRows(["sms"], new Set());
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    cleanup();
    renderRows(["meta_ads"], new Set(["meta_ads"]));
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    cleanup();
    renderRows(["meta_ads"], null);
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });
});
