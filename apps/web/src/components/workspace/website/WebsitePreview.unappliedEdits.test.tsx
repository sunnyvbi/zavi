// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({ useAppReadiness: () => ({ state: "ready", retry: () => {} }) }));

import { WebsitePreview } from "./WebsitePreview";
import { guardLeave } from "@/lib/workspace/unappliedEdits";

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

const SANDBOX = "https://5173-sbx123.e2b.app";
const SITE_KEY = "site:aaaaaaaa-0000-4000-8000-000000000001";
type Msg = Record<string, unknown>;

const save = { fail: false };
function mount() {
  save.fail = false;
  apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    const failed = save.fail && path === "/api/website/edits" && init?.method === "POST";
    return {
      ok: !failed,
      status: failed ? 500 : 200,
      json: async () => (path.startsWith("/api/website/edits?") ? { edits: [] } : { ok: !failed }),
    };
  });
  const view = render(<WebsitePreview liveUrl={SANDBOX} cacheKey={null} appId={SITE_KEY} builtApp siteApp editPlacement="dock" />);
  const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
  const posted: Msg[] = [];
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: (m: Msg) => posted.push(m) } });
  const fromApp = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin: SANDBOX, source: frame.contentWindow }));
    });
  return { posted, fromApp };
}

const writes = () =>
  apiFetch.mock.calls
    .filter(([p, i]) => p === "/api/website/edits" && (i as { method?: string } | undefined)?.method === "POST")
    .map(([, i]) => JSON.parse((i as { body: string }).body));

const heading = { type: "zavi:editor-selected", selector: "h1.hero", tag: "H1", text: "Welcome", textEditable: true, style: { color: "rgb(0, 0, 0)" } };
const link = { type: "zavi:editor-selected", selector: "a.cta", tag: "A", text: "Order", textEditable: true, attrs: { href: "https://a.test" }, style: {} };

async function editHeading(fromApp: (d: unknown) => void, value = "Fresh bread daily") {
  fromApp({ type: "zavi:editor-ready" });
  fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
  fromApp(heading);
  const input = await screen.findByRole("textbox", { name: "Element text" });
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("typed edits save only on Apply", () => {
  it("clicking away from the field saves nothing; Apply saves", async () => {
    const { fromApp } = mount();
    const input = await editHeading(fromApp);
    fireEvent.blur(input);
    await act(async () => {});
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ selector: "h1.hero", patch: { text: "Fresh bread daily" } });
  });

  it("Enter applies the text and link typed together in one edit; Escape throws a field's draft away", async () => {
    const { fromApp } = mount();
    fromApp({ type: "zavi:editor-ready" });
    fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
    fromApp(link);
    const text = await screen.findByRole("textbox", { name: "Element text" });
    const href = screen.getByRole("textbox", { name: "Link URL" });
    fireEvent.change(text, { target: { value: "Order now" } });
    fireEvent.change(href, { target: { value: "https://b.test" } });
    fireEvent.keyDown(href, { key: "Escape" });
    expect((href as HTMLInputElement).value).toBe("https://a.test");
    expect((text as HTMLInputElement).value).toBe("Order now");
    fireEvent.change(href, { target: { value: "https://c.test" } });
    fireEvent.keyDown(text, { key: "Enter" });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ selector: "a.cta", patch: { text: "Order now", attrs: { href: "https://c.test" } } });
  });

  it("picking another element with an unapplied edit asks first: Discard drops it and moves on", async () => {
    const { fromApp } = mount();
    await editHeading(fromApp);
    fromApp(link);
    expect(screen.getByRole("alertdialog", { name: "Unapplied changes" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Element text" }) as HTMLInputElement).value).toBe("Fresh bread daily");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((await screen.findByRole("textbox", { name: "Link URL" })) as HTMLInputElement).toBeTruthy();
    await act(async () => {});
    expect(writes()).toHaveLength(0);
  });

  it("picking another element with an unapplied edit: Apply saves it on the first element, then moves on", async () => {
    const { fromApp } = mount();
    await editHeading(fromApp);
    fromApp(link);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ selector: "h1.hero", patch: { text: "Fresh bread daily" } });
    expect(await screen.findByRole("textbox", { name: "Link URL" })).toBeTruthy();
  });

  it("Done with an unapplied edit asks first and closes after the answer", async () => {
    const { fromApp } = mount();
    await editHeading(fromApp);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("alertdialog", { name: "Unapplied changes" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Element text" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("textbox", { name: "Element text" })).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it("opening another site waits for the answer, and goes straight through with nothing typed", async () => {
    const { fromApp } = mount();
    const open = vi.fn();
    guardLeave(open);
    expect(open).toHaveBeenCalledTimes(1);
    await editHeading(fromApp);
    act(() => guardLeave(open));
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(writes()).toHaveLength(1);
  });

  it("leaving the page with an unapplied edit triggers the browser's leave prompt, and not without one", async () => {
    const { fromApp } = mount();
    const before = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(before()).toBe(false);
    await editHeading(fromApp);
    expect(before()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await act(async () => {});
    expect(before()).toBe(false);
  });

  it("Reload preview with an unapplied edit asks first and reloads after Discard", async () => {
    const { fromApp } = mount();
    await editHeading(fromApp);
    const frameKey = () => document.querySelector("iframe")?.getAttribute("src");
    const before = frameKey();
    fireEvent.click(screen.getByRole("button", { name: "Reload preview" }));
    expect(screen.getByRole("alertdialog", { name: "Unapplied changes" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Element text" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Element text" })).toBeNull();
    expect(writes()).toHaveLength(0);
    expect(frameKey()).toBe(before);
  });

  it("Undo with an unapplied edit asks first; Discard puts the field back and then undoes", async () => {
    const { fromApp, posted } = mount();
    const input = await editHeading(fromApp);
    fromApp({ type: "zavi:editor-history", canUndo: true, canRedo: false });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(posted.some((m) => m.type === "zavi:editor-undo")).toBe(false);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    expect(posted.some((m) => m.type === "zavi:editor-undo")).toBe(true);
    expect((input as HTMLInputElement).value).toBe("Welcome");
    expect(writes()).toHaveLength(0);
  });

  it("opening Ask AI with an unapplied edit asks first; Apply saves it, then Ask AI opens", async () => {
    const { fromApp } = mount();
    await editHeading(fromApp);
    fireEvent.click(screen.getByTestId("editor-toolbar-mode"));
    expect(screen.queryByRole("textbox", { name: "Ask AI to change this element" })).toBeNull();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(screen.getByRole("textbox", { name: "Ask AI to change this element" })).toBeTruthy();
  });

  it("Apply in the prompt saves first: a failed save keeps the draft and the page, says so, and goes nowhere", async () => {
    const { fromApp, posted } = mount();
    await editHeading(fromApp);
    save.fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Apply" }));
    expect(await within(screen.getByRole("alertdialog")).findByText("Couldn't save, try again.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Element text" }) as HTMLInputElement).value).toBe("Fresh bread daily");
    expect(posted.some((m) => m.type === "zavi:editor-apply")).toBe(false);
    save.fail = false;
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Element text" })).toBeNull());
    expect(posted.filter((m) => m.type === "zavi:editor-apply").at(-1)).toMatchObject({ selector: "h1.hero", patch: { text: "Fresh bread daily" } });
  });

  it("Undo with a draft: Apply saves and applies it and stops there, so the next Undo undoes that edit; Redo likewise", async () => {
    const { fromApp, posted } = mount();
    await editHeading(fromApp);
    fromApp({ type: "zavi:editor-history", canUndo: true, canRedo: true });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(posted.some((m) => m.type === "zavi:editor-undo")).toBe(false);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(posted.filter((m) => m.type === "zavi:editor-undo")).toHaveLength(1);
    const input = screen.getByRole("textbox", { name: "Element text" });
    fireEvent.change(input, { target: { value: "Another draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(posted.some((m) => m.type === "zavi:editor-redo")).toBe(false);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    expect(posted.filter((m) => m.type === "zavi:editor-redo")).toHaveLength(1);
  });

  it("Delete element with a draft asks first; Discard then deletes", async () => {
    const { fromApp, posted } = mount();
    await editHeading(fromApp);
    fireEvent.click(screen.getByRole("button", { name: "Delete element" }));
    expect(posted.some((m) => m.type === "zavi:editor-delete")).toBe(false);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    expect(posted.some((m) => m.type === "zavi:editor-delete")).toBe(true);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ selector: "h1.hero", remove: true });
  });

  it("with the preview hidden (Dashboard or another pane), a guarded leave shows the prompt over the page and Discard completes it", async () => {
    apiFetch.mockImplementation(async (path: string) => ({ ok: true, status: 200, json: async () => (path.startsWith("/api/website/edits?") ? { edits: [] } : { ok: true }) }));
    const view = render(<WebsitePreview liveUrl={SANDBOX} cacheKey={null} appId={SITE_KEY} builtApp siteApp editPlacement="dock" surfaceActive />);
    const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: () => {} } });
    const fromApp = (data: unknown) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, origin: SANDBOX, source: frame.contentWindow }));
      });
    await editHeading(fromApp);
    view.rerender(<WebsitePreview liveUrl={SANDBOX} cacheKey={null} appId={SITE_KEY} builtApp siteApp editPlacement="dock" surfaceActive={false} />);
    const open = vi.fn();
    act(() => guardLeave(open));
    expect(open).not.toHaveBeenCalled();
    const floating = screen.getByTestId("unapplied-changes-floating");
    expect(floating.parentElement).toBe(document.body);
    fireEvent.click(within(floating).getByRole("button", { name: "Discard" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("unapplied-changes-floating")).toBeNull();
  });
});
