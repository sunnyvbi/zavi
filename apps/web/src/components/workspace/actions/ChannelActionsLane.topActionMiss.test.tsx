// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";
import { announceChannelRunStarted, TOP_ACTION_AGAIN_EVENT } from "./topActions/api";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("../WorkspaceShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../WorkspaceShell")>()),
  useWorkspaceOptional: () => ({ role: ws.role, tabs: [], activeTabId: null }),
}));

const SLUG = "email_marketing";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const REASON = 'The campaign tool refused with "Bulk email is not set up yet", so the email to the newsletter list wasn\'t proposed. Once bulk sending is set up, press New campaign again.';

let body: Record<string, unknown> = {};
const actionReads = () => apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(`/api/channels/${SLUG}/actions`));

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount() {
  return render(
    <ChannelActionsLane slug={SLUG} legacy={<p>LEGACY RAIL</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>
      <li>an approvals row</li>
    </ChannelActionsLane>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
  apiFetch.mockReset();
  ws.role = "owner";
  window.sessionStorage.clear();
  window.localStorage.clear();
  body = { actions: [], more: 0, store: "channel_actions" };
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes(`/api/channels/${SLUG}/actions`)) return ok(body);
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    return ok({});
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a Write it run that filed no email", () => {
  it("says why on the page once the run ends, stops watching, and Try again asks for New campaign", async () => {
    mount();
    await flush();
    act(() => announceChannelRunStarted(SLUG));
    await flush();
    expect(screen.queryByTestId("top-action-miss")).toBeNull();
    body = {
      ...body,
      top_action_miss: { run_id: "1caaac04-0000-4000-8000-000000000000", key: "new_email", noun: "this email", reason: REASON, at: "2026-10-23T10:00:51Z" },
    };
    await flush(20_000);
    const miss = screen.getByTestId("top-action-miss");
    expect(miss.textContent).toContain(`Zavi didn't write this email: ${REASON}`);
    expect(miss.textContent).not.toMatch(/\.\.$/);
    const reads = actionReads().length;
    await flush(120_000);
    expect(actionReads()).toHaveLength(reads);
    const asked = vi.fn();
    window.addEventListener(TOP_ACTION_AGAIN_EVENT, asked as EventListener);
    fireEvent.click(screen.getByTestId("top-action-miss-again"));
    window.removeEventListener(TOP_ACTION_AGAIN_EVENT, asked as EventListener);
    expect(asked).toHaveBeenCalledTimes(1);
    expect((asked.mock.calls[0][0] as CustomEvent).detail).toEqual({ slug: SLUG, key: "new_email" });
  });

  it("ends the reason with a full stop when the run's sentence has none", async () => {
    body = { ...body, top_action_miss: { run_id: "r", key: "new_email", noun: "this email", reason: "The list has only two people", at: "2026-10-23T09:00:00Z" } };
    mount();
    await flush();
    expect(screen.getByTestId("top-action-miss").textContent).toContain("Zavi didn't write this email: The list has only two people.");
  });

  it("shows no reason when the run filed its card", async () => {
    body = { ...body, actions: [makeAction("check", { id: "ca-1", channel_slug: SLUG, title: "Spring sale email" })] };
    mount();
    await flush();
    act(() => announceChannelRunStarted(SLUG));
    await flush(20_000);
    expect(screen.queryAllByText("Spring sale email").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("top-action-miss")).toBeNull();
  });

  const MISS = { run_id: "run-miss", key: "new_email", noun: "this email", reason: "The list has only two people", at: "2026-10-23T09:00:00Z" };

  it("goes away once an email card filed after the miss is in the lane, and stays for a card filed before it", async () => {
    body = { ...body, top_action_miss: MISS, actions: [makeAction("check", { id: "old", channel_slug: SLUG, title: "Older email", email_card: true, proposed_at: "2026-10-23T08:00:00Z" })] };
    mount();
    await flush();
    expect(screen.getByTestId("top-action-miss")).toBeTruthy();
    cleanup();
    body = { ...body, top_action_miss: MISS, actions: [makeAction("check", { id: "pasted", channel_slug: SLUG, title: "Pasted email", email_card: true, proposed_at: "2026-10-23T09:30:00Z" })] };
    mount();
    await flush();
    expect(screen.queryByTestId("top-action-miss")).toBeNull();
  });

  it("a pasted email that is already sent and done still hides the miss", async () => {
    body = { ...body, top_action_miss: MISS, completed: [makeAction("check", { id: "sent", channel_slug: SLUG, title: "Sent email", email_card: true, status: "acted", proposed_at: "2026-10-23T09:30:00Z" })] };
    mount();
    await flush();
    expect(screen.queryByTestId("top-action-miss")).toBeNull();
  });

  it("the close button hides this miss on this browser, and a later miss shows again", async () => {
    body = { ...body, top_action_miss: MISS };
    mount();
    await flush();
    fireEvent.click(screen.getByTestId("top-action-miss-close"));
    expect(screen.queryByTestId("top-action-miss")).toBeNull();
    cleanup();
    mount();
    await flush();
    expect(screen.queryByTestId("top-action-miss")).toBeNull();
    cleanup();
    body = { ...body, top_action_miss: { ...MISS, run_id: "run-miss-2", at: "2026-10-23T09:40:00Z" } };
    mount();
    await flush();
    expect(screen.getByTestId("top-action-miss")).toBeTruthy();
  });

  it.each(["member", "viewer", null])("a %s sees why but gets no Try again, so nothing posts to an owner-only run", async (role) => {
    ws.role = role;
    body = { ...body, top_action_miss: MISS };
    mount();
    await flush();
    expect(screen.getByTestId("top-action-miss").textContent).toContain("The list has only two people.");
    expect(screen.queryByTestId("top-action-miss-again")).toBeNull();
  });

  it("an admin gets Try again", async () => {
    ws.role = "admin";
    body = { ...body, top_action_miss: MISS };
    mount();
    await flush();
    expect(screen.getByTestId("top-action-miss-again")).toBeTruthy();
  });
});

describe("a run refused because it repeats an earlier email", () => {
  const INPUTS = { route: "klaviyo", list_id: "VYfr94", brief: "Happy diwali" };
  const REPEAT = {
    run_id: "cada35f6-0000-4000-8000-000000000000",
    key: "new_email",
    noun: "this email",
    reason: "You already approved this same email, so Zavi did not file it again. Change the brief to write a new one. This attempt used 71 credits.",
    at: "2026-10-23T09:50:00Z",
    repeat: { title: "You already sent this email", detail: "Happy Diwali went to Zavi QA. Change the brief to write a different one.", credits: "This attempt used 71 credits.", inputs: INPUTS },
  };

  it("offers no retrying control: Change brief carries the earlier inputs, and nothing starts a run", async () => {
    body = { ...body, top_action_miss: REPEAT };
    mount();
    await flush();
    expect(screen.queryByTestId("top-action-miss-again")).toBeNull();
    expect(screen.getByTestId("top-action-miss-repeat").textContent).not.toContain("Try again");
    expect(screen.getByTestId("top-action-miss-repeat-title").textContent).toBe("You already sent this email");
    expect(screen.getByTestId("top-action-miss-repeat-detail").textContent).toBe("Happy Diwali went to Zavi QA. Change the brief to write a different one.");
    const notice = screen.getByTestId("top-action-miss-repeat");
    expect(notice.textContent).not.toMatch(/didn.t write|file|cada35f6/i);
    expect(notice.className).not.toMatch(/danger|red/);
    expect(notice.className).toContain("mb-6");
    expect(screen.getByTestId("top-action-miss-repeat-credits").className).toContain("text-ca-secondary");
    const asked = vi.fn();
    window.addEventListener(TOP_ACTION_AGAIN_EVENT, asked as EventListener);
    fireEvent.click(screen.getByTestId("top-action-miss-change"));
    window.removeEventListener(TOP_ACTION_AGAIN_EVENT, asked as EventListener);
    expect((asked.mock.calls[0][0] as CustomEvent).detail).toEqual({ slug: SLUG, key: "new_email", inputs: INPUTS });
    expect(apiFetch.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("no credits used means no credits line", async () => {
    body = { ...body, top_action_miss: { ...REPEAT, repeat: { ...REPEAT.repeat, credits: null } } };
    mount();
    await flush();
    expect(screen.queryByTestId("top-action-miss-repeat-credits")).toBeNull();
  });

  it("Cancel closes it for good, across a new tab's empty session", async () => {
    body = { ...body, top_action_miss: REPEAT };
    mount();
    await flush();
    fireEvent.click(screen.getByTestId("top-action-miss-cancel"));
    expect(screen.queryByTestId("top-action-miss-repeat")).toBeNull();
    cleanup();
    window.sessionStorage.clear();
    mount();
    await flush();
    expect(screen.queryByTestId("top-action-miss-repeat")).toBeNull();
  });

  it.each(["member", "viewer", null])("a %s can cancel but gets no Change brief", async (role) => {
    ws.role = role;
    body = { ...body, top_action_miss: REPEAT };
    mount();
    await flush();
    expect(screen.queryByTestId("top-action-miss-change")).toBeNull();
    expect(screen.getByTestId("top-action-miss-cancel")).toBeTruthy();
  });

  it("an unrelated failure keeps its own wording and Try again", async () => {
    body = { ...body, top_action_miss: { run_id: "run-other", key: "new_email", noun: "this email", reason: "That list has nobody on it.", at: "2026-10-23T09:50:00Z" } };
    mount();
    await flush();
    expect(screen.getByTestId("top-action-miss").textContent).toContain("Zavi didn't write this email: That list has nobody on it.");
    expect(screen.getByTestId("top-action-miss-again").textContent).toBe("Try again");
    expect(screen.queryByTestId("top-action-miss-change")).toBeNull();
  });
});
