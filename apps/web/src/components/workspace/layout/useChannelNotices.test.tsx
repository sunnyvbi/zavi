// @vitest-environment jsdom
import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChannelNotices } from "./useChannelNotices";

function Probe() {
  const { unseen } = useChannelNotices("user", "tenant");
  return <span>{unseen("seo", 4)}</span>;
}

afterEach(() => window.localStorage.clear());

it("renders the same first value on the server and during hydration", async () => {
  window.localStorage.setItem("zavi:channel-notices:user:tenant", JSON.stringify({ seo: 4 }));
  const html = renderToString(<Probe />);
  expect(html).toBe("<span>4</span>");
  const container = document.createElement("div");
  container.innerHTML = html;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, <Probe />);
    });
    expect(error).not.toHaveBeenCalled();
    expect(container.textContent).toBe("0");
  } finally {
    await act(async () => root?.unmount());
    error.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("notifies again when fresh work raises the count after a decrease", async () => {
  window.localStorage.setItem("zavi:channel-notices:user:tenant", JSON.stringify({ seo: 2 }));
  let count = 2;
  const view = renderHook(() => useChannelNotices("user", "tenant", { seo: count }));
  await waitFor(() => expect(view.result.current.unseen("seo", count)).toBe(0));
  count = 1;
  view.rerender();
  await waitFor(() => expect(JSON.parse(window.localStorage.getItem("zavi:channel-notices:user:tenant") ?? "{}").seo).toBe(1));
  count = 2;
  view.rerender();
  expect(view.result.current.unseen("seo", count)).toBe(1);
  view.unmount();
});
