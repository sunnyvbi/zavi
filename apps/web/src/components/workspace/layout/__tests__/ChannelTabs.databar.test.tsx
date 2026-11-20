// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CHANNELS, WRITES_ELSEWHERE_FIELD_IDS, writesElsewhere, type Channel } from "@zavi/shared";
import { ChannelPanel } from "../ChannelPanel";
import { PLATFORMS } from "../../actions/platforms";
import { channelCanPaste } from "../ChannelSnapshotPaste";
import type { ChannelDetail } from "../channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () =>
        String(path).includes("/settings")
          ? { fields: {} }
          : {
              actions: [],
              more: 0,
              store: "channel_actions",
              metrics: [],
              briefs: [],
              artifacts: [],
            },
    }),
  );
});

const channel = (slug: string) =>
  (CHANNELS as readonly Channel[]).find((c) => c.slug === slug)!;

function slugWithNothingOnSettings(): string {
  const found = (CHANNELS as readonly Channel[]).find((c) => {
    const p = PLATFORMS[c.slug];
    return (
      !!p &&
      !p.settings?.length &&
      !p.extras?.length &&
      !p.kpiFallback &&
      !channelCanPaste(c.slug, false) &&
      !c.human?.available
    );
  });
  if (!found) throw new Error(
    "No channel row declares nothing any more, so the no-bar case has no subject. " +
      "This guard measured `tabs.length === 1` -> zero tabs; give it a fixture row " +
      "instead of a real slug, or retire it and say why in the PR.",
  );
  return found.slug;
}

function detailFor(slug: string, over: Partial<ChannelDetail> = {}): ChannelDetail {
  return {
    channel: channel(slug),
    mode: "produce",
    connected: true,
    connectors: ["x"],
    workState: "delivered",
    lastRunAt: new Date().toISOString(),
    lastProbeAt: null,
    lastProbeDelta: null,
    runnable: true,
    ...over,
  };
}

const mount = (slug: string, over: Partial<ChannelDetail> = {}) =>
  render(
    <ChannelPanel
      detail={detailFor(slug, over)}
      actionCount={0}
      onOpenConnectors={() => {}}
    />,
  );

describe("the tab bar is built from the channel's row", () => {
  it("renders NO tab at all for a channel with nothing on Settings", async () => {
    mount(slugWithNothingOnSettings(), { connected: false, connectors: [], runnable: false });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("gives a channel with only a schedule a Settings tab", async () => {
    mount("youtube_ads");
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Overview", "Analytics", "Settings"]);
  });

  it("renders Overview, Analytics and Settings for a channel that declares settings and numbers", async () => {
    mount("google_ads");
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Overview", "Analytics", "Settings"]);
  });
});

describe("the header row holds only what the channel actually has", () => {
  it("offers refresh for the YouTube campaign reader without inventing an account", async () => {
    mount("youtube_ads");
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const row = screen.getByTestId("channel-header");
    expect(within(row).getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Overview",
      "Analytics",
      "Settings",
    ]);
    expect(within(row).queryByTestId("account-strip")).toBeNull();
    expect(within(row).queryByRole("button", { name: /Refresh/ })).toBeNull();
    fireEvent.click(within(row).getByRole("tab", { name: "Analytics" }));
    expect(await within(row).findByRole("button", { name: /Refresh/ })).toBeTruthy();
    expect(screen.queryByTestId("account-strip")).toBeNull();
  });

  it("holds nothing at all on a channel with neither tabs nor a dashboard", async () => {
    mount(slugWithNothingOnSettings(), { connected: false, connectors: [], runnable: false });
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const row = screen.getByTestId("channel-header");
    expect(row.textContent).toBe("");
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("every writesTo field is one the server also refuses", () => {
  const declared = Object.entries(PLATFORMS).flatMap(([slug, spec]) =>
    (spec.settings ?? []).map((f) => ({ slug, id: f.id, writesTo: f.writesTo })),
  );

  it("declares writesTo only for ids on the shared list", () => {
    const rogue = declared.filter((f) => f.writesTo && !writesElsewhere(f.id));
    expect(
      rogue.map((f) => `${f.slug}.${f.id} -> ${f.writesTo}`),
      "This field would write a SHADOW COPY: the server accepts the id and nothing reads the row. Add the id to WRITES_ELSEWHERE_FIELD_IDS in @zavi/shared.",
    ).toEqual([]);
  });

  it("declares writesTo for every field whose id the server refuses", () => {
    const silent = declared.filter((f) => writesElsewhere(f.id) && !f.writesTo);
    expect(
      silent.map((f) => `${f.slug}.${f.id}`),
      "The server 409s this id, so a save from the Settings tab fails. Declare writesTo on the row, or drop the field.",
    ).toEqual([]);
  });

  it("is not blind: budget declares writesTo, and cadence and autonomy are not fields", () => {
    expect(WRITES_ELSEWHERE_FIELD_IDS).toContain("budget");
    expect(declared.some((f) => f.id === "budget" && f.writesTo)).toBe(true);

    expect(declared.some((f) => f.id === "cadence")).toBe(false);
    expect(declared.some((f) => f.id === "autonomy")).toBe(false);
  });
});

describe("a Suggest button has a list for everything its endpoint writes", () => {
  const reddit = PLATFORMS.reddit_organic.settings ?? [];
  const suggestOf = (id: string) => {
    const field = reddit.find((f) => f.id === id);
    return field && "suggest" in field ? field.suggest : undefined;
  };

  it("declares a list for each table the suggest call writes", () => {
    expect(reddit.map((f) => f.id)).toEqual(
      expect.arrayContaining(["keywords", "competitors"]),
    );
  });

  it("puts the producer endpoint on both of them", () => {
    expect(suggestOf("keywords")).toBe("/api/reddit/workspace/suggest");
    expect(suggestOf("competitors")).toBe("/api/reddit/workspace/suggest");
  });

  it("gives competitors NO item types, because the table has no type column", () => {
    const competitors = reddit.find((f) => f.id === "competitors");
    expect(
      competitors && "itemTypes" in competitors ? competitors.itemTypes : undefined,
    ).toBeUndefined();
  });
});
