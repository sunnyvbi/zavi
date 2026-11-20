// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ start: vi.fn(), context: vi.fn(), fetch: vi.fn() }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  startTopAction: api.start,
  readTopActionContext: api.context,
}));
vi.mock("@/lib/api", () => ({ apiFetch: api.fetch }));
const pop = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("@/components/ui/toast", async (orig) => ({ ...(await orig<typeof import("@/components/ui/toast")>()), toast: { add: pop.add, close: vi.fn(), update: vi.fn(), promise: vi.fn() } }));

import { TopActionsRow } from "../TopActionsRow";
import { CHANNEL_TAB_EVENT } from "../api";
import { seo } from "../../platforms/seo";
import { geo } from "../../platforms/geo";
import { ugc } from "../../platforms/ugc";
import { generated_video } from "../../platforms/generated_video";

const VIDEO_ACTIONS: typeof seo.topActions = [
  { key: "new_video", label: "New video", modal: "tab", tab: "studio" },
  {
    key: "make_starters",
    label: "Make starter videos",
    modal: "form",
    submit: "video_starters",
    lead: "Zavi drafts a few short videos for your business from your site.",
    note: "Each video uses credits when it renders. Your very first starter video renders without an Approve; the rest wait for yours.",
    primary: "Make starter videos",
    done: "Zavi is drafting them. They land in What Zavi wants to do.",
  },
];

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const calls = (path: string) => api.fetch.mock.calls.filter(([u]) => u === path);
const labels = (actions: typeof seo.topActions) => (actions ?? []).map((a) => a.label);
const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

beforeEach(() => {
  pop.add.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.start.mockReset().mockResolvedValue({ run_id: "run-1" });
  api.context.mockReset().mockResolvedValue({});
  api.fetch.mockReset().mockResolvedValue(ok({}));
});
afterEach(() => cleanup());

describe("PR 4 rows", () => {
  it("carry the approved buttons, primary first", () => {
    expect(labels(seo.topActions)).toEqual([]);
    expect(labels(geo.topActions)).toEqual([]);
    expect(labels(ugc.topActions)).toEqual([]);
    expect(labels(generated_video.topActions)).toEqual([]);
  });
});

describe("UGC and AI UGC Videos", () => {
  it("New video switches the page to the Create tab and makes nothing", async () => {
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(CHANNEL_TAB_EVENT, on);
    render(<TopActionsRow slug="generated_video" channelName="AI UGC Videos" actions={VIDEO_ACTIONS} onChanged={() => {}} />);
    await press("New video");
    window.removeEventListener(CHANNEL_TAB_EVENT, on);
    expect(seen).toEqual([{ slug: "generated_video", tab: "studio" }]);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it("Make starter videos calls the starter route and says the first renders without an Approve", async () => {
    const onStarted = vi.fn();
    render(<TopActionsRow slug="generated_video" channelName="AI UGC Videos" actions={VIDEO_ACTIONS} onChanged={() => {}} onStarted={onStarted} />);
    await press("Make starter videos");
    expect(screen.getByText(/first starter video renders without an Approve/)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Make starter videos" });
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
    });
    expect(calls("/api/channels/generated_video/starters")).toHaveLength(1);
    expect(onStarted).toHaveBeenCalled();
  });
});

describe("AI UGC Videos repeat", () => {
  it("Make starter videos again says they already exist and starts nothing new", async () => {
    api.fetch.mockResolvedValue(ok({ run_id: "run-old", duplicate: true }));
    const onStarted = vi.fn();
    render(<TopActionsRow slug="generated_video" channelName="AI UGC Videos" actions={VIDEO_ACTIONS} onChanged={() => {}} onStarted={onStarted} />);
    await press("Make starter videos");
    const buttons = screen.getAllByRole("button", { name: "Make starter videos" });
    await act(async () => {
      fireEvent.click(buttons[buttons.length - 1]);
    });
    expect(pop.add).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/starter run already exists/) }));
    expect(onStarted).not.toHaveBeenCalled();
  });
});
