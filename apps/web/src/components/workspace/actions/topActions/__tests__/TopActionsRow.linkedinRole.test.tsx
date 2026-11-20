import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: api.fetch }));
const who = vi.hoisted(() => ({ role: "owner" as string }));
vi.mock("../../../WorkspaceShell", async (orig) => ({
  ...(await orig<typeof import("../../../WorkspaceShell")>()),
  useWorkspaceOptional: () => ({ role: who.role, tabs: [], activeTabId: null }),
}));

import { TopActionsRow } from "../TopActionsRow";
import { linkedin_ads } from "../../platforms/linkedin_ads";
import { meta_ads } from "../../platforms/meta_ads";

const RAW = "This action requires one of: owner, admin. Your role: member.";
const NOTE = "Only workspace owners and admins can prepare LinkedIn campaigns.";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.fetch.mockReset();
  who.role = "owner";
});
afterEach(() => cleanup());

describe("LinkedIn Ads Boost a Page post and the workspace role", () => {
  it("a member sees the owners-and-admins note and no button that would fail", () => {
    who.role = "member";
    render(<TopActionsRow slug="linkedin_ads" channelName="LinkedIn Ads" actions={linkedin_ads.topActions} onChanged={() => {}} />);
    expect(screen.queryByTestId("top-action-boost_post")).toBeNull();
    expect(screen.getByTestId("top-actions-owners-only").textContent).toBe(NOTE);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("a member keeps Meta's Boost a Page post; Create campaign (owners and admins only) becomes the note", () => {
    who.role = "member";
    render(<TopActionsRow slug="meta_ads" channelName="Meta Ads" actions={meta_ads.topActions} onChanged={() => {}} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Boost a Page post"]);
    expect(screen.getByTestId("top-actions-owners-only").textContent).toBe("Only workspace owners and admins can create or edit Meta campaigns in Zavi.");
  });

  it("when the server refuses the role, the form says it in plain words, never the server text", async () => {
    api.fetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { code: "forbidden", message: RAW } }) });
    render(<TopActionsRow slug="linkedin_ads" channelName="LinkedIn Ads" actions={linkedin_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByTestId("top-action-boost_post"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Prepare the campaign" }));
    });
    const dialog = screen.getByRole("dialog");
    expect(api.fetch.mock.calls.map(([u]) => u)).toEqual(["/api/channels/linkedin_ads/campaign-drafts"]);
    expect(dialog.textContent).toContain(NOTE);
    expect(dialog.textContent).not.toContain("requires one of");
    expect(dialog.textContent).not.toContain("Your role");
  });
});
