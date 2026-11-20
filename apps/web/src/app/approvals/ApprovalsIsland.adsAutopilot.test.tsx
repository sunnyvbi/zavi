// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  approveDecision: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.apiFetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: mocks.approveDecision }));
vi.mock("@/components/workspace/WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ tenantId: "tenant-1" }),
}));

import { ApprovalsIsland } from "./ApprovalsIsland";

const decision = (id: string, decisionClass: string, channel: string) => ({
  id,
  agent_run_id: null,
  decision_class: decisionClass,
  body: { title: `${channel} launch`, payload: { campaign_name: `${channel} spring` } },
  status: "proposed",
  autonomy_at_emit: "approval",
  handler: decisionClass,
  emitted_at: "2026-11-05T07:09:07.000Z",
  channel_slug: channel,
});

const LINKEDIN = decision("aaaaaaaa-0000-4000-8000-000000000011", "linkedin_ads.launch_campaign", "linkedin_ads");
const META = decision("aaaaaaaa-0000-4000-8000-000000000012", "meta_ads.update_ad_set_budget", "meta_ads");

const response = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  clone() {
    return this;
  },
});

const card = (id: string) => document.getElementById(`approval-${id}`) as HTMLElement;

beforeEach(() => {
  window.localStorage.clear();
  mocks.apiFetch.mockReset().mockImplementation(async (path: string) =>
    path === "/api/approvals" ? response({ decisions: [LINKEDIN, META] }) : response({ decisions: [] }),
  );
  mocks.approveDecision.mockReset().mockResolvedValue(response({ ok: true }));
});

afterEach(cleanup);

describe("ads autopilot panel on approval cards", () => {
  it("never offers a LinkedIn card a $/day cap the LinkedIn launch does not enforce", async () => {
    render(<ApprovalsIsland />);
    await screen.findAllByRole("button", { name: "Approve" });

    const linkedin = card(LINKEDIN.id);
    expect(within(linkedin).queryByLabelText("Daily budget cap in dollars")).toBeNull();
    expect(within(linkedin).queryByText(/ads autopilot/i)).toBeNull();
    expect(within(linkedin).queryByRole("button", { name: /Enable ads autopilot/ })).toBeNull();
    expect(within(linkedin).getByRole("button", { name: "Approve" })).toBeTruthy();

    const meta = card(META.id);
    expect(within(meta).getByLabelText("Daily budget cap in dollars")).toBeTruthy();
    expect(within(meta).getByRole("button", { name: /Enable ads autopilot up to \$50/ })).toBeTruthy();

    const capWrites = mocks.apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method);
    expect(capWrites).toEqual([]);
  });
});
