// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

let pauseCalls = 0;
let creditCalls = 0;
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string) => {
    if (url === "/api/workspace/email-pause") pauseCalls++;
    if (url === "/api/billing/credits") creditCalls++;
    const body = url === "/api/workspace/email-pause" ? { paused: false, held: null } : { effective_available_display: 5000, included_allowance: 150000, soft_warn: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  },
}));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ role: "owner" }),
  useWorkspace: () => ({ openTab: vi.fn(), role: "owner", creditsEnforced: true }),
}));
vi.mock("../../brain/useActiveTenant", () => ({ useActiveTenant: () => "tenant-1" }));

import { ChannelPageHeaderSlotProvider } from "../../layout/ChannelHeaderRow";
import { EmailSendingSwitch, forgetPaused } from "../EmailSendingSwitch";
import { LowCreditsWarning } from "../../LowCreditsWarning";

let visibility: DocumentVisibilityState = "visible";

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const fire = async (...events: Array<"focus" | "visibilitychange">) => {
  await act(async () => {
    for (const e of events) (e === "focus" ? window : document).dispatchEvent(new Event(e));
  });
  await flush();
};

beforeEach(() => {
  forgetPaused();
  pauseCalls = 0;
  creditCalls = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.innerHTML = "";
});

async function mountSwitch() {
  const badge = document.createElement("span");
  document.body.appendChild(badge);
  render(
    <ChannelPageHeaderSlotProvider element={null} badgeElement={badge}>
      <EmailSendingSwitch />
    </ChannelPageHeaderSlotProvider>,
  );
  await screen.findByRole("switch", { name: "Email sending" });
}

async function returnSequence(count: () => number) {
  const start = count();
  visibility = "hidden";
  await fire("visibilitychange");
  expect(count()).toBe(start);
  vi.setSystemTime(new Date("2026-10-29T10:05:00Z"));
  visibility = "visible";
  await fire("visibilitychange", "focus");
  expect(count()).toBe(start + 1);

  vi.setSystemTime(new Date("2026-10-29T10:05:00.400Z"));
  await fire("focus");
  expect(count()).toBe(start + 1);

  vi.setSystemTime(new Date("2026-10-29T10:05:01.500Z"));
  await fire("focus", "visibilitychange");
  expect(count()).toBe(start + 2);
}

describe("coming back to the tab sends one read, not two", () => {
  it("GET /api/workspace/email-pause", async () => {
    await mountSwitch();
    await returnSequence(() => pauseCalls);
  });

  it("GET /api/billing/credits", async () => {
    render(<LowCreditsWarning />);
    await flush();
    await returnSequence(() => creditCalls);
  });
});
