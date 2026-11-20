// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const routes: Record<string, Reply> = {};

vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    const r = routes[`${method} ${url}`] ?? (url.startsWith("/api/workspace/email-contacts?") ? routes["GET /api/workspace/email-contacts"] : undefined) ?? { status: 200, body: {} };
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner", tenantName: "Brightloop" }) }));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { EmailContactsSection } from "../EmailContactsSection";
import { MESSAGE_SHOWN_MS, useAutoDismissMessage } from "../useAutoDismissMessage";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const row = (id: string, name: string) => ({ id, name, archived_at: "2026-11-01T00:00:00Z", people: 5, members_hidden: false });
const ok = (body: unknown): Reply => ({ status: 200, body });

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(routes)) delete routes[k];
  routes["GET /api/workspace/email-lists"] = ok({ lists: [] });
  routes["GET /api/workspace/email-lists/archived"] = ok({ lists: [row(ID, "Spring leads"), row(ID2, "Old")] });
  routes["GET /api/workspace/email-contacts"] = ok({ rows: [], total: 0, counts: { contacts: 3, lists: 1, unsubscribed: 0, bounced: 0 }, masked: false });
  routes["GET /api/workspace/email-test-lists"] = ok({ routes: [], orphans: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function unarchive(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Unarchive ${name}` }));
  await flush();
  const confirm = screen.getByRole("alertdialog", { name: `Unarchive "${name}"?` });
  fireEvent.click(within(confirm).getByRole("button", { name: "Unarchive list" }));
  await flush();
}

async function mountAndOpen() {
  render(
    <>
      <ConfirmDialogHost />
      <EmailContactsSection />
    </>,
  );
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Archived lists" }));
  await flush();
}

describe("unarchive confirmation hides itself", () => {
  it("is visible after the action, still there at 2s, gone after the limit", async () => {
    routes["POST /api/workspace/email-lists/" + ID + "/unarchive"] = ok({ ok: true, unarchived: true, stopped_sends: 0 });
    await mountAndOpen();
    await unarchive("Spring leads");
    expect(screen.getByRole("status").textContent).toContain("Spring leads is back in Lists");
    await flush(2000);
    expect(screen.getByRole("status").textContent).toContain("Spring leads is back in Lists");
    await flush(MESSAGE_SHOWN_MS - 2000 + 10);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a second message mid-timer gets its own full time", async () => {
    routes["POST /api/workspace/email-lists/" + ID + "/unarchive"] = ok({ ok: true, unarchived: true, stopped_sends: 0 });
    routes["POST /api/workspace/email-lists/" + ID2 + "/unarchive"] = ok({ ok: true, unarchived: true, stopped_sends: 0 });
    await mountAndOpen();
    await unarchive("Spring leads");
    await flush(2000);
    await unarchive("Old");
    expect(screen.getByRole("status").textContent).toContain("Old is back in Lists");
    await flush(2000);
    expect(screen.getByRole("status").textContent).toContain("Old is back in Lists");
    await flush(MESSAGE_SHOWN_MS - 2000 + 10);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the X still closes it early", async () => {
    routes["POST /api/workspace/email-lists/" + ID + "/unarchive"] = ok({ ok: true, unarchived: true, stopped_sends: 0 });
    await mountAndOpen();
    await unarchive("Spring leads");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a message that tells the owner to act stays until closed", async () => {
    routes["POST /api/workspace/email-lists/" + ID + "/unarchive"] = ok({ ok: true, unarchived: true, stopped_sends: 2 });
    await mountAndOpen();
    await unarchive("Spring leads");
    await flush(MESSAGE_SHOWN_MS * 5);
    expect(screen.getByRole("status").textContent).toContain("approve a new email");
  });

  it("an error does not hide", async () => {
    routes["POST /api/workspace/email-lists/" + ID + "/unarchive"] = { status: 500, body: { error: "Could not unarchive." } };
    await mountAndOpen();
    await unarchive("Spring leads");
    await flush(MESSAGE_SHOWN_MS * 5);
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });
});

function Harness({ onApi }: { onApi: (api: ReturnType<typeof useAutoDismissMessage>) => void }) {
  const api = useAutoDismissMessage();
  onApi(api);
  return api.message ? <p role="status">{api.message}</p> : null;
}

describe("useAutoDismissMessage", () => {
  it("the same text shown again restarts the timer", async () => {
    let api!: ReturnType<typeof useAutoDismissMessage>;
    render(<Harness onApi={(a) => (api = a)} />);
    act(() => api.show("Saved."));
    await flush(2000);
    act(() => api.show("Saved."));
    await flush(2000);
    expect(screen.getByRole("status")).toBeTruthy();
    await flush(MESSAGE_SHOWN_MS - 2000 + 10);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("unmounting mid-timer clears the timer and does not throw", async () => {
    let api!: ReturnType<typeof useAutoDismissMessage>;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(<Harness onApi={(a) => (api = a)} />);
    act(() => api.show("Saved."));
    await flush(1000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await flush(MESSAGE_SHOWN_MS * 2);
    expect(err).not.toHaveBeenCalled();
  });
});
