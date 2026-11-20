// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Reply = { status: number; body: unknown } | "offline";
const routes: Record<string, Reply> = {};
const calls: string[] = [];
const ws = vi.hoisted(() => ({ role: "owner" as string }));
const goto = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    const r = routes[key] ?? { status: 200, body: {} };
    if (r === "offline") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role }) }));
vi.mock("../../actions/channelPlanLock", () => ({ useChannelPlanLock: () => null, upgradeOnPlanRefusal: () => false }));
vi.mock("../emailSettingsNav", async (orig) => ({ ...(await orig<typeof import("../emailSettingsNav")>()), gotoEmailSettings: goto }));

import { forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";
import { IDEAS, NewCampaignDialog, newCampaignSession, PLANNED_SEND_RULE, withIdea, type CampaignSession } from "../NewCampaignDialog";

const LISTS = "GET /api/workspace/email-test-lists";
const TEMPLATE = "GET /api/workspace/email-template";
const list = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, people: 10, marked: false, ...over });
const routeOf = (lists: unknown[], route = "mailchimp") => ({ routes: [{ route, label: route, status: "complete", error: null, lists }], orphans: [] });

function Reopens({ session }: { session: CampaignSession }) {
  const [open, setOpen] = useState(true);
  return open ? <NewCampaignDialog slug="email_marketing" channelName="Email campaigns" session={session} onClose={() => setOpen(false)} /> : <button onClick={() => setOpen(true)}>reopen</button>;
}

const brief = () => screen.getByLabelText("What should this email do?") as HTMLTextAreaElement;

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  for (const k of Object.keys(routes)) delete routes[k];
  calls.length = 0;
  ws.role = "owner";
  goto.mockReset();
  forgetEmailTestLists();
  routes[LISTS] = { status: 200, body: routeOf([list("Members")]) };
  routes[TEMPLATE] = { status: 200, body: { template: { postal_address: "Cakely, 450 Valencia Street, San Francisco, CA 94103" } } };
  routes["GET /api/email-results"] = { status: 200, body: { emails: [] } };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("leaving for Settings keeps what the founder wrote", () => {
  it("Add it in Settings brings the brief, subject, preview and list back, once, and Cancel forgets them", async () => {
    routes[LISTS] = { status: 200, body: routeOf([list("Members"), list("Leads")]) };
    routes[TEMPLATE] = { status: 200, body: { postal_address: "" } };
    const session = newCampaignSession();
    render(<Reopens session={session} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Leads/ }));
    fireEvent.change(brief(), { target: { value: "Our spring sale starts Friday" } });
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: "Spring sale" } });
    fireEvent.change(screen.getByLabelText(/Preview text/), { target: { value: "20% off" } });
    fireEvent.click(await screen.findByRole("button", { name: "Add it in Settings" }));
    expect(goto).toHaveBeenCalledWith("footer");
    fireEvent.click(await screen.findByRole("button", { name: "reopen" }));
    expect(brief().value).toBe("Our spring sale starts Friday");
    expect((screen.getByLabelText(/Subject/) as HTMLInputElement).value).toBe("Spring sale");
    expect((screen.getByLabelText(/Preview text/) as HTMLInputElement).value).toBe("20% off");
    await waitFor(() => expect((screen.getByRole("radio", { name: /Leads/ }) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "reopen" }));
    expect(brief().value).toBe("");
  });

  it("a pasted email and its mode come back too", async () => {
    routes[TEMPLATE] = { status: 200, body: { postal_address: "" } };
    const session = newCampaignSession();
    render(<Reopens session={session} />);
    await screen.findByRole("radio", { name: /Members/ });
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: "My whole pasted email, every word of it" } });
    fireEvent.click(await screen.findByRole("button", { name: "Add it in Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "reopen" }));
    expect((screen.getByLabelText("Email body") as HTMLTextAreaElement).value).toBe("My whole pasted email, every word of it");
  });
});

describe("starter chips", () => {
  it("keep typed words, and swapping chips does not stack them", async () => {
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
    await screen.findByRole("radio", { name: /Members/ });
    fireEvent.change(brief(), { target: { value: "Happy Diwali" } });
    fireEvent.click(screen.getByRole("button", { name: IDEAS[0] }));
    expect(brief().value).toBe(`${IDEAS[0]}: Happy Diwali`);
    fireEvent.click(screen.getByRole("button", { name: IDEAS[2] }));
    expect(brief().value).toBe(`${IDEAS[2]}: Happy Diwali`);
    expect(withIdea(IDEAS[1], "")).toBe(`${IDEAS[1]}: `);
  });
});

describe("Zavi checks", () => {
  const marker = () => document.querySelector('[data-step="checks"] [data-testid="new-campaign-step-marker"]')!;
  const consentList = list("Imported", { needs_consent: true });

  it("is not marked done while the list still needs consent, even with every other check passing", async () => {
    routes[LISTS] = { status: 200, body: routeOf([consentList], "zavi_list") };
    routes["GET /api/workspace/sending-domain"] = { status: 200, body: { bulk_email_ready: true, domain: { status: "verified" } } };
    routes["GET /api/workspace/email-pause"] = { status: 200, body: { paused: false, held: null } };
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
    await screen.findByTestId("new-campaign-list-consent");
    fireEvent.change(brief(), { target: { value: "Spring sale" } });
    await waitFor(() => expect(marker().getAttribute("data-checking")).toBe("false"));
    expect(marker().getAttribute("data-done")).toBe("false");
    expect(screen.queryByTestId("new-campaign-checks-passed")).toBeNull();
  });

  it("shows one line when everything passes, none of the rows that can never fail, and a row again when one needs attention", async () => {
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
    fireEvent.change(brief(), { target: { value: "Spring sale" } });
    const checks = screen.getByTestId("new-campaign-checks");
    await within(checks).findByText("All checks passed");
    expect(checks.querySelectorAll("li")).toHaveLength(1);
    expect(checks.textContent).not.toMatch(/Unsubscribe|Zavi writes it|Test lists/);
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: "S".repeat(61) } });
    expect(within(checks).getByText("Subject under 60 characters")).toBeTruthy();
    expect(within(checks).queryByText("All checks passed")).toBeNull();
  });

  it("does not say all passed when past sends could not be checked", async () => {
    routes["GET /api/email-results"] = { status: 500, body: {} };
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
    expect(screen.queryByTestId("new-campaign-checks-passed")).toBeNull();
    await within(screen.getByTestId("new-campaign-checks")).findByText("Zavi could not check past sends just now");
    expect(screen.queryByTestId("new-campaign-checks-passed")).toBeNull();
  });
});

describe("the send rule beside the buttons", () => {
  it("matches Autopilot on Pick a time and the approval line otherwise, with the subtitle and brief line gone", async () => {
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
    await screen.findByRole("radio", { name: /Members/ });
    const hint = () => screen.getByTestId("action-modal-hint").textContent;
    expect(hint()).toContain("Nothing is sent until an owner or admin approves it.");
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    await waitFor(() => expect(hint()).toContain(PLANNED_SEND_RULE));
    expect(hint()).not.toContain("Nothing is sent until");
    expect(document.body.textContent).not.toMatch(/Pick who gets it|in your saved template\./);
    expect(brief().className).toContain("rounded-[8px]");
    expect(document.querySelector("[data-testid='new-campaign']")!.innerHTML).not.toMatch(/12\.5px|rounded-\[10px\]/);
  });
});

describe("a list read that failed", () => {
  it("re-reads by itself and clears the error without a press, keeping the alert up between tries", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    routes[LISTS] = "offline";
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} />);
    await screen.findByText(/Could not load your lists/);
    await act(async () => void vi.advanceTimersByTime(10_000));
    expect(screen.getByText(/Could not load your lists/)).toBeTruthy();
    routes[LISTS] = { status: 200, body: routeOf([list("Members")]) };
    await act(async () => void vi.advanceTimersByTime(10_000));
    await screen.findByRole("radio", { name: /Members/ });
    expect(screen.queryByText(/Could not load your lists/)).toBeNull();
  });
});
