// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
const openStatic = vi.fn();
let role: string | null = "owner";
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock("./layout/shared", () => ({ useOpenStatic: () => openStatic }));
vi.mock("./WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role }) }));
vi.mock("@/components/workspace/actions/BusinessControlsApprovalCard", () => ({
  BusinessControlsApprovalCard: ({ decisionId }: { decisionId: string }) => <div data-testid="business-controls-card">{decisionId}</div>,
}));

import { NeedsYouTab } from "./NeedsYouTab";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  agent_run_id: null,
  decision_class: "pm.needs_action",
  handler: "pm.needs_action",
  body: { rationale: `Ticket ${n} needs a call.` },
  status: "proposed",
  emitted_at: `2026-10-17T10:00:0${9 - n}.000Z`,
  dispatched_at: null,
  dispatch_error: null,
  home: "needs_you",
  home_channel: null,
  channel_slug: null,
  agent_slug: "pm",
  thread_id: null,
  run_stopped: false,
  needs_owner_admin: false,
  ...over,
});

type Route = (url: string, init?: RequestInit) => Response | undefined;
let routes: Route[] = [];
beforeEach(() => {
  role = "owner";
  openStatic.mockReset();
  apiFetch.mockReset();
  routes = [];
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    for (const r of routes) {
      const out = r(url, init);
      if (out) return out;
    }
    return json(404, { error: { code: "not_found" } });
  });
});
afterEach(cleanup);

const firstPage = (url: string) =>
  url === "/api/approvals?home=needs_you&count=1"
    ? json(200, { decisions: [row(1), row(2)], next_cursor: "CUR1", totals: { needs_you: 2, growth: 7, channel: 4 } })
    : undefined;

describe("NeedsYouTab", () => {
  it("lists the page, the true count, the growth line and Show more with the cursor", async () => {
    routes.push(firstPage, (url) =>
      url === "/api/approvals?home=needs_you&cursor=CUR1" ? json(200, { decisions: [row(3)], next_cursor: null }) : undefined,
    );
    render(<NeedsYouTab />);
    expect(await screen.findByText("2 items need you")).toBeTruthy();
    expect(screen.getAllByText(/You approve$/)).toHaveLength(2);
    fireEvent.click(screen.getByText("7 growth approvals → Your CGO"));
    expect(openStatic).toHaveBeenCalledWith("autopilot");
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getAllByText(/You approve$/)).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("Approve turns the row into its live card, tagged needs_you", async () => {
    routes.push(
      firstPage,
      (url) => (url === `/api/approvals/${uuid(1)}/approve?surface=needs_you` ? json(200, { ok: true }) : undefined),
      (url) =>
        url === `/api/approvals/${uuid(1)}`
          ? json(200, { decision: { ...row(1), status: "acted" }, home: { kind: "needs_you" }, needs_owner_admin: false, viewer_role: "owner" })
          : undefined,
    );
    render(<NeedsYouTab />);
    await screen.findByText("2 items need you");
    fireEvent.click(screen.getAllByRole("button", { name: "Retry fix" })[0]);
    expect(await screen.findByText("Done.")).toBeTruthy();
    expect(await screen.findByText("1 item needs you")).toBeTruthy();
  });

  it("a member gets no one-click Approve on a gated row; its card says why", async () => {
    role = "member";
    routes.push(
      (url) =>
        url === "/api/approvals?home=needs_you&count=1"
          ? json(200, { decisions: [row(1, { needs_owner_admin: true })], next_cursor: null, totals: { needs_you: 1, growth: 0, channel: 0 } })
          : undefined,
      (url) =>
        url === `/api/approvals/${uuid(1)}`
          ? json(200, { decision: row(1), home: { kind: "needs_you" }, needs_owner_admin: true, viewer_role: "member" })
          : undefined,
    );
    render(<NeedsYouTab />);
    await screen.findByText("1 item needs you");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("Only an owner or admin can approve this")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("business results settings open their own card in place, never a bare approve (F2)", async () => {
    routes.push((url) =>
      url === "/api/approvals?home=needs_you&count=1"
        ? json(200, {
            decisions: [row(4, { decision_class: "growth.save_business_controls", handler: null })],
            next_cursor: null,
            totals: { needs_you: 1, growth: 0, channel: 0 },
          })
        : undefined,
    );
    render(<NeedsYouTab />);
    await screen.findByText("1 item needs you");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect((await screen.findByTestId("business-controls-card")).textContent).toBe(uuid(4));
    expect(apiFetch.mock.calls.some(([u]) => String(u).includes("/approve"))).toBe(false);
  });

  it("focusing a growth decision opens the Growth page on it", async () => {
    routes.push(firstPage, (url) =>
      url === `/api/approvals/${uuid(5)}`
        ? json(200, { decision: row(5, { decision_class: "google_ads.update_campaign_budget" }), home: { kind: "growth" }, needs_owner_admin: false, viewer_role: "owner" })
        : undefined,
    );
    render(<NeedsYouTab focusDecisionId={uuid(5)} />);
    await waitFor(() => expect(openStatic).toHaveBeenCalledWith("autopilot", { decision: uuid(5) }));
  });

  it("focusing a channel decision opens its channel with the lane's card link", async () => {
    routes.push(firstPage, (url) =>
      url === `/api/approvals/${uuid(6)}`
        ? json(200, { decision: row(6), home: { kind: "channel", slug: "seo" }, needs_owner_admin: false, viewer_role: "owner" })
        : undefined,
    );
    render(<NeedsYouTab focusDecisionId={uuid(6)} />);
    await waitFor(() => expect(openStatic).toHaveBeenCalledWith("channels", { channel: "seo", action: uuid(6) }));
  });

  it("focusing a Needs-you decision pins it on top and opens it", async () => {
    routes.push(firstPage, (url) =>
      url === `/api/approvals/${uuid(8)}`
        ? json(200, { decision: row(8, { body: { rationale: "Pinned one." } }), home: { kind: "needs_you" }, needs_owner_admin: false, viewer_role: "owner" })
        : undefined,
    );
    const { container } = render(<NeedsYouTab focusDecisionId={uuid(8)} />);
    await waitFor(() => expect(container.querySelector(`[data-needs-you-row="${uuid(8)}"]`)).toBeTruthy());
    const ids = [...container.querySelectorAll("[data-needs-you-row]")].map((e) => e.getAttribute("data-needs-you-row"));
    expect(ids[0]).toBe(uuid(8));
  });

  it("focusing an id that is gone says so", async () => {
    routes.push(firstPage);
    render(<NeedsYouTab focusDecisionId={uuid(9)} />);
    expect(await screen.findByText("That card is not in your list any more.")).toBeTruthy();
  });

  it("empty and error states", async () => {
    routes.push((url) =>
      url === "/api/approvals?home=needs_you&count=1" ? json(200, { decisions: [], next_cursor: null, totals: { needs_you: 0, growth: 0, channel: 0 } }) : undefined,
    );
    render(<NeedsYouTab />);
    expect(await screen.findByText("Nothing needs you right now.")).toBeTruthy();
    cleanup();
    routes = [(url) => (url.startsWith("/api/approvals?home=needs_you") ? json(500, {}) : undefined)];
    render(<NeedsYouTab />);
    expect(await screen.findByText(/Could not load this list \(HTTP 500\)\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("re-reads when approvals change elsewhere", async () => {
    routes.push(firstPage);
    render(<NeedsYouTab />);
    await screen.findByText("2 items need you");
    const before = apiFetch.mock.calls.length;
    window.dispatchEvent(new Event("zavi:approvals-changed"));
    await waitFor(() => expect(apiFetch.mock.calls.length).toBeGreaterThan(before));
  });
});
