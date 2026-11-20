// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ActionsEmpty, type ChannelRunInfo } from "./ChannelEmptyStates";
import { ChannelChatProvider, type ChannelChatPin } from "../actions/channelChat";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }) }),
    }),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => {},
  }),
}));

const RUN_A = "aaaaaaaa-1111-4111-8111-111111111111";
const RUN_B = "bbbbbbbb-2222-4222-8222-222222222222";
const ASK = "Before I write a creator brief, send me the bakery's site address, the town, and the claims a creator must never make.";
const FOUND_NOTHING = /found nothing/i;

const run: ChannelRunInfo = { slug: "ugc", name: "UGC Videos", switched: false, priorCount: 0, foldBelow: false, onRan: () => {} };

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void };
function deferred(): Deferred {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const channelsBody = (runId: string | null) => ({
  channels: [{ channel_slug: "ugc", run_reserve_credits: 160, last_run_id: runId, last_run_at: "2026-10-19T09:00:00Z" }],
});

let lastRunId: string | null = RUN_A;
let runReads: Record<string, () => Promise<unknown>> = {};
let opened: ChannelChatPin[] = [];

function route(url: string) {
  if (url === "/api/channels") return Promise.resolve(ok(channelsBody(lastRunId)));
  const m = url.match(/^\/api\/channels\/ugc\/top-actions\/runs\/(.+)$/);
  if (m && runReads[m[1]]) return runReads[m[1]]();
  return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: { code: "not_found" } }) });
}

function ui(lastRunAt = "2026-10-19T09:00:00Z") {
  return (
    <ChannelChatProvider open={(pin) => opened.push(pin)}>
      <ActionsEmpty workState="delivered" lastRunAt={lastRunAt} run={run} />
    </ChannelChatProvider>
  );
}

beforeEach(() => {
  opened = [];
  lastRunId = RUN_A;
  runReads = {};
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string) => route(url));
  window.localStorage.clear();
});
afterEach(cleanup);

describe("a finished run that filed no cards but asked for something", () => {
  it("shows the run's own question on the page with a way to answer, and never says it found nothing", async () => {
    runReads[RUN_A] = () => Promise.resolve(ok({ status: "success", actions: [], summary: ASK }));
    render(ui());
    expect(await screen.findByText(ASK)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(FOUND_NOTHING);
    expect(apiFetch).toHaveBeenCalledWith(`/api/channels/ugc/top-actions/runs/${RUN_A}`);
    fireEvent.click(screen.getByRole("button", { name: "Answer Zavi in chat" }));
    expect(opened).toEqual([{ target: "channel" }]);
    expect(screen.getByRole("button", { name: /Get suggestions/ })).toBeTruthy();
  });

  it("the run and chat buttons sit in the same card as the message, with no separate footer row", async () => {
    runReads[RUN_A] = () => Promise.resolve(ok({ status: "success", actions: [], summary: ASK }));
    render(ui());
    const text = await screen.findByTestId("empty-run-said-text");
    const card = screen.getByTestId("empty-run-said");
    expect(card.contains(text)).toBe(true);
    expect(card.contains(screen.getByTestId("run-channel"))).toBe(true);
    expect(card.contains(screen.getByRole("button", { name: "Answer Zavi in chat" }))).toBe(true);
    expect(screen.getByTestId("empty-run-said").querySelector(".border-t")).toBeNull();
  });

  it("a long message shows three lines with Show all, and a short one shows whole with no toggle", async () => {
    const LONG = `${ASK} `.repeat(4).trim();
    runReads[RUN_A] = () => Promise.resolve(ok({ status: "success", actions: [], summary: LONG }));
    const first = render(ui());
    const text = await screen.findByTestId("empty-run-said-text");
    expect(text.textContent).toBe(LONG);
    expect(text.className).toContain("line-clamp-3");
    const toggle = screen.getByRole("button", { name: "Show all" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(text.className).not.toContain("line-clamp-3");
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
    first.unmount();
    runReads[RUN_A] = () => Promise.resolve(ok({ status: "success", actions: [], summary: ASK }));
    render(ui());
    expect((await screen.findByTestId("empty-run-said-text")).className).not.toContain("line-clamp-3");
    expect(screen.queryByRole("button", { name: /Show all|Show less/ })).toBeNull();
  });

  it("Show all reveals the run's whole note, not the short summary the modal uses", async () => {
    const NOTE = `${ASK} I read 30 days: 0 impressions, 0 clicks, $0 spend, 0 conversions. The launch card from the last run is still waiting for your approval.`;
    const CUT = `${ASK} I read 30 days: 0 impressions, 0 clicks, $0 spend, 0\u2026`;
    runReads[RUN_A] = () => Promise.resolve(ok({ status: "success", actions: [], summary: CUT, note: NOTE }));
    render(ui());
    const text = await screen.findByTestId("empty-run-said-text");
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(text.textContent).toBe(NOTE);
    expect(text.textContent).not.toContain("\u2026");
    expect(text.textContent?.endsWith("still waiting for your approval.")).toBe(true);
  });

  it("a run read from an older backend with no note still shows its summary", async () => {
    runReads[RUN_A] = () => Promise.resolve(ok({ status: "success", actions: [], summary: ASK }));
    render(ui());
    expect((await screen.findByTestId("empty-run-said-text")).textContent).toBe(ASK);
  });

  it("a long run that ends with an ask shows the ask collapsed and the whole note only after Show all", async () => {
    const PREAMBLE = "I read the last 30 days of posts, the creator list, the brand notes and the three briefs already filed, and none of them name the bakery's town or its claims. ".repeat(3);
    const NOTE = `${PREAMBLE}${ASK}`;
    const SUMMARY = `\u2026${ASK}`;
    runReads[RUN_A] = () => Promise.resolve(ok({ status: "success", actions: [], summary: SUMMARY, note: NOTE }));
    render(ui());
    const text = await screen.findByTestId("empty-run-said-text");
    expect(text.textContent).toBe(SUMMARY);
    expect(text.textContent).not.toContain("I read the last 30 days");
    const toggle = screen.getByRole("button", { name: "Show all" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(text.textContent).toBe(NOTE);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(text.textContent).toBe(SUMMARY);
  });

  it("a note equal to the summary adds no toggle to a short message", async () => {
    runReads[RUN_A] = () => Promise.resolve(ok({ status: "success", actions: [], summary: ASK, note: ASK }));
    render(ui());
    expect((await screen.findByTestId("empty-run-said-text")).textContent).toBe(ASK);
    expect(screen.queryByRole("button", { name: /Show all|Show less/ })).toBeNull();
  });

  it("never paints 'found nothing' while the run's words are still on their way", async () => {
    const pending = deferred();
    runReads[RUN_A] = () => pending.promise;
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(document.body.textContent ?? ""));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    render(ui());
    seen.push(document.body.textContent ?? "");
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/api/channels/ugc/top-actions/runs/${RUN_A}`));
    expect(screen.getByTestId("empty-reading-run")).toBeTruthy();
    await act(async () => {
      pending.resolve(ok({ status: "success", actions: [], summary: ASK }));
    });
    expect(await screen.findByText(ASK)).toBeTruthy();
    observer.disconnect();
    expect(seen.some((t) => FOUND_NOTHING.test(t))).toBe(false);
  });

  it("when the run cannot be read, it keeps the page's usual copy and does not invent an ask", async () => {
    runReads[RUN_A] = () => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: { code: "run_unavailable" } }) });
    render(ui());
    expect(await screen.findByTestId("empty-delivered")).toBeTruthy();
    expect(screen.getByTestId("empty-run-said-text").textContent).toBe("Zavi can take another look and suggest what to do next.");
    expect(screen.queryByText(/It said:/)).toBeNull();
  });

  it("while the run is still being read, Run it again is already there", async () => {
    const slow = deferred();
    runReads[RUN_A] = () => slow.promise;
    render(ui());
    expect(await screen.findByTestId("empty-reading-run")).toBeTruthy();
    expect(screen.getByText("Get suggestions")).toBeTruthy();
  });

  it("shows the newest run's words when an older run's read lands last", async () => {
    const slowA = deferred();
    runReads[RUN_A] = () => slowA.promise;
    runReads[RUN_B] = () => Promise.resolve(ok({ status: "success", actions: [], summary: "Run B asks for the town." }));
    const r = render(ui("2026-10-19T09:00:00Z"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/api/channels/ugc/top-actions/runs/${RUN_A}`));
    lastRunId = RUN_B;
    r.rerender(ui("2026-10-19T10:00:00Z"));
    expect(await screen.findByText("Run B asks for the town.")).toBeTruthy();
    await act(async () => {
      slowA.resolve(ok({ status: "success", actions: [], summary: "Run A's stale words." }));
    });
    expect(screen.queryByText("Run A's stale words.")).toBeNull();
    expect(screen.getByText("Run B asks for the town.")).toBeTruthy();
  });
});

describe("what stays as it was", () => {
  it("does not claim nothing was found after the run filed cards", async () => {
    runReads[RUN_A] = () => Promise.resolve(ok({ status: "success", actions: [{ id: "x" }], summary: ASK }));
    render(ui());
    expect(await screen.findByTestId("empty-delivered")).toBeTruthy();
    expect(screen.queryByText(ASK)).toBeNull();
    expect(document.body.textContent).not.toMatch(FOUND_NOTHING);
    expect(screen.getByRole("button", { name: /Get suggestions/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Answer Zavi in chat" }));
    expect(opened).toEqual([{ target: "channel" }]);
  });

  it("a run that said nothing keeps the plain line", async () => {
    runReads[RUN_A] = () => Promise.resolve(ok({ status: "success", actions: [], summary: null }));
    render(ui());
    expect(await screen.findByTestId("empty-delivered")).toBeTruthy();
  });

  it("no known run id reads no run at all", async () => {
    lastRunId = null;
    render(ui());
    expect(await screen.findByTestId("empty-delivered")).toBeTruthy();
    expect(apiFetch.mock.calls.some((c) => String(c[0]).includes("/top-actions/runs/"))).toBe(false);
  });

  it("a filtered list keeps its own reason and reads no run", async () => {
    render(
      <ActionsEmpty workState="delivered" lastRunAt="2026-10-19T09:00:00Z" run={run} filteredReason="Outside your checklist." />,
    );
    expect(await screen.findByText("Outside your checklist.")).toBeTruthy();
    await act(async () => {});
    expect(apiFetch.mock.calls.some((c) => String(c[0]).includes("/top-actions/runs/"))).toBe(false);
  });
});
