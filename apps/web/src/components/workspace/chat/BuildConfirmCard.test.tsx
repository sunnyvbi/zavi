// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { BuildConfirmCard } from "./BuildConfirmCard";
import { parseBuildConfirm } from "@/lib/workspace/buildConfirm";

const card = {
  nonce: "11111111-1111-4111-8111-111111111111",
  target: "engineer",
  est_credits: 2000,
  est_usd: 5,
  expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("BuildConfirmCard", () => {
  it("shows the cost and starts THIS card's build on Start", async () => {
    apiFetch.mockResolvedValue(json(200, { status: "started", run_id: "child-1" }));
    render(<BuildConfirmCard card={card} threadId="th-1" />);
    expect(screen.getByText(/About 2,000 credits \(~\$5\.00\)/)).toBeTruthy();
    fireEvent.click(screen.getByText("Start build"));
    await waitFor(() => expect(screen.getByText(/Build started/)).toBeTruthy());
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe("/api/chat/build-confirm/th-1/start");
    expect(JSON.parse((init as { body: string }).body)).toEqual({ nonce: card.nonce });
  });

  it("a free first build says free and never shows a zero credit price", () => {
    const parsed = parseBuildConfirm({ ...card, est_credits: 0, est_usd: 0 });
    expect(parsed).toBeTruthy();
    render(<BuildConfirmCard card={parsed!} threadId="th-1" />);
    expect(screen.getByText(/Free: this is your workspace's first build\./)).toBeTruthy();
    expect(screen.queryByText(/0 credits/)).toBeNull();
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
    expect(screen.getByText("Start build")).toBeTruthy();
  });

  it("402 shows a top-up link and keeps Start available", async () => {
    apiFetch.mockResolvedValue(json(402, { status: "insufficient_credits" }));
    render(<BuildConfirmCard card={card} threadId="th-1" />);
    fireEvent.click(screen.getByText("Start build"));
    await waitFor(() => expect(screen.getByText(/Not enough credits/)).toBeTruthy());
    expect(screen.getByText("Start build")).toBeTruthy();
  });

  it("an expired or already-started card has no Start button", () => {
    render(<BuildConfirmCard card={{ ...card, expires_at: "2020-01-01T00:00:00Z" }} threadId="th-1" />);
    expect(screen.queryByText("Start build")).toBeNull();
    cleanup();
    render(<BuildConfirmCard card={{ ...card, status: "started", run_id: "c" }} threadId="th-1" />);
    expect(screen.queryByText("Start build")).toBeNull();
    expect(screen.getByText(/Build started/)).toBeTruthy();
  });

  it("a card the server marked replaced says so and has no Start, even after it mounted", () => {
    const { rerender } = render(<BuildConfirmCard card={card} threadId="th-1" />);
    expect(screen.getByText("Start build")).toBeTruthy();
    rerender(<BuildConfirmCard card={{ ...card, status: "replaced" }} threadId="th-1" />);
    expect(screen.queryByText("Start build")).toBeNull();
    expect(screen.getByText("Replaced by your new request.")).toBeTruthy();
    expect(screen.queryByText(/Nothing runs until you start it/)).toBeNull();
  });

  it("a click on a card the server no longer holds (409) says replaced or expired, with no Start", async () => {
    apiFetch.mockResolvedValue(json(409, { status: "expired" }));
    render(<BuildConfirmCard card={card} threadId="th-1" />);
    fireEvent.click(screen.getByText("Start build"));
    await waitFor(() =>
      expect(
        screen.getByText("This build request was replaced or expired. Ask me again to start it."),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Start build")).toBeNull();
  });

  it("parseBuildConfirm keeps the replaced status", () => {
    expect(parseBuildConfirm({ ...card, status: "replaced" })?.status).toBe("replaced");
  });

  it("parseBuildConfirm rejects a malformed meta", () => {
    expect(parseBuildConfirm({ nonce: "x" })).toBeUndefined();
    expect(parseBuildConfirm(card)).toEqual(card);
  });
});
