// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const routes: Record<string, { status: number; body?: unknown }> = {};
const posts: string[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (method === "POST") posts.push(url);
    const r = routes[`${method} ${url}`] ?? { status: 200, body: {} };
    return {
      ok: r.status < 400,
      status: r.status,
      json: () => (r.body === undefined ? Promise.reject(new SyntaxError("Unexpected end of JSON input")) : Promise.resolve(r.body)),
    };
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(() => Promise.resolve(true)) }));
vi.mock("@/components/workspace/WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("@/components/workspace/actions/channelPlanLock", () => ({ useChannelPlanLock: () => null, upgradeOnPlanRefusal: () => false }));

import { EmailConnectTiles, forgetConnected } from "@/components/workspace/email/EmailConnectTiles";

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  posts.length = 0;
  forgetConnected();
  routes["GET /api/workspace/email-test-lists"] = {
    status: 200,
    body: {
      routes: ["sendgrid", "mailchimp", "klaviyo"].map((r) => ({ route: r, label: r, status: "not_connected", error: null, lists: [] })),
      orphans: [],
    },
  };
});
afterEach(() => cleanup());

describe("Email campaigns Overview connect tiles when the Composio start fails", () => {
  for (const tool of ["mailchimp", "klaviyo", "gmail"]) {
    it(`${tool}: a 500 with no body shows the founder sentence, not "HTTP 500"`, async () => {
      routes[`POST /api/connectors/composio/${tool}/connect`] = { status: 500 };
      render(<EmailConnectTiles />);
      const tile = await screen.findByTestId(`email-connect-${tool}`);
      await screen.findByTestId(`email-connect-${tool}-state`);
      fireEvent.click(tile);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("Could not start the connection. Try again.");
      expect(screen.queryByText(/HTTP/)).toBeNull();
      expect(posts).toEqual([`/api/connectors/composio/${tool}/connect`]);
    });
  }

  it("a 400 with a server message shows that message on the tile", async () => {
    routes["POST /api/connectors/composio/mailchimp/connect"] = { status: 400, body: { error: { code: "not_enabled", message: "Mailchimp is not available on your plan." } } };
    render(<EmailConnectTiles />);
    await screen.findByTestId("email-connect-mailchimp-state");
    fireEvent.click(screen.getByTestId("email-connect-mailchimp"));
    expect((await screen.findByRole("alert")).textContent).toBe("Mailchimp is not available on your plan.");
  });
});
