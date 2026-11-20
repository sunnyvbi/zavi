// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
const openStatic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("../shared", () => ({ CGO_LABEL: "Your CGO", useOpenStatic: () => openStatic }));

import { AdSpendSection } from "./AdSpendSection";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const bad = (status: number, body: unknown = {}) => ({ ok: false, status, json: async () => body });
type Opts = { budget?: unknown; autopilot?: boolean; autorun?: boolean; budgetOk?: boolean; write?: unknown };
const serve = ({ budget = null, autopilot = false, autorun = false, budgetOk = true, write = ok({ ok: true }) }: Opts) =>
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return write;
    if (url === "/api/workspace/ad-budget") return budgetOk ? ok({ budget }) : bad(500);
    return ok({ head_of_growth: { autopilot }, channels: [{ slug: "x_ads", autorun }, { slug: "seo", autorun: true }] });
  });
const radio = (name: string) => screen.findByRole("radio", { name: new RegExp(name) }) as Promise<HTMLInputElement>;
const posts = () => apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  openStatic.mockReset();
});

describe("AdSpendSection", () => {
  it("shows ask first with Autopilot off and locks go ahead", async () => {
    serve({ autorun: true });
    render(<AdSpendSection slug="x_ads" canEdit />);
    expect((await radio("Ask me first")).checked).toBe(true);
    expect((await radio("Go ahead")).disabled).toBe(true);
    expect(screen.getByText("No ad budget yet")).toBeTruthy();
  });

  it("shows go ahead and the daily limit when Autopilot may run this channel", async () => {
    serve({ budget: { status: "active", daily_limit_usd: 50 }, autopilot: true, autorun: true });
    render(<AdSpendSection slug="x_ads" canEdit />);
    expect((await radio("Go ahead")).checked).toBe(true);
    expect(screen.getByText("$50")).toBeTruthy();
  });

  it("shows go ahead for a channel with no stored switch while Autopilot is on", async () => {
    serve({ autopilot: true });
    render(<AdSpendSection slug="reddit_ads" canEdit />);
    expect((await radio("Go ahead")).checked).toBe(true);
    expect((await radio("Ask me first")).checked).toBe(false);
  });

  it("reads this channel's switch, not another channel's", async () => {
    serve({ autopilot: true, autorun: false });
    render(<AdSpendSection slug="x_ads" canEdit />);
    expect((await radio("Ask me first")).checked).toBe(true);
  });

  it("saves ask first for this channel only", async () => {
    serve({ autopilot: true, autorun: true });
    render(<AdSpendSection slug="x_ads" canEdit />);
    fireEvent.click(await radio("Ask me first"));
    await waitFor(async () => expect((await radio("Ask me first")).checked).toBe(true));
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe("/api/workspace/growth/channels/x_ads/autorun");
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toEqual({ autorun: false });
  });

  it("saves go ahead when Autopilot is on", async () => {
    serve({ autopilot: true, autorun: false });
    render(<AdSpendSection slug="x_ads" canEdit />);
    fireEvent.click(await radio("Go ahead"));
    await waitFor(async () => expect((await radio("Go ahead")).checked).toBe(true));
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toEqual({ autorun: true });
  });

  it("keeps the old choice and says why when the save is refused", async () => {
    serve({ autopilot: true, autorun: false, write: bad(403, { error: { message: "X Ads is on the Pro plan." } }) });
    render(<AdSpendSection slug="x_ads" canEdit />);
    fireEvent.click(await radio("Go ahead"));
    expect((await screen.findByRole("alert")).textContent).toBe("X Ads is on the Pro plan.");
    expect((await radio("Ask me first")).checked).toBe(true);
  });

  it("locks both choices for a member", async () => {
    serve({ autopilot: true, autorun: true });
    render(<AdSpendSection slug="x_ads" canEdit={false} />);
    expect((await radio("Ask me first")).disabled).toBe(true);
    expect((await radio("Go ahead")).disabled).toBe(true);
  });

  it("shows no choice at all when a read fails", async () => {
    serve({ autopilot: true, budgetOk: false });
    render(<AdSpendSection slug="x_ads" canEdit />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("opens Your CGO for the budget and Autopilot", async () => {
    serve({});
    render(<AdSpendSection slug="x_ads" canEdit />);
    fireEvent.click(await screen.findByRole("button", { name: "Change in Your CGO" }));
    expect(openStatic).toHaveBeenCalledWith("autopilot");
    expect(posts()).toHaveLength(0);
  });
});
