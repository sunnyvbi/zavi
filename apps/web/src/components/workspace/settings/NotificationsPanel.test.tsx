// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const LIST = "/api/notifications/agent-email-recipients";
const RID = "00000000-0000-4000-8000-0000000000aa";

const calls: { path: string; method: string }[] = [];
let removeBody: unknown = { removed: false };
let listBodies: unknown[] = [];

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    if (path === LIST && method === "GET") {
      const body = listBodies.length > 1 ? listBodies.shift() : listBodies[0];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }
    if (path === `${LIST}/${RID}` && method === "DELETE") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(removeBody) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  },
}));

vi.mock("./PushPrefsCard", () => ({ PushPrefsCard: () => null }));

import { NotificationsPanel } from "./NotificationsPanel";

const owner = { id: null, email: "owner@acme.com", label: null, is_owner: true };
const ops = { id: RID, email: "ops@acme.com", label: null, is_owner: false };

beforeEach(() => {
  calls.length = 0;
});
afterEach(cleanup);

function listGets() {
  return calls.filter((c) => c.path === LIST && c.method === "GET").length;
}

describe("NotificationsPanel remove", () => {
  it("shows an error and reloads when the server reports removed:false", async () => {
    removeBody = { removed: false };
    listBodies = [{ recipients: [owner, ops] }];
    render(<NotificationsPanel />);
    const btn = await screen.findByRole("button", { name: "Remove ops@acme.com" });
    expect(listGets()).toBe(1);

    fireEvent.click(btn);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/wasn't removed/);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    await waitFor(() => expect(listGets()).toBe(2));
    expect(screen.getByText("ops@acme.com")).toBeDefined();
  });

  it("treats a body without removed:true as a failure, not success", async () => {
    removeBody = {};
    listBodies = [{ recipients: [owner, ops] }];
    render(<NotificationsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove ops@acme.com" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/wasn't removed/);
  });

  it("stays quiet and drops the row when removed:true", async () => {
    removeBody = { removed: true };
    listBodies = [{ recipients: [owner, ops] }, { recipients: [owner] }];
    render(<NotificationsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove ops@acme.com" }));
    await waitFor(() => expect(screen.queryByText("ops@acme.com")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(listGets()).toBe(2);
  });
});
