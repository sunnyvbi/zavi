// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

const openTab = vi.fn();
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    approvalsPending: 0,
    openAgentTab: vi.fn(),
    openTab,
  }),
}));

const STEP_ONE_TITLE = "Replace the /terms/conditions title and add an H1 to the homepage";

const action = (
  position: number,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  id: `d-${position}`,
  decision_class: "channel.recipe_step",
  channel_slug: "seo",
  handler: null,
  emitted_at: "2026-09-14T10:00:00.000Z",
  run_group: { run_id: "run-1", position, of: 3 },
  body: {
    step: { title, body: "" },
    position,
    of: 3,
    ...extra,
  },
});

const FINDINGS = [
  {
    metric_id: "page_claims",
    status: "failing",
    value: "0 H1 tags on the homepage",
    numeric_value: 0,
    target: 1,
    unit: "tags",
  },
  {
    metric_id: "ai_crawler_access",
    status: "measured",
    value: "passing. Single User-agent: * with Allow: /",
  },
];

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith("/api/approvals"))
      return {
        ok: true,
        json: async () => ({
          decisions: [
            action(1, STEP_ONE_TITLE, { findings: FINDINGS }),
            action(2, "Publish an llms.txt file"),
            action(3, "Cut server response time"),
          ],
        }),
      };
    if (path.startsWith("/api/channels"))
      return {
        ok: true,
        json: async () => ({
          channels: [
            {
              channel_slug: "seo",
              delivery_mode: "produce",
              work_state: "needs_review",
              priority: 1,
              last_run_at: "2026-09-14T09:00:00.000Z",
              connected: false,
              connectors: ["google_search_console"],
              runnable: true,
            },
          ],
        }),
      };
    return { ok: false, json: async () => ({}) };
  }),
}));

vi.mock("@/lib/approvals/approveDecision", () => ({
  approveDecision: vi.fn(async () => ({ ok: true })),
}));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

beforeEach(clearChannelBoardCache);

afterEach(cleanup);

async function renderPanel() {
  const view = render(
    <ChannelsPanel collapsed={false} width={380} onToggle={() => {}} />,
  );
  await screen.findByText(new RegExp(STEP_ONE_TITLE.slice(0, 30)));
  fireEvent.click(screen.getByRole("button", { expanded: false, name: /SEO/ }));
  return view;
}

function runRow(): HTMLElement {
  const title = screen.getByText(new RegExp(STEP_ONE_TITLE.slice(0, 30)));
  const li = title.closest("li.rounded-2xl");
  expect(li).toBeTruthy();
  return li as HTMLElement;
}

describe("ChannelsPanel — a run's title is printed ONCE", () => {
  it("does not repeat step 1's title in the row header", async () => {
    await renderPanel();
    const matches = screen.getAllByText(
      (_, el) => el?.textContent?.trim() === STEP_ONE_TITLE,
    );
    const leaves = matches.filter(
      (el) => !matches.some((other) => other !== el && el.contains(other)),
    );
    expect(leaves).toHaveLength(1);
  });

  it("the one place it appears is the numbered list, next to its number", async () => {
    await renderPanel();
    const row = runRow();
    const list = row.querySelector("ol");
    expect(list).toBeTruthy();
    expect(within(list as HTMLElement).getByText(STEP_ONE_TITLE)).toBeTruthy();
    expect(within(list as HTMLElement).getByText("1.")).toBeTruthy();
  });

  it("the header still says which channel and how much is left", async () => {
    await renderPanel();
    const row = runRow();
    expect(row.textContent).toContain("3 of 3 left");
    const header = within(row).getAllByRole("button")[0];
    expect(header.textContent).toContain("3 of 3 left");
    expect(header.textContent).not.toContain(STEP_ONE_TITLE);
  });
});

describe("ChannelsPanel — findings carry their numbers", () => {
  it("draws value against target when the agent measured both", async () => {
    await renderPanel();
    const row = runRow();
    expect(within(row).getByText("0 tags")).toBeTruthy();
    expect(within(row).getByText("target 1 tags")).toBeTruthy();
  });

  it("A FINDING WITH NO NUMBERS RENDERS EXACTLY AS BEFORE", async () => {
    await renderPanel();
    const row = runRow();
    expect(within(row).getByText(/Single User-agent/)).toBeTruthy();
    const prose = within(row).getByText(/Single User-agent/);
    const item = prose.closest("li") as HTMLElement;
    expect(item.textContent).not.toContain("target");
    expect(item.querySelector("[class*='w-14']")).toBeNull();
  });

  it("states the finding status in words, never by colour alone", async () => {
    await renderPanel();
    const row = runRow();
    expect(within(row).getByText(", needs work")).toBeTruthy();
    expect(within(row).getByText(", looks fine")).toBeTruthy();
  });
});
