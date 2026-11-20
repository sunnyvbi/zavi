import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-admin", () => ({ adminApiFetch: fetchMock }));
vi.mock("@/lib/channel-lock-preview", () => ({
  readLockPreview: vi.fn(async () => ({ running_runs: 2, schedules: 3, companies: 4 })),
}));

import AdminChannelsPage from "./page";

const row = (locked: boolean) => ({ slug: "linkedin_ads", name: "LinkedIn Ads", category: "ads", readiness: "ready", executor: "x", locked });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let savedLocked = false;
let lockReply: () => Promise<Response>;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
};

const listReads = () => fetchMock.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method).length;

beforeEach(() => {
  savedLocked = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") return lockReply();
    return json(200, { channels: [row(savedLocked)] });
  });
});
afterEach(() => cleanup());

async function pressLockAndConfirm() {
  render(<AdminChannelsPage />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Lock" }));
  await flush();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Lock LinkedIn Ads" }));
  await flush();
}

describe("admin Channels Lock when the lock request fails", () => {
  it("shows the failure inside the open dialog and reloads the table", async () => {
    lockReply = async () => json(504, { error: { message: "Gateway timeout" } });
    await pressLockAndConfirm();
    const dialog = screen.getByRole("dialog");
    const inDialog = within(dialog).getByTestId("lock-dialog-error");
    expect(inDialog.textContent).toContain("Lock did not go through: Gateway timeout.");
    expect(inDialog.textContent).toContain("still available");
    expect(listReads()).toBe(2);
  });

  it("when the lock was saved but the reply was lost, the reloaded table says so and the dialog closes", async () => {
    lockReply = async () => {
      savedLocked = true;
      throw new TypeError("Failed to fetch");
    };
    await pressLockAndConfirm();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("LinkedIn Ads is locked.");
    expect(screen.getByText("Locked")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(listReads()).toBe(2);
  });
});
