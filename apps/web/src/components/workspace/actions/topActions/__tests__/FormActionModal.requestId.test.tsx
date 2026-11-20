// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/workspace/channelActionsApi";
import { toast } from "@/components/ui/toast";

const api = vi.hoisted(() => ({ start: vi.fn(), context: vi.fn(), fetch: vi.fn() }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  startTopAction: api.start,
  readTopActionContext: api.context,
}));
vi.mock("@/lib/api", () => ({ apiFetch: api.fetch }));

import { TopActionsRow } from "../TopActionsRow";
import { reddit_organic } from "../../platforms/reddit_organic";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.start.mockReset();
  api.context.mockReset().mockResolvedValue({ credits: 60 });
  api.fetch.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ids = () => api.start.mock.calls.map((c) => c[2] as string);

async function openDraftPost(community: string) {
  render(<TopActionsRow slug="reddit_organic" channelName="Reddit" actions={reddit_organic.topActions} onChanged={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Draft a post" }));
  fireEvent.change(screen.getByLabelText("Community"), { target: { value: community } });
}

async function press() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Draft the post" }));
    await vi.advanceTimersByTimeAsync(6000);
  });
}

describe("Draft a post once the run has started", () => {
  it("closes the dialog and says so in a toast, instead of leaving a done strip open", async () => {
    const shown = vi.spyOn(toast, "add");
    const onStarted = vi.fn();
    api.start.mockResolvedValue({ run_id: "run-1" });
    render(<TopActionsRow slug="reddit_organic" channelName="Reddit" actions={reddit_organic.topActions} onChanged={() => {}} onStarted={onStarted} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft a post" }));
    fireEvent.change(screen.getByLabelText("Community"), { target: { value: "r/smallbusiness" } });
    await press();

    expect(screen.queryByRole("dialog", { name: "Draft a post" })).toBeNull();
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: expect.stringMatching(/drafting your post/) }));
    shown.mockRestore();
  });
});

describe("Draft a post never starts a second paid run for one ask", () => {
  it("reuses the request id after 'still starting', so the server dedupes the retry", async () => {
    api.start.mockResolvedValue({ run_id: null });
    await openDraftPost("r/smallbusiness");
    await press();
    expect(screen.getByRole("alert").textContent).toMatch(/still starting/i);

    api.start.mockResolvedValue({ run_id: "run-1" });
    await press();

    expect(new Set(ids()).size).toBe(1);
  });

  it("reuses the request id after the connection drops mid-request", async () => {
    api.start.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue({ run_id: "run-1" });
    await openDraftPost("r/smallbusiness");
    await press();
    await press();

    expect(ids()).toHaveLength(2);
    expect(ids()[0]).toBe(ids()[1]);
  });

  it("takes a fresh id after a definite refusal, since no run exists for the old one", async () => {
    api.start.mockRejectedValueOnce(new ApiError("Check the form", 400)).mockResolvedValue({ run_id: "run-1" });
    await openDraftPost("r/smallbusiness");
    await press();
    await press();

    expect(ids()[0]).not.toBe(ids()[1]);
  });

  it("takes a fresh id when the founder changes the community before retrying", async () => {
    api.start.mockResolvedValueOnce({ run_id: null }).mockResolvedValueOnce({ run_id: null })
      .mockResolvedValueOnce({ run_id: null }).mockResolvedValueOnce({ run_id: null })
      .mockResolvedValue({ run_id: "run-2" });
    await openDraftPost("r/smallbusiness");
    await press();
    fireEvent.change(screen.getByLabelText("Community"), { target: { value: "r/startups" } });
    await press();

    const first = ids()[0];
    const last = ids().at(-1)!;
    expect(last).not.toBe(first);
    expect(api.start.mock.calls.at(-1)![3]).toMatchObject({ community: "r/startups" });
  });
});

describe("Draft a post when the workspace is out of credits", () => {
  it("shows the server's top-up sentence once, not a second Top up after it", async () => {
    const SERVER = "You're out of credits. Top up in Billing to keep your agents running.";
    api.start.mockRejectedValue(new ApiError(SERVER, 402, { error: { code: "insufficient_credits", message: SERVER, action: "top_up" } }));
    await openDraftPost("r/smallbusiness");
    await press();
    expect(screen.getByRole("alert").textContent!.trim()).toBe(SERVER);
    expect(screen.getByRole("dialog", { name: "Draft a post" }).textContent!.match(/top up/gi)).toHaveLength(1);
  });

  it("with no server sentence still says to top up, once", async () => {
    api.start.mockRejectedValue(new ApiError("", 402));
    await openDraftPost("r/smallbusiness");
    await press();
    expect(screen.getByRole("alert").textContent!.trim()).toBe("You are out of credits for this. Top up, then try again.");
    expect(screen.getByRole("dialog", { name: "Draft a post" }).textContent!.match(/top up/gi)).toHaveLength(1);
  });
});
