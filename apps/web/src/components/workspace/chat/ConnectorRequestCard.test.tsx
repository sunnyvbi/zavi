// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConnectorRequest } from "@zavi/shared";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
const launchConnect = vi.hoisted(() => vi.fn(async (_slug: string, _info: unknown) => {}));
vi.mock("@/app/connectors/connectStrategies", async (orig) => ({
  ...(await orig<typeof import("@/app/connectors/connectStrategies")>()),
  launchConnect,
}));

import { ConnectorRequestCard } from "./ConnectorRequestCard";

const base: ConnectorRequest = {
  kind: "connector_request",
  v: 1,
  request_id: "req-1",
  slug: "meta_ads",
  label: "Meta Ads",
  connect: "oauth",
  reason: "I need your Meta Ads account to read campaign spend.",
  origin: "model",
  mode: "connect",
  run_id: "run-1",
  created_at: "2026-09-22T10:00:00.000Z",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let connectors: Array<{ slug: string; connected_at?: string | null }> = [];
let continueStatus = 200;
let continueCode: unknown = "not_connected_yet";

beforeEach(() => {
  connectors = [];
  continueStatus = 200;
  continueCode = "not_connected_yet";
  window.localStorage.clear();
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/api/connectors") return json(200, { connectors });
    if (path.startsWith("/api/chat/connector-requests/")) {
      return continueStatus === 200
        ? json(200, { run_id: "run-2" })
        : json(continueStatus, { error: continueCode });
    }
    return json(404, {});
  });
});

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  launchConnect.mockClear();
});

describe("ConnectorRequestCard", () => {
  it("connect mode: title, reason and Connect button that launches the strategy", async () => {
    render(<ConnectorRequestCard request={base} />);
    expect(screen.getByText("I need your Meta Ads account to read campaign spend.")).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Connect Meta Ads" });
    fireEvent.click(btn);
    await waitFor(() => expect(launchConnect).toHaveBeenCalledTimes(1));
    expect(launchConnect.mock.calls[0]![0]).toBe("meta_ads");
  });

  it("reconnect mode uses Reconnect copy", () => {
    render(<ConnectorRequestCard request={{ ...base, mode: "reconnect" }} />);
    expect(screen.getByRole("button", { name: "Reconnect Meta Ads" })).toBeTruthy();
  });

  it("flips to Continue once the connector row exists", async () => {
    connectors = [{ slug: "meta_ads", connected_at: "2026-09-22T09:00:00.000Z" }];
    render(<ConnectorRequestCard request={base} />);
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("reconnect mode flips only when connected_at is newer than the request", async () => {
    connectors = [{ slug: "meta_ads", connected_at: "2026-09-22T09:00:00.000Z" }];
    render(<ConnectorRequestCard request={{ ...base, mode: "reconnect" }} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/connectors"));
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();

    connectors = [{ slug: "meta_ads", connected_at: "2026-09-22T10:05:00.000Z" }];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("posts continue once and shows Working on it", async () => {
    connectors = [{ slug: "meta_ads" }];
    render(<ConnectorRequestCard request={base} />);
    const btn = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(await screen.findByText("Working on it")).toBeTruthy();
    const posts = apiFetch.mock.calls.filter(([p]) => String(p).includes("/continue"));
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe("/api/chat/connector-requests/run-1/continue");
    expect(posts[0]![1]).toMatchObject({ method: "POST" });
  });

  it("409 shows Not connected yet and returns to pending", async () => {
    connectors = [{ slug: "meta_ads" }];
    continueStatus = 409;
    render(<ConnectorRequestCard request={base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Not connected yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Meta Ads" })).toBeTruthy();
  });

  it("other errors show a Settings link", async () => {
    connectors = [{ slug: "meta_ads" }];
    continueStatus = 403;
    render(<ConnectorRequestCard request={base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    const link = await screen.findByRole("link", { name: "Open Settings" });
    expect(link.getAttribute("href")).toBe("/workspace?tab=settings#connector-meta_ads");
  });

  it("after a non-409 error Continue is clickable again", async () => {
    connectors = [{ slug: "meta_ads" }];
    continueStatus = 500;
    render(<ConnectorRequestCard request={base} />);
    const btn = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(btn);
    await screen.findByRole("link", { name: "Open Settings" });
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a non-409 error says why, with the server's code", async () => {
    connectors = [{ slug: "meta_ads" }];
    continueStatus = 500;
    continueCode = "run_read_failed";
    render(<ConnectorRequestCard request={base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Something went wrong \(run_read_failed\)/)).toBeTruthy();
  });

  it("403 plan_upgrade_required says the plan does not include it", async () => {
    connectors = [{ slug: "meta_ads" }];
    continueStatus = 403;
    continueCode = "plan_upgrade_required";
    render(<ConnectorRequestCard request={base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Your plan doesn't include this agent/)).toBeTruthy();
  });

  it("a 409 that is not not_connected_yet is an error, not Not connected yet", async () => {
    connectors = [{ slug: "meta_ads" }];
    continueStatus = 409;
    continueCode = "not_continuable";
    render(<ConnectorRequestCard request={base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/can't be continued/)).toBeTruthy();
    expect(screen.queryByText("Not connected yet")).toBeNull();
  });

  it("reads a nested auth-layer error code", async () => {
    connectors = [{ slug: "meta_ads" }];
    continueStatus = 403;
    continueCode = { code: "viewer_read_only", message: "read-only" };
    render(<ConnectorRequestCard request={base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Your role is read-only/)).toBeTruthy();
  });

  it("402 says out of credits with a top-up link", async () => {
    connectors = [{ slug: "meta_ads" }];
    continueStatus = 402;
    render(<ConnectorRequestCard request={base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/You're out of credits\./)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Top up" });
    expect(link.getAttribute("href")).toBe("/workspace?tab=settings#billing");
  });

  it("a later reply does NOT collapse the card when Continue was never pressed", async () => {
    connectors = [{ slug: "meta_ads" }];
    render(<ConnectorRequestCard request={base} followedByAssistantRow />);
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByText("Connected Meta Ads")).toBeNull();
  });

  it("collapses to Connected <label> once THIS card continued and a newer reply exists", async () => {
    connectors = [{ slug: "meta_ads" }];
    const { rerender } = render(<ConnectorRequestCard request={base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("Working on it");
    rerender(<ConnectorRequestCard request={base} followedByAssistantRow />);
    expect(await screen.findByText("Connected Meta Ads")).toBeTruthy();
    expect(screen.queryByTestId("connector-request-card")).toBeNull();
  });

  it("after a reload (fresh mount) a later reply does not collapse it: Continue is back", async () => {
    connectors = [{ slug: "meta_ads" }];
    const first = render(<ConnectorRequestCard request={base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("Working on it");
    first.unmount();
    render(<ConnectorRequestCard request={base} followedByAssistantRow />);
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.queryByText("Connected Meta Ads")).toBeNull();
  });

  it("dismiss hides the card and is remembered per request", () => {
    const { unmount } = render(<ConnectorRequestCard request={base} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("connector-request-card")).toBeNull();
    unmount();
    render(<ConnectorRequestCard request={base} />);
    expect(screen.queryByTestId("connector-request-card")).toBeNull();
  });
});
