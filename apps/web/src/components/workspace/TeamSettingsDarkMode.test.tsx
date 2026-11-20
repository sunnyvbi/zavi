// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api";
import { WorkspaceMembersPanel } from "./WorkspaceMembersPanel";
import { TeamRosterCard } from "./TeamRosterCard";
import { InviteMemberModal } from "@/components/InviteMemberModal";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

const RAIL_BORDER = 1;
const PILL_W = 72;
const PILL_LEFT: Record<string, number> = { "All 0": 5, "Needs review 0": 81, "People 0": 157, "Bot 0": 233 };

function stubLayout() {
  for (const [prop, get] of [
    [
      "offsetWidth",
      function (this: HTMLElement) {
        return this.tagName === "BUTTON" ? PILL_W : 320;
      },
    ],
    [
      "offsetLeft",
      function (this: HTMLElement) {
        return this.tagName === "BUTTON" ? (PILL_LEFT[this.textContent ?? ""] ?? 0) : 0;
      },
    ],
    [
      "clientLeft",
      function (this: HTMLElement) {
        return this.tagName === "BUTTON" ? 0 : RAIL_BORDER;
      },
    ],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get });
  }
}

function membersApi(members: Array<{ user_id: string; email: string; role: string }>) {
  mockedApiFetch.mockImplementation(async (path) => {
    if (path === "/api/v1/members") {
      return new Response(
        JSON.stringify({
          members: members.map((m) => ({ ...m, joined_at: "2026-09-28T00:00:00.000Z" })),
        }),
      );
    }
    return new Response(JSON.stringify({ invites: [] }));
  });
}

function renderInShell(ui: React.ReactElement<any>) {
  const shell = document.createElement("div");
  shell.className = "workspace-shell";
  document.body.appendChild(shell);
  const result = render(ui, { container: shell });
  return { ...result, shell };
}

afterEach(() => {
  cleanup();
  document.querySelectorAll(".workspace-shell").forEach((n) => n.remove());
  for (const prop of ["offsetWidth", "offsetLeft", "clientLeft"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  }
});

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe("Team settings surfaces stay inside the workspace shell so dark mode reaches them", () => {
  it("mounts the invite dialog under .workspace-shell when one exists", () => {
    const { shell } = renderInShell(<InviteMemberModal open onClose={() => {}} onInvited={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Invite a teammate" });
    expect(dialog.parentElement).toBe(shell);
    expect(dialog.parentElement).not.toBe(document.body);
  });

  it("falls back to document.body outside the workspace", () => {
    render(<InviteMemberModal open onClose={() => {}} onInvited={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Invite a teammate" }).parentElement).toBe(document.body);
  });

  it("opens a member's row menu under .workspace-shell", async () => {
    membersApi([
      { user_id: "user-1", email: "owner@zavi.test", role: "owner" },
      { user_id: "user-2", email: "admin@zavi.test", role: "admin" },
    ]);
    const { shell } = renderInShell(
      <WorkspaceMembersPanel role="owner" currentUserId="user-1" embedded title="Team" subtitle="" />,
    );
    const trigger = await screen.findByRole("button", { name: "Member actions" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(menu.parentElement).toBe(shell);
    expect(screen.getByRole("menuitem", { name: "Make member" })).toBeTruthy();
  });

  it("shows no dead kebab on a row that has no actions", async () => {
    membersApi([{ user_id: "user-1", email: "owner@zavi.test", role: "owner" }]);
    renderInShell(
      <WorkspaceMembersPanel role="owner" currentUserId="user-1" embedded title="Team" subtitle="" />,
    );
    await screen.findByTestId("members-table");
    expect(screen.queryByRole("button", { name: "Member actions" })).toBeNull();
    expect(screen.getByText("No actions")).toBeTruthy();
  });
});

describe("Observed team filter tabs slide one pill instead of repainting the active tab", () => {
  beforeEach(() => {
    stubLayout();
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify({ members: [] })));
  });

  function pillOf(container: HTMLElement) {
    return container.querySelector<HTMLElement>('[data-testid="team-filter-pill"]');
  }

  it("parks the pill on the active tab and moves the SAME element on select", async () => {
    const { container } = render(<TeamRosterCard />);
    await screen.findByRole("tablist", { name: "Observed team filters" });
    await waitFor(() => expect(pillOf(container)).not.toBeNull());
    const pill = pillOf(container)!;
    expect(pill.style.transform).toBe(`translateX(${PILL_LEFT["All 0"] - RAIL_BORDER}px)`);
    expect(pill.style.width).toBe(`${PILL_W}px`);
    expect(pill.className).toContain("transition-[transform,width]");
    expect(pill.className).toContain("motion-reduce:transition-none");
    expect(pill.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "People 0" }));
    await waitFor(() =>
      expect(pillOf(container)!.style.transform).toBe(`translateX(${PILL_LEFT["People 0"] - RAIL_BORDER}px)`),
    );
    expect(pillOf(container)).toBe(pill);
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).not.toContain("bg-cream ");
    }
    expect(screen.getByRole("tab", { name: "People 0" }).getAttribute("aria-selected")).toBe("true");
  });
});
