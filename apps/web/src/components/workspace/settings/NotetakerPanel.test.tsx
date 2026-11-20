// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Call = { path: string; method: string; body: unknown };
const calls: Call[] = [];
let settings: Record<string, unknown> = {};
let recapReply: { status: number; body: unknown } = { status: 200, body: {} };
let meetings: unknown[] = [];
let notes: unknown = null;

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const reply = (status: number, body: unknown) =>
      Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    if (path === "/api/workspace/notetaker-settings" && method === "GET") return reply(200, settings);
    if (path === "/api/workspace/notetaker-recap") return reply(recapReply.status, recapReply.body);
    if (path === "/api/workspace/slack-channels") return reply(200, { slack_connected: true, channels: [{ id: "C1", name: "standups" }] });
    if (path === "/api/workspace/notetaker-meetings") return reply(200, { meetings });
    if (path.endsWith("/notes")) return reply(200, { notes });
    if (path.endsWith("/atoms")) return reply(200, { atoms: [] });
    if (path === "/api/workspace/notetaker-join") return reply(200, { ok: true, deduped: false });
    return reply(200, {});
  },
}));

import { NotetakerPanel } from "./NotetakerPanel";

const BASE = {
  enabled: true,
  meeting_url: "",
  days_of_week: [1, 2, 3, 4, 5],
  join_time: "09:30",
  timezone: "America/Los_Angeles",
  slack_channel_id: null,
  slack_channel_name: null,
};

beforeEach(() => {
  calls.length = 0;
  settings = { ...BASE, recap_destination: null };
  recapReply = { status: 200, body: { ok: true } };
  meetings = [];
  notes = null;
});
afterEach(cleanup);

const recapPuts = () => calls.filter((c) => c.path === "/api/workspace/notetaker-recap");
const joins = () => calls.filter((c) => c.path === "/api/workspace/notetaker-join");

describe("NotetakerPanel: where meeting summaries go", () => {
  it("before a choice: says nothing is posted or emailed, and the fake controls are gone", async () => {
    render(<NotetakerPanel />);
    await screen.findByText(/Nobody has chosen yet, so meeting summaries stay in Zavi/);
    expect(screen.queryByText("Redact personal data in transcripts")).toBeNull();
    expect(screen.queryByText("Delete transcripts after")).toBeNull();
    expect(screen.queryByText("Email the recap to")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Enable recap sharing" })).toBeNull();
    expect(screen.getByText(/keeps each meeting’s summary and transcript for 30 days, then deletes them/)).toBeDefined();
  });

  it("choosing a Slack channel by name saves it through the recap endpoint", async () => {
    recapReply = { status: 200, body: { ok: true, recap_destination: "slack", slack_channel_name: "standups" } };
    render(<NotetakerPanel />);
    const group = await screen.findByRole("radiogroup", { name: "Where meeting summaries go" });
    fireEvent.click(group.querySelector('input[value="slack"]') as HTMLInputElement);
    fireEvent.change(screen.getByLabelText("Slack channel name"), { target: { value: "#standups" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Meeting summaries post to #standups in Slack.");
    expect(recapPuts()).toEqual([
      { path: "/api/workspace/notetaker-recap", method: "PUT", body: { destination: "slack", slack_channel: "#standups" } },
    ]);
    expect(calls.some((c) => c.path === "/api/workspace/notetaker-settings" && c.method === "PUT")).toBe(false);
  });

  it("shows Slack's refusal as the server wrote it", async () => {
    recapReply = { status: 400, body: { error: { code: "channel_not_found", message: "Couldn't find #leads in your Slack. Check the spelling. If it's a private channel, invite @Zavi to #leads first, then try again." } } };
    render(<NotetakerPanel />);
    const group = await screen.findByRole("radiogroup", { name: "Where meeting summaries go" });
    fireEvent.click(group.querySelector('input[value="slack"]') as HTMLInputElement);
    fireEvent.change(screen.getByLabelText("Slack channel name"), { target: { value: "leads" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("invite @Zavi to #leads first");
  });

  it("Join now with no choice asks where the summary goes first, inline, then joins", async () => {
    recapReply = { status: 200, body: { ok: true, recap_destination: "off", slack_channel_name: null } };
    render(<NotetakerPanel />);
    await screen.findByText("Send Zavi to a call now");
    fireEvent.change(screen.getByPlaceholderText("https://meet.google.com/xxx-xxxx-xxx"), {
      target: { value: "https://meet.google.com/abc-defg-hij" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join now" }));
    const inline = await screen.findByRole("radiogroup", { name: "Before Zavi joins: where should the summary go?" });
    expect(joins()).toHaveLength(0);
    fireEvent.click(inline.querySelector('input[value="off"]') as HTMLInputElement);
    const saves = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saves[0]);
    await waitFor(() => expect(joins()).toHaveLength(1));
    expect(recapPuts()[0].body).toEqual({ destination: "off" });
    expect(joins()[0].body).toEqual({ meeting_url: "https://meet.google.com/abc-defg-hij" });
  });

  it("Join now with a choice made joins straight away", async () => {
    settings = { ...BASE, recap_destination: "email" };
    render(<NotetakerPanel />);
    await screen.findByText("Send Zavi to a call now");
    fireEvent.change(screen.getByPlaceholderText("https://meet.google.com/xxx-xxxx-xxx"), {
      target: { value: "https://meet.google.com/abc-defg-hij" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join now" }));
    await waitFor(() => expect(joins()).toHaveLength(1));
    expect(screen.queryByRole("radiogroup", { name: "Before Zavi joins: where should the summary go?" })).toBeNull();
  });

  it("a member sees where summaries go, read-only, and the channel list is never fetched", async () => {
    settings = { ...BASE, recap_destination: "slack", slack_channel_name: "standups" };
    render(<NotetakerPanel readOnly />);
    await screen.findByText("Meeting summaries post to #standups in Slack.");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(calls.some((c) => c.path === "/api/workspace/slack-channels")).toBe(false);
  });
});

describe("Recent captures: the summary and transcript Zavi keeps 30 days", () => {
  const capture = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "ingested",
    source: "scheduled",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    scheduled_for: "2026-10-27T16:30:00Z",
    atoms_count: 2,
    error: null,
    created_at: "2026-10-27T16:30:00Z",
  };

  it("opens a meeting's written summary and transcript, with when they are deleted", async () => {
    meetings = [capture];
    notes = {
      minutes: { tldr: "Pricing page ships Friday.", decisions: ["Ship Friday"], action_items: [{ text: "Review the page", owner: "Ben" }], topics: [], open_questions: [] },
      transcript: "Asha: We ship Friday.",
      created_at: "2026-10-27T17:00:00Z",
      delete_after: "2026-11-26T17:00:00Z",
    };
    render(<NotetakerPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "View" }));
    await screen.findByText("Pricing page ships Friday.");
    expect(screen.getByText("Ship Friday")).toBeDefined();
    expect(screen.getByText("Review the page (Ben)")).toBeDefined();
    expect(screen.getByText("Transcript")).toBeDefined();
    expect(screen.getByText("Asha: We ship Friday.")).toBeDefined();
    expect(screen.getByText(/Kept in Zavi until .*, then deleted\./)).toBeDefined();
    expect(calls.some((c) => c.path === `/api/workspace/notetaker-meetings/${capture.id}/notes`)).toBe(true);
  });

  it("past 30 days (or never saved) says so instead of showing anything", async () => {
    meetings = [capture];
    notes = null;
    render(<NotetakerPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "View" }));
    await screen.findByText(/No summary or transcript is saved for this meeting\. Zavi keeps them for 30 days/);
  });
});
