// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));

import { RecentBuilds } from "./BuildModePane";
import type { BuildSessionMeta } from "@/lib/workspace/buildHistory";

function row(
  id: string,
  site: BuildSessionMeta["site"],
  extra: Partial<BuildSessionMeta> = {},
): BuildSessionMeta {
  return {
    id,
    title: id === "bike" ? "Bike Rental" : `Site ${id}`,
    request: "",
    state: "ready",
    run_status: "done",
    created_at: "2026-10-05T10:00:00Z",
    last_activity_at: "2026-10-05T11:00:00Z",
    refine_count: 2,
    is_current: false,
    site,
    ...extra,
  } as BuildSessionMeta;
}

const LIVE_URL = "https://bike-rental-dev.zaviagent.com";

const sessions = [
  row("bike", {
    hostname: "bike-rental-dev.zaviagent.com",
    live_url: LIVE_URL,
    status: "live",
  }),
  row("draft", {
    hostname: "draft-dev.zaviagent.com",
    live_url: null,
    status: "ready",
  }),
  row("paused", {
    hostname: "paused-dev.zaviagent.com",
    live_url: "https://paused-dev.zaviagent.com",
    status: "paused",
  }),
  row("broken", {
    hostname: "broken-dev.zaviagent.com",
    live_url: "https://broken-dev.zaviagent.com",
    status: "failed",
  }),
];

function mount() {
  const onOpen = vi.fn();
  const listHeard = vi.fn();
  render(
    <div onClick={listHeard}>
      <RecentBuilds
        label="Your sites"
        sessions={sessions}
        currentSessionId={null}
        onOpen={onOpen}
        limit={50}
        siteNames
      />
    </div>,
  );
  const items = within(
    screen.getByRole("region", { name: "Your sites" }),
  ).getAllByRole("listitem");
  return { onOpen, items, listHeard };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Your sites: open-live-site link sits inside the row beside the address", () => {
  it("renders the live row as one row whose open link sits right after the address", () => {
    const { items } = mount();
    const live = items[0];
    const link = within(live).getByRole("link");
    expect(live.querySelectorAll("a")).toHaveLength(1);
    expect(link.previousElementSibling?.textContent).toBe(
      "bike-rental-dev.zaviagent.com",
    );
    expect(live.className).toContain("hover:bg-creamDeep/60");
    const chevron = live.querySelector("[data-testid=site-row-chevron]")!;
    expect(chevron.getAttribute("class")).toMatch(/(^|\s)text-inkMuted(\s|$)/);
    expect(chevron.getAttribute("class")).toContain("group-hover/site:text-ink");
    expect(screen.getByRole("heading", { name: "Your sites" }).className).toContain("text-[14px]");
    const button = within(live).getByRole("button");
    expect(button.contains(link)).toBe(false);
    expect(link.contains(button)).toBe(false);
    const badge = live.querySelector("[data-site-badge]")!;
    expect(badge.textContent).toBe("Live");
    expect(badge.previousElementSibling).toBe(button);
    expect(button.parentElement?.nextElementSibling?.contains(link)).toBe(true);
    const shown = live.cloneNode(true) as HTMLElement;
    shown.querySelectorAll(".sr-only").forEach((n) => n.remove());
    expect(shown.textContent).toBe("Bike RentalLivebike-rental-dev.zaviagent.comToday".replace("Today", shown.querySelector("time")!.textContent!));
    for (const child of Array.from(live.querySelectorAll("*"))) {
      expect(child.className.toString()).not.toContain("hover:bg-creamDeep");
    }
    expect(link.getAttribute("aria-label")).toBe(
      "Open Bike Rental in a new tab",
    );
  });

  it("opens the live URL in a new tab and never opens the row", async () => {
    const { onOpen, items, listHeard } = mount();
    const link = within(items[0]).getByRole("link");
    expect(link.getAttribute("href")).toBe(LIVE_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")?.split(" ")).toContain("noopener");
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(true);
    expect(listHeard).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(within(items[0]).getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith("bike");
  });

  it("shows no open link on rows that are not live, even when a stale live_url is still stored", () => {
    const { items } = mount();
    for (const item of items.slice(1)) {
      expect(within(item).queryByRole("link")).toBeNull();
    }
    expect(items[2].querySelector("[data-site-badge]")?.textContent).toBe(
      "Paused",
    );
    expect(items[3].querySelector("[data-site-badge]")?.textContent).toBe(
      "Failed",
    );
  });

  it("ends every row with the same time then arrow cells, live or not", () => {
    const { items } = mount();
    const shapes = items.map((item) => {
      const kids = Array.from(item.children);
      return kids.map((kid) => kid.tagName.toLowerCase());
    });
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
    for (const item of items) {
      const last = item.lastElementChild!;
      expect(last.tagName.toLowerCase()).toBe("svg");
      expect(last.previousElementSibling?.tagName.toLowerCase()).toBe("time");
    }
  });

  it("tabs to the row and then to its open link as two separate stops", async () => {
    const user = userEvent.setup();
    const { items } = mount();
    const button = within(items[0]).getByRole("button");
    const link = within(items[0]).getByRole("link");
    await user.tab();
    expect(document.activeElement).toBe(button);
    await user.tab();
    expect(document.activeElement).toBe(link);
    await user.tab();
    expect(document.activeElement).toBe(within(items[1]).getByRole("button"));
    expect(link.className).toContain("focus-visible:ring-2");
    expect(button.className).toContain("focus-visible:after:ring-2");
  });
});
