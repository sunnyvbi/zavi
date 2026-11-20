// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  approveDecision: vi.fn(),
  follow: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: mocks.approveDecision }));
vi.mock("@/components/workspace/actions/topActions/postToast", () => ({ followPostInToast: mocks.follow }));
vi.mock("@/components/workspace/WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ tenantId: "tenant-1" }),
}));

import { ApprovalsIsland } from "./ApprovalsIsland";

const PIN = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  agent_run_id: null,
  decision_class: "social.publish.v2",
  body: {
    channel: "pinterest_pin",
    payload: {
      title: "Cake",
      text: "Made to order.",
      board_id: "1",
      board_name: "Ideas",
      image_path: "tenant-1/aaaaaaaa-0000-4000-8000-000000000002.jpg",
      link: "https://example.com/cake",
    },
    scheduled_at: null,
  },
  status: "proposed",
  autonomy_at_emit: "approval",
  handler: "social.publish.v2",
  emitted_at: "2026-10-16T07:09:07.000Z",
  channel_slug: "pinterest_organic",
};

const response = (body: unknown, ok = true, status = ok ? 200 : 500) => ({
  ok,
  status,
  json: async () => body,
  clone() {
    return this;
  },
});

beforeEach(() => {
  window.localStorage.clear();
  mocks.apiFetch.mockReset().mockImplementation(async (path: string) =>
    path === "/api/approvals"
      ? response({ decisions: [PIN] })
      : response({ decisions: [] }),
  );
  mocks.approveDecision.mockReset().mockResolvedValue(response({ ok: true }));
  mocks.follow.mockReset().mockResolvedValue({ state: "posted", url: null });
});

afterEach(cleanup);

describe("Pinterest approval reconciliation", () => {
  it("follows the pin after approval from the global Approvals page", async () => {
    render(<ApprovalsIsland />);
    const approve = await screen.findByRole("button", { name: "Approve" });
    await act(async () => fireEvent.click(approve));

    expect(mocks.approveDecision).toHaveBeenCalledWith(PIN.id, expect.any(Object));
    expect(mocks.follow).toHaveBeenCalledWith(PIN.id, "Pinterest", undefined, "tenant-1");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("still follows the original pin when the approval response is lost", async () => {
    mocks.approveDecision.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<ApprovalsIsland />);
    const approve = await screen.findByRole("button", { name: "Approve" });
    await act(async () => fireEvent.click(approve));

    expect(mocks.follow).toHaveBeenCalledWith(PIN.id, "Pinterest", undefined, "tenant-1");
    expect(screen.getByText(/Could not confirm the Pinterest approval/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("reloads the original card when reconciliation shows approval never happened", async () => {
    mocks.approveDecision.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mocks.follow.mockResolvedValueOnce({ state: "approval_uncertain" });
    render(<ApprovalsIsland />);
    const approve = await screen.findByRole("button", { name: "Approve" });
    await act(async () => fireEvent.click(approve));

    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === "/api/approvals")).toHaveLength(2);
  });

  it("keeps the editable card after a definite validation refusal", async () => {
    mocks.approveDecision.mockResolvedValueOnce(
      response({ error: { code: "invalid_edit", message: "Pinterest descriptions must be at most 500 characters." } }, false, 400),
    );
    render(<ApprovalsIsland />);
    const approve = await screen.findByRole("button", { name: "Approve" });
    await act(async () => fireEvent.click(approve));

    expect(mocks.follow).not.toHaveBeenCalled();
    expect(screen.getByText("Pinterest descriptions must be at most 500 characters.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });
});
