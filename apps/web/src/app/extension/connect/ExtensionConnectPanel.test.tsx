import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  calls: [] as { path: string; opts: Record<string, unknown> }[],
  ok: true,
  body: {
    code: "THE_CODE",
    redirect_uri: "https://kfgbahfijacgiigdnlaoaemdfbolabia.chromiumapp.org/callback",
  } as unknown,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts: Record<string, unknown> = {}) => {
    state.calls.push({ path, opts });
    return { ok: state.ok, json: async () => state.body };
  },
}));

import { ExtensionConnectPanel } from "./ExtensionConnectPanel";

let replaced: string[] = [];
let closed = 0;

beforeEach(() => {
  state.calls = [];
  state.ok = true;
  state.body = {
    code: "THE_CODE",
    redirect_uri: "https://kfgbahfijacgiigdnlaoaemdfbolabia.chromiumapp.org/callback",
  };
  replaced = [];
  closed = 0;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { replace: (u: string) => replaced.push(u) },
  });
  window.close = () => {
    closed += 1;
  };
});

afterEach(cleanup);

describe("the connect screen", () => {
  it("names the account the extension is about to be signed in as", () => {
    render(<ExtensionConnectPanel email="owner@acme.com" />);
    expect(screen.getByText("owner@acme.com")).toBeTruthy();
    expect(screen.getByRole("heading").textContent).toContain("Connect the Zavi extension");
  });
});

describe("T11 Cancel", () => {
  it("writes no row: /start is never called", async () => {
    render(<ExtensionConnectPanel email="owner@acme.com" />);
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.getByRole("heading").textContent).toContain("cancelled"));
    expect(state.calls).toEqual([]);
    expect(replaced).toEqual([]);
    expect(closed).toBe(1);
  });
});

describe("Connect", () => {
  it("posts an EMPTY body and follows the SERVER's redirect with the code", async () => {
    render(<ExtensionConnectPanel email="owner@acme.com" />);
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => expect(replaced).toHaveLength(1));
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].path).toBe("/api/extension/connect/start");
    expect(state.calls[0].opts.method).toBe("POST");
    expect(state.calls[0].opts.body).toBeUndefined();

    expect(replaced[0]).toBe(
      "https://kfgbahfijacgiigdnlaoaemdfbolabia.chromiumapp.org/callback?code=THE_CODE",
    );
  });

  it("shows a generic error and does not navigate when /start refuses", async () => {
    state.ok = false;
    render(<ExtensionConnectPanel email="owner@acme.com" />);
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not connect the extension. Try again.",
    );
    expect(replaced).toEqual([]);
  });

  it("does not navigate on a response missing the code or the redirect", async () => {
    state.body = { redirect_uri: "https://x.chromiumapp.org/callback" };
    render(<ExtensionConnectPanel email="owner@acme.com" />);
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(replaced).toEqual([]);
  });
});
