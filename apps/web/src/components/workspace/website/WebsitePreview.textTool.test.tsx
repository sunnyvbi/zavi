// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WebsitePreview, TEXT_EDITS_SAVED, STALE_RUNTIME_RELOADS, STALE_RUNTIME_RELOAD_MS, TEXT_EDITS_CLEAR_FAILED, TEXT_EDIT_NOT_SAVED, textChangeLabel } from "./WebsitePreview";
import { siteEditsSendOutcome, SITE_EDITS_NOTHING_APPLIED } from "@/lib/workspace/siteInlineEdits";

const api = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; body: Record<string, unknown> | null }>,
  saved: [] as Array<{ id?: string; selector: string; patch: unknown; removed: boolean; updated_at?: string; published_at?: string | null; published_patch?: unknown }>,
  discardOk: true,
  saveOk: true,
  saveResults: [] as boolean[],
  saveGates: [] as Array<Promise<void>>,
  serverText: new Map<string, string>(),
  saveGate: null as null | Promise<void>,
  hydrateGate: null as null | Promise<void>,
  hydrateVersions: true,
  saveTextOnly: true,
  saveVersion: 0,
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { body?: string }) => {
    api.calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.startsWith("/api/website/edits?")) return (api.hydrateGate ?? Promise.resolve()).then(() => ({
      ok: true,
      json: async () => ({
        edits: api.saved.map((edit, index) => api.hydrateVersions
          ? { id: `hydrated-${index}`, updated_at: `hydrated-version-${index}`, ...edit }
          : edit),
      }),
    }));
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
            ? { edit: { selector: body.selector, id: `edit:${body.selector}`, updated_at: `version-${version}`, text_only: api.saveTextOnly } }
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
  api.hydrateVersions = true;
  api.saveTextOnly = true;
  api.saveVersion = 0;
});
afterEach(cleanup);

const APP_URL = "https://5173-sbx.e2b.app";
const APP_ID = "site:5f0c2a1e-1111-4222-8333-444455556666";
type Msg = { type?: string; enabled?: boolean; tool?: string };
type Send = { ok: true; direct?: true; applied?: number; appliedSelectors?: string[] } | { ok: false; message: string };

function mount(opts: {
  protocol?: number;
  onSendEdits?: (count: number, edits?: ReadonlyArray<{ selector: string; text?: string; id?: string; updated_at?: string }>) => Promise<Send>;
  editsBusy?: boolean;
} = {}) {
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
const saves = () => api.calls.filter((c) => c.url === "/api/website/edits");

describe("the T text tool in the preview pill", () => {
  it("sends an Enter-submitted text change after its draft finishes saving", async () => {
    let release: () => void = () => {};
    api.saveGate = new Promise<void>((resolve) => (release = resolve));
    const app = mount({ protocol: 5 });
    app.send({ type: "zavi:editor-text-edited", selector: "main > h1", text: "Ride today", before: "Grab a bike", protocol: 5 });
    app.send({ type: "zavi:editor-text-submit", protocol: 5 });
    expect(app.onSendEdits).not.toHaveBeenCalled();
    await act(async () => release());
    await waitFor(() => expect(app.onSendEdits).toHaveBeenCalledTimes(1));
  });

  it("when the page reloads inside the frame (a change landing), text mode is switched back on in the new page and saved edits are replayed", async () => {
    api.saved = [{ selector: "main > p", patch: { text: "Saved earlier" }, removed: false }];
    const app = mount();
    await within(tools()).findByText("1 text change");
    fireEvent.click(within(tools()).getByRole("button", { name: "Edit text" }));
    expect(app.posted.at(-1)).toEqual({ type: "zavi:editor-mode", enabled: true, tool: "text" });
    app.posted.length = 0;
    app.send({ type: "zavi:editor-ready", protocol: 3 });
    await waitFor(() => expect(app.posted).toContainEqual({ type: "zavi:editor-mode", enabled: true, tool: "text" }));
    await waitFor(() => expect(app.posted.some((m) => (m as { type?: string }).type === "zavi:editor-apply")).toBe(true));
    expect(within(tools()).getByRole("button", { name: "Stop editing text" })).toBeTruthy();
  });

  it("a queued Send never absorbs a newer edit made before the clicked snapshot can be versioned", async () => {
    let release: () => void = () => {};
    api.saveGate = new Promise<void>((r) => (release = r));
    const app = mount();
    fireEvent.click(within(tools()).getByRole("button", { name: "Edit text" }));
    app.send({ type: "zavi:editor-text-edited", selector: "main > h1", text: "This week", before: "Sun", protocol: 3 });
    expect(within(tools()).getByText("1 text change")).toBeTruthy();
    const send = within(tools()).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    expect(send.className).toContain("bg-[#fff]");
    expect(send.className).toContain("text-[#0e0f11]");
    expect(send.className).not.toContain("bg-[#3d6fe5]");
    expect(send.className).toContain("hover:brightness-95");
    expect(send.className).not.toContain("hover:bg-[#f0f0f0]");
    expect(within(tools()).queryByRole("button", { name: "Saving..." })).toBeNull();
    fireEvent.click(send);
    expect(app.onSendEdits).not.toHaveBeenCalled();
    const queued = within(tools()).getByRole("button", { name: "Sending..." }) as HTMLButtonElement;
    expect(queued.disabled).toBe(true);
    fireEvent.click(queued);
    app.send({ type: "zavi:editor-text-edited", selector: "main > h1", text: "This week!", before: "This week", protocol: 3 });
    expect(app.onSendEdits).not.toHaveBeenCalled();
    await act(async () => release());
    await waitFor(() => expect(within(tools()).getByText("1 text change")).toBeTruthy());
    expect(app.onSendEdits).not.toHaveBeenCalled();
    expect(saves().length).toBeGreaterThanOrEqual(2);
  });

  it("a change the server refuses to save is never counted or sent, and the founder is told", async () => {
    api.saveOk = false;
    const app = mount();
    await app.typed("main > h1", "This week");
    await screen.findByText(TEXT_EDIT_NOT_SAVED);
    expect(within(tools()).queryByText(/text change/)).toBeNull();
    expect(within(tools()).queryByRole("button", { name: "Send" })).toBeNull();
    expect(app.onSendEdits).not.toHaveBeenCalled();
  });

  it("a later edit to the same text that fails to save blocks Send, so the older saved text is never sent as if it were the new one", async () => {
    api.saveResults = [true, false];
    const app = mount();
    await app.typed("main > h1", "First");
    await app.typed("main > h1", "Second", "First");
    await screen.findByText(TEXT_EDIT_NOT_SAVED);
    const sendButton = within(tools()).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    expect(sendButton.className).toContain("disabled:!text-[#0e0f11]");
    fireEvent.click(sendButton);
    expect(app.onSendEdits).not.toHaveBeenCalled();
    await app.typed("main > h1", "Second", "First");
    await waitFor(() => expect((within(tools()).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(app.onSendEdits).toHaveBeenCalledTimes(1));
  });

  it("an older save answering after a newer one does not decide the text's state", async () => {
    let releaseFirst: () => void = () => {};
    const first = new Promise<void>((r) => (releaseFirst = r));
    api.saveResults = [false, true];
    api.saveGate = first;
    const app = mount();
    app.send({ type: "zavi:editor-text-edited", selector: "main > h1", text: "First", before: "Sun", protocol: 3 });
    api.saveGate = null;
    await app.typed("main > h1", "Second", "First");
    await act(async () => releaseFirst());
    await within(tools()).findByText("1 text change");
    expect(screen.queryByText(TEXT_EDIT_NOT_SAVED)).toBeNull();
    expect((within(tools()).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Clear pressed while a save is still in flight discards only after that save lands, so a cleared change cannot come back", async () => {
    const app = mount({ protocol: 4 });
    await app.typed("main > p", "Saved first");
    let release: () => void = () => {};
    api.saveGate = new Promise<void>((r) => (release = r));
    await app.typed("main > h1", "Still saving");
    const clear = within(tools()).getByRole("button", { name: "Clear" }) as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    await act(async () => {});
    expect(api.calls.filter((c) => c.url === "/api/website/discard")).toEqual([]);
    await act(async () => release());
    await waitFor(() =>
      expect(api.calls.filter((c) => c.url === "/api/website/discard").map((c) => c.body?.selector).sort()).toEqual(["main > h1", "main > p"]),
    );
    expect(within(tools()).queryByText(/text change/)).toBeNull();
  });

  it("Clear cancels a queued Send, so a later edit is never sent without another click", async () => {
    let release: () => void = () => {};
    api.saveGate = new Promise<void>((resolve) => (release = resolve));
    const app = mount({ protocol: 4 });
    app.send({ type: "zavi:editor-text-edited", selector: "main > h1", text: "Queued", before: "Original", protocol: 4 });
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    expect(within(tools()).getByRole("button", { name: "Sending..." })).toBeTruthy();
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    await act(async () => release());
    await waitFor(() => expect(within(tools()).queryByText(/text change/)).toBeNull());
    await app.typed("main > h1", "Later", "Original");
    await within(tools()).findByText("1 text change");
    expect(app.onSendEdits).not.toHaveBeenCalled();
  });

  it("Clear puts the typed text back inside the page without reloading it, to the text from before the first change", async () => {
    const app = mount({ protocol: 4 });
    const keyFrame = app.frame;
    const srcBefore = app.frame.getAttribute("src");
    await app.typed("main > h1", "Spring", "Class timetable");
    await app.typed("main > h1", "Spring timetable", "Spring");
    await app.typed("main > p", "Seven days", "Open daily");
    await within(tools()).findByText("2 text changes");
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(within(tools()).queryByText(/text change/)).toBeNull());
    expect(app.posted).toContainEqual({
      type: "zavi:editor-text-revert",
      edits: expect.arrayContaining([
        { selector: "main > h1", text: "Class timetable" },
        { selector: "main > p", text: "Open daily" },
      ]),
    });
    expect(api.calls.filter((c) => c.url === "/api/website/discard").map((c) => c.body?.selector).sort()).toEqual(["main > h1", "main > p"]);
    expect(document.querySelector("iframe")).toBe(keyFrame);
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(srcBefore);
  });

  it("Clear still reloads when the page holds a change whose old text this session never saw", async () => {
    api.saved = [{ selector: "main > p", patch: { text: "B" }, removed: false }];
    const app = mount({ protocol: 4 });
    await within(tools()).findByText("1 text change");
    await app.typed("main > h1", "Spring", "Class timetable");
    const keyFrame = app.frame;
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBe(keyFrame));
    expect(app.posted.some((m) => m.type === "zavi:editor-text-revert")).toBe(false);
  });

  it("two quick edits to the same text reach the server in order, so the newest text is what gets saved and sent", async () => {
    let releaseFirst: () => void = () => {};
    api.saveGates = [new Promise<void>((r) => (releaseFirst = r)), Promise.resolve()];
    const app = mount();
    app.send({ type: "zavi:editor-text-edited", selector: "main > h1", text: "First", before: "Sun", protocol: 3 });
    await app.typed("main > h1", "Second", "First");
    expect(api.calls.filter((c) => c.url === "/api/website/edits").length).toBe(1);
    await act(async () => releaseFirst());
    await within(tools()).findByText("1 text change");
    await waitFor(() => expect(api.calls.filter((c) => c.url === "/api/website/edits").length).toBe(2));
    expect(api.serverText.get("main > h1")).toBe("Second");
  });

  it("a send that applied nothing keeps the changes instead of reporting success", () => {
    expect(siteEditsSendOutcome({ ok: true, applied: 0, appliedSelectors: [], remaining: 0, conductorRunId: null, direct: false, rowsDirect: 0, rowsFallback: 0 })).toEqual({ ok: false, message: SITE_EDITS_NOTHING_APPLIED });
    expect(siteEditsSendOutcome({ ok: true, applied: 2, appliedSelectors: ["a", "b"], remaining: 0, conductorRunId: "r", direct: false, rowsDirect: 0, rowsFallback: 0 })).toEqual({ ok: true, applied: 2, appliedSelectors: ["a", "b"] });
    expect(siteEditsSendOutcome({ ok: false, status: 402, code: "credits", message: "Out of credits." })).toEqual({ ok: false, message: "Out of credits." });
  });

  it("a change typed before the saved changes finish loading is still counted", async () => {
    api.saved = [{ selector: "main > p", patch: { text: "B" }, removed: false }];
    const app = mount();
    await app.typed("main > h1", "This week");
    await within(tools()).findByText("2 text changes");
    await act(async () => {});
    expect(within(tools()).getByText("2 text changes")).toBeTruthy();
  });

  it("turns on text editing in the page and off again", async () => {
    const app = mount();
    fireEvent.click(within(tools()).getByRole("button", { name: "Edit text" }));
    expect(app.posted.at(-1)).toEqual({ type: "zavi:editor-mode", enabled: true, tool: "text" });
    fireEvent.click(within(tools()).getByRole("button", { name: "Stop editing text" }));
    expect(app.posted.at(-1)).toEqual({ type: "zavi:editor-mode", enabled: false });
  });

  it("an older page helper in a site preview reloads the frame on its own, at most three times, so the text tool appears without the founder reloading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const app = mount({ protocol: 2 });
      const frames = [app.frame];
      for (let i = 0; i < STALE_RUNTIME_RELOADS + 2; i++) {
        await act(async () => {
          vi.advanceTimersByTime(STALE_RUNTIME_RELOAD_MS);
        });
        const now = document.querySelector("iframe") as HTMLIFrameElement;
        if (now !== frames.at(-1)) {
          frames.push(now);
          Object.defineProperty(now, "contentWindow", { configurable: true, value: { postMessage: () => {} } });
          act(() => {
            window.dispatchEvent(new MessageEvent("message", { data: { type: "zavi:editor-ready", protocol: 2 }, origin: APP_URL, source: now.contentWindow as Window }));
          });
        }
      }
      expect(frames).toHaveLength(1 + STALE_RUNTIME_RELOADS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a current page helper never triggers a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const app = mount({ protocol: 3 });
      await act(async () => {
        vi.advanceTimersByTime(STALE_RUNTIME_RELOAD_MS * 2);
      });
      expect(document.querySelector("iframe")).toBe(app.frame);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not offered by an older page helper, or where nothing can send the change", () => {
    mount({ protocol: 2 });
    expect(within(tools()).queryByRole("button", { name: "Edit text" })).toBeNull();
    cleanup();
    render(<WebsitePreview liveUrl={APP_URL} cacheKey={null} appId={APP_ID} builtApp editPlacement="dock" />);
    fireEvent.load(document.querySelector("iframe")!);
    expect(within(tools()).queryByRole("button", { name: "Edit text" })).toBeNull();
  });

  it("saves each typed change once and counts changed elements, not keystrokes", async () => {
    const app = mount();
    fireEvent.click(within(tools()).getByRole("button", { name: "Edit text" }));
    await app.typed("div > button:nth-of-type(7)", "sunday");
    await app.typed("div > button:nth-of-type(7)", "Sunday");
    await app.typed("main > h1", "This week");
    expect(saves().map((c) => c.body)).toEqual([
      { app_id: APP_ID, selector: "div > button:nth-of-type(7)", patch: { text: "sunday" }, before: { text: "Sun" } },
      { app_id: APP_ID, selector: "div > button:nth-of-type(7)", patch: { text: "Sunday" }, before: { text: "Sun" } },
      { app_id: APP_ID, selector: "main > h1", patch: { text: "This week" }, before: { text: "Sun" } },
    ]);
    expect(within(tools()).getByText(textChangeLabel(2))).toBeTruthy();
    expect(textChangeLabel(1)).toBe("1 text change");
  });

  it("ignores a text change from another origin or another window, and an unsafe selector", async () => {
    const app = mount();
    await app.typed("main > h1", "Hacked", "Sun", "https://evil.example");
    app.send({ type: "zavi:editor-text-edited", selector: "main > h1", text: "x", before: "y" }, APP_URL, window);
    await app.typed("<img onerror=1>", "x");
    expect(saves()).toEqual([]);
    expect(within(tools()).queryByText(/text change/)).toBeNull();
  });

  it("Send hands every saved change to the chat once and resets the pill", async () => {
    const app = mount();
    await app.typed("main > h1", "This week");
    await act(async () => {});
    expect(within(tools()).getByText("1 text change")).toBeTruthy();
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(within(tools()).queryByText(/text change/)).toBeNull());
    expect(app.onSendEdits).toHaveBeenCalledTimes(1);
  });

  it("never sends an unversioned hydrated batch as every saved edit", async () => {
    api.hydrateVersions = false;
    api.saved = [{ selector: "main > h1", patch: { text: "No version" }, removed: false }];
    const app = mount();
    await within(tools()).findByText("1 text change");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await screen.findByText(TEXT_EDIT_NOT_SAVED);
    expect(app.onSendEdits).not.toHaveBeenCalled();
  });

  it("does not let a queued text Send absorb a saved row that also contains an unsubmitted style edit", async () => {
    let release: () => void = () => {};
    api.saveGate = new Promise<void>((resolve) => (release = resolve));
    api.saveTextOnly = false;
    const app = mount({ protocol: 5 });
    app.send({ type: "zavi:editor-text-edited", selector: "main > h1", text: "New", before: "Old", protocol: 3 });
    app.send({ type: "zavi:editor-text-submit", protocol: 5 });
    await act(async () => release());
    await waitFor(() => expect(within(tools()).getByText("1 text change")).toBeTruthy());
    expect(app.onSendEdits).not.toHaveBeenCalled();
  });

  it("a delayed hydration response cannot replace a newer saved-version snapshot", async () => {
    let release: () => void = () => {};
    api.hydrateGate = new Promise<void>((resolve) => (release = resolve));
    api.saved = [{ id: "old-id", updated_at: "old-version", selector: "main > h1", patch: { text: "Old" }, removed: false }];
    const app = mount();
    await app.typed("main > h1", "New", "Old");
    await act(async () => release());
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(app.onSendEdits).toHaveBeenCalledTimes(1));
    expect(app.onSendEdits).toHaveBeenCalledWith(1, [
      { selector: "main > h1", text: "New", id: "edit:main > h1", updated_at: "version-1" },
    ]);
  });

  it("while a sent change runs, a preview reload that re-reads the saved edits does not count the sent one again", async () => {
    const first = mount();
    await first.typed("main > h1", "Sent text");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(first.onSendEdits).toHaveBeenCalledTimes(1));
    first.rerender(true);
    cleanup();

    api.saved = [{ selector: "main > h1", patch: { text: "Sent text" }, removed: false }];
    const reloaded = mount({ editsBusy: true });
    await act(async () => {});
    expect(within(tools()).queryByText(/text change/)).toBeNull();
    await reloaded.typed("main > p", "New text");
    await within(tools()).findByText("1 text change");
    await reloaded.typed("main > p", "New text again", "New text");
    expect(within(tools()).getByText("1 text change")).toBeTruthy();
  });

  it("editing the sent text again while its change runs counts it as a new change", async () => {
    const first = mount();
    await first.typed("main > h1", "Sent text");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(first.onSendEdits).toHaveBeenCalledTimes(1));
    first.rerender(true);
    cleanup();

    api.saved = [{ selector: "main > h1", patch: { text: "Sent text" }, removed: false }];
    const reloaded = mount({ editsBusy: true });
    await act(async () => {});
    await reloaded.typed("main > h1", "Changed again", "Sent text");
    await within(tools()).findByText("1 text change");
  });

  it("once the change has finished, a saved edit it did not apply is counted again on the next load", async () => {
    const first = mount();
    await first.typed("main > h1", "Sent text");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(first.onSendEdits).toHaveBeenCalledTimes(1));
    first.rerender(true);
    first.rerender(false);
    cleanup();

    api.saved = [
      { selector: "main > h1", patch: { text: "Sent text" }, removed: false },
      { selector: "main > p", patch: { text: "Other" }, removed: false },
    ];
    mount();
    await within(tools()).findByText("2 text changes");
  });

  it("Send confirms at once while the server is still answering, and a direct apply keeps the plain confirmation", async () => {
    let finish: (v: Send) => void = () => undefined;
    const app = mount({ onSendEdits: vi.fn(() => new Promise<Send>((r) => (finish = r))) });
    await app.typed("main > h1", "This week");
    await app.typed("main > p", "Daily classes", "Classes");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    expect(app.onSendEdits).toHaveBeenCalledWith(2, [
      { selector: "main > h1", text: "This week", id: "edit:main > h1", updated_at: "version-1" },
      { selector: "main > p", text: "Daily classes", id: "edit:main > p", updated_at: "version-2" },
    ]);
    expect(within(tools()).getByRole("status").textContent).toContain(TEXT_EDITS_SAVED);
    expect(within(tools()).queryByText(/Sending/)).toBeNull();
    expect(within(tools()).queryByText(/text change/)).toBeNull();
    expect(within(tools()).getByRole("button", { name: "Edit text" })).toBeTruthy();
    await act(async () => finish({ ok: true, direct: true }));
    expect(within(tools()).getByText(TEXT_EDITS_SAVED)).toBeTruthy();
  });

  it("a second Send stays disabled until the first request answers, so it cannot absorb later text", async () => {
    const finishes: Array<(v: Send) => void> = [];
    const app = mount({ onSendEdits: vi.fn(() => new Promise<Send>((r) => finishes.push(r))) });
    await app.typed("main > h1", "This week");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await app.typed("main > p", "Daily classes", "Classes");
    const again = within(tools()).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    expect(app.onSendEdits).toHaveBeenCalledTimes(1);
    await act(async () => finishes[0]({ ok: true, direct: true }));
    await waitFor(() => expect((within(tools()).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(app.onSendEdits).toHaveBeenCalledTimes(2));
    expect(app.onSendEdits).toHaveBeenLastCalledWith(1, [
      { selector: "main > p", text: "Daily classes", id: "edit:main > p", updated_at: "version-2" },
    ]);
    await act(async () => finishes[1]({ ok: true, direct: true }));
    expect(within(tools()).queryByText(/text change/)).toBeNull();
  });

  it("when the first Send fails, a Send queued behind it is dropped and every change waits in the pill with the reason", async () => {
    const finishes: Array<(v: Send) => void> = [];
    const app = mount({ onSendEdits: vi.fn(() => new Promise<Send>((r) => finishes.push(r))) });
    await app.typed("main > h1", "This week");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await app.typed("main > p", "Daily classes", "Classes");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await act(async () => finishes[0]({ ok: false, message: "You're out of credits." }));
    await screen.findByText("You're out of credits.");
    await act(async () => {});
    expect(app.onSendEdits).toHaveBeenCalledTimes(1);
    expect(within(tools()).getByText("2 text changes")).toBeTruthy();
    expect((within(tools()).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a queued batch is not sent when one clicked snapshot is superseded before saving", async () => {
    let release: () => void = () => {};
    const app = mount({ onSendEdits: vi.fn(async (): Promise<Send> => ({ ok: true, applied: 1, appliedSelectors: ["main > h1"] })) });
    await app.typed("main > h1", "First", "Original first");
    api.saveGate = new Promise<void>((resolve) => (release = resolve));
    app.send({ type: "zavi:editor-text-edited", selector: "main > p", text: "Queued", before: "Original second", protocol: 3 });
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    app.send({ type: "zavi:editor-text-edited", selector: "main > p", text: "Newer", before: "Queued", protocol: 3 });
    await act(async () => release());
    await waitFor(() => expect(within(tools()).getByText("2 text changes")).toBeTruthy());
    expect(app.onSendEdits).not.toHaveBeenCalled();
  });

  it("a Send that went to an AI edit shows no direct confirmation", async () => {
    const app = mount();
    await app.typed("main > h1", "This week");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(app.onSendEdits).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(within(tools()).queryByText(TEXT_EDITS_SAVED)).toBeNull();
  });

  it("a failed Send keeps the changes and says why", async () => {
    const app = mount({ onSendEdits: vi.fn(async (): Promise<Send> => ({ ok: false, message: "You're out of credits." })) });
    await app.typed("main > h1", "This week");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await screen.findByText("You're out of credits.");
    expect(within(tools()).getByText("1 text change")).toBeTruthy();
    expect(saves()).toHaveLength(1);
  });

  it("Send waits while a change is already running, then works", async () => {
    const app = mount({ editsBusy: true });
    await app.typed("main > h1", "This week");
    const sendButton = within(tools()).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    fireEvent.click(sendButton);
    expect(app.onSendEdits).not.toHaveBeenCalled();
    app.rerender(false);
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(app.onSendEdits).toHaveBeenCalledTimes(1));
  });

  it("Send clears the pill the moment it is pressed and shows no sending state while the server answers", async () => {
    let finish: (v: Send) => void = () => {};
    const app = mount({ onSendEdits: vi.fn(() => new Promise<Send>((r) => (finish = r))) });
    await app.typed("main > h1", "This week");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    expect(within(tools()).queryByText(/text change/)).toBeNull();
    expect(within(tools()).queryByRole("button", { name: "Send" })).toBeNull();
    expect(within(tools()).queryByText(/Sending/)).toBeNull();
    await act(async () => finish({ ok: true }));
    expect(within(tools()).queryByText(TEXT_EDITS_SAVED)).toBeNull();
    expect(within(tools()).queryByText(/text change/)).toBeNull();
  });

  it("a Send the server refuses brings every change back to the pill, with the reason", async () => {
    let finish: (v: Send) => void = () => {};
    const app = mount({ onSendEdits: vi.fn(() => new Promise<Send>((r) => (finish = r))) });
    await app.typed("main > h1", "This week");
    await app.typed("main > p", "Daily classes", "Classes");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    expect(within(tools()).queryByText(/text change/)).toBeNull();
    expect(within(tools()).getByText(TEXT_EDITS_SAVED)).toBeTruthy();
    await act(async () => finish({ ok: false, message: "You're out of credits." }));
    await screen.findByText("You're out of credits.");
    expect(within(tools()).getByText("2 text changes")).toBeTruthy();
    expect(within(tools()).queryByText(TEXT_EDITS_SAVED)).toBeNull();
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(app.onSendEdits).toHaveBeenCalledTimes(2));
  });

  it("a double click on Send sends once", async () => {
    let finish: (v: Send) => void = () => {};
    const app = mount({ onSendEdits: vi.fn(() => new Promise<Send>((r) => (finish = r))) });
    await app.typed("main > h1", "This week");
    const sendButton = within(tools()).getByRole("button", { name: "Send" });
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);
    await act(async () => finish({ ok: true }));
    expect(app.onSendEdits).toHaveBeenCalledTimes(1);
  });

  it("changes saved earlier are counted when the page loads, and Clear discards each and reloads the page", async () => {
    api.saved = [
      { selector: "main > h1", patch: { text: "A" }, removed: false },
      { selector: "main > p", patch: { text: "B" }, removed: false },
    ];
    const app = mount();
    await within(tools()).findByText("2 text changes");
    const srcBefore = app.frame.getAttribute("src");
    const keyFrame = app.frame;
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(within(tools()).queryByText(/text change/)).toBeNull());
    expect(api.calls.filter((c) => c.url === "/api/website/discard").map((c) => c.body)).toEqual([
      { app_id: APP_ID, selector: "main > h1", expected: { id: "hydrated-0", updated_at: "hydrated-version-0" } },
      { app_id: APP_ID, selector: "main > p", expected: { id: "hydrated-1", updated_at: "hydrated-version-1" } },
    ]);
    expect(document.querySelector("iframe")).not.toBe(keyFrame);
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(srcBefore);
  });

  it("after a reload, saved changes on a page helper without the text tool leave Annotate in the pill", async () => {
    api.saved = [{ selector: "main > h1", patch: { text: "A" }, removed: false }];
    const app = mount({ protocol: 2 });
    await waitFor(() => expect(api.calls.some((c) => c.url.startsWith("/api/website/edits?"))).toBe(true));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
    const reloaded = document.querySelector("iframe") as HTMLIFrameElement;
    expect(reloaded).not.toBe(app.frame);
    Object.defineProperty(reloaded, "contentWindow", { configurable: true, value: { postMessage: () => {} } });
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "zavi:editor-ready", protocol: 2 }, origin: APP_URL, source: reloaded.contentWindow as Window }));
    });
    await waitFor(() => expect(api.calls.filter((c) => c.url.startsWith("/api/website/edits?"))).toHaveLength(2));
    await act(async () => {});
    expect(within(tools()).queryByText(/text change/)).toBeNull();
    fireEvent.click(within(tools()).getByRole("button", { name: "Annotate" }));
    expect(within(tools()).queryByRole("button", { name: "Annotate" })).toBeNull();
  });

  it("saved text changes the pill can send still take Annotate's place until they are sent or cleared", async () => {
    api.saved = [{ selector: "main > h1", patch: { text: "A" }, removed: false }];
    mount();
    await within(tools()).findByText("1 text change");
    expect(within(tools()).queryByRole("button", { name: "Annotate" })).toBeNull();
  });

  it("a Clear the server refuses says so", async () => {
    api.discardOk = false;
    const app = mount();
    await app.typed("main > h1", "This week");
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    await screen.findByText(TEXT_EDITS_CLEAR_FAILED);
  });

  it("picking the normal edit tool turns the text tool off", () => {
    const app = mount();
    fireEvent.click(within(tools()).getByRole("button", { name: "Edit text" }));
    fireEvent.click(within(tools()).getByRole("button", { name: /^Edit$/ }));
    expect(app.posted.at(-1)).toEqual({ type: "zavi:editor-mode", enabled: true });
  });

  it("a draft taken back by the page is discarded on the server and leaves nothing to send", async () => {
    const app = mount({ protocol: 4 });
    await app.typed("main > h1", "Summer timetable", "Class timetable");
    await within(tools()).findByText("1 text change");
    await app.typed("main > h1", "Class timetable", "Summer timetable");
    await waitFor(() => expect(within(tools()).queryByText(/text change/)).toBeNull());
    expect(api.calls.filter((c) => c.url === "/api/website/discard").map((c) => c.body)).toEqual([{
      app_id: APP_ID,
      selector: "main > h1",
      only: "text",
      expected: { id: "edit:main > h1", updated_at: "version-1" },
    }]);
    expect(saves().map((c) => (c.body?.patch as { text: string }).text)).toEqual(["Summer timetable"]);
    expect(within(tools()).queryByRole("button", { name: "Send" })).toBeNull();
    await app.typed("main > h1", "Autumn timetable", "Class timetable");
    await within(tools()).findByText("1 text change");
    expect(saves().map((c) => (c.body?.patch as { text: string }).text)).toEqual(["Summer timetable", "Autumn timetable"]);
  });

  it("taking back a draft over a change saved earlier keeps that change: no discard, still pending to send", async () => {
    api.saved = [{ selector: "main > h1", patch: { text: "B" }, removed: false }];
    const app = mount({ protocol: 4 });
    await within(tools()).findByText("1 text change");
    await app.typed("main > h1", "C", "B");
    await app.typed("main > h1", "B", "C");
    await waitFor(() => expect(saves().map((c) => (c.body?.patch as { text: string }).text)).toEqual(["C", "B"]));
    expect(api.calls.filter((c) => c.url === "/api/website/discard")).toEqual([]);
    expect(api.serverText.get("main > h1")).toBe("B");
    await within(tools()).findByText("1 text change");
  });

  it("a change saved earlier with its old text known is discarded only when typed back to that old text", async () => {
    api.saved = [{ selector: "main > h1", patch: { text: "B", before: { text: "A" } } as never, removed: false }];
    const app = mount({ protocol: 4 });
    await within(tools()).findByText("1 text change");
    await app.typed("main > h1", "C", "B");
    await app.typed("main > h1", "B", "C");
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(api.calls.filter((c) => c.url === "/api/website/discard")).toEqual([]);
    await app.typed("main > h1", "A", "B");
    await waitFor(() => expect(api.calls.filter((c) => c.url === "/api/website/discard")).toHaveLength(1));
    await waitFor(() => expect(within(tools()).queryByText(/text change/)).toBeNull());
  });

  it("typing the source text over a published override saves that reversion instead of restoring the published text", async () => {
    api.saved = [{
      id: "edit-published",
      selector: "main > h1",
      patch: { text: "Published override", before: { text: "Source text" } } as never,
      removed: false,
      updated_at: "2026-10-08T10:00:00.000Z",
      published_at: "2026-10-08T10:01:00.000Z",
      published_patch: { text: "Published override" },
    }];
    const app = mount({ protocol: 4 });
    await within(tools()).findByText("1 text change");
    await app.typed("main > h1", "Source text", "Published override");
    await waitFor(() => expect(saves().map((c) => (c.body?.patch as { text: string }).text)).toEqual(["Source text"]));
    expect(api.calls.filter((c) => c.url === "/api/website/discard")).toEqual([]);
    expect(api.serverText.get("main > h1")).toBe("Source text");
    expect(within(tools()).getByText("1 text change")).toBeTruthy();
  });

  it("Clear reloads after restoring a published text override, so stale source text is never shown", async () => {
    api.saved = [{
      id: "edit-published",
      selector: "main > h1",
      patch: { text: "Draft override", before: { text: "Source text" } } as never,
      removed: false,
      updated_at: "2026-10-08T10:00:00.000Z",
      published_at: "2026-10-08T10:01:00.000Z",
      published_patch: { text: "Published override" },
    }];
    const app = mount({ protocol: 4 });
    await within(tools()).findByText("1 text change");
    const frameBefore = app.frame;
    fireEvent.click(within(tools()).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBe(frameBefore));
    expect(app.posted.some((message) => message.type === "zavi:editor-text-revert")).toBe(false);
    expect(api.calls.filter((call) => call.url === "/api/website/discard").map((call) => call.body)).toEqual([{
      app_id: APP_ID,
      selector: "main > h1",
      expected: { id: "edit-published", updated_at: "2026-10-08T10:00:00.000Z" },
    }]);
  });

  it("a published style-only edit still lets source-copy take-back discard the text draft", async () => {
    api.saved = [{
      id: "edit-style-only",
      selector: "main > h1",
      patch: { style: { color: "red" }, before: { text: "Source text" } } as never,
      removed: false,
      updated_at: "2026-10-08T10:00:00.000Z",
      published_at: "2026-10-08T10:01:00.000Z",
      published_patch: { style: { color: "red" } },
    }];
    const app = mount({ protocol: 4 });
    await within(tools()).findByText("1 text change");
    await app.typed("main > h1", "Draft text", "Source text");
    await app.typed("main > h1", "Source text", "Draft text");
    await waitFor(() => expect(api.calls.filter((call) => call.url === "/api/website/discard")).toHaveLength(1));
  });

  it("a failed Send keeps the old text, so a later take-back is still a clean discard", async () => {
    const app = mount({ protocol: 4, onSendEdits: vi.fn(async (): Promise<Send> => ({ ok: false, message: "Nope" })) });
    await app.typed("main > h1", "B", "A");
    await within(tools()).findByText("1 text change");
    await act(async () => {
      fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    });
    await within(tools()).findByText("1 text change");
    await app.typed("main > h1", "A", "B");
    await waitFor(() => expect(api.calls.filter((c) => c.url === "/api/website/discard")).toHaveLength(1));
  });

  it("a failed Send preserves the earliest source text across an edit made while Send is in flight", async () => {
    let finish: (result: Send) => void = () => {};
    const app = mount({ protocol: 4, onSendEdits: vi.fn(() => new Promise<Send>((resolve) => (finish = resolve))) });
    await app.typed("main > h1", "B", "A");
    fireEvent.click(within(tools()).getByRole("button", { name: "Send" }));
    await app.typed("main > h1", "C", "B");
    await act(async () => finish({ ok: false, message: "Nope" }));
    await screen.findByText("Nope");
    await app.typed("main > h1", "A", "C");
    await waitFor(() => expect(api.calls.filter((c) => c.url === "/api/website/discard")).toHaveLength(1));
  });

  it("an edit made before the saved changes finish loading cannot turn a later take-back into a discard", async () => {
    let release: () => void = () => {};
    api.hydrateGate = new Promise<void>((r) => (release = r));
    api.saved = [{ selector: "main > h1", patch: { text: "B" }, removed: false }];
    const app = mount({ protocol: 4 });
    await app.typed("main > h1", "C", "B");
    await act(async () => release());
    await waitFor(() => expect(api.calls.filter((c) => c.url.startsWith("/api/website/edits?"))).toHaveLength(1));
    await act(async () => {});
    await app.typed("main > h1", "B", "C");
    await waitFor(() => expect(saves().map((c) => (c.body?.patch as { text: string }).text)).toEqual(["C", "B"]));
    expect(api.calls.filter((c) => c.url === "/api/website/discard")).toEqual([]);
    expect(api.serverText.get("main > h1")).toBe("B");
  });

  it("an early edit is corrected to the saved row's own old text once loading finishes", async () => {
    let release: () => void = () => {};
    api.hydrateGate = new Promise<void>((r) => (release = r));
    api.saved = [{ selector: "main > h1", patch: { text: "B", before: { text: "A" } } as never, removed: false }];
    const app = mount({ protocol: 4 });
    await app.typed("main > h1", "C", "B");
    await act(async () => release());
    await act(async () => {});
    await app.typed("main > h1", "B", "C");
    await waitFor(() => expect(saves()).toHaveLength(2));
    expect(api.calls.filter((c) => c.url === "/api/website/discard")).toEqual([]);
    await app.typed("main > h1", "A", "B");
    await waitFor(() => expect(api.calls.filter((c) => c.url === "/api/website/discard")).toHaveLength(1));
  });
});
