// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ start: vi.fn(), run: vi.fn(), context: vi.fn(), fetch: vi.fn() }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  startTopAction: api.start,
  readTopActionRun: api.run,
  readTopActionContext: api.context,
}));
vi.mock("@/lib/api", () => ({ apiFetch: api.fetch }));

import { CreateAdModal } from "../CreateAdModal";
import { TopActionsRow } from "../TopActionsRow";
import { META_CREATE } from "./createAdSpecs";
import { reddit_organic } from "../../platforms/reddit_organic";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.start.mockReset().mockResolvedValue({ run_id: null });
  api.run.mockReset().mockResolvedValue({ status: "running", actions: [] });
  api.context.mockReset().mockResolvedValue({ currency: "INR", credits: 60 });
  api.fetch.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const calls = () => api.start.mock.calls.map((c) => c[2] as string);

async function press(name: string) {
  const before = api.start.mock.calls.length;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await vi.advanceTimersByTimeAsync(6000);
  });
  const mine = calls().slice(before);
  expect(new Set(mine).size).toBe(1);
  return mine[0];
}

async function stuckThenStarts(name: string) {
  const stuck: string[] = [];
  for (let i = 0; i < 4; i++) {
    stuck.push(await press(name));
    expect(screen.getByRole("alert").textContent).toMatch(/still starting/i);
  }
  api.start.mockResolvedValue({ run_id: "run-1" });
  const fresh = await press(name);
  return { stuck, fresh };
}

describe("a press that keeps coming back 'still starting' keeps its id, so a slow first start is never run twice", () => {
  it("Create new ad asks every press under one id", async () => {
    render(<CreateAdModal slug="meta_ads" channelName="Meta Ads" action={META_CREATE} onClose={() => {}} onChanged={() => {}} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("What is the ad about?"), { target: { value: "Halloween Teslas" } });
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://upcar.ai/halloween" } });
    fireEvent.click(screen.getByRole("radio", { name: /Buy or sign up/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Instagram only/ }));
    fireEvent.change(screen.getByLabelText("Daily budget"), { target: { value: "500" } });

    const { stuck, fresh } = await stuckThenStarts("Make a plan");

    expect(new Set(stuck).size).toBe(1);
    expect(fresh).toBe(stuck[0]);
    expect(api.start.mock.calls.at(-1)![3]).toEqual(api.start.mock.calls[0][3]);
  });

  it("Draft a post asks every press under one id", async () => {
    render(<TopActionsRow slug="reddit_organic" channelName="Reddit" actions={reddit_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft a post" }));
    fireEvent.change(screen.getByLabelText("Community"), { target: { value: "r/smallbusiness" } });

    const { stuck, fresh } = await stuckThenStarts("Draft the post");

    expect(new Set(stuck).size).toBe(1);
    expect(fresh).toBe(stuck[0]);
    expect(api.start.mock.calls.at(-1)![3]).toEqual(api.start.mock.calls[0][3]);
  });

  it("Draft a post counts again from zero after a press that starts", async () => {
    render(<TopActionsRow slug="reddit_organic" channelName="Reddit" actions={reddit_organic.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft a post" }));
    fireEvent.change(screen.getByLabelText("Community"), { target: { value: "r/smallbusiness" } });

    const a = await press("Draft the post");
    const b = await press("Draft the post");
    api.start.mockResolvedValueOnce({ run_id: "run-1" });
    const c = await press("Draft the post");
    expect(new Set([a, b, c]).size).toBe(1);
  });
});
