// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ ok: true, name: "Home Cleaning San Jose" as unknown, notified: 0 }));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: h.ok, status: h.ok ? 200 : 500, json: async () => ({ name: h.name }) })),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: () => { h.notified += 1; },
}));

import { apiFetch } from "@/lib/api";
import { SITE_RENAME_FAILED, SiteRename } from "./SiteRename";

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const ID = "33333333-3333-4333-8333-333333333333";
const input = () => screen.getByLabelText("Site name") as HTMLInputElement;

beforeEach(() => {
  fetchMock.mockClear();
  h.ok = true;
  h.name = "Home Cleaning San Jose";
  h.notified = 0;
});
afterEach(cleanup);

describe("SiteRename", () => {
  it("one tap opens the current name; saving posts it, tells the parent and refreshes the session list", async () => {
    const onRenamed = vi.fn();
    render(<SiteRename siteId={ID} name="Run Home Cleaning" onRenamed={onRenamed} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename site" }));
    expect(input().value).toBe("Run Home Cleaning");
    fireEvent.change(input(), { target: { value: "  Home Cleaning San Jose " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("Home Cleaning San Jose"));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe(`/api/workspace/autopilot/sites/${ID}/name`);
    expect(JSON.parse(init.body)).toEqual({ name: "Home Cleaning San Jose" });
    expect(h.notified).toBe(1);
    expect(screen.queryByLabelText("Site name")).toBeNull();
  });

  it("the same name or a blank one writes nothing", async () => {
    render(<SiteRename siteId={ID} name="Same" />);
    fireEvent.click(screen.getByRole("button", { name: "Rename site" }));
    fireEvent.change(input(), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input(), { target: { value: " Same " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByLabelText("Site name")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a failed save keeps what they typed, says so, and tells nobody it changed", async () => {
    h.ok = false;
    const onRenamed = vi.fn();
    render(<SiteRename siteId={ID} name="Old" onRenamed={onRenamed} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename site" }));
    fireEvent.change(input(), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(SITE_RENAME_FAILED);
    expect(input().value).toBe("New");
    expect(onRenamed).not.toHaveBeenCalled();
    expect(h.notified).toBe(0);
  });

  it("cancel throws the draft away, and reopening starts from the real name", () => {
    render(<SiteRename siteId={ID} name="Old" />);
    fireEvent.click(screen.getByRole("button", { name: "Rename site" }));
    fireEvent.change(input(), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename site" }));
    expect(input().value).toBe("Old");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
