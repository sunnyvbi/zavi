// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn(() => "t"), update: vi.fn(), close: vi.fn() } }));

import { PublishPopover } from "./PublishPopover";
import type { LiveEditActionResult } from "@/lib/workspace/useLiveEdit";

const SHA = "c".repeat(40);
const order: string[] = [];

function json(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function wire(inlinePending: number) {
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/website/overview?app=workspace") return json({ visibility: "public" });
    if (url === "/api/website/builtin-url") {
      return json({
        builtin: { label: "acme", hostname: "acme.zaviagent.com", url: "https://acme.zaviagent.com", status: "live" },
        base_domain: "zaviagent.com",
      });
    }
    if (url.startsWith("/api/website/publish-status")) {
      return json({ pending: inlinePending, published: 0, last_published_at: null });
    }
    if (url === "/api/website/publish" && init?.method === "POST") {
      order.push("inline");
      return json({ published: inlinePending });
    }
    return json({});
  });
}

function draftProp(over: Partial<{ publish: () => Promise<LiveEditActionResult>; discard: () => Promise<LiveEditActionResult> }> = {}) {
  return {
    pending: 2,
    changes: [
      { sha: "2".repeat(40), message: "Make the hero darker" },
      { sha: "1".repeat(40), message: "Add a pricing table" },
    ],
    publish: vi.fn(async (): Promise<LiveEditActionResult> => {
      order.push("draft");
      return { ok: true, commit_sha: SHA };
    }),
    discard: vi.fn(async (): Promise<LiveEditActionResult> => ({ ok: true })),
    onPublished: vi.fn(),
    ...over,
  };
}

function mount(draft: ReturnType<typeof draftProp> | undefined) {
  return render(
    <PublishPopover
      appUrl="https://acme.zaviagent.com"
      appHost="acme.zaviagent.com"
      publishable
      onGetDomain={() => {}}
      onClose={() => {}}
      draft={draft}
    />,
  );
}

async function ready() {
  await waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
}

function inlinePosts() {
  return apiFetch.mock.calls.filter(([u, init]) => u === "/api/website/publish" && (init as RequestInit | undefined)?.method === "POST");
}

beforeEach(() => {
  apiFetch.mockReset();
  order.length = 0;
});
afterEach(cleanup);

describe("PublishPopover with live-edit draft changes", () => {
  it("draft changes alone make Publish available and publishing ships only the draft", async () => {
    wire(0);
    const draft = draftProp();
    mount(draft);
    await ready();
    expect(screen.getByText("2 unpublished changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish changes" }));
    expect(screen.getByText(/Publish 2 change/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(draft.onPublished).toHaveBeenCalledWith(SHA, 2));
    expect(draft.publish).toHaveBeenCalledTimes(1);
    expect(inlinePosts()).toHaveLength(0);
  });

  it("publishes the draft before inline edits and counts both", async () => {
    wire(1);
    const draft = draftProp();
    mount(draft);
    await ready();
    expect(screen.getByText("3 unpublished changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(order).toEqual(["draft", "inline"]));
  });

  it("a refused draft publish stops everything: no inline publish, no deploy watcher, the reason is shown", async () => {
    wire(1);
    const draft = draftProp({
      publish: vi.fn(async (): Promise<LiveEditActionResult> => ({
        ok: false,
        message: "Your live app changed since these edits were made. Discard the draft and make the change again.",
      })),
    });
    mount(draft);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Publish changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Your live app changed since these edits were made."),
    );
    expect(inlinePosts()).toHaveLength(0);
    expect(draft.onPublished).not.toHaveBeenCalled();
  });

  it("lists the draft changes and can discard them", async () => {
    wire(0);
    const draft = draftProp();
    mount(draft);
    await ready();
    fireEvent.click(screen.getByText("2 changes in preview"));
    expect(screen.getByText("Make the hero darker")).toBeTruthy();
    expect(screen.getByText("Add a pricing table")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Discard preview changes/ }));
    await waitFor(() => expect(draft.discard).toHaveBeenCalledTimes(1));
    expect(draft.publish).not.toHaveBeenCalled();
  });

  it("without a draft and nothing pending, the button reads Up to date and stays disabled", async () => {
    wire(0);
    mount(undefined);
    await ready();
    expect(screen.getByRole("button", { name: "Up to date" })).toHaveProperty("disabled", true);
    expect(screen.queryByTestId("draft-changes")).toBeNull();
  });
});
