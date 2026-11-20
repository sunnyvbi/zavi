// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const routes: Record<string, { status: number; body: unknown }> = {};
const posts: unknown[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    if (method === "POST") posts.push(init?.body ? JSON.parse(init.body) : undefined);
    const r = routes[`${method} ${url}`] ?? { status: 200, body: {} };
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("@/app/connectors/composioConnect", () => ({ startComposioConnect: vi.fn(() => Promise.resolve()) }));
vi.mock("../../actions/channelPlanLock", () => ({ useChannelPlanLock: () => null, upgradeOnPlanRefusal: () => false }));

import { EmailConnectTiles, forgetConnected } from "../EmailConnectTiles";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
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

const submitKey = async (key: string) => {
  fireEvent.click(await screen.findByRole("button", { name: "Connect SendGrid" }));
  const input = await screen.findByPlaceholderText("SG.…");
  fireEvent.change(input, { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
};

describe("Connect SendGrid from the Email campaigns Overview", () => {
  it("shows the server's reason when the key is not a SendGrid key, instead of doing nothing", async () => {
    routes["POST /api/connectors/email"] = {
      status: 400,
      body: { error: { code: "invalid_body", message: "That does not look like a SendGrid API key. It starts with SG." } },
    };
    render(<EmailConnectTiles />);
    await submitKey("notasendgridkeyatall1234567890");
    const modal = screen.getByRole("dialog");
    const alert = await within(modal).findByRole("alert");
    expect(alert.textContent).toBe("Couldn’t connect SendGridThat does not look like a SendGrid API key. It starts with SG.");
    expect(posts).toEqual([{ api_key: "notasendgridkeyatall1234567890" }]);
    expect(screen.queryByText("SendGrid is connected")).toBeNull();
  });

  it("a revoked key shows its reason inside the Connect SendGrid window, once, and keeps the window open to try another key", async () => {
    routes["POST /api/connectors/email"] = {
      status: 400,
      body: { error: { message: "SendGrid did not accept this key. Your existing connection, if any, is unchanged." } },
    };
    render(<EmailConnectTiles />);
    await submitKey("SG.revokedrevokedrevoked.revokedrevoked");
    const modal = screen.getByRole("dialog");
    expect((await within(modal).findAllByRole("alert")).map((a) => a.textContent)).toEqual(["Couldn’t connect SendGridSendGrid did not accept this key. Your existing connection, if any, is unchanged."]);
    expect(screen.queryAllByRole("alert").length).toBe(1);
    expect(within(modal).getByPlaceholderText("SG.…")).toBeTruthy();
  });
});

describe("the SendGrid tile after a Mail-Send-only key was saved", () => {
  const sendgridRoute = (status: string) => {
    routes["GET /api/workspace/email-test-lists"] = {
      status: 200,
      body: {
        routes: [
          { route: "sendgrid", label: "SendGrid", status, error: status === "needs_permissions" ? "The saved SendGrid key sends one-to-one email but is missing the permissions campaigns need." : null, lists: [] },
          { route: "mailchimp", label: "Mailchimp", status: "not_connected", error: null, lists: [] },
          { route: "klaviyo", label: "Klaviyo", status: "not_connected", error: null, lists: [] },
        ],
        orphans: [],
      },
    };
  };

  it("reads Needs permissions in the attention style and opens the Connect SendGrid form", async () => {
    sendgridRoute("needs_permissions");
    render(<EmailConnectTiles />);
    const state = await screen.findByTestId("email-connect-sendgrid-state");
    expect(state.textContent).toBe("Needs permissions");
    expect(state.className).toMatch(/text-danger/);
    const tile = screen.getByTestId("email-connect-sendgrid");
    expect(tile.getAttribute("data-state")).toBe("attention");
    expect(tile.getAttribute("data-issue")).toBe("permissions");
    expect(tile.getAttribute("aria-label")).toMatch(/^SendGrid needs permissions/);
    expect(screen.getByTestId("email-connect-mailchimp-state").textContent).toBe("Connect");
    fireEvent.click(tile);
    const modal = await screen.findByRole("dialog");
    expect(within(modal).getByPlaceholderText("SG.…")).toBeTruthy();
  });

  it("a campaign-ready key still reads Connected", async () => {
    sendgridRoute("complete");
    render(<EmailConnectTiles />);
    expect((await screen.findByTestId("email-connect-sendgrid-state")).textContent).toBe("Connected");
    expect(screen.getByTestId("email-connect-sendgrid").getAttribute("data-issue")).toBeNull();
  });
});
