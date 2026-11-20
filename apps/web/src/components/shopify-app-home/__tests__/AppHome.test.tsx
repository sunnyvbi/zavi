// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppHome } from "../AppHome";
import { ApprovalsCard } from "../ApprovalsCard";
import { PlanCard } from "../PlanCard";
import { PAID_FIXTURE } from "@/lib/shopify-app-home/fixtures";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/shopify/app-home");
  delete window.shopify;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Shopify App Home", () => {
  it("renders the paid layout with status, metrics, approvals and plan", async () => {
    render(<AppHome />);
    await waitFor(() => expect(screen.getByText("Working")).toBeTruthy());
    expect(screen.getByText("Growth Channels")).toBeTruthy();
    expect(document.querySelector("svg.lucide-inbox")).toBeTruthy();
    expect(screen.queryByText("Channels")).toBeNull();
    expect(screen.getByText("Store sales")).toBeTruthy();
    expect(screen.getByText("$4,820")).toBeTruthy();
    expect(screen.getByText("Waiting for your approval")).toBeTruthy();
    expect(screen.getAllByText("Approve")).toHaveLength(3);
    expect(screen.getByText("Billed by Shopify")).toBeTruthy();
    expect(screen.getByText("Change plan")).toBeTruthy();
    expect(screen.queryByText("$240")).toBeNull();
    expect(screen.queryByText("See plans")).toBeNull();
    expect(screen.queryByText(/stay signed in/i)).toBeNull();
    expect(screen.queryByText(/read-only/i)).toBeNull();
  });

  it("loads authenticated live data in production instead of serving a fixture", async () => {
    vi.stubEnv("NODE_ENV", "production");
    window.shopify = { idToken: vi.fn().mockResolvedValue("signed-shopify-token") };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(PAID_FIXTURE), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<AppHome />);
    await waitFor(() => expect(screen.getByText("Store sales")).toBeTruthy());
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:3001/api/shopify/app-home", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer signed-shopify-token" }),
    }));
  });

  it("shows the exact account and requires an explicit click before connecting inside Shopify", async () => {
    vi.stubEnv("NODE_ENV", "production");
    window.history.replaceState({}, "", "/shopify/app-home?embedded=1&zavi_confirmation=signed-choice");
    window.shopify = { idToken: vi.fn().mockResolvedValue("signed-shopify-token") };
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        shop: "zavi-test-store.myshopify.com",
        workspace: { display_name: "Zavi Test Store", account_email: "owner@zavi.test", role: "owner" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(PAID_FIXTURE), { status: 200, headers: { "Content-Type": "application/json" } }));

    render(<AppHome />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Connect store" })).toBeTruthy());
    expect(screen.getByText("Zavi Test Store")).toBeTruthy();
    expect(screen.getByText("owner@zavi.test")).toBeTruthy();
    expect(window.location.search).toBe("?embedded=1");
    expect(fetchSpy).toHaveBeenNthCalledWith(1, "http://localhost:3001/api/shopify/app-home/install/confirmation", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ confirmation: "signed-choice" }),
      headers: expect.objectContaining({ Authorization: "Bearer signed-shopify-token" }),
    }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Connect store" }));
    await waitFor(() => expect(screen.getByText("Store sales")).toBeTruthy());
    expect(fetchSpy).toHaveBeenNthCalledWith(2, "http://localhost:3001/api/shopify/app-home/install/confirm", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ confirmation: "signed-choice" }),
      headers: expect.objectContaining({ Authorization: "Bearer signed-shopify-token" }),
    }));
    expect(fetchSpy).toHaveBeenNthCalledWith(3, "http://localhost:3001/api/shopify/app-home", expect.anything());
    expect(window.location.search).toBe("?embedded=1");
  });

  it("offers a connected store's unlinked staff member the link handoff instead of a dead end", async () => {
    vi.stubEnv("NODE_ENV", "production");
    window.shopify = { idToken: vi.fn().mockResolvedValue("signed-shopify-token") };
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "user_not_linked", message: "Connect this staff account." },
      }), { status: 403, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connect_url: "https://www.zaviagent.com/connectors/shopify/install?token=signed-link",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<AppHome />);

    await waitFor(() => expect(screen.getByText("Link your Shopify staff account")).toBeTruthy());
    expect(screen.getByText(/already connected to Zavi/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue to Zavi" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://www.zaviagent.com/connectors/shopify/install?token=signed-link", "_top"));
    expect(fetchSpy).toHaveBeenNthCalledWith(2, "http://localhost:3001/api/shopify/app-home/install", expect.objectContaining({ method: "POST" }));
  });

  it("confirms a staff link with link wording, then loads the workspace", async () => {
    vi.stubEnv("NODE_ENV", "production");
    window.history.replaceState({}, "", "/shopify/app-home?embedded=1&zavi_confirmation=signed-link-choice");
    window.shopify = { idToken: vi.fn().mockResolvedValue("signed-shopify-token") };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        shop: "zavi-test-store.myshopify.com",
        workspace: { display_name: "Zavi Test Store", account_email: "owner@zavi.test", role: "owner" },
        link_only: true,
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, linked: true }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(PAID_FIXTURE), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<AppHome />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Link account" })).toBeTruthy());
    expect(screen.getByText("Link your Shopify staff account?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect store" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));
    await waitFor(() => expect(screen.getByText("Store sales")).toBeTruthy());
  });

  it("shows an error instead of an endless skeleton when the reload after connecting fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    window.history.replaceState({}, "", "/shopify/app-home?embedded=1&zavi_confirmation=signed-choice");
    window.shopify = { idToken: vi.fn().mockResolvedValue("signed-shopify-token") };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        shop: "zavi-test-store.myshopify.com",
        workspace: { display_name: "Zavi Test Store", account_email: "owner@zavi.test", role: "owner" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "shopify_app_unavailable", message: "Zavi could not load this Shopify workspace. Try again." },
      }), { status: 502, headers: { "Content-Type": "application/json" } }));
    render(<AppHome />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect store" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not load this Shopify workspace/));
    expect(screen.queryByRole("button", { name: "Connect store" })).toBeNull();
  });

  it("waits for App Bridge to initialize before requesting live data", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(PAID_FIXTURE), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<AppHome />);
    setTimeout(() => { window.shopify = { idToken: vi.fn().mockResolvedValue("delayed-token") }; }, 10);
    await waitFor(() => expect(screen.getByText("Store sales")).toBeTruthy());
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:3001/api/shopify/app-home", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer delayed-token" }),
    }));
  });

  it("shows embedded setup before preparing the managed-install workspace claim on click", async () => {
    vi.stubEnv("NODE_ENV", "production");
    window.shopify = { idToken: vi.fn().mockResolvedValue("signed-shopify-token") };
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "shop_not_connected", message: "Connect this store." },
      }), { status: 409, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connect_url: "https://www.zaviagent.com/connectors/shopify/install?token=signed-install",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<AppHome />);

    await waitFor(() => expect(screen.getByText("Finish setting up Zavi")).toBeTruthy());
    expect(screen.getByText(/review the exact workspace/)).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Continue to Zavi" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://www.zaviagent.com/connectors/shopify/install?token=signed-install", "_top"));
    expect(fetchSpy).toHaveBeenNthCalledWith(2, "http://localhost:3001/api/shopify/app-home/install", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer signed-shopify-token" }),
    }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps embedded setup available for retry when connection preparation fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    window.shopify = { idToken: vi.fn().mockResolvedValue("signed-shopify-token") };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "shop_not_connected", message: "Connect this store." },
      }), { status: 409, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "shopify_install_unavailable", message: "Could not prepare this Shopify connection. Try again." },
      }), { status: 503, headers: { "Content-Type": "application/json" } }));
    render(<AppHome />);

    const button = await screen.findByRole("button", { name: "Continue to Zavi" });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not prepare/));
    expect(screen.getByText("Finish setting up Zavi")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue to Zavi" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows an invalid-session error instead of masking it with OAuth", async () => {
    vi.stubEnv("NODE_ENV", "production");
    window.shopify = { idToken: vi.fn().mockResolvedValue("wrong-audience-token") };
    window.history.replaceState({}, "", "/shopify/app-home?embedded=1&hmac=signed&shop=zavi-test-store.myshopify.com&timestamp=1793534093");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { code: "invalid_token", message: "Your Shopify session expired. Reload the app and try again." },
    }), { status: 401, headers: { "Content-Type": "application/json" } }));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<AppHome />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/session expired/i));
    expect(open).not.toHaveBeenCalled();
  });

  it("uses anchors, not buttons inside anchors, for Open Zavi", async () => {
    render(<AppHome />);
    await waitFor(() => expect(screen.getByText("Working")).toBeTruthy());
    expect(document.querySelectorAll("a button")).toHaveLength(0);
    expect(document.querySelectorAll("a[href='https://www.zaviagent.com']")).toHaveLength(1);
  });

  it("renders the free layout with the banner, locked chips and empty approvals", async () => {
    window.history.replaceState({}, "", "/shopify/app-home?fixture=free");
    render(<AppHome />);
    await waitFor(() => expect(screen.getByText("Drafting only")).toBeTruthy());
    expect(screen.getByText("See plans")).toBeTruthy();
    expect(screen.getByText("Meta Ads · Pro plan")).toBeTruthy();
    expect(screen.getByText(/Nothing to approve/)).toBeTruthy();
    expect(screen.getByText("Upgrade")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("See plans")).toBeNull();
  });

  it("removes a one-click row only after the decision is accepted, and keeps it on failure", async () => {
    const rows = PAID_FIXTURE.approvals.rows.filter((r) => r.one_click_approvable);
    const onDecide = vi.fn().mockResolvedValueOnce({ ok: false, message: "Try again" }).mockResolvedValueOnce({ ok: true });
    render(<ApprovalsCard rows={rows} allApprovalsUrl="https://www.zaviagent.com/approvals" onDecide={onDecide} />);
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Try again"));
    expect(screen.getByText(rows[0].title)).toBeTruthy();
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(screen.queryByText(rows[0].title)).toBeNull());
    expect(screen.getByText(/Nothing to approve/)).toBeTruthy();
  });

  it("recovers when an inline approval request throws", async () => {
    const rows = PAID_FIXTURE.approvals.rows.filter((r) => r.one_click_approvable);
    const onDecide = vi.fn().mockRejectedValue(new Error("network down"));
    render(<ApprovalsCard rows={rows} allApprovalsUrl="https://www.zaviagent.com/approvals" onDecide={onDecide} />);
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Could not update this approval/));
    expect(screen.getByText("Approve").hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(rows[0].title)).toBeTruthy();
  });

  it("sends a detailed-review row to Zavi instead of deciding inline", () => {
    const rows = PAID_FIXTURE.approvals.rows.filter((r) => !r.one_click_approvable);
    const onDecide = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<ApprovalsCard rows={rows} allApprovalsUrl="https://www.zaviagent.com/approvals" onDecide={onDecide} />);
    fireEvent.click(screen.getAllByText("Approve")[0]);
    expect(open).toHaveBeenCalledWith(rows[0].review_url, "_blank", "noopener,noreferrer");
    expect(onDecide).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("shows the approved monthly and annual Shopify terms before checkout", async () => {
    const onSubscribe = vi.fn().mockResolvedValue({ ok: true });
    render(<PlanCard data={PAID_FIXTURE} onSubscribe={onSubscribe} />);
    fireEvent.click(screen.getByText("Change plan"));
    expect(screen.getByText("Monthly")).toBeTruthy();
    expect(screen.getByText("Annual")).toBeTruthy();
    expect(screen.getByText(/^No trial\./)).toBeTruthy();
    fireEvent.click(screen.getByText("Annual"));
    fireEvent.click(screen.getByText("Continue with Pro"));
    await waitFor(() => expect(onSubscribe).toHaveBeenCalledWith("pro", "annual"));
  });

  it("does not let a viewer change billing", () => {
    const data = {
      ...PAID_FIXTURE,
      workspace: { ...PAID_FIXTURE.workspace, viewer_role: "viewer" as const },
      billing: { ...PAID_FIXTURE.billing, can_manage: false },
    };
    render(<PlanCard data={data} onSubscribe={vi.fn()} />);
    expect((screen.getByText("Change plan") as HTMLButtonElement).disabled).toBe(true);
  });
});
