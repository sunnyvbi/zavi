import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
const who = vi.hoisted(() => ({ role: "owner" as string | null, tenantId: "t1" }));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ role: who.role, tenantId: who.tenantId }),
}));

import { ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";

const RAW = "This action requires one of: owner, admin. Your role: member.";
const respond = (ok: boolean, status: number, body: unknown) => Promise.resolve({ ok, status, json: async () => body });

let saved: Record<string, { item: string }[]> = {};
let refuseRole = false;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
  });
};

beforeEach(() => {
  who.role = "owner";
  who.tenantId = "t1";
  refuseRole = false;
  saved = { deal_value: [{ item: "5000" }] };
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      if (refuseRole) return respond(false, 403, { error: { code: "forbidden", message: RAW } });
      const id = String(path).split("/").pop()!;
      const items = (JSON.parse(String(init.body)) as { items: { item: string }[] }).items;
      saved = { ...saved, [id]: items };
      return respond(true, 200, { fields: { [id]: items } });
    }
    return respond(true, 200, { fields: saved });
  });
});
afterEach(() => cleanup());

const fields = PLATFORMS.linkedin_ads.settings ?? [];
const deal = () => screen.getByLabelText("What one new customer is worth in year one") as HTMLInputElement;
const puts = () => apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");

describe("Settings for a role that cannot save", () => {
  it("a member sees the values, cannot edit them, and gets no Save button that would fail", async () => {
    who.role = "member";
    render(<ChannelSettingsTab slug="linkedin_ads" fields={fields} />);
    await flush();
    expect(deal().value).toBe("5000");
    expect(deal().disabled).toBe(true);
    expect(screen.getByTestId("settings-view-only").textContent).toContain("Only a workspace owner or admin can change these settings.");
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it("when the server refuses the role, the founder reads plain words, never the server text, and keeps the edit", async () => {
    refuseRole = true;
    render(<ChannelSettingsTab slug="linkedin_ads" fields={fields} />);
    await flush();
    fireEvent.change(deal(), { target: { value: "12000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();
    expect(puts()).toHaveLength(1);
    expect(document.body.textContent).toContain("Only a workspace owner or admin can change these settings.");
    expect(document.body.textContent).not.toContain("requires one of");
    expect(document.body.textContent).not.toContain("Your role");
    expect(deal().value).toBe("12000");
  });
});

describe("an unsaved Settings edit survives leaving the tab", () => {
  it("keeps the typed deal value when Settings unmounts and mounts again, and Save sends it", async () => {
    const first = render(<ChannelSettingsTab slug="linkedin_ads" fields={fields} />);
    await flush();
    fireEvent.change(deal(), { target: { value: "12000" } });
    first.unmount();
    render(<ChannelSettingsTab slug="linkedin_ads" fields={fields} />);
    await flush();
    expect(deal().value).toBe("12000");
    expect(screen.getByText("You have unsaved changes.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();
    expect(saved.deal_value).toEqual([{ item: "12000" }]);
  });

  it("a saved edit is not brought back, and another company never sees the draft", async () => {
    const first = render(<ChannelSettingsTab slug="linkedin_ads" fields={fields} />);
    await flush();
    fireEvent.change(deal(), { target: { value: "777" } });
    first.unmount();
    who.tenantId = "t2";
    const second = render(<ChannelSettingsTab slug="linkedin_ads" fields={fields} />);
    await flush();
    expect(deal().value).toBe("5000");
    second.unmount();
    who.tenantId = "t1";
    render(<ChannelSettingsTab slug="linkedin_ads" fields={fields} />);
    await flush();
    expect(deal().value).toBe("777");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();
    cleanup();
    render(<ChannelSettingsTab slug="linkedin_ads" fields={fields} />);
    await flush();
    expect(deal().value).toBe("777");
    expect(screen.queryByText("You have unsaved changes.")).toBeNull();
  });

  it("warns before the page closes while an edit is unsaved", async () => {
    render(<ChannelSettingsTab slug="linkedin_ads" fields={fields} />);
    await flush();
    fireEvent.change(deal(), { target: { value: "12000" } });
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
