// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ChannelPickerPanel, channelConnectHref } from "./ChannelPicker";

const respond = (connected: string[]) =>
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      channels: connected.map((slug) => ({ channel_slug: slug, connected: true })),
    }),
  });

const rowFor = (name: RegExp) =>
  screen.getAllByRole("button").find((b) => name.test(b.getAttribute("aria-label") ?? ""));

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("channelConnectHref", () => {
  it("points at the Integrations surface with the channel name prefilled", () => {
    const href = channelConnectHref({
      slug: "instagram_organic",
      name: "Instagram",
      category: "organic",
      connected: false,
      channel: {} as never,
    });
    expect(href).toBe("/workspace?tab=brain&q=Instagram#integrations");
  });

  it("escapes a name that would otherwise break the query string", () => {
    const href = channelConnectHref({
      slug: "x_organic",
      name: "X / Twitter",
      category: "organic",
      connected: false,
      channel: {} as never,
    });
    expect(href).toContain("q=X%20%2F%20Twitter");
  });
});

describe("ChannelPickerPanel — the + means 'not connected'", () => {
  it("marks a connected channel pickable and an unconnected one connect-only", async () => {
    respond(["instagram_organic"]);
    render(<ChannelPickerPanel selected={[]} onToggle={vi.fn()} onConnect={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));

    const pickable = screen.getAllByRole("menuitemcheckbox");
    const connectOnly = screen.getAllByRole("menuitem");
    expect(pickable).toHaveLength(1);
    expect(pickable[0].getAttribute("aria-label")).toMatch(/^Add /);
    expect(connectOnly.every((b) => /^Connect /.test(b.getAttribute("aria-label") ?? ""))).toBe(true);
  });

  it("shows the + only on rows that need connecting", async () => {
    respond(["instagram_organic"]);
    const { container } = render(
      <ChannelPickerPanel selected={[]} onToggle={vi.fn()} onConnect={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));

    const plusIn = (el: Element) => !!el.querySelector(".lucide-plus");
    expect(screen.getAllByRole("menuitemcheckbox").every(plusIn)).toBe(false);
    expect(screen.getAllByRole("menuitem").every(plusIn)).toBe(true);
    expect(container.querySelectorAll(".lucide-plus").length).toBe(
      screen.getAllByRole("menuitem").length,
    );
  });

  it("hands the whole option to onConnect and never toggles an unconnected channel", async () => {
    respond([]);
    const onConnect = vi.fn();
    const onToggle = vi.fn();
    render(<ChannelPickerPanel selected={[]} onToggle={onToggle} onConnect={onConnect} />);
    await waitFor(() => expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0));

    screen.getAllByRole("menuitem")[0].click();
    expect(onToggle).not.toHaveBeenCalled();
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect.mock.calls[0][0]).toMatchObject({ connected: false });
    expect(typeof onConnect.mock.calls[0][0].name).toBe("string");
  });
});

describe("ChannelPickerPanel — loading", () => {
  it("lists the channels before the connected state resolves", async () => {
    let release: (v: unknown) => void = () => {};
    apiFetch.mockReturnValue(new Promise((r) => { release = r; }));
    render(<ChannelPickerPanel selected={[]} onToggle={vi.fn()} onConnect={vi.fn()} />);

    const rows = screen.getAllByRole("menuitem");
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.queryByText(/Loading channels/i)).toBeNull();

    release({ ok: true, json: async () => ({ channels: [] }) });
    await waitFor(() => expect(screen.getAllByRole("menuitem")[0].hasAttribute("disabled")).toBe(false));
  });

  it("skeletons the glyph and stays inert until the answer lands", async () => {
    let release: (v: unknown) => void = () => {};
    apiFetch.mockReturnValue(new Promise((r) => { release = r; }));
    const onConnect = vi.fn();
    const onToggle = vi.fn();
    const { container } = render(
      <ChannelPickerPanel selected={[]} onToggle={onToggle} onConnect={onConnect} />,
    );

    expect(container.querySelectorAll(".lucide-plus").length).toBe(0);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    const first = screen.getAllByRole("menuitem")[0];
    expect(first.getAttribute("aria-label")).not.toMatch(/^Connect /);

    first.click();
    expect(onConnect).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();

    release({ ok: true, json: async () => ({ channels: [] }) });
    await waitFor(() => expect(container.querySelectorAll(".lucide-plus").length).toBeGreaterThan(0));
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });
});

describe("ChannelPickerPanel — an aborted request is not an answer", () => {
  it("keeps the skeletons up when the first request is aborted", async () => {
    apiFetch.mockImplementation((_url: string, opts?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
    );

    const { container } = render(
      <StrictMode>
        <ChannelPickerPanel selected={[]} onToggle={vi.fn()} onConnect={vi.fn()} />
      </StrictMode>,
    );
    await act(async () => { await Promise.resolve(); });

    expect(apiFetch.mock.calls.length).toBeGreaterThan(1);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".lucide-plus").length).toBe(0);
    expect(screen.getAllByRole("menuitem")[0].getAttribute("aria-label")).not.toMatch(/^Connect /);
  });

  it("still degrades to 'nothing connected' on a genuine failure", async () => {
    apiFetch.mockRejectedValue(new Error("network is down"));
    const { container } = render(
      <ChannelPickerPanel selected={[]} onToggle={vi.fn()} onConnect={vi.fn()} />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".lucide-plus").length).toBeGreaterThan(0),
    );
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });
});
