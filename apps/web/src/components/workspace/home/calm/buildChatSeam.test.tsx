// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type * as React from "react";

import { HomeChatPanel } from "./HomeChatPanel";
import { WebsitePreview } from "../../website/WebsitePreview";

vi.mock("@/lib/api", () => ({
  apiFetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
}));
vi.mock("../../ThreadBar", () => ({
  ThreadBar: () => <div data-testid="thread-strip">pills</div>,
}));
vi.mock("../../ChatExpandButton", () => ({
  ChatExpandButton: () => <button type="button" aria-label="Expand chat" />,
  HEADER_CARD_SHADOW: "",
}));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspace: () => ({ userEmail: "founder@example.com", openTab: () => "t", role: "owner" }),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: (_slug: string, threadId: string | null | undefined) => {
    boundThreads.push(threadId);
    return { rows: [], loading: false, errorMsg: null, reload: () => {} };
  },
}));

const boundThreads: (string | null | undefined)[] = [];
vi.mock("../../Composer", () => ({ Composer: () => <textarea /> }));
vi.mock("../../ChatThread", () => ({ ChatThread: () => <div /> }));

afterEach(cleanup);

const websiteTabSource = readFileSync(
  join(__dirname, "..", "..", "WebsiteTab.tsx"),
  "utf8",
);

const separatorProps = {
  role: "separator",
  "aria-orientation": "vertical",
  "aria-label": "Resize the chat panel",
  onMouseDown: () => {},
} as unknown as React.ComponentProps<typeof HomeChatPanel>["separatorProps"];

const base = {
  greeting: "Good afternoon, Ravi.",
  pulse: <span>pulse</span>,
  suggestions: [] as string[],
  expanded: false,
  onExpandedChange: () => {},
  width: 430,
  dragging: false,
  separatorProps,
};

function buildPanel(overrides: Partial<React.ComponentProps<typeof HomeChatPanel>> = {}) {
  return render(
    <HomeChatPanel
      {...base}
      side="left"
      surface="card"
      showThreadBar={false}
      showExpand={false}
      title={<span>Hush</span>}
      {...overrides}
    />,
  );
}

function titleRow(): HTMLElement {
  const row = screen.getByText("Hush").parentElement;
  if (!row) throw new Error("the title is not in a row");
  return row;
}

function previewChrome(container: HTMLElement): HTMLElement {
  const bar = container.querySelector("[data-testid='preview-chrome']");
  if (!bar) throw new Error("no preview chrome rendered");
  return bar as HTMLElement;
}

function heightClass(el: Element): string {
  const h = el.className.split(/\s+/).filter((c) => /^h-\d/.test(c));
  if (h.length !== 1) throw new Error(`expected one height class, got ${h.join(",")}`);
  return h[0];
}

describe("the Build chat's top title", () => {
  it("uses one quiet bordered surface instead of a raised grey card", () => {
    const panel = buildPanel();
    const aside = panel.container.querySelector("aside") as HTMLElement;
    expect(aside.className).toContain("border");
    expect(aside.className).toContain("bg-white");
    expect(aside.className).toContain("shadow-sm");
    expect(aside.className).not.toContain("bg-[#f9f9f9]");
    expect(aside.className).not.toContain("shadow-elev");
  });
  it("draws a rule that is not the colour of the card it sits on", () => {
    buildPanel();
    const row = titleRow();
    expect(row.className).toContain("border-b");
    expect(row.className).not.toContain("border-[#f0f0f0]");
    expect(row.className).toMatch(/border-ink\/\d+/);
  });

  it("keeps the title and conversation on one white surface", () => {
    const panel = buildPanel();
    const aside = panel.container.querySelector("aside") as HTMLElement;
    expect(titleRow().className).toContain("bg-white");
    expect(aside.className).toContain("bg-white");
    expect(aside.className).not.toContain("bg-[#f0f0f0]");
  });

  it("sits on the same line as the preview's own bar — same height, both flush", () => {
    const panel = buildPanel();
    const aside = panel.container.querySelector("aside") as HTMLElement;
    const rowHeight = heightClass(titleRow());
    const asideClass = aside.className;
    cleanup();

    const preview = render(
      <WebsitePreview
        liveUrl="https://hush.zaviagent.com"
        cacheKey={null}
        appId="hush.zaviagent.com"
      />,
    );
    expect(rowHeight).toBe(heightClass(previewChrome(preview.container)));

    expect(asideClass).toContain("inset-y-0");
    expect(asideClass).toContain("left-0");
    expect(websiteTabSource).toContain(
      'overflow-hidden ${isBuild ? "" : "p-4"}',
    );
  });

  it("does not hang its inset off the right edge when it goes full width", () => {
    const panel = buildPanel({ fullWidthBelowLg: true });
    const aside = panel.container.querySelector("aside") as HTMLElement;
    expect(aside.className).toContain("w-full");
    expect(aside.className).toContain("max-lg:inset-x-0");
    expect(aside.className).toContain("max-lg:w-auto");
  });
});

describe("which conversation the Build chat holds", () => {
  it("follows the thread its host binds, so a History pick lands here", () => {
    boundThreads.length = 0;
    const panel = render(
      <HomeChatPanel
        {...base}
        side="left"
        surface="card"
        showThreadBar={false}
        showExpand={false}
        title={<span>Hush</span>}
        initialThreadId="thread-one"
      />,
    );
    expect(boundThreads.at(-1)).toBe("thread-one");
    panel.rerender(
      <HomeChatPanel
        {...base}
        side="left"
        surface="card"
        showThreadBar={false}
        showExpand={false}
        title={<span>Hush</span>}
        initialThreadId="thread-two"
      />,
    );
    expect(boundThreads.at(-1)).toBe("thread-two");
  });

  it("reports every binding back to its host", async () => {
    const seen: (string | null)[] = [];
    render(
      <HomeChatPanel
        {...base}
        side="left"
        surface="card"
        showThreadBar={false}
        showExpand={false}
        title={<span>Hush</span>}
        initialThreadId="thread-one"
        onThreadChange={(id) => seen.push(id)}
      />,
    );
    expect(seen).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["thread-one"]);
  });
});

describe("the Build chat on a phone", () => {
  const narrow = {
    fullWidthBelowLg: true,
    narrowLeading: (
      <button type="button" aria-label="View app">
        app
      </button>
    ),
  } as Partial<React.ComponentProps<typeof HomeChatPanel>>;

  it("puts the pane toggle AFTER the name, never before it", () => {
    const panel = buildPanel({
      ...narrow,
      narrowTrailing: (
        <button type="button" aria-label="Show the app">
          app
        </button>
      ),
    });
    const aside = panel.container.querySelector("aside") as HTMLElement;
    const row = Array.from(aside.children).find((c) =>
      c.className.includes("border-b"),
    ) as HTMLElement;
    const name = screen.getByText("Hush");
    const toggle = screen.getByLabelText("Show the app");
    expect(row.contains(toggle)).toBe(true);
    expect(
      name.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect((toggle.parentElement as HTMLElement).className).toContain("ml-auto");
  });

  it("keeps ONE header row — the narrow controls ride with the title", () => {
    const panel = buildPanel(narrow);
    const aside = panel.container.querySelector("aside") as HTMLElement;
    const rows = Array.from(aside.children).filter((c) =>
      c.className.includes("border-b"),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].contains(screen.getByLabelText("View app"))).toBe(true);
    expect(rows[0].contains(screen.getByText("Hush"))).toBe(true);
    expect(heightClass(rows[0])).toBe("h-12");
  });

  it("goes full bleed — no floating card corners against the screen edge", () => {
    const panel = buildPanel(narrow);
    const aside = panel.container.querySelector("aside") as HTMLElement;
    expect(aside.className).toContain("compact:rounded-none");
    expect(aside.className).not.toMatch(/(?:^|\s)border(?:\s|`|$)/);
    expect(aside.className).toContain("compact:shadow-none");
    expect(aside.className).toContain("rounded-2xl");
  });

  it("still shows the title row on its own when there are no narrow controls", () => {
    buildPanel();
    expect(screen.queryByLabelText("View app")).toBeNull();
    expect(titleRow().contains(screen.getByText("Hush"))).toBe(true);
  });
});

describe("the drag seam between the chat and the preview", () => {
  it("is visible before anyone hovers it, and is not a 6px target", () => {
    buildPanel();
    const seam = screen.getByRole("separator");
    expect(seam.className).toContain("w-3");
    expect(seam.className).not.toContain("w-[6px]");

    const paint = Array.from(seam.children).map((c) => c.className);
    expect(paint.length).toBeGreaterThanOrEqual(2);
    expect(paint.join(" ")).not.toContain("bg-transparent");
    expect(paint.some((c) => /bg-ink\/\d+/.test(c) && c.includes("rounded-full"))).toBe(true);
    expect(paint.every((c) => /bg-ink\/\d+/.test(c))).toBe(true);
  });

  it("answers hover AND keyboard focus, not just the mouse", () => {
    buildPanel();
    const paint = Array.from(screen.getByRole("separator").children).map((c) => c.className);
    for (const cls of paint) {
      expect(cls).toContain("group-hover:bg-[#c9a24b]");
      expect(cls).toContain("group-focus-visible:bg-[#c9a24b]");
    }
  });

  it("stays gold through a drag, when the pointer has left the 12px strip", () => {
    buildPanel({ dragging: true });
    const paint = Array.from(screen.getByRole("separator").children).map((c) => c.className);
    for (const cls of paint) {
      expect(cls).toMatch(/(?:^|\s)bg-\[#c9a24b\]/);
      expect(cls).not.toMatch(/(?:^|\s)bg-ink\/\d+/);
    }
  });

  it("keeps the seam out of the way when the chat is expanded over the preview", () => {
    buildPanel({ expanded: true });
    expect(screen.queryByRole("separator")).toBeNull();
  });
});
