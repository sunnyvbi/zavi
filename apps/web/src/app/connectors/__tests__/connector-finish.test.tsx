// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import ConnectorFinishPage from "../finish/page";
import { sameOriginTarget } from "../finish/target";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const replace = vi.fn();
const clearChannelReadCache = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace/channelReadCache", () => ({ clearChannelReadCache }));

beforeEach(() => {
  apiFetch.mockReset();
  replace.mockReset();
  clearChannelReadCache.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, hash: "", pathname: "/connectors/finish", origin: "http://localhost", replace },
  });
});
afterEach(cleanup);

function landWith(hash: string) {
  (window.location as unknown as { hash: string }).hash = hash;
}

describe("connector finish page", () => {
  it("posts code and state with the signed-in session and lands on the backend's same-origin target", async () => {
    landWith("#connector=linkedin_ads&code=c-1&state=s-1");
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, redirect: "http://localhost/workspace?tab=channels&linkedin_ads=connected" }) });
    render(<ConnectorFinishPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workspace?tab=channels&linkedin_ads=connected"));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/connectors/linkedin_ads/complete");
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ code: "c-1", state: "s-1" });
  });

  it("shows the refusal and never navigates when the backend refuses the session", async () => {
    landWith("#connector=linkedin_ads&code=c-1&state=s-1");
    apiFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { code: "state_session_mismatch", message: "This sign-in was started by another person or workspace." } }) });
    render(<ConnectorFinishPage />);
    expect(await screen.findByText("This sign-in was started by another person or workspace.")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  function browserIs(userAgent: string) {
    Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: userAgent });
  }

  it("must catch: a phone browser with no web session hands the sign-in to the app, whose own token finishes it", async () => {
    browserIs("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    landWith("#connector=linkedin_ads&code=c%2B1&state=s-1");
    apiFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: "unauthorized", message: "raw" } }) });
    render(<ConnectorFinishPage />);
    const link = await screen.findByRole("link", { name: "Open the Zavi app" });
    expect(link.getAttribute("href")).toBe("zavi://connectors/finish?connector=linkedin_ads&code=c%2B1&state=s-1");
    expect(replace).not.toHaveBeenCalled();
  });

  it("must catch: a computer browser with no session is told plainly nothing was saved and given a way to sign in, never the raw token error", async () => {
    browserIs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    landWith("#connector=linkedin_ads&code=c-1&state=s-1");
    apiFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: "Missing or invalid Bearer token." } }) });
    render(<ConnectorFinishPage />);
    expect(await screen.findByText(/You are signed out, so this connection was not finished and nothing was saved/)).toBeTruthy();
    expect(screen.queryByText(/Bearer/)).toBeNull();
    const signIn = screen.getByRole("link", { name: "Sign in" });
    expect(signIn.getAttribute("href")).toBe("/login?next=%2Fworkspace%3Ftab%3Dsettings");
    expect(screen.queryByRole("link", { name: "Open the Zavi app" })).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("must not catch: a phone browser refused for the wrong session never gets the app link", async () => {
    browserIs("Mozilla/5.0 (Linux; Android 15)");
    landWith("#connector=linkedin_ads&code=c-1&state=s-1");
    apiFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { code: "state_session_mismatch", message: "This sign-in was started by another person or workspace." } }) });
    render(<ConnectorFinishPage />);
    expect(await screen.findByText("This sign-in was started by another person or workspace.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open the Zavi app" })).toBeNull();
  });

  it("must catch (Flow 2): a finished connect drops the tab's saved dashboard before landing, so the Connect card never paints first", async () => {
    landWith("#connector=linkedin_ads&code=c-1&state=s-1");
    const order: string[] = [];
    clearChannelReadCache.mockImplementation(() => order.push("clear"));
    replace.mockImplementation(() => order.push("land"));
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, redirect: "http://localhost/workspace/linkedin_ads?linkedin_ads=connected" }) });
    render(<ConnectorFinishPage />);
    await waitFor(() => expect(order).toEqual(["clear", "land"]));
  });

  it("must not catch: a refused finish keeps the saved dashboard", async () => {
    landWith("#connector=linkedin_ads&code=c-1&state=s-1");
    apiFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { code: "invalid_state", message: "OAuth state invalid, expired, or replayed." } }) });
    render(<ConnectorFinishPage />);
    await screen.findByText(/took too long/);
    expect(clearChannelReadCache).not.toHaveBeenCalled();
  });

  it("must catch (Flow 1): more than ten minutes on LinkedIn's consent page reads as plain words with a way forward, never the OAuth state text", async () => {
    landWith("#connector=linkedin_ads&code=c-1&state=s-1");
    apiFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { code: "invalid_state", message: "OAuth state invalid, expired, or replayed." } }) });
    render(<ConnectorFinishPage />);
    expect(await screen.findByText("The LinkedIn sign-in took too long or was already used, so nothing was connected. Go back to your workspace and press Connect to try again.")).toBeTruthy();
    expect(screen.queryByText(/OAuth|replayed/)).toBeNull();
    expect(screen.getByRole("link", { name: "Back to your workspace" })).toBeTruthy();
  });

  it.each([
    ["a raw database error", 500, { error: { code: "state_consume_failed", message: "permission denied for function consume_oauth_state" } }],
    ["a bare gateway error", 502, {}],
  ])("must catch (Flow 1): %s is never shown to the founder", async (_name, status, body) => {
    landWith("#connector=linkedin_ads&code=c-1&state=s-1");
    apiFetch.mockResolvedValue({ ok: false, status, json: async () => body });
    render(<ConnectorFinishPage />);
    expect(await screen.findByText("The connection could not be finished, so nothing was connected. Go back to your workspace and press Connect to try again.")).toBeTruthy();
    expect(screen.queryByText(/permission denied|consume_oauth_state|HTTP/)).toBeNull();
  });

  it("does not call the backend for a malformed connector slug", async () => {
    landWith("#connector=../../api/staff&code=c&state=s");
    render(<ConnectorFinishPage />);
    expect(await screen.findByText(/incomplete/)).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("never follows a redirect to another origin", () => {
    expect(sameOriginTarget("https://evil.example/workspace", "http://localhost")).toBe("/workspace?tab=settings");
    expect(sameOriginTarget("//evil.example/x", "http://localhost")).toBe("/workspace?tab=settings");
    expect(sameOriginTarget(undefined, "http://localhost")).toBe("/workspace?tab=settings");
    expect(sameOriginTarget("http://localhost/workspace?a=1#b", "http://localhost")).toBe("/workspace?a=1#b");
  });
});
