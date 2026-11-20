// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WebsitePreview, TEXT_EDITS_CLEAR_FAILED } from "./WebsitePreview";

const api = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; body: Record<string, unknown> | null }>,
  saved: [] as Array<{ id?: string; selector: string; patch: unknown; removed: boolean; updated_at?: string }>,
  discardOk: true,
  saveOk: true,
  saveResults: [] as boolean[],
  saveGates: [] as Array<Promise<void>>,
  serverText: new Map<string, string>(),
  saveGate: null as null | Promise<void>,
  hydrateGate: null as null | Promise<void>,
  saveVersion: 0,
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { body?: string }) => {
    api.calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.startsWith("/api/website/edits?")) return (api.hydrateGate ?? Promise.resolve()).then(() => ({ ok: true, json: async () => ({ edits: api.saved }) }));
    if (url === "/api/website/discard") return Promise.resolve({ ok: api.discardOk, json: async () => ({}) });
    if (url === "/api/website/edits") {
      const ok = api.saveResults.length > 0 ? api.saveResults.shift()! : api.saveOk;
      const gate = api.saveGates.length > 0 ? api.saveGates.shift()! : api.saveGate ?? Promise.resolve();
      const body = init?.body ? JSON.parse(init.body) : null;
      const version = ++api.saveVersion;
      return gate.then(() => {
        if (ok && body) api.serverText.set(body.selector, body.patch.text);
        return {
          ok,
          json: async () => ok && body
            ? { edit: { selector: body.selector, id: `edit:${body.selector}`, updated_at: `version-${version}`, text_only: true } }
            : {},
        };
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  },
}));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

beforeEach(() => {
  api.calls.length = 0;
  api.saved = [];
  api.discardOk = true;
  api.saveOk = true;
  api.saveResults = [];
  api.saveGates = [];
  api.serverText = new Map();
  api.saveGate = null;
  api.hydrateGate = null;
  api.saveVersion = 0;
});
afterEach(cleanup);

const APP_URL = "https://5173-sbx.e2b.app";
const APP_ID = "site:5f0c2a1e-1111-4222-8333-444455556666";
type Msg = { type?: string; enabled?: boolean; tool?: string };
type Send = { ok: true; direct?: true } | { ok: false; message: string };

function mount(opts: { protocol?: number; onSendEdits?: () => Promise<Send>; editsBusy?: boolean } = {}) {
  const onSendEdits = opts.onSendEdits ?? vi.fn(async (): Promise<Send> => ({ ok: true }));
  const props = { liveUrl: APP_URL, cacheKey: null, appId: APP_ID, builtApp: true, siteApp: true, editPlacement: "dock" as const };
  const view = render(<WebsitePreview {...props} onSendEdits={onSendEdits} editsBusy={opts.editsBusy ?? false} />);
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const posted: Msg[] = [];
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: (m: Msg) => posted.push(m) } });
  const send = (data: unknown, origin = APP_URL, source: unknown = frame.contentWindow) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
    });
  send({ type: "zavi:editor-ready", protocol: opts.protocol ?? 3 });
  const typed = async (selector: string, text: string, before = "Sun", origin = APP_URL) => {
    send({ type: "zavi:editor-text-edited", selector, text, before, protocol: 3 }, origin);
    await act(async () => {});
  };
  const rerender = (busy: boolean) => view.rerender(<WebsitePreview {...props} onSendEdits={onSendEdits} editsBusy={busy} />);
  return { posted, send, typed, onSendEdits, rerender, frame };
}

const tools = () => screen.getByRole("toolbar", { name: "Preview tools" });
const discards = () => api.calls.filter((c) => c.url === "/api/website/discard").map((c) => c.body);

describe("Clear on a page holding more than typed text", () => {
  it("keeps a new text edit made while Clear waits for the previous save", async () => {
    let releaseFirstSave: () => void = () => {};
    api.saveGates = [new Promise<void>((resolve) => (releaseFirstSave = resolve)), Promise.resolve()];
    const app = mount({ protocol: 4 });
    await app.typed("main > h1", "Spring", "Class timetable");
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    expect((within(tools()).getByRole("button", { name: /^Edit$/ }) as HTMLButtonElement).disabled).toBe(true);
    app.send({ type: "zavi:editor-text-edited", selector: "main > h1", text: "Autumn", before: "Class timetable", protocol: 3 });
    await act(async () => releaseFirstSave());
    await waitFor(() => expect(api.serverText.get("main > h1")).toBe("Autumn"));
    expect(api.calls.filter((call) => call.url === "/api/website/edits" || call.url === "/api/website/discard").map((call) => call.url)).toEqual([
      "/api/website/edits",
      "/api/website/discard",
      "/api/website/edits",
    ]);
    expect(within(tools()).getByText("1 text change")).toBeTruthy();
  });

  it("a saved colour change with its old text known is discarded and the page reloads, so the colour cannot linger on screen", async () => {
    api.saved = [{ id: "colour-edit", selector: "main > h1", patch: { style: { color: "#ff0000" }, before: { text: "Class timetable", style: {} } }, removed: false, updated_at: "colour-version" }];
    const app = mount({ protocol: 4 });
    await within(tools()).findByText("1 text change");
    const keyFrame = app.frame;
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBe(keyFrame));
    expect(app.posted.some((m) => m.type === "zavi:editor-text-revert")).toBe(false);
    expect(discards()).toEqual([{ app_id: APP_ID, selector: "main > h1", expected: { id: "colour-edit", updated_at: "colour-version" } }]);
  });

  it("a saved deletion with its old text known reloads the page on Clear instead of only putting text back", async () => {
    api.saved = [{ selector: "main > p", patch: { before: { text: "Open daily", style: {} } }, removed: true }];
    const app = mount({ protocol: 4 });
    await waitFor(() => expect(api.calls.some((c) => c.url.startsWith("/api/website/edits?"))).toBe(true));
    await act(async () => {});
    await app.typed("main > h1", "Spring", "Class timetable");
    const keyFrame = app.frame;
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBe(keyFrame));
    expect(app.posted.some((m) => m.type === "zavi:editor-text-revert")).toBe(false);
  });

  it("a text-only change typed this session is still put back in place without a reload", async () => {
    const app = mount({ protocol: 4 });
    await app.typed("main > h1", "Spring", "Class timetable");
    await within(tools()).findByText("1 text change");
    const keyFrame = app.frame;
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(within(tools()).queryByText(/text change/)).toBeNull());
    expect(app.posted.some((m) => m.type === "zavi:editor-text-revert")).toBe(true);
    expect(document.querySelector("iframe")).toBe(keyFrame);
  });

  it("a discard the server refuses during an in-place Clear reloads the page so it shows what the server still holds", async () => {
    const app = mount({ protocol: 4 });
    await app.typed("main > h1", "Spring", "Class timetable");
    await within(tools()).findByText("1 text change");
    api.discardOk = false;
    const keyFrame = app.frame;
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    await screen.findByText(TEXT_EDITS_CLEAR_FAILED);
    await waitFor(() => expect(document.querySelector("iframe")).not.toBe(keyFrame));
  });
});
