import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiFetch } from "@/lib/api";
import { ApprovalsIsland } from "./ApprovalsIsland";
import type { Decision } from "./approvalDecision";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/workspace/PostPreview", () => ({
  PostPreview: ({ payload }: { payload: Record<string, unknown> }) => <p>{String(payload.text)}</p>,
}));

const id = "11111111-1111-4111-8111-111111111111";
const makeDecision = (revision: string, text: string): Decision => ({
  id, post_revision: revision, agent_run_id: null, decision_class: "social.publish.v2", status: "proposed",
  autonomy_at_emit: "approval", handler: "social_post_create", emitted_at: "2026-10-16T00:00:00Z",
  body: { channel: "linkedin", payload: { text }, post_draft: { text, thread: null }, scheduled_at: null },
});
let current: Decision;
const approvals: Record<string, unknown>[] = [];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  current = makeDecision("a".repeat(64), "Saved social caption");
  approvals.length = 0;
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    if (url === `/api/approvals/${id}/approve`) {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      approvals.push(body);
      return body.expected_post_revision === current.post_revision
        ? reply({ ok: true })
        : reply({ error: { code: "stale_card", message: "This post changed. Refresh before approving." } }, 409);
    }
    return reply({ decisions: url === "/api/approvals" ? [current] : [] });
  });
});
afterEach(cleanup);

it("approves a saved post using the revision returned by the list", async () => {
  render(<ApprovalsIsland />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  await waitFor(() => expect(approvals).toHaveLength(1));
  expect(approvals[0]).toEqual({ expected_post_revision: current.post_revision, expected_scheduled_at: null });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
});

it("schedules a saved post after refreshing to the latest displayed revision", async () => {
  render(<ApprovalsIsland />);
  await screen.findByText("Saved social caption");
  current = makeDecision("b".repeat(64), "Saved in another tab");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Saved in another tab");
  fireEvent.change(screen.getByLabelText("Publish at"), { target: { value: "2099-01-02T09:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve at this time" }));
  await waitFor(() => expect(approvals).toHaveLength(1));
  expect(approvals[0]).toMatchObject({ expected_post_revision: current.post_revision, scheduled_at: expect.stringContaining("2099-01-02") });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Approve at this time" })).toBeNull());
});

it("keeps a stale approval pending and allows approval after an explicit refresh", async () => {
  render(<ApprovalsIsland />);
  const approve = await screen.findByRole("button", { name: "Approve" });
  current = makeDecision("b".repeat(64), "A newer saved post");
  fireEvent.click(approve);
  await screen.findByText("This post changed. Refresh before approving.");
  expect(approvals[0].expected_post_revision).toBe("a".repeat(64));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("A newer saved post");
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(approvals).toHaveLength(2));
  expect(approvals[1].expected_post_revision).toBe(current.post_revision);
});
