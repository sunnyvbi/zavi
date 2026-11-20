// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api";
import { WorkspaceMembersPanel } from "./WorkspaceMembersPanel";
import { TeamRosterCard } from "./TeamRosterCard";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);

afterEach(cleanup);

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe("Team settings appearance", () => {
  it("uses the workspace theme and motion language for members and invites", async () => {
    mockedApiFetch.mockImplementation(async (path) => {
      if (path === "/api/v1/members") {
        return new Response(
          JSON.stringify({
            members: [
              {
                user_id: "user-1",
                email: "owner@zavi.test",
                role: "owner",
                joined_at: "2026-09-28T00:00:00.000Z",
              },
            ],
          }),
        );
      }
      return new Response(
        JSON.stringify({
          invites: [
            {
              id: "invite-1",
              email: "new@zavi.test",
              role: "member",
              invited_at: "2026-09-28T00:00:00.000Z",
            },
          ],
        }),
      );
    });

    render(
      <WorkspaceMembersPanel
        role="owner"
        currentUserId="user-1"
        embedded
        title="Members"
        subtitle="Invite members as an admin, member or viewer."
      />,
    );

    const surface = await screen.findByTestId("team-members-surface");
    expect(surface.className).toContain("bg-cream");
    expect(surface.className).toContain("team-surface-enter");
    expect(surface.className).not.toContain("bg-white");

    const invite = screen.getByRole("button", { name: "Invite a member" });
    expect(invite.className).toContain("team-primary-action");
    expect(invite.className).toContain("transition-");

    expect(screen.getByTestId("members-table").className).toContain("bg-bone");
    expect(screen.getByTestId("open-invites-table").className).toContain(
      "bg-bone",
    );
  });

  it("gives discovery filters and empty state clear transitions", async () => {
    mockedApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ members: [] })),
    );

    render(<TeamRosterCard />);

    await waitFor(() => {
      expect(screen.getByText(/No team discovered yet/)).toBeTruthy();
    });

    expect(screen.getByTestId("team-discovery-surface").className).toContain(
      "team-surface-enter",
    );
    expect(screen.getByRole("tablist").className).toContain("bg-bone");
    expect(screen.getByRole("tab", { name: /All/ }).className).toContain(
      "transition-",
    );
    expect(
      screen.getByRole("button", { name: /Discover team/ }).className,
    ).toContain("team-secondary-action");
  });
});
