// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { channelTabs, ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const flush = async (ticks = 16) => {
  await act(async () => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  });
};

const respond = (ok: boolean, body: unknown) =>
  Promise.resolve({ ok, status: ok ? 200 : 400, json: async () => body });

type PutItem = { item: string } & Record<string, unknown>;

const puts = (): { path: string; items: PutItem[] }[] =>
  apiFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([path, init]) => ({
      path: String(path),
      items: (JSON.parse(String((init as RequestInit).body)) as { items: PutItem[] }).items,
    }));

async function mountReddit(fields: Record<string, unknown[]>) {
  apiFetch.mockImplementation((_path: string, init?: RequestInit) =>
    init?.method === "PUT" ? respond(true, {}) : respond(true, { fields }),
  );
  render(
    <ChannelSettingsTab slug="reddit_organic" fields={PLATFORMS.reddit_organic.settings ?? []} />,
  );
  await flush();
}

const save = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await flush();
};

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

describe("the channel page has two tabs and Reddit did not get a third", () => {
  it("offers only Overview and Settings, on every channel", () => {
    for (const [slug, platform] of Object.entries(PLATFORMS)) {
      const keys = channelTabs(platform).map(([k]) => k);
      if (platform.studio) {
        expect(keys, `${slug} is a studio channel and has only Overview and Library`).toEqual(["studio", "library"]);
        continue;
      }
      expect(keys, `${slug} grew a tab that is not Overview or Settings`).toEqual(
        platform.settings?.length ? ["overview", "settings"] : ["overview"],
      );
    }
  });

  it("gives Reddit exactly the two every settings-bearing channel gets", () => {
    expect(channelTabs(PLATFORMS.reddit_organic)).toEqual([
      ["overview", "Overview"],
      ["settings", "Settings"],
    ]);
  });

  it("gives AI UGC Videos an Overview that makes videos and a Library of them, with no Ideas or Settings tab", () => {
    expect(channelTabs(PLATFORMS.generated_video)).toEqual([
      ["studio", "Overview"],
      ["library", "Library"],
    ]);
    expect(channelTabs(PLATFORMS.generated_video, true).map(([k]) => k)).toEqual(["studio", "library"]);
    const others = Object.entries(PLATFORMS).filter(([, p]) => p.studio).map(([slug]) => slug);
    expect(others).toEqual(["generated_video"]);
  });

  it("names no tab after the surface it replaced", () => {
    const labels = channelTabs(PLATFORMS.reddit_organic).map(([, text]) => text);
    for (const label of labels) {
      expect(label).not.toMatch(/strategy|comment|post|opportunit/i);
    }
  });

  it("the tab file mounts no channel's component", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/workspace/layout/ChannelTabs.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+"\.\.\/agent\//);
    expect(src).not.toMatch(/StrategyTab/);
  });
});

describe("a list row's status is the switch the run reads", () => {
  it("pauses a tracked row, and saves the status", async () => {
    await mountReddit({ communities: [{ id: "c1", item: "cars", status: "tracking" }] });

    const pill = screen.getByRole("button", { name: "Pause cars" });
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pill);
    await flush();

    expect(screen.getByRole("button", { name: "Resume cars" }).getAttribute("aria-pressed")).toBe(
      "false",
    );

    await save();
    const put = puts().find((p) => p.path.endsWith("/settings/communities"));
    expect(put?.items).toEqual([expect.objectContaining({ item: "cars", status: "paused" })]);
  });

  it("resumes a paused row, which was reachable only by deleting it before", async () => {
    await mountReddit({ communities: [{ id: "c1", item: "cars", status: "paused" }] });

    fireEvent.click(screen.getByRole("button", { name: "Resume cars" }));
    await flush();
    await save();

    const put = puts().find((p) => p.path.endsWith("/settings/communities"));
    expect(put?.items).toEqual([expect.objectContaining({ item: "cars", status: "tracking" })]);
  });

  it("a paused row survives the save alongside the rows that stayed on", async () => {
    await mountReddit({
      communities: [
        { id: "c1", item: "cars", status: "tracking" },
        { id: "c2", item: "carbuying", status: "tracking" },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Pause cars" }));
    await flush();
    await save();

    const put = puts().find((p) => p.path.endsWith("/settings/communities"));
    expect(put?.items.map((i) => [i.item, i.status])).toEqual([
      ["cars", "paused"],
      ["carbuying", "tracking"],
    ]);
  });

  it("leaves a suggested row's own verbs alone", async () => {
    await mountReddit({
      communities: [{ id: "c1", item: "cars", status: "suggested", origin: "suggested" }],
    });

    expect(screen.queryByRole("button", { name: /^(Pause|Resume) cars$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Track it" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("a read-only field does not offer it", async () => {
    apiFetch.mockImplementation(() =>
      respond(true, { fields: { budget: [{ id: "b1", item: "cars", status: "tracking" }] } }),
    );
    render(
      <ChannelSettingsTab
        slug="reddit_organic"
        fields={[
          {
            kind: "list",
            id: "budget",
            label: "Monthly budget",
            writesTo: "channel.monthly_budget",
          },
        ]}
      />,
    );
    await flush();

    expect(screen.queryByRole("button", { name: /^(Pause|Resume) cars$/ })).toBeNull();
    expect(screen.getByText("tracking")).toBeTruthy();
  });
});
