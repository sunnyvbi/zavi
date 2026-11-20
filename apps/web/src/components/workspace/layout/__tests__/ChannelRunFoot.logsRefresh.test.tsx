// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChannelRunFoot } from "../ChannelRunFoot";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/components/memory/RememberedPill", () => ({ RememberedPill: () => null }));

afterEach(cleanup);
beforeEach(() => apiFetch.mockReset());

const run = (id: string, at: string) => ({
  run_id: id,
  executor: "linkedin_ads",
  trigger: "manual",
  status: "success",
  enqueued_at: at,
  started_at: at,
  finished_at: at,
  redo_of_action_id: null,
});

const body = (runs: ReturnType<typeof run>[]) => ({ runs, closed: [], pre_switch: [] });
const reply = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
const historyCalls = () => apiFetch.mock.calls.filter(([url]) => String(url).includes("/history")).length;

describe("channel Logs follow the run state", () => {
  it("shows the newer run after the run state flips from running to finished, without remount", async () => {
    const older = run("run-old", "2026-10-28T10:01:00Z");
    const newer = run("run-new", "2026-10-28T10:16:00Z");
    let served = body([older]);
    apiFetch.mockImplementation(async () => reply(served));

    const { rerender } = render(<ChannelRunFoot slug="linkedin_ads" runKey={`idle|${older.finished_at}`} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Logs / }));
    expect(await screen.findAllByText(/Run started/)).toHaveLength(1);
    expect(document.body.textContent).toContain("Oct 28, 10:01");

    rerender(<ChannelRunFoot slug="linkedin_ads" runKey={`running|${older.finished_at}`} />);
    await waitFor(() => expect(historyCalls()).toBe(2));

    served = body([newer, older]);
    rerender(<ChannelRunFoot slug="linkedin_ads" runKey={`idle|${newer.finished_at}`} />);

    await waitFor(() => expect(screen.getAllByText(/Run started/)).toHaveLength(2));
    expect(document.body.textContent).toContain("10:16");
    expect(historyCalls()).toBe(3);
  });

  it("does not refetch when the run state is unchanged across rerenders", async () => {
    apiFetch.mockImplementation(async () => reply(body([run("run-old", "2026-10-28T10:01:00Z")])));
    const { rerender } = render(<ChannelRunFoot slug="linkedin_ads" runKey="idle|a" />);
    await screen.findByRole("button", { name: /^Logs / });
    rerender(<ChannelRunFoot slug="linkedin_ads" runKey="idle|a" />);
    rerender(<ChannelRunFoot slug="linkedin_ads" runKey="idle|a" />);
    expect(historyCalls()).toBe(1);
  });
});
